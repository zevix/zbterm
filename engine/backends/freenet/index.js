// The Freenet share backend (design: docs/projects/260918_backend-abstraction/
// freenet-backend-design.md §4; D-01, D-09).
//
// Phases of docs/projects/260924_freenet-backend/: F3 made start() open one
// WebSocket to a Freenet node and nothing else; F5 made routeFor() mint routes
// from the bundled contracts (./route.js). F6 adds announce, withdraw, dial,
// the 'connection' event and the handshake of design §6: a viewer's signed,
// sealed offer reaches the host through the link's signalling contract, the
// host's signed answer comes back the same way, and a connection is surfaced
// only once the DTLS certificate matches the fingerprint inside the SDP its
// peer signed. F7 adds channels (./channel.js: JSON over one data channel per
// (protocol, id), cut into parts of at most 65 536 bytes) and the per-link
// admission limits of design §7 layer 4. F8 adds live history (./history.js:
// the session's cores replicated over one extra data channel). F9 wires it
// into the product: the registry reports it `available` when the host offers
// its WebRTC adapter (else `broken` / `host has no WebRTC adapter`), and
// `share.backends` asks probe() whether a node answers at the configured
// address; a half-open peer connection has a deadline and one viewer key a
// share of the half-open slots (S-22); the ICE servers are the host's
// (setIceServers, D-11).
//
// D-01: the backend is a hybrid. Contracts carry the rendezvous advert, the
// signalling mailbox and durable history; a contract-signalled WebRTC data
// channel, run in the host process (D-06, D-09), carries live output and
// viewer input.
//
// A signalling entry (./signal.js) is `{ l, r, s, t, d, p, g }` with `l` the
// connection id `cid` a viewer picks per dial (random, 32 hex), `r`
// `v:<viewer key>` for the viewer's entries and `h:<viewer key>` for the
// host's, `s` a sequence per (l, r) from 0, and `p` the sealed batch
// `{ cid, re?, m: [message…] }` where a message is `{ type: 'offer' |
// 'answer', sdp }` or `{ type: 'candidate', candidate, mid }`. Messages a peer
// connection produces within FLUSH_MS of each other share one entry: the
// contract keeps 16 live entries per viewer key (design §7), and a
// connection on a machine with many interfaces trickles more candidates than
// that. `re` is set on every host entry: the hash of the viewer entry that
// carried the offer.
require('./bare-shims').install()

const { EventEmitter } = require('events')
const crypto = require('crypto')

const { EngineError, CODES } = require('../../errors')
const { CAP } = require('../types')
const { blake3 } = require('./blake3')
const nodeClient = require('./node-client')
const route = require('./route')
const signal = require('./signal')
const FreenetConnection = require('./connection')
const history = require('./history')

const DEFAULT_NODE_URL = 'ws://127.0.0.1:7509/v1/contract/command'
// probe(): how long a WebSocket to the node may take to open (A-11: 2 s).
const PROBE_TIMEOUT_MS = 2000
// The host process owns the peer connections (D-06, D-09); a host that did
// not offer its WebRTC adapter (the `rtc` host capability) cannot carry one.
const NO_RTC_HOST = 'host has no WebRTC adapter'
// The canonical empty signalling state (contracts/src/signalling: `{"e":[]}`).
const EMPTY_STATE = Buffer.from('{"e":[]}')
// A Get of an instance that may not exist yet. A local-mode node never
// answers a miss (S-05 c); a network node answered one after 4.7-8.7 s (F1).
const ANNOUNCE_GET_MS = 2000
// How long a viewer waits between Gets of an instance its node does not hold
// yet (F2: a fresh instance was readable on the first Get in 9 of 9 runs).
const DIAL_GET_GAP_MS = 1000
// A pointer record Get; a miss on a local-mode node is never answered.
const POINTER_GET_MS = 5000
// Tombstones are best effort: a write the contract refuses is never answered
// (S-19), and an entry expires at `t + ttl_ms` anyway.
const TOMBSTONE_TIMEOUT_MS = 3000
// Signalling messages a peer connection produces within this window go into
// one entry (see the header).
const FLUSH_MS = 25
// The first pointer record of a link (design §5.2): it names the link's own
// signalling instance. A later version moves the link.
const POINTER_VER = 1
// node-datachannel makes an offer only once the first data channel exists,
// so a dial opens this one. It carries nothing and stays open with the
// connection; its label is not a channel label (./channel.js::parseLabel), so
// neither side ever surfaces it as a channel.
const BOOTSTRAP_CHANNEL = 0
const BOOTSTRAP_LABEL = 'zbterm/fnet-bootstrap'
// Design §7 layer 4 (A-12), per link: offers answered within any
// ANSWER_WINDOW_MS, and peer connections answered but not yet surfaced. An
// offer past either limit is refused like one the admission policy refuses:
// nothing is written and it counts in `refused`.
const MAX_ANSWERS_PER_MINUTE = 30
const ANSWER_WINDOW_MS = 60 * 1000
const MAX_HALF_OPEN = 8
// S-22: a peer connection answered but not surfaced within this long is
// closed and counted as refused, so a holder of the invite cannot keep the
// link's half-open slots by offering and never finishing (F2 measured
// offer -> connected p95 2.1 s across the internet). One viewer key holds at
// most MAX_HALF_OPEN_PER_VIEWER of the MAX_HALF_OPEN slots.
const HALF_OPEN_TIMEOUT_MS = 15000
const MAX_HALF_OPEN_PER_VIEWER = 2

// No DIRECT_DIAL: every connection is brokered through the signalling
// contract first. No PATH_MIGRATION: an ICE restart is a new connection.
// RELAY is TURN, which is operator-supplied: describe() adds it only when the
// ICE servers name one. HISTORY_OFFLINE_HOST and HISTORY_EVENTUAL_MERGE stay
// cleared until offline history exists (design §8.2), because ShareManager
// acts on capabilities. AUTHENTICATED_PEER rests on design §6 as built in F6
// (docs/projects/260924_freenet-backend/): a connection is surfaced only
// after its answer (or offer) verified under the expected key, named the
// viewer's offer, and the DTLS certificate matched the signed SDP's
// fingerprint; test/backends/freenet-backend.test.js negatives (i)-(iii).
const CAPABILITIES =
  CAP.AUTHENTICATED_PEER |
  CAP.MULTIPLEXED_STREAMS |
  CAP.ORDERED_STREAM |
  CAP.EPHEMERAL_DELIVERY |
  CAP.NAT_TRAVERSAL |
  CAP.BROKERED |
  CAP.HISTORY_SPARSE_READ |
  CAP.HISTORY_HEAD_WATCH

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function hex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

