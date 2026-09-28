// Bare sidecar entrypoint for the core (SessionEngine). This is the file
// `zbterm-core`'s launch contract names: `zbterm-core/worker.js`, run by
// engine/spawn-worker.js with argv [userData, profileId, profilePath, backend,
// hostCaps] and a
// framed duplex pipe on Bare.IPC (docs/CORE-CONTRACT.md "Sidecar launch"). It was
// `workers/engine.js` before the core became its own package; the app's other
// worker, the OTA updater (`workers/main.js`), was removed from every build
// (D-08), so this is the only Bare worker. See
// docs/PHASE2-WORK-PLAN.md step 3 and docs/DESIGN-SWARM-AND-WORKER.md
// "Additional Bare-compatibility findings" for why the three globalThis
// shims below are required before anything else is required. The Freenet
// backend's own shims (TextEncoder, a WebSocket over bare-ws) are installed by
// engine/backends/freenet/bare-shims.js when that backend loads, not here:
// nothing outside the registry may reach into a backend directory.
globalThis.process = require('bare-process')
globalThis.navigator = globalThis.navigator || { userAgent: 'bare' }
globalThis.performance = globalThis.performance || { now: () => Date.now() }

const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')

const SessionEngine = require('./index')
const PtyRemote = require('./pty-remote')
const backends = require('./backends')
const { EngineError } = require('./errors')
const { FrameKind, LOW_RATE_EVENTS, encodeFrame, decodeFrame } = require('./rpc/schema')
const { tunePipe } = require('./rpc/pipe')

// See engine/rpc/pipe.js: framed-stream's default highWaterMark (16 384
// bytes) made a single frame of 16 KiB or more report backpressure on an
// idle pipe, which is what let a lagging viewer's resync re-lag itself.
const pipe = tunePipe(new FramedStream(Bare.IPC))
let closing = false

// Returns the pipe's write result: false once it is full (RtcRemote's flow).
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
// The share-backend limit the host resolved (--backend, then
// ZBTERM_BACKEND). It arrives as a spawn argument, never as an invoke, so
// nothing can race it, and never through the environment, which is not
// reliably inherited under PearRuntime. '' (or an older host that passes no
// 4th argument) means no limit.
const backendLimit = Bare.argv[5] || ''
// What the host process offers, comma-separated: `rtc` when it has the WebRTC
// adapter the Freenet backend needs (electron/rtc-host.js). '' (or an older
// host that passes no 5th argument) means no capabilities.
const hostCaps = Bare.argv[6] || ''
const rtcRemote = hostCaps
  .split(',')
  .map((part) => part.trim())
  .includes('rtc')
  ? backends.rtcRemote((kind, id, body) => send(kind, id, body))
  : null

const engine = new SessionEngine({
  userData,
  profileId,
  profilePath,
  backendLimit,
  hostCaps,
  rtcHost: rtcRemote,
  ptyHost: ptyRemote
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
