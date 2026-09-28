// The regression this reproduces: a shared session flooded with output (an
// `ls -R /`-shaped burst) left the viewer "lagging" forever afterwards - the
// host logged `host:peer:lagging` / `host:peer:resync` every
// LAG_RESYNC_MAX_MS (8 s), always for the same reason (`backpressure: true`),
// even on a link that was completely idle. Root cause (engine/rpc/pipe.js):
// framed-stream's Writable side never got a highWaterMark option, so it kept
// streamx's default of 16 384 bytes, and a single write of 16 KiB or more
// reports "full" on an otherwise empty pipe (streamx checks *after* adding
// this write's bytes to `buffered`, not the backlog it displaced). Every
// resync bootstrap is itself typically tens of KiB, so it always re-tripped
// the same false alarm and the peer never recovered.
//
// Unlike test/share-flood.test.js (which reproduces a different bug on the
// in-process loopback backend, where nothing ever touches this pipe), this
// spawns two REAL engine/worker.js sidecars - test/fixtures/
// freenet-stress-worker.js is that file byte-for-byte, plus one
// environment-only hook to point the Freenet backend at a throwaway test
// node instead of its production default - each reached through a real
// EngineClient, each with its own real electron/rtc-host.js RtcHost, talking
// over a real WebRTC data channel through a real (throwaway, local-mode)
// Freenet node. This is the actual seam the bug lived on: FramedStream on
// both ends, RtcRemote, FreenetChannel, ShareManager.
//
// ZBTERM_PIPE_FLOOD_MS sets the flood length (default 4000 ms).
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')

const { EngineClient } = require('../engine/client')
const { RtcHost } = require('../electron/rtc-host')
const { freenetAvailable, startLocalNode } = require('./helpers/freenet-node')

const FIXTURE = path.join(__dirname, 'fixtures', 'freenet-stress-worker.js')
const FLOOD_MS = Number(process.env.ZBTERM_PIPE_FLOOD_MS || 4000)
const SETTLE_MS = 3000
const SAMPLES = 5
const SAMPLE_GAP_MS = 250
const SAMPLE_TIMEOUT_MS = 15000
// Generous next to INVOKE_TIMEOUT_MS (a wedged worker is killed there); the
// fixed code should recover in low seconds, not tens of them.
const MAX_BASELINE_P95_MS = 2000
const ABSOLUTE_BOUND_MS = 4000

// A PTY host that runs nothing (test/share-flood.test.js's FakeHost), shaped
// like the real ptyHost contract electron/pty-host.js implements - unlike
// that test, this one goes through the real EngineClient seam, and
// engine/client.js calls straight through to the class-level pause/resume/
// write (PTY_PAUSE/PTY_RESUME/PTY_WRITE, `_setPtyPaused`) and reads
// `ptyHost.sessions` directly (PTY_SPAWN/PTY_ATTACH dedupe against it,
// `_reattach()` walks it after a respawn), not just the handle spawn()
// returns. `push()` is the "real PTY produced this chunk" event, honouring
// pause() the way node-pty would.
class FakeHost extends EventEmitter {
  constructor() {
    super()
    this.sessions = new Map()
  }

  spawn(sessionId) {
    const terminal = { sessionId, paused: false, registered: true }
    this.sessions.set(sessionId, terminal)
    return {
      write: (data) => this.write(sessionId, data),
      resize: (cols, rows) => this.resize(sessionId, cols, rows),
      pause: () => this.pause(sessionId),
      resume: () => this.resume(sessionId),
      kill: () => this.kill(sessionId)
    }
  }

  write() {}
  resize() {}

  pause(sessionId) {
    const terminal = this.sessions.get(sessionId)
    if (terminal) terminal.paused = true
  }

  resume(sessionId) {
    const terminal = this.sessions.get(sessionId)
    if (terminal) terminal.paused = false
  }

  kill(sessionId) {
    const terminal = this.sessions.get(sessionId)
    if (!terminal || !terminal.registered) return
    terminal.registered = false
    this.sessions.delete(sessionId)
    this.emit('exit', { sessionId, exit: { code: 0, signal: null } })
  }

