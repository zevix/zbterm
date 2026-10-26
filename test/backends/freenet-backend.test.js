// The Freenet backend since K11 of zxterm-core (ZBTerm D-34): a proxy to the
// Freenet transport service of the Rust `zxterm-core` sidecar. Its announce,
// withdraw, dial, 'connection', admission, channels (framing, order,
// back-pressure) and live history (§8.1) are tested here through the proxy:
// every peer is a FreenetBackend with a sidecar of its own
// (test/helpers/zxterm-core.js::testCore), and all of them meet on one
// throwaway local-mode node (test/helpers/freenet-node.js, never the
// owner's), started by the first node test and stopped by the last. No ICE
// servers: host candidates only. Node tests skip when the `freenet` binary is
// not on PATH (A-7).
//
// What ran in this process before K11 and runs in the core now is tested
// there, in `zevix/zxterm` (named in each case below): the handshake checks
// of design §6 (fingerprint, signature, `re`), the pointer record, the
// per-link limits of design §7 layer 4 with a fake clock (S-22), the
// bootstrap channel (S-26) and the READY part (S-27). The cases here that
// stand for them check what the proxy owes: the core's verdicts, codes,
// details, debug events and counters reach the backend's callers unchanged.
// Those use a scripted core (FakeCore) in place of the sidecar.
//
// Every "never connects" case first proves that a permitted dial connects on
// the same node (the conformance suite's GRACE_MS rule).
const { EventEmitter } = require('events')
const crypto = require('crypto')
const test = require('brittle')

const { testCore } = require('../helpers/zxterm-core')

const FreenetBackend = require('../../engine/backends/freenet')
const { PATH } = require('../../engine/backends/types')
const { transportKeyPair } = require('../../engine/crypto')
const { freenetAvailable, startLocalNode, freePort } = require('../helpers/freenet-node')
const ShareManager = require('../../engine/share-manager')

// How long a negative case watches before it concludes (the plan's 5 s).
const NEVER_MS = 5000
const CONNECT_TIMEOUT_MS = 15000
const MAX_MESSAGE_SIZE = 65536

const hex = (bytes) => Buffer.from(bytes).toString('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function within(ms, promise, what) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function until(fn, ms = 10000, what = 'condition') {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`)
    await delay(25)
  }
}

function outcomeOf(promise) {
  const outcome = { state: 'pending', value: null, error: null, settled: null }
  outcome.settled = promise.then(
    (value) => {
      outcome.state = 'resolved'
      outcome.value = value
    },
    (err) => {
      outcome.state = 'rejected'
      outcome.error = err
    }
  )
  return outcome
}

let node = null

async function sharedNode() {
  if (!node) node = await startLocalNode()
  return node
}

// A started backend with its own key and its own sidecar. Every Chan frame
// its core is asked to send is recorded in `sent` (sizes).
async function peer(t) {
  const { url } = await sharedNode()
  const keyPair = transportKeyPair()
  const core = testCore(t)
  const sent = []
  const sendChan = core.sendChan.bind(core)
  core.sendChan = (chan, bytes) => {
    sent.push(bytes.byteLength)
    return sendChan(chan, bytes)
  }
  const backend = new FreenetBackend({ nodeUrl: url, core, iceServers: [] })
  const connections = []
  const debug = []
  backend.on('connection', (conn, info) => connections.push({ conn, info }))
  backend.on('debug', (e) => debug.push(e))
  t.teardown(() => backend.stop())
  await backend.start({ keyPair: () => keyPair })
  return { backend, keyPair, core, sent, connections, debug, hex: hex(keyPair.publicKey) }
}

// A permitted dial on the same node: host admits everyone it is told to.
async function connect(t, host, viewer, r) {
  const started = Date.now()
  const dial = viewer.backend.dial(r, host.keyPair.publicKey)
  const conn = await within(CONNECT_TIMEOUT_MS, dial.connected, 'connected')
  const ms = Date.now() - started
  const accepted = await until(
    () => host.connections.find(({ conn }) => hex(conn.remotePeerKey) === viewer.hex),
    CONNECT_TIMEOUT_MS,
    "the host's 'connection'"
  )
  return { dial, conn, hostConn: accepted.conn, info: accepted.info, ms }
}

function countDebug(p, event, pred = () => true) {
  return p.debug.filter((e) => e.event === event && pred(e.details || {})).length
}

// A scripted core in place of the sidecar: `request` answers from
// `handlers` (method -> fn(args)), `event()` plays a seam Event frame.
class FakeCore extends EventEmitter {
  constructor(handlers = {}) {
    super()
    this.calls = []
    this.sent = []
    this.handlers = {
      'freenet.start': () => ({ publicKey: 'ab'.repeat(32) }),
      'freenet.announce': ({ linkId }) => ({ route: { sig: `sig-${linkId}` }, linkId }),
      ...handlers
    }
    this._nextDial = 1
  }

  // Answers on a later tick, as the seam does; a handler runs at once, so
  // it can play events that arrive before the reply.
  request(method, args) {
    this.calls.push([method, args])
    const handler = this.handlers[method]
    try {
      if (handler) return Promise.resolve(handler(args))
      if (method === 'freenet.dial') return Promise.resolve({ dial: this._nextDial++ })
      return Promise.resolve(null)
    } catch (err) {
      return Promise.reject(err)
    }
  }

  called(method) {
    return this.calls.filter(([name]) => name === method).map(([, args]) => args)
  }

  sendChan(chan, bytes) {
    this.sent.push([chan, bytes])
    return true
  }

  event(name, data) {
    this.emit('event', { name, data })
  }
}

async function scripted(t, handlers) {
  const core = new FakeCore(handlers)
  const keyPair = transportKeyPair()
  const backend = new FreenetBackend({ nodeUrl: 'ws://127.0.0.1:1/v1/contract/command', core })
  const connections = []
  const debug = []
  backend.on('connection', (conn, info) => connections.push({ conn, info }))
  backend.on('debug', (e) => debug.push(e))
  t.teardown(() => backend.stop())
  await backend.start({ keyPair: () => keyPair })
  return { backend, core, keyPair, connections, debug }
}

