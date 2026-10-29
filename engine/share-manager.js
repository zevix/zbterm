const { EventEmitter } = require('events')
const crypto = require('crypto')
const b4a = require('b4a')

const { VERSION } = require('./schema')
const {
  decryptPacket,
  encryptPacket,
  openSealedBytes,
  sealBytes,
  verifyDeviceIdentity,
  isVerifiedDeviceIdentity
} = require('./crypto')
const { EngineError, CODES } = require('./errors')
const {
  FULL_CAPS,
  VIEW_LIVE,
  READ_HISTORY,
  SEND_INPUT,
  hasCap,
  capsFromLinkOptions
} = require('./caps')
const { signChallenge } = require('./identity/claim')
const { UNKNOWN, displayIdFor } = require('./identity/providers')
const { verifyPeerIdentity, IDENTITY_TIMEOUT_MS } = require('./identity/verify')

const { LINK_PREFIX, encodeLink, decodeLink } = require('./invite')
const { bridgeFor, OrderedRequests, b64, unb64 } = require('./zxterm/share')
const { HostHistory, supportsHistory } = require('./zxterm/history')
const backendRegistry = require('./backends')
const { CAP, assertBackend } = require('./backends/types')
// The peer-to-peer channel id exchanged with every remote build. Both sides
// must agree on it, so changing it breaks compatibility with any build that
// shipped a different value. Pear and the loopback only: a Freenet share's
// channels are the core's (`zxterm/ctl`, `zxterm/live`, `zxterm/history`;
// engine/zxterm/share.js, K14 of zxterm-core).
const PROTOCOL = 'zbterm/ctl'
const JOIN_TIMEOUT_MS = 30 * 1000
// Once the host has raised the join for approval a person is deciding, so the
// wait is theirs, not the network's.
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
// Why a join failed, as the viewer's UI receives it in `join:changed`
// (`status: 'failed', reason`). The host sends one on its `error` frame; the
// viewer supplies one for the failures it detects itself.
const JOIN_REASONS = Object.freeze({
  DENIED: 'denied', // the host's user refused the request
  REVOKED: 'revoked', // the link was revoked (or is unknown to the host)
  CONSUMED: 'consumed', // a single-use link that has already joined once
  FULL: 'full', // a group link at its viewer limit
  ENDED: 'ended', // the host is up but no longer shares this session
  BAD_PROOF: 'bad-identity-proof',
  DEVICE_REVOKED: 'device-revoked',
  IDENTITY: 'identity', // the identity gate refused the claim
  UNREACHABLE: 'unreachable', // no host answered before JOIN_TIMEOUT_MS
  NO_ANSWER: 'no-answer', // approval never came before APPROVAL_TIMEOUT_MS
  CLOSED: 'closed', // the connection dropped before the join completed
  HOST_MISMATCH: 'host-mismatch'
})
const MAX_GROUP_VIEWERS = 99
// Live output towards a viewer that cannot keep up (drop-to-snapshot; see
// broadcastData). A viewer whose channel reports backpressure - its `send`
// returned false - stops getting live data; LAG_RESYNC_MS later it gets the
// host's current screen as a bootstrap instead of what it missed, and live
// data resumes. A resync that itself meets backpressure doubles the wait, up
// to LAG_RESYNC_MAX_MS, so a link that cannot carry even the screens is sent
// one screen per LAG_RESYNC_MAX_MS, never an unbounded queue.
const LAG_RESYNC_MS = 500
const LAG_RESYNC_MAX_MS = 8000
// A resync screen carries this much scrollback, not the mirror's full 5000
// lines: a full screen is about 1 MiB under a flood, which is past any
// backend's write buffer on its own, so `send` said "backpressure" for every
// resync whatever the link could carry, and the wait climbed to the maximum.
// The recording keeps every line; only the viewer's live scrollback is cut.
const RESYNC_SCROLLBACK = 500
// ... and at most this much of the output still queued for the host's own
// mirror (up to CORE_BACKLOG_LIMIT under a flood), from a line start.
const RESYNC_TAIL_BYTES = 64 * 1024

const TIMELINE_SYNC_CHUNK = 2048
const SNAPSHOT_SYNC_YIELD_EVERY = 32
const SNAPSHOT_SYNC_MAX = 96

class ShareManager extends EventEmitter {
  constructor(engine, opts = {}) {
    super()
    this.engine = engine
    this.hostShares = new Map()
    this.joins = new Map()
    // linkId -> sessionId. Populated by createLink, never removed except in
    // close() - mirrors share.links' lifetime. Lets host-side connection
    // handling resolve a channel id to a share without relying on any
    // topic-discovery metadata (see docs/DESIGN-SWARM-AND-WORKER.md, "Phase
    // 1 -> Connection routing").
    this._linkIndex = new Map()
    // The share backend: everything network-shaped (swarm, dialing, pinning,
    // relay, channels, history replication) lives behind it. None is held
    // until the first createLink() or join() asks for one (_ensureBackend):
    // the registry decides which backends this build carries, `opts.limit`
    // (the host's --backend / ZBTERM_BACKEND) narrows that set, and each
    // share or join starts the backend it names (several may run at once).
    this._registry = opts.registry || backendRegistry
    this._backendLimit = opts.limit === undefined || opts.limit === null ? '' : String(opts.limit)
    // Constructor options for every backend the registry creates, also handed
    // to a backend's probe (`share.backends`): the Freenet node's address
    // (`{ nodeUrl }`, the worker's `freenetNode` spawn argument, or a test's
    // throwaway node), and the engine's zxterm-core sidecar (`core`,
    // engine/zxterm/core.js), which the Freenet backend proxies to (K11 of
    // zxterm-core). The ICE servers the host sends (setIceServers) join them
    // once known.
    this._backendOptions = {
      ...(engine && engine.core ? { core: engine.core } : {}),
      ...opts.backendOptions
    }
    this._iceServers = null
    // Every backend activated this run, by id: { backend, listeners }. Each
    // share and each join runs over its own backend, so a Pear share and a
    // Freenet join (or the other way round) run side by side.
    this._backends = new Map()
    // The backend each connection arrived on, for the per-connection calls
    // (history, identity keys) that must go to that backend.
    this._connBackends = new WeakMap()
    this._closed = false
    // An injected backend (opts.backend) bypasses the registry and the limit:
    // it is the only backend this manager will ever use, it serves an invite
    // of any `b`, and it is active from construction. This is the seam tests
    // (and the in-process loopback backend) come through.
    this._injected = opts.backend ? assertBackend(opts.backend) : null
    // conn -> Set<peer>, spanning every session that connection carries. One
    // backend connection can carry channels for several hosted sessions at
    // once, so this is used only to fan cleanup out to every peer a closing
    // connection produced, across all shares - share.peers itself stays keyed
    // by session.
    this._connPeers = new Map()
    // The Freenet path (K14): the core runs the session protocol, so a share
    // or a join over a backend that has a sidecar (`backend.sessionCore()`)
    // keeps only what ZBTerm owns - the session store, the engine's remote
    // sessions and the UI's events. `_coreJoins`: joinId -> the join's state,
    // `_coreJoinsBySession`: sessionId -> the same once confirmed;
    // `_coreListeners`: bridge -> the handlers this manager put on it.
    this._coreJoins = new Map()
    this._coreJoinsBySession = new Map()
    this._coreListeners = new Map()
    // `share.join` requests unanswered, and the join events that arrived
    // before the answer named their join.
    this._joinsInFlight = 0
    this._earlyCoreEvents = []
    // Connections this manager already serves history on.
    this._hostHandled = new WeakSet()
    // How long either side waits for an answer to its identity challenge.
    // Overridable per instance (tests inject a short timeout instead of
    // sleeping for the real 15s).
    this.identityTimeoutMs = Number.isFinite(engine && engine.identityTimeoutMs)
      ? engine.identityTimeoutMs
      : IDENTITY_TIMEOUT_MS
    if (this._injected) this._attachBackend(this._injected)
  }

  // The active backend. Reading it while none is held activates the default
  // one (synchronously; its start() runs in the background), which is what
  // every caller before lazy activation relied on. It is null when this build
  // carries no usable backend. Code that must not activate anything (close,
  // diagnostics, backendsInfo) reads `_backend` instead.
  get backend() {
    if (this._backend) return this._backend
    // After close() an injected backend is still reported (stopped), as it
    // always was; a registry backend is never re-activated by a late read.
    if (this._closed) return this._injected
    try {
      return this._backendNow(null)
    } catch {
      return null
    }
  }

  _backendIdOf(backend) {
    for (const [id, entry] of this._backends) {
      if (entry.backend === backend) return id
    }
    const { id } = backend.describe()
    return id
  }

  // The backend reported as active (backendsInfo().active, diagnostics()):
  // the default one when it is running, else the first activated. Null while
  // none is. Reading it never activates anything.
  get _backend() {
    const entry = this._primaryEntry()
    return entry ? entry[1].backend : null
  }

  get _backendId() {
    const entry = this._primaryEntry()
    return entry ? entry[0] : null
  }

  _primaryEntry() {
    if (!this._backends.size) return null
    let preferred = null
    try {
      preferred = this._defaultBackendId()
    } catch {}
    if (preferred && this._backends.has(preferred)) {
      return [preferred, this._backends.get(preferred)]
    }
    return this._backends.entries().next().value
  }

  // The backend a connection arrived on; the reported one for a connection
  // this manager never saw arrive.
  _backendOfConn(conn) {
    return (conn && this._connBackends.get(conn)) || this.backend
  }

  _defaultBackendId() {
    if (this._injected) return this._backendIdOf(this._injected)
    return this._registry.resolve(this._selection()).default
  }

  // What the registry selects from: the host's limit.
  _selection() {
    return { limit: this._backendLimit }
  }

  // Throws E_BACKEND_UNSUPPORTED, naming the backend, when `id` cannot be used
  // in this build under the current limit.
  _assertBackendUsable(id) {
    const entry = this._registry.resolve(this._selection()).backends.find((item) => item.id === id)
    if (entry && entry.state === 'available') return
    throw new EngineError(
      CODES.E_BACKEND_UNSUPPORTED,
      entry
        ? `The '${id}' share backend cannot be used: ${entry.detail}`
        : `The '${id}' share backend is not available in this build`,
      { backend: id, detail: entry ? entry.detail : null }
    )
  }

  // Returns the backend for `id` (the default when empty), activating it if
  // it is not running yet. Throws E_BACKEND_UNSUPPORTED when this build
  // cannot use it.
  _backendNow(id) {
    if (this._injected) return this._injected
    const wanted = id || this._defaultBackendId()
    if (!wanted) {
      throw new EngineError(
        CODES.E_BACKEND_UNSUPPORTED,
        'No share backend is available in this build',
        { backend: null, limitedBy: this._backendLimit || null }
      )
    }
    const running = this._backends.get(wanted)
    if (running) return running.backend
    this._assertBackendUsable(wanted)
    return this._attachBackend(
      this._registry.create(wanted, {
        ...this._selection(),
        options: {
          ...this._backendOptions,
          ...(this._iceServers ? { iceServers: this._iceServers } : {})
        }
      }),
      wanted
    )
  }

  // Several backends may run at once (this replaces R-6's one per run): each
  // share and each join uses the backend it names. `id` empty means the
  // default.
  async _ensureBackend(id) {
    return this._backendNow(id)
  }

  _attachBackend(backend, id) {
    const listeners = {
      connection: (conn, info) => {
        try {
          this._connBackends.set(conn, backend)
          this._handleConnection(conn, info)
        } catch (err) {
          this.emit('error', EngineError.from(err))
        }
      },
      error: (err) => this.emit('error', EngineError.from(err)),
      debug: ({ event, details }) => this._debug(event, details)
    }
    this._backends.set(id || backend.describe().id, { backend, listeners })
    // Inbound admission: accept iff hosting anything (accept-all, unchanged
    // from today). The backend additionally admits any key an active join is
    // dialing - see PearBackend._ensureSwarm.
    backend.setAdmission(() => this.hostShares.size > 0)
    for (const [name, fn] of Object.entries(listeners)) backend.on(name, fn)
    backend
      .start({
        // Read lazily: the device keys are looked up on every use, never
        // captured at construction.
        keyPair: () => {
          const device = this.engine && this.engine.localDevice
          if (!device) return null
          return { publicKey: device.dhtPublicKey, secretKey: device.dhtSecretKey }
        }
      })
      .catch((err) => this.emit('error', EngineError.from(err)))
    return backend
  }

  async _detachBackends() {
    const entries = Array.from(this._backends.values())
    this._backends.clear()
    await Promise.all(
      entries.map(async ({ backend, listeners }) => {
        for (const [name, fn] of Object.entries(listeners)) backend.off(name, fn)
        await backend.stop()
      })
    )
  }

  // share.backends (R-7). Activates nothing.
  backendsInfo() {
    if (this._injected) {
      const descriptor = this._injected.describe()
      return {
        backends: [
          {
            id: descriptor.id,
            label: descriptor.label || descriptor.id,
            capabilities: descriptor.capabilities || 0,
            state: 'available',
            detail: null
          }
        ],
        default: descriptor.id,
        active: descriptor.id,
        running: [descriptor.id],
        limitedBy: null
      }
    }
    const resolved = this._registry.resolve(this._selection())
    return {
      backends: resolved.backends,
      default: resolved.default,
      active: this._backendId,
      // Every backend running this run; `active` is one of them.
      running: Array.from(this._backends.keys()),
      limitedBy: resolved.limitedBy
    }
  }

  // share.backends as the core answers it: backendsInfo(), with each usable
  // backend's probe (engine/backends/index.js::probe, A-11) awaited and its
  // answer taken over. A backend the probe calls broken is not the default.
  async probedBackendsInfo() {
    const info = this.backendsInfo()
    if (this._injected || typeof this._registry.probe !== 'function') return info
    const backends = await Promise.all(
      info.backends.map(async (entry) => {
        if (entry.state !== 'available') return entry
        const answer = await this._registry.probe(entry.id, {
          ...this._selection(),
          ...this._backendOptions
        })
        return answer ? { ...entry, state: answer.state, detail: answer.detail } : entry
      })
    )
    const usable = backends.find((entry) => entry.state === 'available')
    return { ...info, backends, default: usable ? usable.id : null }
  }

  // D-11: the host's ICE servers (an array of ICE URLs, [] for host
  // candidates only, null for the host half's own list), for every peer
  // connection a backend opens from now on. A backend without
  // setIceServers has no use for them.
  setIceServers(iceServers) {
    this._iceServers = Array.isArray(iceServers) ? iceServers.map(String) : null
    for (const { backend } of this._backends.values()) {
      if (typeof backend.setIceServers === 'function') backend.setIceServers(this._iceServers)
    }
    return { iceServers: this._iceServers }
  }

  async close() {
    this._closed = true
    await this._closeCoreSessions()
    await this._detachBackends()
    this.hostShares.clear()
    this.joins.clear()
    this._connPeers.clear()
    this._unlistenCores()
  }

  // Freenet path: what the core holds for this manager's shares and joins
  // goes with it (a sidecar outlives an engine, and a second `hostOpen` of
  // the same session would refuse).
  async _closeCoreSessions() {
    const closing = []
    for (const share of this.hostShares.values()) {
      if (!share.core) continue
      // The last segment is closed and published before the core drops it.
      if (share.history) closing.push(share.history.close().catch(() => {}))
      closing.push(
        Promise.race([
          share.core.request('share.hostClose', { sessionId: share.sessionId }).catch(() => {}),
          delay(2000)
        ])
      )
    }
    for (const state of this.joins.values()) {
      if (state.viaCore) this._leaveCoreJoin(state)
    }
    await Promise.all(closing)
  }

