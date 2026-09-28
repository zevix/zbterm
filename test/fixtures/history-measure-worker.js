// Bare sidecar entrypoint for scripts/measure-history.js: the Freenet
// backend's live history (engine/backends/freenet/history.js, design §8.1)
// run in a real worker, with every data-channel message crossing the worker
// <-> host pipe to the host's RtcHost. Spawned by EngineClient (its
// `workerEntrypoint`) through engine/spawn-worker.js::spawnWorker and framed
// exactly as engine/worker.js is; it answers INVOKE frames and forwards the
// BACKEND_* frames to the backend's RtcRemote, and nothing else. It stands in
// for engine/worker.js only because the core does not yet let a host name
// the Freenet node to use (the backend's `nodeUrl`; F9), and a measurement
// must never touch the owner's node.
//
//   history.host   { nodeUrl, dir, mib, blockBytes }
//     -> a store { log, metaCore } of `mib` MiB in `blockBytes` blocks, a
//        started backend that announces one link and serves the store to
//        every connection; { route, hostKey, logKey, metaKey, length, appendMs }
//   history.attach { nodeUrl, dir, route, hostKey, logKey, metaKey, length }
//     -> dials, attaches, fetches [0, length) and reports the timing
//
// The first frame is EVENT_JSON engine:worker-ready, as the core's is.
//
// The same three globals engine/worker.js installs before anything else.
globalThis.process = require('bare-process')
globalThis.navigator = globalThis.navigator || { userAgent: 'bare' }
globalThis.performance = globalThis.performance || { now: () => Date.now() }

const path = require('bare-path')
const FramedStream = require('framed-stream')
const Hypercore = require('hypercore')

const backends = require('../../engine/backends')
const FreenetBackend = require('../../engine/backends/freenet')
const { transportKeyPair } = require('../../engine/crypto')
const { EngineError } = require('../../engine/errors')
const { FrameKind, encodeFrame, decodeFrame } = require('../../engine/rpc/schema')

const LINK_ID = 'history-measure'
const MIB = 1024 * 1024

const pipe = new FramedStream(Bare.IPC)
let closing = false

function send(kind, id, body) {
  if (closing) return false
  return pipe.write(encodeFrame(kind, id, body))
}

const rtcRemote = backends.rtcRemote((kind, id, body) => send(kind, id, body))
const made = { backends: [], cores: [] }

function hex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

async function startBackend(nodeUrl) {
  const backend = new FreenetBackend({ nodeUrl, rtcHost: rtcRemote, iceServers: [] })
  made.backends.push(backend)
  const keyPair = transportKeyPair()
  await backend.start({ keyPair: () => keyPair })
  return backend
}

async function core(dir, key) {
  const c = key ? new Hypercore(dir, Buffer.from(key, 'hex')) : new Hypercore(dir)
  made.cores.push(c)
  await c.ready()
  return c
}

async function host({ nodeUrl, dir, mib, blockBytes }) {
  const store = {
    log: await core(path.join(dir, 'log')),
    metaCore: await core(path.join(dir, 'meta'))
  }
  // As spikes/freenet/p6.js writes it: each block numbered, partly random.
  const blocks = Math.round((mib * MIB) / blockBytes)
  const t0 = performance.now()
  for (let i = 0; i < blocks; i += 64) {
    const batch = []
    for (let j = i; j < Math.min(blocks, i + 64); j++) {
      const block = Buffer.alloc(blockBytes)
      block.writeUInt32LE(j, 0)
      for (let k = 4; k < 68 && k < blockBytes; k++) block[k] = Math.floor(Math.random() * 256)
      batch.push(block)
    }
    await store.log.append(batch)
  }
  await store.metaCore.append(Buffer.from('meta-0'))
  const appendMs = performance.now() - t0

  const backend = await startBackend(nodeUrl)
  backend.setAdmission(true)
  backend.on('connection', (conn) => backend.serveHistory(conn, store))
  const { route } = await backend.announce(LINK_ID)
  return {
    route,
    hostKey: hex(backend.localPeerKey()),
    logKey: hex(store.log.key),
    metaKey: hex(store.metaCore.key),
    length: store.log.length,
    appendMs: Math.round(appendMs)
  }
}

async function attach({ nodeUrl, dir, route, hostKey, logKey, metaKey, length }) {
  const store = {
    log: await core(path.join(dir, 'log'), logKey),
    metaCore: await core(path.join(dir, 'meta'), metaKey)
  }
  const backend = await startBackend(nodeUrl)
  const d0 = performance.now()
  const conn = await backend.dial(route, Buffer.from(hostKey, 'hex')).connected
  const connectMs = performance.now() - d0

  let firstBlockMs = null
  let last = 0
  let longestGapMs = 0
  const t0 = performance.now()
  store.log.on('download', () => {
    const now = performance.now()
    if (firstBlockMs === null) firstBlockMs = now - t0
    else longestGapMs = Math.max(longestGapMs, now - last)
    last = now
  })
  const handle = backend.attachHistory(conn, store, { logKey, metaKey })
  await handle.fetch({ start: 0, end: length }).done()
  const transferMs = performance.now() - t0
  const lastBlock = await store.log.get(length - 1, { wait: false })
  const meta = await store.metaCore.get(0, { timeout: 10000 }).catch(() => null)
  handle.close()
  return {
    connectMs: Math.round(connectMs),
    transferMs: Math.round(transferMs),
    firstBlockMs: firstBlockMs === null ? null : Math.round(firstBlockMs),
    longestGapMs: Math.round(longestGapMs),
    blocks: store.log.contiguousLength,
    lastBlockOk: !!lastBlock && lastBlock.readUInt32LE(0) === length - 1,
    metaOk: !!meta && meta.toString() === 'meta-0'
  }
}

const METHODS = { 'history.host': host, 'history.attach': attach }

pipe.on('data', async (raw) => {
  let frame
  try {
    frame = decodeFrame(raw)
  } catch (err) {
    console.error('history-measure-worker: malformed frame:', err.message)
    return
  }
  if (frame.kind === FrameKind.INVOKE) {
    const method = METHODS[frame.body.method]
    try {
      if (!method) throw new Error(`unknown method ${frame.body.method}`)
      const result = await method(frame.body.args)
      send(FrameKind.REPLY_OK, frame.id, { result })
    } catch (err) {
      send(FrameKind.REPLY_ERR, frame.id, { error: EngineError.from(err).toJSON() })
    }
    return
  }
  if (rtcRemote && rtcRemote.handleFrame(frame)) return
  console.error('history-measure-worker: unexpected frame kind', frame.kind)
})

pipe.on('drain', () => {
  if (rtcRemote) rtcRemote.handleDrain()
})

async function teardown() {
  if (closing) return
  closing = true
  for (const backend of made.backends) await backend.stop().catch(() => {})
  for (const c of made.cores) await c.close().catch(() => {})
  pipe.end()
}

pipe.on('end', teardown)
pipe.on('close', teardown)
pipe.on('error', teardown)

send(FrameKind.EVENT_JSON, 0, { name: 'engine:worker-ready', data: { sessionIds: [] } })
