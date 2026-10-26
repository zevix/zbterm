// The Freenet share backend: a thin proxy to the Freenet transport service
// of the Rust `zxterm-core` sidecar (zxterm K10, stage C1; wired here in K11,
// ZBTerm D-34). Everything the backend used to do in this process - the
// contract client, the invite route, the signalling entries, the WebRTC
// handshake and its checks (design §6), the per-link admission limits
// (design §7 layer 4, S-22), the data channels (S-26, S-27) - runs in the
// core now (`zxterm_core::freenet::backend::Backend`, reached through the
// seam's `freenet.*` methods, `zxterm_core::seam::freenet_methods`). This
// file is the `rtc-remote.js` pattern moved one hop (zxterm design §4.3):
// every ShareBackend call becomes a seam request, every core event an
// EventEmitter event, and every channel's bytes travel as the seam's
// non-droppable `Chan` frames.
//
// The sidecar is the profile's own (`engine/zxterm/core.js`, the `core`
// constructor option ShareManager passes from its engine); a backend made
// without one opens a sidecar of its own on a scratch directory.
//
// Channels. Over the seam every channel is raw (zxterm X-17): the core
// pairs data channels and handles the READY part (S-27), and hands over
// every data-channel message as it arrived. A JSON channel keeps the wire it
// always had, framed here: a message is JSON, then UTF-8, cut into parts of
// at most MAX_MESSAGE_SIZE bytes, each with the 5-byte header
// `[flags u8][index u32 LE]` (flags bit 0: last part). One part is one
// `Chan` frame, and the core keeps every send of at most MAX_MESSAGE_SIZE
// bytes one data-channel message, so the boundaries survive. A raw channel
// (`openRawChannel`) hands the bytes over as they arrived. A session's history
// is not carried here any more: since K17 of zxterm-core (ZBTerm D-40) the
// core serves and reads it on the session protocol's `history` channel
// (`engine/zxterm/history.js`), and this backend only hands out the handle.
//
// Back-pressure is advisory, as on the loopback: `send()` never drops a
// message on an open channel; it returns false while the core reports the
// channel over its mark (`freenet.backpressure` until `freenet.drain`), while
// the seam socket's buffer is full, or while QUEUE_HIGH_WATER bytes wait here
// for the channel's handle.
//
// Admission crosses the seam as `true`, `false` or a list of keys (X-17). A
// policy function (ShareManager's `() => this.hostShares.size > 0`) is
// evaluated without a key when it is set, once the backend has started, and
// before every announce; a list of 32-byte keys is sent as it is.
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { EngineError, CODES } = require('../../errors')
const { CAP, PATH } = require('../types')
const { Core } = require('../../zxterm/core')
const { CoreHistoryHandle } = require('../../zxterm/history')
const { bridgeFor } = require('../../zxterm/share')

const DEFAULT_NODE_URL = 'ws://127.0.0.1:7509/v1/contract/command'
// A process-wide replacement for DEFAULT_NODE_URL. Tests set it to a closed
// port (test/helpers/zxterm-core.js), so a backend made without a node
// address can never reach a real node on 7509 (A-9); nothing else sets it.
const DEFAULT_NODE_KEY = Symbol.for('zbterm.freenetDefaultNode')

function defaultNodeUrl() {
  return globalThis[DEFAULT_NODE_KEY] || DEFAULT_NODE_URL
}
// probe(): how long a WebSocket to the node may take to open (A-11: 2 s).
const PROBE_TIMEOUT_MS = 2000
// Design §7 layer 4 (A-12) and S-22, enforced by the core
// (`zxterm_core::freenet::backend::{MAX_ANSWERS_PER_MINUTE, ANSWER_WINDOW_MS,
// MAX_HALF_OPEN, HALF_OPEN_TIMEOUT_MS, MAX_HALF_OPEN_PER_VIEWER}`); named here
// for callers and tests.
const MAX_ANSWERS_PER_MINUTE = 30
const ANSWER_WINDOW_MS = 60 * 1000
const MAX_HALF_OPEN = 8
const HALF_OPEN_TIMEOUT_MS = 15000
const MAX_HALF_OPEN_PER_VIEWER = 2
// JSON channel framing (the wire of the former channel.js, unchanged).
const MAX_MESSAGE_SIZE = 65536
const HEADER_BYTES = 5
const PART_BYTES = MAX_MESSAGE_SIZE - HEADER_BYTES
const LAST = 1
// Bytes a channel holds here before its handle is known, past which send()
// reports back-pressure (they are still sent).
const QUEUE_HIGH_WATER = 256 * 1024
// diagnostics(): the core's own figures are fetched in the background, at
// most this often.
const DIAGNOSTICS_REFRESH_MS = 500

