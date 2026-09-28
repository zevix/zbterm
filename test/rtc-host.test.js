// electron/rtc-host.js (Freenet design 3, 3.1; D-06/D-09): the host half of
// the Freenet backend's WebRTC, on node-datachannel. Two RtcHost instances in
// this process, wired by an in-process signalling relay, connect on loopback
// with no ICE servers (host candidates only).
const crypto = require('crypto')
const test = require('brittle')

const { RtcHost, MAX_MESSAGE_SIZE, REMOTE_CHANNEL_BASE } = require('../electron/rtc-host')

const CONN = 7
const CHAN = 1
const MESSAGES = 1000
const BURST_BYTES = 64 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 15000
const TRANSFER_TIMEOUT_MS = 120000

function within(ms, promise, what) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function once(emitter, name, match = () => true) {
  return new Promise((resolve) => {
    const on = (event) => {
      if (!match(event)) return
      emitter.off(name, on)
      resolve(event)
    }
    emitter.on(name, on)
  })
}

// node-datachannel's global teardown runs once, after the last test (the last
// test in this file): without it the process never exits.

// The offerer `a` opens the connection and the channel; `b` opens its side
// when the offer arrives, as the host half of a share would on BACKEND_OPEN.
function pair(t) {
  const a = new RtcHost({ iceServers: [] })
  const b = new RtcHost({ iceServers: [] })
  const states = { a: [], b: [] }
  const relay = (from, to) =>
    from.on('signal', (msg) => {
      // A real relay is asynchronous; so is this one.
      setImmediate(() => {
        if (msg.type === 'offer' && !to.conns.has(CONN)) to.open(CONN, { iceServers: [] })
        to.signal(CONN, msg)
      })
    })
  relay(a, b)
  relay(b, a)
  a.on('state', (s) => states.a.push(s))
  b.on('state', (s) => states.b.push(s))
  t.teardown(() => {
    a.closeAll('teardown')
    b.closeAll('teardown')
  })
  return { a, b, states }
}

async function connect(t, { a, b }) {
  const aOpened = once(a, 'channel', (c) => c.op === 'opened')
  const bOpened = once(b, 'channel', (c) => c.op === 'opened')
  t.ok(a.open(CONN, { iceServers: [] }), 'open() creates a peer connection')
  t.ok(a.openChannel(CONN, CHAN, 'zbterm-test'), 'openChannel() creates a data channel')
  const [local, remote] = await within(
    CONNECT_TIMEOUT_MS,
    Promise.all([aOpened, bOpened]),
    'channel open'
  )
  return { local, remote }
}

function digest(buffers) {
  const hash = crypto.createHash('sha256')
  for (const buffer of buffers) hash.update(buffer)
  return hash.digest('hex')
}

test('rtc-host: node-datachannel loads here', (t) => {
  t.is(RtcHost.available(), true, 'RtcHost.available()')
  t.is(RtcHost.loadError(), null, 'and there is no load error')
})

