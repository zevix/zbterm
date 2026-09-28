// The ShareBackend conformance suite (backend-abstraction R-11). Every case
// here is written against the contract in engine/backends/types.js only: it
// never names a backend, never reads `describe().id`, and never reaches into a
// backend's privates. A backend's own test file supplies `makePair` and calls
// `run`; the same cases then run against it unchanged.
//
// makePair() resolves to:
//   host, viewer  two backends on one network, constructed but NOT started
//   create()      one more unstarted backend on the same network
//   teardown()    stops every backend it handed out and the network itself
//
// The suite starts backends itself, with keypairs it mints, or hands them to a
// ShareManager, which starts them with the device's keypair.
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const brittle = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')

const ShareManager = require('../../engine/share-manager')
const { assertBackend, PATH } = require('../../engine/backends/types')
const { VERSION } = require('../../engine/schema')
const {
  loadOrCreateLocalDevice,
  sealEnvelope,
  openEnvelope,
  transportKeyPair
} = require('../../engine/crypto')
const { VIEW_LIVE, READ_HISTORY, QUICK_CATCHUP, SEND_INPUT } = require('../../engine/caps')

const LINK_PREFIX = 'zbterm://join/'
const CAPS = VIEW_LIVE | READ_HISTORY | QUICK_CATCHUP | SEND_INPUT
const PROTOCOL = 'conformance/ctl'
const BURST = 10000
// How long a negative case ("never connects") watches before it concludes.
// Every such case first proves, on the same network, that a permitted dial
// connects well inside this window.
const GRACE_MS = 750
// The revoked-link case's bound (D-16). A backend that is unreachable after
// withdraw (path b) has nothing to end the late join but ShareManager's
// JOIN_TIMEOUT_MS (30 s, engine/share-manager.js), which is also brittle's
// default test timeout; the case gets that plus room for its setup.
const REVOKED_JOIN_BOUND_MS = 60 * 1000