// The capabilities the core describes (`zxterm_core::freenet::backend::
// CAPABILITIES`): no DIRECT_DIAL, no PATH_MIGRATION, and never RELAY - the
// core has no TURN client (zxterm X-18).
const CAPABILITIES =
  CAP.AUTHENTICATED_PEER |
  CAP.MULTIPLEXED_STREAMS |
  CAP.ORDERED_STREAM |
  CAP.EPHEMERAL_DELIVERY |
  CAP.NAT_TRAVERSAL |
  CAP.BROKERED |
  CAP.HISTORY_SPARSE_READ |
  CAP.HISTORY_HEAD_WATCH

function hex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

function unavailable(message, detail) {
  return new EngineError(CODES.E_BACKEND_UNAVAILABLE, message, { backend: 'freenet', detail })
}

// A seam error as the backend's EngineError. The core sends its details
// appended to the message (`<message>: <details>`); they come back as
// `details.detail`.
function fromCore(code, message) {
  const text = String(message || '')
  const at = text.lastIndexOf(': ')
  const detail = at > 0 ? text.slice(at + 2) : null
  return new EngineError(code || CODES.E_INTERNAL, text, { backend: 'freenet', detail })
}

function fromSeamError(err) {
  if (err && err.details && err.details.backend === 'freenet') return err
  return fromCore(err && err.code, err && err.message)
}

// An ICE URL without its credentials (`turn:user:secret@host:port` ->
// `turn:host:port`), for diagnostics.
function redactIceServer(server) {
  const url = typeof server === 'string' ? server : server && server.urls
  return String([].concat(url || '')[0]).replace(/^(turns?:)[^@]*@/i, '$1')
}

function iceUrls(iceServers) {
  const out = []
  for (const server of iceServers) {
    const urls = typeof server === 'string' ? server : server && server.urls
    for (const url of [].concat(urls || [])) if (typeof url === 'string') out.push(url)
  }
  return out
}

function labelOf(protocol, id) {
  return protocol + ' ' + hex(id)
}

// A message as the parts that carry it.
function cut(message) {
  const text = JSON.stringify(message)
  if (text === undefined) throw new TypeError('A channel message must be JSON')
  const body = Buffer.from(text, 'utf8')
  const count = Math.max(1, Math.ceil(body.byteLength / PART_BYTES))
  const parts = []
  for (let index = 0; index < count; index++) {
    const chunk = body.subarray(index * PART_BYTES, (index + 1) * PART_BYTES)
    const part = Buffer.allocUnsafe(HEADER_BYTES + chunk.byteLength)
    part[0] = index === count - 1 ? LAST : 0
    part.writeUInt32LE(index, 1)
    chunk.copy(part, HEADER_BYTES)
    parts.push(part)
  }
  return parts
}