  // The backend's 'connection' event fires once per connection, whatever
  // roles it ends up carrying: a peer can simultaneously be our viewer-target
  // (an active join dialed them - that side arrives through the dial's
  // `connected` promise, see join()) and a viewer of ours (they open a
  // host-role channel to us) on the very same connection - see
  // docs/DESIGN-SWARM-AND-WORKER.md, "Phase 3 -> Routing viewer connections on
  // the shared swarm". The two are independent; neither waits for the other.
  _handleConnection(conn, info) {
    this._handleHostConnection(conn, info)
  }

  async createLink(sessionId, opts = {}) {
    // `opts.backend` names the backend to share over; the default otherwise.
    // Resolved before anything is recorded, so a build without that backend
    // (or with none) leaves no half-made share behind.
    const backend = this._backendNow(opts.backend)
    const runtime = this.engine.sessions.get(sessionId)
    if (!runtime) throw new EngineError(CODES.E_INTERNAL, 'Only live sessions can be shared')
    // A session is shared over one backend at a time: its links, peers and
    // (on Freenet) its core state all live on that backend.
    const existing = this.hostShares.get(sessionId)
    if (existing && existing.backend && existing.backend !== backend) {
      const current = this._backendIdOf(existing.backend)
      throw new EngineError(
        CODES.E_BACKEND_UNAVAILABLE,
        `This session is already shared over '${current}'; stop sharing it to share it over '${this._backendIdOf(backend)}'`,
        { backend: this._backendIdOf(backend), active: current }
      )
    }
    this._debug('host:create-link:start', { sessionId, type: opts.type, autoJoin: opts.autoJoin })

    const linkId = crypto.randomBytes(16).toString('hex')
    // A backend may mint a route asynchronously (the Freenet proxy asks its
    // core, and fails if the backend could not start); Pear's is synchronous.
    // Minted before the share is recorded, so a failure leaves nothing behind.
    const route = await backend.routeFor(linkId, null)
    // Freenet path (K14): the backend's sidecar runs the session protocol.
    const bridge = await this._coreOf(backend)

    let share = this.hostShares.get(sessionId)
    if (!share) {
      share = {
        sessionId,
        // The backend this session is shared over.
        backend,
        peers: new Set(),
        links: new Map(),
        pendingApprovals: new Map(),
        inputCounters: new Map(),
        liveSeq: 0,
        // Freenet path: the sidecar's bridge (null on Pear and the loopback),
        // the confirmed peers by core join id, the identity outcomes by
        // join id, the queue that applies the core's events to the store in
        // order, the highest epoch applied to it and who waits for one.
        core: bridge,
        out: bridge ? new OrderedRequests((method, args) => bridge.request(method, args)) : null,
        peersByJoin: new Map(),
        identities: new Map(),
        queue: Promise.resolve(),
        appliedEpoch: 0,
        epochWaiters: [],
        firstEpoch: 0,
        opening: null,
        // The session's history in the core (engine/zxterm/history.js::
        // HostHistory), once opened; null without one.
        history: null,
        // Cursor into runtime.store.timeline: how much of it has already been
        // pushed to confirmed peers via broadcastTimeline. Starts at the
        // current length so a share created mid-session doesn't immediately
        // resend the whole backlog that _syncTimelineToPeer already handles
        // per-peer at grant time - this only ever covers what's appended
        // *after* the share exists.
        timelineSyncedCount: runtime.store.timeline.length
      }
      this.hostShares.set(sessionId, share)
      if (bridge) share.opening = this._coreHostOpen(share, runtime)
    }
    if (share.opening) {
      try {
        await share.opening
      } catch (err) {
        if (this.hostShares.get(sessionId) === share) this.hostShares.delete(sessionId)
        throw err
      }
    }

    this._linkIndex.set(linkId, sessionId)
    const type = opts.type === 'group' ? 'group' : 'single'
    const defaultMaxViewers = type === 'group' ? MAX_GROUP_VIEWERS : 1
    const requestedMaxViewers = Number(opts.maxViewers)
    const maxViewers = Number.isFinite(requestedMaxViewers)
      ? Math.min(MAX_GROUP_VIEWERS, Math.max(1, requestedMaxViewers))
      : defaultMaxViewers
    const requestedCaps = Number.isFinite(opts.caps)
      ? opts.caps
      : capsFromLinkOptions({ ...opts, sendInput: opts.sendInput !== false })
    // R-2: viewer input must never be stored, so a backend that cannot deliver
    // ephemerally (abstract-arch §16.2) gets links without SEND_INPUT. Decided
    // by capability, never by which backend it is.
    const ephemeral = ((backend.describe().capabilities || 0) & CAP.EPHEMERAL_DELIVERY) !== 0
    const caps = ephemeral ? requestedCaps : requestedCaps & ~SEND_INPUT
    const link = {
      version: VERSION,
      linkId,
      sessionId,
      // A route is opaque to the share manager. One that carries a `topic`
      // (Pear's) keeps the stored field it always had; any other shape is
      // stored whole, for the backend's routeFor() to read back.
      ...(typeof route.topic === 'string' ? { topic: route.topic } : { route }),
      type,
      maxViewers,
      caps,
      autoJoin: opts.autoJoin !== false,
      createdAt: Date.now(),
      consumed: false,
      revoked: false,
      viewers: 0
    }

    await runtime.store.meta.put(`link/${linkId}`, link)
    share.links.set(linkId, link)
    // The core must know the link before its route is announced: a viewer
    // can dial the moment it is.
    if (share.core) await this._coreAddLink(share, runtime, link)
    await backend.announce(linkId, { route, tag: { sessionId } })

    const uri = this._inviteFor(backend, linkId, route)
    this.emit('share:changed', this.status(sessionId))
    return { ...link, uri }
  }

  async listLinks(sessionId) {
    const runtime = this.engine.sessions.get(sessionId)
    if (!runtime) return []
    const share = this.hostShares.get(sessionId)
    const backend = (share && share.backend) || this.backend
    const out = []
    for await (const node of runtime.store.meta.createReadStream({ gt: 'link/', lt: 'link0' })) {
      out.push({
        ...node.value,
        // Without a usable backend there is nothing to dial, so no URI.
        uri: backend
          ? this._inviteFor(
              backend,
              node.value.linkId,
              await this._routeOfLink(backend, runtime, node.value)
            )
          : null
      })
    }
    return out
  }

  // The route of a stored link. On a backend that keeps routes in a sidecar
  // (Freenet, K14) the core is asked whether it still accepts the stored one:
  // a link made before the session protocol v2 has a route it refuses (PV-3,
  // zxterm protocol.md section 12.3), so a new one is minted, stored and
  // announced, and the link's invite changes with it.
  async _routeOfLink(backend, runtime, link) {
    if (typeof backend.refreshRoute !== 'function' || !link.route) {
      return await backend.routeFor(link.linkId, link)
    }
    let refreshed
    try {
      refreshed = await backend.refreshRoute(link.linkId, link)
    } catch (err) {
      // Without a running core there is nothing to ask: the stored route
      // stands, as it did before the core kept it.
      this._debug('host:link:route-check-failed', {
        linkId: link.linkId,
        message: err && err.message
      })
      return await backend.routeFor(link.linkId, link)
    }
    const { route, minted } = refreshed
    if (!minted) return route
    const next = { ...link, route }
    await runtime.store.meta.put(`link/${link.linkId}`, next)
    const share = this.hostShares.get(link.sessionId)
    if (share && share.links.has(link.linkId)) share.links.set(link.linkId, next)
    if (share && !link.revoked && share.backend === backend) {
      await backend
        .announce(link.linkId, { route, tag: { sessionId: link.sessionId } })
        .catch((err) => this._debug('host:announce:error', { message: err && err.message }))
    }
    this._debug('host:link:route-refreshed', { sessionId: link.sessionId, linkId: link.linkId })
    return route
  }

  // The invite for one link. invite.js decides the wire shape from `b`: Pear
  // links keep the v1 fields, every other backend gets the v2 shape.
  _inviteFor(backend, linkId, route) {
    return encodeLink({
      v: VERSION,
      b: this._backendIdOf(backend),
      linkId,
      peer: b4a.toString(backend.localPeerKey(), 'hex'),
      route,
      claim: this._inviteIdentityClaim()
    })
  }

  async revokeLink(sessionId, linkId) {
    const runtime = this.engine.sessions.get(sessionId)
    if (!runtime) return false
    const node = await runtime.store.meta.get(`link/${linkId}`)
    if (!node) return false
    const next = { ...node.value, revoked: true }
    await runtime.store.meta.put(`link/${linkId}`, next)
    // A-10, D-16: the route stops being announced. A late join on it still
    // fails: in-band (host:join-deny) on a backend that stays reachable by
    // peer key after withdraw, by a backend error on one that does not. A
    // failure here is reported, never thrown: the link is revoked either way.
    // The share's backend: revoking never activates one.
    const owner = this.hostShares.get(sessionId)
    const backend = (owner && owner.backend) || this._backend
    if (backend) {
      try {
        await backend.withdraw(linkId)
      } catch (err) {
        this._debug('host:withdraw:error', { sessionId, linkId, message: err && err.message })
      }
    }
    const share = this.hostShares.get(sessionId)
    // Freenet path: the core disconnects the link's peers, revokes its
    // members and rotates.
    if (share && share.core) return await this._coreRevokeLink(share, runtime, linkId, next)
    if (share) {
      share.links.set(linkId, next)
      for (const peer of share.peers) {
        if (peer.linkId === linkId) this._disconnectHostPeer(peer)
      }
    }
    // Anyone who joined through this link loses standing access, not just
    // their live socket - mark them revoked and rotate so a stale envelope
    // (or a future reconnect attempt) can't keep reading confidential
    // material.
    if (runtime.store.listActiveMembers) {
      const members = await runtime.store.listActiveMembers()
      const revoked = members.filter((member) => member.linkId === linkId)
      if (revoked.length) {
        for (const member of revoked) {
          await runtime.store.setMemberStatus(member.identityKeyHex, 'revoked')
        }
        const remaining = await runtime.store.listActiveMembers()
        const { envelopes } = await runtime.store.rotateEpoch(remaining, 'link-revoke')
        if (share) this._broadcastRekey(share, runtime, envelopes)
      }
    }
    this.emit('share:changed', this.status(sessionId))
    return true
  }

  // Revokes a single member (by identity) regardless of which link they
  // joined through: disconnects any of their currently-connected devices
  // and rotates keys among everyone else so they stop receiving future
  // output/history/live keys, per the session revocation requirement.
  async revokeMember(sessionId, identityKeyHex) {
    const runtime = this.engine.sessions.get(sessionId)
    if (!runtime) return false
    const coreShare = this.hostShares.get(sessionId)
    if (coreShare && coreShare.core && /^[0-9a-f]{64}$/i.test(String(identityKeyHex))) {
      return await this._coreRevokeMember(coreShare, runtime, identityKeyHex)
    }
    const member = await runtime.store.getMember(identityKeyHex)
    if (!member || member.status !== 'active') return false
    await runtime.store.setMemberStatus(identityKeyHex, 'revoked')
    const share = this.hostShares.get(sessionId)
    if (share) {
      for (const peer of share.peers) {
        if (peer.identityKeyHex === identityKeyHex) this._disconnectHostPeer(peer)
      }
    }
    const remaining = await runtime.store.listActiveMembers()
    const { envelopes } = await runtime.store.rotateEpoch(remaining, 'member-revoke')
    if (share) this._broadcastRekey(share, runtime, envelopes)
    this.emit('share:changed', this.status(sessionId))
    return true
  }

  _broadcastRekey(share, runtime, envelopes, opts = {}) {
    for (const peer of share.peers) {
      if (!peer.confirmed || !peer.message || !peer.deviceKeyHex) continue
      if (opts.except && peer.deviceKeyHex === opts.except) continue
      const envelopeHex = envelopes.get(peer.deviceKeyHex)
      if (!envelopeHex) continue
      peer.message.send({ type: 'rekey', epoch: runtime.store.epoch, envelope: envelopeHex })
    }
  }

  // Called when the viewer deletes a joined session locally (engine
  // deleteSession) while it may still be actively receiving replication
  // traffic from the host. Tears down the join the same way a normal
  // failure/timeout would (state.finish -> settle: leaves the topic, unpins
  // the host key, closes the channel) instead of leaving it live to keep
  // dialing/replicating into a session the viewer just asked to remove.
  // No-op if this session was never joined this session (e.g. it's a
  // catalog-only entry with no live join state) or the join already ended.
  leaveJoinedSession(sessionId) {
    for (const state of this.joins.values()) {
      if (state.sessionId === sessionId && !state.done) {
        state.finish({ status: 'left', linkId: state.invite.linkId })
        return true
      }
    }
    return false
  }

  // Joins share the backend hosting also uses - no per-join network stack.
  // Pinning is (1) the app-layer check in _handleViewerConnection (primary,
  // exact per-join) and (2) the backend's own dial pin (defense in depth, see
  // PearBackend.dial/_ensureSwarm).
  async join(uri) {
    const invite = decodeLink(uri)
    // The invite's `b` decides the backend. One this build lacks raises
    // E_BACKEND_UNSUPPORTED naming it, before any join state exists.
    const backend = this._backendNow(invite.b)
    this._debug('viewer:join:start', {
      linkId: invite.linkId,
      topic: invite.topic,
      hostDhtKey: invite.hostDhtKey || null
    })
    // hostDhtKey is mandatory as of decodeLink's Phase 3 check - always
    // present here, never null. Kept as a local + state field (rather than
    // re-deriving from state.invite each time) so _handleViewerConnection's
    // pinning check below is a plain buffer compare, no re-parsing.
    const hostDhtKey = b4a.from(invite.hostDhtKey, 'hex')
    const key = `${invite.topic || invite.b}:${invite.linkId}`
    const state = {
      invite,
      hostDhtKey,
      startedAt: Date.now(),
      connected: false,
      confirmed: false,
      channel: null,
      message: null,
      sessionId: null,
      registeringRemote: null,
      dial: null,
      history: null,
      downloads: [],
      done: false,
      timer: null
    }
    this.joins.set(key, state)
    // Freenet path (K14): the backend's sidecar dials, joins and runs the
    // timers; `state` keeps what the diagnostics and the UI's events need.
    state.backend = backend
    state.viaCore = typeof backend.sessionCore === 'function'
    state.settle = () => {
      if (state.done) return
      state.done = true
      if (state.timer) clearTimeout(state.timer)
      this.joins.delete(key)
      if (state.viaCore) {
        this._leaveCoreJoin(state)
        return
      }
      // Cancelling the dial leaves this join's route and releases its pin on
      // the host key (refcounted in the backend) instead of tearing down a
      // network stack this join does not own.
      if (state.dial) state.dial.cancel()
      if (state.channel) state.channel.close()
    }
    state.finish = (status) => {
      if (state.done) return
      state.settle()
      this.emit('join:changed', { linkId: invite.linkId, ...status })
    }
    if (state.viaCore) {
      this._coreJoin(state)
      this.emit('join:changed', { status: 'connecting', linkId: invite.linkId })
      return { status: 'connecting', linkId: invite.linkId }
    }
    state.timer = setTimeout(() => {
      this._debug('viewer:join-timeout', {
        linkId: invite.linkId,
        swarm: backend.diagnostics().hostSwarm
      })
      state.finish({
        status: 'failed',
        code: CODES.E_AUTH,
        reason: JOIN_REASONS.UNREACHABLE,
        message: 'Share host was not found or the invite is no longer valid'
      })
    }, JOIN_TIMEOUT_MS)

    // The backend pins the expected host key synchronously, before it dials
    // (docs/DESIGN-SWARM-AND-WORKER.md, "Phase 3 -> Pinning" addendum), and
    // reuses a connection it already holds to that host. `connected` only ever
    // yields a connection from the expected key.
    state.dial = backend.dial(invite.route, hostDhtKey, { tag: { linkId: invite.linkId } })
    state.dial.connected.then(
      (conn) => {
        if (state.done || state.connected) return
        try {
          this._handleViewerConnection(state, conn)
        } catch (err) {
          this.emit('error', EngineError.from(err))
        }
      },
      (err) => {
        // A cancel (settle() above) rejects with a plain Error and is not a
        // failure. A backend that gives up on its own names a code (the
        // Freenet backend: E_HOST_UNREACHABLE 'ice-failed', E_AUTH
        // 'fingerprint mismatch', ...): the join fails now, with that code
        // and detail, instead of at JOIN_TIMEOUT_MS (freenet-backend F9).
        if (state.done || state.connected || !err || !err.code) return
        const details = err.details || {}
        this._debug('viewer:dial-failed', {
          linkId: invite.linkId,
          code: err.code,
          detail: details.detail || null
        })
        state.finish({
          status: 'failed',
          code: err.code,
          reason: JOIN_REASONS.UNREACHABLE,
          detail: details.detail || null,
          backend: details.backend || null,
          message: err.message
        })
      }
    )
    this.emit('join:changed', { status: 'connecting', linkId: invite.linkId })
    return { status: 'connecting', linkId: invite.linkId }
  }

