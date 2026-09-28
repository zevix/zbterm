// Tests that reach into the Pear backend's privates (the swarm factory, the
// shared swarm, host-key pinning, the relay window, the registry lookup, the
// socket -> PearConnection wrapping). They construct PearBackend directly and,
// where the behaviour under test is ShareManager's, inject it through
// `new ShareManager(engine, { backend })`. Moved here from
// test/share-manager.test.js by backend-abstraction B4; every assertion is
// unchanged.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')
const b4a = require('b4a')
const Protomux = require('protomux')

const ShareManager = require('../../engine/share-manager')
const SessionEngine = require('../../engine')
const PearBackend = require('../../engine/backends/pear')
const { PearConnection } = require('../../engine/backends/pear')
const { VERSION } = require('../../engine/schema')
const { loadOrCreateLocalDevice } = require('../../engine/crypto')
const { CODES } = require('../../engine/errors')
const { SEND_INPUT } = require('../../engine/caps')

test('default share links allow input when host enables shared keyboard', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  const host = await loadOrCreateLocalDevice({ root: dir })
  const stored = {}
  const manager = new ShareManager(
    {
      localDevice: host,
      sessions: new Map([
        [
          'session-a',
          {
            store: {
              timeline: [],
              meta: {
                put: async (key, value) => {
                  stored[key] = value
                }
              }
            }
          }
        ]
      ])
    },
    { backend: new PearBackend() }
  )
  t.teardown(() => manager.close())
  manager.backend._createSwarm = () => ({
    on: () => {},
    join: () => {},
    flush: async () => {},
    destroy: async () => {}
  })

  const link = await manager.createLink('session-a', { type: 'group' })
  t.ok(link.caps & SEND_INPUT, 'default links grant SEND_INPUT')
  t.ok(stored[`link/${link.linkId}`].caps & SEND_INPUT, 'stored link grants SEND_INPUT')
})

// The Join dialog inspects the inviter before it connects, so the claim has to
// survive the round trip through the link itself.
test('an invite link carries the host identity claim, and works without one', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  const host = await loadOrCreateLocalDevice({ root: dir })
  const stored = new Map()
  const engine = {
    localDevice: host,
    selfIdentityClaim: null,
    sessions: new Map([
      [
        'session-a',
        {
          store: {
            timeline: [],
            meta: {
              put: async (key, value) => {
                stored.set(key, value)
              },
              // listLinks re-encodes every stored link, so the round trip has
              // to be exercised through a readable store, not just createLink.
              createReadStream: ({ gt, lt }) =>
                [...stored.entries()]
                  .filter(([key]) => key > gt && key < lt)
                  .map(([key, value]) => ({ key, value }))
            }
          }
        }
      ]
    ])
  }
  const manager = new ShareManager(engine, { backend: new PearBackend() })
  t.teardown(() => manager.close())
  manager.backend._createSwarm = () => ({
    on: () => {},
    join: () => {},
    flush: async () => {},
    destroy: async () => {}
  })

  // An unidentified host still produces a usable link - the viewer just sees
  // it as unclaimed rather than as an error.
  const anonymous = await manager.createLink('session-a', { type: 'group' })
  t.is(ShareManager.decodeLink(anonymous.uri).claim, null, 'no identity means no claim')

  const claim = {
    version: 2,
    provider: 'github',
    subject: 'alice',
    identityKey: 'aa'.repeat(32),
    authKey: 'bb'.repeat(32),
    sshPublicKey: 'AAAA',
    sshKeyType: 'ssh-ed25519',
    sshFingerprint: 'SHA256:abc',
    issuedAt: 1700000000000,
    nonce: 'cc'.repeat(16),
    signature: '-----BEGIN SSH SIGNATURE-----\nx\n-----END SSH SIGNATURE-----\n',
    createdAt: 1700000000001
  }
  engine.selfIdentityClaim = claim
  const identified = await manager.createLink('session-a', { type: 'group' })
  const carried = ShareManager.decodeLink(identified.uri).claim
  t.ok(carried, 'an identified host puts its claim in the link')
  // Every field claimBytes() signs must survive, or the viewer cannot check
  // the signature it is handed.
  for (const field of [
    'provider',
    'subject',
    'identityKey',
    'authKey',
    'sshFingerprint',
    'issuedAt',
    'nonce',
    'signature'
  ]) {
    t.is(carried[field], claim[field], `${field} survives the link round trip`)
  }
  t.is(carried.sshPublicKey, claim.sshPublicKey, 'the signing key survives')
  t.absent('createdAt' in carried, 'unsigned bookkeeping is not published in the link')
  t.absent('version' in carried, 'the stored record version is not published in the link')

  const listed = await manager.listLinks('session-a')
  t.ok(
    listed.every((link) => ShareManager.decodeLink(link.uri).claim),
    'links listed later carry the claim too'
  )
})

