// The Freenet backend's announce, withdraw, dial, 'connection' and the
// handshake of design §6 (F6 of docs/projects/260924_freenet-backend/;
// design §4, §5.2, §6, §7), and since F7 its channels (framing, order,
// back-pressure) and the per-link admission limits of §7 layer 4, and since F8 live history (§8.1). Every peer is a FreenetBackend with its own
// electron/rtc-host.js RtcHost in this process (A-8), wrapped by a relay that
// counts and may rewrite what crosses it; all of them meet on one throwaway
// local-mode node (test/helpers/freenet-node.js, never the owner's), started
// by the first node test and stopped by the last. No ICE servers: host
// candidates only. Tests skip when the `freenet` binary is not on PATH (A-7).
//
// Every "never connects" case first proves that a permitted dial connects on
// the same node (the conformance suite's GRACE_MS rule).
const { EventEmitter } = require('events')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')
const Hypercore = require('hypercore')

const FreenetBackend = require('../../engine/backends/freenet')
const nodeClient = require('../../engine/backends/freenet/node-client')
const contracts = require('../../engine/backends/freenet/contracts')
const route = require('../../engine/backends/freenet/route')
const signal = require('../../engine/backends/freenet/signal')
const { RtcHost } = require('../../electron/rtc-host')
const { PATH } = require('../../engine/backends/types')
const { transportKeyPair } = require('../../engine/crypto')
const fixtures = require('../../scripts/contract-fixtures')
const { freenetAvailable, startLocalNode, freePort } = require('../helpers/freenet-node')
const ShareManager = require('../../engine/share-manager')

// How long a negative case watches before it concludes (the plan's 5 s).
const NEVER_MS = 5000
const CONNECT_TIMEOUT_MS = 15000

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

// An RtcHost seen through a relay: it counts open() calls and every remote
// description applied, and may rewrite what goes in (`signal`) or what comes
// out (`state`). The backend cannot tell it from an RtcHost.
function relayed(rtc, { signal: mapSignal, state: mapState } = {}) {
  const relay = new EventEmitter()
  relay.opens = 0
  relay.applied = []
  relay.states = []
  relay.open = (connId, opts) => {
    relay.opens++
    return rtc.open(connId, opts)
  }
  relay.signal = (connId, msg) => {
    const next = mapSignal ? mapSignal(msg) : msg
    if (next.type !== 'candidate') relay.applied.push(next.type)
    return rtc.signal(connId, next)
  }
  for (const name of ['openChannel', 'closeChannel', 'send', 'close', 'closeAll']) {
    relay[name] = (...args) => rtc[name](...args)
  }
  for (const name of ['signal', 'state', 'channel', 'data', 'flow', 'close']) {
    rtc.on(name, (body) => {
      if (name === 'state') relay.states.push(body.state)
      relay.emit(name, name === 'state' && mapState ? mapState(body) : body)
    })
  }
  return relay
}

let node = null
let client = null

async function sharedNode() {
  if (!node) {
    node = await startLocalNode()
    client = await nodeClient.connect(node.url)
  }
  return node
}

// A started backend with its own key and RtcHost. `relay` options rewrite
// what crosses the host half; `clock` replaces the backend's Date.now.
async function peer(t, { relay, iceServers = [], clock } = {}) {
  const { url } = await sharedNode()
  const keyPair = transportKeyPair()
  const rtc = new RtcHost({ iceServers: [] })
  const rtcHost = relayed(rtc, relay)
  const backend = new FreenetBackend({ nodeUrl: url, rtcHost, iceServers, clock })
  const connections = []
  const debug = []
  backend.on('connection', (conn, info) => connections.push({ conn, info }))
  backend.on('debug', (e) => debug.push(e))
  t.teardown(async () => {
    await backend.stop()
    rtc.closeAll('teardown')
  })
  await backend.start({ keyPair: () => keyPair })
  return { backend, keyPair, rtc, rtcHost, connections, debug, hex: hex(keyPair.publicKey) }
}

// The entries of a route's signalling instance, as the node holds them now.
async function entriesOf(r) {
  const wasm = contracts.known.get(r.code)
  const { key } = nodeClient.contractKey(wasm, route.paramsBytes(r.params))
  const res = await client.get(key)
  const text = Buffer.from(res.state).toString('utf8')
  return text ? JSON.parse(text).e : []
}