// The route checks that ran in route.js before K11 run in the core now
// (`zxterm_core::freenet::route`, its unit tests and tests/freenet_parity.rs).
test('freenet: routes the core mints, and the checks it runs on a dialed route', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  const viewer = await peer(t)
  host.backend.setAdmission(true)

  const r = await host.backend.routeFor('link-a', null)
  t.alike(Object.keys(r).sort(), ['code', 'k', 'params', 'ptr', 'sig'], 'route shape')
  // Seam replies carry their JSON keys sorted; the core builds the
  // contract's parameter bytes in its own field order (ttl_ms, host, n, pv).
  // K14 (ZBTerm D-38): since the session protocol v2 (zxterm K13) the core
  // mints `pv: 2` into every route's params, and ZBTerm passes it through
  // without reading it (test/backends/freenet-pv.test.js pins the refusals).
  t.alike(Object.keys(r.params).sort(), ['host', 'n', 'pv', 'ttl_ms'], 'params fields')
  t.is(r.params.pv, 2, 'the route protocol version')
  t.is(r.params.ttl_ms, 120000)
  t.is(r.params.host, host.hex, 'params.host is the transport key')
  t.is(Buffer.from(r.params.n, 'base64url').length, 32, 'n is 32 bytes, base64url')
  t.is(Buffer.from(r.k, 'base64url').length, 32, 'k is 32 bytes, base64url')
  t.alike(JSON.parse(JSON.stringify(r)), r, 'the route is JSON-safe')
  t.is(host.backend.routeFor('link-a', { route: r }), r, 'a stored route is returned as it is')
  const other = await host.backend.routeFor('link-a', null)
  t.not(other.sig, r.sig, 'a second mint is a new instance')
  t.not(other.ptr, r.ptr, 'with its own pointer (F6)')

  await host.backend.announce('link-a', { route: r })
  const changedSig = viewer.backend.dial({ ...r, sig: r.ptr }, host.keyPair.publicKey)
  const changedOutcome = outcomeOf(changedSig.connected)
  await within(CONNECT_TIMEOUT_MS, changedOutcome.settled, 'the changed-sig dial settles')
  t.is(changedOutcome.state, 'rejected')
  t.is(changedOutcome.error.code, 'E_CORRUPT', 'a changed sig: E_CORRUPT')
  t.is(changedOutcome.error.details.backend, 'freenet')

  const stranger = transportKeyPair()
  const wrong = viewer.backend.dial(r, stranger.publicKey)
  const wrongOutcome = outcomeOf(wrong.connected)
  const { conn } = await connect(t, host, viewer, r)
  t.alike(conn.remotePeerKey, host.keyPair.publicKey, 'the control: the route itself connects')
  await delay(500)
  t.is(wrongOutcome.state, 'pending', 'a route for another host than expected stays pending')
  wrong.cancel()
  await wrongOutcome.settled
  t.is(wrongOutcome.state, 'rejected', 'until it is cancelled')

  for (const bad of [{}, { ...r, params: { ...r.params, n: 1 } }]) {
    const dial = viewer.backend.dial(bad, host.keyPair.publicKey)
    const outcome = outcomeOf(dial.connected)
    await within(CONNECT_TIMEOUT_MS, outcome.settled, 'a malformed route settles')
    t.is(outcome.state, 'rejected', 'a malformed route is rejected')
    t.ok(outcome.error.code, `with a code (${outcome.error.code})`)
  }
})

test('freenet: announce -> dial -> connection on both sides, with the right keys and path()', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  await sharedNode()
  t.not(node.port, 7509, `own node on port ${node.port} (pid ${node.pid})`)
  const host = await peer(t)
  const viewer = await peer(t)
  host.backend.setAdmission(true)

  const announcedAt = Date.now()
  const { route: r, linkId } = await host.backend.announce('link-a', { tag: { sessionId: 's' } })
  const announceMs = Date.now() - announcedAt
  t.is(linkId, 'link-a')
  t.is(host.backend.diagnostics().announced, 1, 'one link announced')
  t.is(host.backend.health().listening, true, 'listening while a link is subscribed')
  t.comment(`announce: ${announceMs} ms (Put + pointer Put + subscribe, in the core)`)
  const announced = host.debug.find((e) => e.event === 'host:announce')
  t.ok(announced && announced.details.sessionId === 's', "the core's debug event carries the tag")

  const { conn, hostConn, info, ms } = await connect(t, host, viewer, r)
  t.comment(`dial -> connected through a local-mode node, via two sidecars: ${ms} ms`)
  t.alike(conn.remotePeerKey, host.keyPair.publicKey, 'the viewer sees the host key')
  t.alike(hostConn.remotePeerKey, viewer.keyPair.publicKey, 'the host sees the viewer key')
  t.is(conn.initiator, true)
  t.is(hostConn.initiator, false)
  t.is(conn.path(), PATH.DIRECT, 'host candidates: DIRECT')
  t.is(hostConn.path(), PATH.DIRECT)
  t.is(viewer.connections.length, 1, "the viewer hears 'connection' once")
  t.is(viewer.connections[0].conn, conn, 'for the object connected resolved to')
  t.is(host.connections.length, 1, "the host hears 'connection' once")
  t.alike(info, { linkId: 'link-a' }, "the host's info names the link")
  t.alike(viewer.connections[0].info, { linkId: null }, "the viewer's names none")

  const diagnostics = await host.backend.refreshDiagnostics()
  const text = JSON.stringify(diagnostics)
  t.alike(JSON.parse(text), diagnostics, 'diagnostics() is JSON-safe')
  t.is(diagnostics.conns.length, 1)
  t.alike(diagnostics.conns[0], {
    channels: 0,
    iceState: 'connected',
    path: 'DIRECT',
    peer: viewer.hex
  })
  t.is(diagnostics.links.length, 1)
  t.alike(
    [diagnostics.links[0].linkId, diagnostics.links[0].instance],
    ['link-a', r.sig],
    'the link and its instance'
  )
  t.alike(
    [
      diagnostics.links[0].answeredLastMinute,
      diagnostics.links[0].halfOpen,
      diagnostics.links[0].refused
    ],
    [1, 0, 0]
  )
  t.absent(text.includes(r.k), 'no route secret k')
  t.absent(/sdp|fingerprint/i.test(text), 'no SDP')

  const closed = new Promise((resolve) => hostConn.once('close', resolve))
  conn.close()
  t.is(conn.closed, true, 'close() closes')
  await within(CONNECT_TIMEOUT_MS, closed, "the host's close")
  t.is(hostConn.closed, true, 'on both sides')
})

