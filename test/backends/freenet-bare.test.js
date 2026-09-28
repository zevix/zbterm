// The Freenet client under the sidecar's Bare (F3): the backend module loads,
// its shims install, and start() reaches a local-mode node over bare-ws. The
// fixture runs in a real Bare worker spawned exactly as the core is
// (engine/spawn-worker.js::spawnWorker); the worker and the node are stopped
// by the pids this test started.
const path = require('path')
const test = require('brittle')

const { spawnWorker } = require('../../engine/spawn-worker')
const { freenetAvailable, startLocalNode } = require('../helpers/freenet-node')

const ENTRY = path.join(__dirname, '..', 'fixtures', 'freenet-bare-entry.js')
const REPLY_TIMEOUT_MS = 20000
// S-29: longer than bare-http1's 5 000 ms socket timeout, which used to
// destroy an idle node connection under Bare.
const IDLE_MS = 6000

function firstLine(worker) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(
      () => reject(new Error(`no reply within ${REPLY_TIMEOUT_MS} ms`)),
      REPLY_TIMEOUT_MS
    )
    worker.on('data', (chunk) => {
      buf += chunk.toString()
      const at = buf.indexOf('\n')
      if (at === -1) return
      clearTimeout(timer)
      resolve(buf.slice(0, at))
    })
    worker.on('error', () => {})
  })
}

test('freenet (Bare): the client starts against a local node under the sidecar', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const node = await startLocalNode()
  t.teardown(() => node.stop())

  const worker = spawnWorker(ENTRY, [node.url, String(IDLE_MS)])
  const pid = worker._process.pid
  let stderr = ''
  worker.stdout?.on('data', () => {})
  worker.stderr?.on('data', (chunk) => (stderr += chunk.toString()))
  t.teardown(() => {
    if (worker._process.exitCode === null && worker._process.signalCode === null) worker.destroy()
  })
  t.ok(pid, `spawned a Bare worker (pid ${pid})`)

  const started = Date.now()
  const line = await firstLine(worker)
  const reply = JSON.parse(line)
  t.comment(`reply after ${Date.now() - started} ms: ${line}`)
  if (!reply.ok) t.comment(`worker stderr: ${stderr}`)
  t.ok(reply.ok, 'the worker started the backend and minted a route')
  t.is(reply.health && reply.health.started, true, 'health() says started')
  t.alike(
    reply.idleHealth && [reply.idleHealth.started, reply.idleHealth.detail],
    [true, null],
    `the node connection survives ${IDLE_MS} ms without traffic (S-29)`
  )
  t.is(reply.stopped && reply.stopped.started, false, 'and stop() stopped it')
})