function instanceKey(r) {
  const wasm = contracts.known.get(r.code)
  return nodeClient.contractKey(wasm, route.paramsBytes(r.params)).key
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

function flipHexDigit(fingerprintLine) {
  // 'a=fingerprint:sha-256 AB:CD:…' -> the first hex digit after the space, changed.
  return fingerprintLine.replace(/(a=fingerprint:\S+ )([0-9A-Fa-f])/, (all, head, digit) => {
    const flipped = digit.toUpperCase() === 'A' ? 'B' : 'A'
    return head + flipped
  })
}

test('freenet: signal.js signs the bytes the contract checks, and seals payloads', (t) => {
  const host = fixtures.keyPair(1)
  const viewer = fixtures.keyPair(2)
  const params = route.paramsBytes({ ttl_ms: 120000, host: host.hex, n: 'f6-fixture' })
  const e = { l: 'cid', r: `v:${viewer.hex}`, s: 7, t: 1234567890123, d: false, p: 'payload' }
  t.alike(
    signal.entryBytes(params, e),
    fixtures.entryBytes(params, e),
    'the same bytes as the fixtures'
  )
  const signed = signal.signEntry(viewer.secretKey, params, e)
  t.alike(signed, fixtures.signEntry(viewer.secretKey, params, e), 'and the same signature')
  t.alike(Object.keys(signed), ['l', 'r', 's', 't', 'd', 'p', 'g'], 'in wire field order')
  t.ok(signal.verifyEntry(viewer.publicKey, params, signed), 'it verifies under the signer')
  t.absent(signal.verifyEntry(host.publicKey, params, signed), 'not under another key')
  t.absent(signal.verifyEntry(viewer.publicKey, params, { ...signed, s: 8 }), 'nor once changed')
  const other = route.paramsBytes({ ttl_ms: 120000, host: host.hex, n: 'another-link' })
  t.absent(signal.verifyEntry(viewer.publicKey, other, signed), "nor for another link's instance")
  const tomb = signal.signEntry(host.secretKey, params, {
    ...e,
    r: `h:${viewer.hex}`,
    d: true,
    p: ''
  })
  t.ok(signal.verifyEntry(host.publicKey, params, tomb), 'a tombstone signs d = 1')

  const rec = { ver: 1, sig: 'instance', code: 'ab'.repeat(32), params: params.toString() }
  const own = route.pointerParamsBytes(host.hex, 'f6-fixture')
  t.alike(signal.recordBytes(own, rec), fixtures.recordBytes(own, rec), 'pointer bytes too')
  t.alike(
    signal.signRecord(host.secretKey, own, rec),
    fixtures.signRecord(host.secretKey, own, rec)
  )

  const k = Buffer.alloc(32, 9).toString('base64url')
  const key = signal.payloadKey(k)
  const sealed = signal.seal(key, { cid: 'x', m: [{ type: 'offer', sdp: 'v=0' }] })
  t.ok(/^[A-Za-z0-9_-]+$/.test(sealed), 'a sealed payload is base64url')
  t.alike(signal.open(key, sealed), { cid: 'x', m: [{ type: 'offer', sdp: 'v=0' }] }, 'and opens')
  t.is(signal.open(signal.payloadKey(Buffer.alloc(32, 8).toString('base64url')), sealed), null)
  t.is(signal.offerRef(sealed).length, 64, 're is a 64-hex BLAKE3')
  t.is(
    signal.sdpFingerprint('v=0\r\na=fingerprint:SHA-256 ab:cd\r\n'),
    'sha-256 AB:CD',
    'the fingerprint in the shape RtcHost reports it'
  )
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
  t.comment(`announce: ${announceMs} ms (Put + pointer Put + subscribe)`)

  const ptrParams = route.pointerParamsBytes(r.params.host, r.params.n)
  const ptr = await client.get(nodeClient.contractKey(contracts.pointer.wasm, ptrParams).key)
  const record = JSON.parse(Buffer.from(ptr.state).toString())
  t.is(record.sig, r.sig, "the link's pointer record names its instance")
  t.ok(signal.verifyRecord(host.keyPair.publicKey, ptrParams, record), 'signed by the host')

  const { conn, hostConn, info, ms } = await connect(t, host, viewer, r)
  t.comment(`dial -> connected through a local-mode node: ${ms} ms`)
  const answer = viewer.debug.find((e) => e.event === 'viewer:answer')
  t.comment(
    `dial -> verified answer applied: ${answer.details.ms} ms; offer written -> answer applied: ${answer.details.sinceOfferMs} ms`
  )
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

  const entries = await entriesOf(r)
  const viewerEntries = entries.filter((e) => e.r === `v:${viewer.hex}`)
  const hostEntries = entries.filter((e) => e.r === `h:${viewer.hex}`)
  t.ok(
    viewerEntries.length >= 1 && viewerEntries.length <= 4,
    `${viewerEntries.length} viewer entries`
  )
  t.ok(hostEntries.length >= 1 && hostEntries.length <= 4, `${hostEntries.length} host entries`)
  t.ok(
    entries.every((e) => !/a=fingerprint|candidate/.test(e.p)),
    'no SDP in the clear in contract state'
  )

  const diagnostics = host.backend.diagnostics()
  const text = JSON.stringify(diagnostics)
  t.alike(JSON.parse(text), diagnostics, 'diagnostics() is JSON-safe')
  t.is(diagnostics.conns.length, 1)
  t.alike(diagnostics.conns[0], {
    peer: viewer.hex,
    iceState: 'connected',
    path: 'DIRECT',
    channels: 0
  })
  t.alike(diagnostics.links, [
    {
      linkId: 'link-a',
      instance: r.sig,
      entries: entries.length,
      answeredLastMinute: 1,
      halfOpen: 0,
      refused: 0
    }
  ])
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
  const entries = await entriesOf(r)
  const own = entries.filter((e) => e.r.startsWith('h:'))
  t.ok(own.length >= 1 && own.every((e) => e.d === true && e.p === ''), 'own entries tombstoned')

  const opensBefore = host.rtcHost.opens
  const fresh = late.backend.dial(r, host.keyPair.publicKey)
  const outcome = outcomeOf(fresh.connected)
  await delay(NEVER_MS)
  t.is(outcome.state, 'pending', `a fresh dial after withdraw did not connect in ${NEVER_MS} ms`)
  t.is(host.rtcHost.opens, opensBefore, 'the host opened no peer connection for it')
  t.ok(
    (await entriesOf(r)).some((e) => e.r === `v:${late.hex}`),
    'although its offer reached the contract'
  )
  fresh.cancel()
  await outcome.settled
  t.is(outcome.state, 'rejected', 'cancel rejects it')

  t.is(conn.closed, false, 'the earlier connection is open')
  t.is(hostConn.closed, false, 'on both sides')
  const states = [host.rtc, viewer.rtc].map((rtc) => {
    const [only] = Array.from(rtc.conns.values())
    return only ? only.pc.state() : null
  })
  t.alike(states, ['connected', 'connected'], 'and both peer connections still report connected')
})

test('freenet: (i) an answer whose fingerprint was changed after verification never surfaces', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  // The relay flips one hex digit of a=fingerprint: in the answer the viewer's
  // host half applies. The answer the viewer verified is the host's.
  let tampered = 0
  const viewer = await peer(t, {
    relay: {
      signal: (msg) => {
        if (msg.type !== 'answer') return msg
        tampered++
        return { ...msg, sdp: msg.sdp.replace(/a=fingerprint:[^\r\n]+/, flipHexDigit) }
      }
    }
  })
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-i')
  const started = Date.now()
  const dial = viewer.backend.dial(r, host.keyPair.publicKey)
  const outcome = outcomeOf(dial.connected)
  await within(30000, outcome.settled, 'the tampered dial settles')
  const ms = Date.now() - started
  t.is(tampered, 1, 'the relay changed the answer')
  t.is(outcome.state, 'rejected', `connected rejects (after ${ms} ms)`)
  t.comment(`rejection: ${outcome.error.code} ${JSON.stringify(outcome.error.details)}`)
  t.is(outcome.error.code, 'E_HOST_UNREACHABLE', 'as a failed peer connection')
  t.absent(
    viewer.rtcHost.states.includes('connected'),
    'the library never reported connected: it refused the certificate itself (DTLS)'
  )
  t.is(viewer.connections.length, 0, "no 'connection' on the viewer")
  await delay(500)
  t.is(host.connections.length, 0, 'and none on the host')
})