// `opts.only`, when given, lists the case texts (the titles without the
// '<name> backend conformance: ' prefix) to register; every other case is
// left out. For a backend that cannot pass the whole suite yet.
function run(name, makePair, opts = {}) {
  const title = (text) => `${name} backend conformance: ${text}`
  const test = (full, testOpts, fn) => {
    if (typeof testOpts === 'function') return test(full, {}, testOpts)
    if (opts.only && !opts.only.some((text) => title(text) === full)) return
    // brittle ends the whole file when a case throws. A case that throws is
    // failed here instead, so the cases after it still run and report.
    brittle(full, testOpts, async (t) => {
      try {
        await fn(t)
      } catch (err) {
        t.fail(`the case threw: ${(err && err.stack) || err}`)
      }
    })
  }

  test(title('start opens no swarm and announces nothing; double stop is safe'), async (t) => {
    const pair = await makePair()
    t.teardown(() => pair.teardown())
    const { host } = pair
    const keyPair = transportKeyPair()

    t.execution(() => assertBackend(host), 'the backend has every contract member')
    const descriptor = host.describe()
    t.is(typeof descriptor.id, 'string', 'describe() names the backend')
    t.is(descriptor.interfaceVersion, 1, 'describe() reports interface version 1')
    t.is(typeof descriptor.capabilities, 'number', 'describe() reports a capability bitset')

    t.alike(
      pick(host.health(), ['started', 'listening']),
      { started: false, listening: false },
      'a constructed backend is neither started nor listening'
    )
    let connections = 0
    host.on('connection', () => connections++)
    await host.start({ keyPair: () => keyPair })
    t.alike(
      pick(host.health(), ['started', 'listening']),
      { started: true, listening: false },
      'start() alone does not listen: nothing is announced and nothing dialed'
    )
    t.alike(host.localPeerKey(), keyPair.publicKey, 'localPeerKey() is the context key')
    t.is(connections, 0, 'start() produces no connection')

    await host.stop()
    await t.execution(host.stop(), 'a second stop() is safe')
    t.is(host.health().started, false, 'a stopped backend reports it')
  })

  test(title('announce then dial connects, and each side sees the other key'), async (t) => {
    const { host, viewer, keys } = await startedPair(t, makePair)
    host.setAdmission(true)
    const inbound = collectConnections(host)
    const outbound = collectConnections(viewer)

    const announcement = await host.announce('link-1')
    t.is(announcement.linkId, 'link-1', 'announce() echoes the link id')
    t.alike(
      JSON.parse(JSON.stringify(announcement.route)),
      announcement.route,
      'the minted route is JSON-safe'
    )
    t.is(host.health().listening, true, 'an announcing backend is listening')

    const dial = viewer.dial(announcement.route, keys.host.publicKey)
    const viewerConn = await dial.connected
    const hostConn = await inbound.next()

    t.alike(viewerConn.remotePeerKey, host.localPeerKey(), 'the viewer sees the host key')
    t.alike(hostConn.remotePeerKey, viewer.localPeerKey(), 'the host sees the viewer key')
    t.is(viewerConn.initiator, true, 'the dialing side is the initiator')
    t.is(hostConn.initiator, false, 'the accepting side is not')
    t.ok(Object.values(PATH).includes(viewerConn.path()), 'path() is one of PATH')
    t.is(viewerConn.closed, false, 'a fresh connection is open')
    t.is(inbound.count(), 1, "'connection' fired once on the accepting side")
    t.is(
      await outbound.next(),
      viewerConn,
      "the dialing side hears 'connection' for the same object"
    )
    t.is(outbound.count(), 1, 'once')

    dial.cancel()
    t.execution(() => dial.cancel(), 'cancel() is idempotent')
    t.is(viewerConn.closed, false, 'cancelling a connected dial never closes the connection')
  })

  test(title('a wrong expectedPeerKey never yields a connection'), async (t) => {
    const { host, viewer, keys } = await startedPair(t, makePair)
    host.setAdmission(true)
    const { route } = await host.announce('link-1')

    const stranger = transportKeyPair()
    const wrong = viewer.dial(route, stranger.publicKey)
    const wrongOutcome = outcomeOf(wrong.connected)

    // The control: the same route, dialed with the right key, does connect.
    const right = viewer.dial(route, keys.host.publicKey)
    const conn = await right.connected
    t.alike(conn.remotePeerKey, keys.host.publicKey, 'the right key connects')

    await delay(GRACE_MS)
    t.is(wrongOutcome.state, 'pending', 'the wrong-key dial surfaced no connection')
    wrong.cancel()
    await wrongOutcome.settled
    t.is(wrongOutcome.state, 'rejected', 'cancelling an unconnected dial rejects it')
  })

  // D-04: withdraw ends discovery of the route, not reachability of the host.
  // Whether a later dial of the route connects is the backend's business and
  // is deliberately not asserted either way; refusing a join on a revoked link
  // is ShareManager's job (see the revoked-link case below).
  test(
    title(
      'withdraw stops announcing the route, is idempotent, and an existing connection survives'
    ),
    async (t) => {
      const { host, viewer, keys } = await startedPair(t, makePair)
      host.setAdmission(true)
      const inbound = collectConnections(host)
      t.is(host.diagnostics().announced, 0, 'nothing is announced to begin with')
      const { route } = await host.announce('link-1')
      t.is(host.diagnostics().announced, 1, 'one link is announced')

      const viewerConn = await viewer.dial(route, keys.host.publicKey).connected
      const hostConn = await inbound.next()
      const echo = openEcho(hostConn)

      await host.withdraw('link-1')
      t.is(host.diagnostics().announced, 0, 'the route is no longer announced')
      await t.execution(host.withdraw('link-1'), 'withdrawing twice is safe')
      t.is(host.diagnostics().announced, 0, 'and changes nothing')
      await t.execution(host.withdraw('never-announced'), 'as is withdrawing an unknown link')

      t.is(viewerConn.closed, false, 'the earlier connection is still open')
      t.is(hostConn.closed, false, 'on both sides')
      const reply = await roundTrip(viewerConn, b4a.alloc(4, 1), { ping: 1 })
      t.alike(reply, { echo: { ping: 1 } }, 'and still carries messages both ways')
      t.is(echo.opened(), 1, 'over a channel opened after the withdraw')
    }
  )

  test(
    title('setAdmission(false) blocks inbound while a dial-pinned key still connects outbound'),
    async (t) => {
      const pair = await startedPair(t, makePair)
      const { host, viewer, keys } = pair
      // `host` admits nobody; `viewer` admits everybody.
      host.setAdmission(false)
      viewer.setAdmission(true)
      const hostInbound = collectConnections(host)
      const viewerInbound = collectConnections(viewer)
      const hostRoute = (await host.announce('link-h')).route
      const viewerRoute = (await viewer.announce('link-v')).route

      // A third peer knocks on the closed side for the whole case.
      const stranger = await startedExtra(pair)
      const blocked = stranger.backend.dial(hostRoute, keys.host.publicKey)
      const blockedOutcome = outcomeOf(blocked.connected)

      // The closed side can still dial out: the key it expects is pinned, so
      // its own policy does not stand in the way of the connection it asked
      // for. This is also the control for the negative half: a permitted
      // connection on this network is up before the grace period starts.
      const outbound = host.dial(viewerRoute, keys.viewer.publicKey)
      const conn = await outbound.connected
      t.alike(conn.remotePeerKey, keys.viewer.publicKey, 'the pinned key connects outbound')
      const accepted = await viewerInbound.next()
      t.alike(accepted.remotePeerKey, keys.host.publicKey, 'and the open side accepted it')

      await delay(GRACE_MS)
      t.is(blockedOutcome.state, 'pending', 'an inbound dial is not admitted')
      t.absent(
        hostInbound
          .all()
          .some((seen) => b4a.equals(seen.remotePeerKey, stranger.keyPair.publicKey)),
        "and the closed side saw no 'connection' from it"
      )
      blocked.cancel()
    }
  )

  test(title('two channels on one connection are independent'), async (t) => {
    const { viewerConn, hostConn } = await connectedPair(t, makePair)
    const idA = b4a.alloc(16, 0xa)
    const idB = b4a.alloc(16, 0xb)

    const hostSide = new Map()
    const announced = []
    hostConn.onChannel(PROTOCOL, (id) => {
      const key = b4a.toString(id, 'hex')
      announced.push(key)
      const entry = { received: [], closes: 0, channel: null }
      entry.channel = hostConn.openChannel(PROTOCOL, id, {
        onmessage: (message) => entry.received.push(message),
        onclose: () => entry.closes++
      })
      hostSide.set(key, entry)
    })

    const viewerA = openRecorded(viewerConn, idA)
    const viewerB = openRecorded(viewerConn, idB)
    viewerA.channel.send({ on: 'a', n: 1 })
    viewerB.channel.send({ on: 'b', n: 1 })
    viewerA.channel.send({ on: 'a', n: 2 })

    await until(() => hostSide.size === 2 && totalReceived(hostSide) === 3)
    const hostA = hostSide.get(b4a.toString(idA, 'hex'))
    const hostB = hostSide.get(b4a.toString(idB, 'hex'))
    t.alike(announced.slice().sort(), [idA, idB].map((id) => b4a.toString(id, 'hex')).sort())
    t.alike(
      hostA.received,
      [
        { on: 'a', n: 1 },
        { on: 'a', n: 2 }
      ],
      'channel A delivers only its own messages, in order'
    )
    t.alike(hostB.received, [{ on: 'b', n: 1 }], 'channel B delivers only its own')

    hostA.channel.send({ back: 'a' })
    hostB.channel.send({ back: 'b' })
    await until(() => viewerA.received.length === 1 && viewerB.received.length === 1)
    t.alike(viewerA.received, [{ back: 'a' }], 'replies come back on the channel they belong to')
    t.alike(viewerB.received, [{ back: 'b' }])

    // A replaced handler receives the next message.
    const replaced = []
    viewerB.channel.onmessage = (message) => replaced.push(message)
    hostB.channel.send({ back: 'b2' })
    await until(() => replaced.length === 1)
    t.alike(replaced, [{ back: 'b2' }], 'onmessage is replaceable')

    viewerA.channel.close()
    await until(() => hostA.closes === 1 && viewerA.closes() === 1)
    t.is(viewerA.channel.send({ late: true }), false, 'send() on a closed channel returns false')
    t.is(hostB.closes, 0, 'closing one channel leaves the other open')
    t.is(viewerConn.closed, false, 'and leaves the connection open')
    viewerB.channel.send({ on: 'b', n: 2 })
    await until(() => hostB.received.length === 2)
    t.alike(hostB.received[1], { on: 'b', n: 2 }, 'the surviving channel still delivers')
  })

  test(
    title(`a ${BURST}-message burst keeps per-channel order and reports backpressure`),
    async (t) => {
      const { viewerConn, hostConn } = await connectedPair(t, makePair)
      const id = b4a.alloc(16, 7)

      // Nothing here reads a clock: completion is the arrival of the last
      // message, whenever that is.
      let expected = 0
      let outOfOrder = 0
      const complete = new Promise((resolve) => {
        hostConn.onChannel(PROTOCOL, (channelId) => {
          hostConn.openChannel(PROTOCOL, channelId, {
            onmessage: (message) => {
              if (message.i !== expected) outOfOrder++
              expected++
              if (expected === BURST) resolve()
            }
          })
        })
      })

      const channel = viewerConn.openChannel(PROTOCOL, id, { onmessage: () => {} })
      let refused = 0
      for (let i = 0; i < BURST; i++) {
        if (channel.send({ i, pad: 'x'.repeat(64) }) === false) refused++
      }
      t.ok(refused > 0, 'send() returned false under backpressure during the burst')

      await complete
      t.is(expected, BURST, 'every message of the burst arrived')
      t.is(outOfOrder, 0, 'in the order it was sent')
    }
  )

  test(title("conn.close fires each channel's onclose once"), async (t) => {
    const { viewerConn, hostConn } = await connectedPair(t, makePair)
    const ids = [b4a.alloc(16, 1), b4a.alloc(16, 2)]

    const hostCloses = new Map()
    hostConn.onChannel(PROTOCOL, (id) => {
      const key = b4a.toString(id, 'hex')
      hostCloses.set(key, 0)
      hostConn.openChannel(PROTOCOL, id, {
        onmessage: () => {},
        onclose: () => hostCloses.set(key, hostCloses.get(key) + 1)
      })
    })
    const viewerChannels = ids.map((id) => openRecorded(viewerConn, id))
    for (const entry of viewerChannels) entry.channel.send({ hello: true })
    await until(() => hostCloses.size === 2)

    let hostConnCloses = 0
    let viewerConnCloses = 0
    hostConn.on('close', () => hostConnCloses++)
    viewerConn.on('close', () => viewerConnCloses++)

    viewerConn.close('conformance')
    await until(() => hostConnCloses === 1 && viewerConnCloses === 1)
    await until(() => Array.from(hostCloses.values()).every((n) => n >= 1))
    await until(() => viewerChannels.every((entry) => entry.closes() >= 1))
    // Let anything that would fire a second time do so before counting.
    await delay(50)

    t.alike(
      viewerChannels.map((entry) => entry.closes()),
      [1, 1],
      'each channel of the closing side heard onclose once'
    )
    t.alike(
      Array.from(hostCloses.values()),
      [1, 1],
      'each channel of the remote side heard onclose once'
    )
    t.is(viewerConn.closed, true, 'the closing side reports closed')
    t.is(hostConn.closed, true, 'the remote side reports closed')
    t.is(hostConnCloses + viewerConnCloses, 2, "'close' fired once per side")
    t.is(viewerChannels[0].channel.send({ late: true }), false, 'send() after close returns false')
  })

  test(
    title('serveHistory/attachHistory reach the target length; a second serveHistory is a no-op'),
    async (t) => {
      const { host, viewer, viewerConn, hostConn } = await connectedPair(t, makePair)
      const dir = await temp(t)
      const TARGET = 64

      const hostStore = {
        log: new Hypercore(path.join(dir, 'host-log')),
        metaCore: new Hypercore(path.join(dir, 'host-meta'))
      }
      await hostStore.log.ready()
      await hostStore.metaCore.ready()
      for (let i = 0; i < TARGET; i++) await hostStore.log.append(b4a.from(`block-${i}`))
      await hostStore.metaCore.append(b4a.from('meta-0'))
      const replicateCalls = countCalls(hostStore.log, 'replicate')

      const viewerStore = {
        log: new Hypercore(path.join(dir, 'viewer-log'), hostStore.log.key),
        metaCore: new Hypercore(path.join(dir, 'viewer-meta'), hostStore.metaCore.key)
      }
      await viewerStore.log.ready()
      await viewerStore.metaCore.ready()
      t.teardown(async () => {
        for (const store of [hostStore, viewerStore]) {
          await store.log.close().catch(() => {})
          await store.metaCore.close().catch(() => {})
        }
      })

      t.is(host.historyRouteFor(hostStore), null, 'history rides the connection: no extra route')

      host.serveHistory(hostConn, hostStore)
      t.is(replicateCalls(), 1, 'serveHistory attached the log once')
      host.serveHistory(hostConn, hostStore)
      t.is(replicateCalls(), 1, 'a second serveHistory for the same session is a no-op')

      const handle = viewer.attachHistory(viewerConn, viewerStore, {
        logKey: b4a.toString(hostStore.log.key, 'hex'),
        metaKey: b4a.toString(hostStore.metaCore.key, 'hex')
      })
      t.is(typeof handle.fetch, 'function', 'the handle can fetch a range')
      t.is(typeof handle.close, 'function', 'and can be closed')

      await until(
        () => viewerStore.log.length === TARGET && viewerStore.metaCore.length === 1,
        20000
      )
      await handle.fetch({ start: 0, end: TARGET }).done()
      t.is(viewerStore.log.length, TARGET, 'the viewer log reached the target length')
      t.is(viewerStore.log.contiguousLength, TARGET, 'with every block downloaded')
      t.alike(
        await viewerStore.log.get(TARGET - 1, { wait: false }),
        b4a.from(`block-${TARGET - 1}`),
        'and the last block is the host block'
      )
      t.alike(
        await viewerStore.metaCore.get(0),
        b4a.from('meta-0'),
        'the meta core replicated on the same connection'
      )
      t.execution(() => handle.close(), 'closing the handle is safe')
    }
  )

  test(title('diagnostics are JSON-safe and carry no secrets'), async (t) => {
    const { host, viewer, keys } = await connectedPair(t, makePair)
    for (const [role, backend] of [
      ['host', host],
      ['viewer', viewer]
    ]) {
      const diagnostics = backend.diagnostics()
      const text = JSON.stringify(diagnostics)
      t.alike(JSON.parse(text), diagnostics, `${role} diagnostics survive a JSON round trip`)
      const secret = keys[role].secretKey
      t.absent(
        text.includes(b4a.toString(secret, 'hex')) ||
          text.includes(b4a.toString(secret.subarray(0, 32), 'hex')) ||
          text.includes(b4a.toString(secret, 'base64')),
        `${role} diagnostics do not contain the transport secret key`
      )
      const health = backend.health()
      t.alike(JSON.parse(JSON.stringify(health)), health, `${role} health is JSON-safe`)
    }
  })

  test(
    title('a full ShareManager auto-join: bootstrap, data, rekey and sealed input'),
    async (t) => {
      const pair = await makePair()
      t.teardown(() => pair.teardown())
      const hostDevice = await loadOrCreateLocalDevice({ root: await temp(t) })
      const viewerDevice = await loadOrCreateLocalDevice({ root: await temp(t) })

      const ptyWrites = []
      const runtime = fullHostRuntime('session-a', hostDevice, viewerDevice, { freshKeys: true })
      runtime.inputMode = 'all'
      runtime.pty = { write: (input) => ptyWrites.push(input) }
      const hostErrors = []
      const hostManager = new ShareManager(
        {
          localDevice: hostDevice,
          buildLiveBootstrap: () => Promise.resolve({ seq: 1, cols: 80, rows: 24, data: 'boot' }),
          sessions: new Map([['session-a', runtime]])
        },
        { backend: pair.host }
      )
      hostManager.on('error', (err) => hostErrors.push(err))
      t.teardown(() => hostManager.close())

      const applied = { bootstrap: [], data: [] }
      const remoteSessions = new Map()
      const viewerErrors = []
      const viewerManager = new ShareManager(
        {
          localDevice: viewerDevice,
          remoteSessions,
          registerRemoteSession: (message) => {
            const remote = envelopeRemote(message, viewerDevice)
            remoteSessions.set(message.sessionId, remote)
            return Promise.resolve(remote)
          },
          applyRemoteBootstrap: (sessionId, bootstrap) => {
            applied.bootstrap.push({ sessionId, bootstrap })
            return Promise.resolve()
          },
          applyRemoteData: (sessionId, data) => {
            applied.data.push({ sessionId, text: b4a.toString(data, 'utf8') })
          },
          markRemoteOffline: () => Promise.resolve(),
          sessions: new Map()
        },
        { backend: pair.viewer }
      )
      viewerManager.on('error', (err) => viewerErrors.push(err))
      t.teardown(() => viewerManager.close())

      const link = await hostManager.createLink('session-a', { type: 'group' })
      const joined = waitForJoinChange(viewerManager, link.linkId)
      await viewerManager.join(link.uri)
      const status = await joined
      t.is(status.status, 'joined', 'the auto-join reaches joined')
      t.is(status.sessionId, 'session-a', 'for the shared session')

      // Bootstrap: sealed under the epoch the join minted, opened by the viewer
      // with the key it got from its own envelope.
      t.alike(
        applied.bootstrap,
        [{ sessionId: 'session-a', bootstrap: { seq: 1, cols: 80, rows: 24, data: 'boot' } }],
        'the viewer applied the live bootstrap the host built'
      )
      const remote = remoteSessions.get('session-a')
      t.is(remote.store.epoch, runtime.store.epoch, 'both sides are on the epoch the join minted')
      t.alike(remote.store.keys.liveKey, runtime.store.keys.liveKey, 'with the same live key')

      // Data.
      hostManager.broadcastData('session-a', b4a.from('hello viewer'))
      await until(() => applied.data.length === 1)
      t.alike(
        applied.data[0],
        { sessionId: 'session-a', text: 'hello viewer' },
        'live data is delivered and decrypted'
      )

      // Rekey: revoking some other member rotates the epoch and the live key;
      // the viewer only keeps up if it received and applied its envelope.
      const epochBefore = runtime.store.epoch
      const liveKeyBefore = runtime.store.keys.liveKey
      t.ok(await hostManager.revokeMember('session-a', 'ff'.repeat(32)), 'a member was revoked')
      t.is(runtime.store.epoch, epochBefore + 1, 'the host rotated the epoch')
      t.unlike(runtime.store.keys.liveKey, liveKeyBefore, 'to a new live key')
      await until(() => remote.store.epoch === runtime.store.epoch)
      t.alike(remote.store.keys.liveKey, runtime.store.keys.liveKey, 'the viewer applied the rekey')
      hostManager.broadcastData('session-a', b4a.from('after rekey'))
      await until(() => applied.data.length === 2)
      t.is(applied.data[1].text, 'after rekey', 'data under the new epoch is decrypted')

      // Sealed input, the way SessionEngine#input sends it.
      remote.message.send({ type: 'input', data: viewerManager.sealInput('session-a', 'ls -la\n') })
      await until(() => ptyWrites.length === 1)
      t.alike(ptyWrites, ['ls -la\n'], 'sealed input is opened by the host and reaches the pty')

      t.alike(hostErrors, [], 'the host raised no error')
      t.alike(viewerErrors, [], 'the viewer raised no error')
    }
  )

  // D-04: the security guarantee lives above the backend. Whatever a backend
  // does with a dial after the link is gone, a join on a revoked link is
  // refused and its peer receives no session data. revokeLink withdraws the
  // route (A-10); D-16 lets the refusal be in-band or a backend error.
  test(
    title('a join on a revoked link is refused and receives no bootstrap or session data'),
    { timeout: REVOKED_JOIN_BOUND_MS },
    async (t) => {
      const pair = await makePair()
      t.teardown(() => pair.teardown())
      const hostDevice = await loadOrCreateLocalDevice({ root: await temp(t) })
      const viewerDevice = await loadOrCreateLocalDevice({ root: await temp(t) })
      const lateDevice = await loadOrCreateLocalDevice({ root: await temp(t) })

      const hostDebug = []
      const runtime = fullHostRuntime('session-a', hostDevice, viewerDevice, { freshKeys: true })
      const hostManager = new ShareManager(
        {
          localDevice: hostDevice,
          buildLiveBootstrap: () => Promise.resolve({ seq: 1, cols: 80, rows: 24, data: 'boot' }),
          sessions: new Map([['session-a', runtime]])
        },
        { backend: pair.host }
      )
      hostManager.on('debug', (e) => hostDebug.push(e))
      t.teardown(() => hostManager.close())

      const viewer = recordingViewer(viewerDevice, pair.viewer)
      t.teardown(() => viewer.close())
      // A fresh third peer: on a backend that reuses a warm connection, or
      // that remembers a refused key, the first viewer would not be a fair
      // second attempt.
      const late = recordingViewer(lateDevice, pair.create())
      t.teardown(() => late.close())

      const link = await hostManager.createLink('session-a', { type: 'group' })
      const joined = waitForJoinChange(viewer.manager, link.linkId)
      await viewer.manager.join(link.uri)
      t.is((await joined).status, 'joined', 'the link works before it is revoked')
      t.is(viewer.applied.bootstrap.length, 1, 'and delivers the bootstrap')

      t.ok(await hostManager.revokeLink('session-a', link.linkId), 'the host revokes the link')

      const confirmsBefore = countDebug(hostDebug, 'host:join-confirm')
      const refused = waitForJoinChange(late.manager, link.linkId)
      await late.manager.join(link.uri)
      const status = await refused
      t.is(status.status, 'failed', 'a fresh peer joining with the same invite is refused')
      t.is(countDebug(hostDebug, 'host:join-confirm'), confirmsBefore, 'the host confirmed nothing')
      // D-16: how the join fails is the backend's. (a) A backend that stays
      // reachable by peer key after withdraw lets the host deny it in-band;
      // (b) one that becomes unreachable ends it with a backend error (or the
      // join timeout). The guarantee around this assertion is the same for both.
      const denied = hostDebug.some(
        (e) => e.event === 'host:join-deny' && e.details.reason === 'invalid-or-revoked'
      )
      t.comment(
        denied
          ? 'D-16 path (a): host:join-deny invalid-or-revoked'
          : `D-16 path (b): backend error ${status.code}`
      )
      t.ok(
        denied || (typeof status.code === 'string' && status.code.length > 0),
        'the host denied it because the link is revoked, or the backend refused it with an error'
      )

      hostManager.broadcastData('session-a', b4a.from('after revoke'))
      // Let anything that would wrongly arrive do so before counting.
      await delay(GRACE_MS)
      t.is(late.registered.length, 0, 'no remote session was registered for the refused peer')
      t.alike(late.applied, { bootstrap: [], data: [] }, 'it received no bootstrap and no data')
      t.alike(late.errors, [], 'and raised no error of its own')
    }
  )

  // Moved from test/share-manager-network.test.js (backend-abstraction B5).
  test(
    title(
      'a join whose invite hostDhtKey is forged to a different live peer never lets ' +
        'either party process a join-request'
    ),
    async (t) => {
      const pair = await makePair()
      t.teardown(() => pair.teardown())

      const hostDevice = await loadOrCreateLocalDevice({ root: await temp(t) })
      const adversaryDevice = await loadOrCreateLocalDevice({ root: await temp(t) })
      const viewerDevice = await loadOrCreateLocalDevice({ root: await temp(t) })

      const hostDebug = []
      const hostManager = new ShareManager(
        {
          localDevice: hostDevice,
          sessions: new Map([['session-a', minimalHostRuntime()]])
        },
        { backend: pair.host }
      )
      hostManager.on('debug', (e) => hostDebug.push(e.event))
      t.teardown(() => hostManager.close())

      // The adversary is a real, live, listening ShareManager hosting its own,
      // unrelated session - "a different live peer", not an unreachable one.
      // It never sees this test's real link/session at all.
      const adversaryDebug = []
      const adversaryManager = new ShareManager(
        {
          localDevice: adversaryDevice,
          sessions: new Map([['session-b', minimalHostRuntime()]])
        },
        { backend: pair.create() }
      )
      adversaryManager.on('debug', (e) => adversaryDebug.push(e.event))
      t.teardown(() => adversaryManager.close())
      await adversaryManager.createLink('session-b', { type: 'group' })

      const viewerManager = new ShareManager(
        { localDevice: viewerDevice, sessions: new Map() },
        { backend: pair.viewer }
      )
      t.teardown(() => {
        // ShareManager#close leaves a pending join's 30 s timeout armed, and a
        // join that never connected has nothing else to end it.
        for (const state of Array.from(viewerManager.joins.values())) state.settle()
        return viewerManager.close()
      })

      const realLink = await hostManager.createLink('session-a', { type: 'group' })

      // Forge the invite: keep the real topic/linkId (a genuine link the real
      // host is actually announcing), but swap hostDhtKey for the adversary's
      // real, live key - simulating a tampered/MITM'd invite string, which is
      // the only way a join ever ends up pinned to the wrong party. A link
      // whose route is not a topic keeps its real route the same way, in the
      // v2 spelling (engine/invite.js), without the host's claim.
      const adversaryKey = b4a.toString(adversaryDevice.dhtPublicKey, 'hex')
      const real = JSON.parse(
        Buffer.from(realLink.uri.slice(LINK_PREFIX.length), 'base64url').toString('utf8')
      )
      const forged = realLink.topic
        ? { v: VERSION, linkId: realLink.linkId, topic: realLink.topic, hostDhtKey: adversaryKey }
        : { v: real.v, b: real.b, linkId: realLink.linkId, peer: adversaryKey, route: real.route }
      const forgedUri = LINK_PREFIX + Buffer.from(JSON.stringify(forged)).toString('base64url')

      await viewerManager.join(forgedUri)

      // Give connections time to settle - generous for a local network.
      await waitFor(
        () =>
          hostDebug.includes('host:socket:connection') ||
          adversaryDebug.includes('host:socket:connection'),
        3000
      )
      await delay(500)

      t.absent(
        hostDebug.includes('host:join-request'),
        'the real topic owner never processes a join-request for this forged-invite join attempt'
      )
      t.absent(
        adversaryDebug.includes('host:join-request'),
        "the adversary's own linkIndex has no record of this link, so it never processes a " +
          'join-request either, even if the viewer (trusting the forged invite) sent one to it'
      )
    }
  )

  // Moved from test/share-manager-network.test.js (backend-abstraction B5).
  test(
    title('a single viewer identity can join two sessions hosted by the same host'),
    async (t) => {
      const { statusA, statusB, hostDebug } = await joinTwoSessions(t, makePair)
      t.is(statusA.status, 'joined', 'the first session join reaches joined')
      t.is(statusB.status, 'joined', 'the second session join (same host) also reaches joined')
      t.absent(
        hostDebug.some(
          (e) => e.event === 'host:socket:error' && /duplicate/i.test(e.details.message || '')
        ),
        'the host never tears down a socket as a duplicate connection (the Phase 1 regression this closes)'
      )
    }
  )
}

