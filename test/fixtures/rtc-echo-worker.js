// Bare sidecar entrypoint for scripts/measure-seam.js: the BACKEND_DATA path of
// the worker <-> host pipe, without a peer connection. Spawned through
// engine/spawn-worker.js::spawnWorker, framed exactly as engine/worker.js is.
//
//   host BACKEND_OPEN {connId}   -> the worker sends TOTAL bytes as 65 536-byte
//                                   BACKEND_DATA frames on connId, as fast as
//                                   the pipe allows, then BACKEND_CLOSE 'sent'
//   host BACKEND_DATA            -> echoed back as it is; once TOTAL bytes have
//                                   arrived, BACKEND_CLOSE 'received'
//
// The first frame is BACKEND_STATE {connId: 0, state: 'ready'}.
//
// The same three globals engine/worker.js installs before anything else.
globalThis.process = require('bare-process')
globalThis.navigator = globalThis.navigator || { userAgent: 'bare' }
globalThis.performance = globalThis.performance || { now: () => Date.now() }

const FramedStream = require('framed-stream')

const { FrameKind, encodeFrame, decodeFrame } = require('../../engine/rpc/schema')

const TOTAL = 16 * 1024 * 1024
const MESSAGE = 65536

const pipe = new FramedStream(Bare.IPC)
const received = new Map()

function send(kind, body) {
  return pipe.write(encodeFrame(kind, 0, body))
}

function drained() {
  return new Promise((resolve) => pipe.once('drain', resolve))
}

async function blast(connId) {
  const data = Buffer.alloc(MESSAGE)
  for (let i = 0; i < MESSAGE; i++) data[i] = (i * 13 + connId) & 0xff
  for (let sent = 0; sent < TOTAL; sent += MESSAGE) {
    if (!send(FrameKind.BACKEND_DATA, { connId, chanId: 0, data })) await drained()
  }
  send(FrameKind.BACKEND_CLOSE, { connId, reason: 'sent' })
}

pipe.on('data', (raw) => {
  const frame = decodeFrame(raw)
  const body = frame.body
  if (frame.kind === FrameKind.BACKEND_OPEN) {
    blast(body.connId).catch((err) => console.error('rtc-echo-worker:', err))
    return
  }
  if (frame.kind === FrameKind.BACKEND_DATA) {
    send(FrameKind.BACKEND_DATA, body)
    const total = (received.get(body.connId) || 0) + body.data.byteLength
    received.set(body.connId, total)
    if (total === TOTAL) send(FrameKind.BACKEND_CLOSE, { connId: body.connId, reason: 'received' })
  }
})

pipe.on('end', () => pipe.end())
pipe.on('error', () => {})

send(FrameKind.BACKEND_STATE, { connId: 0, state: 'ready' })