test('freenet: withdraw ends discovery, is idempotent, and the live connection survives', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  const viewer = await peer(t)
  const late = await peer(t)
  host.backend.setAdmission(true)
  t.is(host.backend.diagnostics().announced, 0)
  const { route: r } = await host.backend.announce('link-w')
  t.is(host.backend.diagnostics().announced, 1)
  const { conn, hostConn } = await connect(t, host, viewer, r)
  t.pass('the control: a permitted dial connected on this node')

  await host.backend.withdraw('link-w')
  t.is(host.backend.diagnostics().announced, 0, 'withdraw: 1 -> 0')
  t.is(host.backend.health().listening, false, 'nothing is listening any more')
  await host.backend.withdraw('link-w')
  await host.backend.withdraw('never-announced')
  t.is(host.backend.diagnostics().announced, 0, 'withdrawing twice, or an unknown link, is safe')
  const withdrawn = host.debug.filter((e) => e.event === 'host:withdraw')
  t.is(withdrawn.length, 1, 'the core withdrew the link once')
  t.ok(withdrawn[0].details.tombstones >= 1, 'and tombstoned its own entries')

  const offersBefore = countDebug(host, 'host:offer')
  const fresh = late.backend.dial(r, host.keyPair.publicKey)
  const outcome = outcomeOf(fresh.connected)
  await delay(NEVER_MS)
  t.is(outcome.state, 'pending', `a fresh dial after withdraw did not connect in ${NEVER_MS} ms`)
  t.is(countDebug(host, 'host:offer'), offersBefore, 'the host answered no offer for it')
  t.ok(
    countDebug(late, 'viewer:subscribed') >= 1,
    "although the viewer reached the link's instance"
  )
  fresh.cancel()
  await outcome.settled
  t.is(outcome.state, 'rejected', 'cancel rejects it')

  t.is(conn.closed, false, 'the earlier connection is open')
  t.is(hostConn.closed, false, 'on both sides')
  const states = []
  for (const p of [host, viewer]) {
    const diagnostics = await p.backend.refreshDiagnostics()
    states.push(diagnostics.conns.map((c) => c.iceState)[0] || null)
  }
  t.alike(states, ['connected', 'connected'], 'and both peer connections still report connected')
})

// The real check: zxterm's `crate::freenet::dial::check_fingerprint` (unit
// tests) and tests/rtc_parity.rs's four fingerprint_tamper_* cases.
test('freenet: (i) a dial the core refuses for a fingerprint mismatch rejects E_AUTH with its detail, and surfaces nothing', async (t) => {
  const p = await scripted(t)
  const dial = p.backend.dial({ sig: 'x' }, transportKeyPair().publicKey)
  const outcome = outcomeOf(dial.connected)
  await until(() => p.core.called('freenet.dial').length === 1, 2000, 'the dial request')
  p.core.event('freenet.debug', {
    event: 'viewer:fingerprint-mismatch',
    details: { peer: 'cd'.repeat(32) }
  })
  p.core.event('freenet.dialError', {
    dial: 1,
    code: 'E_AUTH',
    message:
      'The Freenet peer presented a certificate its signed SDP does not name: fingerprint mismatch'
  })
  await outcome.settled
  t.is(outcome.state, 'rejected')
  t.is(outcome.error.code, 'E_AUTH', 'the viewer rejects E_AUTH')
  t.is(outcome.error.details.detail, 'fingerprint mismatch')
  t.is(outcome.error.details.backend, 'freenet')
  t.is(p.connections.length, 0, "and fires no 'connection'")
  t.is(countDebug(p, 'viewer:fingerprint-mismatch'), 1, "the core's debug event is passed on")
  t.alike(
    p.core.called('freenet.cancelDial'),
    [{ dial: 1 }],
    'the failed dial is released in the core'
  )
})

test('freenet: (i) a peer connection the core reports failed rejects E_HOST_UNREACHABLE; a host-side mismatch surfaces nothing', async (t) => {
  const p = await scripted(t)
  const dial = p.backend.dial({ sig: 'x' }, transportKeyPair().publicKey)
  const outcome = outcomeOf(dial.connected)
  await until(() => p.core.called('freenet.dial').length === 1, 2000, 'the dial request')
  p.core.event('freenet.dialError', {
    dial: 1,
    code: 'E_HOST_UNREACHABLE',
    message: 'The Freenet peer connection failed: ice-failed'
  })
  await outcome.settled
  t.is(outcome.error.code, 'E_HOST_UNREACHABLE')
  t.is(outcome.error.details.detail, 'ice-failed')

  await p.backend.announce('link-ib2')
  p.core.event('freenet.debug', {
    event: 'host:fingerprint-mismatch',
    details: { peer: 'ef'.repeat(32) }
  })
  await delay(50)
  t.is(countDebug(p, 'host:fingerprint-mismatch'), 1, 'the host hears of the mismatch')
  t.is(p.connections.length, 0, "and fires no 'connection'")
})

// The real case: zxterm's backend.rs refuses an `h:` entry that does not
// verify under the expected key (`viewer:answer-refused`, reason
// `signature`), as index.js did (tests/freenet_parity.rs).
test('freenet: (ii) an answer the core ignores stays ignored: the dial stays pending and the refusal is counted', async (t) => {
  let refused = 0
  const p = await scripted(t, {
    'freenet.diagnostics': () => ({ links: [], conns: [], refused })
  })
  const dial = p.backend.dial({ sig: 'x' }, transportKeyPair().publicKey)
  const outcome = outcomeOf(dial.connected)
  await until(() => p.core.called('freenet.dial').length === 1, 2000, 'the dial request')
  refused++
  p.core.event('freenet.debug', {
    event: 'viewer:answer-refused',
    details: { reason: 'signature' }
  })
  t.is((await p.backend.refreshDiagnostics()).refused, 1, "the core's count reaches diagnostics()")
  t.ok(
    p.debug.some((e) => e.event === 'viewer:answer-refused' && e.details.reason === 'signature'),
    'as a bad signature'
  )
  await delay(200)
  t.is(outcome.state, 'pending', 'no connection')
  t.is(p.connections.length, 0)
  dial.cancel()
  await outcome.settled
  t.is(outcome.state, 'rejected', 'cancel rejects it')
  t.alike(p.core.called('freenet.cancelDial'), [{ dial: 1 }], 'and cancels it in the core')
})