test('viewer connection is destroyed before any channel/join-request when the socket key does not match the invite hostDhtKey', async (t) => {
  const host = await loadOrCreateLocalDevice({ root: await temp() })
  const wrongHost = await loadOrCreateLocalDevice({ root: await temp() })
  const manager = new ShareManager(
    { localDevice: host, sessions: new Map() },
    { backend: new PearBackend() }
  )
  t.teardown(() => manager.close())

  const debugEvents = []
  manager.on('debug', ({ event }) => debugEvents.push(event))

  let finishedWith = null
  const state = {
    invite: { linkId: 'a'.repeat(32) },
    hostDhtKey: host.dhtPublicKey,
    connected: false,
    finish: (status) => {
      finishedWith = status
    }
  }

  const socket = fakeSocket()
  socket.remotePublicKey = wrongHost.dhtPublicKey
  let destroyed = false
  const realDestroy = socket.destroy.bind(socket)
  socket.destroy = () => {
    destroyed = true
    realDestroy()
  }

  manager._handleViewerConnection(
    state,
    new PearConnection(socket, { client: true, server: false })
  )

  t.ok(destroyed, 'the mismatched socket is destroyed')
  t.ok(finishedWith, 'the join is finished rather than left to time out')
  t.is(finishedWith.code, CODES.E_AUTH)
  t.ok(debugEvents.includes('viewer:socket:host-mismatch'), 'the mismatch is logged for diagnosis')
  t.absent(
    debugEvents.includes('viewer:ctl:open'),
    'no channel is ever opened for a socket that fails the host-key pin'
  )
  t.absent(
    debugEvents.includes('viewer:join-request:sent'),
    'join-request (carrying this device identity proof) is never sent to an unverified peer'
  )
})

test('viewer connection proceeds normally when the socket key matches the invite hostDhtKey', async (t) => {
  const host = await loadOrCreateLocalDevice({ root: await temp() })
  const manager = new ShareManager(
    { localDevice: host, sessions: new Map() },
    { backend: new PearBackend() }
  )
  t.teardown(() => manager.close())

  const debugEvents = []
  manager.on('debug', ({ event }) => debugEvents.push(event))

  const state = {
    invite: { linkId: 'a'.repeat(32) },
    hostDhtKey: host.dhtPublicKey,
    connected: false,
    finish: () => {}
  }

  const socket = fakeSocket()
  socket.remotePublicKey = host.dhtPublicKey

  manager._handleViewerConnection(
    state,
    new PearConnection(socket, { client: true, server: false })
  )

  t.absent(socket.destroyed, 'a correctly-pinned socket is not destroyed')
  t.absent(
    debugEvents.includes('viewer:socket:host-mismatch'),
    'no mismatch is logged for a correct host key'
  )
  t.ok(debugEvents.includes('viewer:ctl:open'), 'channel is opened for a correctly-pinned socket')
  t.ok(debugEvents.includes('viewer:join-request:sent'), 'join-request is sent once pinning passes')
})

