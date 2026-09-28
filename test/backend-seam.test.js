// The BACKEND_* seam (Freenet design 3, 3.1): EngineClient dispatches the
// worker's BACKEND_* frames to the injected rtcHost and turns its events back
// into frames; RtcRemote is the worker-side proxy. The client runs against a
// fake pipe here - no sidecar - by standing a stub in for
// engine/spawn-worker.js::spawnWorker, which EngineClient calls through the
// module object.
const { EventEmitter } = require('events')
const { Duplex } = require('streamx')
const FramedStream = require('framed-stream')
const test = require('brittle')

const spawner = require('../engine/spawn-worker')
const registry = require('../engine/backends')
const { EngineClient } = require('../engine/client')
const { FrameKind, encodeFrame, decodeFrame } = require('../engine/rpc/schema')
const { PIPE_HIGH_WATER_MARK } = require('../engine/rpc/pipe')

// The host end is what spawnWorker returns (EngineClient wraps it in a
// FramedStream); the worker end is read and written through its own
// FramedStream by the test. `gate()` holds the host end's writes, so the
// client's pipe fills and write() returns false.
function fakeSpawn(t) {
  const spawns = []
  const original = spawner.spawnWorker
  spawner.spawnWorker = (entrypoint, args) => {
    let held = null
    let hostEnd = null
    const workerEnd = new Duplex({
      write(data, cb) {
        hostEnd.push(data)
        cb(null)
      }
    })
    hostEnd = new Duplex({
      write(data, cb) {
        if (held) held.push(() => (workerEnd.push(data), cb(null)))
        else (workerEnd.push(data), cb(null))
      }
    })
    hostEnd._process = { pid: null }
    const worker = new FramedStream(workerEnd)
    const frames = []
    worker.on('data', (buf) => {
      const frame = decodeFrame(buf)
      frames.push(frame)
      worker.emit('frame', frame)
    })
    spawns.push({
      entrypoint,
      args,
      frames,
      send: (kind, body) => worker.write(encodeFrame(kind, 0, body)),
      next: (kind) =>
        new Promise((resolve) => {
          const on = (frame) => {
            if (frame.kind !== kind) return
            worker.off('frame', on)
            resolve(frame)
          }
          worker.on('frame', on)
        }),
      gate: () => (held = held || []),
      release: () => {
        const pending = held || []
        held = null
        for (const fn of pending) fn()
      }
    })
    return hostEnd
  }
  t.teardown(() => {
    spawner.spawnWorker = original
  })
  return spawns
}

function ptyHost() {
  const host = new EventEmitter()
  host.sessions = new Map()
  return host
}

// Records every call EngineClient makes on it.
class FakeRtcHost extends EventEmitter {
  constructor() {
    super()
    this.calls = []
    for (const name of ['open', 'signal', 'openChannel', 'closeChannel', 'send', 'close']) {
      this[name] = (...args) => {
        this.calls.push([name, ...args])
        return true
      }
    }
    for (const name of ['pause', 'resume', 'closeAll']) {
      this[name] = (...args) => this.calls.push([name, ...args])
    }
  }
}