function unavailable(message, detail) {
  return new EngineError(CODES.E_BACKEND_UNAVAILABLE, message, { backend: 'freenet', detail })
}

// The node's address as a person would type it: scheme, host and port.
function nodeAddress(nodeUrl) {
  const match = /^(wss?:\/\/[^/]+)/i.exec(String(nodeUrl))
  return match ? match[1] : String(nodeUrl)
}

// An ICE URL without its credentials (`turn:user:secret@host:port` ->
// `turn:host:port`), for diagnostics.
function redactIceServer(server) {
  const url = typeof server === 'string' ? server : server && server.urls
  return String([].concat(url || '')[0]).replace(/^(turns?:)[^@]*@/i, '$1')
}

function hasTurnServer(iceServers) {
  for (const server of Array.isArray(iceServers) ? iceServers : []) {
    const urls = typeof server === 'string' ? server : server && server.urls
    for (const url of [].concat(urls || [])) {
      if (typeof url === 'string' && /^turns?:/i.test(url)) return true
    }
  }
  return false
}

// `hostCaps` is a comma-separated list ('' for none), as the worker's 5th
// spawn argument carries it.
function hasHostCap(hostCaps, cap) {
  return String(hostCaps)
    .split(',')
    .map((part) => part.trim())
    .includes(cap)
}

// The entries of a signalling state or delta; [] for anything else.
function entriesOf(bytes) {
  try {
    const wire = JSON.parse(Buffer.from(bytes).toString('utf8'))
    return wire && Array.isArray(wire.e) ? wire.e : []
  } catch {
    return []
  }
}

// A signalling message from the host half (RtcHost / RtcRemote 'signal'),
// as it goes into an entry.
function messageOf(body) {
  if (body.type === 'candidate') {
    return { type: 'candidate', candidate: body.candidate, mid: body.mid }
  }
  return { type: body.type, sdp: body.sdp }
}

// Peer connections a link answered that have not surfaced yet, all of them
// or those of one viewer key (hex).
function halfOpen(link, viewer) {
  let count = 0
  for (const session of link.sessions.values()) {
    if (!session.conn && (viewer === undefined || session.viewer === viewer)) count++
  }
  return count
}

function dispatchChannel(conn, kind, body) {
  if (kind === 'channel') conn._channelEvent(body)
  else if (kind === 'data') conn._dataEvent(body)
  else conn._flowEvent(body)
}

class FreenetBackend extends EventEmitter {
  // The registry's self-check hook (../index.js::load): the module loaded
  // (the SDK with it), so the backend is usable when the host offers its
  // WebRTC adapter. `hostCaps` undefined means the caller has no host to ask
  // about, and skips that check. Whether a node answers is probe()'s.
  static availability(ctx) {
    const hostCaps = ctx && ctx.hostCaps
    if (hostCaps !== undefined && hostCaps !== null && !hasHostCap(hostCaps, 'rtc')) {
      return { state: 'broken', detail: NO_RTC_HOST }
    }
    return { state: 'available', detail: null }
  }

  // A-11, D-12: `share.backends` asks whether a node answers at `nodeUrl`
  // (engine/backends/index.js::probe). One WebSocket is opened and closed;
  // nothing is put or subscribed. ZBTerm never starts a node itself.
  static async probe(ctx = {}) {
    const nodeUrl = ctx.nodeUrl || DEFAULT_NODE_URL
    const timeoutMs = Number.isFinite(ctx.timeoutMs) ? ctx.timeoutMs : PROBE_TIMEOUT_MS
    try {
      const client = await nodeClient.connect(nodeUrl, { openTimeoutMs: timeoutMs })
      await client.close()
      return { state: 'available', detail: null }
    } catch {
      return {
        state: 'broken',
        detail: `no Freenet node at ${nodeAddress(nodeUrl)} — see README "Freenet"`
      }
    }
  }

  // `nodeUrl` is a constructor option, never read from the environment: the
  // worker's environment is not reliably inherited (../../worker.js).
  // `iceServers` and `rtcHost` are for the WebRTC half (the host sends the
  // first through ShareManager, F9 - see setIceServers; the registry passes
  // the second, the worker's RtcRemote, since F4; tests pass an
  // electron/rtc-host.js RtcHost, which has the same API); without
  // `iceServers` the host half's own list applies. `wasm` replaces the
  // bundled signalling contract code (raw bytes) for new routes. `clock`
  // (milliseconds, default Date.now) times the per-link answer window; tests
  // pass a fake one.
  constructor({ nodeUrl = DEFAULT_NODE_URL, iceServers, rtcHost, wasm, clock } = {}) {
    super()
    this._nodeUrl = nodeUrl
    this._iceServersGiven = null
    this._iceServers = []
    this.setIceServers(iceServers)
    this._rtcHost = rtcHost || null
    this._wasm = wasm || null
    this._clock = typeof clock === 'function' ? clock : Date.now
    this._contracts = null
    this._ctx = null
    this._client = null
    this._starting = null
    this._started = false
    this._nodeProblem = null
    this._wsRttMs = null
    // linkId -> the announced link.
    this._links = new Map()
    // instance id -> { id, key, link, dials, subscribed, entries }: every
    // instance this backend listens to, as host (link) or viewer (dials).
    this._subs = new Map()
    // Active dials, in start order.
    this._dials = new Set()
    // connId -> the dial or host session that owns that peer connection.
    this._rtc = new Map()
    // Surfaced connections.
    this._conns = new Set()
    // hex key -> refcount of active dials expecting it (always admitted).
    this._pinned = new Map()
    // Route sigs minted by this object: new, so announce Puts without a Get.
    this._minted = new Set()
    this._admission = () => false
    this._refused = 0
    this._nextConnId = 1
    this._rtcListeners = null
  }

  describe() {
    return {
      id: 'freenet',
      label: 'Freenet (experimental)',
      interfaceVersion: 1,
      capabilities: CAPABILITIES | (hasTurnServer(this._iceServers) ? CAP.RELAY : 0)
    }
  }

  // D-11: the ICE servers every new peer connection gets (an array of ICE
  // URLs; [] means host candidates only). Anything else leaves the host
  // half's own list in charge. describe() claims RELAY only with a TURN URL.
  setIceServers(iceServers) {
    this._iceServersGiven = Array.isArray(iceServers) ? iceServers.slice() : null
    this._iceServers = this._iceServersGiven || []
  }