  broadcastData(sessionId, data, opts = {}) {
    const share = this.hostShares.get(sessionId)
    if (!share) return
    const runtime = this.engine.sessions.get(sessionId)
    if (!runtime) return
    if (share.core) {
      // The core seals it, skips a peer that lags and resyncs it (protocol.md
      // section 11); nothing to send while nobody has joined.
      if (share.peers.size === 0) return
      share.out
        .push(sessionId, data, !!opts.hd)
        .catch((err) => this._debug('host:push:error', { sessionId, message: err && err.message }))
      return
    }
    for (const peer of share.peers) {
      if (!peer.confirmed || !peer.message) continue
      if (!hasCap(peer.caps, VIEW_LIVE)) continue
      if (peer.lagging) {
        peer.lagSkippedBytes = (peer.lagSkippedBytes || 0) + data.byteLength
        continue
      }
      const message = this._encryptLiveMessage(share, runtime, 'data', data, { hd: !!opts.hd })
      // The message that met backpressure is still delivered (backpressure
      // is advisory on every backend), so the viewer's stream stays whole up
      // to here; everything after it is replaced by the resync's screen.
      if (peer.message.send(message) === false) this._lagPeer(share, peer)
    }
  }

  _lagPeer(share, peer) {
    if (peer.lagging) return
    peer.lagging = true
    peer.lagSkippedBytes = 0
    peer.lagDelay = Math.min(LAG_RESYNC_MAX_MS, peer.lagDelay || LAG_RESYNC_MS)
    this._debug('host:peer:lagging', {
      sessionId: share.sessionId,
      linkId: peer.linkId,
      retryMs: peer.lagDelay
    })
    peer.lagTimer = setTimeout(() => {
      peer.lagTimer = null
      this._resyncPeer(share, peer).catch((err) => this.emit('error', EngineError.from(err)))
    }, peer.lagDelay)
    // A peer that goes away meanwhile is noticed when this fires.
    if (typeof peer.lagTimer.unref === 'function') peer.lagTimer.unref()
  }

  // Brings a lagging viewer back to the live screen: the host's screen as of
  // now (buildLiveBootstrap covers every byte recorded so far, and nothing is
  // awaited between it and clearing `lagging`), then live data again.
  async _resyncPeer(share, peer) {
    const gone = () =>
      this._closed ||
      !share.peers.has(peer) ||
      !peer.confirmed ||
      !peer.message ||
      (peer.conn && peer.conn.closed) ||
      !this.engine.sessions.has(share.sessionId)
    if (gone()) return
    const runtime = this.engine.sessions.get(share.sessionId)
    const bootstrap = await this.engine.buildLiveBootstrap(share.sessionId, {
      scrollback: RESYNC_SCROLLBACK,
      tailBytes: RESYNC_TAIL_BYTES
    })
    if (gone()) return
    const ok = peer.message.send(this._encryptLiveJson(share, runtime, 'bootstrap', bootstrap))
    this._debug('host:peer:resync', {
      sessionId: share.sessionId,
      linkId: peer.linkId,
      skippedBytes: peer.lagSkippedBytes,
      bytes: bootstrap.data ? bootstrap.data.length : 0,
      backpressure: ok === false
    })
    peer.lagging = false
    peer.lagSkippedBytes = 0
    // A screen that met backpressure too: the next resync waits longer.
    peer.lagDelay = ok === false ? Math.min(LAG_RESYNC_MAX_MS, peer.lagDelay * 2) : LAG_RESYNC_MS
    if (ok === false) this._lagPeer(share, peer)
  }

  // _syncTimelineToPeer only catches a peer up to the backlog that existed
  // when they were granted access. Without this, packets appended after
  // that point never reach an already-joined peer's store.timeline, so
  // Player.seek (which resolves a clicked timestamp via that timeline) can
  // never target anything newer than the join-time backlog - scrubbing into
  // "live-only" history silently resolves to the same stale frame.
  broadcastTimeline(sessionId) {
    const share = this.hostShares.get(sessionId)
    if (!share) return
    const runtime = this.engine.sessions.get(sessionId)
    if (!runtime || !runtime.store) return
    const timeline = runtime.store.timeline
    // A history copy cut short drops the part of its timeline it never copied.
    const cursor = Math.min(share.timelineSyncedCount || 0, timeline.length)
    if (!Array.isArray(timeline) || timeline.length <= cursor) return
    const items = timeline.slice(cursor)
    share.timelineSyncedCount = timeline.length
    if (share.core) {
      if (share.peers.size > 0) {
        this._coreSend(share, 'share.timeline', {
          sessionId,
          data: b64(Buffer.from(JSON.stringify({ items, length: runtime.store.log.length })))
        })
      }
      return
    }
    for (const peer of share.peers) {
      if (!peer.confirmed || !peer.message) continue
      if (!hasCap(peer.caps, READ_HISTORY) || !hasCap(peer.caps, VIEW_LIVE)) continue
      peer.message.send(
        this._encryptLiveJson(share, runtime, 'timeline', {
          items,
          length: runtime.store.log.length
        })
      )
    }
  }

  async broadcastBootstrap(sessionId) {
    const share = this.hostShares.get(sessionId)
    if (!share) return
    const runtime = this.engine.sessions.get(sessionId)
    if (!runtime) return
    if (share.core) {
      // The core asks for the screen (`share.bootstrapNeeded`) once for
      // every viewer that can see it.
      const info = runtime.store.info || {}
      const cols = runtime.cols || info.cols
      const rows = runtime.rows || info.rows
      if (Number.isFinite(cols) && Number.isFinite(rows)) {
        await this._coreSend(share, 'share.resize', { sessionId, cols, rows })
      }
      return
    }
    const bootstrap = await this.engine.buildLiveBootstrap(sessionId)
    for (const peer of share.peers) {
      if (!peer.confirmed || !peer.message) continue
      if (!hasCap(peer.caps, VIEW_LIVE)) continue
      peer.message.send(this._encryptLiveJson(share, runtime, 'bootstrap', bootstrap))
    }
  }

  broadcastEnd(sessionId, exit) {
    const share = this.hostShares.get(sessionId)
    if (!share) return
    if (share.core) {
      // The session's last segment is closed, so viewers and the contract have
      // all of it.
      if (share.history) share.history.flush().catch(() => {})
      this._coreSend(share, 'share.end', { sessionId, exit: exit || null })
      this.emit('share:changed', this.status(sessionId))
      return
    }
    for (const peer of share.peers) {
      if (!peer.confirmed || !peer.message) continue
      peer.message.send({ type: 'end', sessionId, exit: exit || null })
    }
    this.emit('share:changed', this.status(sessionId))
  }

  broadcastInfo(sessionId, info = {}) {
    const share = this.hostShares.get(sessionId)
    if (!share) return
    if (share.core) {
      const args = { sessionId }
      if (info.name !== undefined) args.name = info.name
      if (info.inputMode !== undefined) args.inputMode = info.inputMode
      this._coreSend(share, 'share.info', args)
      return
    }
    for (const peer of share.peers) {
      if (!peer.confirmed || !peer.message) continue
      peer.message.send({ type: 'info', sessionId, info })
    }
  }

  status(sessionId) {
    const share = this.hostShares.get(sessionId)
    if (!share) return { sessionId, isSharing: false, viewerCount: 0 }
    let viewerCount = 0
    // Identity of every confirmed viewer travels with the share status so
    // `session.list` rows can render badges without a second call.
    const viewers = []
    for (const peer of share.peers) {
      if (!peer.confirmed) continue
      viewerCount++
      viewers.push({
        identityKey: peer.identityKeyHex || null,
        deviceKey: peer.deviceKeyHex || null,
        displayId: peer.identityDisplayId || displayIdFor(UNKNOWN, peer.identityKeyHex || ''),
        status: peer.identityStatus || 'unknown'
      })
    }
    const runtime = this.engine.sessions && this.engine.sessions.get(sessionId)
    return {
      sessionId,
      isSharing: true,
      viewerCount,
      viewers,
      inputMode: runtime ? runtime.inputMode || 'host' : undefined
    }
  }

  async approveJoin(sessionId, requestId) {
    const share = this.hostShares.get(sessionId)
    if (!share) throw new EngineError(CODES.E_AUTH, 'No active share for this session')
    const pending = share.pendingApprovals.get(requestId)
    if (!pending) throw new EngineError(CODES.E_AUTH, 'Approval request is no longer pending')
    share.pendingApprovals.delete(requestId)
    if (pending.core) {
      await share.core.request('share.approve', { sessionId, joinId: pending.joinId })
      return true
    }
    await this._grantJoin(share, pending.peer, pending.runtime, pending.link, pending.request)
    return true
  }

  denyJoin(sessionId, requestId) {
    const share = this.hostShares.get(sessionId)
    if (!share) throw new EngineError(CODES.E_AUTH, 'No active share for this session')
    const pending = share.pendingApprovals.get(requestId)
    if (!pending) throw new EngineError(CODES.E_AUTH, 'Approval request is no longer pending')
    share.pendingApprovals.delete(requestId)
    if (pending.core) {
      return share.core
        .request('share.deny', { sessionId, joinId: pending.joinId })
        .then(() => true)
    }
    this._denyPeer(pending.peer, CODES.E_AUTH, 'Join request denied', JOIN_REASONS.DENIED)
    return true
  }

  diagnostics() {
    // Reads `_backend`: asking for diagnostics never activates a backend.
    const active = this._backend
    const network = active ? active.diagnostics() : {}
    const alias = (value) => (value === undefined ? null : value)
    return {
      // The top-level keys that predate backends, kept as aliases of the
      // active backend's report (`backend`, last in this object).
      relayPublicKey: alias(network.relayPublicKey),
      relayFallbackMs: alias(network.relayFallbackMs),
      hostSwarm: alias(network.hostSwarm),
      hostShares: Array.from(this.hostShares.values()).map((share) => ({
        sessionId: share.sessionId,
        peers: share.peers.size,
        pendingApprovals: share.pendingApprovals.size,
        links: Array.from(share.links.values()).map((link) => ({
          linkId: link.linkId,
          topic: link.topic,
          type: link.type,
          maxViewers: link.maxViewers,
          caps: link.caps,
          canSendInput: hasCap(link.caps, SEND_INPUT),
          viewers: link.viewers,
          autoJoin: link.autoJoin,
          revoked: !!link.revoked,
          consumed: !!link.consumed
        })),
        peerDetails: Array.from(share.peers).map((peer) => ({
          confirmed: !!peer.confirmed,
          linkId: peer.linkId || null,
          caps: peer.caps || 0,
          canViewLive: hasCap(peer.caps || 0, VIEW_LIVE),
          canSendInput: hasCap(peer.caps || 0, SEND_INPUT),
          deviceKey: peer.deviceKeyHex || null,
          inputCtr: peer.inputCtr || 0
        })),
        inputCounters: Array.from(share.inputCounters || new Map()).map(
          ([deviceKey, inputCtr]) => ({
            deviceKey,
            inputCtr
          })
        )
      })),
      joins: Array.from(this.joins.values()).map((join) => ({
        linkId: join.invite.linkId,
        topic: join.invite.topic,
        hostDhtKey: join.invite.hostDhtKey || null,
        connected: join.connected,
        confirmed: join.confirmed,
        sessionId: join.sessionId,
        inputMode:
          join.sessionId && this.engine.remoteSessions.get(join.sessionId)
            ? this.engine.remoteSessions.get(join.sessionId).inputMode
            : null,
        inputCtr:
          join.sessionId && this.engine.remoteSessions.get(join.sessionId)
            ? this.engine.remoteSessions.get(join.sessionId).inputCtr || 0
            : 0
      })),
      // The active backend's own report; null while none is active.
      backend: active ? { ...network, id: this._backendId, health: active.health() } : null,
      // Every running backend's report, the active one included.
      backends: Array.from(this._backends, ([id, { backend }]) => ({
        ...backend.diagnostics(),
        id,
        health: backend.health()
      }))
    }
  }

  // One backend connection can carry channels for several hosted sessions at
  // once (Hyperswarm dedupes to one socket per remote keypair - see
  // docs/DESIGN-SWARM-AND-WORKER.md, "New pitfall 3"). This handler therefore
  // has no single share to close over; each channel id the viewer opens
  // resolves its own share independently, and per-connection state (peers) is
  // fanned out across all of them on close.
  _handleHostConnection(conn, info) {
    this._debug('host:socket:connection', {
      remotePublicKey: hex(conn.remotePeerKey),
      client: !!(info && info.client),
      server: !!(info && info.server)
    })

    conn.once('error', (err) => {
      this._debug('host:socket:error', { message: err.message })
    })
    conn.once('close', () => {
      const peers = this._connPeers.get(conn)
      this._connPeers.delete(conn)
      if (!peers) return
      for (const peer of peers) this._cleanupHostPeer(peer)
    })

    // Channel identity, not connection-time topic metadata, is what routes
    // this connection to the right share (see docs/DESIGN-SWARM-AND-WORKER.md,
    // "Phase 1 -> Connection routing"). React to whatever channel id the
    // viewer opens rather than pre-creating one; an id that doesn't map back
    // to a live share is left alone (not destroyed) - another channel for a
    // different link may still legitimately arrive on the same connection.
    // Freenet path (K14): the core answers the join on `zxterm/ctl` and, since
    // K17, serves the session's history on its own `zxterm/history` channel:
    // nothing is left for this process to do on the connection.
    const connBackend = this._backendOfConn(conn)
    if (connBackend && typeof connBackend.sessionCore === 'function') return
    conn.onChannel(PROTOCOL, (id) => {
      const linkId = b4a.toString(id, 'hex')
      const sessionId = this._linkIndex.get(linkId)
      const share = sessionId ? this.hostShares.get(sessionId) : null
      const runtime = sessionId ? this.engine.sessions.get(sessionId) : null
      if (!share || !runtime) {
        // The viewer opened this channel to join, so it is waiting for an
        // answer; without one it would sit out JOIN_TIMEOUT_MS and then be
        // told the host was not found. Answer on the channel it opened and
        // close only that channel: the connection may carry another link.
        this._debug('host:socket:unknown-link', { linkId })
        const channel = conn.openChannel(PROTOCOL, id, { onmessage() {}, onclose() {} })
        channel.send({
          type: 'error',
          code: CODES.E_AUTH,
          reason: JOIN_REASONS.ENDED,
          message: 'This share is no longer active'
        })
        setImmediate(() => channel.close())
        return
      }
      this._openHostChannel(share, runtime, conn, id)
    })
  }