test('freenet: (i) our fingerprint check: a remoteFingerprint that differs from the signed SDP -> E_AUTH', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  // A host half whose DTLS certificate would not be the one in the signed SDP
  // (what an SDP-derived accessor could not show, and a library that did not
  // check would let through): its reported remoteFingerprint is changed.
  const lie = (body) =>
    body.state === 'connected'
      ? {
          ...body,
          remoteFingerprint: flipHexDigit(`a=fingerprint:${body.remoteFingerprint}`).slice(14)
        }
      : body
  const host = await peer(t)
  const viewer = await peer(t, { relay: { state: lie } })
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-ib')
  const dial = viewer.backend.dial(r, host.keyPair.publicKey)
  const outcome = outcomeOf(dial.connected)
  await within(CONNECT_TIMEOUT_MS, outcome.settled, 'the dial settles')
  t.is(outcome.state, 'rejected')
  t.is(outcome.error.code, 'E_AUTH', 'the viewer rejects E_AUTH')
  t.is(outcome.error.details.detail, 'fingerprint mismatch')
  t.is(viewer.connections.length, 0, "and fires no 'connection'")
  t.is(viewer.backend.diagnostics().refused, 1, 'counted')

  // The same on the host side: its host half lies, it surfaces nothing.
  const liar = await peer(t, { relay: { state: lie } })
  const honest = await peer(t)
  liar.backend.setAdmission(true)
  const { route: r2 } = await liar.backend.announce('link-ib2')
  const dial2 = honest.backend.dial(r2, liar.keyPair.publicKey)
  const outcome2 = outcomeOf(dial2.connected)
  await until(
    () => liar.debug.some((e) => e.event === 'host:fingerprint-mismatch'),
    CONNECT_TIMEOUT_MS,
    'the host refuses the certificate'
  )
  await delay(500)
  t.is(liar.connections.length, 0, "the host fires no 'connection'")
  t.is(liar.backend.diagnostics().conns.length, 0)
  dial2.cancel()
  await outcome2.settled
})

test('freenet: (ii) an answer signed by a third key is ignored and counted', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  const control = await peer(t)
  const viewer = await peer(t)
  // The host admits only the control viewer: nobody answers `viewer` but the
  // attacker below.
  host.backend.setAdmission((key) => hex(key) === control.hex)
  const { route: r } = await host.backend.announce('link-ii')
  await connect(t, host, control, r)
  t.pass('the control: a permitted dial connected on this node')

  const dial = viewer.backend.dial(r, host.keyPair.publicKey)
  const outcome = outcomeOf(dial.connected)
  const offerEntry = await until(
    async () => (await entriesOf(r)).find((e) => e.r === `v:${viewer.hex}`),
    CONNECT_TIMEOUT_MS,
    "the viewer's offer"
  )
  const payloadKey = signal.payloadKey(r.k)
  const offer = signal.open(payloadKey, offerEntry.p)
  t.ok(offer && offer.m.some((m) => m.type === 'offer'), 'the offer (the invite holds k)')

  // A third party answers the offer with a real peer connection of its own
  // and signs the answer with its own key.
  const third = transportKeyPair()
  const attacker = new RtcHost({ iceServers: [] })
  t.teardown(() => attacker.closeAll('teardown'))
  const attackerStates = []
  attacker.on('state', (s) => attackerStates.push(s.state))
  const produced = []
  attacker.on('signal', (msg) => produced.push(msg))
  attacker.open(1)
  for (const m of offer.m) {
    attacker.signal(
      1,
      m.type === 'candidate' ? { type: 'candidate', candidate: m.candidate, mid: m.mid } : m
    )
  }
  await until(() => produced.some((m) => m.type === 'answer'), 5000, 'the attacker answer')
  await delay(200)
  const forged = signal.signEntry(third.secretKey, route.paramsBytes(r.params), {
    l: offerEntry.l,
    r: `h:${viewer.hex}`,
    s: 0,
    t: Date.now(),
    p: signal.seal(payloadKey, {
      cid: offer.cid,
      re: signal.offerRef(offerEntry.p),
      m: produced.map((m) =>
        m.type === 'candidate'
          ? { type: 'candidate', candidate: m.candidate, mid: m.mid }
          : { type: m.type, sdp: m.sdp }
      )
    })
  })
  // The contract refuses an h: entry the host did not sign, so only a lying
  // node could deliver it: hand it to the viewer as a notification would.
  const refusedBefore = viewer.backend.diagnostics().refused
  viewer.backend._onEntries(r.sig, [forged])
  t.is(viewer.backend.diagnostics().refused, refusedBefore + 1, 'ignored and counted')
  t.ok(
    viewer.debug.some(
      (e) => e.event === 'viewer:answer-refused' && e.details.reason === 'signature'
    ),
    'as a bad signature'
  )
  await delay(NEVER_MS)
  t.is(outcome.state, 'pending', `no connection within ${NEVER_MS} ms`)
  t.alike(viewer.rtcHost.applied, [], 'the attacker SDP never reached the host half')
  t.absent(attackerStates.includes('connected'), 'the attacker never connected')
  t.is(viewer.connections.length, 0)
  dial.cancel()
  await outcome.settled
})

