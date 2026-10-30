// The seam (K7, spike S3): `zxterm-core sidecar --profile <dir>` spawned
// for real, `engine/zxterm/client.js` connected to it from a real Bare
// worker (`test/fixtures/zxterm-seam-worker.js`, launched with
// `bare-sidecar` exactly as `engine/spawn-worker.js` launches ZBTerm's
// production worker), exercising `core.version`, one `identity.*` method
// against a throwaway SSH key, and `test.flood`/`test.echo` for the flood
// criterion this phase's Goal states: "a 16 MiB flood from `test.flood` to
// a client running under Bare recovers within the same latency-ratio bound
// ZBTerm's own pipe-backpressure flood test uses"
// (test/pipe-backpressure-flood.test.js).
//
// Requires `zxterm-core` built with the `seam-test` Cargo feature
// (`cargo build -p zxterm-core --features seam-test --target-dir target/seam-test`
// in the `zxterm/` submodule) -
// `test.flood`/`test.echo` only exist in that build. Both tests below skip
// with a named reason if the binary is not found at `ZXTERM_CORE_BIN` (or
// the default `<ZX_ZXTERM>/target/seam-test/debug/zxterm-core`, a target directory
// of its own so a plain debug build is never mistaken for it).
//
// Flood size is bytes, not milliseconds (`test.flood { bytes }`, unlike the
// pipe test's time-boxed flood) - `ZBTERM_ZXTERM_SEAM_FLOOD_BYTES` is this
// flood's own env-var override, in the naming spirit of
// `ZBTERM_PIPE_FLOOD_MS` (verified current: `FLOOD_MS =
// Number(process.env.ZBTERM_PIPE_FLOOD_MS || 4000)`) adapted to what is
// actually configurable here. The bound formula and sampling shape
// (baseline p95, settle, post-flood p95) are reused verbatim from that
// file's own `MAX_BASELINE_P95_MS = 2000`, `ABSOLUTE_BOUND_MS = 4000`,
// `bound = max(baseline_p95 * 3, ABSOLUTE_BOUND_MS)`.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const test = require('brittle')

const FIXTURE = path.join(__dirname, 'fixtures', 'zxterm-seam-worker.js')
const ZXTERM_ROOT = process.env.ZX_ZXTERM || path.join(__dirname, '..', 'zxterm')
const ZXTERM_CORE_BIN =
  process.env.ZXTERM_CORE_BIN ||
  path.join(ZXTERM_ROOT, 'target', 'seam-test', 'debug', 'zxterm-core')

const FLOOD_BYTES = Number(process.env.ZBTERM_ZXTERM_SEAM_FLOOD_BYTES || 16 * 1024 * 1024)
const SETTLE_MS = 3000
const SAMPLES = 5
const SAMPLE_GAP_MS = 250
const MAX_BASELINE_P95_MS = 2000
const ABSOLUTE_BOUND_MS = 4000

function binAvailable() {
  try {
    fs.accessSync(ZXTERM_CORE_BIN, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function summary(values) {
  if (!values.length) return { min: 0, p50: 0, p95: 0, max: 0 }
  const sorted = values.slice().sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] }
}

function scratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// Bridges the Node test process to the real Bare worker
// (test/fixtures/zxterm-seam-worker.js), spawned with `bare-sidecar`
// exactly as engine/spawn-worker.js spawns ZBTerm's production worker.
// Talks newline-delimited JSON over the Sidecar's own Duplex (Bare.IPC on
// the far end) - this bridge's own protocol, not ZBTerm's production
// `engine/rpc/` framing.
class WorkerBridge {
  constructor(profile, bin) {
    const Sidecar = require('bare-sidecar')
    this.sidecar = new Sidecar(FIXTURE, [profile, bin])
    this._buf = Buffer.alloc(0)
    this._pending = new Map()
    this._nextId = 1
    this.events = []
    this.stderrText = ''
    this.exit = null
    this._readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve
      this._rejectReady = reject
    })
    this.sidecar.stderr.on('data', (d) => {
      this.stderrText += d.toString('utf8')
    })
    this.sidecar.on('data', (d) => this._onData(d))
    this.sidecar.on('exit', (code, signal) => {
      this.exit = { code, signal }
    })
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : Buffer.from(chunk)
    let nl
    while ((nl = this._buf.indexOf(0x0a)) !== -1) {
      const line = this._buf.subarray(0, nl).toString('utf8')
      this._buf = this._buf.subarray(nl + 1)
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      this._onMessage(msg)
    }
  }

  _onMessage(msg) {
    if (msg.type === 'ready') {
      this._resolveReady()
      return
    }
    if (msg.type === 'fatal') {
      this._rejectReady(new Error(`${msg.code}: ${msg.message}`))
      return
    }
    if (msg.type === 'reply') {
      const pending = this._pending.get(msg.id)
      if (!pending) return
      this._pending.delete(msg.id)
      pending.resolve(msg)
      return
    }
    this.events.push({ ...msg, at: Date.now() })
  }

  ready() {
    return this._readyPromise
  }

  _send(obj) {
    this.sidecar.write(Buffer.from(`${JSON.stringify(obj)}\n`))
  }

  async request(method, args = {}) {
    const id = String(this._nextId++)
    const msg = await new Promise((resolve) => {
      this._pending.set(id, { resolve })
      this._send({ type: 'request', id, method, args })
    })
    if (!msg.ok) {
      const err = new Error(msg.message)
      err.code = msg.code
      throw err
    }
    return { result: msg.result, ms: msg.ms }
  }

  async close() {
    this._send({ type: 'close' })
    await delay(200)
    try {
      this.sidecar.destroy()
    } catch {
      // already gone
    }
  }
}

