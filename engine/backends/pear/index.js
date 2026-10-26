// The Pear/Holepunch share backend (backend-abstraction R-3): everything that
// names hyperswarm, hyperdht or protomux lives under this directory. The code
// here was moved out of engine/share-manager.js, not rewritten - wire behaviour
// is byte-identical, so this build interoperates with released builds in both
// roles.
const { EventEmitter } = require('events')
const crypto = require('crypto')
const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')
const b4a = require('b4a')

const { CAP } = require('../types')
const PearConnection = require('./connection')

// Fallback used when direct connect + hole-punch fails (eg. two peers behind
// the same NAT). Discovered via a DHT mutable record (see relay/server.js
// and relay/registry-publish.js) so users never have to configure this
// themselves - REGISTRY_PUBLIC_KEY is a fixed lookup address, not a secret.
// ZBTERM_RELAY_PUBLIC_KEY remains as an escape hatch for anyone running their
// own relay+registry instead of the default one.
const REGISTRY_PUBLIC_KEY = b4a.from(
  '9fa15b9590a55c63d14069c27d8e8cbc12bd0a0ec0f76e5a79f1c8c57f1e283b',
  'hex'
)
const REGISTRY_REFRESH_MS = 15 * 60 * 1000

// How long a viewer waits on a pure direct/hole-punch attempt before also
// racing a relayed connection in parallel. hyperdht connects over a relay
// and a direct hole-punch concurrently once relaying is offered, and
// transparently swaps the live connection over to the direct path if the
// punch succeeds later (see hyperdht/lib/connect.js: onsocket/changeRemote) -
// so enabling the relay does not give up on punching, it just stops waiting
// on it alone.
const RELAY_FALLBACK_MS_ENV = process.env.ZBTERM_RELAY_FALLBACK_MS
const RELAY_FALLBACK_MS = RELAY_FALLBACK_MS_ENV ? Number(RELAY_FALLBACK_MS_ENV) : 5000

const CAPABILITIES =
  CAP.AUTHENTICATED_PEER |
  CAP.MULTIPLEXED_STREAMS |
  CAP.ORDERED_STREAM |
  CAP.EPHEMERAL_DELIVERY |
  CAP.DIRECT_DIAL |
  CAP.NAT_TRAVERSAL |
  CAP.RELAY |
  CAP.PATH_MIGRATION |
  CAP.HISTORY_SPARSE_READ |
  CAP.HISTORY_HEAD_WATCH

class PearBackend extends EventEmitter {
  constructor() {
    super()
    this._ctx = null
    this._started = false
    // One Hyperswarm for every hosted session and every join, created lazily
    // on the first announce/dial. Hyperswarm dedupes to one socket per remote
    // keypair, so a viewer joining two sessions on this host arrives on one
    // socket - and therefore on one PearConnection.
    this._swarm = null
    // socket -> PearConnection. Weak, so a closed socket drops its wrapper.
    this._conns = new WeakMap()
    // Active dials, in start order. Backs connection routing by remote key
    // and the relay fallback window.
    this._dials = new Set()
    // linkId -> topic buffer, for withdraw.
    this._announced = new Map()
    // Inbound admission policy, set by the share manager (accept iff hosting
    // anything). A key pinned by an active dial is always admitted.
    this._admission = () => false
    // hostKeyHex -> refcount. Populated by _pinHost/_unpinHost, called from
    // dial() (before dialing - see the ordering note there) and the dial's
    // cancel() respectively. Backs both the union firewall (Phase 3 "Pinning",
    // defense in depth - the app-layer check in the share manager's
    // _handleViewerConnection is primary) and swarm.leavePeer bookkeeping, so
    // two concurrent joins to the same host don't unpin/leavePeer each
    // other's connection early.
    this._pinnedHostKeys = new Map()
    const relayPublicKeyEnv = process.env.ZBTERM_RELAY_PUBLIC_KEY
    this._relayPublicKey = relayPublicKeyEnv ? b4a.from(relayPublicKeyEnv, 'hex') : null
    this._registryDht = null
    this._registryTimer = null
  }

  describe() {
    return {
      id: 'pear',
      label: 'Pear (Holepunch)',
      interfaceVersion: 1,
      capabilities: CAPABILITIES
    }
  }

  // Opens no share socket: the swarm is created lazily by announce/dial. The
  // relay registry lookup (one DHT mutable get, unless a relay key was given
  // by env) does start here, exactly as it did in the ShareManager
  // constructor.
  start(ctx) {
    if (this._started) return Promise.resolve()
    this._started = true
    this._ctx = ctx || {}
    if (!this._relayPublicKey) this._startRelayRegistryLookup()
    return Promise.resolve()
  }