test('freenet: (iii) the previous signed answer, re-put for a new offer, is ignored (wrong re)', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  const viewer = await peer(t)
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-iii')
  const first = await connect(t, host, viewer, r)
  t.pass('the control: the first dial connected')
  const payloadKey = signal.payloadKey(r.k)
  const oldAnswer = (await entriesOf(r)).find((e) => e.r === `h:${viewer.hex}`)
  const old = signal.open(payloadKey, oldAnswer.p)
  t.ok(
    old.m.some((m) => m.type === 'answer'),
    "the host's signed answer to the first offer"
  )
  first.conn.close()

  // The host answers nothing from here on; a second dial writes a new offer.
  host.backend.setAdmission(false)
  const refusedBefore = viewer.backend.diagnostics().refused
  const dial = viewer.backend.dial(r, host.keyPair.publicKey)
  const outcome = outcomeOf(dial.connected)
  const second = await until(
    async () => (await entriesOf(r)).find((e) => e.r === `v:${viewer.hex}` && e.l !== oldAnswer.l),
    CONNECT_TIMEOUT_MS,
    'the second offer'
  )
  // Re-addressed to the new connection id and signed with the host's own key
  // (so the contract takes it), but still naming the first offer.
  const replay = signal.signEntry(host.keyPair.secretKey, route.paramsBytes(r.params), {
    l: second.l,
    r: `h:${viewer.hex}`,
    s: 0,
    t: Date.now(),
    p: signal.seal(payloadKey, { ...old, cid: second.l })
  })
  const delta = Buffer.from(JSON.stringify({ e: [replay, oldAnswer] }))
  await client.update(instanceKey(r), delta)
  t.pass('the contract accepts the replay: it is validly signed')
  await until(
    () =>
      viewer.debug.some((e) => e.event === 'viewer:answer-refused' && e.details.reason === 'offer'),
    CONNECT_TIMEOUT_MS,
    'the viewer sees it'
  )
  t.is(viewer.backend.diagnostics().refused, refusedBefore + 1, 'ignored for its re, and counted')
  await delay(NEVER_MS)
  t.is(outcome.state, 'pending', `no connection within ${NEVER_MS} ms`)
  t.is(
    viewer.rtcHost.applied.filter((type) => type === 'answer').length,
    1,
    'only the first answer was ever applied'
  )
  dial.cancel()
  await outcome.settled
})

test('freenet: (iv) setAdmission(() => false) answers nothing; true again and the same key connects', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  const control = await peer(t)
  const viewer = await peer(t)
  host.backend.setAdmission((key) => hex(key) === control.hex)
  const { route: r } = await host.backend.announce('link-iv')
  await connect(t, host, control, r)
  t.pass('the control: a permitted dial connected on this node')

  host.backend.setAdmission(() => false)
  const opensBefore = host.rtcHost.opens
  const refusedBefore = host.backend.diagnostics().refused
  const dial = viewer.backend.dial(r, host.keyPair.publicKey)
  const outcome = outcomeOf(dial.connected)
  await until(
    () => host.debug.some((e) => e.event === 'host:offer-refused' && e.details.peer === viewer.hex),
    CONNECT_TIMEOUT_MS,
    'the host evaluates the offer'
  )
  await delay(NEVER_MS)
  t.is(host.rtcHost.opens, opensBefore, 'no rtcHost.open on the host side')
  t.absent(
    (await entriesOf(r)).some((e) => e.r === `h:${viewer.hex}`),
    'no answer written'
  )
  t.is(host.backend.diagnostics().refused, refusedBefore + 1, 'the refusal is counted')
  t.is(outcome.state, 'pending', `no connection within ${NEVER_MS} ms`)
  dial.cancel()
  await outcome.settled

  host.backend.setAdmission(() => true)
  const again = await connect(t, host, viewer, r)
  t.alike(
    again.hostConn.remotePeerKey,
    viewer.keyPair.publicKey,
    'the same viewer key connects: not sticky'
  )
  t.is(host.rtcHost.opens, opensBefore + 1, 'with one host-side peer connection')
})

test('freenet: a route whose code this build lacks is looked up through its pointer record', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-p')
  // A viewer whose build ships only another signalling code (the pointer's
  // bytes stand in for it).
  const { url } = await sharedNode()
  const keyPair = transportKeyPair()
  const rtc = new RtcHost({ iceServers: [] })
  const old = new FreenetBackend({
    nodeUrl: url,
    rtcHost: rtc,
    iceServers: [],
    wasm: contracts.pointer.wasm
  })
  const debug = []
  old.on('debug', (e) => debug.push(e))
  t.teardown(async () => {
    await old.stop()
    rtc.closeAll('teardown')
  })
  await old.start({ keyPair: () => keyPair })
  const dial = old.dial(r, host.keyPair.publicKey)
  const err = await dial.connected.then(
    () => null,
    (e) => e
  )
  t.is(err.code, 'E_BACKEND_UNSUPPORTED', 'still unknown after the pointer: E_BACKEND_UNSUPPORTED')
  t.ok(
    debug.some(
      (e) => e.event === 'viewer:route-refused' && e.details.detail === 'unknown contract code'
    ),
    'the route was refused for its code'
  )
  t.ok(
    debug.some(
      (e) => e.event === 'viewer:pointer' && e.details.instance === r.sig && e.details.ver === 1
    ),
    "and the host's signed pointer record was read and verified"
  )

  const stranger = transportKeyPair()
  const wrong = old.dial(r, stranger.publicKey)
  const wrongOutcome = outcomeOf(wrong.connected)
  await delay(200)
  t.is(
    wrongOutcome.state,
    'pending',
    'a route naming another host stays pending (never a byte to the node)'
  )
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
    const rtc = new RtcHost({ iceServers: [] })
    const backend = new FreenetBackend({ nodeUrl: url, rtcHost: rtc, iceServers: [] })
    t.teardown(async () => {
      await backend.stop()
      rtc.closeAll('teardown')
    })
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

  // Every data-channel message the viewer's host half is asked to send.
  const sizes = []
  const send = viewer.rtcHost.send
  viewer.rtcHost.send = (connId, chanId, data) => {
    sizes.push(data.byteLength)
    return send(connId, chanId, data)
  }
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
  const sentAt = now()
  t.is(channel.send(message), true, 'send() takes it')
  await within(CONNECT_TIMEOUT_MS, arrived, 'the 200 KiB message')
  const ms = now() - sentAt
  t.alike(received, [message], 'it arrived intact, once')
  t.is(sizes.length, Math.ceil(bytes / (65536 - 5)), `in ${sizes.length} parts`)
  t.ok(
    sizes.every((size) => size <= 65536),
    `none above 65 536 bytes (largest ${Math.max(...sizes)})`
  )
  t.comment(`200 KiB JSON message: send() -> onmessage ${ms.toFixed(1)} ms`)
  t.is(host.backend.diagnostics().conns[0].channels, 1, 'diagnostics() counts the channel')

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
    const opened = key === 'second' ? until(() => channel._writable, 5000, 'open') : null
    if (opened) await opened
    let refused = 0
    let bytes = 0
    const started = now()
    for (let i = 0; i < BURST; i++) {
      const message = { i, pad: 'x'.repeat(64) }
      bytes += Buffer.byteLength(JSON.stringify(message))
      if (channel.send(message) === false) refused++
    }
    await within(30000, complete, `the ${key} burst`)
    const ms = now() - started
    return { channel, refused, bytes, ms, counter: counters.get(key) }
  }

  // As the conformance case sends it: right after openChannel.
  const first = await burst('first')
  t.ok(first.refused > 0, `send() returned false ${first.refused} times`)
  t.is(first.counter.expected, BURST, 'every message arrived')
  t.is(first.counter.outOfOrder, 0, 'in the order it was sent')
  t.ok(
    first.channel._queuedHigh <= 1024 * 1024,
    `the worker held at most 1 MiB for the channel (${first.channel._queuedHigh} bytes)`
  )
  const rate = (run) =>
    `${Math.round((BURST / run.ms) * 1000)} msg/s, ${(run.bytes / 1048576 / (run.ms / 1000)).toFixed(2)} MiB/s of JSON`
  t.comment(
    `burst right after openChannel: ${BURST} messages (${first.bytes} bytes of JSON) in ${first.ms.toFixed(0)} ms = ${rate(first)}; ` +
      `send() false ${first.refused}x; worker queue high-water ${first.channel._queuedHigh} bytes`
  )

  // Reported, not gated: the same burst on a channel that is already open.
  const second = await burst('second')
  t.is(second.counter.outOfOrder, 0, 'a burst on an open channel keeps its order too')
  t.comment(
    `burst on an open channel: ${second.ms.toFixed(0)} ms = ${rate(second)}; send() false ${second.refused}x; ` +
      `worker queue high-water ${second.channel._queuedHigh} bytes`
  )
})