  _cleanupHostPeer(peer) {
    const share = this.hostShares.get(peer.sessionId)
    this._debug('host:socket:close', { sessionId: peer.sessionId, linkId: peer.linkId })
    if (!share) return
    if (!share.peers.delete(peer)) return
    for (const [requestId, pending] of share.pendingApprovals) {
      if (pending.peer !== peer) continue
      share.pendingApprovals.delete(requestId)
      // The requester is gone (gave up, or timed out waiting): the host's
      // approve/deny prompt for it has nothing left to decide.
      this.emit('approval:cancelled', { requestId, sessionId: peer.sessionId })
    }
    this._disableInputWhenEmpty(share)
    this.emit('share:changed', this.status(peer.sessionId))
  }

  _openHostChannel(share, runtime, conn, id) {
    // Serving history in the channel callback (pre-auth, possibly after other
    // traffic has flowed on the connection) is confirmed safe by Phase 0
    // spike 2(b); the backend keeps it idempotent per (connection x session)
    // so a second link for the same session on the same connection doesn't
    // double-replicate.
    this._backendOfConn(conn).serveHistory(conn, runtime.store)

    const peer = {
      conn,
      channel: null,
      message: null,
      confirmed: false,
      linkId: null,
      sessionId: share.sessionId
    }
    share.peers.add(peer)
    let connPeers = this._connPeers.get(conn)
    if (!connPeers) {
      connPeers = new Set()
      this._connPeers.set(conn, connPeers)
    }
    connPeers.add(peer)

    // One object is both the channel and its message sender.
    peer.channel = peer.message = conn.openChannel(PROTOCOL, id, {
      onmessage: async (message) => {
        try {
          this._debug('host:ctl:message', {
            sessionId: share.sessionId,
            type: message.type,
            linkId: message.linkId
          })
          if (this._handleIdentityCtlMessage(peer, peer.message, conn, message)) return
          if (message.type === 'join-request') {
            // Protomux does not await this handler, so a second join-request
            // could otherwise start a second identity challenge on the same
            // peer while the first is still outstanding.
            if (peer.identityState || peer.confirmed) {
              this._debug('host:join-request:duplicate', {
                sessionId: share.sessionId,
                linkId: message.linkId
              })
              return
            }
            peer.identityState = 'requested'
            await this._confirmJoin(share, peer, runtime, message)
            return
          }
          if (message.type === 'input') {
            const mode = runtime.inputMode || 'host'
            if (mode === 'all') {
              const input = this._openInputMessage(runtime, peer, message)
              this._debug('host:input:accepted', {
                sessionId: share.sessionId,
                linkId: peer.linkId,
                deviceKey: peer.deviceKeyHex,
                inputCtr: peer.inputCtr,
                bytes: Buffer.byteLength(input)
              })
              runtime.pty.write(input)
            } else {
              this._debug('host:input:dropped', {
                sessionId: share.sessionId,
                linkId: peer.linkId,
                deviceKey: peer.deviceKeyHex,
                reason: 'input-mode',
                mode
              })
            }
          }
        } catch (err) {
          if (message && message.type === 'input') {
            this._debug('host:input:error', {
              sessionId: share.sessionId,
              linkId: peer.linkId,
              deviceKey: peer.deviceKeyHex,
              message: err.message,
              code: err.code
            })
          }
          this.emit('error', EngineError.from(err))
        }
      },
      onclose: () => {
        this._cleanupHostPeer(peer)
        const connPeers = this._connPeers.get(conn)
        if (connPeers) connPeers.delete(peer)
      }
    })
    this._debug('host:ctl:open', { sessionId: share.sessionId })
  }

  async _confirmJoin(share, peer, runtime, request) {
    this._debug('host:join-request', {
      sessionId: share.sessionId,
      linkId: request.linkId,
      deviceKey: request.deviceKey,
      deviceName: request.deviceName
    })
    const link = await this._loadLink(runtime, request.linkId)
    if (!link || link.revoked) {
      this._debug('host:join-deny', { linkId: request.linkId, reason: 'invalid-or-revoked' })
      this._denyPeer(peer, CODES.E_AUTH, 'Invite is no longer valid', JOIN_REASONS.REVOKED)
      return
    }
    if (link.type === 'single' && link.consumed) {
      this._debug('host:join-deny', { linkId: request.linkId, reason: 'consumed' })
      this._denyPeer(peer, CODES.E_AUTH, 'Invite has already been used', JOIN_REASONS.CONSUMED)
      return
    }
    if (link.type === 'group' && currentLinkViewers(share, link.linkId) >= link.maxViewers) {
      this._debug('host:join-deny', { linkId: request.linkId, reason: 'full' })
      this._denyPeer(peer, CODES.E_AUTH, 'Invite is full', JOIN_REASONS.FULL)
      return
    }
    const deviceKeyHex = request.deviceKey
    const identityKeyHex = request.identityKey || deviceKeyHex
    if (
      !(await verifyDeviceIdentity(
        request.identityProof,
        identityKeyHex,
        deviceKeyHex,
        this.engine.core
      ))
    ) {
      this._debug('host:join-deny', { linkId: request.linkId, reason: 'bad-identity-proof' })
      this._denyPeer(peer, CODES.E_AUTH, 'Device identity proof is invalid', JOIN_REASONS.BAD_PROOF)
      return
    }
    if (await this._isRevoked(runtime, identityKeyHex, deviceKeyHex)) {
      this._debug('host:join-deny', { linkId: request.linkId, reason: 'revoked' })
      this._denyPeer(
        peer,
        CODES.E_AUTH,
        'This device has been revoked',
        JOIN_REASONS.DEVICE_REVOKED
      )
      return
    }
    // Identity gate (Phase 5): a presented claim that fails verification
    // refuses the connection, before any approval is raised and before any
    // member record or epoch rotation exists. No claim at all is allowed and
    // recorded as `unknown`.
    if (!(await this._verifyViewerIdentity(share, peer, request, identityKeyHex, deviceKeyHex))) {
      this._debug('host:join-deny', { linkId: request.linkId, reason: 'identity' })
      return
    }
    if (!link.autoJoin) {
      const requestId = crypto.randomBytes(16).toString('hex')
      share.pendingApprovals.set(requestId, {
        requestId,
        peer,
        runtime,
        request,
        link,
        createdAt: Date.now()
      })
      this._debug('host:join-pending', { linkId: request.linkId, requestId })
      peer.message.send({ type: 'approval-pending' })
      this.emit('approval:pending', {
        requestId,
        sessionId: share.sessionId,
        linkId: link.linkId,
        linkType: link.type,
        maxViewers: link.maxViewers,
        deviceKey: deviceKeyHex,
        identityKey: identityKeyHex,
        deviceName: request.deviceName || 'viewer'
      })
      return
    }

    await this._grantJoin(share, peer, runtime, link, request)
  }

  async _grantJoin(share, peer, runtime, link, request) {
    if (link.type === 'group' && currentLinkViewers(share, link.linkId) >= link.maxViewers) {
      this._debug('host:join-deny', { linkId: link.linkId, reason: 'full' })
      this._denyPeer(peer, CODES.E_AUTH, 'Invite is full', JOIN_REASONS.FULL)
      return
    }
    const deviceKeyHex = request.deviceKey
    const identityKeyHex = request.identityKey || deviceKeyHex
    const caps = Number.isFinite(link.caps) ? link.caps : FULL_CAPS

    await runtime.store.putMember(identityKeyHex, {
      deviceKeyHex,
      deviceName: request.deviceName,
      caps,
      linkId: link.linkId
    })
    // Grant access to prior epochs' history *before* rotating, so the
    // eager history sync below can actually be decrypted by this device.
    await runtime.store.sealHistoryForMember(deviceKeyHex, caps)
    // A join changes who's authorized, so it always mints a fresh epoch -
    // every currently active member (including the one joining) gets the
    // new epoch key; anyone not in this list (eg. previously revoked)
    // does not.
    const members = await runtime.store.listActiveMembers()
    const { envelopes } = await runtime.store.rotateEpoch(members, 'join')
    this._broadcastRekey(share, runtime, envelopes, { except: deviceKeyHex })
    const envelopeHex = envelopes.get(deviceKeyHex)

    const next = {
      ...link,
      viewers: (link.viewers || 0) + 1,
      consumed: link.type === 'single' ? true : link.consumed
    }
    await runtime.store.meta.put(`link/${link.linkId}`, next)
    share.links.set(link.linkId, next)

    const bootstrap = await this.engine.buildLiveBootstrap(share.sessionId)
    peer.confirmed = true
    peer.linkId = link.linkId
    peer.caps = caps
    peer.deviceKeyHex = deviceKeyHex
    peer.identityKeyHex = identityKeyHex
    peer.identityProofHex = request.identityProof
    peer.inputCounterKey = deviceKeyHex
    if (!share.inputCounters) share.inputCounters = new Map()
    peer.inputCounters = share.inputCounters
    peer.inputCtr = share.inputCounters.get(deviceKeyHex) || 0
    peer.message.send({
      type: 'confirm',
      sessionId: runtime.store.sessionId,
      info: runtime.store.info,
      inputMode: runtime.inputMode || 'host',
      logKey: b4a.toString(runtime.store.log.key, 'hex'),
      metaKey: b4a.toString(runtime.store.metaCore.key, 'hex'),
      hostDeviceKey: b4a.toString(
        runtime.store.writerDeviceKey || runtime.store.localDevice.publicKey,
        'hex'
      ),
      envelope: envelopeHex,
      // Optional identity fields: an older viewer ignores them, and a viewer
      // that gets none treats this host as `unknown`.
      hostIdentityClaim: this._selfIdentityClaim(),
      hostAuthKey: this._localAuthKeyHex(),
      bootstrap: hasCap(peer.caps, VIEW_LIVE)
        ? this._encryptLiveJson(share, runtime, 'bootstrap', bootstrap)
        : null
    })
    this._debug('host:join-confirm', { sessionId: share.sessionId, linkId: link.linkId })
    this._debug('host:bootstrap:sent', {
      sessionId: share.sessionId,
      linkId: link.linkId,
      seq: bootstrap.seq,
      cols: bootstrap.cols,
      rows: bootstrap.rows,
      bytes: bootstrap.data ? bootstrap.data.length : 0
    })
    this._syncHistoryReferencesToPeer(share, peer, runtime).catch((err) =>
      this.emit('error', EngineError.from(err))
    )
    this.emit('share:changed', this.status(share.sessionId))
  }

  async _syncHistoryReferencesToPeer(share, peer, runtime) {
    await this._syncTimelineToPeer(share, peer, runtime)
    await this._syncSnapshotsToPeer(share, peer, runtime)
  }

  async _syncTimelineToPeer(share, peer, runtime) {
    if (!peer || !peer.confirmed || !peer.message) return
    if (!hasCap(peer.caps, READ_HISTORY) || !hasCap(peer.caps, VIEW_LIVE)) return
    const timeline =
      runtime.store && Array.isArray(runtime.store.timeline) ? runtime.store.timeline : []
    if (!timeline.length) return

    this._debug('host:timeline-sync:start', {
      sessionId: share.sessionId,
      linkId: peer.linkId,
      count: timeline.length
    })
    let sent = 0
    for (let i = 0; i < timeline.length; i += TIMELINE_SYNC_CHUNK) {
      if (!peer.confirmed || !peer.message || peer.conn.closed) break
      const items = timeline.slice(i, i + TIMELINE_SYNC_CHUNK)
      const end = i + items.length
      peer.message.send(
        this._encryptLiveJson(share, runtime, 'timeline', {
          items,
          length: runtime.store.log.length,
          more: end < timeline.length
        })
      )
      sent += items.length
      await delay(0)
    }
    this._debug('host:timeline-sync:end', {
      sessionId: share.sessionId,
      linkId: peer.linkId,
      sent
    })
  }

  async _syncSnapshotsToPeer(share, peer, runtime) {
    if (!peer || !peer.confirmed || !peer.message) return
    if (!hasCap(peer.caps, READ_HISTORY) || !hasCap(peer.caps, VIEW_LIVE)) return
    const allSnapshots =
      runtime.snapshot && runtime.snapshot.index && Array.isArray(runtime.snapshot.index.snapshots)
        ? runtime.snapshot.index.snapshots.slice()
        : []
    const snapshots = selectSnapshotSyncItems(allSnapshots, SNAPSHOT_SYNC_MAX)
    if (!snapshots.length) return

    this._debug('host:snapshot-sync:start', {
      sessionId: share.sessionId,
      linkId: peer.linkId,
      count: snapshots.length,
      total: allSnapshots.length
    })
    let sent = 0
    for (const item of snapshots) {
      if (!peer.confirmed || !peer.message || peer.conn.closed) break
      const frame = await runtime.snapshot.read(item.seq)
      peer.message.send(this._encryptLiveJson(share, runtime, 'snapshot', frame))
      sent++
      if (sent % SNAPSHOT_SYNC_YIELD_EVERY === 0) await delay(0)
    }
    this._debug('host:snapshot-sync:end', {
      sessionId: share.sessionId,
      linkId: peer.linkId,
      sent
    })
  }

  // ---------------------------------------------------------------------
  // Identity handshake (Phase 5). Both roles run the same two halves: every
  // side is a *verifier* (it challenges the other) and a *prover* (it answers
  // the other's challenge).
  // ---------------------------------------------------------------------

  // The local signed claim, or null when this profile has no verified
  // identity. Read from a cache the engine refreshes (`selfIdentityClaim`)
  // because join-request is sent synchronously, before any await.
  _selfIdentityClaim() {
    const claim = this.engine && this.engine.selfIdentityClaim
    if (!claim || typeof claim !== 'object') return null
    if (!claim.provider || claim.provider === UNKNOWN || !claim.signature) return null
    return claim
  }

  _localAuthKeyHex() {
    const key = this.engine && this.engine.localDevice && this.engine.localDevice.authPublicKey
    return key ? b4a.toString(key, 'hex') : null
  }

  // The same claim, trimmed to what an invite needs: every field claimBytes()
  // signs, plus the key and signature needed to check it. `createdAt`/`version`
  // are stored-record bookkeeping that nothing verifies, so they are dropped -
  // an invite is a URI someone pastes into a chat, and it should carry the
  // proof and nothing else.
  //
  // Null when this profile has no verified identity, which is what makes a
  // link from an unidentified host read as "not authorized" rather than as an
  // error. An older build ignores the field entirely.
  _inviteIdentityClaim() {
    const claim = this._selfIdentityClaim()
    if (!claim) return null
    return {
      provider: claim.provider,
      subject: claim.subject,
      identityKey: claim.identityKey,
      authKey: claim.authKey,
      sshPublicKey: claim.sshPublicKey || null,
      sshKeyType: claim.sshKeyType || null,
      sshFingerprint: claim.sshFingerprint,
      issuedAt: claim.issuedAt,
      nonce: claim.nonce,
      signature: claim.signature
    }
  }

