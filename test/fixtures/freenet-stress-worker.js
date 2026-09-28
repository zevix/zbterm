// Bare sidecar entrypoint for test/pipe-backpressure-flood.test.js: byte-for-
// byte engine/worker.js (the real seam - FramedStream, RtcRemote, the
// backends registry, ShareManager, all unmodified), with exactly one
// addition: the Freenet backend's node URL can be pointed at a throwaway test
// node (test/helpers/freenet-node.js) via ZBTERM_STRESS_NODE_URL, since
// engine/worker.js's spawn-argument contract (docs/CORE-CONTRACT.md) has no
// slot for it and must not grow one just for a test. Unset, it is exactly
// engine/worker.js: SessionEngine gets no backendOptions, and the Freenet
// backend falls back to its own DEFAULT_NODE_URL.
//
// EngineClient (engine/client.js) spawns this the same way it spawns
// engine/worker.js (engine/spawn-worker.js::spawnWorker -> bare-sidecar,
// which inherits this process's environment), so ZBTERM_STRESS_NODE_URL
// need only be set on the test process, once, before either EngineClient is
// constructed.
globalThis.process = require('bare-process')
globalThis.navigator = globalThis.navigator || { userAgent: 'bare' }
globalThis.performance = globalThis.performance || { now: () => Date.now() }

const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')

const SessionEngine = require('../../engine/index')
const PtyRemote = require('../../engine/pty-remote')
const backends = require('../../engine/backends')
const { EngineError } = require('../../engine/errors')
const { FrameKind, LOW_RATE_EVENTS, encodeFrame, decodeFrame } = require('../../engine/rpc/schema')
const { tunePipe } = require('../../engine/rpc/pipe')

const pipe = tunePipe(new FramedStream(Bare.IPC))
let closing = false

function send(kind, id, body) {
  if (closing) return false
  return pipe.write(encodeFrame(kind, id, body))
}

function toBuffer(data) {
  if (data === null || data === undefined) return null
  if (Buffer.isBuffer(data)) return data
  return Buffer.from(data)
}

const ptyRemote = new PtyRemote((kind, id, body) => send(kind, id, body))

const userData = Bare.argv[2]
const profileId = Bare.argv[3] || null
const profilePath = Bare.argv[4] || null
const backendLimit = Bare.argv[5] || ''
const hostCaps = Bare.argv[6] || ''
const rtcRemote = hostCaps
  .split(',')
  .map((part) => part.trim())
  .includes('rtc')
  ? backends.rtcRemote((kind, id, body) => send(kind, id, body))
  : null

// The one difference from engine/worker.js: a test-only node override, read
// from the environment (never a spawn argument - see the header).
const nodeUrl = process.env.ZBTERM_STRESS_NODE_URL || null

const engine = new SessionEngine({
  userData,
  profileId,
  profilePath,
  backendLimit,
  hostCaps,
  rtcHost: rtcRemote,
  ptyHost: ptyRemote,
  backendOptions: nodeUrl ? { nodeUrl } : undefined
})

for (const name of LOW_RATE_EVENTS) {
  engine.on(name, (data) => send(FrameKind.EVENT_JSON, 0, { name, data }))
}
engine.on('session:data', (payload) => {
  send(FrameKind.EVENT_DATA, 0, {
    name: 'session:data',
    sessionId: payload.sessionId,
    hd: !!payload.hd,
    source: payload.source || null,
    data: toBuffer(payload.data)
  })
})
engine.on('player:data', (payload) => {
  send(FrameKind.EVENT_DATA, 0, {
    name: 'player:data',
    sessionId: payload.sessionId,
    hd: !!payload.hd,
    seq: payload.seq,
    tsMs: payload.tsMs,
    kind: payload.kind,
    cols: payload.cols,
    rows: payload.rows,
    data: toBuffer(payload.data)
  })
})

engine
  .ready()
  .then(() => {
    send(FrameKind.EVENT_JSON, 0, {
      name: 'engine:worker-ready',
      data: { sessionIds: Array.from(engine.sessions.keys()) }
    })
  })
  .catch((err) => {
    send(FrameKind.EVENT_JSON, 0, {
      name: 'engine:worker-ready-error',
      data: EngineError.from(err).toJSON()
    })
  })

pipe.on('data', async (raw) => {
  let frame
  try {
    frame = decodeFrame(raw)
  } catch (err) {
    console.error('dropping malformed frame from shell:', err.message)
    return
  }

  if (frame.kind === FrameKind.INVOKE) {
    try {
      const result = await engine.invoke(frame.body.method, frame.body.args)
      send(FrameKind.REPLY_OK, frame.id, { result })
    } catch (err) {
      send(FrameKind.REPLY_ERR, frame.id, { error: EngineError.from(err).toJSON() })
    }
    return
  }
  if (frame.kind === FrameKind.PTY_DATA) {
    ptyRemote.handleData(frame.body.sessionId, frame.body.data)
    return
  }
  if (frame.kind === FrameKind.PTY_EXIT) {
    ptyRemote.handleExit(frame.body.sessionId, {
      code: frame.body.code,
      signal: frame.body.signal
    })
    return
  }
  if (frame.kind === FrameKind.PTY_DETACH) {
    ptyRemote.handleDetach(frame.body.sessionId)
    return
  }
  if (rtcRemote && rtcRemote.handleFrame(frame)) return
  console.error('unexpected frame kind from shell:', frame.kind)
})

async function teardown() {
  if (closing) return
  closing = true
  const hardExit = setTimeout(() => {
    console.error('engine.close() timed out; forcing worker exit')
    Bare.exit(1)
  }, 7000)
  await engine.close().catch((err) => console.error('engine.close() failed:', err))
  clearTimeout(hardExit)
  pipe.end?.()
}

pipe.on('drain', () => {
  if (rtcRemote) rtcRemote.handleDrain()
})
pipe.on('end', teardown)
pipe.on('close', teardown)
pipe.on('error', teardown)

if (globalThis.Pear && typeof globalThis.Pear.teardown === 'function') {
  globalThis.Pear.teardown(teardown)
} else {
  goodbye(teardown)
}