// A real offer SDP from a throwaway peer connection, for offers a test writes
// itself.
async function offerSdp(t) {
  const gen = new RtcHost({ iceServers: [] })
  t.teardown(() => gen.closeAll('teardown'))
  const produced = []
  gen.on('signal', (msg) => produced.push(msg))
  gen.open(1)
  gen.openChannel(1, 0, 'offer-source')
  await until(() => produced.some((msg) => msg.type === 'offer'), 5000, 'an offer')
  return produced.find((msg) => msg.type === 'offer').sdp
}

// A viewer's signed, sealed offer on route `r`, or its tombstone, written
// through the node as the viewer's own backend would write it.
function viewerWriter(r, sdp) {
  const params = route.paramsBytes(r.params)
  const payloadKey = signal.payloadKey(r.k)
  const at = Date.now()
  let n = 0
  return {
    async offer(keyPair) {
      const cid = crypto.randomBytes(16).toString('hex')
      const entry = signal.signEntry(keyPair.secretKey, params, {
        l: cid,
        r: `v:${hex(keyPair.publicKey)}`,
        s: 0,
        t: at + n++,
        p: signal.seal(payloadKey, { cid, m: [{ type: 'offer', sdp }] })
      })
      await client.update(instanceKey(r), Buffer.from(JSON.stringify({ e: [entry] })))
      return cid
    },
    async cancel(keyPair, cid) {
      const entry = signal.signEntry(keyPair.secretKey, params, {
        l: cid,
        r: `v:${hex(keyPair.publicKey)}`,
        s: 0,
        t: at + n++,
        d: true
      })
      await client.update(instanceKey(r), Buffer.from(JSON.stringify({ e: [entry] })))
    }
  }
}

function refusedFor(host, keyPair, reason) {
  return host.debug.filter(
    (e) =>
      e.event === 'host:offer-refused' &&
      e.details.peer === hex(keyPair.publicKey) &&
      e.details.reason === reason
  ).length
}

test('freenet: an offer above MAX_HALF_OPEN on one link gets no answer', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const { MAX_HALF_OPEN } = FreenetBackend
  t.is(MAX_HALF_OPEN, 8, 'A-12: 8 half-open peer connections per link')
  const host = await peer(t)
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-half')
  const writer = viewerWriter(r, await offerSdp(t))
  const keys = Array.from({ length: MAX_HALF_OPEN + 2 }, () => transportKeyPair())
  const link = () => host.backend.diagnostics().links[0]

  const cids = []
  for (let i = 0; i < MAX_HALF_OPEN; i++) {
    cids.push(await writer.offer(keys[i]))
    await until(() => host.rtcHost.opens === i + 1, CONNECT_TIMEOUT_MS, `offer ${i + 1} answered`)
  }
  t.is(link().halfOpen, MAX_HALF_OPEN, `${MAX_HALF_OPEN} answered peer connections, none up`)

  const above = keys[MAX_HALF_OPEN]
  await writer.offer(above)
  await until(() => refusedFor(host, above, 'half-open') === 1, CONNECT_TIMEOUT_MS, 'refused')
  await delay(500)
  t.is(host.rtcHost.opens, MAX_HALF_OPEN, 'no peer connection for the offer above the limit')
  t.absent(
    (await entriesOf(r)).some((e) => e.r === `h:${hex(above.publicKey)}`),
    'and no answer written'
  )
  t.is(link().refused, 1, "counted in the link's refused")
  t.is(host.backend.diagnostics().refused, 1, 'and in the backend total')

  // One viewer gives up: the next offer is answered again.
  await writer.cancel(keys[0], cids[0])
  await until(() => link().halfOpen === MAX_HALF_OPEN - 1, CONNECT_TIMEOUT_MS, 'one dropped')
  await writer.offer(keys[MAX_HALF_OPEN + 1])
  await until(
    () => host.rtcHost.opens === MAX_HALF_OPEN + 1,
    CONNECT_TIMEOUT_MS,
    'the next offer answered'
  )
  t.is(link().halfOpen, MAX_HALF_OPEN, 'a freed slot is taken by the next offer')
})

