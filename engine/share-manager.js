const { EventEmitter } = require('events')
const crypto = require('crypto')
const b4a = require('b4a')

const { VERSION } = require('./schema')
const {
  decryptPacket,
  encryptPacket,
  openSealedBytes,
  sealBytes,
  verifyDeviceIdentity
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
const { randomHex, signChallenge } = require('./identity/claim')
const { UNKNOWN, displayIdFor } = require('./identity/providers')
const { verifyPeerIdentity, IDENTITY_TIMEOUT_MS } = require('./identity/verify')

const { LINK_PREFIX, encodeLink, decodeLink } = require('./invite')
const backendRegistry = require('./backends')
const { CAP, assertBackend } = require('./backends/types')
// The peer-to-peer channel id exchanged with every remote build. Both sides
// must agree on it, so changing it breaks compatibility with any build that
// shipped a different value.
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
    // (the host's --backend / ZBTERM_BACKEND) narrows that set, and only one
    // backend is active at a time.
    this._registry = opts.registry || backendRegistry
    this._backendLimit = opts.limit === undefined || opts.limit === null ? '' : String(opts.limit)
    // What the host process offers (`opts.hostCaps`, '' for nothing: the
    // worker's 5th spawn argument) and, when it offers `rtc`, the proxy to its
    // WebRTC adapter (`opts.rtcHost`), handed to every backend the registry
    // creates. A backend that needs the adapter reports itself broken without
    // it (engine/backends/index.js::load).
    this._hostCaps =
      opts.hostCaps === undefined || opts.hostCaps === null ? '' : String(opts.hostCaps)
    this._rtcHost = opts.rtcHost || null
    // Constructor options for every backend the registry creates, also handed
    // to a backend's probe (`share.backends`): tests name a node address here
    // (`{ nodeUrl }`), the product passes none. The ICE servers the host sends
    // (setIceServers) join them once known.
    this._backendOptions = { ...opts.backendOptions }
    this._iceServers = null
    this._backend = null
    this._backendId = null
    this._backendListeners = null
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
    const { id } = backend.describe()
    return id
  }

  _defaultBackendId() {
    if (this._injected) return this._backendIdOf(this._injected)
    return this._registry.resolve(this._selection()).default
  }

  // What the registry selects from: the host's limit and its capabilities.
  _selection() {
    return { limit: this._backendLimit, hostCaps: this._hostCaps }
  }

  _busy() {
    return this.hostShares.size > 0 || this.joins.size > 0
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

  // The synchronous part of _ensureBackend: returns the backend for `id` when
  // it is already active or can be activated without stopping another one,
  // and null when a swap is needed. Throws like _ensureBackend.
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
    if (this._backend && this._backendId === wanted) return this._backend
    this._assertBackendUsable(wanted)
    if (this._backend) {
      if (this._busy()) {
        throw new EngineError(
          CODES.E_BACKEND_UNAVAILABLE,
          `The '${this._backendId}' share backend is in use; restart ZBTerm to share or join over '${wanted}'`,
          { backend: wanted, active: this._backendId }
        )
      }
      return null
    }
    this._attachBackend(
      this._registry.create(wanted, {
        ...this._selection(),
        options: {
          rtcHost: this._rtcHost,
          ...this._backendOptions,
          ...(this._iceServers ? { iceServers: this._iceServers } : {})
        }
      }),
      wanted
    )
    return this._backend
  }

  // One backend is active per run (R-6). `id` empty means the default. A
  // different id while shares or joins exist raises E_BACKEND_UNAVAILABLE;
  // with none, the old backend is stopped and the new one started.
  async _ensureBackend(id) {
    for (;;) {
      const ready = this._backendNow(id)
      if (ready) return ready
      await this._detachBackend()
    }
  }

  _attachBackend(backend, id) {
    const listeners = {
      connection: (conn, info) => {
        try {
          this._handleConnection(conn, info)
        } catch (err) {
          this.emit('error', EngineError.from(err))
        }
      },
      error: (err) => this.emit('error', EngineError.from(err)),
      debug: ({ event, details }) => this._debug(event, details)
    }
    this._backend = backend
    this._backendId = id || this._backendIdOf(backend)
    this._backendListeners = listeners
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
  }

  async _detachBackend() {
    const backend = this._backend
    if (!backend) return
    const listeners = this._backendListeners || {}
    this._backend = null
    this._backendId = null
    this._backendListeners = null
    for (const [name, fn] of Object.entries(listeners)) backend.off(name, fn)
    await backend.stop()
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
        limitedBy: null
      }
    }
    const resolved = this._registry.resolve(this._selection())
    return {
      backends: resolved.backends,
      default: resolved.default,
      active: this._backendId,
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
    const backend = this._backend
    if (backend && typeof backend.setIceServers === 'function') {
      backend.setIceServers(this._iceServers)
    }
    return { iceServers: this._iceServers }
  }

  async close() {
    this._closed = true
    await this._detachBackend()
    this.hostShares.clear()
    this.joins.clear()
    this._connPeers.clear()
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
    const backend = this._backendNow(opts.backend) || (await this._ensureBackend(opts.backend))
    const runtime = this.engine.sessions.get(sessionId)
    if (!runtime) throw new EngineError(CODES.E_INTERNAL, 'Only live sessions can be shared')
    this._debug('host:create-link:start', { sessionId, type: opts.type, autoJoin: opts.autoJoin })

    let share = this.hostShares.get(sessionId)
    if (!share) {
      share = {
        sessionId,
        peers: new Set(),
        links: new Map(),
        pendingApprovals: new Map(),
        inputCounters: new Map(),
        liveSeq: 0,
        // Cursor into runtime.store.timeline: how much of it has already been
        // pushed to confirmed peers via broadcastTimeline. Starts at the
        // current length so a share created mid-session doesn't immediately
        // resend the whole backlog that _syncTimelineToPeer already handles
        // per-peer at grant time - this only ever covers what's appended
        // *after* the share exists.
        timelineSyncedCount: runtime.store.timeline.length
      }
      this.hostShares.set(sessionId, share)
    }

    const linkId = crypto.randomBytes(16).toString('hex')
    this._linkIndex.set(linkId, sessionId)
    const route = backend.routeFor(linkId, null)
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
    await backend.announce(linkId, { route, tag: { sessionId } })

    const uri = this._inviteFor(backend, linkId, route)
    this.emit('share:changed', this.status(sessionId))
    return { ...link, uri }
  }

  async listLinks(sessionId) {
    const runtime = this.engine.sessions.get(sessionId)
    if (!runtime) return []
    const backend = this.backend
    const out = []
    for await (const node of runtime.store.meta.createReadStream({ gt: 'link/', lt: 'link0' })) {
      out.push({
        ...node.value,
        // Without a usable backend there is nothing to dial, so no URI.
        uri: backend
          ? this._inviteFor(
              backend,
              node.value.linkId,
              backend.routeFor(node.value.linkId, node.value)
            )
          : null
      })
    }
    return out
  }

  // The invite for one link. invite.js decides the wire shape from `b`: Pear
  // links keep the v1 fields, every other backend gets the v2 shape.
  _inviteFor(backend, linkId, route) {
    return encodeLink({
      v: VERSION,
      b: this._backendId || this._backendIdOf(backend),
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
    // `_backend`: revoking never activates a backend.
    const backend = this._backend
    if (backend) {
      try {
        await backend.withdraw(linkId)
      } catch (err) {
        this._debug('host:withdraw:error', { sessionId, linkId, message: err && err.message })
      }
    }
    const share = this.hostShares.get(sessionId)
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
    const backend = this._backendNow(invite.b) || (await this._ensureBackend(invite.b))
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
    state.settle = () => {
      if (state.done) return
      state.done = true
      if (state.timer) clearTimeout(state.timer)
      this.joins.delete(key)
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
    for (const peer of share.peers) {
      if (!peer.confirmed || !peer.message) continue
      peer.message.send({ type: 'end', sessionId, exit: exit || null })
    }
    this.emit('share:changed', this.status(sessionId))
  }

  broadcastInfo(sessionId, info = {}) {
    const share = this.hostShares.get(sessionId)
    if (!share) return
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
    await this._grantJoin(share, pending.peer, pending.runtime, pending.link, pending.request)
    return true
  }

  denyJoin(sessionId, requestId) {
    const share = this.hostShares.get(sessionId)
    if (!share) throw new EngineError(CODES.E_AUTH, 'No active share for this session')
    const pending = share.pendingApprovals.get(requestId)
    if (!pending) throw new EngineError(CODES.E_AUTH, 'Approval request is no longer pending')
    share.pendingApprovals.delete(requestId)
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
      backend: active ? { ...network, id: this._backendId, health: active.health() } : null
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
    this.backend.serveHistory(conn, runtime.store)

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
    if (!verifyDeviceIdentity(request.identityProof, identityKeyHex, deviceKeyHex)) {
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
    const challengeId = randomHex(16)
    const nonce = randomHex(32)
    const challenge = {
      sessionId: sessionId || '',
      challengeId,
      nonce,
      verifierDhtKey: hex(this.backend.localPeerKey()),
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

  // Prover half: sign the peer's challenge with this device's auth key. The
  // signed bytes mirror the verifier's view (their DHT key is the verifier,
  // ours is the prover).
  _answerIdentityChallenge(send, conn, message) {
    const secretKey = this.engine.localDevice && this.engine.localDevice.authSecretKey
    if (!secretKey || !send) return
    const signature = signChallenge(secretKey, {
      sessionId: message.sessionId || '',
      challengeId: message.challengeId,
      nonce: message.nonce,
      verifierDhtKey: hex(conn && conn.remotePeerKey),
      proverDhtKey: hex(this.backend.localPeerKey()),
      role: message.role
    })
    send.send({
      type: 'identity-response',
      challengeId: message.challengeId,
      signature: b4a.toString(signature, 'hex')
    })
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
        store: this.engine.identityStore
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
      store: this.engine.identityStore
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
      store: this.engine.identityStore
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
    if (!verifyDeviceIdentity(input.identityProof, input.identityKey, input.deviceKey)) {
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
    state.history = this.backend.attachHistory(state.conn, remote.store, {
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
