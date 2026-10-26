// The loopback share backend (backend-abstraction R-11): a second, non-Pear
// implementation of the ShareBackend contract, entirely in-process. It exists
// to prove the contract is not Pear-shaped - the same conformance suite runs
// against it and against Pear - and to give tests a share path with no
// network at all.
//
// Backends meet on a hub, keyed by route id. There is no mux, no socket and no
// connection dedupe: every dial that connects makes a fresh connection, even
// to a host this backend already reaches. A channel is a pair of queues
// drained on the microtask queue; history is Hypercore's own replication
// stream, one per connection, piped to its counterpart on the other side.
const { EventEmitter } = require('events')
const b4a = require('b4a')

const { CAP, PATH } = require('./types')

const CAPABILITIES =
  CAP.AUTHENTICATED_PEER |
  CAP.MULTIPLEXED_STREAMS |
  CAP.ORDERED_STREAM |
  CAP.EPHEMERAL_DELIVERY |
  CAP.DIRECT_DIAL |
  CAP.HISTORY_SPARSE_READ |
  CAP.HISTORY_HEAD_WATCH

// Messages queued towards one side of a channel before `send` starts
// reporting backpressure. Advisory, like a stream's high-water mark: a message
// sent past it is still delivered.
const CHANNEL_HIGH_WATER = 1024

// The rendezvous point of a set of loopback backends. Backends that share a
// hub can reach each other; backends on different hubs cannot.
class LoopbackHub {
  constructor() {
    // route id -> Set<LoopbackBackend> announcing it.
    this.routes = new Map()
    // Dials that have not connected yet, in start order. Re-tried whenever a
    // route is announced, so a dial started before its host announces still
    // connects - as a Pear dial would through topic discovery.
    this.pending = new Set()
    // D-16: every backend that has announced anything and has not stopped.
    // Like a Pear host, whose swarm keeps listening after it leaves a topic,
    // it stays reachable by its peer key after withdraw: withdraw ends
    // discovery of a route, not reachability of the host.
    this.members = new Set()
  }

  announce(routeId, backend) {
    let set = this.routes.get(routeId)
    if (!set) {
      set = new Set()
      this.routes.set(routeId, set)
    }
    set.add(backend)
    this.members.add(backend)
    for (const record of Array.from(this.pending)) {
      if (record.routeId === routeId) record.attempt()
    }
  }

  withdraw(routeId, backend) {
    const set = this.routes.get(routeId)
    if (!set) return
    set.delete(backend)
    if (set.size === 0) this.routes.delete(routeId)
  }

  // The announcer of `routeId` that holds `peerKey`, if any; else (D-16) a
  // started member that holds it, whatever it announces now.
  resolve(routeId, peerKey) {
    const holds = (backend) => {
      const key = backend.localPeerKey()
      return !!key && b4a.equals(key, peerKey)
    }
    for (const backend of this.routes.get(routeId) || []) if (holds(backend)) return backend
    for (const backend of this.members) if (backend._started && holds(backend)) return backend
    return null
  }
}

const defaultHub = new LoopbackHub()

// One direction-agnostic channel endpoint. `_lane` is shared with the endpoint
// on the other side of the connection.
class LoopbackChannel {
  constructor(conn, lane, handlers = {}) {
    // Replaceable: whatever is assigned at delivery time receives the message.
    this.onmessage = handlers.onmessage || noop
    this.onclose = handlers.onclose || noop
    this._conn = conn
    this._lane = lane
    // Messages waiting to be delivered to *this* endpoint.
    this._inbox = []
    this._scheduled = false
    this._closed = false
  }

  send(message) {
    const lane = this._lane
    if (this._closed || lane.closed) return false
    // A channel carries JSON (A-10): the receiver gets its own copy, never the
    // sender's object.
    const inbox = lane.inbox(this._conn._other)
    inbox.push(JSON.stringify(message))
    const remote = lane.endpoint(this._conn._other)
    if (remote) remote._schedule()
    return inbox.length < CHANNEL_HIGH_WATER
  }

  close() {
    this._lane.close()
  }

  _schedule() {
    if (this._scheduled || this._closed) return
    this._scheduled = true
    queueMicrotask(() => this._drain())
  }

  _drain() {
    this._scheduled = false
    const inbox = this._inbox
    while (inbox.length > 0 && !this._closed) {
      const message = JSON.parse(inbox.shift())
      try {
        // Not awaited, as the contract says.
        this.onmessage(message)
      } catch (err) {
        this._conn._fail(err)
        return
      }
    }
  }