test('freenet: a link above MAX_ANSWERS_PER_MINUTE answers nothing until the window passes (fake clock)', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const { MAX_ANSWERS_PER_MINUTE, ANSWER_WINDOW_MS } = FreenetBackend
  t.is(MAX_ANSWERS_PER_MINUTE, 30, 'A-12: 30 answered offers per link per minute')
  t.is(ANSWER_WINDOW_MS, 60000, 'over a 60 s window')
  let clock = 1000000
  const host = await peer(t, { clock: () => clock })
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-rate')
  const writer = viewerWriter(r, await offerSdp(t))
  const link = () => host.backend.diagnostics().links[0]

  // Each offer is answered, then cancelled, so no half-open limit applies.
  for (let i = 0; i < MAX_ANSWERS_PER_MINUTE; i++) {
    const keyPair = transportKeyPair()
    const cid = await writer.offer(keyPair)
    await until(() => host.rtcHost.opens === i + 1, CONNECT_TIMEOUT_MS, `offer ${i + 1} answered`)
    await writer.cancel(keyPair, cid)
    await until(() => link().halfOpen === 0, CONNECT_TIMEOUT_MS, `offer ${i + 1} cancelled`)
  }
  t.is(link().answeredLastMinute, MAX_ANSWERS_PER_MINUTE, `${MAX_ANSWERS_PER_MINUTE} answered`)

  const late = transportKeyPair()
  await writer.offer(late)
  await until(() => refusedFor(host, late, 'rate') === 1, CONNECT_TIMEOUT_MS, 'refused')
  t.is(host.rtcHost.opens, MAX_ANSWERS_PER_MINUTE, 'the offer above the limit is not answered')

  clock += ANSWER_WINDOW_MS - 1000
  await writer.offer(late)
  await until(() => refusedFor(host, late, 'rate') === 2, CONNECT_TIMEOUT_MS, 'refused again')
  t.is(host.rtcHost.opens, MAX_ANSWERS_PER_MINUTE, '59 s later its new offer is still not answered')
  await delay(500)
  t.absent(
    (await entriesOf(r)).some((e) => e.r === `h:${hex(late.publicKey)}`),
    'and nothing was written for it'
  )
  t.is(link().refused, 2, 'both refusals counted')

  clock += 1000
  await writer.offer(late)
  await until(
    () => host.rtcHost.opens === MAX_ANSWERS_PER_MINUTE + 1,
    CONNECT_TIMEOUT_MS,
    'answered once the window passed'
  )
  t.pass('once the window has passed, the same peer is answered')
  t.is(link().answeredLastMinute, 1, 'the window holds only the new answer')
})

// S-22 (F9): a half-open peer connection holds its slot for at most
// HALF_OPEN_TIMEOUT_MS, and one viewer key at most MAX_HALF_OPEN_PER_VIEWER of
// the link's slots. Time is the backend's `clock` option.
test('freenet: a viewer holding 2 stale offers cannot block other viewers, and stale slots expire (S-22)', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const { HALF_OPEN_TIMEOUT_MS, MAX_HALF_OPEN_PER_VIEWER, MAX_HALF_OPEN } = FreenetBackend
  t.is(HALF_OPEN_TIMEOUT_MS, 15000, 'S-22: 15 s half-open deadline')
  t.is(MAX_HALF_OPEN_PER_VIEWER, 2, 'S-22: 2 of the 8 slots per viewer key')
  t.ok(MAX_HALF_OPEN > 2 * MAX_HALF_OPEN_PER_VIEWER, 'so two stale holders leave room')
  let clock = 1000000
  const host = await peer(t, { clock: () => clock })
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-stale')
  const writer = viewerWriter(r, await offerSdp(t))
  const link = () => host.backend.diagnostics().links[0]
  const holder = transportKeyPair()

  for (let i = 0; i < MAX_HALF_OPEN_PER_VIEWER; i++) {
    await writer.offer(holder)
    await until(() => host.rtcHost.opens === i + 1, CONNECT_TIMEOUT_MS, `stale offer ${i + 1}`)
  }
  t.is(link().halfOpen, MAX_HALF_OPEN_PER_VIEWER, 'the holder has its 2 half-open slots')

  await writer.offer(holder)
  await until(
    () => refusedFor(host, holder, 'half-open-viewer') === 1,
    CONNECT_TIMEOUT_MS,
    "the holder's third offer is refused"
  )
  t.is(host.rtcHost.opens, MAX_HALF_OPEN_PER_VIEWER, 'no peer connection for it')

  const others = [transportKeyPair(), transportKeyPair()]
  for (let i = 0; i < others.length; i++) {
    await writer.offer(others[i])
    await until(
      () => host.rtcHost.opens === MAX_HALF_OPEN_PER_VIEWER + i + 1,
      CONNECT_TIMEOUT_MS,
      `viewer ${i + 2} answered`
    )
  }
  t.pass('the next viewers are answered while the holder keeps its stale offers')
  t.is(link().halfOpen, MAX_HALF_OPEN_PER_VIEWER + others.length)
  t.is(link().refused, 1)

  // Past the deadline, the next offer finds every stale slot closed first.
  clock += HALF_OPEN_TIMEOUT_MS
  await writer.offer(holder)
  const answered = MAX_HALF_OPEN_PER_VIEWER + others.length + 1
  await until(() => host.rtcHost.opens === answered, CONNECT_TIMEOUT_MS, 'answered again')
  const expired = host.debug.filter((e) => e.event === 'host:half-open-expired').length
  t.is(expired, MAX_HALF_OPEN_PER_VIEWER + others.length, 'every stale peer connection expired')
  t.is(link().halfOpen, 1, 'only the new offer is half-open')
  t.is(host.rtc.conns.size, 1, 'the expired peer connections were closed (RtcHost.close)')
  t.is(link().refused, 1 + expired, "and each is counted in the link's refused")
})

// A-11 (F9): share.backends asks the node itself. A live local-mode node is
// `available`; a closed port is `broken`, naming the address.
test('freenet: probe() is available with a node and names the address without one (A-11)', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const { url } = await sharedNode()
  t.alike(await FreenetBackend.probe({ nodeUrl: url }), { state: 'available', detail: null })
  const port = await freePort()
  t.alike(await FreenetBackend.probe({ nodeUrl: `ws://127.0.0.1:${port}/v1/contract/command` }), {
    state: 'broken',
    detail: `no Freenet node at ws://127.0.0.1:${port} — see README "Freenet"`
  })

  const manager = new ShareManager(null, {
    hostCaps: 'rtc',
    rtcHost: new EventEmitter(),
    backendOptions: { nodeUrl: url }
  })
  t.teardown(() => manager.close())
  const info = await manager.probedBackendsInfo()
  const freenet = info.backends.find((entry) => entry.id === 'freenet')
  t.alike([freenet.state, freenet.detail], ['available', null], 'share.backends: available')
  t.is(info.active, null, 'probing activated nothing')
})