test('rtc-host: two hosts connect on loopback and echo 1 000 binary messages of 65 536 bytes intact', async (t) => {
  const hosts = pair(t)
  const { a, b, states } = hosts
  const { local, remote } = await connect(t, hosts)
  t.alike(local, { connId: CONN, chanId: CHAN, label: 'zbterm-test', op: 'opened' })
  t.is(remote.label, 'zbterm-test', 'the remote side sees the label')
  t.ok(
    remote.chanId >= REMOTE_CHANNEL_BASE,
    'and a host-assigned chanId for a channel it did not open'
  )

  for (const [name, list] of Object.entries(states)) {
    const connected = list.find((s) => s.state === 'connected')
    t.ok(connected, `${name}: state reports connected`)
    t.ok(/^sha-256 [0-9A-F:]{95}$/.test(connected.localFingerprint), `${name}: a local fingerprint`)
    t.ok(
      /^sha-256 [0-9A-F:]{95}$/.test(connected.remoteFingerprint),
      `${name}: a remote fingerprint`
    )
    t.is(connected.pathKind, 'host', `${name}: pathKind is host`)
  }
  const aUp = states.a.find((s) => s.state === 'connected')
  const bUp = states.b.find((s) => s.state === 'connected')
  t.is(aUp.remoteFingerprint, bUp.localFingerprint, "a's remote fingerprint is b's own")
  t.is(bUp.remoteFingerprint, aUp.localFingerprint, "and b's is a's")

  t.exception.all(
    () => a.send(CONN, CHAN, Buffer.alloc(MAX_MESSAGE_SIZE + 1)),
    /exceeds/,
    'a message over 65 536 bytes is refused'
  )

  // b echoes every message on the channel it received it on.
  b.on('data', ({ connId, chanId, data }) => b.send(connId, chanId, data))
  const sent = []
  const echoed = []
  const done = new Promise((resolve) => {
    a.on('data', ({ data }) => {
      echoed.push(Buffer.from(data))
      if (echoed.length === MESSAGES) resolve()
    })
  })
  let resumed = null
  a.on('flow', ({ paused }) => {
    if (!paused && resumed) resumed()
  })
  for (let i = 0; i < MESSAGES; i++) {
    const message = crypto.randomBytes(MAX_MESSAGE_SIZE)
    sent.push(message)
    if (!a.send(CONN, CHAN, message)) await new Promise((resolve) => (resumed = resolve))
  }
  const started = Date.now()
  await within(TRANSFER_TIMEOUT_MS, done, 'echo')
  t.comment(`echo drained ${Date.now() - started} ms after the last send`)
  t.is(echoed.length, MESSAGES, `${MESSAGES} messages came back`)
  t.ok(
    echoed.every((m) => m.byteLength === MAX_MESSAGE_SIZE),
    'each 65 536 bytes long'
  )
  t.is(digest(echoed), digest(sent), 'and byte-identical, in order')

  const aClosed = once(a, 'close')
  const bClosed = once(b, 'close')
  a.close(CONN, 'done')
  const [ours, theirs] = await within(CONNECT_TIMEOUT_MS, Promise.all([aClosed, bClosed]), 'close')
  t.alike(ours, { connId: CONN, reason: 'done' }, 'close() ends our side with its reason')
  t.is(theirs.connId, CONN, 'and the remote side sees the connection end')
  t.is(a.conns.size, 0, 'no connection is left on a')
  t.is(b.conns.size, 0, 'or on b')
  t.is(a.send(CONN, CHAN, Buffer.alloc(1)), false, 'send() after close returns false')
})

test('rtc-host: flow pauses and resumes under a 64 MiB burst', async (t) => {
  const hosts = pair(t)
  const { a, b } = hosts
  await connect(t, hosts)

  let received = 0
  const all = new Promise((resolve) => {
    b.on('data', ({ data }) => {
      received += data.byteLength
      if (received === BURST_BYTES) resolve()
    })
  })
  const flow = []
  const resumed = new Promise((resolve) => {
    a.on('flow', (event) => {
      flow.push(event.paused)
      if (!event.paused) resolve()
    })
  })
  const message = Buffer.alloc(MAX_MESSAGE_SIZE, 0xa5)
  let refused = 0
  for (let sent = 0; sent < BURST_BYTES; sent += MAX_MESSAGE_SIZE) {
    if (!a.send(CONN, CHAN, message)) refused++
  }
  t.ok(refused > 0, `send() returned false ${refused} times past the high-water mark`)
  await within(TRANSFER_TIMEOUT_MS, Promise.all([all, resumed]), 'burst')
  t.is(flow[0], true, 'flow reported paused first')
  t.ok(flow.includes(false), 'and resumed on onBufferedAmountLow')
  t.is(received, BURST_BYTES, 'every byte of the burst arrived')
  a.close(CONN, 'done')
})

test('rtc-host: node-datachannel cleans up', (t) => {
  RtcHost.cleanup()
  t.pass('cleanup() returned')
})
