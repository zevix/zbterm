// The seven BACKEND_* frame kinds (Freenet design 3.1): appended after
// PTY_DETACH, each with a compact-encoding body in engine/rpc/schema.js.
const test = require('brittle')

const { FrameKind, FrameKindName, encodeFrame, decodeFrame } = require('../engine/rpc/schema')

function roundTrip(t, kind, body, expected = body) {
  const decoded = decodeFrame(encodeFrame(kind, 0, body))
  t.is(decoded.kind, kind, `${FrameKindName[kind]} kind round trips`)
  t.is(decoded.id, 0)
  t.alike(decoded.body, expected, `${FrameKindName[kind]} body round trips`)
}

test('backend frames: kinds 0-14 keep their numbers and 15-21 are appended in order', (t) => {
  t.alike(Object.entries(FrameKind), [
    ['INVOKE', 0],
    ['REPLY_OK', 1],
    ['REPLY_ERR', 2],
    ['EVENT_JSON', 3],
    ['EVENT_DATA', 4],
    ['PTY_SPAWN', 5],
    ['PTY_WRITE', 6],
    ['PTY_RESIZE', 7],
    ['PTY_KILL', 8],
    ['PTY_PAUSE', 9],
    ['PTY_RESUME', 10],
    ['PTY_DATA', 11],
    ['PTY_EXIT', 12],
    ['PTY_ATTACH', 13],
    ['PTY_DETACH', 14],
    ['BACKEND_OPEN', 15],
    ['BACKEND_SIGNAL', 16],
    ['BACKEND_STATE', 17],
    ['BACKEND_CHANNEL', 18],
    ['BACKEND_DATA', 19],
    ['BACKEND_FLOW', 20],
    ['BACKEND_CLOSE', 21]
  ])
  t.is(FrameKindName[21], 'BACKEND_CLOSE', 'FrameKindName covers the new kinds')
})

test('backend frames: BACKEND_OPEN round trips, with and without an iceServers override', (t) => {
  roundTrip(t, FrameKind.BACKEND_OPEN, {
    connId: 1,
    iceServers: ['stun:stun.example.test:3478', { urls: 'turn:t.example.test', username: 'u' }]
  })
  roundTrip(t, FrameKind.BACKEND_OPEN, { connId: 2, iceServers: [] })
  roundTrip(t, FrameKind.BACKEND_OPEN, { connId: 3 }, { connId: 3, iceServers: null })
})

test('backend frames: BACKEND_SIGNAL round trips a description and a candidate', (t) => {
  roundTrip(
    t,
    FrameKind.BACKEND_SIGNAL,
    { connId: 1, type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD\r\n' },
    {
      connId: 1,
      type: 'offer',
      sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD\r\n',
      candidate: null,
      mid: null
    }
  )
  roundTrip(
    t,
    FrameKind.BACKEND_SIGNAL,
    {
      connId: 1,
      type: 'candidate',
      candidate: 'a=candidate:1 1 UDP 1 127.0.0.1 5000 typ host',
      mid: '0'
    },
    {
      connId: 1,
      type: 'candidate',
      sdp: null,
      candidate: 'a=candidate:1 1 UDP 1 127.0.0.1 5000 typ host',
      mid: '0'
    }
  )
})

test('backend frames: BACKEND_STATE round trips, fingerprints and path optional', (t) => {
  roundTrip(t, FrameKind.BACKEND_STATE, {
    connId: 4,
    state: 'connected',
    localFingerprint: 'sha-256 AA:BB',
    remoteFingerprint: 'sha-256 CC:DD',
    pathKind: 'host'
  })
  roundTrip(
    t,
    FrameKind.BACKEND_STATE,
    { connId: 4, state: 'connecting' },
    {
      connId: 4,
      state: 'connecting',
      localFingerprint: null,
      remoteFingerprint: null,
      pathKind: null
    }
  )
})

test('backend frames: BACKEND_CHANNEL round trips each op', (t) => {
  for (const op of ['open', 'opened', 'closed']) {
    roundTrip(t, FrameKind.BACKEND_CHANNEL, { connId: 1, chanId: 0x80000000, label: 'l', op })
  }
  roundTrip(
    t,
    FrameKind.BACKEND_CHANNEL,
    { connId: 1, chanId: 2, op: 'closed' },
    { connId: 1, chanId: 2, label: null, op: 'closed' }
  )
})

test('backend frames: BACKEND_DATA carries a 65 536-byte binary message intact', (t) => {
  const data = Buffer.from(Array.from({ length: 65536 }, (_, i) => (i * 31 + 17) & 0xff))
  const decoded = decodeFrame(
    encodeFrame(FrameKind.BACKEND_DATA, 0, { connId: 9, chanId: 3, data })
  )
  t.is(decoded.body.connId, 9)
  t.is(decoded.body.chanId, 3)
  t.ok(Buffer.isBuffer(decoded.body.data), 'a buffer, not JSON')
  t.ok(decoded.body.data.equals(data), 'every byte intact')
  roundTrip(t, FrameKind.BACKEND_DATA, { connId: 0, chanId: 0, data: Buffer.alloc(0) })
})

test('backend frames: BACKEND_FLOW and BACKEND_CLOSE round trip', (t) => {
  roundTrip(t, FrameKind.BACKEND_FLOW, { connId: 1, chanId: 2, paused: true })
  roundTrip(t, FrameKind.BACKEND_FLOW, { connId: 1, chanId: 2, paused: false })
  roundTrip(t, FrameKind.BACKEND_CLOSE, { connId: 1, reason: 'ice-failed' })
  roundTrip(t, FrameKind.BACKEND_CLOSE, { connId: 1 }, { connId: 1, reason: null })
})

test('backend frames: a truncated BACKEND_* body is E_CORRUPT', (t) => {
  for (const [kind, body] of [
    [FrameKind.BACKEND_OPEN, { connId: 1, iceServers: ['stun:x'] }],
    [FrameKind.BACKEND_SIGNAL, { connId: 1, type: 'answer', sdp: 'v=0' }],
    [FrameKind.BACKEND_STATE, { connId: 1, state: 'connected', pathKind: 'host' }],
    [FrameKind.BACKEND_CHANNEL, { connId: 1, chanId: 2, label: 'l', op: 'open' }],
    [FrameKind.BACKEND_DATA, { connId: 1, chanId: 2, data: Buffer.alloc(64, 1) }],
    [FrameKind.BACKEND_FLOW, { connId: 1, chanId: 2, paused: true }],
    [FrameKind.BACKEND_CLOSE, { connId: 1, reason: 'x' }]
  ]) {
    const buf = encodeFrame(kind, 0, body)
    try {
      decodeFrame(buf.subarray(0, buf.byteLength - 1))
      t.fail(`${FrameKindName[kind]}: truncation should throw`)
    } catch (err) {
      t.is(err.code, 'E_CORRUPT', `${FrameKindName[kind]}: truncated -> E_CORRUPT`)
    }
  }
})