// F8 (design §8.1): live history over one extra data channel. Blocks of
// 256 KiB make every replication message larger than a data-channel message,
// so the u32 LE frames must be cut and reassembled.
test(
  'freenet: history replicates 256 KiB blocks over zbterm/history 00, in messages of at most 65 536 bytes',
  { timeout: 60000 },
  async (t) => {
    if (!freenetAvailable()) {
      t.skip('freenet binary not on PATH')
      return
    }
    const BLOCK = 256 * 1024
    const BLOCKS = 16
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-freenet-history-'))
    const cores = []
    t.teardown(async () => {
      for (const core of cores) await core.close().catch(() => {})
      await fs.promises.rm(dir, { recursive: true, force: true })
    })
    const open = async (name, key) => {
      const core = new Hypercore(path.join(dir, name), key)
      cores.push(core)
      await core.ready()
      return core
    }
    const hostStore = { log: await open('host-log'), metaCore: await open('host-meta') }
    const blocks = []
    for (let i = 0; i < BLOCKS; i++) blocks.push(crypto.randomBytes(BLOCK))
    await hostStore.log.append(blocks)
    await hostStore.metaCore.append(Buffer.from('meta-0'))
    const viewerStore = {
      log: await open('viewer-log', hostStore.log.key),
      metaCore: await open('viewer-meta', hostStore.metaCore.key)
    }

    const host = await peer(t)
    const viewer = await peer(t)
    host.backend.setAdmission(true)
    const { route: r } = await host.backend.announce('link-history')
    const { conn, hostConn } = await connect(t, host, viewer, r)

    const labels = []
    const openChannel = host.rtcHost.openChannel
    host.rtcHost.openChannel = (connId, chanId, label) => {
      labels.push(label)
      return openChannel(connId, chanId, label)
    }
    const sizes = []
    const send = host.rtcHost.send
    host.rtcHost.send = (connId, chanId, data) => {
      sizes.push(data.byteLength)
      return send(connId, chanId, data)
    }
    let surfaced = 0
    conn.onChannel('zbterm/history', () => surfaced++)

    let replicates = 0
    const replicate = hostStore.log.replicate
    hostStore.log.replicate = function (...args) {
      replicates++
      return replicate.apply(this, args)
    }
    host.backend.serveHistory(hostConn, hostStore)
    host.backend.serveHistory(hostConn, hostStore)
    t.is(replicates, 1, 'a second serveHistory on the same connection and store is a no-op')
    await until(() => labels.length > 0, CONNECT_TIMEOUT_MS, 'the history data channel')
    t.alike(labels, ['zbterm/history 00'], 'the host opened the history data channel')

    const handle = viewer.backend.attachHistory(conn, viewerStore, {})
    await within(30000, handle.fetch({ start: 0, end: BLOCKS }).done(), 'the history fetch')
    t.is(viewerStore.log.contiguousLength, BLOCKS, `all ${BLOCKS} blocks of ${BLOCK} bytes arrived`)
    t.alike(await viewerStore.log.get(BLOCKS - 1, { wait: false }), blocks[BLOCKS - 1], 'intact')
    t.alike(await viewerStore.metaCore.get(0), Buffer.from('meta-0'), 'the meta core came along')
    t.ok(
      sizes.length > 0 && sizes.every((size) => size <= 65536),
      `${sizes.length} messages, none above 65 536 bytes (largest ${Math.max(...sizes)})`
    )
    t.ok(
      sizes.filter((size) => size === 65536).length >= BLOCKS * 3,
      'the block frames were cut at the message cap'
    )
    t.is(surfaced, 0, 'the history channel never reaches an onChannel listener')
    handle.close()
  }
)

// S-26: a host that had the viewer's candidates reached ICE `connected` by
// its own checks while its answer was still on the way; the viewer, applying
// the answer late, failed the DTLS certificate check and the join hung. A
// dial now sends its candidates only after it applied the answer, so no host
// peer connection gets a remote candidate before its viewer holds the
// answer. The viewer's notifications are held back 1 500 ms here, the way a
// slow node or a busy machine delivers them. Two dials from one key to one
// host, as ShareManager makes for two sessions: both connect, and each
// connection carries its own session's history.
test(
  'freenet: a dial sends its candidates only after it applied the answer; two dials from one key both connect and attach history (S-26)',
  { timeout: 90000 },
  async (t) => {
    if (!freenetAvailable()) {
      t.skip('freenet binary not on PATH')
      return
    }
    const LATE_MS = 1500
    const host = await peer(t)
    const viewer = await peer(t)
    host.backend.setAdmission(true)
    const deliver = viewer.backend._onNotification.bind(viewer.backend)
    viewer.backend._onNotification = (n) => setTimeout(() => deliver(n), LATE_MS)

    let answersApplied = 0
    const viewerSignal = viewer.rtcHost.signal
    viewer.rtcHost.signal = (connId, msg) => {
      if (msg.type === 'answer') answersApplied++
      return viewerSignal(connId, msg)
    }
    const early = []
    const withCandidates = new Set()
    const hostSignal = host.rtcHost.signal
    host.rtcHost.signal = (connId, msg) => {
      if (msg.type === 'candidate') {
        withCandidates.add(connId)
        if (withCandidates.size > answersApplied) early.push(connId)
      }
      return hostSignal(connId, msg)
    }

    const { route: ra } = await host.backend.announce('link-a')
    const { route: rb } = await host.backend.announce('link-b')
    const dials = [ra, rb].map((r) => viewer.backend.dial(r, host.keyPair.publicKey))
    const conns = await within(
      CONNECT_TIMEOUT_MS + 4 * LATE_MS,
      Promise.all(dials.map((dial) => dial.connected)),
      'both dials connected'
    )
    await until(() => host.connections.length === 2, CONNECT_TIMEOUT_MS, "both 'connection's")
    t.is(conns.length, 2, 'both dials from one key to one host connected')
    t.not(conns[0], conns[1], 'as two connections')
    t.is(answersApplied, 2, 'the viewer applied two answers')
    // The viewer's candidates may never be needed: its own checks can bring the
    // connection up before they are flushed, and a surfaced dial sends nothing.
    t.comment(`host connections that got viewer candidates: ${withCandidates.size}`)
    t.alike(early, [], 'never before the viewer had applied the answer they belong to')

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-freenet-two-'))
    const cores = []
    t.teardown(async () => {
      for (const core of cores) await core.close().catch(() => {})
      await fs.promises.rm(dir, { recursive: true, force: true })
    })
    const open = async (name, key) => {
      const core = new Hypercore(path.join(dir, name), key)
      cores.push(core)
      await core.ready()
      return core
    }
    const byViewer = new Map(conns.map((conn, i) => [i, conn]))
    for (const [i, conn] of byViewer) {
      // The host connection whose info names this dial's link.
      const link = i === 0 ? 'link-a' : 'link-b'
      const hostSide = host.connections.find(({ info }) => info.linkId === link)
      t.ok(hostSide, `the host connection for ${link}`)
      const hostStore = { log: await open(`host-log-${i}`), metaCore: await open(`host-meta-${i}`) }
      await hostStore.log.append([Buffer.from(`session-${i}-0`), Buffer.from(`session-${i}-1`)])
      await hostStore.metaCore.append(Buffer.from(`meta-${i}`))
      const viewerStore = {
        log: await open(`viewer-log-${i}`, hostStore.log.key),
        metaCore: await open(`viewer-meta-${i}`, hostStore.metaCore.key)
      }
      host.backend.serveHistory(hostSide.conn, hostStore)
      const handle = viewer.backend.attachHistory(conn, viewerStore, {})
      await within(20000, handle.fetch({ start: 0, end: 2 }).done(), `history over ${link}`)
      t.alike(
        await viewerStore.log.get(1, { wait: false }),
        Buffer.from(`session-${i}-1`),
        `the history of ${link} arrived on its own connection`
      )
      t.alike(await viewerStore.metaCore.get(0), Buffer.from(`meta-${i}`), 'with its meta core')
      handle.close()
    }
  }
)