  push(sessionId, data) {
    const terminal = this.sessions.get(sessionId)
    if (!terminal || !terminal.registered || terminal.paused) return false
    this.emit('data', { sessionId, data })
    return true
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function within(ms, promise, what) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function summary(values) {
  if (!values.length) return { min: 0, p50: 0, p95: 0, max: 0 }
  const sorted = values.slice().sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] }
}

// Output shaped like `ls -R /`, same as test/share-flood.test.js's lsChunk.
function lsChunk(n, size) {
  const lines = [`\r\n/usr/share/flood/dir-${n}:\r\n`]
  let bytes = lines[0].length
  let i = 0
  while (bytes < size) {
    const line = `f${n}-${i++}.${(n * 7919 + i * 104729) % 100000}.so  lib-${i}.a  README\r\n`
    lines.push(line)
    bytes += line.length
  }
  return Buffer.from(lines.join('').slice(0, size), 'utf8')
}

// --- the pair: two real EngineClients, two real bare sidecars, one real
// Freenet node, two real RtcHosts talking real WebRTC. ---------------------

async function sharedPair(t) {
  const node = await startLocalNode()
  t.teardown(() => node.stop())

  const pair = {
    errors: { host: [], viewer: [] },
    debug: { host: [], viewer: [] },
    viewerText: ''
  }
  const savedNodeUrl = process.env.ZBTERM_STRESS_NODE_URL
  process.env.ZBTERM_STRESS_NODE_URL = node.url
  t.teardown(() => {
    if (savedNodeUrl === undefined) delete process.env.ZBTERM_STRESS_NODE_URL
    else process.env.ZBTERM_STRESS_NODE_URL = savedNodeUrl
  })

  for (const role of ['host', 'viewer']) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `zbterm-pipe-flood-${role}-`))
    const ptyHost = new FakeHost()
    const rtcHost = new RtcHost({ iceServers: [] })
    const client = new EngineClient({
      userData: dir,
      backend: 'freenet',
      workerEntrypoint: FIXTURE,
      ptyHost,
      rtcHost
    })
    client.on('engine:error', (err) => pair.errors[role].push(err))
    client.on('share:debug', (entry) => pair.debug[role].push({ ...entry, at: Date.now() }))
    await client.ready()
    pair[role] = client
    pair[role + 'Pty'] = ptyHost
    pair[role + 'Rtc'] = rtcHost
    t.teardown(async () => {
      await client.close().catch(() => {})
      rtcHost.closeAll('test teardown')
      await fs.promises
        .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        .catch(() => {})
    })
  }

  const created = await pair.host.invoke('session.create', {
    name: 'pipe-flood',
    cols: 100,
    rows: 30
  })
  pair.sessionId = created.sessionId

  // The host renderer: acks what it was shown, same flow-control contract as
  // test/share-flood.test.js.
  pair.host.on('session:data', ({ sessionId, source, data }) => {
    if (source !== 'pty') return
    pair.host.invoke('session.ack', { sessionId, bytes: data.byteLength }).catch(() => {})
  })
  pair.viewer.on('session:data', ({ sessionId, source, data }) => {
    if (source !== 'socket' || sessionId !== pair.sessionId) return
    pair.viewerText += Buffer.from(data).toString('utf8')
  })

  const link = await pair.host.invoke('share.createLink', {
    sessionId: pair.sessionId,
    type: 'single',
    autoJoin: true
  })

  const joined = new Promise((resolve, reject) => {
    const onChange = (status) => {
      if (status.linkId !== link.linkId) return
      if (status.status === 'joined') {
        pair.viewer.off('share:join-changed', onChange)
        resolve(status)
      } else if (status.status === 'failed') {
        pair.viewer.off('share:join-changed', onChange)
        reject(new Error(`join failed: ${status.message} (${status.reason})`))
      }
    }
    pair.viewer.on('share:join-changed', onChange)
  })
  await pair.viewer.invoke('share.join', { uri: link.uri })
  await within(30000, joined, 'viewer join')

  return pair
}