  async stop() {
    this._started = false
    const swarm = this._swarm
    this._swarm = null
    // Joins no longer own a swarm to destroy (Phase 3: joins share this one
    // swarm with hosting) - the single shared swarm is the only one to tear
    // down.
    await destroySwarm(swarm)
    this._dials.clear()
    this._announced.clear()
    this._pinnedHostKeys.clear()
    if (this._registryTimer) clearInterval(this._registryTimer)
    this._registryTimer = null
    const registryDht = this._registryDht
    this._registryDht = null
    if (registryDht) await registryDht.destroy().catch(() => {})
  }

  health() {
    return {
      started: this._started,
      listening: !!(this._swarm && this._swarm.listening),
      detail: null
    }
  }

  localPeerKey() {
    const keyPair = this._keyPair()
    return (keyPair && keyPair.publicKey) || null
  }

  _keyPair() {
    return (this._ctx && this._ctx.keyPair && this._ctx.keyPair()) || null
  }

  setAdmission(policy) {
    this._admission = typeof policy === 'function' ? policy : () => !!policy
  }

  // A Pear route is the announced swarm topic. A stored link record already
  // carries it as `topic`; with nothing stored a fresh random topic is minted.
  routeFor(linkId, stored) {
    if (stored && stored.route && stored.route.topic) return { topic: stored.route.topic }
    if (stored && stored.topic) return { topic: stored.topic }
    return { topic: crypto.randomBytes(32).toString('hex') }
  }

  async announce(linkId, opts = {}) {
    const route = opts.route || this.routeFor(linkId, null)
    const topic = b4a.from(route.topic, 'hex')
    const swarm = this._ensureSwarm()
    this._announced.set(linkId, topic)
    this._debug('host:swarm:join-topic', { ...opts.tag, linkId, topic: route.topic })
    // Host announces only; viewers dial via topic lookup and/or joinPeer(hostDhtKey).
    swarm.join(topic, { server: true, client: false })
    await swarm.flush()
    this._debug('host:swarm:flushed', {
      ...opts.tag,
      linkId,
      swarm: swarmDiagnostics(swarm)
    })
    return { route, linkId }
  }

  async withdraw(linkId) {
    const topic = this._announced.get(linkId)
    if (!topic) return
    this._announced.delete(linkId)
    if (this._swarm) await this._swarm.leave(topic).catch(() => {})
  }

  // Joins share the one swarm hosting also uses (Phase 3: docs/DESIGN-SWARM-
  // AND-WORKER.md, "Join-side consolidation") - no per-join Hyperswarm, no
  // per-join firewall. Pinning is (1) the app-layer check in the share
  // manager's _handleViewerConnection (primary, exact per-join) and (2) the
  // shared swarm's union firewall (defense in depth, see _ensureSwarm).
  dial(route, expectedPeerKey, opts = {}) {
    const topic = b4a.from(route.topic, 'hex')
    const expectedHex = hex(expectedPeerKey)
    const record = {
      expectedHex,
      startedAt: Date.now(),
      connected: false,
      done: false,
      resolve: null,
      reject: null
    }
    const connected = new Promise((resolve, reject) => {
      record.resolve = resolve
      record.reject = reject
    })
    // A cancelled dial is an expected outcome, not an unhandled rejection.
    connected.catch(() => {})
    this._dials.add(record)

    const cancel = () => {
      if (record.done) return
      record.done = true
      this._dials.delete(record)
      // Leave this dial's topic and unpin its host key (refcounted - see
      // _unpinHost) instead of destroying a swarm this dial does not own.
      if (this._swarm) this._swarm.leave(topic).catch(() => {})
      this._unpinHost(expectedPeerKey)
      if (!record.connected) record.reject(new Error('Dial was cancelled'))
    }
    if (opts.signal) {
      if (opts.signal.aborted) setImmediate(cancel)
      else opts.signal.addEventListener('abort', cancel, { once: true })
    }

    // Ordering, enforced structurally (docs/DESIGN-SWARM-AND-WORKER.md,
    // "Phase 3 -> Pinning" addendum): pin before dialing, in the same
    // synchronous block, so this dial can never end up blocking its own
    // outbound connection to the very host it's trying to reach.
    this._pinHost(expectedPeerKey)
    const swarm = this._ensureSwarm()
    for (const socket of swarm.connections || []) {
      if (socket.remotePublicKey && b4a.equals(socket.remotePublicKey, expectedPeerKey)) {
        record.connected = true
        record.resolve(this._adopt(socket, null))
        break
      }
    }

    this._debug('viewer:swarm:join-topic', { ...opts.tag, topic: route.topic })
    // Viewer is client-only. The expected key is mandatory (decodeLink rejects
    // an invite without one), so this direct dial always happens - topic
    // discovery alone is unreliable across NATs (e.g. host behind libvirt
    // while the VM can still dial out).
    swarm.join(topic, { server: false, client: true })
    this._debug('viewer:swarm:join-peer', { ...opts.tag, hostDhtKey: expectedHex })
    swarm.joinPeer(expectedPeerKey)
    swarm
      .flush()
      .then(() => {
        this._debug('viewer:swarm:flushed', {
          ...opts.tag,
          connected: record.connected,
          swarm: swarmDiagnostics(swarm)
        })
      })
      .catch((err) => {
        this._debug('viewer:swarm:flush-error', {
          ...opts.tag,
          message: err.message,
          swarm: swarmDiagnostics(swarm)
        })
      })

    return { connected, cancel }
  }