  // Opens one WebSocket to the node and nothing else: no contract is put or
  // subscribed.
  start(ctx) {
    if (this._started) return Promise.resolve()
    if (this._starting) return this._starting
    this._ctx = ctx || {}
    this._starting = nodeClient
      .connect(this._nodeUrl, {
        on: {
          notification: (n) => this._onNotification(n),
          close: () => this._onNodeClose(),
          err: (e) => this._debug('node:error', { cause: e && e.cause })
        }
      })
      .then(
        (client) => {
          this._starting = null
          this._client = client
          this._started = true
          this._nodeProblem = null
          this._listenRtc()
          this._debug('node:open', { address: this._nodeUrl, openMs: client.openMs })
        },
        (err) => {
          this._starting = null
          const detail = `no Freenet node at ${this._nodeUrl}`
          this._nodeProblem = detail
          this._debug('node:unavailable', { address: this._nodeUrl, message: err.message })
          throw unavailable(`The 'freenet' share backend cannot start: ${detail}`, detail)
        }
      )
    return this._starting
  }

  // Cancels every dial, withdraws every link (tombstones, best effort),
  // closes every peer connection this backend opened, then the socket.
  async stop() {
    const starting = this._starting
    if (starting) await starting.catch(() => {})
    for (const dial of Array.from(this._dials)) this._endDial(dial, new Error('Backend stopped'))
    await Promise.all(Array.from(this._links.keys()).map((linkId) => this.withdraw(linkId)))
    for (const [connId, owner] of Array.from(this._rtc)) {
      this._rtc.delete(connId)
      this._clearDeadline(owner)
      if (this._rtcHost) this._rtcHost.close(connId, 'stopped')
      if (owner.conn) this._connClosed(owner, 'stopped')
    }
    this._unlistenRtc()
    this._subs.clear()
    this._pinned.clear()
    this._started = false
    const client = this._client
    this._client = null
    if (client) await client.close()
  }

  // `listening` while at least one announced link has a live subscription.
  health() {
    let listening = false
    for (const link of this._links.values()) {
      const sub = this._subs.get(link.id)
      if (sub && sub.subscribed) listening = true
    }
    return {
      started: this._started,
      listening: this._started && listening,
      detail: this._nodeProblem
    }
  }

  localPeerKey() {
    const keyPair = this._keyPair()
    return (keyPair && keyPair.publicKey) || null
  }

  _keyPair() {
    return (this._ctx && this._ctx.keyPair && this._ctx.keyPair()) || null
  }

  // Synchronous and offline (./route.js::mint): the instance ids are
  // blake3(blake3(wasm) ‖ params), computed here. `k` is the payload key and
  // never leaves the invite; `ptr` names the link's pointer record (§5.2).
  routeFor(linkId, stored) {
    if (stored && stored.route) return stored.route
    const keyPair = this._keyPair()
    if (!keyPair) {
      throw unavailable(
        "The 'freenet' share backend has no transport key to mint a route with",
        'no transport key'
      )
    }
    const minted = route.mint(linkId, keyPair.publicKey, this._contractSet())
    this._minted.add(minted.sig)
    return minted
  }

  // The bundled contracts (./contracts.js), with the constructor's `wasm` as
  // the signalling code when one was given.
  _contractSet() {
    if (this._contracts) return this._contracts
    let bundled
    try {
      bundled = require('./contracts')
    } catch (err) {
      throw unavailable(
        `The 'freenet' share backend has no signalling contract: ${err.message}`,
        'signalling contract missing from this build'
      )
    }
    if (this._wasm) {
      const code = Buffer.from(blake3(this._wasm)).toString('hex')
      this._contracts = {
        current: code,
        known: new Map([[code, this._wasm]]),
        pointer: bundled.pointer
      }
    } else {
      this._contracts = bundled
    }
    return this._contracts
  }

  // Design §4 `announce`: the link's signalling instance is Put with an
  // empty canonical state and subscribed (S-05 a: the PutResponse is the
  // ack), and the link's pointer record (§5.2) is Put beside it. A route this
  // object minted is Put at once; any other (a stored link after a restart)
  // is read with a Get first and Put only on a miss (S-05 b: an instance is
  // never Put twice), under ANNOUNCE_GET_MS because a local-mode node never
  // answers a miss (S-05 c).
  //
  // announce and dial wait for a start() still opening its socket: a caller
  // (ShareManager) may start the backend and announce without awaiting.
  async announce(linkId, opts = {}) {
    if (this._starting) await this._starting.catch(() => {})
    this._usable()
    const known = this._links.get(linkId)
    if (known) return { route: known.route, linkId }
    const r = opts.route || this.routeFor(linkId, null)
    const keyPair = this._keyPair()
    const contracts = this._contractSet()
    const wasm = r && r.code && contracts.known.get(r.code)
    if (!wasm) {
      throw new EngineError(
        CODES.E_BACKEND_UNSUPPORTED,
        'The Freenet route uses a signalling contract this build does not ship',
        { backend: 'freenet', detail: 'unknown contract code' }
      )
    }
    if (!r.params || r.params.host !== hex(keyPair.publicKey)) {
      throw new EngineError(CODES.E_AUTH, 'The Freenet route belongs to another host', {
        backend: 'freenet',
        detail: 'route host is not this device'
      })
    }
    const started = now()
    const params = route.paramsBytes(r.params)
    const { key, id } = nodeClient.contractKey(wasm, params)
    const fresh = this._minted.has(r.sig)
    const [state] = await Promise.all([
      this._ensureInstance(wasm, params, key, EMPTY_STATE, fresh),
      this._putPointer(r, keyPair, contracts, fresh).catch((err) => {
        this._debug('host:pointer:error', { ...opts.tag, linkId, message: err.message })
      })
    ])
    const link = {
      linkId,
      route: r,
      id,
      key,
      params,
      payloadKey: signal.payloadKey(r.k),
      ttlMs: r.params.ttl_ms,
      tag: opts.tag,
      seen: new Map(),
      sessions: new Map(),
      // Times (this._clock) of the offers answered within ANSWER_WINDOW_MS.
      answers: [],
      refused: 0
    }
    const sub = this._subscription(id, key)
    sub.link = link
    this._links.set(linkId, link)
    try {
      await this._subscribe(sub)
    } catch (err) {
      if (this._links.get(linkId) === link) this._links.delete(linkId)
      sub.link = null
      this._release(sub)
      throw unavailable(
        `The 'freenet' share backend could not subscribe to the link: ${err.message}`,
        'subscribe failed'
      )
    }
    if (state) this._onState(id, [state])
    this._debug('host:announce', {
      ...opts.tag,
      linkId,
      instance: id,
      fresh,
      ms: Math.round(now() - started)
    })
    return { route: r, linkId }
  }