test('two sessions multiplexed over one socket produce independent peers, and closing that socket cleans up both without affecting a peer on a different socket', async (t) => {
  const backend = new PearBackend()
  const manager = new ShareManager({ sessions: new Map() }, { backend })
  t.teardown(() => manager.close())

  const replicated = []
  const runtimeFor = (sessionId) => ({
    store: {
      log: { replicate: () => replicated.push(`${sessionId}:log`) },
      metaCore: { replicate: () => replicated.push(`${sessionId}:meta`) }
    }
  })
  manager.engine.sessions.set('session-a', runtimeFor('session-a'))
  manager.engine.sessions.set('session-b', runtimeFor('session-b'))

  const shareA = { sessionId: 'session-a', peers: new Set(), pendingApprovals: new Map() }
  const shareB = { sessionId: 'session-b', peers: new Set(), pendingApprovals: new Map() }
  manager.hostShares.set('session-a', shareA)
  manager.hostShares.set('session-b', shareB)

  const linkIdA = 'aa'.repeat(16)
  const linkIdB = 'bb'.repeat(16)
  manager._linkIndex.set(linkIdA, 'session-a')
  manager._linkIndex.set(linkIdB, 'session-b')

  // The backend wraps each socket in one PearConnection and emits it; the
  // manager keys its per-connection bookkeeping by that object.
  const sharedSocket = fakeSocket()
  backend._handleConnection(sharedSocket, { client: false, server: true })
  const sharedConn = backend._conns.get(sharedSocket)
  t.ok(sharedConn instanceof PearConnection, 'the socket is wrapped in a PearConnection')
  const sharedNotify = pairNotify(sharedSocket)
  await sharedNotify(b4a.from(linkIdA, 'hex'))
  await sharedNotify(b4a.from(linkIdB, 'hex'))

  t.is(shareA.peers.size, 1, 'session-a got its own peer on the shared socket')
  t.is(shareB.peers.size, 1, 'session-b got its own peer on the shared socket')
  t.is(manager._connPeers.get(sharedConn).size, 2, 'one socket tracks both peers it produced')
  t.alike(
    replicated.sort(),
    ['session-a:log', 'session-a:meta', 'session-b:log', 'session-b:meta'].sort(),
    'each session replicates exactly once on the shared socket'
  )

  const otherSocket = fakeSocket()
  backend._handleConnection(otherSocket, { client: false, server: true })
  const otherConn = backend._conns.get(otherSocket)
  const otherNotify = pairNotify(otherSocket)
  await otherNotify(b4a.from(linkIdA, 'hex'))
  t.is(shareA.peers.size, 2, 'a second, unrelated socket gets its own independent peer')

  sharedSocket.destroy()
  t.is(shareA.peers.size, 1, 'closing the shared socket removes only its own session-a peer')
  t.is(shareB.peers.size, 0, 'closing the shared socket removes its session-b peer too')
  t.absent(
    manager._connPeers.has(sharedConn),
    'the shared socket is dropped from socket bookkeeping'
  )
  t.is(manager._connPeers.get(otherConn).size, 1, 'the unrelated socket is untouched')

  otherSocket.destroy()
})

test('registry lookup prefers the shared host swarm dht once one exists', async (t) => {
  const backend = new PearBackend()
  t.teardown(() => backend.stop())
  // A relay key given by env suppresses the registry lookup altogether.
  backend._relayPublicKey = null
  await backend.start({})

  t.ok(backend._registryDht, "start()'s pre-swarm tick created a standalone registry dht")

  let registryDhtCalls = 0
  backend._registryDht.mutableGet = async () => {
    registryDhtCalls++
    return null
  }

  let hostSwarmDhtCalls = 0
  backend._swarm = {
    dht: {
      mutableGet: async () => {
        hostSwarmDhtCalls++
        return null
      }
    },
    destroy: async () => {}
  }

  await backend._registryLookup()

  t.is(hostSwarmDhtCalls, 1, 'lookup used the shared host swarm dht once it exists')
  t.is(registryDhtCalls, 0, 'the standalone registry dht is not used once a host swarm exists')
})

test('_pinHost/_unpinHost refcount a host key across concurrent joins to the same host', (t) => {
  const backend = new PearBackend()
  t.teardown(() => backend.stop())

  const hostKey = b4a.alloc(32, 7)
  const hostKeyHex = b4a.toString(hostKey, 'hex')

  let leavePeerCalls = 0
  backend._swarm = { leavePeer: () => leavePeerCalls++, destroy: async () => {} }

  backend._pinHost(hostKey)
  backend._pinHost(hostKey)
  t.is(
    backend._pinnedHostKeys.get(hostKeyHex),
    2,
    'two concurrent joins to the same host share one refcounted pin'
  )

  backend._unpinHost(hostKey)
  t.is(
    backend._pinnedHostKeys.get(hostKeyHex),
    1,
    'unpinning one of two joins leaves the host pinned for the other'
  )
  t.is(leavePeerCalls, 0, 'leavePeer is not called while another join still needs this host')

  backend._unpinHost(hostKey)
  t.absent(backend._pinnedHostKeys.has(hostKeyHex), 'the last unpin removes the refcount entry')
  t.is(leavePeerCalls, 1, 'leavePeer is called only once the refcount reaches zero')
})