  _close() {
    if (this._closed) return
    this._closed = true
    this._inbox.length = 0
    try {
      this.onclose()
    } catch (err) {
      this._conn._fail(err)
    }
  }
}

// The state both endpoints of one (protocol, id) channel share.
class Lane {
  constructor(link, key, protocol, id) {
    this.link = link
    this.key = key
    this.protocol = protocol
    this.id = id
    this.closed = false
    // Connections whose onChannel callback has already heard of this lane.
    this.notified = new Set()
    this.endpoints = new Map() // conn -> LoopbackChannel
    this.inboxes = new Map() // conn -> message[] queued before that side opened
  }

  endpoint(conn) {
    return this.endpoints.get(conn) || null
  }

  inbox(conn) {
    const endpoint = this.endpoints.get(conn)
    if (endpoint) return endpoint._inbox
    let early = this.inboxes.get(conn)
    if (!early) {
      early = []
      this.inboxes.set(conn, early)
    }
    return early
  }

  open(conn, handlers) {
    if (this.endpoints.has(conn)) {
      throw new Error(`Channel ${this.key} is already open on this connection`)
    }
    const channel = new LoopbackChannel(conn, this, handlers)
    const early = this.inboxes.get(conn)
    if (early) {
      this.inboxes.delete(conn)
      channel._inbox = early
    }
    this.endpoints.set(conn, channel)
    if (channel._inbox.length > 0) channel._schedule()
    return channel
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.link.lanes.delete(this.key)
    this.inboxes.clear()
    for (const channel of Array.from(this.endpoints.values())) channel._close()
  }
}

class LoopbackConnection extends EventEmitter {
  constructor(link, localKey, remoteKey, initiator) {
    super()
    this._link = link
    this._other = null
    this._localKey = localKey
    this._remoteKey = remoteKey
    this._initiator = initiator
    this._closed = false
    // protocol -> cb, for channels the remote opens first.
    this._pairs = new Map()
    // Session stores already replicated on this connection.
    this._replicated = new WeakSet()
    this._historyStream = null
  }

  get remotePeerKey() {
    return this._remoteKey
  }

  get closed() {
    return this._closed
  }

  get initiator() {
    return this._initiator
  }

  path() {
    return PATH.LOCAL
  }

  openChannel(protocol, id, handlers) {
    if (this._closed) throw new Error('Connection is closed')
    const link = this._link
    const key = laneKey(protocol, id)
    let lane = link.lanes.get(key)
    if (!lane) {
      lane = new Lane(link, key, protocol, b4a.from(id))
      link.lanes.set(key, lane)
    }
    const channel = lane.open(this, handlers)
    // The remote learns of a channel it has not opened itself through its
    // onChannel callback, one microtask later.
    if (!lane.endpoint(this._other)) {
      const other = this._other
      queueMicrotask(() => other._notify(lane))
    }
    return channel
  }

  onChannel(protocol, cb) {
    this._pairs.set(protocol, cb)
    // Channels the remote opened before this side was listening.
    for (const lane of Array.from(this._link.lanes.values())) {
      if (lane.protocol !== protocol) continue
      if (lane.endpoint(this) || !lane.endpoint(this._other)) continue
      queueMicrotask(() => this._notify(lane))
    }
  }

  close(_reason) {
    this._link.close()
  }

  _notify(lane) {
    if (this._closed || lane.closed || lane.endpoint(this)) return
    if (lane.notified.has(this)) return
    const cb = this._pairs.get(lane.protocol)
    if (!cb) return
    lane.notified.add(this)
    try {
      cb(b4a.from(lane.id))
    } catch (err) {
      this._fail(err)
    }
  }

  // A handler that throws takes the connection down, as it would on a real
  // stream.
  _fail(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err)
    this._link.close()
  }

  // Both cores of a session ride one Hypercore protocol stream per
  // connection; the stream of this side is piped to the other side's as soon
  // as both exist.
  _replicate(store) {
    if (this._closed || this._replicated.has(store)) return
    this._replicated.add(store)
    for (const core of [store.log, store.metaCore]) {
      if (!core || typeof core.replicate !== 'function') continue
      if (this._historyStream) {
        core.replicate(this._historyStream)
        continue
      }
      const stream = core.replicate(this._initiator === true, { keepAlive: false })
      if (!stream || typeof stream.pipe !== 'function') continue
      stream.on('error', noop)
      this._historyStream = stream
      this._link.pipeHistory()
    }
  }

  _close() {
    if (this._closed) return
    this._closed = true
    this._pairs.clear()
    const stream = this._historyStream
    this._historyStream = null
    if (stream && typeof stream.destroy === 'function') stream.destroy()
    this.emit('close')
  }
}