  // Sends a challenge and returns { challenge, wait } where `wait` settles
  // with the peer's hex signature, or null on timeout. The transport keys
  // inside `challenge` are never transmitted: each side fills in its own view
  // (the backend's local peer key and the connection's remote one), so a
  // relayed answer signs different bytes and fails verification. The field
  // names `verifierDhtKey`/`proverDhtKey` are signed, hence wire-frozen.
  _issueIdentityChallenge(ctx, { sessionId, role, send, conn }) {
    const challengeId = crypto.randomBytes(16).toString('hex')
    const nonce = crypto.randomBytes(32).toString('hex')
    const challenge = {
      sessionId: sessionId || '',
      challengeId,
      nonce,
      verifierDhtKey: hex(this._backendOfConn(conn).localPeerKey()),
      proverDhtKey: hex(conn && conn.remotePeerKey),
      role
    }
    let resolve = null
    const wait = new Promise((r) => {
      resolve = r
    })
    const timer = setTimeout(() => {
      if (!ctx.identityPending || ctx.identityPending.challengeId !== challengeId) return
      ctx.identityPending = null
      resolve(null)
    }, this.identityTimeoutMs)
    ctx.identityPending = { challengeId, challenge, resolve, timer }
    send.send({
      type: 'identity-challenge',
      challengeId,
      nonce,
      sessionId: challenge.sessionId,
      role
    })
    return { challenge, wait }
  }

  // Prover half: the core signs the peer's challenge with this device's auth
  // key (`identity.signChallenge` over the seam). The signed bytes mirror the
  // verifier's view (their DHT key is the verifier, ours is the prover). The
  // answer goes out when the core replies; a failure sends nothing, which the
  // verifier treats as an unanswered challenge.
  _answerIdentityChallenge(send, conn, message) {
    const secretKey = this.engine.localDevice && this.engine.localDevice.authSecretKey
    if (!secretKey || !send) return
    const challenge = {
      sessionId: message.sessionId || '',
      challengeId: message.challengeId,
      nonce: message.nonce,
      verifierDhtKey: hex(conn && conn.remotePeerKey),
      proverDhtKey: hex(this._backendOfConn(conn).localPeerKey()),
      role: message.role
    }
    signChallenge(secretKey, challenge, this.engine.core).then(
      (signature) => {
        send.send({
          type: 'identity-response',
          challengeId: message.challengeId,
          signature: b4a.toString(signature, 'hex')
        })
      },
      (err) => this._debug('identity:sign-failed', { message: err && err.message })
    )
  }

  _settleIdentityChallenge(ctx, message) {
    const pending = ctx && ctx.identityPending
    if (!pending || pending.challengeId !== message.challengeId) return
    ctx.identityPending = null
    clearTimeout(pending.timer)
    pending.resolve(message.signature || null)
  }

  // The two identity ctl messages, handled identically for both roles.
  _handleIdentityCtlMessage(ctx, send, conn, message) {
    if (message.type === 'identity-challenge') {
      this._answerIdentityChallenge(send, conn, message)
      return true
    }
    if (message.type === 'identity-response') {
      this._settleIdentityChallenge(ctx, message)
      return true
    }
    return false
  }

  _emitPeerIdentity(payload) {
    this.emit('share:peer-identity', payload)
  }

  // Host side gate, run from _confirmJoin before approval/grant. Returns
  // false when the peer was denied.
  async _verifyViewerIdentity(share, peer, request, identityKeyHex, deviceKeyHex) {
    const claim = request.identityClaim || null
    const emit = (status, result) => {
      this._emitPeerIdentity({
        sessionId: share.sessionId,
        direction: 'viewer',
        identityKey: identityKeyHex,
        deviceKey: deviceKeyHex,
        displayId: result ? result.displayId : displayIdFor(UNKNOWN, identityKeyHex),
        provider: result ? result.provider : (claim && claim.provider) || UNKNOWN,
        status,
        reason: result ? result.reason : null
      })
    }
    if (!claim) {
      // No claim presented: allowed, recorded as unknown, and no challenge is
      // ever sent.
      const result = await verifyPeerIdentity({
        claim: null,
        identityKey: identityKeyHex,
        deviceKey: deviceKeyHex,
        store: this.engine.identityStore,
        core: this.engine.core
      })
      peer.identityStatus = result.status
      peer.identityDisplayId = result.displayId
      emit(result.status, result)
      return true
    }
    // Guard: one challenge per peer, even if a second join-request arrives.
    peer.identityState = 'pending'
    peer.identityStatus = 'pending'
    emit('pending', null)
    const startedAt = Date.now()
    const { challenge, wait } = this._issueIdentityChallenge(peer, {
      sessionId: share.sessionId,
      role: 'viewer',
      send: peer.message,
      conn: peer.conn
    })
    const signature = await wait
    const result = await verifyPeerIdentity({
      claim,
      authKey: request.authKey,
      identityKey: identityKeyHex,
      deviceKey: deviceKeyHex,
      identityProof: request.identityProof,
      challenge,
      signature,
      resolver: this.engine.identityResolver,
      store: this.engine.identityStore,
      core: this.engine.core
    })
    peer.identityState = result.status
    peer.identityStatus = result.status
    peer.identityDisplayId = result.displayId
    this._debug('host:identity:result', {
      sessionId: share.sessionId,
      linkId: request.linkId,
      identityKey: identityKeyHex,
      status: result.status,
      reason: result.reason,
      ms: Date.now() - startedAt
    })
    // Emit before denying: _denyPeer closes the channel, and anything emitted
    // after it would race the teardown.
    emit(result.status, result)
    if (result.status === 'failed') {
      this._denyPeer(peer, CODES.E_AUTH, 'Identity verification failed', JOIN_REASONS.IDENTITY)
      return false
    }
    return true
  }

  // Viewer side mirror, run on `confirm` before the remote session is
  // registered. Returns false when the join was aborted.
  async _verifyHostIdentity(state, message) {
    const claim = message.hostIdentityClaim || null
    const identityKeyHex = claim && claim.identityKey ? String(claim.identityKey) : null
    const deviceKeyHex = message.hostDeviceKey || null
    const emit = (status, result) => {
      this._emitPeerIdentity({
        sessionId: message.sessionId || state.sessionId || null,
        direction: 'host',
        identityKey: identityKeyHex,
        deviceKey: deviceKeyHex,
        displayId: result ? result.displayId : displayIdFor(UNKNOWN, identityKeyHex || ''),
        provider: result ? result.provider : (claim && claim.provider) || UNKNOWN,
        status,
        reason: result ? result.reason : null
      })
    }
    if (!claim) {
      emit('unknown', null)
      return true
    }
    emit('pending', null)
    const startedAt = Date.now()
    const { challenge, wait } = this._issueIdentityChallenge(state, {
      sessionId: message.sessionId,
      role: 'host',
      send: state.message,
      conn: state.conn
    })
    const signature = await wait
    const result = await verifyPeerIdentity({
      claim,
      authKey: message.hostAuthKey,
      identityKey: identityKeyHex,
      deviceKey: deviceKeyHex,
      challenge,
      signature,
      resolver: this.engine.identityResolver,
      store: this.engine.identityStore,
      core: this.engine.core
    })
    this._debug('viewer:identity:result', {
      linkId: state.invite.linkId,
      sessionId: message.sessionId,
      identityKey: identityKeyHex,
      status: result.status,
      reason: result.reason,
      ms: Date.now() - startedAt
    })
    emit(result.status, result)
    if (result.status === 'failed') {
      if (state.finish) {
        state.finish({
          status: 'failed',
          code: CODES.E_AUTH,
          message: 'Host identity verification failed'
        })
      }
      if (state.conn) state.conn.close('host-identity-failed')
      return false
    }
    return true
  }

  // `reason` is the machine-readable side of `message` (JOIN_REASONS): the
  // viewer's UI turns it into a sentence of its own, so the wording here can
  // change without the viewer's build changing with it.
  _denyPeer(peer, code, message, reason = null) {
    if (peer && peer.message) peer.message.send({ type: 'error', code, message, reason })
    if (peer) setImmediate(() => this._disconnectHostPeer(peer))
  }

  // Disconnects one peer without touching the underlying connection - it is
  // shared, so closing it would also drop any other session's channel it
  // happens to be carrying (see docs/DESIGN-SWARM-AND-WORKER.md, "New pitfall
  // 3"). Real peers always have a channel (set in _openHostChannel); closing
  // it runs the same cleanup the connection's 'close' listener would run,
  // just scoped to this one peer. A peer shape without a channel (eg. a test
  // mock) is logged and left alone.
  _disconnectHostPeer(peer) {
    if (peer.channel) {
      peer.channel.close()
      this._cleanupHostPeer(peer)
      const connPeers = this._connPeers.get(peer.conn)
      if (connPeers) connPeers.delete(peer)
      return
    }
    this._debug('host:peer:missing-channel', { sessionId: peer.sessionId, linkId: peer.linkId })
  }

  _disableInputWhenEmpty(share) {
    if (!share) return
    for (const peer of share.peers) if (peer.confirmed) return
    const runtime = this.engine.sessions && this.engine.sessions.get(share.sessionId)
    if (!runtime || runtime.inputMode !== 'all') return
    runtime.inputMode = 'host'
    this._debug('host:input:disabled', {
      sessionId: share.sessionId,
      reason: 'no-viewers'
    })
    this.broadcastInfo(share.sessionId, { inputMode: runtime.inputMode })
  }

  _encryptLiveJson(share, runtime, type, value) {
    return this._encryptLiveMessage(share, runtime, type, Buffer.from(JSON.stringify(value)))
  }

  _encryptLiveMessage(share, runtime, type, plain, extra = {}) {
    const seq = ++share.liveSeq
    const deviceKey = runtime.store.writerDeviceKey || runtime.store.localDevice.publicKey
    const ciphertext = encryptPacket(
      runtime.store.keys.liveKey,
      runtime.store.sessionId,
      runtime.store.epoch,
      seq,
      deviceKey,
      plain
    )
    return {
      ...extra,
      type,
      epoch: runtime.store.epoch,
      seq,
      deviceKey: b4a.toString(deviceKey, 'hex'),
      data: b4a.toString(ciphertext, 'base64')
    }
  }

  _openInputMessage(runtime, peer, message) {
    if (!peer || !peer.confirmed) throw new EngineError(CODES.E_AUTH, 'Input peer is not joined')
    if (!hasCap(peer.caps, SEND_INPUT)) {
      throw new EngineError(CODES.E_AUTH, 'Peer is not allowed to send input')
    }
    const sealed = b4a.from(message.data || '', 'base64')
    const plain = openSealedBytes(
      this.engine.localDevice.publicKey,
      this.engine.localDevice.secretKey,
      sealed
    )
    const input = JSON.parse(plain.toString('utf8'))
    if (input.sessionId !== runtime.store.sessionId) {
      throw new EngineError(CODES.E_AUTH, 'Input was sealed for a different session')
    }
    if (input.epoch !== runtime.store.epoch) {
      throw new EngineError(CODES.E_AUTH, 'Input was sealed for a different epoch')
    }
    if (input.deviceKey !== peer.deviceKeyHex || input.identityKey !== peer.identityKeyHex) {
      throw new EngineError(CODES.E_AUTH, 'Input identity does not match the joined peer')
    }
    // Synchronous on purpose (this runs per input frame): the core already
    // verified this exact proof when the peer joined (`_confirmJoin`), and
    // only a proof it accepted passes here.
    if (!isVerifiedDeviceIdentity(input.identityProof, input.identityKey, input.deviceKey)) {
      throw new EngineError(CODES.E_AUTH, 'Input identity proof is invalid')
    }
    if (input.identityProof !== peer.identityProofHex) {
      throw new EngineError(CODES.E_AUTH, 'Input identity proof does not match the joined peer')
    }
    const inputCounterKey = peer.inputCounterKey || peer.deviceKeyHex
    const lastInputCtr = Math.max(
      peer.inputCtr || 0,
      peer.inputCounters ? peer.inputCounters.get(inputCounterKey) || 0 : 0
    )
    if (!Number.isSafeInteger(input.inputCtr) || input.inputCtr <= lastInputCtr) {
      throw new EngineError(CODES.E_AUTH, 'Input counter replayed or out of order')
    }
    peer.inputCtr = input.inputCtr
    if (peer.inputCounters) peer.inputCounters.set(inputCounterKey, input.inputCtr)
    return Buffer.from(input.data || '', 'base64').toString('utf8')
  }

  // Two independent revocation sources: (1) this identity was previously a
  // member of this session and was revoked (eg. via revokeMember, or a
  // revoked link's members), and (2) the device belongs to this host's own
  // account and has been revoked there (engine/account-store.js). A device
  // with no account-store record simply isn't one of the host's own
  // devices, so it isn't "not-applicable" revoked - only a hit is decisive.
  async _isRevoked(runtime, identityKeyHex, deviceKeyHex) {
    const member = await runtime.store.getMember(identityKeyHex)
    if (member && member.status === 'revoked') return true
    if (this.engine.account) {
      const device = await this.engine.account.getDevice(deviceKeyHex).catch(() => null)
      if (device && !(await this.engine.account.isDeviceActive(deviceKeyHex))) return true
    }
    return false
  }

  async _loadLink(runtime, linkId) {
    const node = await runtime.store.meta.get(`link/${linkId}`)
    return node && node.value
  }

  _handleViewerConnection(state, conn) {
    if (state.connected) return
    state.connected = true
    this._debug('viewer:socket:connection', {
      linkId: state.invite.linkId,
      remotePublicKey: hex(conn.remotePeerKey),
      client: conn.initiator === true,
      server: conn.initiator === false
    })
    // Primary pinning control (docs/DESIGN-SWARM-AND-WORKER.md, "Phase 3 ->
    // Pinning"): exact per-join pinning at the application layer, checked
    // before creating a channel or sending join-request (which carries this
    // device's identity proof - information that must not reach an
    // unverified peer). This does not replace the backend's own dial pin; it
    // is the control that stays exact per-join whatever the backend's
    // admission can or cannot distinguish.
    if (!b4a.equals(conn.remotePeerKey, state.hostDhtKey)) {
      this._debug('viewer:socket:host-mismatch', {
        linkId: state.invite.linkId,
        expectedHostDhtKey: hex(state.hostDhtKey),
        remotePublicKey: hex(conn.remotePeerKey)
      })
      // Fail immediately rather than letting this fall through to the
      // generic join-timeout path - this connection is provably not the invited
      // host, so there is nothing to wait for. No channel is created and no
      // join-request (which carries this device's identity proof) is ever
      // sent on it.
      if (state.finish) {
        state.finish({
          status: 'failed',
          code: CODES.E_AUTH,
          reason: JOIN_REASONS.HOST_MISMATCH,
          message: 'Share host key did not match the invite'
        })
      }
      conn.close('host-key-mismatch')
      return
    }
    state.conn = conn
    conn.once('close', () => {
      this._debug('viewer:socket:close', {
        linkId: state.invite.linkId,
        sessionId: state.sessionId
      })
      if (!state.confirmed && state.finish) {
        state.finish({
          status: 'failed',
          code: CODES.E_AUTH,
          reason: JOIN_REASONS.CLOSED,
          message: 'Share connection closed before the session was joined'
        })
      } else if (state.sessionId) {
        this.engine.markRemoteOffline(state.sessionId).catch(() => {})
        this._settleJoin(state)
      }
    })
    conn.once('error', (err) => {
      this._debug('viewer:socket:error', {
        linkId: state.invite.linkId,
        sessionId: state.sessionId,
        message: err.message
      })
    })
    // protomux dispatches onmessage per incoming frame without waiting for a
    // previous async handler to settle (see _track/_recv in protomux), so two
    // handler invocations can overlap. That matters here because 'rekey'
    // awaits remote.store.applyEpochEnvelope() before the new epoch's key is
    // installed - a 'data'/'snapshot'/'timeline' message already encrypted
    // under the new epoch can otherwise be decrypted with the stale key,
    // guaranteed to fail authentication. Chaining every message through this
    // queue forces strict in-order processing per channel.
    state.messageQueue = Promise.resolve()
    const linkChannelId = b4a.from(state.invite.linkId, 'hex')
    // One object is both the channel and its message sender.
    state.channel = state.message = conn.openChannel(PROTOCOL, linkChannelId, {
      onmessage: (message) => {
        // The two identity frames deliberately bypass the queue: the
        // `confirm` handler runs *inside* the chain and blocks waiting for
        // the host's identity-response, so queueing that response behind it
        // would deadlock. Neither frame touches epoch/session state, so
        // in-order processing of everything else is unaffected.
        if (
          message &&
          (message.type === 'identity-challenge' || message.type === 'identity-response')
        ) {
          this._handleIdentityCtlMessage(state, state.message, state.conn, message)
          return
        }
        state.messageQueue = state.messageQueue.then(() =>
          this._handleViewerCtlMessage(state, message)
        )
        return state.messageQueue
      },
      onclose: () => {
        if (state.confirmed && state.sessionId) this._settleJoin(state)
      }
    })
    this._debug('viewer:ctl:open', { linkId: state.invite.linkId })
    state.message.send({
      type: 'join-request',
      linkId: state.invite.linkId,
      deviceKey: b4a.toString(this.engine.localDevice.publicKey, 'hex'),
      identityKey: b4a.toString(this.engine.localDevice.identityPublicKey, 'hex'),
      identityProof: b4a.toString(this.engine.localDevice.identityProof, 'hex'),
      deviceName: process.env.USER || 'viewer',
      // Optional identity fields: null when this profile has no verified
      // identity, absent entirely on older builds.
      identityClaim: this._selfIdentityClaim(),
      authKey: this._localAuthKeyHex(),
      appVersion: '1'
    })
    this._debug('viewer:join-request:sent', { linkId: state.invite.linkId })
  }