test('shared swarm union firewall accepts hosting-anything or a pinned join host, rejects otherwise', (t) => {
  const backend = new PearBackend()
  const manager = new ShareManager(
    {
      localDevice: { dhtPublicKey: b4a.alloc(32, 1) },
      sessions: new Map()
    },
    { backend }
  )
  t.teardown(() => manager.close())

  let installedFirewall = null
  backend._createSwarm = (opts) => {
    installedFirewall = opts.firewall
    return {
      on: () => {},
      join: () => {},
      joinPeer: () => {},
      flush: async () => {},
      destroy: async () => {}
    }
  }

  backend._ensureSwarm()
  t.ok(installedFirewall, 'the shared swarm is created with a firewall function')

  const pinnedKey = b4a.alloc(32, 2)
  const unpinnedKey = b4a.alloc(32, 3)
  backend._pinHost(pinnedKey)

  t.ok(
    installedFirewall(unpinnedKey),
    'an unpinned key is rejected while nothing is hosted or pinned for it'
  )
  t.absent(
    installedFirewall(pinnedKey),
    'a pinned join host is accepted even while nothing is hosted'
  )

  manager.hostShares.set('session-a', {})
  t.absent(
    installedFirewall(unpinnedKey),
    'any key is accepted once this instance is hosting something (accept-all, unchanged from Phase 1/2)'
  )
})

test('_relayThrough offers the relay only for forced or unconnected stale joins', (t) => {
  const backend = new PearBackend()
  t.teardown(() => backend.stop())
  backend._relayPublicKey = b4a.alloc(32, 9)

  t.is(
    backend._relayThrough(false),
    null,
    'no relay is offered with no relay key or no active join'
  )
  t.alike(backend._relayThrough(true), backend._relayPublicKey, 'force always offers the relay')

  // The relay window is driven by the backend's own active dials.
  backend._dials.add({ startedAt: Date.now() })
  t.is(backend._relayThrough(false), null, 'a freshly-started join does not yet unlock the relay')

  backend._dials.add({ connected: true, startedAt: Date.now() - 60_000 })
  t.is(backend._relayThrough(false), null, 'a connected old join does not unlock the relay')

  backend._dials.add({ connected: false, startedAt: Date.now() - 60_000 })
  t.alike(
    backend._relayThrough(false),
    backend._relayPublicKey,
    'an unconnected join past the fallback window unlocks the relay'
  )
})

test('join reuses an existing socket to the invited host before dialing', async (t) => {
  const backend = new PearBackend()
  const manager = new ShareManager({ sessions: new Map() }, { backend })
  t.teardown(() => manager.close())

  const hostDhtKey = b4a.alloc(32, 4)
  const socket = fakeSocket()
  socket.remotePublicKey = hostDhtKey

  const calls = []
  // The manager is handed the PearConnection the backend wrapped the warm
  // socket in; the socket and its swarm info are that connection's privates.
  manager._handleViewerConnection = (state, conn) => {
    calls.push({ linkId: state.invite.linkId, socket: conn._socket, info: conn._info })
    state.connected = true
  }

  let joinedTopic = null
  let joinedPeer = null
  backend._swarm = {
    connections: [socket],
    join: (topic, opts) => {
      joinedTopic = { topic, opts }
    },
    joinPeer: (key) => {
      joinedPeer = key
    },
    leave: async () => {},
    leavePeer: () => {},
    flush: async () => {},
    destroy: async () => {},
    on: () => {}
  }

  const invite = {
    v: VERSION,
    linkId: 'aa'.repeat(16),
    topic: 'bb'.repeat(32),
    hostDhtKey: b4a.toString(hostDhtKey, 'hex')
  }

  await manager.join(encodeTestLink(invite))

  t.is(calls.length, 1, 'join immediately dispatches the warm socket')
  t.is(calls[0].socket, socket, 'the reused socket is the existing host connection')
  t.is(calls[0].info, null, 'warm-socket reuse is not tied to a new swarm event')
  t.ok(joinedTopic, 'join still joins the invite topic for discovery/backstop')
  t.alike(joinedPeer, hostDhtKey, 'join still keeps the direct host dial pinned')

  for (const state of manager.joins.values()) state.settle()
})