  // D-04: ends discovery, not reachability. Notifications for the link are
  // ignored from here on (the SDK has no unsubscribe), no offer is answered
  // again, and the host's own entries are tombstoned. The instance cannot be
  // deleted; its entries age out at `t + ttl_ms`. Live connections survive.
  async withdraw(linkId) {
    const link = this._links.get(linkId)
    if (!link) return
    this._links.delete(linkId)
    const sub = this._subs.get(link.id)
    if (sub && sub.link === link) {
      sub.link = null
      this._release(sub)
    }
    const tombstones = []
    for (const session of link.sessions.values()) tombstones.push(...this._tombstones(session))
    this._debug('host:withdraw', { ...link.tag, linkId, tombstones: tombstones.length })
    if (tombstones.length) await this._write(link.key, tombstones, TOMBSTONE_TIMEOUT_MS)
  }

  // Design §4 `dial` and §6. The expected key is pinned synchronously; the
  // route is checked (§5.1) before a byte reaches the node. A route that
  // names another host than `expectedPeerKey` can never connect, so its
  // `connected` stays pending until the caller cancels, as a dial nobody
  // answers does (conformance: 'a wrong expectedPeerKey never yields a
  // connection'); any other bad route rejects at once. An unknown contract
  // code is looked up through the route's pointer record first (§5.2); a
  // known one is used directly, without reading the pointer. A dial made
  // while start() is still opening its socket begins once start() settles.
  dial(r, expectedPeerKey, opts = {}) {
    const dial = {
      kind: 'dial',
      expectedKey: Buffer.from(expectedPeerKey),
      expectedHex: hex(expectedPeerKey),
      tag: opts.tag,
      done: false,
      conn: null,
      connId: null,
      ready: false,
      queue: [],
      timer: null,
      own: [],
      seen: new Map(),
      s: 0,
      re: null,
      offerAt: null,
      fingerprint: null,
      answered: false,
      held: [],
      // This side's own candidates, kept back until the answer is applied
      // (_onRtcSignal).
      ownHeld: [],
      startedAt: now(),
      resolve: null,
      reject: null
    }
    const connected = new Promise((resolve, reject) => {
      dial.resolve = resolve
      dial.reject = reject
    })
    // A cancelled dial is an expected outcome, not an unhandled rejection.
    connected.catch(() => {})
    this._pin(dial.expectedHex)
    this._dials.add(dial)
    const cancel = () => this._endDial(dial, new Error('Dial was cancelled'))
    if (opts.signal) {
      if (opts.signal.aborted) queueMicrotask(cancel)
      else opts.signal.addEventListener('abort', cancel, { once: true })
    }
    const handle = { connected, cancel }
    if (this._starting) {
      const go = () => {
        if (!dial.done) this._beginDial(dial, r, expectedPeerKey, opts)
      }
      this._starting.then(go, go)
    } else {
      this._beginDial(dial, r, expectedPeerKey, opts)
    }
    return handle
  }

  _beginDial(dial, r, expectedPeerKey, opts) {
    try {
      this._usable()
    } catch (err) {
      this._endDial(dial, err)
      return
    }
    let checked
    try {
      checked = route.verify(r, expectedPeerKey, this._contractSet())
    } catch (err) {
      this._debug('viewer:route-refused', {
        ...opts.tag,
        code: err.code,
        detail: err.details && err.details.detail
      })
      if (err.code === CODES.E_AUTH) return
      if (err.code === CODES.E_BACKEND_UNSUPPORTED && r.ptr) {
        this._viaPointer(dial, r, err)
        return
      }
      this._endDial(dial, err)
      return
    }
    this._startDial(dial, r, checked).catch((err) => this._endDial(dial, EngineError.from(err)))
  }

  // Evaluated on each verified offer, before a peer connection exists
  // (design §4, §6 step 2), as `policy(remotePeerKey, { remotePeerKey,
  // linkId })`. A key pinned by an active dial is always admitted. Unlike
  // Pear (S-09) a refusal is not sticky: the next offer is evaluated again.
  // The per-link limits of design §7 layer 4 apply to every offer, pinned or
  // not (_overLimit).
  setAdmission(policy) {
    this._admission = typeof policy === 'function' ? policy : () => !!policy
  }

  // Design §8.1 (./history.js): the session's cores replicate over one extra
  // data channel of the connection, idempotent per (connection, store).
  serveHistory(conn, store) {
    history.serveHistory(conn, store)
  }

  attachHistory(conn, store, keys) {
    return history.attachHistory(conn, store, keys)
  }

  // History rides the live connection; the offline route of design §8.2 does
  // not exist (D-13).
  historyRouteFor() {
    return null
  }

  // JSON-safe; never a route's `k`, never SDP, never an ICE credential.
  // `ice.servers` is null while the host half's own list applies.
  diagnostics() {
    const given = this._iceServersGiven
    return {
      backend: 'freenet',
      started: this._started,
      announced: this._links.size,
      node: { address: this._nodeUrl, version: null, wsRttMs: this._wsRttMs },
      ice: {
        servers: given ? given.map(redactIceServer) : null,
        hostCandidatesOnly: !!given && given.length === 0,
        relay: hasTurnServer(this._iceServers)
      },
      links: Array.from(this._links.values()).map((link) => {
        const sub = this._subs.get(link.id)
        return {
          linkId: link.linkId,
          instance: link.id,
          entries: (sub && sub.entries) || 0,
          answeredLastMinute: this._answeredInWindow(link),
          halfOpen: halfOpen(link),
          refused: link.refused
        }
      }),
      conns: Array.from(this._conns).map((conn) => ({
        peer: hex(conn.remotePeerKey),
        iceState: conn._state,
        path: conn.path(),
        channels: conn._channels.size
      })),
      refused: this._refused
    }
  }

  // --- announce ---

  // The state the node holds for `key` (bytes), or null after a Put of
  // `initial`.
  async _ensureInstance(wasm, params, key, initial, fresh) {
    const client = this._client
    if (!fresh) {
      try {
        return (await client.get(key, { timeoutMs: ANNOUNCE_GET_MS })).state
      } catch {}
    }
    try {
      await client.put(wasm, params, initial)
      return null
    } catch (err) {
      // S-05 b: a Put of an instance the node holds is never answered with a
      // PutResponse. A slow first Get looks the same, so ask once more.
      try {
        return (await client.get(key, { timeoutMs: ANNOUNCE_GET_MS })).state
      } catch {
        throw unavailable(
          `The 'freenet' share backend could not put the link's contract: ${err.message}`,
          'put failed'
        )
      }
    }
  }