// One viewer identity joins two sessions of one host. Shared by the suite's
// case and by a backend's own file that wants to assert more about how the
// backend carried the two joins (eg. Pear's single deduped socket).
async function joinTwoSessions(t, makePair) {
  const pair = await makePair()
  t.teardown(() => pair.teardown())

  const hostDevice = await loadOrCreateLocalDevice({ root: await temp(t) })
  const viewerDevice = await loadOrCreateLocalDevice({ root: await temp(t) })

  const masterMaterial = {
    liveKey: b4a.alloc(32, 5),
    historyKey: b4a.alloc(32, 6)
  }

  const hostDebug = []
  const runtimeA = fullHostRuntime('session-a', hostDevice, viewerDevice, { masterMaterial })
  const runtimeB = fullHostRuntime('session-b', hostDevice, viewerDevice, { masterMaterial })
  const hostManager = new ShareManager(
    {
      localDevice: hostDevice,
      buildLiveBootstrap: () => Promise.resolve({ seq: 1, cols: 80, rows: 24, data: '' }),
      sessions: new Map([
        ['session-a', runtimeA],
        ['session-b', runtimeB]
      ])
    },
    { backend: pair.host }
  )
  hostManager.on('debug', (e) => hostDebug.push(e))
  t.teardown(() => hostManager.close())

  const remoteSessions = new Map()
  const viewerManager = new ShareManager(
    {
      localDevice: viewerDevice,
      remoteSessions,
      registerRemoteSession: (message) => {
        const remote = {
          store: {
            sessionId: message.sessionId,
            epoch: 1,
            keys: { liveKey: masterMaterial.liveKey, historyKey: masterMaterial.historyKey },
            writerDeviceKey: hostDevice.publicKey,
            log: { replicate: () => {}, download: () => Promise.resolve() },
            metaCore: { replicate: () => {}, download: () => Promise.resolve() }
          },
          inputMode: 'host'
        }
        remoteSessions.set(message.sessionId, remote)
        return Promise.resolve(remote)
      },
      applyRemoteBootstrap: () => Promise.resolve(),
      markRemoteOffline: () => Promise.resolve(),
      sessions: new Map()
    },
    { backend: pair.viewer }
  )
  t.teardown(() => viewerManager.close())

  const linkA = await hostManager.createLink('session-a', { type: 'group' })
  const linkB = await hostManager.createLink('session-b', { type: 'group' })

  const joinedA = waitForJoinChange(viewerManager, linkA.linkId)
  const joinedB = waitForJoinChange(viewerManager, linkB.linkId)
  await viewerManager.join(linkA.uri)
  await viewerManager.join(linkB.uri)

  const [statusA, statusB] = await Promise.all([joinedA, joinedB])
  return { statusA, statusB, hostDebug, hostManager, viewerManager }
}