// What the two LoopbackConnections of one dial share.
class Link {
  constructor() {
    this.lanes = new Map()
    this.conns = []
    this.closed = false
    this.piped = false
  }

  pipeHistory() {
    if (this.piped || this.closed) return
    const [a, b] = this.conns
    if (!a._historyStream || !b._historyStream) return
    this.piped = true
    a._historyStream.pipe(b._historyStream).pipe(a._historyStream)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const lane of Array.from(this.lanes.values())) lane.close()
    for (const conn of this.conns) conn._close()
  }
}

class LoopbackBackend extends EventEmitter {
  constructor(opts = {}) {
    super()
    this._hub = opts.hub || defaultHub
    // The name of the one field a route carries. See routeFor().
    this._routeKey = typeof opts.routeKey === 'string' && opts.routeKey ? opts.routeKey : 'topic'
    this._ctx = null
    this._started = false
    // linkId -> route id, for withdraw.
    this._announced = new Map()
    this._dials = new Set()
    this._links = new Set()
    this._admission = () => false
    // peerKeyHex -> refcount of active dials expecting that key.
    this._pinned = new Map()
  }

  describe() {
    return {
      id: 'loopback',
      label: 'Loopback (in-process)',
      interfaceVersion: 1,
      capabilities: CAPABILITIES
    }
  }

  start(ctx) {
    if (this._started) return Promise.resolve()
    this._started = true
    this._ctx = ctx || {}
    return Promise.resolve()
  }

  stop() {
    this._started = false
    this._hub.members.delete(this)
    for (const [, routeId] of this._announced) this._hub.withdraw(routeId, this)
    this._announced.clear()
    for (const record of Array.from(this._dials)) record.cancel()
    for (const link of Array.from(this._links)) link.close()
    this._links.clear()
    this._pinned.clear()
    return Promise.resolve()
  }

  health() {
    return {
      started: this._started,
      listening: this._announced.size > 0,
      detail: null
    }
  }

  localPeerKey() {
    const keyPair = (this._ctx && this._ctx.keyPair && this._ctx.keyPair()) || null
    return (keyPair && keyPair.publicKey) || null
  }

  setAdmission(policy) {
    this._admission = typeof policy === 'function' ? policy : () => !!policy
  }

  // A route is `{ <routeKey>: <64 hex> }`. The key defaults to `topic`, on
  // purpose: the conformance suite forges v1-shaped invites from a link's
  // stored `topic`, and those must dial on this backend as they do on Pear.
  // The share manager itself no longer needs that spelling (B6): with
  // `opts.routeKey` set to anything else the route is opaque to it, is stored
  // whole on the link record and travels in a v2 invite - which is how
  // test/backends/registry.test.js proves the manager is not topic-shaped.
  routeFor(linkId, stored) {
    const key = this._routeKey
    if (stored && stored.route && stored.route[key]) return { [key]: stored.route[key] }
    if (stored && stored[key]) return { [key]: stored[key] }
    return { [key]: randomHex(32) }
  }

  _routeId(route) {
    return route ? route[this._routeKey] : undefined
  }

  announce(linkId, opts = {}) {
    const route = opts.route || this.routeFor(linkId, null)
    const routeId = this._routeId(route)
    this._announced.set(linkId, routeId)
    this._debug('loopback:announce', { ...opts.tag, linkId, route: routeId })
    this._hub.announce(routeId, this)
    return Promise.resolve({ route, linkId })
  }

  withdraw(linkId) {
    const routeId = this._announced.get(linkId)
    if (routeId === undefined) return Promise.resolve()
    this._announced.delete(linkId)
    // Another link of this backend may still announce the same route.
    let shared = false
    for (const other of this._announced.values()) if (other === routeId) shared = true
    if (!shared) this._hub.withdraw(routeId, this)
    return Promise.resolve()
  }