// The proxy's own ordering rule: the core may report a dial's outcome in the
// same socket read as the reply naming the dial.
test('freenet: (iii) a dial outcome that arrives before the reply to freenet.dial is kept for that dial', async (t) => {
  let core = null
  const p = await scripted(t, {
    'freenet.dial': () => {
      core.event('freenet.dialConnected', { dial: 7, conn: 3 })
      core.event('freenet.connection', {
        conn: 3,
        remotePeerKey: 'cd'.repeat(32),
        initiator: true,
        linkId: null,
        path: 'DIRECT'
      })
      return { dial: 7 }
    }
  })
  core = p.core
  const expected = Buffer.from('cd'.repeat(32), 'hex')
  const conn = await within(2000, p.backend.dial({ sig: 'x' }, expected).connected, 'connected')
  t.alike(conn.remotePeerKey, expected, 'the dial resolved with its connection')
  t.is(conn.initiator, true)
  t.is(p.connections.length, 1, "'connection' fired once")
  t.is(p.connections[0].conn, conn, 'for the same object')

  // A second dial whose error comes first.
  let second = null
  p.core.handlers['freenet.dial'] = () => {
    core.event('freenet.dialError', { dial: 8, code: 'E_CORRUPT', message: 'bad route: sig' })
    return { dial: 8 }
  }
  second = outcomeOf(p.backend.dial({ sig: 'y' }, expected).connected)
  await within(2000, second.settled, 'the second dial settles')
  t.is(second.error.code, 'E_CORRUPT', 'an early error is kept too')
})

test('freenet: (iv) setAdmission(false) answers nothing; true again and the same key connects', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  const control = await peer(t)
  const viewer = await peer(t)
  host.backend.setAdmission([control.keyPair.publicKey])
  const { route: r } = await host.backend.announce('link-iv')
  await connect(t, host, control, r)
  t.pass('the control: a key on the admission list connected on this node')

  host.backend.setAdmission(() => false)
  const offersBefore = countDebug(host, 'host:offer')
  const refusedBefore = (await host.backend.refreshDiagnostics()).refused
  const dial = viewer.backend.dial(r, host.keyPair.publicKey)
  const outcome = outcomeOf(dial.connected)
  await until(
    () => countDebug(host, 'host:offer-refused', (d) => d.peer === viewer.hex) > 0,
    CONNECT_TIMEOUT_MS,
    'the host evaluates the offer'
  )
  await delay(NEVER_MS)
  t.is(countDebug(host, 'host:offer'), offersBefore, 'no offer answered on the host side')
  t.is(
    (await host.backend.refreshDiagnostics()).refused,
    refusedBefore + 1,
    'the refusal is counted'
  )
  t.is(outcome.state, 'pending', `no connection within ${NEVER_MS} ms`)
  dial.cancel()
  await outcome.settled

  host.backend.setAdmission(true)
  const again = await connect(t, host, viewer, r)
  t.alike(
    again.hostConn.remotePeerKey,
    viewer.keyPair.publicKey,
    'the same viewer key connects: not sticky'
  )
  t.is(countDebug(host, 'host:offer'), offersBefore + 1, 'with one host-side peer connection')
})

// The real case: zxterm's tests/freenet_backend.rs::
// a_dial_with_an_unknown_code_follows_the_pointer_record.
test('freenet: a route whose code this build lacks: the core reads its pointer record, and its verdict is passed on', async (t) => {
  const p = await scripted(t)
  const dial = p.backend.dial(
    { sig: 'x', code: 'ab'.repeat(32), ptr: 'p' },
    transportKeyPair().publicKey
  )
  const outcome = outcomeOf(dial.connected)
  await until(() => p.core.called('freenet.dial').length === 1, 2000, 'the dial request')
  const [args] = p.core.called('freenet.dial')
  t.alike(
    args.route,
    { sig: 'x', code: 'ab'.repeat(32), ptr: 'p' },
    'the route reaches the core as it is'
  )
  p.core.event('freenet.debug', {
    event: 'viewer:route-refused',
    details: { code: 'E_BACKEND_UNSUPPORTED', detail: 'unknown contract code' }
  })
  p.core.event('freenet.debug', { event: 'viewer:pointer', details: { ver: 1, instance: 'x' } })
  p.core.event('freenet.dialError', {
    dial: 1,
    code: 'E_BACKEND_UNSUPPORTED',
    message:
      'The Freenet route uses a signalling contract this build does not ship: unknown contract code'
  })
  await outcome.settled
  t.is(
    outcome.error.code,
    'E_BACKEND_UNSUPPORTED',
    'still unknown after the pointer: E_BACKEND_UNSUPPORTED'
  )
  t.ok(
    p.debug.some(
      (e) => e.event === 'viewer:route-refused' && e.details.detail === 'unknown contract code'
    ),
    'the route was refused for its code'
  )
  t.ok(
    p.debug.some((e) => e.event === 'viewer:pointer' && e.details.ver === 1),
    'and the pointer record was read'
  )

  const wrong = p.backend.dial({ sig: 'x' }, transportKeyPair().publicKey)
  const wrongOutcome = outcomeOf(wrong.connected)
  await delay(200)
  t.is(wrongOutcome.state, 'pending', 'a dial the core says nothing about stays pending')
  wrong.cancel()
  await wrongOutcome.settled
  t.is(wrongOutcome.state, 'rejected')
})