async function ready(client, spawn) {
  spawn.send(FrameKind.EVENT_JSON, { name: 'engine:worker-ready', data: { sessionIds: [] } })
  await client.ready()
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

const ALL_BYTES = Buffer.from(Array.from({ length: 65536 }, (_, i) => (i * 7 + 3) & 0xff))

test('backend seam: the 5th spawn argument is hostCaps - "" without an rtcHost, "rtc" with one', (t) => {
  const spawns = fakeSpawn(t)
  const plain = new EngineClient({ userData: '/data', ptyHost: ptyHost() })
  t.alike(spawns[0].args, ['/data', '', '', '', ''], 'no adapter: no capabilities')
  const withRtc = new EngineClient({
    userData: '/data',
    backend: 'freenet',
    ptyHost: ptyHost(),
    rtcHost: new FakeRtcHost()
  })
  t.alike(spawns[1].args, ['/data', '', '', 'freenet', 'rtc'], 'an adapter: rtc, after backend')
  t.is(plain.rtcHost, null)
  t.ok(withRtc.rtcHost)
})

test('backend seam: BACKEND_* frames from the worker reach the rtcHost', async (t) => {
  const spawns = fakeSpawn(t)
  const rtcHost = new FakeRtcHost()
  const client = new EngineClient({ userData: '/data', ptyHost: ptyHost(), rtcHost })
  const spawn = spawns[0]
  await ready(client, spawn)

  spawn.send(FrameKind.BACKEND_OPEN, { connId: 3, iceServers: ['stun:example.test:3478'] })
  spawn.send(FrameKind.BACKEND_SIGNAL, { connId: 3, type: 'answer', sdp: 'v=0' })
  spawn.send(FrameKind.BACKEND_SIGNAL, { connId: 3, type: 'candidate', candidate: 'c', mid: '0' })
  spawn.send(FrameKind.BACKEND_CHANNEL, { connId: 3, chanId: 1, label: 'x', op: 'open' })
  spawn.send(FrameKind.BACKEND_DATA, { connId: 3, chanId: 1, data: ALL_BYTES })
  spawn.send(FrameKind.BACKEND_CHANNEL, { connId: 3, chanId: 1, label: null, op: 'closed' })
  spawn.send(FrameKind.BACKEND_CLOSE, { connId: 3, reason: 'bye' })
  await flush()

  const calls = rtcHost.calls
  t.alike(
    calls[0],
    ['open', 3, { iceServers: ['stun:example.test:3478'] }],
    'BACKEND_OPEN -> open()'
  )
  t.is(calls[1][0], 'signal')
  t.is(calls[1][1], 3)
  t.alike(
    [calls[1][2].type, calls[1][2].sdp],
    ['answer', 'v=0'],
    'BACKEND_SIGNAL (description) -> signal()'
  )
  t.alike(
    [calls[2][2].type, calls[2][2].candidate, calls[2][2].mid],
    ['candidate', 'c', '0'],
    'BACKEND_SIGNAL (candidate) -> signal()'
  )
  t.alike(calls[3], ['openChannel', 3, 1, 'x'], 'BACKEND_CHANNEL open -> openChannel()')
  t.is(calls[4][0], 'send', 'BACKEND_DATA -> send()')
  t.alike([calls[4][1], calls[4][2]], [3, 1])
  t.ok(Buffer.from(calls[4][3]).equals(ALL_BYTES), 'with the bytes intact')
  t.alike(calls[5], ['closeChannel', 3, 1], 'BACKEND_CHANNEL closed -> closeChannel()')
  t.alike(calls[6], ['close', 3, 'bye'], 'BACKEND_CLOSE -> close()')
})

test('backend seam: rtcHost events become BACKEND_* frames, data bytes intact', async (t) => {
  const spawns = fakeSpawn(t)
  const rtcHost = new FakeRtcHost()
  const client = new EngineClient({ userData: '/data', ptyHost: ptyHost(), rtcHost })
  const spawn = spawns[0]
  await ready(client, spawn)

  const data = spawn.next(FrameKind.BACKEND_DATA)
  rtcHost.emit('data', { connId: 3, chanId: 9, data: ALL_BYTES })
  const frame = await data
  t.is(frame.body.connId, 3)
  t.is(frame.body.chanId, 9)
  t.ok(frame.body.data.equals(ALL_BYTES), 'BACKEND_DATA carries all 65 536 bytes intact')

  const events = [
    ['signal', FrameKind.BACKEND_SIGNAL, { connId: 3, type: 'offer', sdp: 'v=0' }],
    [
      'state',
      FrameKind.BACKEND_STATE,
      {
        connId: 3,
        state: 'connected',
        localFingerprint: 'sha-256 AA',
        remoteFingerprint: 'sha-256 BB',
        pathKind: 'host'
      }
    ],
    ['channel', FrameKind.BACKEND_CHANNEL, { connId: 3, chanId: 9, label: 'x', op: 'opened' }],
    ['flow', FrameKind.BACKEND_FLOW, { connId: 3, chanId: 9, paused: true }],
    ['close', FrameKind.BACKEND_CLOSE, { connId: 3, reason: 'failed' }]
  ]
  for (const [name, kind, body] of events) {
    const next = spawn.next(kind)
    rtcHost.emit(name, body)
    const got = await next
    for (const [field, value] of Object.entries(body)) {
      t.is(got.body[field], value, `${name} -> ${field}`)
    }
  }
})

test('backend seam: a full pipe pauses the rtcHost channel, and drain resumes it', async (t) => {
  const spawns = fakeSpawn(t)
  const rtcHost = new FakeRtcHost()
  const client = new EngineClient({ userData: '/data', ptyHost: ptyHost(), rtcHost })
  const spawn = spawns[0]
  await ready(client, spawn)

  // A single ALL_BYTES-sized frame (65 536 bytes) must not trip backpressure
  // on its own (engine/rpc/pipe.js) - only genuinely piling up past
  // PIPE_HIGH_WATER_MARK while the raw transport is gated (nothing ever
  // drains) does, so this writes enough of them to actually cross it.
  spawn.gate()
  const writes = Math.ceil(PIPE_HIGH_WATER_MARK / ALL_BYTES.byteLength) + 2
  for (let i = 0; i < writes; i++) rtcHost.emit('data', { connId: 1, chanId: 2, data: ALL_BYTES })
  t.alike(
    rtcHost.calls.filter(([name]) => name === 'pause'),
    [['pause', 1, 2]],
    'one pause() for the channel whose write returned false'
  )
  spawn.release()
  await flush()
  t.alike(
    rtcHost.calls.filter(([name]) => name === 'resume'),
    [['resume', 1, 2]],
    "resume() on the pipe's drain"
  )
})

test('backend seam: without an rtcHost, BACKEND_OPEN is answered with BACKEND_CLOSE', async (t) => {
  const spawns = fakeSpawn(t)
  const client = new EngineClient({ userData: '/data', ptyHost: ptyHost() })
  const spawn = spawns[0]
  await ready(client, spawn)
  const closed = spawn.next(FrameKind.BACKEND_CLOSE)
  spawn.send(FrameKind.BACKEND_OPEN, { connId: 5, iceServers: null })
  const frame = await closed
  t.alike(frame.body, { connId: 5, reason: 'host has no WebRTC adapter' })
})

test('backend seam: RtcRemote turns calls into frames and frames into events', (t) => {
  const sent = []
  let pipeFull = false
  const remote = registry.rtcRemote((kind, id, body) => {
    // Through the real codec, as the worker's send() does.
    sent.push(decodeFrame(encodeFrame(kind, id, body)))
    return !pipeFull
  })
  t.ok(remote, 'the registry hands out an RtcRemote in a build with the Freenet backend')

  remote.open(1, { iceServers: [] })
  remote.signal(1, { type: 'candidate', candidate: 'c', mid: 0 })
  remote.openChannel(1, 2, 'x')
  t.is(remote.send(1, 2, ALL_BYTES), true, 'send() is true while nothing is paused')
  remote.closeChannel(1, 2)
  remote.close(1, 'bye')
  t.alike(
    sent.map((frame) => frame.kind),
    [
      FrameKind.BACKEND_OPEN,
      FrameKind.BACKEND_SIGNAL,
      FrameKind.BACKEND_CHANNEL,
      FrameKind.BACKEND_DATA,
      FrameKind.BACKEND_CHANNEL,
      FrameKind.BACKEND_CLOSE
    ],
    'one frame per call'
  )
  t.alike(sent[0].body, { connId: 1, iceServers: [] })
  t.is(sent[1].body.mid, '0', 'mid travels as a string')
  t.is(sent[2].body.op, 'open')
  t.ok(sent[3].body.data.equals(ALL_BYTES), 'data bytes intact')
  t.is(sent[4].body.op, 'closed')
  t.alike(sent[5].body, { connId: 1, reason: 'bye' })

  const events = []
  for (const name of ['signal', 'state', 'channel', 'data', 'flow', 'close']) {
    remote.on(name, (body) => events.push([name, body]))
  }
  const inbound = (kind, body) => remote.handleFrame({ kind, id: 0, body })
  t.ok(inbound(FrameKind.BACKEND_SIGNAL, { connId: 1, type: 'offer', sdp: 'v=0' }))
  t.ok(inbound(FrameKind.BACKEND_STATE, { connId: 1, state: 'connected' }))
  t.ok(inbound(FrameKind.BACKEND_CHANNEL, { connId: 1, chanId: 3, label: 'y', op: 'opened' }))
  t.ok(inbound(FrameKind.BACKEND_DATA, { connId: 1, chanId: 3, data: ALL_BYTES }))
  t.absent(inbound(FrameKind.PTY_DATA, { sessionId: 's', data: ALL_BYTES }), 'not a BACKEND_* kind')
  t.alike(
    events.map(([name]) => name),
    ['signal', 'state', 'channel', 'data'],
    'each inbound kind is its event'
  )

  // Flow: the host's pause, then the pipe's, combine into one paused state.
  events.length = 0
  t.ok(inbound(FrameKind.BACKEND_FLOW, { connId: 1, chanId: 3, paused: true }))
  t.is(remote.send(1, 3, ALL_BYTES), false, 'send() is false while the host has paused it')
  pipeFull = true
  remote.send(1, 3, ALL_BYTES)
  t.ok(inbound(FrameKind.BACKEND_FLOW, { connId: 1, chanId: 3, paused: false }))
  t.is(remote.send(1, 3, ALL_BYTES), false, 'and while the pipe is full')
  pipeFull = false
  remote.handleDrain()
  t.alike(
    events.filter(([name]) => name === 'flow').map(([, body]) => body.paused),
    [true, false],
    'flow: paused once, resumed once both have cleared'
  )
  t.is(remote.send(1, 3, ALL_BYTES), true)

  t.ok(inbound(FrameKind.BACKEND_CLOSE, { connId: 1, reason: 'failed' }))
  t.alike(events[events.length - 1], ['close', { connId: 1, reason: 'failed' }])
})
