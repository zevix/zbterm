// Spike 2 - Protomux pairing + late replication attach.
// docs/PHASE0-WORK-PLAN.md, Spike 2. Exits 0 only if all assertions pass.
// Throwaway spike code, never imported by app code.
'use strict'
const os = require('os')
const path = require('path')
const fs = require('fs')
const Protomux = require('protomux')
const Hypercore = require('hypercore')
const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { setupTestnet, makeSwarm } = require('./testnet')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-spike2-'))
}

const PROTOCOL = 'zbterm/ctl'

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
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

function hostPairHandlerFactory(mux, onPair) {
  return (id) => {
    onPair(id)
    const channel = mux.createChannel({ protocol: PROTOCOL, id })
    const message = channel.addMessage({
      encoding: c.json,
      onmessage: (msg) => {
        if (msg.type === 'ping-a') message.send({ type: 'pong-a', n: msg.n })
        if (msg.type === 'ping-b') message.send({ type: 'pong-b', n: msg.n })
      }
    })
    channel.open()
    mux.userData = mux.userData || {}
    mux.userData[b4a.toString(id, 'hex')] = { channel, message }
  }
}

async function main() {
  const testnet = await setupTestnet(3)
  const hostKeyPair = crypto.keyPair()
  const viewerKeyPair = crypto.keyPair()

  const hostSwarm = makeSwarm(testnet, { keyPair: hostKeyPair })
  const viewerSwarm = makeSwarm(testnet, { keyPair: viewerKeyPair })

  // --- (a) pair fires for an unknown channel id ---------------------------
  const idA = crypto.randomBytes(16)
  let hostMux = null
  let hostSocket = null
  let viewerMux = null
  let viewerSocket = null

  const hostPairSeen = new Promise((resolve) => {
    hostSwarm.on('connection', (socket) => {
      hostSocket = socket
      const mux = Protomux.from(socket)
      hostMux = mux
      mux.pair({ protocol: PROTOCOL }, hostPairHandlerFactory(mux, resolve))
    })
  })

  const viewerConnected = new Promise((resolve) => {
    viewerSwarm.on('connection', (socket) => {
      viewerSocket = socket
      viewerMux = Protomux.from(socket)
      resolve()
    })
  })

  const topic = crypto.randomBytes(32)
  hostSwarm.join(topic, { server: true, client: false })
  await hostSwarm.flush()
  viewerSwarm.join(topic, { server: false, client: true })
  await viewerSwarm.flush()

  await viewerConnected

  let viewerReplyA
  const viewerChannelA = viewerMux.createChannel({ protocol: PROTOCOL, id: idA })
  const viewerMessageA = viewerChannelA.addMessage({
    encoding: c.json,
    onmessage: (msg) => {
      if (msg.type === 'pong-a') viewerReplyA = msg
    }
  })
  viewerChannelA.open()

  const receivedId = await hostPairSeen
  assert(b4a.equals(receivedId, idA), '(a) host pair callback id must equal idA')
  console.log('(a) OK: mux.pair fired with byte-equal id for unknown channel')

  viewerMessageA.send({ type: 'ping-a', n: 1 })
  await waitFor(() => viewerReplyA && viewerReplyA.n === 1, 5000, '(a) round trip reply')
  console.log('(a) OK: JSON message round-tripped both directions on channel A')

  // --- (b) late replication attach ----------------------------------------
  const hostCore = new Hypercore(tmpDir())
  await hostCore.ready()
  for (let i = 0; i < 50; i++) await hostCore.append(`block-${i}`)

  const viewerCore = new Hypercore(tmpDir(), hostCore.key)
  await viewerCore.ready()

  for (let i = 50; i < 100; i++) await hostCore.append(`block-${i}`)

  // Only now, after channel-A traffic completed, attach replication.
  hostCore.replicate(hostMux)
  viewerCore.replicate(viewerMux)

  const block99 = await Promise.race([
    viewerCore.get(99),
    new Promise((_, reject) => setTimeout(() => reject(new Error('core.get(99) timeout')), 10000))
  ])
  assert(b4a.equals(block99, b4a.from('block-99')), '(b) block 99 content mismatch')
  console.log('(b) OK: viewer core.get(99) resolved after late replicate() attach')

  const appendEvents = []
  viewerCore.on('append', () => appendEvents.push(Date.now()))
  for (let i = 100; i < 110; i++) await hostCore.append(`block-${i}`)
  await waitFor(() => viewerCore.length >= 110, 10000, '(b) live append propagation')
  const block109 = await viewerCore.get(109)
  assert(b4a.equals(block109, b4a.from('block-109')), '(b) live block 109 content mismatch')
  assert(appendEvents.length > 0, '(b) viewer core must observe append events for live blocks')
  console.log('(b) OK: 10 further live-appended blocks arrived via replication')

  // --- (c) channel independence -------------------------------------------
  assert(hostSwarm.connections.size === 1, '(c) host swarm must have exactly one connection')
  assert(viewerSwarm.connections.size === 1, '(c) viewer swarm must have exactly one connection')
  console.log('(c) OK: exactly one socket on both sides')

  const idB = crypto.randomBytes(16)
  // Re-pair on the same protocol key (Protomux keys `pair()` by
  // protocol+id, so this simply replaces the notify function) to catch
  // idB while still routing idA through the original handler.
  let hostPairBResolve
  const hostPairBSeen = new Promise((resolve) => {
    hostPairBResolve = resolve
  })
  hostMux.pair(
    { protocol: PROTOCOL },
    hostPairHandlerFactory(hostMux, (id) => {
      if (b4a.equals(id, idB)) hostPairBResolve(id)
    })
  )
  const viewerChannelB = viewerMux.createChannel({ protocol: PROTOCOL, id: idB })
  const viewerMessageB = viewerChannelB.addMessage({
    encoding: c.json,
    onmessage: () => {}
  })
  viewerChannelB.open()
  await hostPairBSeen

  const hostEntryA = hostMux.userData[b4a.toString(idA, 'hex')]
  const hostEntryB = hostMux.userData[b4a.toString(idB, 'hex')]
  const viewerRecvA = []
  const viewerRecvB = []

  // Replace host-side handlers to echo numbered messages back per channel.
  hostEntryA.message.onmessage = (msg) => {
    hostEntryA.message.send({ type: 'echo-a', n: msg.n })
  }
  hostEntryB.message.onmessage = (msg) => {
    hostEntryB.message.send({ type: 'echo-b', n: msg.n })
  }
  viewerMessageA.onmessage = (msg) => {
    if (msg.type === 'echo-a') viewerRecvA.push(msg.n)
  }
  viewerMessageB.onmessage = (msg) => {
    if (msg.type === 'echo-b') viewerRecvB.push(msg.n)
  }

  for (let i = 0; i < 100; i++) {
    viewerMessageA.send({ type: 'num-a', n: i })
    viewerMessageB.send({ type: 'num-b', n: i })
  }

  await waitFor(
    () => viewerRecvA.length === 100 && viewerRecvB.length === 100,
    10000,
    '(c) 100 messages per channel'
  )
  for (let i = 0; i < 100; i++) {
    assert(viewerRecvA[i] === i, `(c) channel A message ${i} out of order or wrong (${viewerRecvA[i]})`)
    assert(viewerRecvB[i] === i, `(c) channel B message ${i} out of order or wrong (${viewerRecvB[i]})`)
  }
  console.log('(c) OK: 100 numbered messages each on channels A and B, in order, no cross-talk')

  // Closing channel A must not disturb channel B or replication.
  viewerChannelA.close()
  await new Promise((resolve) => setTimeout(resolve, 500))
  viewerMessageB.send({ type: 'num-b', n: 999 })
  await waitFor(() => viewerRecvB.includes(999), 5000, '(c) channel B survives channel A close')
  assert(viewerCore.length >= 110, '(c) replication must be unaffected by channel A close')
  console.log('(c) OK: closing channel A left channel B and replication intact')

  await hostSwarm.destroy()
  await viewerSwarm.destroy()
  await testnet.destroy()
  await hostCore.close()
  await viewerCore.close()

  console.log('\nSPIKE 2: ALL ASSERTIONS PASSED')
  process.exit(0)
}

main().catch((err) => {
  console.error('SPIKE 2 FAILED:', err.stack || err.message)
  process.exit(1)
})