test('freenet: announce and dial made while start() is still opening wait for it (S-23)', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const { url } = await sharedNode()
  const make = () => {
    const backend = new FreenetBackend({ nodeUrl: url, core: testCore(t), iceServers: [] })
    t.teardown(() => backend.stop())
    return { backend, keyPair: transportKeyPair() }
  }
  const host = make()
  const viewer = make()
  host.backend.setAdmission(true)
  // As ShareManager does it: start() is not awaited.
  const hostStarted = host.backend.start({ keyPair: () => host.keyPair })
  const { route: r } = await host.backend.announce('link-early')
  t.pass('announce() waited for start()')
  await hostStarted
  viewer.backend.start({ keyPair: () => viewer.keyPair })
  const conn = await within(
    CONNECT_TIMEOUT_MS,
    viewer.backend.dial(r, host.keyPair.publicKey).connected,
    'connected'
  )
  t.alike(conn.remotePeerKey, host.keyPair.publicKey, 'and so did dial()')
  const idle = make().backend
  await t.exception(
    idle.announce('link-none'),
    /not started/,
    'with no start() under way: not started'
  )
})

const CHANNEL = 'zbterm/f7-test'
const now = () => performance.now()

test('freenet: a 200 KiB JSON message crosses a channel intact, in parts of at most 65 536 bytes', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  const viewer = await peer(t)
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-big')
  const { conn, hostConn } = await connect(t, host, viewer, r)

  const received = []
  const closes = { host: 0, viewer: 0 }
  const arrived = new Promise((resolve) => {
    hostConn.onChannel(CHANNEL, (id) => {
      hostConn.openChannel(CHANNEL, id, {
        onmessage: (message) => {
          received.push(message)
          resolve()
        },
        onclose: () => closes.host++
      })
    })
  })
  const id = Buffer.from('big')
  const channel = conn.openChannel(CHANNEL, id, {
    onmessage: () => {},
    onclose: () => closes.viewer++
  })
  t.exception(
    () => conn.openChannel(CHANNEL, id, {}),
    /already open/,
    'the same (protocol, id) twice on one connection is an error, not a reuse'
  )
  const message = { n: 1, blob: crypto.randomBytes(150 * 1024).toString('base64') }
  const bytes = Buffer.byteLength(JSON.stringify(message))
  t.ok(bytes >= 200 * 1024, `a ${bytes}-byte JSON message`)
  viewer.sent.length = 0
  const sentAt = now()
  channel.send(message)
  t.pass('send() takes it')
  await within(CONNECT_TIMEOUT_MS, arrived, 'the 200 KiB message')
  const ms = now() - sentAt
  t.alike(received, [message], 'it arrived intact, once')
  t.is(
    viewer.sent.length,
    Math.ceil(bytes / (MAX_MESSAGE_SIZE - 5)),
    `in ${viewer.sent.length} parts`
  )
  t.ok(
    viewer.sent.every((size) => size <= MAX_MESSAGE_SIZE),
    `none above 65 536 bytes (largest ${Math.max(...viewer.sent)})`
  )
  t.comment(`200 KiB JSON message: send() -> onmessage ${ms.toFixed(1)} ms`)
  t.is(
    (await host.backend.refreshDiagnostics()).conns[0].channels,
    1,
    'diagnostics() counts the channel'
  )

  channel.close()
  await until(() => closes.host === 1 && closes.viewer === 1, CONNECT_TIMEOUT_MS, 'both onclose')
  await delay(50)
  t.alike(closes, { host: 1, viewer: 1 }, 'onclose fired once on each side')
  t.is(channel.send({ late: true }), false, 'send() on a closed channel returns false')
  t.is(conn.closed, false, 'the connection stays open')
})

test('freenet: a 10 000-message burst arrives in order, and send() returns false under back-pressure', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const BURST = 10000
  const host = await peer(t)
  const viewer = await peer(t)
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-burst')
  const { conn, hostConn } = await connect(t, host, viewer, r)

  const counters = new Map()
  const arrivals = new Map()
  hostConn.onChannel(CHANNEL, (id) => {
    const key = id.toString()
    counters.set(key, { expected: 0, outOfOrder: 0 })
    hostConn.openChannel(CHANNEL, id, {
      onmessage: (message) => {
        const counter = counters.get(key)
        if (message.i !== counter.expected) counter.outOfOrder++
        counter.expected++
        if (counter.expected === BURST) arrivals.get(key)()
      }
    })
  })
  const burst = async (key) => {
    const complete = new Promise((resolve) => arrivals.set(key, resolve))
    const channel = conn.openChannel(CHANNEL, Buffer.from(key), { onmessage: () => {} })
    if (key === 'second') await until(() => channel._chan !== null, 5000, 'open')
    let refused = 0
    let bytes = 0
    let heldHigh = 0
    const started = now()
    for (let i = 0; i < BURST; i++) {
      const message = { i, pad: 'x'.repeat(64) }
      bytes += Buffer.byteLength(JSON.stringify(message))
      if (channel.send(message) === false) refused++
      if (channel._outBytes > heldHigh) heldHigh = channel._outBytes
    }
    await within(30000, complete, `the ${key} burst`)
    const ms = now() - started
    return { channel, refused, bytes, ms, heldHigh, counter: counters.get(key) }
  }

  // As the conformance case sends it: right after openChannel.
  const first = await burst('first')
  t.ok(first.refused > 0, `send() returned false ${first.refused} times`)
  t.is(first.counter.expected, BURST, 'every message arrived')
  t.is(first.counter.outOfOrder, 0, 'in the order it was sent')
  t.ok(
    first.heldHigh <= 1024 * 1024,
    `this process held at most 1 MiB for the channel (${first.heldHigh} bytes)`
  )
  const rate = (run) =>
    `${Math.round((BURST / run.ms) * 1000)} msg/s, ${(run.bytes / 1048576 / (run.ms / 1000)).toFixed(2)} MiB/s of JSON`
  t.comment(
    `burst right after openChannel: ${BURST} messages (${first.bytes} bytes of JSON) in ${first.ms.toFixed(0)} ms = ${rate(first)}; ` +
      `send() false ${first.refused}x; held before the handle ${first.heldHigh} bytes`
  )

  // Reported, not gated: the same burst on a channel that is already open.
  const second = await burst('second')
  t.is(second.counter.outOfOrder, 0, 'a burst on an open channel keeps its order too')
  t.comment(
    `burst on an open channel: ${second.ms.toFixed(0)} ms = ${rate(second)}; send() false ${second.refused}x`
  )
})