  // The link's pointer record (§5.2, `{ host, n }` since F6): version 1 names
  // the link's own signalling instance.
  async _putPointer(r, keyPair, contracts, fresh) {
    if (!r.ptr) return
    const ptrParams = route.pointerParamsBytes(r.params.host, r.params.n)
    const { key, id } = nodeClient.contractKey(contracts.pointer.wasm, ptrParams)
    if (id !== r.ptr) throw new Error('the route names another pointer record')
    const record = signal.signRecord(keyPair.secretKey, ptrParams, {
      ver: POINTER_VER,
      sig: r.sig,
      code: r.code,
      params: route.paramsBytes(r.params).toString('utf8')
    })
    const state = Buffer.from(JSON.stringify(record))
    await this._ensureInstance(contracts.pointer.wasm, ptrParams, key, state, fresh)
  }

  // --- host role ---

  // Design §6 steps 2-3. Every notification is the whole state (S-05 d), so
  // entries are de-duplicated by key and signature before any is verified.
  _hostEntries(link, entries) {
    const fresh = []
    let high = 0
    for (const e of entries) {
      if (!e || typeof e.r !== 'string' || !e.r.startsWith('v:')) continue
      if (Number.isSafeInteger(e.t) && e.t > high) high = e.t
      const id = `${e.l}\n${e.r}\n${e.s}`
      const seen = link.seen.get(id)
      if (seen && seen.g === e.g) continue
      link.seen.set(id, { g: e.g, t: e.t })
      fresh.push(e)
    }
    // Forget what the contract has purged by now.
    for (const [id, seen] of link.seen) {
      if (seen.t + 2 * link.ttlMs < high) link.seen.delete(id)
    }
    fresh.sort((a, b) => a.s - b.s)
    for (const e of fresh) this._hostEntry(link, e)
  }

  _hostEntry(link, e) {
    const role = signal.roleOf(e.r)
    if (!role || !signal.verifyEntry(Buffer.from(role.viewer, 'hex'), link.params, e)) {
      this._refuse('host:entry-refused', { ...link.tag, linkId: link.linkId, reason: 'signature' })
      return
    }
    const sessionKey = `${role.viewer}:${e.l}`
    let session = link.sessions.get(sessionKey)
    if (e.d) {
      // The viewer cancelled: a connection that never surfaced goes.
      if (session && !session.conn) this._dropSession(session, 'viewer cancelled')
      return
    }
    const msg = signal.open(link.payloadKey, e.p)
    if (!msg || msg.cid !== e.l || !Array.isArray(msg.m)) {
      this._refuse('host:entry-refused', { ...link.tag, linkId: link.linkId, reason: 'payload' })
      return
    }
    if (!session) {
      // Candidates for a connection this side never opened (refused, or
      // gone) are dropped; only an offer opens one.
      const offer = msg.m.find((m) => m && m.type === 'offer' && typeof m.sdp === 'string')
      if (!offer) return
      const viewerKey = Buffer.from(role.viewer, 'hex')
      const refusal =
        this._overLimit(link, role.viewer) || (this._admits(viewerKey, link) ? null : 'admission')
      if (refusal) {
        link.refused++
        this._refuse('host:offer-refused', {
          ...link.tag,
          linkId: link.linkId,
          peer: role.viewer,
          reason: refusal
        })
        return
      }
      link.answers.push(this._clock())
      session = {
        kind: 'host',
        link,
        sessionKey,
        viewer: role.viewer,
        remoteKey: viewerKey,
        cid: e.l,
        connId: this._nextConnId++,
        r: `h:${role.viewer}`,
        re: signal.offerRef(e.p),
        fingerprint: signal.sdpFingerprint(offer.sdp),
        ready: true,
        queue: [],
        timer: null,
        own: [],
        s: 0,
        conn: null,
        startedAt: now(),
        // S-22: this._clock() time after which it no longer holds a slot.
        deadline: this._clock() + HALF_OPEN_TIMEOUT_MS,
        deadlineTimer: null
      }
      link.sessions.set(sessionKey, session)
      this._armDeadline(session, HALF_OPEN_TIMEOUT_MS)
      this._rtc.set(session.connId, session)
      this._debug('host:offer', { ...link.tag, linkId: link.linkId, peer: role.viewer })
      this._rtcHost.open(session.connId, this._openOptions())
      for (const m of msg.m) this._applyRemote(session, m, true)
      return
    }
    for (const m of msg.m) this._applyRemote(session, m, false)
  }

  _dropSession(session, reason) {
    this._clearDeadline(session)
    session.link.sessions.delete(session.sessionKey)
    if (this._rtc.get(session.connId) === session) {
      this._rtc.delete(session.connId)
      this._rtcHost.close(session.connId, reason)
    }
    this._clearFlush(session)
  }

  // A remote description or candidate for the host half. An in-process
  // RtcHost throws for a candidate that reaches a peer connection that has
  // just failed or closed (its ICE transport is gone before its state change
  // reaches us); since a dial sends its candidates after the answer (S-26)
  // that can happen, and it must not escape the node's notification handler.
  _signal(connId, msg) {
    try {
      this._rtcHost.signal(connId, msg)
    } catch (err) {
      this._debug('rtc:signal-error', { connId, type: msg.type, message: err.message })
    }
  }

  // A remote message, already verified. An offer or answer is applied once:
  // the fingerprint §6 step 5 checks against is the one it carried.
  _applyRemote(owner, m, first) {
    if (!m || typeof m !== 'object') return
    if (m.type === 'candidate') {
      if (typeof m.candidate !== 'string') return
      const msg = { type: 'candidate', candidate: m.candidate, mid: m.mid }
      if (owner.kind === 'dial' && !owner.answered) owner.held.push(msg)
      else this._signal(owner.connId, msg)
    } else if (first && m.type === 'offer' && owner.kind === 'host') {
      this._signal(owner.connId, { type: 'offer', sdp: m.sdp })
    }
  }

  // --- viewer role ---

  async _viaPointer(dial, r, unsupported) {
    try {
      const contracts = this._contractSet()
      const ptrParams = route.pointerParamsBytes(r.params.host, r.params.n)
      const { key, id } = nodeClient.contractKey(contracts.pointer.wasm, ptrParams)
      if (id !== r.ptr) throw unsupported
      let record
      try {
        const res = await this._client.get(key, { timeoutMs: POINTER_GET_MS })
        record = JSON.parse(Buffer.from(res.state).toString('utf8'))
      } catch {
        throw unsupported
      }
      if (dial.done) return
      if (!signal.verifyRecord(dial.expectedKey, ptrParams, record)) {
        throw new EngineError(
          CODES.E_AUTH,
          "The Freenet route's pointer record is not signed by the host",
          { backend: 'freenet', detail: 'pointer record not signed by the host' }
        )
      }
      // The record may move the link to another instance (another `n`), so
      // its route is checked without `ptr`.
      const next = { sig: record.sig, code: record.code, params: JSON.parse(record.params), k: r.k }
      this._debug('viewer:pointer', { ...dial.tag, ver: record.ver, instance: record.sig })
      const checked = route.verify(next, dial.expectedKey, contracts)
      await this._startDial(dial, next, checked)
    } catch (err) {
      this._endDial(dial, EngineError.from(err))
    }
  }