  dial(route, expectedPeerKey, opts = {}) {
    const expectedHex = b4a.toString(expectedPeerKey, 'hex')
    const record = {
      routeId: this._routeId(route),
      connected: false,
      done: false,
      attempt: null,
      cancel: null
    }
    let resolve = null
    let reject = null
    const connected = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    // A cancelled dial is an expected outcome, not an unhandled rejection.
    connected.catch(() => {})

    record.cancel = () => {
      if (record.done) return
      record.done = true
      this._dials.delete(record)
      this._hub.pending.delete(record)
      this._unpin(expectedHex)
      if (!record.connected) reject(new Error('Dial was cancelled'))
    }

    record.attempt = () => {
      if (record.done || record.connected || !this._started) return
      const localKey = this.localPeerKey()
      if (!localKey) return
      const remote = this._hub.resolve(record.routeId, expectedPeerKey)
      if (!remote || remote === this) return
      // The remote's inbound policy: its admission, or a key it is itself
      // dialing.
      if (!remote._admits(localKey)) {
        this._debug('loopback:dial:refused', { ...opts.tag, route: record.routeId })
        return
      }
      record.connected = true
      this._hub.pending.delete(record)
      const link = new Link()
      const mine = new LoopbackConnection(link, localKey, b4a.from(expectedPeerKey), true)
      const theirs = new LoopbackConnection(link, b4a.from(expectedPeerKey), localKey, false)
      mine._other = theirs
      theirs._other = mine
      link.conns.push(mine, theirs)
      this._track(link)
      remote._track(link)
      this._debug('loopback:dial:connected', { ...opts.tag, route: record.routeId })
      // The accepting side hears of the connection first, so its channel
      // listener is in place before the dialing side opens anything.
      remote._accept(theirs, { client: false, server: true })
      resolve(mine)
      // 'connection' fires once per connection on both sides, whichever side
      // opened it: the dialed peer may open channels of its own on it.
      this._accept(mine, { client: true, server: false })
    }

    this._dials.add(record)
    this._pin(expectedHex)
    this._hub.pending.add(record)
    if (opts.signal) {
      if (opts.signal.aborted) queueMicrotask(record.cancel)
      else opts.signal.addEventListener('abort', record.cancel, { once: true })
    }
    this._debug('loopback:dial', { ...opts.tag, route: record.routeId, peer: expectedHex })
    queueMicrotask(record.attempt)

    return { connected, cancel: record.cancel }
  }

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

  // History rides the connection, keyed by the Hypercore keys already carried
  // in `confirm`; there is no separate route.
  historyRouteFor(_store) {
    return null
  }

  diagnostics() {
    let connections = 0
    for (const link of this._links) if (!link.closed) connections++
    return {
      id: 'loopback',
      started: this._started,
      announced: this._announced.size,
      dials: this._dials.size,
      connections
    }
  }

  _admits(remoteKey) {
    if (!this._started) return false
    return !!this._admission(remoteKey) || this._pinned.has(b4a.toString(remoteKey, 'hex'))
  }

  _accept(conn, info) {
    try {
      this.emit('connection', conn, info)
    } catch (err) {
      this.emit('error', err)
    }
  }

  _track(link) {
    this._links.add(link)
    link.conns[0].once('close', () => this._links.delete(link))
  }

  _pin(keyHex) {
    this._pinned.set(keyHex, (this._pinned.get(keyHex) || 0) + 1)
  }

  _unpin(keyHex) {
    const count = (this._pinned.get(keyHex) || 0) - 1
    if (count <= 0) this._pinned.delete(keyHex)
    else this._pinned.set(keyHex, count)
  }

  _debug(event, details = {}) {
    this.emit('debug', { event, details })
  }
}

function laneKey(protocol, id) {
  return protocol + '\n' + b4a.toString(id, 'hex')
}

// Route ids only need to be unique, not unguessable: they never leave the
// process.
let routeCounter = 0
function randomHex(bytes) {
  const out = b4a.alloc(bytes)
  for (let i = 0; i < bytes; i++) out[i] = Math.floor(Math.random() * 256)
  const counter = ++routeCounter
  out[0] = counter & 0xff
  out[1] = (counter >> 8) & 0xff
  out[2] = (counter >> 16) & 0xff
  return b4a.toString(out, 'hex')
}

function noop() {}

module.exports = LoopbackBackend
module.exports.LoopbackBackend = LoopbackBackend
module.exports.LoopbackHub = LoopbackHub
module.exports.LoopbackConnection = LoopbackConnection