// A sidecar of this backend's own, on a scratch directory: for a backend
// constructed without the profile's (tests, scripts, a probe without one).
function scratchCore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxf-'))
  const core = new Core(dir)
  return {
    core,
    release() {
      core.close()
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// One channel over the seam: its handle (`chan`) arrives with the reply to
// the open request; bytes sent before that wait here.
class SeamChannel {
  constructor(conn, protocol, id, handlers = {}) {
    // Replaceable: whatever is assigned at delivery time receives the message.
    this.onmessage = handlers.onmessage || noop
    this.onclose = handlers.onclose || noop
    this.ondrain = handlers.ondrain || noop
    this.protocol = protocol
    this.id = Buffer.from(id)
    this.label = labelOf(protocol, this.id)
    this._conn = conn
    this._backend = conn._backend
    this._chan = null
    this._closed = false
    this._out = []
    this._outBytes = 0
    // The core reported this channel over its mark (freenet.backpressure).
    this._paused = false
    // A Chan frame of this channel met a full seam socket.
    this._full = false
  }

  _open() {
    const conn = this._conn
    const args = { conn: conn._id, protocol: this.protocol, id: hex(this.id) }
    this._backend._opening++
    this._backend
      ._request('freenet.openChannel', args)
      .finally(() => {
        this._backend._opening--
      })
      .then(({ chan }) => {
        if (this._closed) {
          this._backend._request('freenet.closeChannel', { chan }).catch(noop)
          return
        }
        this._chan = chan
        this._backend._chans.set(chan, this)
        const out = this._out.splice(0)
        this._outBytes = 0
        for (const part of out) this._send(part)
        this._backend._claimOrphans(chan, this)
        if (this._takesMore()) this.ondrain()
      })
      .catch((err) => {
        this._backend._debug('channel:open-error', { label: this.label, message: err.message })
        this._shut()
      })
  }

  _write(part) {
    if (this._chan === null) {
      this._out.push(part)
      this._outBytes += part.byteLength
      return
    }
    this._send(part)
  }

  _send(part) {
    if (!this._backend._core.sendChan(this._chan, part)) this._full = true
  }

  _takesMore() {
    return !this._closed && !this._paused && !this._full && this._outBytes < QUEUE_HIGH_WATER
  }

  close() {
    if (this._closed) return
    if (this._chan !== null) {
      this._backend._request('freenet.closeChannel', { chan: this._chan }).catch(noop)
    }
    this._shut()
  }

  // Fires onclose once; the channel no longer sends or reads.
  _shut() {
    if (this._closed) return
    this._closed = true
    this._out.length = 0
    this._outBytes = 0
    this._conn._forgetChannel(this)
    if (this._chan !== null && this._backend._chans.get(this._chan) === this) {
      this._backend._chans.delete(this._chan)
    }
    try {
      this.onclose()
    } catch (err) {
      this._conn._fail(err)
    }
  }

  _backpressure() {
    this._paused = true
  }

  _drained() {
    this._paused = false
    if (this._takesMore()) this.ondrain()
  }

  _socketDrained() {
    if (!this._full) return
    this._full = false
    if (this._takesMore()) this.ondrain()
  }
}

// A channel of JSON messages (types.js MessageChannel).
class JsonChannel extends SeamChannel {
  constructor(conn, protocol, id, handlers) {
    super(conn, protocol, id, handlers)
    this._parts = []
  }

  send(message) {
    if (this._closed) return false
    for (const part of cut(message)) this._write(part)
    return this._takesMore()
  }

  _data(part) {
    if (this._closed) return
    if (part.byteLength < HEADER_BYTES || part.readUInt32LE(1) !== this._parts.length) {
      this._backend._debug('channel:malformed', { label: this.label })
      this.close()
      return
    }
    this._parts.push(part.subarray(HEADER_BYTES))
    if ((part[0] & LAST) === 0) return
    const body = this._parts.length === 1 ? this._parts[0] : Buffer.concat(this._parts)
    this._parts = []
    let message
    try {
      message = JSON.parse(body.toString('utf8'))
    } catch {
      this._backend._debug('channel:malformed', { label: this.label })
      this.close()
      return
    }
    try {
      this.onmessage(message)
    } catch (err) {
      this._conn._fail(err)
    }
  }
}

// A channel of bytes: a send is cut into data-channel messages
// of at most MAX_MESSAGE_SIZE bytes, and every message is handed to
// `onmessage` as it arrives. `ondrain` fires whenever it takes more.
class RawChannel extends SeamChannel {
  send(bytes) {
    if (this._closed) return false
    for (let at = 0; at < bytes.byteLength; at += MAX_MESSAGE_SIZE) {
      this._write(bytes.subarray(at, Math.min(bytes.byteLength, at + MAX_MESSAGE_SIZE)))
    }
    return this._takesMore()
  }

  _data(bytes) {
    if (this._closed) return
    try {
      this.onmessage(bytes)
    } catch (err) {
      this._conn._fail(err)
    }
  }
}

// One authenticated Freenet peer connection (types.js PeerConnection), held
// by the core as `conn`. It exists only once the core surfaced it: design §6
// step 5 passed there.
class FreenetConnection extends EventEmitter {
  constructor(backend, id, { remotePeerKey, initiator, linkId, path }) {
    super()
    this.remotePeerKey = remotePeerKey
    this.initiator = initiator
    this.closed = false
    this.linkId = linkId || null
    this._backend = backend
    this._id = id
    this._path = path === PATH.RELAY ? PATH.RELAY : PATH.DIRECT
    // key -> this side's channel.
    this._channels = new Map()
    // key -> { protocol, id, notified }: channels the remote opened that this
    // side has not taken with openChannel yet (the core holds their bytes).
    this._pending = new Map()
    // protocol -> onChannel callback.
    this._onChannel = new Map()
  }

  path() {
    return this._path
  }

  openChannel(protocol, id, handlers) {
    return this._openChannel(protocol, id, handlers, JsonChannel)
  }

  // A byte channel.
  openRawChannel(protocol, id, handlers) {
    return this._openChannel(protocol, id, handlers, RawChannel)
  }

  _openChannel(protocol, id, handlers, Channel) {
    if (this.closed) throw new Error('Connection is closed')
    const key = labelOf(protocol, id)
    if (this._channels.has(key)) {
      throw new Error(`Channel ${key} is already open on this connection`)
    }
    const channel = new Channel(this, protocol, id, handlers)
    this._channels.set(key, channel)
    this._pending.delete(key)
    channel._open()
    return channel
  }

  onChannel(protocol, cb) {
    this._onChannel.set(protocol, cb)
    // Channels the remote opened before this side was listening.
    for (const pending of this._pending.values()) {
      if (pending.protocol === protocol) queueMicrotask(() => this._notify(pending))
    }
  }

  close(reason) {
    if (this.closed) return
    this._backend
      ._request('freenet.closeConnection', { conn: this._id, reason: reason || 'closed' })
      .catch(noop)
    this._closed(reason || 'closed')
  }

  // freenet.incomingChannel: the remote opened (protocol, id).
  _incoming(protocol, id) {
    const key = labelOf(protocol, id)
    if (this.closed || this._channels.has(key) || this._pending.has(key)) return
    const pending = { protocol, id, notified: false }
    this._pending.set(key, pending)
    this._notify(pending)
  }

  _notify(pending) {
    const key = labelOf(pending.protocol, pending.id)
    if (this.closed || pending.notified || this._pending.get(key) !== pending) return
    const cb = this._onChannel.get(pending.protocol)
    if (!cb) return
    pending.notified = true
    try {
      cb(Buffer.from(pending.id))
    } catch (err) {
      this._fail(err)
    }
  }

  _forgetChannel(channel) {
    if (this._channels.get(channel.label) === channel) this._channels.delete(channel.label)
  }

  // A handler that throws takes the connection down, as on the loopback.
  _fail(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err)
    this.close('handler error')
  }

  _setPath(path) {
    const next = path === PATH.RELAY ? PATH.RELAY : PATH.DIRECT
    if (next === this._path) return
    this._path = next
    this.emit('path', next)
  }

  // Every channel hears onclose once, then the connection emits 'close'.
  _closed(reason) {
    if (this.closed) return
    this.closed = true
    for (const channel of Array.from(this._channels.values())) channel._shut()
    this._pending.clear()
    this._onChannel.clear()
    if (this._backend._conns.get(this._id) === this) this._backend._conns.delete(this._id)
    this.emit('close', reason)
  }
}

class FreenetBackend extends EventEmitter {
  // The registry's self-check hook (../index.js::load): the module loaded,
  // so the backend is usable. Whether a node answers is probe()'s, and
  // whether a sidecar runs is start()'s.
  static availability() {
    return { state: 'available', detail: null }
  }

  // A-11, D-12: `share.backends` asks whether a node answers at `nodeUrl`
  // (engine/backends/index.js::probe). The core opens one WebSocket and
  // closes it; nothing is put or subscribed. ZBTerm never starts a node.
  static async probe(ctx = {}) {
    const nodeUrl = ctx.nodeUrl || defaultNodeUrl()
    const timeoutMs = Number.isFinite(ctx.timeoutMs) ? ctx.timeoutMs : PROBE_TIMEOUT_MS
    const own = ctx.core ? null : scratchCore()
    const core = ctx.core || own.core
    try {
      const answer = await core.request('freenet.probe', { nodeUrl, timeoutMs })
      if (answer && answer.state === 'available') return { state: 'available', detail: null }
      return {
        state: 'broken',
        detail: `${(answer && answer.detail) || 'no Freenet node'} — see README "Freenet"`
      }
    } catch (err) {
      return { state: 'broken', detail: err.message }
    } finally {
      if (own) own.release()
    }
  }

  // `nodeUrl` is a constructor option, never read from the environment: the
  // worker's environment is not reliably inherited (../../worker.js). The
  // host names it with the worker's `freenetNode` spawn argument
  // (docs/CORE-CONTRACT.md 3); tests name a throwaway node's. `iceServers`
  // (D-11) reach the core with start() and setIceServers(); without them the
  // core's own default list applies. `core` is the profile's sidecar
  // (engine/zxterm/core.js); `loopbackOnly` makes the core offer loopback
  // candidates only (tests).
  constructor({ nodeUrl, iceServers, core, loopbackOnly } = {}) {
    super()
    this._nodeUrl = nodeUrl || defaultNodeUrl()
    this._iceServersGiven = null
    this.setIceServers(iceServers)
    this._core = core || null
    this._ownCore = null
    this._loopbackOnly = !!loopbackOnly
    this._ctx = null
    this._starting = null
    this._started = false
    this._nodeProblem = null
    // Why the last start() failed, for the calls that needed it.
    this._startError = null
    this._listeners = null
    // linkId -> route: the links this backend announced.
    this._links = new Map()
    // The core's handles: connections, channels, dials.
    this._conns = new Map()
    this._chans = new Map()
    this._dials = new Map()
    // Events for a dial whose handle is not known here yet.
    this._dialStash = new Map()
    // conn -> the dial whose freenet.dialConnected came before the
    // connection's freenet.connection.
    this._dialByConn = new Map()
    // freenet.dial requests awaiting their reply: while there are any, an
    // event for an unknown dial is stashed for the reply that names it.
    this._dialsInFlight = 0
    // Connections of dials that ended here before the core connected them.
    this._unwanted = new Set()
    // Ids of dials this backend cancelled (`freenet.dialConnected` for any
    // other id belongs to a dial the core made for itself, K14: the session
    // protocol's `share.join`, whose connection this backend must not close).
    this._cancelled = new Set()
    // Requests that open a channel on the core and are still unanswered.
    this._opening = 0
    // chan -> bytes that arrived before the channel's handle was known here.
    this._orphans = new Map()
    this._admission = false
    this._diag = null
    this._diagAt = 0
    this._diagPending = null
  }

  describe() {
    return {
      id: 'freenet',
      label: 'Freenet (experimental)',
      interfaceVersion: 1,
      capabilities: CAPABILITIES
    }
  }

  // D-11: the ICE servers every new peer connection gets (an array of ICE
  // URLs; [] means host candidates only). Anything else leaves the core's
  // own list in charge.
  setIceServers(iceServers) {
    this._iceServersGiven = Array.isArray(iceServers) ? iceUrls(iceServers) : null
    if (this._started) {
      this._request('freenet.setIceServers', { iceServers: this._iceServersGiven }).catch((err) =>
        this._debug('core:ice-error', { message: err.message })
      )
    }
  }

  // Starts the core's backend, which opens one WebSocket to the node and
  // nothing else: no contract is put or subscribed.
  start(ctx) {
    if (this._started) return Promise.resolve()
    if (this._starting) return this._starting
    this._ctx = ctx || {}
    this._starting = this._start().then(
      () => {
        this._starting = null
      },
      (err) => {
        this._starting = null
        throw err
      }
    )
    return this._starting
  }

  async _start() {
    const keyPair = this._keyPair()
    if (!keyPair || !keyPair.secretKey) {
      throw unavailable("The 'freenet' share backend has no transport key", 'no transport key')
    }
    if (!this._core) {
      this._ownCore = scratchCore()
      this._core = this._ownCore.core
    }
    this._listen()
    const args = { secretKey: hex(keyPair.secretKey), nodeUrl: this._nodeUrl }
    if (this._iceServersGiven) args.iceServers = this._iceServersGiven
    if (this._loopbackOnly) args.loopbackOnly = true
    try {
      await this._core.request('freenet.start', args)
    } catch (err) {
      const failed = fromSeamError(err)
      this._nodeProblem = failed.details.detail || failed.message
      this._startError = failed
      throw failed
    }
    this._started = true
    this._nodeProblem = null
    this._startError = null
    this._pushAdmission()
  }

  // Cancels every dial, withdraws every link (tombstones, best effort),
  // closes every peer connection, then the socket - all in the core.
  async stop() {
    const starting = this._starting
    if (starting) await starting.catch(() => {})
    for (const dial of Array.from(this._dials.values())) {
      this._endDial(dial, new Error('Backend stopped'))
    }
    this._links.clear()
    if (this._started) await this._request('freenet.stop', {}).catch(() => {})
    this._started = false
    for (const conn of Array.from(this._conns.values())) conn._closed('stopped')
    this._chans.clear()
    this._orphans.clear()
    this._cancelled.clear()
    this._unlisten()
    if (this._ownCore) {
      this._ownCore.release()
      this._ownCore = null
      this._core = null
    }
  }

  // `listening` while at least one announced link is subscribed.
  health() {
    return {
      started: this._started,
      listening: this._started && this._links.size > 0,
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

  // A stored route is returned as it is, synchronously. A new one is minted
  // by the core (offline: `zxterm_core::freenet::route::mint`), so this
  // returns a promise then; it waits for a start() still under way.
  routeFor(linkId, stored) {
    if (stored && stored.route) return stored.route
    return this._mint(linkId)
  }

  async _mint(linkId) {
    if (this._starting) await this._starting.catch(() => {})
    if (!this._started) {
      throw (
        this._startError ||
        unavailable(
          "The 'freenet' share backend has no transport key to mint a route with",
          'no transport key'
        )
      )
    }
    return this._request('freenet.routeFor', { linkId })
  }

  // Design §4 `announce`, in the core: the link's signalling instance and its
  // pointer record are put and subscribed. announce waits for a start() still
  // under way: ShareManager starts the backend and announces without
  // awaiting (S-23).
  async announce(linkId, opts = {}) {
    if (this._starting) await this._starting.catch(() => {})
    this._usable()
    const known = this._links.get(linkId)
    if (known) return { route: known, linkId }
    this._pushAdmission()
    const args = { linkId }
    if (opts.route) args.route = opts.route
    if (opts.tag) args.tag = opts.tag
    const { route } = await this._request('freenet.announce', args)
    this._links.set(linkId, route)
    return { route, linkId }
  }

  // D-04: ends discovery, not reachability. Idempotent; live connections
  // survive it.
  async withdraw(linkId) {
    if (!this._links.has(linkId)) return
    this._links.delete(linkId)
    await this._request('freenet.withdraw', { linkId }).catch((err) =>
      this._debug('core:withdraw-error', { linkId, message: err.message })
    )
  }

  // Design §4 `dial` and §6, in the core: the route is checked there before a
  // byte reaches the node, and a route naming another host than
  // `expectedPeerKey` stays pending until the caller cancels. A dial made
  // while start() is still opening begins once start() settles.
  dial(route, expectedPeerKey, opts = {}) {
    const dial = {
      id: null,
      expectedKey: Buffer.from(expectedPeerKey),
      done: false,
      conn: null,
      resolve: null,
      reject: null
    }
    const connected = new Promise((resolve, reject) => {
      dial.resolve = resolve
      dial.reject = reject
    })
    // A cancelled dial is an expected outcome, not an unhandled rejection.
    connected.catch(() => {})
    const cancel = () => this._endDial(dial, new Error('Dial was cancelled'))
    if (opts.signal) {
      if (opts.signal.aborted) queueMicrotask(cancel)
      else opts.signal.addEventListener('abort', cancel, { once: true })
    }
    const go = () => {
      if (!dial.done) this._beginDial(dial, route, opts)
    }
    if (this._starting) this._starting.then(go, go)
    else go()
    return { connected, cancel }
  }

  async _beginDial(dial, route, opts) {
    try {
      this._usable()
      const args = { route, expectedPeerKey: hex(dial.expectedKey) }
      if (opts.tag) args.tag = opts.tag
      this._dialsInFlight++
      let id
      try {
        ;({ dial: id } = await this._request('freenet.dial', args))
      } finally {
        this._dialsInFlight--
      }
      if (dial.done) {
        this._cancelled.add(id)
        this._request('freenet.cancelDial', { dial: id }).catch(noop)
        return
      }
      dial.id = id
      this._dials.set(id, dial)
      const stashed = this._dialStash.get(id) || []
      this._dialStash.delete(id)
      // What is left belongs to dials the core made for itself.
      if (this._dialsInFlight === 0) this._dialStash.clear()
      for (const event of stashed) this._onEvent(event)
    } catch (err) {
      this._endDial(dial, fromSeamError(err))
    }
  }

  // Cancels (or fails) a dial. A live connection is never closed here.
  _endDial(dial, err) {
    if (dial.done) return
    dial.done = true
    if (dial.id !== null) {
      this._dials.delete(dial.id)
      if (!dial.conn) {
        this._cancelled.add(dial.id)
        this._request('freenet.cancelDial', { dial: dial.id }).catch(noop)
      }
    }
    if (dial.conn) return
    dial.reject(err)
  }

  // `true`, `false`, a list of 32-byte keys (Uint8Array or hex), or a
  // function (see the header). The core always admits a key an active dial
  // pinned, and a refusal is never sticky.
  setAdmission(policy) {
    this._admission = policy
    this._pushAdmission()
  }

  _admissionArg() {
    const policy = this._admission
    if (typeof policy === 'function') {
      try {
        return !!policy()
      } catch {
        return false
      }
    }
    if (Array.isArray(policy)) {
      return policy.map((key) => (typeof key === 'string' ? key : hex(key)))
    }
    return !!policy
  }

  _pushAdmission() {
    if (!this._started) return
    this._request('freenet.setAdmission', { policy: this._admissionArg() }).catch((err) =>
      this._debug('core:admission-error', { message: err.message })
    )
  }

  // A session's history is the core's (K17, ZBTerm D-40): it serves a viewer's
  // range on the session protocol's `history` channel from the history the
  // host opened (engine/zxterm/history.js::HostHistory, from ShareManager), so
  // there is nothing to attach to a connection here.
  serveHistory(_conn, _store) {}

  // The viewer's half: the handle `ShareManager` asks for ranges of the
  // session's log, answered by the core (range requests to the host over the
  // `history` channel while `conn` is up, the segment-v1 contract after).
  // `keys.verifyingKey` (hex) may be filled in after this returns.
  attachHistory(conn, store, keys) {
    this._usable()
    const backend = this
    const handle = new CoreHistoryHandle({
      core: bridgeFor(this._core),
      store,
      keys: keys || {},
      live: () => !!conn && !conn.closed && backend._started,
      debug: (event, details) => this._debug(event, details)
    })
    return handle
  }

  // What a viewer needs to find a session's `segment-v1` contract instance:
  // the host's history signing key and the session id (the core derives the
  // instance from both). Null while the store knows no signing key.
  historyRouteFor(store) {
    const host = store && store.historyVerifyingKey
    if (!host) return null
    return { kind: 'segment-v1', host, session: store.sessionId }
  }

  // The profile's sidecar once this backend has started it, for the session
  // protocol (`share.*`, engine/zxterm/share.js): the core's session service
  // runs on this backend's connections (K14). Waits for a start() under way;
  // throws what a failed one said.
  async sessionCore() {
    if (this._starting) await this._starting.catch(noop)
    this._usable()
    return this._core
  }

  // The live connection to `remotePeerKey` (the host a `share.join` dialed,
  // whose connection the core made: history attaches to it), or null.
  connectionTo(remotePeerKey, { initiator } = {}) {
    const want = hex(remotePeerKey)
    let found = null
    for (const conn of this._conns.values()) {
      if (conn.closed || hex(conn.remotePeerKey) !== want) continue
      if (initiator !== undefined && conn.initiator !== initiator) continue
      found = conn
    }
    return found
  }

  // PV-3 (zxterm protocol.md section 12.3): a link stored before the session
  // protocol v2 has a route the core refuses. The stored route when the core
  // accepts it, else a new one minted by the core (which decides its
  // protocol version; ZBTerm never reads it). `minted` says which.
  async refreshRoute(linkId, stored) {
    if (this._starting) await this._starting.catch(noop)
    if (stored && stored.route) {
      try {
        const route = await this._request('freenet.routeFor', {
          linkId,
          stored: { route: stored.route }
        })
        return { route, minted: false }
      } catch (err) {
        if (err.code !== CODES.E_BACKEND_UNSUPPORTED) throw err
      }
    }
    return { route: await this._mint(linkId), minted: true }
  }

  // JSON-safe; never a route's `k`, never SDP, never an ICE credential.
  // `started`, `announced`, `node` and `ice` are this object's; `links`,
  // `conns` and `refused` are the core's, as last fetched (refreshed in the
  // background; refreshDiagnostics() waits for fresh ones).
  diagnostics() {
    if (this._started && Date.now() - this._diagAt > DIAGNOSTICS_REFRESH_MS) {
      this.refreshDiagnostics().catch(noop)
    }
    const given = this._iceServersGiven
    const core = this._diag || {}
    return {
      backend: 'freenet',
      started: this._started,
      announced: this._links.size,
      node: { address: this._nodeUrl, version: null, wsRttMs: null },
      ice: {
        servers: given ? given.map(redactIceServer) : null,
        hostCandidatesOnly: !!given && given.length === 0,
        relay: false
      },
      links: Array.isArray(core.links) ? core.links : [],
      conns: Array.isArray(core.conns) ? core.conns : [],
      refused: Number.isFinite(core.refused) ? core.refused : 0
    }
  }

  // Fetches the core's diagnostics now, then answers as diagnostics().
  refreshDiagnostics() {
    if (!this._started) return Promise.resolve(this.diagnostics())
    if (!this._diagPending) {
      this._diagAt = Date.now()
      this._diagPending = this._request('freenet.diagnostics', {})
        .then((diag) => {
          this._diag = diag
        })
        .finally(() => {
          this._diagPending = null
        })
    }
    return this._diagPending.then(() => this.diagnostics())
  }

  // --- the seam ---

  _request(method, args) {
    if (!this._core) {
      return Promise.reject(
        unavailable("The 'freenet' share backend is not started", 'not started')
      )
    }
    return this._core.request(method, args).catch((err) => {
      throw fromSeamError(err)
    })
  }

  _listen() {
    if (this._listeners || !this._core) return
    this._listeners = {
      event: (event) => this._onEvent(event),
      chan: (frame) => this._onChan(frame),
      drain: () => {
        for (const channel of Array.from(this._chans.values())) channel._socketDrained()
      },
      exit: (info) => this._onCoreExit(info)
    }
    for (const [name, fn] of Object.entries(this._listeners)) this._core.on(name, fn)
  }

  _unlisten() {
    if (!this._listeners || !this._core) return
    for (const [name, fn] of Object.entries(this._listeners)) this._core.off(name, fn)
    this._listeners = null
  }

  _onChan({ chan, bytes }) {
    const channel = this._chans.get(chan)
    if (channel) {
      channel._data(bytes)
      return
    }
    // The reply naming this channel is on its way (the core never sends a
    // channel's bytes before it); keep them for it. With no open request
    // unanswered the bytes are those of a channel the core's session service
    // owns (K14: the core forwards every channel's bytes to every seam
    // client), which are never ours to keep.
    if (this._opening === 0) return
    if (!this._orphans.has(chan)) this._orphans.set(chan, [])
    this._orphans.get(chan).push(bytes)
  }

  _claimOrphans(chan, channel) {
    const held = this._orphans.get(chan)
    if (!held) return
    this._orphans.delete(chan)
    for (const bytes of held) channel._data(bytes)
  }

  _onEvent({ name, data }) {
    if (!data || typeof data !== 'object') return
    switch (name) {
      case 'freenet.debug':
        if (data.event === 'node:closed') {
          this._nodeProblem = `lost the Freenet node at ${this._nodeUrl}`
        }
        this._debug(data.event, data.details || {})
        return
      case 'freenet.connection':
        this._onConnection(data)
        return
      case 'freenet.dialConnected': {
        const dial = this._dials.get(data.dial)
        if (!dial) {
          if (this._dialsInFlight > 0) return this._stash(data.dial, name, data)
          // A dial of the core's own (share.join) is not ours to close.
          if (!this._cancelled.delete(data.dial)) return
          // A dial that ended here before the core connected it.
          const conn = this._conns.get(data.conn)
          if (conn) conn.close('cancelled')
          else this._unwanted.add(data.conn)
          return
        }
        const conn = this._conns.get(data.conn)
        if (conn) this._surfaceDial(dial, conn)
        else this._dialByConn.set(data.conn, dial)
        return
      }
      case 'freenet.dialError': {
        const dial = this._dials.get(data.dial)
        if (!dial) {
          if (this._dialsInFlight > 0) this._stash(data.dial, name, data)
          return
        }
        this._endDial(dial, fromCore(data.code, data.message))
        return
      }
      case 'freenet.connectionClosed': {
        const conn = this._conns.get(data.conn)
        this._dialByConn.delete(data.conn)
        this._unwanted.delete(data.conn)
        if (conn) conn._closed(data.reason || 'closed')
        return
      }
      case 'freenet.incomingChannel': {
        const conn = this._conns.get(data.conn)
        if (conn) conn._incoming(data.protocol, Buffer.from(String(data.id), 'hex'))
        return
      }
      case 'freenet.channelClosed': {
        const channel = this._chans.get(data.chan)
        this._orphans.delete(data.chan)
        if (channel) channel._shut()
        return
      }
      case 'freenet.backpressure': {
        const channel = this._chans.get(data.chan)
        if (channel) channel._backpressure()
        return
      }
      case 'freenet.drain': {
        const channel = this._chans.get(data.chan)
        if (channel) channel._drained()
      }
    }
  }

  _stash(dialId, name, data) {
    if (!this._dialStash.has(dialId)) this._dialStash.set(dialId, [])
    this._dialStash.get(dialId).push({ name, data })
  }

  _onConnection(data) {
    if (this._conns.has(data.conn)) return
    const conn = new FreenetConnection(this, data.conn, {
      remotePeerKey: Buffer.from(String(data.remotePeerKey), 'hex'),
      initiator: data.initiator === true,
      linkId: data.linkId,
      path: data.path
    })
    this._conns.set(data.conn, conn)
    if (!conn.initiator) {
      this.emit('connection', conn, { linkId: data.linkId || null })
      return
    }
    const dial = this._dialByConn.get(data.conn)
    this._dialByConn.delete(data.conn)
    if (dial) this._surfaceDial(dial, conn)
    else if (this._unwanted.delete(data.conn)) conn.close('cancelled')
    // Otherwise its freenet.dialConnected, stashed for a reply still on its
    // way, surfaces it.
  }

  // 'connection' fires on both sides; on this one with the object
  // `connected` resolved to.
  _surfaceDial(dial, conn) {
    this._dials.delete(dial.id)
    if (dial.done) {
      conn.close('cancelled')
      return
    }
    dial.done = true
    dial.conn = conn
    dial.resolve(conn)
    this.emit('connection', conn, { linkId: null })
  }

  // The sidecar went away: every connection, channel and dial it held is
  // gone with it.
  _onCoreExit({ code, signal } = {}) {
    if (!this._started) return
    this._started = false
    this._nodeProblem = `zxterm-core sidecar exited (code=${code}, signal=${signal})`
    this._links.clear()
    for (const dial of Array.from(this._dials.values())) {
      this._endDial(dial, unavailable(`The 'freenet' share backend lost its core`, 'core exited'))
    }
    for (const conn of Array.from(this._conns.values())) conn._closed('core exited')
    this._chans.clear()
    this._orphans.clear()
    this._debug('core:exit', { code, signal })
  }

  // A start() that failed says why; one never made says `not started`.
  _usable() {
    if (!this._started) {
      throw (
        this._startError || unavailable("The 'freenet' share backend is not started", 'not started')
      )
    }
  }

  _debug(event, details = {}) {
    this.emit('debug', { event, details })
  }
}

function noop() {}

module.exports = FreenetBackend
module.exports.MAX_ANSWERS_PER_MINUTE = MAX_ANSWERS_PER_MINUTE
module.exports.ANSWER_WINDOW_MS = ANSWER_WINDOW_MS
module.exports.MAX_HALF_OPEN = MAX_HALF_OPEN
module.exports.HALF_OPEN_TIMEOUT_MS = HALF_OPEN_TIMEOUT_MS
module.exports.MAX_HALF_OPEN_PER_VIEWER = MAX_HALF_OPEN_PER_VIEWER
module.exports.PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS
module.exports.MAX_MESSAGE_SIZE = MAX_MESSAGE_SIZE
module.exports.DEFAULT_NODE_URL = DEFAULT_NODE_URL
module.exports.DEFAULT_NODE_KEY = DEFAULT_NODE_KEY