  async _handleViewerCtlMessage(state, message) {
    try {
      this._debug('viewer:ctl:message', {
        linkId: state.invite.linkId,
        type: message.type,
        sessionId: message.sessionId || state.sessionId
      })
      // A join that ended before it was confirmed - refused by the identity
      // gate, timed out, or errored - can still have host frames in flight:
      // an auto-join host sends bootstrap/timeline/snapshot in the same tick
      // as `confirm`, so they are already queued behind it when the gate
      // refuses. There is no local session to apply them to, and letting them
      // fall through raises 'Remote session is not registered' as an
      // engine:error the UI shows as a failure. Dropping them is the whole
      // handling.
      if (state.done && !state.confirmed) return
      if (message.type === 'approval-pending') {
        // The host has the request and a person is deciding. The join timer
        // was armed for "is the host reachable at all"; letting it run on
        // would fail a slow decision with "host was not found". Re-arm it for
        // the decision, with its own reason.
        if (state.timer) clearTimeout(state.timer)
        state.timer = setTimeout(() => {
          this._debug('viewer:approval-timeout', { linkId: state.invite.linkId })
          state.finish({
            status: 'failed',
            code: CODES.E_AUTH,
            reason: JOIN_REASONS.NO_ANSWER,
            message: 'The host did not answer the join request'
          })
        }, APPROVAL_TIMEOUT_MS)
        this.emit('join:changed', {
          status: 'approval-pending',
          linkId: state.invite.linkId
        })
        return
      }
      if (message.type === 'confirm') {
        // Identity gate (Phase 5): a host claim that fails verification
        // aborts the join before any remote session is registered locally.
        if (!(await this._verifyHostIdentity(state, message))) return
        state.confirmed = true
        state.sessionId = message.sessionId
        state.registeringRemote = this._registerViewerRemote(state, message)
        try {
          await state.registeringRemote
        } catch (err) {
          // Registration failed (eg. local storage could not be opened).
          // Leaving state.registeringRemote pointed at this rejected
          // promise would make every later data/snapshot/timeline
          // message re-await and re-throw the same error forever, so
          // fail the join cleanly instead.
          state.registeringRemote = null
          this._debug('viewer:register-remote-error', {
            linkId: state.invite.linkId,
            sessionId: message.sessionId,
            message: err.message
          })
          if (state.finish) {
            state.finish({
              status: 'failed',
              code: (err && err.code) || CODES.E_INTERNAL,
              message: (err && err.message) || 'Failed to set up the shared session locally'
            })
          }
          return
        }
        state.registeringRemote = null
        this._debug('viewer:join-confirmed', { sessionId: message.sessionId })
        if (message.bootstrap) {
          await this._applyEncryptedBootstrap(state.sessionId, message.bootstrap)
          if (state.timer) clearTimeout(state.timer)
          state.joined = true
          this.emit('join:changed', {
            status: 'joined',
            linkId: state.invite.linkId,
            sessionId: message.sessionId
          })
        } else {
          if (state.timer) clearTimeout(state.timer)
          this.emit('join:changed', {
            status: 'syncing',
            linkId: state.invite.linkId,
            sessionId: message.sessionId
          })
        }
        return
      }
      if (message.type === 'bootstrap') {
        if (state.registeringRemote) await state.registeringRemote
        await this._applyEncryptedBootstrap(state.sessionId, message)
        if (state.timer) clearTimeout(state.timer)
        // Only the first bootstrap completes the join. The host re-sends its
        // screen on every resize, and its renderer resizes whenever the user
        // switches back to the shared session's tab; announcing 'joined'
        // again made the viewer's UI select the session every time, so the
        // viewer followed the host's tab switches. Later bootstraps repaint
        // (applyRemoteBootstrap emits `session:restored`) and say nothing here.
        if (state.joined) return
        state.joined = true
        this.emit('join:changed', {
          status: 'joined',
          linkId: state.invite.linkId,
          sessionId: state.sessionId
        })
        return
      }
      if (message.type === 'data') {
        if (state.registeringRemote) await state.registeringRemote
        const data = this._decryptViewerLiveMessage(state.sessionId, message)
        this.engine.applyRemoteData(state.sessionId, data, {
          hd: !!message.hd
        })
        return
      }
      if (message.type === 'snapshot') {
        if (state.registeringRemote) await state.registeringRemote
        const frame = this._decryptViewerLiveJson(state.sessionId, message)
        await this.engine.applyRemoteSnapshot(state.sessionId, frame)
        return
      }
      if (message.type === 'timeline') {
        if (state.registeringRemote) await state.registeringRemote
        const timeline = this._decryptViewerLiveJson(state.sessionId, message)
        await this.engine.applyRemoteTimeline(state.sessionId, timeline)
        return
      }
      if (message.type === 'rekey') {
        if (state.registeringRemote) await state.registeringRemote
        const remote = this.engine.remoteSessions.get(state.sessionId)
        if (remote) await remote.store.applyEpochEnvelope(message.epoch, message.envelope)
        return
      }
      if (message.type === 'end') {
        this.engine.markRemoteOffline(state.sessionId, message.exit).catch(() => {})
        this._settleJoin(state)
        return
      }
      if (message.type === 'info') {
        await this.engine.applyRemoteInfo(state.sessionId, message.info || {})
        return
      }
      if (message.type === 'error') {
        this._debug('viewer:join-error', {
          linkId: state.invite.linkId,
          code: message.code,
          message: message.message
        })
        if (state.finish) {
          state.finish({
            status: 'failed',
            code: message.code || CODES.E_AUTH,
            reason: typeof message.reason === 'string' ? message.reason : null,
            message: message.message || 'Share failed'
          })
        }
      }
    } catch (err) {
      this.emit('error', EngineError.from(err))
    }
  }

  async _applyEncryptedBootstrap(sessionId, message) {
    const plain = this._decryptViewerLiveMessage(sessionId, message)
    await this.engine.applyRemoteBootstrap(sessionId, JSON.parse(plain.toString('utf8')))
  }

  _decryptViewerLiveJson(sessionId, message) {
    return JSON.parse(this._decryptViewerLiveMessage(sessionId, message).toString('utf8'))
  }

  _settleJoin(state) {
    if (state && state.settle) state.settle()
  }

  async _registerViewerRemote(state, message) {
    const remote = await this.engine.registerRemoteSession(message)
    remote.message = state.message
    // Attaches history replication to the join's connection and starts the
    // full-range download of both the log and the meta core.
    state.history = (state.backend || this.backend).attachHistory(state.conn, remote.store, {
      logKey: message.logKey,
      metaKey: message.metaKey
    })
    state.downloads.push(state.history)
    // The engine's catch-up download asks this handle for ranges; it never
    // reaches into the backend's replication itself.
    remote.history = state.history
    return remote
  }

  _decryptViewerLiveMessage(sessionId, message) {
    const remote = this.engine.remoteSessions.get(sessionId)
    if (!remote) throw new EngineError(CODES.E_INTERNAL, 'Remote session is not registered')
    try {
      return decryptPacket(
        remote.store.keys.liveKey,
        remote.store.sessionId,
        message.epoch,
        message.seq,
        b4a.from(message.deviceKey, 'hex'),
        b4a.from(message.data, 'base64')
      )
    } catch (err) {
      // A live-key/epoch mismatch is the far more likely cause of an auth
      // failure than transport corruption - logging both epochs here turns a
      // "could not verify data" mystery into an immediate diagnosis.
      this._debug('viewer:decrypt-failed', {
        sessionId,
        messageType: message.type,
        messageEpoch: message.epoch,
        localEpoch: remote.store.epoch,
        seq: message.seq,
        epochMismatch: message.epoch !== remote.store.epoch,
        error: err.message
      })
      throw err
    }
  }

  sealInput(sessionId, data) {
    const remote = this.engine.remoteSessions.get(sessionId)
    if (!remote) throw new EngineError(CODES.E_INTERNAL, 'Remote session is not registered')
    // Freenet path: the core seals and counts the input when the join's
    // `message.send` hands it over (`_coreViewerInput`), so what
    // engine/index.js::input passes on is the input itself.
    if (remote.message && remote.message.viaCore) return data
    const hostDeviceKey = remote.store.writerDeviceKey
    const nextCtr = (remote.inputCtr || 0) + 1
    remote.inputCtr = nextCtr
    this._debug('viewer:input:sealed', {
      sessionId,
      inputCtr: nextCtr,
      inputMode: remote.inputMode || 'host',
      bytes: Buffer.byteLength(String(data || ''))
    })
    return b4a.toString(
      sealBytes(
        hostDeviceKey,
        Buffer.from(
          JSON.stringify({
            sessionId,
            epoch: remote.store.epoch,
            inputCtr: nextCtr,
            deviceKey: b4a.toString(this.engine.localDevice.publicKey, 'hex'),
            identityKey: b4a.toString(this.engine.localDevice.identityPublicKey, 'hex'),
            identityProof: b4a.toString(this.engine.localDevice.identityProof, 'hex'),
            data: Buffer.from(data).toString('base64')
          })
        )
      ),
      'base64'
    )
  }

  // ---------------------------------------------------------------------
  // The Freenet path (K14 of zxterm-core, stage C2; ZBTerm D-38). The Rust
  // sidecar of the backend runs the session protocol - keys, envelopes and
  // epochs, the identity challenge, approvals, live output with its lag
  // resync, sealed input (zxterm `docs/projects/260928_zxterm-core/
  // protocol.md`) - and this file reaches it through engine/zxterm/share.js:
  // `share.*` requests out, `share.*` events in. What stays here is what the
  // core does not own: the session store (its epochs, members and link
  // records), the engine's screen and remote sessions, the UI's events, and
  // the terminal's documents (bootstrap, timeline, snapshots), which the core
  // only seals. Pear and the loopback never come here: `share.core` and
  // `state.viaCore` are null and false for them.
  // ---------------------------------------------------------------------

  // The bridge of the backend's sidecar, with this manager's handlers on it;
  // null for a backend without one (Pear, the loopback).
  async _coreOf(backend) {
    if (!backend || typeof backend.sessionCore !== 'function') return null
    const core = await backend.sessionCore()
    return core ? this._listenCore(core) : null
  }

  _listenCore(core) {
    const bridge = bridgeFor(core)
    if (this._coreListeners.has(bridge)) return bridge
    const handlers = {
      pending: (d) => this._onCorePending(d),
      approvalCancelled: (d) => this._onCoreApprovalCancelled(d),
      granted: (d) => this._onCoreGranted(d),
      peerLeft: (d) => this._onCorePeerLeft(d),
      epoch: (d) => this._onCoreEpoch(d),
      bootstrapNeeded: (d) => this._onCoreBootstrapNeeded(d),
      input: (d) => this._onCoreInput(d),
      inputRefused: (d) => this._onCoreInputRefused(d),
      peerIdentity: (d) => this._onCorePeerIdentity(d),
      joinChanged: (d) => this._onCoreJoinChanged(d),
      output: (d) => this._onCoreViewerEvent(d, (state) => this._coreViewerOutput(state, d)),
      live: (d) => this._onCoreViewerEvent(d, (state) => this._coreViewerLive(state, d)),
      rekey: (d) => this._onCoreViewerEvent(d, (state) => this._coreViewerRekey(state, d)),
      end: (d) => this._onCoreViewerEvent(d, (state) => this._coreViewerEnd(state, d)),
      info: (d) => this._onCoreViewerEvent(d, (state) => this._coreViewerInfo(state, d)),
      offline: (d) => this._onCoreViewerEvent(d, (state) => this._coreViewerOffline(state)),
      error: (d) => this._onCoreError(d),
      debug: (d) => this._debug(d.event, d.details || {}),
      exit: (info) => this._onCoreExit(info)
    }
    for (const [name, fn] of Object.entries(handlers)) bridge.on(name, fn)
    this._coreListeners.set(bridge, handlers)
    return bridge
  }

  _unlistenCores() {
    for (const [bridge, handlers] of this._coreListeners) {
      for (const [name, fn] of Object.entries(handlers)) bridge.off(name, fn)
    }
    this._coreListeners.clear()
  }

  // What `share.hostOpen` and `share.join` call the local device.
  _coreLocal() {
    const device = this.engine.localDevice
    const local = {
      deviceSecretKey: hex(device.secretKey),
      identityKey: hex(device.identityPublicKey),
      identityProof: hex(device.identityProof),
      deviceName: process.env.USER || 'viewer'
    }
    const claim = this._selfIdentityClaim()
    if (claim) local.claim = claim
    if (device.authSecretKey) local.authSecretKey = hex(device.authSecretKey)
    return local
  }

  // A request whose failure is a debug event, not an error (a push into a
  // session that has just ended, a call racing the teardown).
  _coreSend(share, method, args) {
    return share.out.send(method, args).catch((err) =>
      this._debug('host:core:error', {
        method,
        sessionId: share.sessionId,
        message: err && err.message
      })
    )
  }

  // --- host ---

  // `share.hostOpen`: the core mints the first epoch it holds, one above the
  // store's (protocol.md section 3.3: a host that did not mint the epoch it
  // encrypts under rotates before its first live frame), and the store
  // installs it from `share.epoch`.
  async _coreHostOpen(share, runtime) {
    const store = runtime.store
    share.firstEpoch = (Number.isFinite(store.epoch) ? store.epoch : 1) + 1
    const info = store.info || {}
    const flags = info.flags || {}
    await share.core.request('share.hostOpen', {
      sessionId: share.sessionId,
      logKey: hex(store.log.key),
      metaKey: hex(store.metaCore.key),
      local: this._coreLocal(),
      info: {
        name: info.name || '',
        createdAt: info.createdAt || 0,
        cols: runtime.cols || info.cols || 0,
        rows: runtime.rows || info.rows || 0
      },
      sensitive: !!flags.sensitive,
      quickCatchupKB: flags.quickCatchupKB || 0,
      inputMode: runtime.inputMode === 'all' ? 'all' : 'host',
      firstEpoch: share.firstEpoch
    })
    await this._epochApplied(share, share.firstEpoch)
    await this._coreOpenHistory(share, runtime)
  }