// The real limits, with a fake clock: zxterm's tests/freenet_backend.rs::
// admission_refusals_half_open_viewer_half_open_and_rate.
test('freenet: an offer above MAX_HALF_OPEN on one link gets no answer', async (t) => {
  const { MAX_HALF_OPEN } = FreenetBackend
  t.is(MAX_HALF_OPEN, 8, 'A-12: 8 half-open peer connections per link')
  const link = { linkId: 'link-half', instance: 'sig-link-half', entries: 9 }
  let diag = {
    links: [{ ...link, answeredLastMinute: 8, halfOpen: 8, refused: 0 }],
    conns: [],
    refused: 0
  }
  const p = await scripted(t, { 'freenet.diagnostics': () => diag })
  await p.backend.announce('link-half')
  t.is(
    (await p.backend.refreshDiagnostics()).links[0].halfOpen,
    MAX_HALF_OPEN,
    `${MAX_HALF_OPEN} answered peer connections, none up`
  )

  diag = {
    links: [{ ...link, answeredLastMinute: 8, halfOpen: 8, refused: 1 }],
    conns: [],
    refused: 1
  }
  p.core.event('freenet.debug', {
    event: 'host:offer-refused',
    details: { linkId: 'link-half', peer: 'cd'.repeat(32), reason: 'half-open' }
  })
  await delay(20)
  t.is(
    countDebug(p, 'host:offer-refused', (d) => d.reason === 'half-open'),
    1,
    'refused: half-open'
  )
  const diagnostics = await p.backend.refreshDiagnostics()
  t.is(diagnostics.links[0].refused, 1, "counted in the link's refused")
  t.is(diagnostics.refused, 1, 'and in the backend total')
  t.is(diagnostics.announced, 1, 'one link announced')
  t.is(p.connections.length, 0, 'no connection for the offer above the limit')
})

test("freenet: a link above MAX_ANSWERS_PER_MINUTE answers nothing until the window passes (the core's clock)", async (t) => {
  const { MAX_ANSWERS_PER_MINUTE, ANSWER_WINDOW_MS } = FreenetBackend
  t.is(MAX_ANSWERS_PER_MINUTE, 30, 'A-12: 30 answered offers per link per minute')
  t.is(ANSWER_WINDOW_MS, 60000, 'over a 60 s window')
  const p = await scripted(t, {
    'freenet.diagnostics': () => ({
      links: [{ linkId: 'link-rate', answeredLastMinute: 30, halfOpen: 0, refused: 2 }],
      conns: [],
      refused: 2
    })
  })
  await p.backend.announce('link-rate')
  for (let i = 0; i < 2; i++) {
    p.core.event('freenet.debug', {
      event: 'host:offer-refused',
      details: { linkId: 'link-rate', peer: 'cd'.repeat(32), reason: 'rate' }
    })
  }
  await delay(20)
  t.is(
    countDebug(p, 'host:offer-refused', (d) => d.reason === 'rate'),
    2,
    'both refusals reach the caller'
  )
  const diagnostics = await p.backend.refreshDiagnostics()
  t.is(
    diagnostics.links[0].answeredLastMinute,
    MAX_ANSWERS_PER_MINUTE,
    `${MAX_ANSWERS_PER_MINUTE} answered`
  )
  t.is(diagnostics.links[0].refused, 2, 'both refusals counted')
})

// S-22 with the core's fake clock: zxterm's tests/freenet_backend.rs::
// admission_refusals_half_open_viewer_half_open_and_rate
// (host:half-open-expired).
test('freenet: a viewer holding 2 stale offers cannot block other viewers, and stale slots expire (S-22)', async (t) => {
  const { HALF_OPEN_TIMEOUT_MS, MAX_HALF_OPEN_PER_VIEWER, MAX_HALF_OPEN } = FreenetBackend
  t.is(HALF_OPEN_TIMEOUT_MS, 15000, 'S-22: 15 s half-open deadline')
  t.is(MAX_HALF_OPEN_PER_VIEWER, 2, 'S-22: 2 of the 8 slots per viewer key')
  t.ok(MAX_HALF_OPEN > 2 * MAX_HALF_OPEN_PER_VIEWER, 'so two stale holders leave room')
  const p = await scripted(t)
  await p.backend.announce('link-stale')
  const holder = 'cd'.repeat(32)
  p.core.event('freenet.debug', {
    event: 'host:offer-refused',
    details: { linkId: 'link-stale', peer: holder, reason: 'half-open-viewer' }
  })
  for (let i = 0; i < 4; i++) {
    p.core.event('freenet.debug', {
      event: 'host:half-open-expired',
      details: { linkId: 'link-stale', peer: holder }
    })
  }
  await delay(20)
  t.is(
    countDebug(p, 'host:offer-refused', (d) => d.reason === 'half-open-viewer'),
    1,
    "the holder's third offer is refused"
  )
  t.is(countDebug(p, 'host:half-open-expired'), 4, 'every stale peer connection expired')
  t.is(p.connections.length, 0)
})

// A-11 (F9): share.backends asks the node itself, through the core. A live
// local-mode node is `available`; a closed port is `broken`, naming the
// address.
test('freenet: probe() is available with a node and names the address without one (A-11)', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const { url } = await sharedNode()
  const core = testCore(t)
  t.alike(await FreenetBackend.probe({ nodeUrl: url, core }), { state: 'available', detail: null })
  const port = await freePort()
  t.alike(
    await FreenetBackend.probe({ nodeUrl: `ws://127.0.0.1:${port}/v1/contract/command`, core }),
    {
      state: 'broken',
      detail: `no Freenet node at ws://127.0.0.1:${port} — see README "Freenet"`
    }
  )

  const manager = new ShareManager(null, { backendOptions: { nodeUrl: url, core } })
  t.teardown(() => manager.close())
  const info = await manager.probedBackendsInfo()
  const freenet = info.backends.find((entry) => entry.id === 'freenet')
  t.alike([freenet.state, freenet.detail], ['available', null], 'share.backends: available')
  t.is(info.active, null, 'probing activated nothing')
})