test('successful join settlement removes bookkeeping, leaves topic, unpins host, and closes only the channel', async (t) => {
  const backend = new PearBackend()
  const manager = new ShareManager({ sessions: new Map() }, { backend })
  t.teardown(() => manager.close())

  const hostDhtKey = b4a.alloc(32, 5)
  const invite = {
    v: VERSION,
    linkId: 'cc'.repeat(16),
    topic: 'dd'.repeat(32),
    hostDhtKey: b4a.toString(hostDhtKey, 'hex')
  }

  let leaveTopic = null
  let leavePeer = null
  backend._swarm = {
    connections: [],
    join: () => {},
    joinPeer: () => {},
    leave: async (topic) => {
      leaveTopic = topic
    },
    leavePeer: (key) => {
      leavePeer = key
    },
    flush: async () => {},
    destroy: async () => {},
    on: () => {}
  }

  await manager.join(encodeTestLink(invite))
  const state = Array.from(manager.joins.values())[0]
  t.ok(state, 'join state was registered')
  t.is(backend._pinnedHostKeys.get(invite.hostDhtKey), 1, 'host key is pinned while join is active')

  let closed = 0
  state.connected = true
  state.confirmed = true
  state.sessionId = 'remote-a'
  state.channel = { close: () => closed++ }

  manager._settleJoin(state)
  manager._settleJoin(state)

  t.is(manager.joins.size, 0, 'settlement removes the join from diagnostics/bookkeeping')
  t.alike(leaveTopic, b4a.from(invite.topic, 'hex'), 'settlement leaves the invite topic')
  t.alike(leavePeer, hostDhtKey, 'settlement releases the direct host dial pin')
  t.absent(backend._pinnedHostKeys.has(invite.hostDhtKey), 'host pin refcount is cleared')
  t.is(closed, 1, 'settlement is idempotent and closes the channel once')
})

// The injection seam (B4): ShareManager takes a backend, SessionEngine takes
// `opts.shareBackend` as an instance or a factory, and Pear stays the default.
test('a share backend can be injected into ShareManager and SessionEngine, Pear by default', async (t) => {
  const injected = new PearBackend()
  const manager = new ShareManager({ sessions: new Map() }, { backend: injected })
  t.teardown(() => manager.close())
  t.is(manager.backend, injected, 'ShareManager uses the backend it is given')

  const fallback = new ShareManager({ sessions: new Map() })
  t.teardown(() => fallback.close())
  t.ok(fallback.backend instanceof PearBackend, 'ShareManager defaults to Pear')

  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  const engines = []
  t.teardown(() => Promise.all(engines.map((engine) => engine.share.close())))
  const engineWith = (shareBackend) => {
    const engine = new SessionEngine({
      userData: path.join(dir, String(engines.length)),
      ptyHost: new EventEmitter(),
      shareBackend
    })
    engines.push(engine)
    return engine
  }

  const instance = new PearBackend()
  t.is(engineWith(instance).share.backend, instance, 'opts.shareBackend accepts an instance')

  const made = new PearBackend()
  let factoryArg = null
  const viaFactory = engineWith((engine) => {
    factoryArg = engine
    return made
  })
  t.is(viaFactory.share.backend, made, 'opts.shareBackend accepts a factory')
  t.is(factoryArg, viaFactory, 'the factory is called with the engine')

  t.ok(engineWith(undefined).share.backend instanceof PearBackend, 'SessionEngine defaults to Pear')

  t.exception.all(
    () => new ShareManager({ sessions: new Map() }, { backend: {} }),
    'an object that is not a share backend is refused'
  )
})

function fakeSocket() {
  const socket = new EventEmitter()
  socket.write = () => true
  socket.destroyed = false
  socket.userData = null
  socket.destroy = () => {
    if (socket.destroyed) return
    socket.destroyed = true
    socket.emit('close')
  }
  return socket
}

// 'zbterm/ctl' is the wire protocol id (engine/share-manager.js PROTOCOL).
function pairNotify(socket) {
  const mux = Protomux.from(socket)
  return mux._notify.get('zbterm/ctl##')
}

function encodeTestLink(payload) {
  return 'zbterm://join/' + Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function temp() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-pear-backend-test-'))
}