  async _startDial(dial, r, checked) {
    const keyPair = this._keyPair()
    const { key, id } = nodeClient.contractKey(checked.wasm, checked.params)
    dial.id = id
    dial.key = key
    dial.params = checked.params
    dial.payloadKey = signal.payloadKey(r.k)
    dial.secretKey = keyPair.secretKey
    dial.cid = crypto.randomBytes(16).toString('hex')
    dial.r = `v:${hex(keyPair.publicKey)}`
    dial.hostR = `h:${hex(keyPair.publicKey)}`
    // The peer connection gathers while the instance is fetched; its offer
    // is written once the subscription is live (`ready`).
    dial.connId = this._nextConnId++
    this._rtc.set(dial.connId, dial)
    this._rtcHost.open(dial.connId, this._openOptions())
    this._rtcHost.openChannel(dial.connId, BOOTSTRAP_CHANNEL, BOOTSTRAP_LABEL)
    const sub = this._subscription(id, key)
    sub.dials.add(dial)
    let state = null
    for (;;) {
      if (dial.done) return
      try {
        state = (await this._client.get(key)).state
        break
      } catch (err) {
        this._debug('viewer:get-miss', { ...dial.tag, instance: id, message: err.message })
        await new Promise((resolve) => setTimeout(resolve, DIAL_GET_GAP_MS))
      }
    }
    try {
      await this._subscribe(sub)
    } catch (err) {
      this._endDial(
        dial,
        unavailable(
          `The 'freenet' share backend could not subscribe to the link: ${err.message}`,
          'subscribe failed'
        )
      )
      return
    }
    if (dial.done) return
    dial.ready = true
    this._debug('viewer:subscribed', {
      ...dial.tag,
      instance: id,
      ms: Math.round(now() - dial.startedAt)
    })
    if (state) this._onState(id, [state])
    this._scheduleFlush(dial, 0)
  }

  // Design §6 step 4: an `h:` entry for this dial counts only if it verifies
  // under the expected key and names this dial's offer. Anything else is
  // ignored and counted; it never reaches the host half, so an attacker's
  // SDP is never applied.
  _dialEntries(dial, entries) {
    if (dial.done || dial.conn || !dial.re) return
    const fresh = []
    for (const e of entries) {
      if (!e || e.l !== dial.cid || e.r !== dial.hostR) continue
      const id = String(e.s)
      if (dial.seen.get(id) === e.g) continue
      dial.seen.set(id, e.g)
      fresh.push(e)
    }
    fresh.sort((a, b) => a.s - b.s)
    for (const e of fresh) {
      if (!signal.verifyEntry(dial.expectedKey, dial.params, e)) {
        this._refuse('viewer:answer-refused', { ...dial.tag, reason: 'signature' })
        continue
      }
      if (e.d) continue
      const msg = signal.open(dial.payloadKey, e.p)
      if (!msg || msg.cid !== dial.cid || !Array.isArray(msg.m)) {
        this._refuse('viewer:answer-refused', { ...dial.tag, reason: 'payload' })
        continue
      }
      if (msg.re !== dial.re) {
        this._refuse('viewer:answer-refused', { ...dial.tag, reason: 'offer' })
        continue
      }
      for (const m of msg.m) {
        if (m && m.type === 'answer' && typeof m.sdp === 'string' && !dial.answered) {
          dial.answered = true
          dial.fingerprint = signal.sdpFingerprint(m.sdp)
          this._debug('viewer:answer', {
            ...dial.tag,
            ms: Math.round(now() - dial.startedAt),
            sinceOfferMs: Math.round(now() - dial.offerAt)
          })
          this._signal(dial.connId, { type: 'answer', sdp: m.sdp })
          for (const held of dial.held.splice(0)) this._signal(dial.connId, held)
          if (dial.ownHeld.length) {
            dial.queue.push(...dial.ownHeld.splice(0))
            this._scheduleFlush(dial)
          }
        } else {
          this._applyRemote(dial, m, false)
        }
      }
    }
  }

  // Cancels (or fails) a dial. Only a dial that surfaced nothing tombstones
  // its entries and closes its peer connection; a live connection is never
  // closed here.
  _endDial(dial, err) {
    if (dial.done) return
    dial.done = true
    this._dials.delete(dial)
    this._unpin(dial.expectedHex)
    const sub = dial.id && this._subs.get(dial.id)
    if (sub) {
      sub.dials.delete(dial)
      this._release(sub)
    }
    if (dial.conn) return
    this._clearFlush(dial)
    const tombstones = this._tombstones(dial)
    if (tombstones.length && this._client) this._write(dial.key, tombstones, TOMBSTONE_TIMEOUT_MS)
    if (dial.connId !== null && this._rtc.get(dial.connId) === dial) {
      this._rtc.delete(dial.connId)
      this._rtcHost.close(dial.connId, 'cancelled')
    }
    dial.reject(err)
  }

  // --- both roles: writing entries ---

  _scheduleFlush(owner, ms = FLUSH_MS) {
    if (owner.timer || !owner.queue.length) return
    owner.timer = setTimeout(() => {
      owner.timer = null
      this._flush(owner)
    }, ms)
  }

  _clearFlush(owner) {
    if (owner.timer) clearTimeout(owner.timer)
    owner.timer = null
    owner.queue.length = 0
  }

  // One entry for everything queued. A dial's first entry carries its offer;
  // its hash is the `re` every answer must name.
  _flush(owner) {
    if (!owner.ready || !owner.queue.length || (owner.kind === 'dial' && owner.done)) return
    const host = owner.kind === 'host'
    // A withdrawn link answers nothing more (design §4 `withdraw`).
    if (host && this._links.get(owner.link.linkId) !== owner.link) return this._clearFlush(owner)
    const m = owner.queue.splice(0)
    const payload = host ? { cid: owner.cid, re: owner.re, m } : { cid: owner.cid, m }
    const payloadKey = host ? owner.link.payloadKey : owner.payloadKey
    const p = signal.seal(payloadKey, payload)
    const keyPair = this._keyPair()
    if (!keyPair) return
    const entry = signal.signEntry(keyPair.secretKey, host ? owner.link.params : owner.params, {
      l: owner.cid,
      r: owner.r,
      s: owner.s++,
      t: Date.now(),
      p
    })
    if (!host && !owner.re && m.some((msg) => msg.type === 'offer')) {
      owner.re = signal.offerRef(p)
      owner.offerAt = now()
    }
    owner.own.push(entry)
    this._write(host ? owner.link.key : owner.key, [entry])
  }