// F8 (design §8.1) carried live history over one extra raw channel of the
// connection. Since K17 of zxterm-core (ZBTerm D-40) a session's history is the
// core's, served on the session protocol's own `history` channel (its
// content is test/freenet-history.test.js's, end to end): the backend is asked
// for nothing, opens no channel for it and sends no message on the connection.
test(
  "freenet: history is the core's: serving one asks the core for nothing and uses no channel or message of the connection",
  { timeout: 60000 },
  async (t) => {
    if (!freenetAvailable()) {
      t.skip('freenet binary not on PATH')
      return
    }
    const host = await peer(t)
    const viewer = await peer(t)
    host.backend.setAdmission(true)
    const { route: r } = await host.backend.announce('link-history')
    const { conn, hostConn } = await connect(t, host, viewer, r)

    const requests = []
    const request = host.core.request.bind(host.core)
    host.core.request = (method, args) => {
      requests.push(method)
      return request(method, args)
    }
    host.sent.length = 0
    let surfaced = 0
    conn.onChannel('zxterm/history', () => surfaced++)
    hostConn.onChannel('zxterm/history', () => surfaced++)

    const hostStore = { sessionId: 'session-h', historyVerifyingKey: null }
    host.backend.serveHistory(hostConn, hostStore)
    host.backend.serveHistory(hostConn, hostStore)
    t.alike(requests, [], "serving a history asks the host's core for nothing: it serves it itself")

    const viewerStore = { sessionId: 'session-h', availableLength: () => Promise.resolve(0) }
    const handle = viewer.backend.attachHistory(conn, viewerStore, {})
    await within(5000, handle.fetch({ start: 0, end: 0 }).done(), 'an empty history fetch')
    t.is(host.sent.length, 0, 'no data-channel message was sent on the connection')
    t.is(surfaced, 0, 'no history channel reaches an onChannel listener')
    t.is(host.backend.historyRouteFor(hostStore), null, 'and there is no route to a contract yet')
    handle.close()
  }
)

// Two dials from one key to one host, as ShareManager makes for two
// sessions: both connect, and each connection carries its own session's
// history. (S-26's candidate ordering is the core's now: zxterm's
// backend.rs holds a dial's own candidates until its answer is applied.)
test(
  'freenet: two dials from one key to one host both connect, and each connection attaches its own history (S-26)',
  { timeout: 90000 },
  async (t) => {
    if (!freenetAvailable()) {
      t.skip('freenet binary not on PATH')
      return
    }
    const host = await peer(t)
    const viewer = await peer(t)
    host.backend.setAdmission(true)

    const { route: ra } = await host.backend.announce('link-a')
    const { route: rb } = await host.backend.announce('link-b')
    const dials = [ra, rb].map((r) => viewer.backend.dial(r, host.keyPair.publicKey))
    const conns = await within(
      CONNECT_TIMEOUT_MS * 2,
      Promise.all(dials.map((dial) => dial.connected)),
      'both dials connected'
    )
    await until(() => host.connections.length === 2, CONNECT_TIMEOUT_MS, "both 'connection's")
    t.is(conns.length, 2, 'both dials from one key to one host connected')
    t.not(conns[0], conns[1], 'as two connections')

    // Each connection has a handle of its own, bound to that connection: one
    // closing ends its history reads and leaves the other's alone (K17: the
    // history itself, per session, is test/freenet-history.test.js's).
    const store = (i) => ({ sessionId: `session-${i}`, availableLength: () => Promise.resolve(0) })
    const handles = conns.map((conn, i) => viewer.backend.attachHistory(conn, store(i), {}))
    t.not(handles[0], handles[1], 'one history handle per connection')
    for (const [i, handle] of handles.entries()) {
      t.is(
        handle.store.sessionId,
        `session-${i}`,
        `the handle of connection ${i} reads its own session`
      )
      t.is(handle._live(), true, `and is live while connection ${i} is`)
    }
    conns[0].close('done')
    await until(() => conns[0].closed, CONNECT_TIMEOUT_MS, 'the first connection to close')
    t.is(
      handles[0]._live(),
      false,
      'the first handle stops asking the host once its connection is gone'
    )
    t.is(handles[1]._live(), true, "the second connection's handle is unaffected")
    for (const handle of handles) handle.close()
  }
)

// A channel's handle comes with the core's reply to the open request; what
// is sent before it waits here, in order. (S-26's bootstrap-channel rule is
// the core's now: zxterm's crate::freenet::connection defers its own data
// channels until the bootstrap channel is open.)
test('freenet: messages sent on a channel before its handle arrives are sent once it does, in order (S-26)', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  const viewer = await peer(t)
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-bootstrap')
  const { conn, hostConn } = await connect(t, host, viewer, r)
  const received = []
  hostConn.onChannel(CHANNEL, (id) => {
    hostConn.openChannel(CHANNEL, id, { onmessage: (message) => received.push(message) })
  })
  viewer.sent.length = 0
  const channel = conn.openChannel(CHANNEL, Buffer.from('early'), { onmessage: () => {} })
  channel.send({ early: 1 })
  channel.send({ early: 2 })
  t.is(channel._chan, null, 'the handle is not known yet')
  t.is(viewer.sent.length, 0, 'so nothing has gone to the core')
  await until(() => received.length === 2, CONNECT_TIMEOUT_MS, 'the queued messages')
  t.alike(received, [{ early: 1 }, { early: 2 }], 'what was sent meanwhile arrives, in order')
})