  // Idempotent per connection and session: a second link for the same session
  // on the same connection must not call .replicate(mux) twice.
  serveHistory(conn, store) {
    conn._replicate(store)
  }

  attachHistory(conn, store, _keys) {
    conn._replicate(store)
    const downloads = [
      store.log.download({ start: 0, end: -1, linear: true }),
      store.metaCore.download({ start: 0, end: -1, linear: true })
    ]
    return {
      fetch({ start, end }) {
        return store.log.download({ start, end, linear: true })
      },
      close() {
        for (const download of downloads.splice(0)) {
          if (download && typeof download.destroy === 'function') download.destroy()
        }
      }
    }
  }

  // Pear history rides the live connection's private mux, keyed by the
  // Hypercore keys already carried in `confirm`; there is no separate route.
  historyRouteFor(_store) {
    return null
  }

  diagnostics() {
    return {
      id: 'pear',
      announced: this._announced.size,
      relayPublicKey: this._relayPublicKey ? hex(this._relayPublicKey) : null,
      relayFallbackMs: this._relayPublicKey ? RELAY_FALLBACK_MS : null,
      hostSwarm: swarmDiagnostics(this._swarm)
    }
  }

  _startRelayRegistryLookup() {
    this._registryLookup()
    this._registryTimer = setInterval(() => this._registryLookup(), REGISTRY_REFRESH_MS)
  }

  // Prefers the shared swarm's own DHT node once one exists, so the
  // standalone node (below) is only needed in the window before any session
  // has been hosted - checked per tick, not once at startup, since
  // _swarm is always null when the first tick fires.
  _registryLookup() {
    const dht = (this._swarm && this._swarm.dht) || this._ensureRegistryDht()
    return dht
      .mutableGet(REGISTRY_PUBLIC_KEY)
      .then((record) => {
        if (!record || !record.value || record.value.length !== 32) return
        this._relayPublicKey = record.value
        this._debug('relay:registry:resolved', { relayPublicKey: hex(record.value) })
      })
      .catch((err) => {
        this._debug('relay:registry:lookup-error', { message: err.message })
      })
  }

  _ensureRegistryDht() {
    if (!this._registryDht) this._registryDht = new DHT()
    return this._registryDht
  }

  // Increments a host key's pin refcount, called from dial() before that
  // dial's own swarm.join/joinPeer calls - ordering matters here (see
  // docs/DESIGN-SWARM-AND-WORKER.md, "Phase 3 -> Pinning" addendum): a
  // rejecting firewall on hyperswarm@4.17.0/hyperdht@6.32.0 blocks the
  // *outbound* dial too, so a join that pinned its host key after dialing
  // would silently block its own connection to the very host it's trying to
  // reach.
  _pinHost(hostDhtKey) {
    const key = hex(hostDhtKey)
    this._pinnedHostKeys.set(key, (this._pinnedHostKeys.get(key) || 0) + 1)
  }

  // Decrements a host key's pin refcount and, only once it reaches zero (no
  // other active join to the same host still needs it), unpins it from the
  // union firewall and tells the swarm to stop explicitly dialing that peer.
  // Host-role connections never add to this refcount (hosting never calls
  // joinPeer), so this is only ever contended by concurrent joins to the
  // same host.
  _unpinHost(hostDhtKey) {
    const key = hex(hostDhtKey)
    const count = (this._pinnedHostKeys.get(key) || 0) - 1
    if (count <= 0) {
      this._pinnedHostKeys.delete(key)
      if (this._swarm) this._swarm.leavePeer(hostDhtKey)
    } else {
      this._pinnedHostKeys.set(key, count)
    }
  }

  // One relayThrough function for the whole shared swarm (host and join
  // roles alike) - see docs/DESIGN-SWARM-AND-WORKER.md, "Phase 3 -> Relay
  // fallback semantics change". A per-join delayed closure no longer makes
  // sense once joins share one swarm; instead, offer the relay iff forced or
  // any currently active dial has been running longer than the fallback
  // window. Read lazily (a function, not a value) for the same reason Phase
  // 1's host-only relayThrough was - a registry lookup that resolves later
  // still benefits everything hosted/joined afterwards.
  _relayThrough(force, pending = this._dials) {
    if (!this._relayPublicKey) return null
    if (force) return this._relayPublicKey
    const now = Date.now()
    for (const dial of pending) {
      if (!dial.connected && now - dial.startedAt >= RELAY_FALLBACK_MS) return this._relayPublicKey
    }
    return null
  }