// One marker round trip: push it as the "PTY output" and time until the
// viewer's live stream contains it.
async function measureOne(pair) {
  const marker = `MARK-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const before = pair.viewerText.length
  const t0 = Date.now()
  pair.hostPty.push(pair.sessionId, Buffer.from(`\r\n${marker}\r\n`))
  await within(
    SAMPLE_TIMEOUT_MS,
    (async () => {
      while (!pair.viewerText.slice(before).includes(marker)) await delay(10)
    })(),
    `marker ${marker}`
  )
  return Date.now() - t0
}

async function sampleLatency(pair, n = SAMPLES) {
  const samples = []
  for (let i = 0; i < n; i++) {
    samples.push(await measureOne(pair))
    await delay(SAMPLE_GAP_MS)
  }
  return samples
}

// The events the bug produced forever, past the flood: a genuine recovery
// must stop generating them once the link is actually idle again.
function lagCycleEvents(entries, sinceMs) {
  return entries.filter(
    (e) => (e.event === 'host:peer:lagging' || e.event === 'host:peer:resync') && e.at >= sinceMs
  )
}

test('pipe backpressure: a viewer recovers from an ls -R-shaped flood over the real worker seam', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  t.timeout(FLOOD_MS + SETTLE_MS * 2 + SAMPLES * (SAMPLE_TIMEOUT_MS + SAMPLE_GAP_MS) + 120000)

  const pair = await sharedPair(t)

  // Baseline: several marker round trips before any flood.
  const baseline = await sampleLatency(pair)
  const baselineStats = summary(baseline)
  t.comment(`baseline latency: ${JSON.stringify(baselineStats)} ms (samples ${baseline})`)

  // Flood, `ls -R /`-shaped, then Ctrl-C - same shape as
  // test/share-flood.test.js, over the real seam this time.
  let dir = 0
  let pushed = 0
  let pausedPushes = 0
  const started = Date.now()
  while (Date.now() - started < FLOOD_MS) {
    const chunk = lsChunk(dir, 4096 + Math.floor(Math.random() * 12 * 1024))
    if (pair.hostPty.push(pair.sessionId, chunk)) {
      pushed += chunk.byteLength
      dir++
    } else {
      pausedPushes++
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  await pair.host.invoke('session.input', { sessionId: pair.sessionId, data: '\u0003' })
  const floodEndedAt = Date.now()
  t.comment(
    `flood: ${(pushed / (1024 * 1024)).toFixed(1)} MiB in ${dir} chunks over ` +
      `${floodEndedAt - started} ms (${pausedPushes} pushes refused while paused)`
  )

  // A short settle window, then measure again - this is the part that
  // never recovered before the fix (the peer stayed "lagging" and every
  // resync re-tripped the same false alarm).
  await delay(SETTLE_MS)
  const settledAt = Date.now()
  const postFlood = await sampleLatency(pair)
  const postStats = summary(postFlood)
  t.comment(`post-flood latency: ${JSON.stringify(postStats)} ms (samples ${postFlood})`)

  const bound = Math.max(baselineStats.p95 * 3, ABSOLUTE_BOUND_MS)
  t.ok(
    postStats.p95 <= bound,
    `post-flood p95 ${postStats.p95} ms is back near baseline p95 ${baselineStats.p95} ms ` +
      `(<= ${bound} ms)`
  )
  t.ok(
    baselineStats.p95 <= MAX_BASELINE_P95_MS,
    `baseline p95 ${baselineStats.p95} ms is itself reasonable (< ${MAX_BASELINE_P95_MS} ms)`
  )

  // No ongoing lagging/resync cycle once the link has had time to settle:
  // the pre-fix bug kept logging one pair of these every LAG_RESYNC_MAX_MS
  // forever, on a completely idle link.
  const stuck = lagCycleEvents(pair.debug.host, settledAt)
  t.alike(
    stuck,
    [],
    `no host:peer:lagging / host:peer:resync after settling (found ${stuck.length}: ` +
      `${stuck.map((e) => e.event).join(', ')})`
  )

  t.alike(
    pair.errors.host.map((e) => e.message),
    [],
    'no engine:error on the host'
  )
  t.alike(
    pair.errors.viewer.map((e) => e.message),
    [],
    'no engine:error on the viewer'
  )
})