// The core holds what a remote channel carried until this side takes it
// (S-27's READY rule is the core's now: zxterm's crate::freenet::channel).
test('freenet: what a remote channel carried before this side took it arrives, in order (S-27)', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  const viewer = await peer(t)
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-ready')
  const { conn, hostConn } = await connect(t, host, viewer, r)
  const received = []
  let taken = false
  hostConn.onChannel(CHANNEL, (id) => {
    // Take it late: the burst is already on its way.
    setTimeout(() => {
      taken = true
      hostConn.openChannel(CHANNEL, id, { onmessage: (message) => received.push(message.i) })
    }, 300)
  })
  const channel = conn.openChannel(CHANNEL, Buffer.from('ready'), { onmessage: () => {} })
  const BURST = 2000
  for (let i = 0; i < BURST; i++) channel.send({ i })
  await until(() => taken, CONNECT_TIMEOUT_MS, 'the host takes the channel')
  await until(() => received.length === BURST, CONNECT_TIMEOUT_MS, 'the burst')
  t.ok(
    received.every((i, at) => i === at),
    `all ${BURST} messages arrived in order once it was taken`
  )
})

// K14 (ZBTerm D-38): the core's session service runs on the same connections
// as this proxy. What it does for itself reaches every seam client as events,
// and must not be mistaken for the proxy's own: its dials (`share.join`), the
// bytes of its channels. The proxy also hands the session path the sidecar,
// the connection a join dialed, and a stored route the core no longer takes.
test("freenet: the core's own dials and channels are not the proxy's to close or keep (K14)", async (t) => {
  const RAW = { chan: 5 }
  const p = await scripted(t, {
    'freenet.openChannel': () => {
      // Bytes that come before the reply that names their channel are kept for it.
      p.core.emit('chan', { chan: RAW.chan, bytes: Buffer.from('early') })
      return { chan: RAW.chan }
    }
  })
  const remote = 'cd'.repeat(32)
  const connection = (conn, initiator) =>
    p.core.event('freenet.connection', {
      conn,
      remotePeerKey: remote,
      initiator,
      linkId: null,
      path: 'DIRECT'
    })

  // A connection the core dialed for the session protocol: `freenet.dialConnected`
  // names a dial this backend never made, and the connection stays open.
  connection(11, true)
  p.core.event('freenet.dialConnected', { dial: 900, conn: 11 })
  await delay(20)
  t.alike(p.core.called('freenet.closeConnection'), [], "no close request for the core's own dial")
  const dialed = p.backend.connectionTo(Buffer.from(remote, 'hex'), { initiator: true })
  t.ok(dialed && !dialed.closed, 'connectionTo() finds the connection the core dialed')
  t.is(p.connections.length, 0, 'it is not surfaced as a host-side connection')
  t.is(p.backend.connectionTo(Buffer.from(remote, 'hex'), { initiator: false }), null, 'by role')
  t.is(p.backend.connectionTo(Buffer.alloc(32, 1)), null, 'and by peer key')

  // A dial this backend cancelled is still closed when the core connects it.
  connection(12, true)
  const mine = p.backend.dial({ sig: 'x' }, Buffer.from(remote, 'hex'))
  await delay(20)
  mine.cancel()
  const dial = p.core.called('freenet.dial').length
  t.is(dial, 1, 'one dial of the proxy')
  p.core.event('freenet.dialConnected', { dial: 1, conn: 12 })
  await delay(20)
  t.alike(
    p.core.called('freenet.closeConnection').map((args) => args.conn),
    [12],
    'its late connection is closed, as before K14'
  )

  // Bytes of a channel the session service owns are dropped, not stored.
  for (let i = 0; i < 50; i++) p.core.emit('chan', { chan: 700 + i, bytes: Buffer.alloc(1024) })
  t.is(p.backend._orphans.size, 0, "nothing is held for channels of the core's own")

  // And bytes that beat the reply of an open request still reach it.
  p.core.event('freenet.connection', {
    conn: 13,
    remotePeerKey: 'ee'.repeat(32),
    initiator: false,
    linkId: null,
    path: 'DIRECT'
  })
  const conn = p.connections[0].conn
  const got = []
  conn.openRawChannel('some/protocol', Buffer.from('id'), {
    onmessage: (bytes) => got.push(Buffer.from(bytes).toString('utf8'))
  })
  await until(() => got.length === 1, 2000, 'the early bytes')
  t.alike(got, ['early'], 'kept for the channel the reply names')
  t.is(p.backend._orphans.size, 0, 'and released')
})

test('freenet: sessionCore() is the sidecar once started, and refreshRoute() asks the core about a stored route (K14)', async (t) => {
  const fresh = { sig: 'fresh', params: { pv: 2 } }
  const stored = { sig: 'old', params: {} }
  const unsupported = () =>
    Object.assign(new Error('The invite uses an older Freenet session protocol'), {
      code: 'E_BACKEND_UNSUPPORTED'
    })
  const p = await scripted(t, {
    'freenet.routeFor': ({ linkId, stored: given }) => {
      if (given && given.route === stored) throw unsupported()
      return given ? given.route : fresh
    }
  })
  t.is(await p.backend.sessionCore(), p.core, 'the core the backend started')

  const kept = await p.backend.refreshRoute('link', { route: fresh })
  t.alike(kept, { route: fresh, minted: false }, 'a route the core takes is kept')
  const minted = await p.backend.refreshRoute('link', { route: stored })
  t.alike(minted, { route: fresh, minted: true }, 'one it refuses is replaced by a route it mints')
  t.alike(
    p.core.called('freenet.routeFor').map((args) => Boolean(args.stored)),
    [true, true, false],
    'the core was asked about both, then asked to mint'
  )
  const none = await p.backend.refreshRoute('link', null)
  t.alike(none, { route: fresh, minted: true }, 'a link with no stored route gets a new one')

  p.core.handlers['freenet.routeFor'] = () => {
    throw Object.assign(new Error('broken'), { code: 'E_CORRUPT' })
  }
  await t.exception(
    p.backend.refreshRoute('link', { route: stored }),
    /broken/,
    'any other refusal is passed on, not papered over with a new route'
  )

  const idle = new FreenetBackend({
    nodeUrl: 'ws://127.0.0.1:1/v1/contract/command',
    core: new FakeCore()
  })
  await t.exception(
    idle.sessionCore(),
    /not started/,
    'a backend that was never started has no session core'
  )
})

// Last: the node.
test('freenet: teardown', async (t) => {
  if (node) await node.stop()
  t.pass(node ? `stopped the local node (pid ${node.pid})` : 'no node was started')
})