test('the seam: sidecar spawn, core.version, one identity.* method, test.echo, under a real Bare worker', async (t) => {
  if (!binAvailable()) {
    t.comment(
      'SKIP:',
      `zxterm-core not built at ${ZXTERM_CORE_BIN} (cargo build -p zxterm-core --features seam-test --target-dir target/seam-test)`
    )
    return
  }
  t.timeout(30000)

  const profile = scratchDir('zbterm-zxseam-rt-')
  const home = scratchDir('zbterm-zxseam-home-')
  t.teardown(() => {
    fs.rmSync(profile, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  // A throwaway ed25519 key, generated fresh for this test only - never a
  // real key of the owner's.
  const keyPath = path.join(home, 'id_ed25519')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', keyPath])

  const bridge = new WorkerBridge(profile, ZXTERM_CORE_BIN)
  t.teardown(() => bridge.close())
  await bridge.ready()

  const version = await bridge.request('core.version', {})
  t.ok(
    version.result && typeof version.result.version === 'string',
    `core.version: ${JSON.stringify(version.result)}`
  )

  const health = await bridge.request('core.health', {})
  t.is(health.result.status, 'ok')

  const inspect = await bridge.request('identity.sshInspect', { keyPath, home, env: {} })
  t.is(inspect.result.keyType, 'ssh-ed25519')
  t.is(
    inspect.result.signable,
    true,
    `throwaway key should be signable: ${JSON.stringify(inspect.result)}`
  )

  const echoed = await bridge.request('test.echo', { payload: { n: 42, s: 'hi' } })
  t.alike(echoed.result.payload, { n: 42, s: 'hi' })

  t.alike(
    bridge.events.filter((e) => e.type === 'client-error'),
    [],
    'no client-side seam errors'
  )
})

test('the seam: a 16 MiB test.flood to a client under a real Bare worker recovers within the pipe-backpressure bound', async (t) => {
  if (!binAvailable()) {
    t.comment(
      'SKIP:',
      `zxterm-core not built at ${ZXTERM_CORE_BIN} (cargo build -p zxterm-core --features seam-test --target-dir target/seam-test)`
    )
    return
  }
  t.timeout(120000)

  const profile = scratchDir('zbterm-zxflood-')
  t.teardown(() => fs.rmSync(profile, { recursive: true, force: true }))

  // The flood's own Reply only arrives once every chunk (and any final
  // resync) has actually gone out - generous next to a loopback socket's
  // real throughput, never expected to be hit.
  const savedTimeout = process.env.ZBTERM_ZXTERM_SEAM_REQUEST_TIMEOUT_MS
  process.env.ZBTERM_ZXTERM_SEAM_REQUEST_TIMEOUT_MS = '60000'
  t.teardown(() => {
    if (savedTimeout === undefined) delete process.env.ZBTERM_ZXTERM_SEAM_REQUEST_TIMEOUT_MS
    else process.env.ZBTERM_ZXTERM_SEAM_REQUEST_TIMEOUT_MS = savedTimeout
  })

  const bridge = new WorkerBridge(profile, ZXTERM_CORE_BIN)
  t.teardown(() => bridge.close())
  await bridge.ready()

  async function sampleLatency(n) {
    const samples = []
    for (let i = 0; i < n; i++) {
      const { ms } = await bridge.request('test.echo', { payload: `mark-${i}` })
      samples.push(ms)
      await delay(SAMPLE_GAP_MS)
    }
    return samples
  }

  const baseline = await sampleLatency(SAMPLES)
  const baselineStats = summary(baseline)
  t.comment(`baseline test.echo latency: ${JSON.stringify(baselineStats)} ms (samples ${baseline})`)

  const floodStarted = Date.now()
  const flood = await bridge.request('test.flood', { bytes: FLOOD_BYTES })
  const floodMs = Date.now() - floodStarted
  t.comment(`flood: ${JSON.stringify(flood.result)} in ${floodMs} ms`)
  t.is(flood.result.bytesSent, FLOOD_BYTES, 'the full flood was sent')
  t.is(flood.result.stillLagging, false, 'the sidecar delivered its final resync before replying')

  const settledAt = Date.now()
  await delay(SETTLE_MS)
  const postFlood = await sampleLatency(SAMPLES)
  const postStats = summary(postFlood)
  t.comment(`post-flood test.echo latency: ${JSON.stringify(postStats)} ms (samples ${postFlood})`)

  const bound = Math.max(baselineStats.p95 * 3, ABSOLUTE_BOUND_MS)
  t.ok(
    postStats.p95 <= bound,
    `post-flood p95 ${postStats.p95} ms is back near baseline p95 ${baselineStats.p95} ms (<= ${bound} ms)`
  )
  t.ok(
    baselineStats.p95 <= MAX_BASELINE_P95_MS,
    `baseline p95 ${baselineStats.p95} ms is itself reasonable (< ${MAX_BASELINE_P95_MS} ms)`
  )

  // No lingering resync cycle once the link has had time to settle.
  const lateResyncs = bridge.events.filter(
    (e) => e.type === 'event' && e.name === 'resync' && e.at >= settledAt
  )
  t.alike(lateResyncs, [], `no resync events after settling (found ${lateResyncs.length})`)

  t.alike(
    bridge.events.filter((e) => e.type === 'client-error'),
    [],
    'zero errors on the client side'
  )
})