// --- fixtures -------------------------------------------------------------

async function startedPair(t, makePair) {
  const pair = await makePair()
  t.teardown(() => pair.teardown())
  const keys = { host: transportKeyPair(), viewer: transportKeyPair() }
  await pair.host.start({ keyPair: () => keys.host })
  await pair.viewer.start({ keyPair: () => keys.viewer })
  return { ...pair, keys }
}

async function startedExtra(pair) {
  const keyPair = transportKeyPair()
  const backend = pair.create()
  await backend.start({ keyPair: () => keyPair })
  return { backend, keyPair }
}

async function connectedPair(t, makePair) {
  const pair = await startedPair(t, makePair)
  pair.host.setAdmission(true)
  const inbound = collectConnections(pair.host)
  const { route } = await pair.host.announce('link-1')
  const viewerConn = await pair.viewer.dial(route, pair.keys.host.publicKey).connected
  const hostConn = await inbound.next()
  return { ...pair, route, viewerConn, hostConn }
}

function collectConnections(backend) {
  const seen = []
  const waiting = []
  let taken = 0
  backend.on('connection', (conn) => {
    seen.push(conn)
    const waiter = waiting.shift()
    if (waiter) waiter(seen[taken++])
  })
  return {
    count: () => seen.length,
    all: () => seen.slice(),
    next: () =>
      new Promise((resolve) => {
        if (taken < seen.length) resolve(seen[taken++])
        else waiting.push(resolve)
      })
  }
}