// S-26: node-datachannel reports `connected` before it has opened the
// data channels made before SCTP was up; a channel created in that window is
// opened twice and reset. A connection therefore creates its own data
// channels in the host half only once the bootstrap channel reports open.
// Here the viewer's host half holds that report back.
test('freenet: channels opened before the bootstrap channel is open are created once it opens (S-26)', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  const viewer = await peer(t)
  host.backend.setAdmission(true)
  let held = null
  const emit = viewer.rtcHost.emit.bind(viewer.rtcHost)
  viewer.rtcHost.emit = (name, body) => {
    if (name === 'channel' && body.op === 'opened' && body.label === 'zbterm/fnet-bootstrap') {
      held = () => emit(name, body)
      return true
    }
    return emit(name, body)
  }
  const created = []
  const openChannel = viewer.rtcHost.openChannel
  viewer.rtcHost.openChannel = (connId, chanId, label) => {
    if (label.startsWith(CHANNEL)) created.push(label)
    return openChannel(connId, chanId, label)
  }
  const { route: r } = await host.backend.announce('link-bootstrap')
  const { conn, hostConn } = await connect(t, host, viewer, r)
  const received = []
  hostConn.onChannel(CHANNEL, (id) => {
    hostConn.openChannel(CHANNEL, id, { onmessage: (message) => received.push(message) })
  })
  await until(() => held !== null, CONNECT_TIMEOUT_MS, 'the bootstrap channel opened')
  const channel = conn.openChannel(CHANNEL, Buffer.from('early'), { onmessage: () => {} })
  channel.send({ early: true })
  await delay(200)
  t.alike(created, [], 'no data channel is created while the bootstrap channel is not open')
  held()
  t.alike(
    created,
    [`${CHANNEL} ${Buffer.from('early').toString('hex')}`],
    'it is created once it opens'
  )
  await until(() => received.length === 1, CONNECT_TIMEOUT_MS, 'the queued message')
  t.alike(received, [{ early: true }], 'and what was sent meanwhile arrives')
})

// S-27: node-datachannel delivered messages that reached a remote-opened
// data channel before its handler was set out of order (one message hundreds
// late). The opener of a data channel now sends nothing until the other side
// has wired it and says so with a READY part. Here the host's READY is held
// back.
test('freenet: the opener of a channel sends nothing until the other side is ready (S-27)', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const host = await peer(t)
  const viewer = await peer(t)
  host.backend.setAdmission(true)
  const { route: r } = await host.backend.announce('link-ready')
  const { conn, hostConn } = await connect(t, host, viewer, r)
  let release = null
  const hostSend = host.rtcHost.send
  host.rtcHost.send = (connId, chanId, data) => {
    if (!release && data.byteLength === 5 && data[0] === 2) {
      release = () => hostSend(connId, chanId, data)
      return true
    }
    return hostSend(connId, chanId, data)
  }
  let sent = 0
  const viewerSend = viewer.rtcHost.send
  viewer.rtcHost.send = (connId, chanId, data) => {
    sent++
    return viewerSend(connId, chanId, data)
  }
  const received = []
  hostConn.onChannel(CHANNEL, (id) => {
    hostConn.openChannel(CHANNEL, id, { onmessage: (message) => received.push(message.i) })
  })
  const channel = conn.openChannel(CHANNEL, Buffer.from('ready'), { onmessage: () => {} })
  const BURST = 2000
  for (let i = 0; i < BURST; i++) channel.send({ i })
  await until(() => release !== null, CONNECT_TIMEOUT_MS, "the host's READY")
  await delay(200)
  t.is(sent, 0, 'nothing is sent before the other side is ready')
  release()
  await until(() => received.length === BURST, CONNECT_TIMEOUT_MS, 'the burst')
  t.ok(
    received.every((i, at) => i === at),
    `all ${BURST} messages arrived in order once it was`
  )
})

// Last: the node, the client and node-datachannel's global teardown (without
// it the process never exits).
test('freenet: teardown', async (t) => {
  if (client) await client.close()
  if (node) await node.stop()
  RtcHost.cleanup()
  t.pass(node ? `stopped the local node (pid ${node.pid})` : 'no node was started')
})