  // The session's history in the core (K17, D-40): the core serves a viewer's
  // range of it on the `history` channel and publishes it to the segment-v1
  // contract. The recording's existing Hypercore packets go in once, at the
  // session's first Freenet share; what the store appends afterwards follows.
  // A store this cannot keep history for (a test's stub) has none, and a
  // history that fails to open costs the share its history, not the share.
  async _coreOpenHistory(share, runtime) {
    const store = runtime.store
    if (!supportsHistory(store)) return
    const history = new HostHistory({
      request: (method, args) => share.core.request(method, args),
      store,
      sessionId: share.sessionId,
      debug: (event, details) => this._debug(event, details)
    })
    try {
      await history.open()
      share.history = history
    } catch (err) {
      this._debug('host:history:open-failed', { sessionId: share.sessionId, message: err.message })
      this.emit('error', EngineError.from(err))
    }
  }

  // `share.addLink`. A link that joins without asking is registered with the
  // core as one that asks when ZBTerm has a refusal of its own to apply
  // (`_joinGateNeeded`): the core has no store of the host's account devices
  // or of members revoked in an earlier run, so it hands such a join to
  // `_onCorePending` and ZBTerm approves it there.
  async _coreAddLink(share, runtime, link) {
    const gated = link.autoJoin && (await this._joinGateNeeded(runtime))
    await share.core.request('share.addLink', {
      sessionId: share.sessionId,
      linkId: link.linkId,
      type: link.type,
      maxViewers: link.maxViewers,
      autoJoin: !!link.autoJoin && !gated,
      caps: link.caps
    })
  }

  // Whether some identity or device is already refused by ZBTerm's own
  // records: a member revoked in the store, or a revoked device of the host's
  // account.
  async _joinGateNeeded(runtime) {
    try {
      const meta = runtime.store && runtime.store.meta
      if (meta && typeof meta.createReadStream === 'function') {
        for await (const node of meta.createReadStream({ gt: 'member/', lt: 'member0' })) {
          if (node.value && node.value.status === 'revoked') return true
        }
      }
      const account = this.engine.account
      if (account && typeof account.listDevices === 'function') {
        const devices = await account.listDevices()
        if (devices.some((device) => device.status && device.status !== 'active')) return true
      }
    } catch {
      // A store without those records has nothing to refuse.
    }
    return false
  }

  // Runs `fn` after everything queued before it for this share: the core's
  // events reach the store in the order the core produced them.
  _shareQueue(share, fn) {
    share.queue = share.queue.then(fn).catch((err) => this.emit('error', EngineError.from(err)))
    return share.queue
  }

  _onCoreEpoch(data) {
    const share = this.hostShares.get(data.sessionId)
    if (!share || !share.core) return
    this._shareQueue(share, async () => {
      try {
        const runtime = this.engine.sessions.get(share.sessionId)
        if (runtime && runtime.store && typeof runtime.store.applyCoreEpoch === 'function') {
          await runtime.store.applyCoreEpoch(data)
          const keys = runtime.store.keysByEpoch && runtime.store.keysByEpoch.get(data.epoch)
          if (share.history && keys && keys.historyKey) {
            share.history.setEpoch(data.epoch, hex(keys.historyKey))
          }
        }
      } finally {
        share.appliedEpoch = Math.max(share.appliedEpoch, data.epoch)
        const waiting = share.epochWaiters.filter((waiter) => waiter.epoch <= share.appliedEpoch)
        share.epochWaiters = share.epochWaiters.filter(
          (waiter) => waiter.epoch > share.appliedEpoch
        )
        for (const waiter of waiting) {
          clearTimeout(waiter.timer)
          waiter.resolve(true)
        }
      }
    })
  }