function openRecorded(conn, id) {
  const received = []
  let closes = 0
  const channel = conn.openChannel(PROTOCOL, id, {
    onmessage: (message) => received.push(message),
    onclose: () => closes++
  })
  return { channel, received, closes: () => closes }
}

// The accepting side answers every message on every channel the remote opens.
function openEcho(conn) {
  let opened = 0
  conn.onChannel(PROTOCOL, (id) => {
    opened++
    const channel = conn.openChannel(PROTOCOL, id, {
      onmessage: (message) => channel.send({ echo: message })
    })
  })
  return { opened: () => opened }
}

function roundTrip(conn, id, message) {
  return new Promise((resolve) => {
    const channel = conn.openChannel(PROTOCOL, id, { onmessage: resolve })
    channel.send(message)
  })
}

function totalReceived(map) {
  let total = 0
  for (const entry of map.values()) total += entry.received.length
  return total
}

function countCalls(target, method) {
  let calls = 0
  const original = target[method]
  target[method] = function (...args) {
    calls++
    return original.apply(this, args)
  }
  return () => calls
}

function outcomeOf(promise) {
  const outcome = { state: 'pending', settled: null }
  outcome.settled = promise.then(
    () => {
      outcome.state = 'resolved'
    },
    () => {
      outcome.state = 'rejected'
    }
  )
  return outcome
}

