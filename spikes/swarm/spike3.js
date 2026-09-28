// Spike 3 - Hyperswarm connection dedup & mixed roles.
// docs/PHASE0-WORK-PLAN.md, Spike 3. Prints a result row per scenario;
// exits 0 only if every observation was recorded (a scenario "failing" the
// prediction is fine and is recorded as data, not a script error).
// Throwaway spike code, never imported by app code.
'use strict'
const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { setupTestnet, makeSwarm } = require('./testnet')

const PROTOCOL = 'zbterm/ctl'
const matrix = []

// Destroyed swarms can still emit a late 'error' (ECONNRESET) from an
// in-flight NoiseSecretStream teardown race - harmless noise unrelated to
// the recorded assertions/observations above. Log and continue instead of
// letting it crash the whole matrix run.
process.on('uncaughtException', (err) => {
  console.error('[ignored late teardown error]', err.message)
})

function record(scenario, observation) {
  matrix.push({ scenario, observation })
  console.log(`[${scenario}]`, JSON.stringify(observation))
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const iv = setInterval(() => {
      let ok
      try {
        ok = predicate()
      } catch (err) {
        clearInterval(iv)
        reject(err)
        return
      }
      if (ok) {
        clearInterval(iv)
        resolve()
        return
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(iv)
        reject(new Error(`timeout waiting for: ${label} (${timeoutMs}ms)`))
      }
    }, 20)
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function attachChannel(mux, id, onMessage) {
  const channel = mux.createChannel({ protocol: PROTOCOL, id })
  const message = channel.addMessage({ encoding: c.json, onmessage: onMessage || (() => {}) })
  channel.open()
  return { channel, message }
}

function attachPairing(mux, onPair) {
  const entries = {}
  mux.pair({ protocol: PROTOCOL }, (id) => {
    const key = b4a.toString(id, 'hex')
    const entry = attachChannel(mux, id, (msg) => {
      if (onPair) onPair(key, msg, entry)
    })
    entries[key] = entry
  })
  return entries
}

async function scenario1(testnet) {
  const aKeyPair = crypto.keyPair()
  const bKeyPair = crypto.keyPair()
  const A = makeSwarm(testnet, { keyPair: aKeyPair })
  const B = makeSwarm(testnet, { keyPair: bKeyPair })

  const aConnEvents = []
  const bConnEvents = []
  A.on('connection', () => aConnEvents.push(Date.now()))
  B.on('connection', () => bConnEvents.push(Date.now()))

  const t1 = crypto.randomBytes(32)
  const t2 = crypto.randomBytes(32)
  A.join(t1, { server: true, client: false })
  A.join(t2, { server: true, client: false })
  await A.flush()
  B.join(t1, { server: false, client: true })
  B.join(t2, { server: false, client: true })
  await B.flush()

  await waitFor(() => A.connections.size >= 1 && B.connections.size >= 1, 10000, 'scenario1 connect')
  await delay(2000) // let a possible second connection show up if dedup doesn't hold

  record('1-two-topics-one-peer', {
    aConnectionEvents: aConnEvents.length,
    bConnectionEvents: bConnEvents.length,
    aConnectionsSize: A.connections.size,
    bConnectionsSize: B.connections.size
  })

  await A.destroy()
  await B.destroy()
}

async function scenario2(testnet) {
  const aKeyPair = crypto.keyPair()
  const bKeyPair = crypto.keyPair()
  const A = makeSwarm(testnet, { keyPair: aKeyPair })
  const B = makeSwarm(testnet, { keyPair: bKeyPair })

  const aConnEvents = []
  const bConnEvents = []
  A.on('connection', () => aConnEvents.push(Date.now()))
  B.on('connection', () => bConnEvents.push(Date.now()))

  const t1 = crypto.randomBytes(32)
  A.join(t1, { server: true, client: false })
  await A.flush()
  B.join(t1, { server: false, client: true })
  B.joinPeer(aKeyPair.publicKey)
  // Note (observation, not part of the graded scenario): swarm.flush() on
  // the joinPeer side does not resolve here even once connected - it hangs
  // indefinitely when a topic join and an explicit joinPeer are combined
  // on hyperswarm@4.17.0 against this local testnet. Worked around by
  // polling connection state directly instead of awaiting flush().

  await waitFor(() => A.connections.size >= 1 && B.connections.size >= 1, 10000, 'scenario2 connect')
  const sizeAfterFirst = { a: A.connections.size, b: B.connections.size }
  await delay(10000)

  record('2-topic-plus-joinpeer', {
    aConnectionEvents: aConnEvents.length,
    bConnectionEvents: bConnEvents.length,
    sizeAfterFirstConnect: sizeAfterFirst,
    sizeAfter10sWait: { a: A.connections.size, b: B.connections.size },
    secondConnectionEventFiredLater: bConnEvents.length > 1 || aConnEvents.length > 1
  })

  await A.destroy()
  await B.destroy()
}

async function scenario3(testnet) {
  const aKeyPair = crypto.keyPair()
  const bKeyPair = crypto.keyPair()
  const A = makeSwarm(testnet, { keyPair: aKeyPair })
  const B = makeSwarm(testnet, { keyPair: bKeyPair })

  const t1 = crypto.randomBytes(32) // A hosts, B joins
  const t2 = crypto.randomBytes(32) // B hosts, A joins

  const aConns = []
  const bConns = []

  // Real wiring: both sides register a generic host-role pair handler AND
  // may open a viewer-role channel once connected - this is exactly the
  // "roles coexist on one socket" claim to check.
  const aRoleState = { asHostPeers: {}, asViewerChannel: null, asViewerReplies: [] }
  const bRoleState = { asHostPeers: {}, asViewerChannel: null, asViewerReplies: [] }

  A.on('connection', (socket, info) => {
    aConns.push({ client: !!info.client, server: !!info.server })
    const mux = Protomux.from(socket)
    attachPairing(mux, (key, msg, entry) => {
      aRoleState.asHostPeers[key] = true
      if (msg.type === 'ping') entry.message.send({ type: 'pong', from: 'A-as-host' })
    })
    const idOut = crypto.randomBytes(16)
    const entry = attachChannel(mux, idOut, (msg) => {
      if (msg.type === 'pong') aRoleState.asViewerReplies.push(msg.from)
    })
    aRoleState.asViewerChannel = entry
    entry.message.send({ type: 'ping' })
  })

  B.on('connection', (socket, info) => {
    bConns.push({ client: !!info.client, server: !!info.server })
    const mux = Protomux.from(socket)
    attachPairing(mux, (key, msg, entry) => {
      bRoleState.asHostPeers[key] = true
      if (msg.type === 'ping') entry.message.send({ type: 'pong', from: 'B-as-host' })
    })
    const idOut = crypto.randomBytes(16)
    const entry = attachChannel(mux, idOut, (msg) => {
      if (msg.type === 'pong') bRoleState.asViewerReplies.push(msg.from)
    })
    bRoleState.asViewerChannel = entry
    entry.message.send({ type: 'ping' })
  })

  A.join(t1, { server: true, client: false })
  B.join(t2, { server: true, client: false })
  await Promise.all([A.flush(), B.flush()])
  A.join(t2, { server: false, client: true })
  B.join(t1, { server: false, client: true })
  await Promise.all([A.flush(), B.flush()])

  await waitFor(
    () => aRoleState.asViewerReplies.length > 0 && bRoleState.asViewerReplies.length > 0,
    10000,
    'scenario3 both directions replied'
  )
  await delay(1000)

  record('3-mixed-roles', {
    aConnections: aConns,
    bConnections: bConns,
    aConnectionsSize: A.connections.size,
    bConnectionsSize: B.connections.size,
    aReceivedAsViewer: aRoleState.asViewerReplies,
    bReceivedAsViewer: bRoleState.asViewerReplies,
    aActedAsHost: Object.keys(aRoleState.asHostPeers).length > 0,
    bActedAsHost: Object.keys(bRoleState.asHostPeers).length > 0
  })

  await A.destroy()
  await B.destroy()
}

async function scenario4(testnet) {
  const aKeyPair = crypto.keyPair()
  const bKeyPair = crypto.keyPair()
  const A = makeSwarm(testnet, { keyPair: aKeyPair })
  const B = makeSwarm(testnet, { keyPair: bKeyPair })

  let firewallCalls = 0
  const firewallLog = []
  // Recreate A with a counting accept-all firewall (firewall must be set
  // at construction time).
  await A.destroy()
  const A2 = makeSwarm(testnet, {
    keyPair: aKeyPair,
    firewall: (remotePublicKey) => {
      firewallCalls++
      firewallLog.push({ ts: Date.now(), remotePublicKey: b4a.toString(remotePublicKey, 'hex') })
      return false // accept
    }
  })

  const t1 = crypto.randomBytes(32)
  A2.join(t1, { server: true, client: false })
  await A2.flush()
  B.join(t1, { server: false, client: true })
  B.joinPeer(aKeyPair.publicKey)
  await waitFor(() => A2.connections.size >= 1, 10000, 'scenario4 connect (accept-all)')
  await delay(3000)

  record('4a-firewall-invocation-count-accept-all', {
    firewallCalls,
    aConnectionsSize: A2.connections.size,
    bConnectionsSize: B.connections.size
  })

  await A2.destroy()
  await B.destroy()

  // Invert: A rejects B; B still joinPeers A while A also joinPeers B -
  // observe whether the A-outbound direction still connects. A bare
  // joinPeer with no shared topic never connects on this stack (see the
  // isolated repro in the findings write-up), so mirror production's real
  // pattern: B hosts a topic (accept-all, server-only) and A both
  // topic-joins as client AND joinPeers B directly - exactly what
  // ShareManager.join() does. A's own firewall is configured to reject
  // B's key specifically, to probe whether that blocks A's own outbound
  // dial to B (pitfall 2's "firewalls gate inbound only" claim).
  const topic4b = crypto.randomBytes(32)
  const A3 = makeSwarm(testnet, {
    keyPair: aKeyPair,
    firewall: (remotePublicKey) => b4a.equals(remotePublicKey, bKeyPair.publicKey) // true = reject B
  })
  const B2 = makeSwarm(testnet, { keyPair: bKeyPair })

  const aOutboundConnected = new Promise((resolve) => {
    A3.on('connection', (socket, info) => resolve({ client: !!info.client, server: !!info.server }))
  })
  let bSawConnection = false
  B2.on('connection', () => {
    bSawConnection = true
  })

  B2.join(topic4b, { server: true, client: false })
  await B2.flush()
  A3.join(topic4b, { server: false, client: true })
  A3.joinPeer(bKeyPair.publicKey)

  let outboundResult = null
  try {
    outboundResult = await Promise.race([
      aOutboundConnected,
      delay(8000).then(() => 'timeout')
    ])
  } catch (err) {
    outboundResult = { error: err.message }
  }
  await delay(1000)

  record('4b-inverted-firewall-outbound-bypass', {
    aOutboundConnectFired: outboundResult !== 'timeout',
    aOutboundInfo: outboundResult === 'timeout' ? null : outboundResult,
    bSawConnection,
    interpretation:
      outboundResult !== 'timeout'
        ? 'A-outbound joinPeer connected despite local firewall rejecting inbound from B (firewall gates inbound only, as the design doc assumed)'
        : 'CONTRADICTS the design doc: A-outbound joinPeer to B did NOT connect while A\'s own firewall rejects B\'s key - the firewall blocks A\'s own outbound dial too, not just inbound. Confirmed symmetrically in an isolated repro (server-side firewall rejecting the client also blocks the connection). See design doc "Phase 3 -> Pinning" and pitfall 2 - "firewalls gate inbound only" is not accurate for hyperswarm@4.17.0/hyperdht@6.32.0.'
  })

  await A3.destroy()
  await B2.destroy()
}

async function scenario5(testnet) {
  const aKeyPair = crypto.keyPair()
  const bKeyPair = crypto.keyPair()
  const cKeyPair = crypto.keyPair()

  const pinnedHostKeys = new Set([b4a.toString(bKeyPair.publicKey, 'hex')])
  const hostingAnything = false // A is join-only in this scenario

  const A = makeSwarm(testnet, {
    keyPair: aKeyPair,
    firewall: (remotePublicKey) =>
      !(hostingAnything || pinnedHostKeys.has(b4a.toString(remotePublicKey, 'hex')))
  })
  const B = makeSwarm(testnet, { keyPair: bKeyPair })
  const C = makeSwarm(testnet, { keyPair: cKeyPair })

  let aSawConnectionFrom = []
  A.on('connection', (socket) => aSawConnectionFrom.push(b4a.toString(socket.remotePublicKey, 'hex')))

  // B is the pinned host: it must actually be listening (a plain joinPeer
  // never connects on this stack unless the target is a server via a
  // server-role topic join - see the isolated repro in the findings
  // write-up) for A's outbound joinPeer(B) to succeed.
  const topicAB = crypto.randomBytes(32)
  B.join(topicAB, { server: true, client: false })
  await B.flush()
  A.join(topicAB, { server: false, client: true })
  A.joinPeer(bKeyPair.publicKey)
  await waitFor(() => A.connections.size >= 1, 10000, 'scenario5 pinned B connects')
  const pinnedAdmitted = aSawConnectionFrom.includes(b4a.toString(bKeyPair.publicKey, 'hex'))

  // C is the unpinned attacker: A is join-only (hostingAnything = false)
  // and therefore never calls listen() via a server-role join, so A's DHT
  // server is not bound at all - C's joinPeer(A) cannot even reach A's
  // firewall callback; it is structurally unreachable, not merely
  // firewall-rejected. Recorded explicitly below as a finding in its own
  // right (see design doc "Phase 3 -> Pinning").
  C.joinPeer(aKeyPair.publicKey)
  let cReachedHandler = false
  let cJoinTimedOut = false
  try {
    await waitFor(
      () => aSawConnectionFrom.includes(b4a.toString(cKeyPair.publicKey, 'hex')),
      6000,
      'scenario5 unpinned C connects (expected to NOT happen)'
    )
    cReachedHandler = true
  } catch (err) {
    cJoinTimedOut = true
  }

  record('5-pinned-union-firewall', {
    pinnedAdmitted,
    cReachedHandler,
    cJoinTimedOutInstead: cJoinTimedOut,
    aConnectionsSize: A.connections.size,
    aWasListening: !!A.listening,
    aStillAlive: !A.destroyed,
    note:
      'A never calls a server-role join (hostingAnything=false), so A.listening is falsy and C cannot reach A at the DHT layer at all - rejection here is structural (not listening), not the union firewall function firing. The union firewall matters once A IS listening (hosting something else concurrently).'
  })

  await A.destroy()
  await B.destroy()
  await C.destroy()
}

async function runAll() {
  const testnet = await setupTestnet(5)
  await scenario1(testnet)
  await scenario2(testnet)
  await scenario3(testnet)
  await scenario4(testnet)
  await scenario5(testnet)
  await testnet.destroy()
  console.log('\n--- FULL OBSERVATION MATRIX ---')
  console.log(JSON.stringify(matrix, null, 2))
  console.log('\nSPIKE 3: OBSERVATION MATRIX COMPLETE')
  process.exit(0)
}

runAll().catch((err) => {
  console.error('SPIKE 3 FAILED (harness error, not a data outcome):', err.stack || err.message)
  console.log(JSON.stringify(matrix, null, 2))
  process.exit(1)
})