  _createSwarm(opts = {}) {
    const keyPair = this._keyPair()
    return new Hyperswarm({
      keyPair: {
        publicKey: keyPair.publicKey,
        secretKey: keyPair.secretKey
      },
      firewall: opts.firewall,
      relayThrough: 'relayThrough' in opts ? opts.relayThrough : this._relayPublicKey
    })
  }

  // Lazily creates the one Hyperswarm shared by hosting and joining alike
  // (Phase 3: docs/DESIGN-SWARM-AND-WORKER.md, "Join-side consolidation").
  // Whichever of announce/dial runs first installs the union firewall and
  // the shared relayThrough - there is exactly one firewall function from
  // here on, never a host-only or join-only one.
  _ensureSwarm() {
    if (this._swarm) return this._swarm
    this._swarm = this._createSwarm({
      // Accept iff the admission policy says so (the share manager admits
      // everyone while it hosts anything, unchanged from today) OR the
      // remote key is a currently-pinned expected host for an active dial.
      // This is defense in depth only - the app-layer pin in the share
      // manager's _handleViewerConnection is the exact, per-join control;
      // this firewall cannot itself distinguish which join a connection is
      // for.
      firewall: (remotePublicKey) =>
        !(this._admission(remotePublicKey) || this._pinnedHostKeys.has(hex(remotePublicKey))),
      relayThrough: (force) => this._relayThrough(force)
    })
    this._swarm.on('connection', (socket, info) => {
      try {
        this._handleConnection(socket, info)
      } catch (err) {
        this.emit('error', err)
      }
    })
    this._swarm.on('update', () => {
      this._debug('host:swarm:update', { swarm: swarmDiagnostics(this._swarm) })
    })
    return this._swarm
  }

  // Generic dispatcher for the shared swarm's one 'connection' event: a peer
  // can simultaneously be our viewer-target (an active dial expects them) and
  // a viewer of ours (they open a host-role channel to us) on the very same
  // socket - see docs/DESIGN-SWARM-AND-WORKER.md, "Phase 3 -> Routing viewer
  // connections on the shared swarm". Both run unconditionally and
  // independently; neither returns early for the other. A dial only ever
  // receives a connection from its expected key.
  _handleConnection(socket, info) {
    const conn = this._adopt(socket, info)
    const remoteKeyHex = hex(socket.remotePublicKey)
    for (const record of this._dials) {
      if (record.connected) continue
      if (record.expectedHex !== remoteKeyHex) continue
      record.connected = true
      record.resolve(conn)
    }
    this.emit('connection', conn, info)
  }

  // The one PearConnection of a socket, created on first sight.
  _adopt(socket, info) {
    if (socket instanceof PearConnection) return socket
    let conn = this._conns.get(socket)
    if (!conn) {
      conn = new PearConnection(socket, info)
      this._conns.set(socket, conn)
    }
    return conn
  }

  _debug(event, details = {}) {
    this.emit('debug', { event, details })
  }
}

function destroySwarm(swarm) {
  return new Promise((resolve) => {
    if (!swarm) return resolve()
    swarm.destroy().then(resolve, resolve)
  })
}

function swarmDiagnostics(swarm) {
  if (!swarm) return null
  const dht = swarm.dht
  const server = swarm.server
  return {
    listening: !!swarm.listening,
    connecting: swarm.connecting,
    connections: swarm.connections ? swarm.connections.size : 0,
    peers: swarm.peers ? swarm.peers.size : 0,
    explicitPeers: swarm.explicitPeers ? swarm.explicitPeers.size : 0,
    dht: dht
      ? {
          online: !!dht.online,
          firewalled: !!dht.firewalled,
          bootstrapped: !!dht.bootstrapped,
          degraded: !!dht.degraded,
          listening: !!dht.listening
        }
      : null,
    relayAddresses:
      server && Array.isArray(server.relayAddresses)
        ? server.relayAddresses.map((address) => ({
            host: address.host,
            port: address.port
          }))
        : [],
    stats: {
      connects: swarm.stats && swarm.stats.connects ? swarm.stats.connects : null,
      dht: dht && dht.stats ? dht.stats : null
    }
  }
}

function hex(value) {
  if (!value) return null
  return b4a.toString(value, 'hex')
}

module.exports = PearBackend
module.exports.PearBackend = PearBackend
module.exports.PearConnection = PearConnection
module.exports.RELAY_FALLBACK_MS = RELAY_FALLBACK_MS
module.exports.REGISTRY_PUBLIC_KEY = REGISTRY_PUBLIC_KEY
module.exports.swarmDiagnostics = swarmDiagnostics