function pick(source, fields) {
  const out = {}
  for (const field of fields) out[field] = source[field]
  return out
}

function minimalHostRuntime() {
  const metaStore = new Map()
  return {
    store: {
      timeline: [],
      meta: {
        put: (key, value) => Promise.resolve(metaStore.set(key, value)),
        get: (key) => Promise.resolve(metaStore.has(key) ? { value: metaStore.get(key) } : null)
      }
    }
  }
}

// A host runtime complete enough for a granted join. With `masterMaterial` the
// keys are fixed across epochs (the viewer stub knows them up front); with
// `freshKeys` every rotation mints a new live key, so the viewer can only keep
// up through the envelopes it is sent.
function fullHostRuntime(sessionId, hostDevice, viewerDevice, opts = {}) {
  const metaStore = new Map()
  const material = opts.masterMaterial || {
    liveKey: crypto.randomBytes(32),
    historyKey: crypto.randomBytes(32)
  }
  const store = {
    sessionId,
    epoch: 1,
    keys: { masterKey: null, historyKey: material.historyKey, liveKey: material.liveKey },
    info: { name: sessionId },
    log: { key: b4a.alloc(32, 1), replicate: () => {} },
    metaCore: { key: b4a.alloc(32, 2), replicate: () => {} },
    writerDeviceKey: hostDevice.publicKey,
    localDevice: hostDevice,
    timeline: [],
    putMember: () => Promise.resolve(),
    sealHistoryForMember: () => Promise.resolve(),
    getMember: () => Promise.resolve({ status: 'active' }),
    setMemberStatus: () => Promise.resolve(),
    listActiveMembers: () =>
      Promise.resolve([
        {
          identityKeyHex: b4a.toString(viewerDevice.identityPublicKey, 'hex'),
          deviceKeyHex: b4a.toString(viewerDevice.publicKey, 'hex'),
          caps: CAPS
        }
      ]),
    rotateEpoch: (members) => {
      const nextEpoch = store.epoch + 1
      if (opts.freshKeys) store.keys = { ...store.keys, liveKey: crypto.randomBytes(32) }
      const envelopes = new Map()
      for (const member of members) {
        const envelope = sealEnvelope(b4a.from(member.deviceKeyHex, 'hex'), {
          version: VERSION,
          sessionId,
          epoch: nextEpoch,
          caps: member.caps,
          masterKey: null,
          historyKey: store.keys.historyKey,
          liveKey: store.keys.liveKey
        })
        envelopes.set(member.deviceKeyHex, b4a.toString(envelope, 'hex'))
      }
      store.epoch = nextEpoch
      return Promise.resolve({ epoch: nextEpoch, envelopes })
    },
    meta: {
      put: (key, value) => Promise.resolve(metaStore.set(key, value)),
      get: (key) => Promise.resolve(metaStore.has(key) ? { value: metaStore.get(key) } : null)
    }
  }
  return { store, inputMode: 'host' }
}