  // Resolves once the store holds epoch `epoch` (or later): true, or false
  // after `timeoutMs`.
  _epochApplied(share, epoch, timeoutMs = 10000) {
    if (share.appliedEpoch >= epoch) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter = { epoch, resolve, timer: null }
      waiter.timer = setTimeout(() => {
        share.epochWaiters = share.epochWaiters.filter((item) => item !== waiter)
        this._debug('host:epoch:timeout', { sessionId: share.sessionId, epoch })
        resolve(false)
      }, timeoutMs)
      share.epochWaiters.push(waiter)
    })
  }

  // After a call that may have rotated: the core's epoch, and the wait for
  // the store to hold it.
  async _coreSettled(share) {
    try {
      const status = await share.core.request('share.status', { sessionId: share.sessionId })
      await this._epochApplied(share, status.epoch)
    } catch (err) {
      this._debug('host:core:error', { method: 'share.status', message: err && err.message })
    }
  }

  async _onCorePending(data) {
    const share = this.hostShares.get(data.sessionId)
    const runtime = this.engine.sessions.get(data.sessionId)
    if (!share || !share.core || !runtime) return
    try {
      const link = share.links.get(data.linkId) || (await this._loadLink(runtime, data.linkId))
      if (await this._isRevoked(runtime, data.identityKey, data.deviceKey)) {
        this._debug('host:join-deny', { linkId: data.linkId, reason: 'revoked' })
        await share.core.request('share.deny', { sessionId: data.sessionId, joinId: data.joinId })
        return
      }
      if (link && link.autoJoin) {
        await share.core.request('share.approve', {
          sessionId: data.sessionId,
          joinId: data.joinId
        })
        return
      }
      const requestId = data.joinId
      share.pendingApprovals.set(requestId, {
        requestId,
        core: true,
        joinId: data.joinId,
        linkId: data.linkId,
        createdAt: Date.now()
      })
      this._debug('host:join-pending', { linkId: data.linkId, requestId })
      this.emit('approval:pending', {
        requestId,
        sessionId: data.sessionId,
        linkId: data.linkId,
        linkType: link ? link.type : 'single',
        maxViewers: link ? link.maxViewers : 1,
        deviceKey: data.deviceKey,
        identityKey: data.identityKey,
        deviceName: data.deviceName || 'viewer'
      })
    } catch (err) {
      // A gate that could not decide refuses: the join is not left waiting.
      share.core
        .request('share.deny', { sessionId: data.sessionId, joinId: data.joinId })
        .catch(() => {})
      this.emit('error', EngineError.from(err))
    }
  }

  _onCoreApprovalCancelled(data) {
    const share = this.hostShares.get(data.sessionId)
    if (!share || !share.core) return
    // The requester is gone (gave up, or timed out waiting) or its link was
    // revoked: the host's approve/deny prompt for it has nothing left to
    // decide.
    if (share.pendingApprovals.delete(data.joinId)) {
      this.emit('approval:cancelled', { requestId: data.joinId, sessionId: data.sessionId })
    }
  }

  _onCoreGranted(data) {
    const share = this.hostShares.get(data.sessionId)
    if (!share || !share.core) return
    const identity = share.identities.get(data.joinId) || null
    share.identities.delete(data.joinId)
    const peer = {
      core: true,
      joinId: data.joinId,
      sessionId: data.sessionId,
      confirmed: true,
      linkId: data.linkId,
      caps: data.caps,
      deviceKeyHex: data.deviceKey,
      identityKeyHex: data.identityKey,
      identityStatus: identity ? identity.status : 'unknown',
      identityDisplayId: identity ? identity.displayId : null,
      inputCtr: 0
    }
    share.peers.add(peer)
    share.peersByJoin.set(data.joinId, peer)
    this._shareQueue(share, () => this._coreGrantedLocally(share, peer))
    this.emit('share:changed', this.status(share.sessionId))
  }

  // What the core does not persist of a grant: the member, the history keys
  // of the epochs before the core's, the link's counters.
  async _coreGrantedLocally(share, peer) {
    const runtime = this.engine.sessions.get(share.sessionId)
    if (!runtime) return
    const store = runtime.store
    // A refusal ZBTerm's records make that no gate caught (a device of the
    // host's account revoked after the link was made): the peer leaves at
    // once, with a rotation. Read before `putMember` writes the member.
    if (await this._isRevoked(runtime, peer.identityKeyHex, peer.deviceKeyHex)) {
      this._debug('host:join-revoked-late', { sessionId: share.sessionId, linkId: peer.linkId })
      await share.core
        .request('share.revoke', { sessionId: share.sessionId, identityKey: peer.identityKeyHex })
        .catch(() => {})
      return
    }
    await store.putMember(peer.identityKeyHex, {
      deviceKeyHex: peer.deviceKeyHex,
      caps: peer.caps,
      linkId: peer.linkId,
      deviceName: peer.deviceName
    })
    await store.sealHistoryForMember(peer.deviceKeyHex, peer.caps, {
      upTo: share.firstEpoch - 1
    })
    const link = share.links.get(peer.linkId)
    if (link) {
      const next = {
        ...link,
        viewers: (link.viewers || 0) + 1,
        consumed: link.type === 'single' ? true : link.consumed
      }
      await store.meta.put(`link/${link.linkId}`, next)
      share.links.set(link.linkId, next)
    }
    await this._coreSyncHistoryToPeer(share, peer, runtime)
    // Not awaited: it waits for the epoch this join minted, which this queue
    // applies after the current item.
    this._coreSendHistoryInfo(share, peer, runtime).catch((err) =>
      this._debug('host:history:info-failed', { sessionId: share.sessionId, message: err.message })
    )
  }

  // What a viewer needs to read the core's history and is not in `Confirm`:
  // the key the host's head is signed with, and its envelope of every epoch
  // so far (the host's meta core used to carry them to the viewer's replica).
  // It rides the core's `timeline` message, which the core seals and delivers
  // like any other; the viewer takes the `history` field out before it reads
  // the timeline (`_coreViewerLive`).
  async _coreSendHistoryInfo(share, peer, runtime) {
    if (!share.history || !share.history.verifyingKey) return
    if (!hasCap(peer.caps, READ_HISTORY) || !hasCap(peer.caps, VIEW_LIVE)) return
    await this._coreSettled(share)
    if (this._closed || !share.peers.has(peer)) return
    const store = runtime.store
    const envelopes = {}
    for (let epoch = 1; epoch <= store.epoch; epoch++) {
      try {
        const node = await store.meta.get(`env/${epoch}/${peer.deviceKeyHex}`)
        if (node && typeof node.value === 'string') envelopes[epoch] = node.value
      } catch {
        // An epoch with no envelope for this device is one it cannot read.
      }
    }
    await this._coreSend(share, 'share.timeline', {
      sessionId: share.sessionId,
      joinId: peer.joinId,
      data: b64(
        Buffer.from(
          JSON.stringify({
            items: [],
            length: store.log.length,
            history: { verifyingKey: share.history.verifyingKey, envelopes }
          })
        )
      )
    })
  }

  async _coreSyncHistoryToPeer(share, peer, runtime) {
    if (!hasCap(peer.caps, READ_HISTORY) || !hasCap(peer.caps, VIEW_LIVE)) return
    const gone = () => this._closed || !share.peers.has(peer)
    const timeline =
      runtime.store && Array.isArray(runtime.store.timeline) ? runtime.store.timeline : []
    if (timeline.length) {
      this._debug('host:timeline-sync:start', {
        sessionId: share.sessionId,
        linkId: peer.linkId,
        count: timeline.length
      })
      let sent = 0
      for (let i = 0; i < timeline.length; i += TIMELINE_SYNC_CHUNK) {
        if (gone()) break
        const items = timeline.slice(i, i + TIMELINE_SYNC_CHUNK)
        const end = i + items.length
        await this._coreSend(share, 'share.timeline', {
          sessionId: share.sessionId,
          joinId: peer.joinId,
          data: b64(
            Buffer.from(
              JSON.stringify({
                items,
                length: runtime.store.log.length,
                more: end < timeline.length
              })
            )
          )
        })
        sent += items.length
        await delay(0)
      }
      this._debug('host:timeline-sync:end', {
        sessionId: share.sessionId,
        linkId: peer.linkId,
        sent
      })
    }
    const allSnapshots =
      runtime.snapshot && runtime.snapshot.index && Array.isArray(runtime.snapshot.index.snapshots)
        ? runtime.snapshot.index.snapshots.slice()
        : []
    const snapshots = selectSnapshotSyncItems(allSnapshots, SNAPSHOT_SYNC_MAX)
    if (!snapshots.length) return
    this._debug('host:snapshot-sync:start', {
      sessionId: share.sessionId,
      linkId: peer.linkId,
      count: snapshots.length,
      total: allSnapshots.length
    })
    let sent = 0
    for (const item of snapshots) {
      if (gone()) break
      const frame = await runtime.snapshot.read(item.seq)
      await this._coreSend(share, 'share.snapshot', {
        sessionId: share.sessionId,
        joinId: peer.joinId,
        data: b64(Buffer.from(JSON.stringify(frame)))
      })
      sent++
      if (sent % SNAPSHOT_SYNC_YIELD_EVERY === 0) await delay(0)
    }
    this._debug('host:snapshot-sync:end', { sessionId: share.sessionId, linkId: peer.linkId, sent })
  }

  _onCorePeerLeft(data) {
    const share = this.hostShares.get(data.sessionId)
    if (!share || !share.core) return
    const peer = share.peersByJoin.get(data.joinId)
    if (peer) this._dropCorePeer(share, peer)
  }

  // A confirmed peer is gone (`_cleanupHostPeer`); the core has already
  // turned input back to the host's when the last one left, and says so in
  // its own `host:input:disabled` debug event.
  _dropCorePeer(share, peer) {
    if (!share.peers.delete(peer)) return
    share.peersByJoin.delete(peer.joinId)
    if (share.peers.size === 0) {
      const runtime = this.engine.sessions && this.engine.sessions.get(share.sessionId)
      if (runtime && runtime.inputMode === 'all') runtime.inputMode = 'host'
    }
    this.emit('share:changed', this.status(share.sessionId))
  }

  async _onCoreBootstrapNeeded(data) {
    const share = this.hostShares.get(data.sessionId)
    if (!share || !share.core) return
    try {
      const options =
        Number.isFinite(data.scrollback) || Number.isFinite(data.tailBytes)
          ? { scrollback: data.scrollback, tailBytes: data.tailBytes }
          : undefined
      const bootstrap = await this.engine.buildLiveBootstrap(data.sessionId, options)
      await share.out.send('share.bootstrap', {
        sessionId: data.sessionId,
        requestId: data.requestId,
        data: b64(Buffer.from(JSON.stringify(bootstrap)))
      })
      this._debug('host:bootstrap:sent', {
        sessionId: data.sessionId,
        requestId: data.requestId,
        seq: bootstrap.seq,
        cols: bootstrap.cols,
        rows: bootstrap.rows,
        bytes: bootstrap.data ? bootstrap.data.length : 0
      })
    } catch (err) {
      if (this._closed || !this.engine.sessions.has(data.sessionId)) return
      this.emit('error', EngineError.from(err))
    }
  }

  _onCoreInput(data) {
    const share = this.hostShares.get(data.sessionId)
    const runtime = this.engine.sessions.get(data.sessionId)
    if (!share || !share.core || !runtime || !runtime.pty) return
    runtime.pty.write(unb64(data.data).toString('utf8'))
  }

  _onCoreInputRefused(data) {
    const share = this.hostShares.get(data.sessionId)
    if (!share || !share.core) return
    this.emit('error', new EngineError(data.code || CODES.E_AUTH, data.message))
  }

  async _coreRevokeLink(share, runtime, linkId, next) {
    share.links.set(linkId, next)
    await share.core.request('share.revokeLink', { sessionId: share.sessionId, linkId })
    for (const peer of Array.from(share.peers)) {
      if (peer.linkId === linkId) this._dropCorePeer(share, peer)
    }
    // Anyone who joined through this link loses standing access in the store
    // too; the core has revoked them and rotated.
    if (runtime.store.listActiveMembers) {
      const members = await runtime.store.listActiveMembers()
      for (const member of members.filter((item) => item.linkId === linkId)) {
        await runtime.store.setMemberStatus(member.identityKeyHex, 'revoked')
      }
    }
    await this._coreSettled(share)
    this.emit('share:changed', this.status(share.sessionId))
    return true
  }

  async _coreRevokeMember(share, runtime, identityKeyHex) {
    const { revoked } = await share.core.request('share.revoke', {
      sessionId: share.sessionId,
      identityKey: identityKeyHex
    })
    // The store's record decides for a member the core does not know (one
    // that joined in an earlier run): it is marked revoked, so no later join
    // is granted, but there is no live peer to rotate for.
    const member = await runtime.store.getMember(identityKeyHex)
    const stored = !!member && member.status === 'active'
    if (stored) await runtime.store.setMemberStatus(identityKeyHex, 'revoked')
    if (!revoked && !stored) return false
    for (const peer of Array.from(share.peers)) {
      if (peer.identityKeyHex === identityKeyHex) this._dropCorePeer(share, peer)
    }
    await this._coreSettled(share)
    this.emit('share:changed', this.status(share.sessionId))
    return true
  }

  // Identity outcomes of both roles (`share:peer-identity`).
  _onCorePeerIdentity(data) {
    const known =
      data.direction === 'viewer'
        ? this.hostShares.get(data.sessionId)
        : this._coreJoins.get(data.joinId)
    if (!known) {
      if (data.direction === 'host' && this._joinsInFlight > 0) {
        this._earlyCoreEvents.push(['peerIdentity', data])
      }
      return
    }
    const displayId =
      data.displayId || displayIdFor(UNKNOWN, data.identityKey ? String(data.identityKey) : '')
    if (data.direction === 'viewer') {
      // One entry per join until it is granted; a refused join's stays, so
      // the oldest go when they pile up.
      if (known.identities.size >= 256) {
        known.identities.delete(known.identities.keys().next().value)
      }
      known.identities.set(data.joinId, { status: data.status, displayId })
    }
    this._emitPeerIdentity({
      sessionId: data.sessionId === undefined ? null : data.sessionId,
      direction: data.direction,
      identityKey: data.identityKey === undefined ? null : data.identityKey,
      deviceKey: data.deviceKey === undefined ? null : data.deviceKey,
      displayId,
      provider: data.provider,
      status: data.status,
      reason: data.reason === undefined ? null : data.reason
    })
  }

  _onCoreError(data) {
    this.emit('error', new EngineError(data.code || CODES.E_INTERNAL, data.message))
  }

  // The sidecar went away with everything it held.
  _onCoreExit(info) {
    for (const share of this.hostShares.values()) {
      if (!share.core) continue
      for (const peer of Array.from(share.peers)) this._dropCorePeer(share, peer)
      share.pendingApprovals.clear()
    }
    for (const state of Array.from(this.joins.values())) {
      if (!state.viaCore || state.done) continue
      if (state.confirmed && state.sessionId) {
        this.engine.markRemoteOffline(state.sessionId).catch(() => {})
        this._settleJoin(state)
      } else {
        state.finish({
          status: 'failed',
          code: CODES.E_BACKEND_UNAVAILABLE,
          reason: JOIN_REASONS.CLOSED,
          message: `The share backend's core exited (code=${info && info.code})`
        })
      }
    }
  }

  // --- viewer ---

  // `share.join`: the core dials the route (pinning the host key), opens the
  // session channels and runs the join. A route it refuses (a link made before
  // the session protocol v2) answers the request itself, offline.
  async _coreJoin(state) {
    const { invite, backend } = state
    this._joinsInFlight++
    try {
      const bridge = this._listenCore(await backend.sessionCore())
      if (state.done) return
      state.core = bridge
      state.input = new OrderedRequests((method, args) => bridge.request(method, args))
      const { joinId } = await bridge.request('share.join', {
        route: invite.route,
        expectedPeerKey: hex(state.hostDhtKey),
        linkId: invite.linkId,
        local: this._coreLocal()
      })
      if (state.done) {
        bridge.request('share.leave', { joinId }).catch(() => {})
        return
      }
      state.coreJoinId = joinId
      this._coreJoins.set(joinId, state)
      const early = this._earlyCoreEvents.splice(0)
      for (const [name, data] of early) {
        if (data.joinId === joinId) {
          if (name === 'joinChanged') this._onCoreJoinChanged(data)
          else this._onCorePeerIdentity(data)
        } else {
          this._earlyCoreEvents.push([name, data])
        }
      }
    } catch (err) {
      if (state.done) return
      const details = (err && err.details) || {}
      this._debug('viewer:dial-failed', {
        linkId: invite.linkId,
        code: err && err.code,
        detail: details.detail || null
      })
      state.finish({
        status: 'failed',
        code: (err && err.code) || CODES.E_INTERNAL,
        reason: JOIN_REASONS.UNREACHABLE,
        detail: details.detail || null,
        backend: details.backend || null,
        message: (err && err.message) || 'Share failed'
      })
    } finally {
      this._joinsInFlight--
      if (this._joinsInFlight === 0) this._earlyCoreEvents.length = 0
    }
  }

  _leaveCoreJoin(state) {
    if (state.coreJoinId) {
      this._coreJoins.delete(state.coreJoinId)
      if (state.core) {
        state.core.request('share.leave', { joinId: state.coreJoinId }).catch(() => {})
      }
    }
    if (state.sessionId && this._coreJoinsBySession.get(state.sessionId) === state) {
      this._coreJoinsBySession.delete(state.sessionId)
    }
  }

  // Runs `fn` for the join a viewer event names, after every earlier event
  // of that join (`state.messageQueue`: a frame under a new epoch is never
  // applied before the rekey that keys it).
  _onCoreViewerEvent(data, fn) {
    const state = this._coreJoinsBySession.get(data.sessionId)
    if (!state) return
    this._queueViewer(state, () => fn(state))
  }

  _queueViewer(state, fn) {
    state.messageQueue = (state.messageQueue || Promise.resolve())
      .then(fn)
      .catch((err) => this.emit('error', EngineError.from(err)))
  }

  _onCoreJoinChanged(data) {
    const state = this._coreJoins.get(data.joinId)
    if (!state) {
      if (this._joinsInFlight > 0) this._earlyCoreEvents.push(['joinChanged', data])
      return
    }
    if (data.status === 'confirmed' && data.confirm) {
      this._coreJoinsBySession.set(data.confirm.sessionId, state)
    }
    this._queueViewer(state, () => this._coreViewerJoinChanged(state, data))
  }

  async _coreViewerJoinChanged(state, data) {
    // A join that ended before it was confirmed has nothing to apply frames
    // to; dropping what is still in flight is the whole handling.
    if (state.done && !state.confirmed) return
    const linkId = state.invite.linkId
    switch (data.status) {
      case 'approval-pending':
        state.connected = true
        this.emit('join:changed', { status: 'approval-pending', linkId })
        return
      case 'confirmed':
        state.connected = true
        try {
          await this._coreRegisterViewer(state, data.confirm)
        } catch (err) {
          this._debug('viewer:register-remote-error', {
            linkId,
            sessionId: data.confirm.sessionId,
            message: err.message
          })
          state.finish({
            status: 'failed',
            code: (err && err.code) || CODES.E_INTERNAL,
            message: (err && err.message) || 'Failed to set up the shared session locally'
          })
        }
        return
      case 'joined':
        state.joined = true
        this.emit('join:changed', { status: 'joined', linkId, sessionId: state.sessionId })
        return
      case 'syncing':
        this.emit('join:changed', { status: 'syncing', linkId, sessionId: state.sessionId })
        return
      case 'failed':
        state.finish({
          status: 'failed',
          code: data.code || CODES.E_AUTH,
          reason: typeof data.reason === 'string' ? data.reason : null,
          message: data.message || 'Share failed'
        })
        return
      default:
    }
  }

  // `Confirm` applied by the core: the remote session is registered with the
  // engine from what it carried, and the history replicates on the
  // connection the core dialed.
  async _coreRegisterViewer(state, confirm) {
    state.confirmed = true
    state.sessionId = confirm.sessionId
    const message = {
      type: 'confirm',
      sessionId: confirm.sessionId,
      info: {
        name: confirm.info.name,
        createdAt: confirm.info.createdAt,
        flags: {
          sensitive: !!confirm.info.sensitive,
          quickCatchupKB: confirm.info.quickCatchupKB || 0
        },
        cols: confirm.info.cols,
        rows: confirm.info.rows
      },
      inputMode: confirm.inputMode,
      logKey: confirm.logKey,
      metaKey: confirm.metaKey,
      hostDeviceKey: confirm.hostDeviceKey,
      envelope: confirm.envelope,
      // The history of a Freenet session is the core's (K17, D-40): the
      // engine keeps a local cache of it, not a replica of the host's log.
      core: true
    }
    const remote = await this.engine.registerRemoteSession(message)
    remote.message = {
      viaCore: true,
      send: (frame) => this._coreViewerInput(state, frame)
    }
    const conn = await this._coreConnection(state)
    state.conn = conn
    // The handle reads the core's history for this session, over the `history`
    // channel while the host's connection is up and from the contract after.
    state.history = state.backend.attachHistory(conn, remote.store, {
      logKey: confirm.logKey,
      metaKey: confirm.metaKey
    })
    state.downloads.push(state.history)
    remote.history = state.history
  }

  // The connection the core dialed to the host: its event reaches this
  // process on its own path, so it can be a moment behind the join's.
  async _coreConnection(state) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const conn = state.backend.connectionTo(state.hostDhtKey, { initiator: true })
      if (conn) {
        // Sessions of this device's own are served on it as on any other.
        if (!this._hostHandled.has(conn)) {
          this._hostHandled.add(conn)
          this._connBackends.set(conn, state.backend)
          this._handleHostConnection(conn, { client: true })
        }
        return conn
      }
      await delay(50)
    }
    throw new EngineError(CODES.E_HOST_UNREACHABLE, 'The connection to the share host is gone', {
      backend: this._backendIdOf(state.backend)
    })
  }

  _coreViewerInput(state, frame) {
    const sessionId = state.sessionId
    const remote = this.engine.remoteSessions.get(sessionId)
    if (!remote || !state.core) return false
    const bytes = Buffer.from(frame.data)
    state.input.send('share.input', { sessionId, data: b64(bytes) }).then(
      ({ inputCtr }) => {
        remote.inputCtr = inputCtr
        this._debug('viewer:input:sealed', {
          sessionId,
          inputCtr,
          inputMode: remote.inputMode || 'host',
          bytes: bytes.byteLength
        })
      },
      (err) => this.emit('error', EngineError.from(err))
    )
    return true
  }

  _coreViewerOutput(state, data) {
    this.engine.applyRemoteData(state.sessionId, unb64(data.data), { hd: !!data.hd })
  }

  async _coreViewerLive(state, data) {
    const document = JSON.parse(unb64(data.data).toString('utf8'))
    if (data.kind === 'timeline' && document.history) {
      // What the host says of its history (`_coreSendHistoryInfo`).
      const remote = this.engine.remoteSessions.get(state.sessionId)
      if (remote && remote.store && typeof remote.store.applyHistoryInfo === 'function') {
        await remote.store.applyHistoryInfo(document.history)
      }
      if (!Array.isArray(document.items) || !document.items.length) return
    }
    if (data.kind === 'bootstrap') {
      await this.engine.applyRemoteBootstrap(state.sessionId, document)
    } else if (data.kind === 'snapshot') {
      await this.engine.applyRemoteSnapshot(state.sessionId, document)
    } else if (data.kind === 'timeline') {
      await this.engine.applyRemoteTimeline(state.sessionId, document)
    }
  }

  async _coreViewerRekey(state, data) {
    const remote = this.engine.remoteSessions.get(state.sessionId)
    if (remote) await remote.store.applyEpochEnvelope(data.epoch, data.envelope)
  }

  _coreViewerEnd(state, data) {
    this.engine.markRemoteOffline(state.sessionId, data.exit).catch(() => {})
    this._settleJoin(state)
  }

  async _coreViewerInfo(state, data) {
    const info = {}
    if (data.name !== null && data.name !== undefined) info.name = data.name
    if (data.inputMode) info.inputMode = data.inputMode
    await this.engine.applyRemoteInfo(state.sessionId, info)
  }

  _coreViewerOffline(state) {
    if (!state.confirmed || !state.sessionId) return
    this.engine.markRemoteOffline(state.sessionId).catch(() => {})
    this._settleJoin(state)
  }

  // The seam bridge a joined Freenet session's history is read through when
  // nothing connects this run to its host (engine/index.js::
  // _catchUpJoinedCore): the Freenet backend's, started here if it is not
  // running yet. Null when this build has no Freenet backend.
  async coreHistoryBridge() {
    if (this._closed) return null
    let backend = null
    for (const entry of this._backends.values()) {
      if (typeof entry.backend.sessionCore === 'function') backend = entry.backend
    }
    if (!backend && this._injected) backend = this._injected
    if (!backend) {
      try {
        backend = await this._ensureBackend('freenet')
      } catch {
        return null
      }
    }
    if (!backend || typeof backend.sessionCore !== 'function') return null
    const core = await backend.sessionCore()
    return core ? this._listenCore(core) : null
  }

  _debug(event, details = {}) {
    this.emit('debug', {
      ts: Date.now(),
      event,
      details
    })
  }
}

function currentLinkViewers(share, linkId) {
  let count = 0
  for (const peer of share.peers) {
    if (peer.confirmed && peer.linkId === linkId) count++
  }
  return count
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hex(value) {
  if (!value) return null
  return b4a.toString(value, 'hex')
}

module.exports = ShareManager
// The engine reads an invite's identity out of a pasted URI before any
// connection exists, so link decoding lives in exactly one place
// (engine/invite.js); the names are re-exported here for existing callers.
module.exports.LINK_PREFIX = LINK_PREFIX
module.exports.encodeLink = encodeLink
module.exports.decodeLink = decodeLink
module.exports.JOIN_REASONS = JOIN_REASONS
module.exports._test = {
  selectSnapshotSyncItems,
  SNAPSHOT_SYNC_MAX,
  LAG_RESYNC_MS,
  LAG_RESYNC_MAX_MS
}

function selectSnapshotSyncItems(snapshots, max = SNAPSHOT_SYNC_MAX) {
  const items = Array.isArray(snapshots)
    ? snapshots
        .filter((item) => item && Number.isFinite(item.seq))
        .slice()
        .sort((a, b) => a.seq - b.seq)
    : []
  if (items.length <= max) return items
  if (max <= 1) return [items[items.length - 1]]

  const selected = new Map()
  const last = items.length - 1
  for (let i = 0; i < max - 1; i++) {
    const index = Math.floor((i * last) / (max - 1))
    selected.set(items[index].seq, items[index])
  }
  selected.set(items[last].seq, items[last])
  return Array.from(selected.values()).sort((a, b) => a.seq - b.seq)
}