  // Tombstones over the entries `owner` wrote (design §4 `withdraw`, `dial`
  // cancel): same key, later `t`, `d: true`, no payload.
  _tombstones(owner) {
    const keyPair = this._keyPair()
    if (!keyPair || !owner.own.length) return []
    const params = owner.kind === 'host' ? owner.link.params : owner.params
    const at = Date.now()
    const out = owner.own.splice(0).map((e) =>
      signal.signEntry(keyPair.secretKey, params, {
        l: e.l,
        r: e.r,
        s: e.s,
        t: Math.max(at, e.t + 1),
        d: true
      })
    )
    return out
  }

  // A delta through the node. Refused writes are never answered (S-19); a
  // failure is reported, never thrown.
  _write(key, entries, timeoutMs) {
    const client = this._client
    if (!client) return Promise.resolve()
    const delta = Buffer.from(JSON.stringify({ e: entries }))
    return client.update(key, delta, { timeoutMs }).then(
      () => {},
      (err) => this._debug('node:update-error', { entries: entries.length, message: err.message })
    )
  }

  // --- the host half (RtcHost / RtcRemote events) ---

  _listenRtc() {
    const rtc = this._rtcHost
    if (!rtc || this._rtcListeners) return
    this._rtcListeners = {
      signal: (body) => this._onRtcSignal(body),
      state: (body) => this._onRtcState(body),
      close: (body) => this._onRtcClose(body),
      channel: (body) => this._onRtcChannel('channel', body),
      data: (body) => this._onRtcChannel('data', body),
      flow: (body) => this._onRtcChannel('flow', body)
    }
    for (const [name, fn] of Object.entries(this._rtcListeners)) rtc.on(name, fn)
  }

  _unlistenRtc() {
    const rtc = this._rtcHost
    if (!rtc || !this._rtcListeners) return
    for (const [name, fn] of Object.entries(this._rtcListeners)) rtc.off(name, fn)
    this._rtcListeners = null
  }

  _onRtcSignal(body) {
    const owner = this._rtc.get(body.connId)
    if (!owner || owner.conn) return
    if (owner.kind === 'dial' && owner.done) return
    const m = messageOf(body)
    // The dialing side sends its candidates only once it has applied the
    // answer. With them, the host half reaches ICE `connected` by its own
    // checks while the answer is still on its way through the contract; the
    // viewer's peer connection, given that answer late (a slow notification,
    // a busy machine), then goes ICE-connected the instant it applies it and
    // node-datachannel checks the DTLS certificate before it has stored the
    // answer's fingerprint: `certificate verify failed`, the connection
    // `failed` (S-26). Without them the host sends no check until the
    // viewer's own arrive, which the viewer sends only once it holds the
    // answer.
    if (owner.kind === 'dial' && m.type === 'candidate' && !owner.answered) {
      owner.ownHeld.push(m)
      return
    }
    owner.queue.push(m)
    this._scheduleFlush(owner)
  }

  // Design §6 step 5: `connected` counts only when the certificate the DTLS
  // handshake presented is the one inside the SDP the peer signed.
  _onRtcState(body) {
    const owner = this._rtc.get(body.connId)
    if (!owner) return
    if (owner.conn) {
      if (body.state === 'connected') owner.conn._setPathKind(body.pathKind)
      owner.conn._state = body.state
      return
    }
    if (body.state === 'connected') {
      if (!owner.fingerprint || body.remoteFingerprint !== owner.fingerprint) {
        this._authFailed(owner)
        return
      }
      this._surface(owner, body.pathKind)
    } else if (body.state === 'failed' || body.state === 'closed') {
      this._lost(owner, body.state === 'failed' ? 'ice-failed' : 'closed')
    }
  }

  // Channel events reach the connection they belong to. Before it surfaced
  // (design §6 step 5 still pending) they are held, and dropped with the
  // owner if it never does.
  _onRtcChannel(kind, body) {
    const owner = this._rtc.get(body.connId)
    if (!owner) return
    if (!owner.conn) {
      if (!owner.early) owner.early = []
      owner.early.push([kind, body])
      return
    }
    dispatchChannel(owner.conn, kind, body)
  }

  _onRtcClose(body) {
    const owner = this._rtc.get(body.connId)
    if (!owner) return
    this._rtc.delete(body.connId)
    if (owner.conn) this._connClosed(owner, body.reason || 'closed')
    else this._lost(owner, body.reason === 'failed' ? 'ice-failed' : body.reason || 'closed')
  }

  _authFailed(owner) {
    this._rtc.delete(owner.connId)
    this._rtcHost.close(owner.connId, 'fingerprint mismatch')
    this._refuse(
      owner.kind === 'dial' ? 'viewer:fingerprint-mismatch' : 'host:fingerprint-mismatch',
      {
        ...(owner.kind === 'dial' ? owner.tag : owner.link.tag),
        peer: owner.kind === 'dial' ? owner.expectedHex : owner.viewer
      }
    )
    if (owner.kind === 'dial') {
      this._endDial(
        owner,
        new EngineError(
          CODES.E_AUTH,
          'The Freenet peer presented a certificate its signed SDP does not name',
          { backend: 'freenet', detail: 'fingerprint mismatch' }
        )
      )
    } else {
      this._dropSession(owner, 'fingerprint mismatch')
    }
  }

  // A peer connection that ended before it surfaced.
  _lost(owner, reason) {
    if (owner.kind === 'dial') {
      this._endDial(
        owner,
        new EngineError(CODES.E_HOST_UNREACHABLE, 'The Freenet peer connection failed', {
          backend: 'freenet',
          detail: reason
        })
      )
    } else {
      this._debug('host:connection-lost', { ...owner.link.tag, peer: owner.viewer, reason })
      this._dropSession(owner, reason)
    }
  }