// A viewer-side remote session whose keys come only from the envelopes the
// host seals for this device: the one in `confirm`, then one per rekey.
function envelopeRemote(message, viewerDevice) {
  const open = (envelopeHex) =>
    openEnvelope(viewerDevice.publicKey, viewerDevice.secretKey, b4a.from(envelopeHex, 'hex'))
  const first = open(message.envelope)
  const store = {
    sessionId: message.sessionId,
    epoch: first.epoch,
    keys: { liveKey: first.liveKey, historyKey: first.historyKey },
    writerDeviceKey: b4a.from(message.hostDeviceKey, 'hex'),
    log: { replicate: () => {}, download: () => Promise.resolve() },
    metaCore: { replicate: () => {}, download: () => Promise.resolve() },
    applyEpochEnvelope: (epoch, envelopeHex) => {
      const next = open(envelopeHex)
      if (next.epoch !== epoch) throw new Error('envelope epoch mismatch')
      store.epoch = next.epoch
      store.keys = { liveKey: next.liveKey, historyKey: next.historyKey }
      return Promise.resolve()
    }
  }
  return { store, inputMode: message.inputMode || 'host' }
}

// A viewer-side ShareManager that records everything the host gets through to
// it.
function recordingViewer(device, backend) {
  const applied = { bootstrap: [], data: [] }
  const registered = []
  const errors = []
  const remoteSessions = new Map()
  const manager = new ShareManager(
    {
      localDevice: device,
      remoteSessions,
      registerRemoteSession: (message) => {
        registered.push(message.sessionId)
        const remote = envelopeRemote(message, device)
        remoteSessions.set(message.sessionId, remote)
        return Promise.resolve(remote)
      },
      applyRemoteBootstrap: (sessionId, bootstrap) => {
        applied.bootstrap.push({ sessionId, bootstrap })
        return Promise.resolve()
      },
      applyRemoteData: (sessionId, data) => {
        applied.data.push({ sessionId, text: b4a.toString(data, 'utf8') })
      },
      markRemoteOffline: () => Promise.resolve(),
      sessions: new Map()
    },
    { backend }
  )
  manager.on('error', (err) => errors.push(err))
  return {
    manager,
    applied,
    registered,
    errors,
    close: () => {
      for (const state of Array.from(manager.joins.values())) state.settle()
      return manager.close()
    }
  }
}

function countDebug(events, name) {
  return events.filter((e) => e.event === name).length
}

function waitForJoinChange(manager, linkId) {
  return new Promise((resolve) => {
    manager.on('join:changed', (status) => {
      if (status.linkId !== linkId) return
      if (status.status === 'joined' || status.status === 'failed') resolve(status)
    })
  })
}

// Polls a condition; rejects (failing the test) rather than hanging.
function until(fn, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (fn()) return resolve()
      if (Date.now() - started >= timeoutMs) return reject(new Error('condition was never met'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

function waitFor(fn, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (fn() || Date.now() - started >= timeoutMs) return resolve()
      setTimeout(tick, 50)
    }
    tick()
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function temp(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-conformance-test-'))
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  return dir
}

module.exports = { run, joinTwoSessions }
