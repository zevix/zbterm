#!/usr/bin/env node
// Measures the worker <-> host pipe on the BACKEND_DATA path (Freenet design
// 3: "the cost of carrying every data-channel message across the pipe"). Not
// a test: prints one JSON line, reported, not gated.
//
//   node scripts/measure-seam.js
//   -> {"workerToHostMiBps":…,"hostToWorkerMiBps":…,…}
//
// It spawns test/fixtures/rtc-echo-worker.js as a real Bare sidecar through
// engine/spawn-worker.js::spawnWorker, the way engine/client.js spawns the
// core, and stops that one worker when done.
//
// workerToHost: 16 MiB of 65 536-byte BACKEND_DATA frames written by the
// worker as fast as the pipe allows, timed from the request to the last byte.
// hostToWorker: 16 MiB written by this process the same way, timed until the
// worker reports it has read all of it; the worker echoes every frame, and
// `echoIntact` says whether the echo came back byte-identical.
const crypto = require('crypto')
const path = require('path')
const FramedStream = require('framed-stream')

const { spawnWorker } = require('../engine/spawn-worker')
const { FrameKind, encodeFrame, decodeFrame } = require('../engine/rpc/schema')

const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'rtc-echo-worker.js')
const TOTAL = 16 * 1024 * 1024
const MESSAGE = 65536
const MIB = 1024 * 1024
const PHASE_TIMEOUT_MS = 120000

function mibps(bytes, ms) {
  return Math.round((bytes / MIB / (ms / 1000)) * 100) / 100
}

async function main() {
  const worker = spawnWorker(FIXTURE, [])
  const pid = worker._process && worker._process.pid
  worker.stdout?.on('data', () => {})
  worker.stderr?.on('data', (chunk) => process.stderr.write(chunk))
  const exited = new Promise((resolve) => worker.once('exit', resolve))
  const pipe = new FramedStream(worker)

  const waiters = []
  pipe.on('data', (raw) => {
    const frame = decodeFrame(raw)
    for (const waiter of waiters.slice()) waiter(frame)
  })
  const until = (what, match) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what}: timed out`)), PHASE_TIMEOUT_MS)
      const waiter = (frame) => {
        if (!match(frame)) return
        clearTimeout(timer)
        waiters.splice(waiters.indexOf(waiter), 1)
        resolve(frame)
      }
      waiters.push(waiter)
    })

  try {
    await until('ready', (f) => f.kind === FrameKind.BACKEND_STATE && f.body.state === 'ready')

    // Worker -> host.
    let fromWorker = 0
    const counting = (frame) => {
      if (frame.kind === FrameKind.BACKEND_DATA && frame.body.connId === 1) {
        fromWorker += frame.body.data.byteLength
      }
    }
    waiters.push(counting)
    const sent = until('worker -> host', (f) => f.kind === FrameKind.BACKEND_CLOSE && f.body.connId === 1)
    const w0 = performance.now()
    pipe.write(encodeFrame(FrameKind.BACKEND_OPEN, 0, { connId: 1, iceServers: null }))
    await sent
    const workerToHostMs = performance.now() - w0
    waiters.splice(waiters.indexOf(counting), 1)

    // Host -> worker, echoed.
    const sentHash = crypto.createHash('sha256')
    const echoHash = crypto.createHash('sha256')
    let echoed = 0
    const echoDone = new Promise((resolve) => {
      waiters.push((frame) => {
        if (frame.kind !== FrameKind.BACKEND_DATA || frame.body.connId !== 2) return
        echoHash.update(frame.body.data)
        echoed += frame.body.data.byteLength
        if (echoed === TOTAL) resolve()
      })
    })
    const read = until(
      'host -> worker',
      (f) => f.kind === FrameKind.BACKEND_CLOSE && f.body.connId === 2
    )
    const h0 = performance.now()
    for (let offset = 0; offset < TOTAL; offset += MESSAGE) {
      const data = crypto.randomBytes(MESSAGE)
      sentHash.update(data)
      const ok = pipe.write(encodeFrame(FrameKind.BACKEND_DATA, 0, { connId: 2, chanId: 0, data }))
      if (!ok) await new Promise((resolve) => pipe.once('drain', resolve))
    }
    await read
    const hostToWorkerMs = performance.now() - h0
    await echoDone

    console.log(
      JSON.stringify({
        workerToHostMiBps: mibps(fromWorker, workerToHostMs),
        hostToWorkerMiBps: mibps(TOTAL, hostToWorkerMs),
        bytesEachWay: TOTAL,
        workerToHostBytes: fromWorker,
        echoIntact: echoed === TOTAL && sentHash.digest('hex') === echoHash.digest('hex'),
        messageBytes: MESSAGE,
        workerPid: pid
      })
    )
  } finally {
    pipe.end()
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000))
    ])
    // Only the worker this script spawned, and only if it did not exit.
    if (!stopped) worker.destroy()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