  _surface(owner, pathKind) {
    const dialing = owner.kind === 'dial'
    const tag = dialing ? owner.tag : owner.link.tag
    const conn = new FreenetConnection({
      rtcHost: this._rtcHost,
      connId: owner.connId,
      remotePeerKey: dialing ? owner.expectedKey : owner.remoteKey,
      initiator: dialing,
      pathKind,
      debug: (event, details) => this._debug(event, { ...tag, ...details })
    })
    conn._state = 'connected'
    owner.conn = conn
    this._conns.add(conn)
    this._clearFlush(owner)
    this._clearDeadline(owner)
    const early = owner.early || []
    owner.early = null
    const ms = Math.round(now() - owner.startedAt)
    if (dialing) {
      this._debug('viewer:connected', {
        ...owner.tag,
        peer: owner.expectedHex,
        path: conn.path(),
        ms
      })
      owner.resolve(conn)
      // 'connection' fires on both sides, with the object `connected`
      // resolved to on this one.
      this.emit('connection', conn, { linkId: null })
    } else {
      const { linkId } = owner.link
      this._debug('host:connected', { ...owner.link.tag, linkId, peer: owner.viewer, ms })
      this.emit('connection', conn, { linkId })
    }
    // After 'connection', so the listeners' onChannel callbacks are in place.
    for (const [kind, body] of early) dispatchChannel(conn, kind, body)
  }

  _connClosed(owner, reason) {
    const conn = owner.conn
    this._conns.delete(conn)
    if (owner.kind === 'host') owner.link.sessions.delete(owner.sessionKey)
    conn._closed(reason)
  }

  // --- subscriptions ---

  _subscription(id, key) {
    let sub = this._subs.get(id)
    if (!sub) {
      sub = { id, key, link: null, dials: new Set(), subscribed: false, pending: null, entries: 0 }
      this._subs.set(id, sub)
    }
    return sub
  }

  _subscribe(sub) {
    if (sub.subscribed) return Promise.resolve()
    if (!sub.pending) {
      sub.pending = this._client.subscribe(sub.key).then(
        () => {
          sub.pending = null
          sub.subscribed = true
        },
        (err) => {
          sub.pending = null
          throw err
        }
      )
    }
    return sub.pending
  }

  // Nobody listens to the instance any more. The node keeps notifying (the
  // SDK has no unsubscribe); _onState drops what nobody claims.
  _release(sub) {
    if (sub.link || sub.dials.size) return
    if (this._subs.get(sub.id) === sub) this._subs.delete(sub.id)
  }

  _onNotification(n) {
    const id = n && n.key && typeof n.key.encode === 'function' ? n.key.encode() : null
    if (id === null) return
    this._onState(id, nodeClient.notificationParts(n))
  }

  // State or delta bytes for instance `id`.
  _onState(id, parts) {
    const sub = this._subs.get(id)
    if (!sub) return
    const entries = []
    for (const part of parts) entries.push(...entriesOf(part))
    this._onEntries(id, entries)
  }

  _onEntries(id, entries) {
    const sub = this._subs.get(id)
    if (!sub) return
    sub.entries = entries.length
    if (sub.link) this._hostEntries(sub.link, entries)
    for (const dial of Array.from(sub.dials)) this._dialEntries(dial, entries)
  }

  // --- admission and pins ---

  _admits(remoteKey, link) {
    if (this._pinned.has(hex(remoteKey))) return true
    try {
      return !!this._admission(remoteKey, { remotePeerKey: remoteKey, linkId: link.linkId })
    } catch {
      return false
    }
  }

  // Design §7 layer 4: the limit an offer from `viewer` (hex) on `link`
  // would pass, or null. Stale half-open peer connections go first (S-22).
  _overLimit(link, viewer) {
    this._expireHalfOpen(link)
    if (halfOpen(link) >= MAX_HALF_OPEN) return 'half-open'
    if (halfOpen(link, viewer) >= MAX_HALF_OPEN_PER_VIEWER) return 'half-open-viewer'
    if (this._answeredInWindow(link) >= MAX_ANSWERS_PER_MINUTE) return 'rate'
    return null
  }

  // S-22: every half-open peer connection of `link` past its deadline (on
  // this._clock) is closed and counted in the link's `refused`.
  _expireHalfOpen(link) {
    const at = this._clock()
    for (const session of Array.from(link.sessions.values())) {
      if (session.conn || session.deadline > at) continue
      link.refused++
      this._refuse('host:half-open-expired', {
        ...link.tag,
        linkId: link.linkId,
        peer: session.viewer
      })
      this._dropSession(session, 'half-open timeout')
    }
  }

  // A real timer backs the clock check, so a stale slot frees even when no
  // further offer arrives. With a clock that has not reached the deadline
  // (a test's fake one) it checks again later.
  _armDeadline(session, ms) {
    this._clearDeadline(session)
    session.deadlineTimer = setTimeout(() => {
      session.deadlineTimer = null
      if (session.conn || session.link.sessions.get(session.sessionKey) !== session) return
      this._expireHalfOpen(session.link)
      if (session.link.sessions.get(session.sessionKey) === session && !session.conn) {
        this._armDeadline(session, Math.max(1000, session.deadline - this._clock()))
      }
    }, ms)
  }

  _clearDeadline(owner) {
    if (owner && owner.deadlineTimer) clearTimeout(owner.deadlineTimer)
    if (owner) owner.deadlineTimer = null
  }

  _answeredInWindow(link) {
    const since = this._clock() - ANSWER_WINDOW_MS
    while (link.answers.length && link.answers[0] <= since) link.answers.shift()
    return link.answers.length
  }

  _pin(keyHex) {
    this._pinned.set(keyHex, (this._pinned.get(keyHex) || 0) + 1)
  }

  _unpin(keyHex) {
    const count = (this._pinned.get(keyHex) || 0) - 1
    if (count <= 0) this._pinned.delete(keyHex)
    else this._pinned.set(keyHex, count)
  }

  _refuse(event, details) {
    this._refused++
    this._debug(event, details)
  }

  // --- misc ---

  _usable() {
    if (!this._started || !this._client) {
      throw unavailable("The 'freenet' share backend is not started", 'not started')
    }
    if (!this._rtcHost) {
      throw unavailable(`The 'freenet' share backend cannot connect: ${NO_RTC_HOST}`, NO_RTC_HOST)
    }
  }

  _openOptions() {
    return this._iceServersGiven ? { iceServers: this._iceServersGiven } : {}
  }

  _onNodeClose() {
    if (!this._client) return
    this._client = null
    this._nodeProblem = `lost the Freenet node at ${this._nodeUrl}`
    this._debug('node:closed', { address: this._nodeUrl })
  }

  _debug(event, details = {}) {
    this.emit('debug', { event, details })
  }
}

module.exports = FreenetBackend
module.exports.MAX_ANSWERS_PER_MINUTE = MAX_ANSWERS_PER_MINUTE
module.exports.ANSWER_WINDOW_MS = ANSWER_WINDOW_MS
module.exports.MAX_HALF_OPEN = MAX_HALF_OPEN
module.exports.HALF_OPEN_TIMEOUT_MS = HALF_OPEN_TIMEOUT_MS
module.exports.MAX_HALF_OPEN_PER_VIEWER = MAX_HALF_OPEN_PER_VIEWER
module.exports.PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS
