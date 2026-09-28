// Bug 4: a shared terminal running `ls -R /` broke the share on every backend.
// Both backends broke, so the reproduction is the shared path alone - PTY ->
// host engine -> store/live stream -> ShareManager -> viewer engine - on the
// in-process loopback backend, with the two renderers played by this file:
// the host's acks every chunk it is shown, and the viewer's re-opens the
// joined session every 350 ms (renderer/app.js
// ::scheduleJoinedAvailabilityRefresh) and would lose its worker to any open
// slower than engine/client.js::INVOKE_TIMEOUT_MS.
//
// ZBTERM_SHARE_FLOOD_MS sets the flood length (default 3000 ms).
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')

const SessionEngine = require('../engine')
const LoopbackBackend = require('../engine/backends/loopback')
const { LoopbackHub } = require('../engine/backends/loopback')
const { EngineClient, INVOKE_TIMEOUT_MS } = require('../engine/client')
const { FrameKind, encodeFrame } = require('../engine/rpc/schema')

const FLOOD_MS = Number(process.env.ZBTERM_SHARE_FLOOD_MS || 3000)
const OPEN_EVERY_MS = 350
const PACKET_BYTES = 64 * 1024
const SNAPSHOT_BYTES = 256 * 1024
// Bounds the fixed code has to meet, far inside INVOKE_TIMEOUT_MS.
const MAX_OPEN_MS = 5000
const MAX_SETTLE_MS = 5000
const MAX_HEAP_GROWTH_MB = 256

// The spawn half of test/engine-attach.test.js's FakeHost: a PTY host that
// runs nothing and honours pause().
class FakeHost extends EventEmitter {
  constructor() {
    super()
    this.terminals = new Map()
    this.pauses = 0
  }

  spawn(sessionId) {
    const terminal = { sessionId, paused: false, registered: true }
    this.terminals.set(sessionId, terminal)
    return {
      write: () => {},
      resize: () => {},
      pause: () => {
        this.pauses++
        terminal.paused = true
      },
      resume: () => {
        terminal.paused = false
      },
      kill: () => {
        if (!terminal.registered) return
        terminal.registered = false
        this.emit('exit', { sessionId, exit: { code: 0, signal: null } })
      }
    }
  }

  push(sessionId, data) {
    const terminal = this.terminals.get(sessionId)
    if (!terminal || !terminal.registered || terminal.paused) return false
    this.emit('data', { sessionId, data })
    return true
  }
}

test('a shared terminal survives an ls -R flood with a viewer joined', async (t) => {
  t.timeout(FLOOD_MS * 4 + 180000)
  const pair = await sharedPair(t)
  await pair.join()
  const result = await flood(t, pair, {})
  check(t, pair, result, { midFlood: false })
})

test('a viewer that joins mid-flood misses nothing', async (t) => {
  t.timeout(FLOOD_MS * 4 + 180000)
  const pair = await sharedPair(t)
  const result = await flood(t, pair, { joinAt: FLOOD_MS / 3 })
  check(t, pair, result, { midFlood: true })
})

// A viewer is confirmed - and starts getting live data - only once its
// bootstrap is built, and building it waits for the mirror to catch up.
// Output recorded during that wait was broadcast to the others only; the
// bootstrap has to carry it.
test('a bootstrap built while output keeps arriving includes that output', async (t) => {
  const pair = await sharedPair(t)
  const { host, hostPty, sessionId } = pair
  for (let i = 0; i < 64; i++) hostPty.push(sessionId, lsChunk(i, 16 * 1024))
  const building = host.buildLiveBootstrap(sessionId)
  const late = Buffer.from('\r\nwhile-the-bootstrap-was-building\r\n')
  await new Promise((resolve) => setImmediate(resolve))
  hostPty.push(sessionId, late)
  const frame = await building
  t.ok(
    frame.data.includes('while-the-bootstrap-was-building'),
    'output recorded before the bootstrap returned is in it'
  )
})

// The host half of flow control (engine/client.js): a PTY is paused while the
// core or the full pipe to the worker wants it paused, and resumed only when
// neither does.
test('a PTY stays paused until both the core and the pipe let it go', (t) => {
  const client = Object.create(EngineClient.prototype)
  const calls = []
  const pipe = new EventEmitter()
  pipe.full = true
  pipe.write = () => !pipe.full
  client._closed = false
  client._workerAlive = true
  client._pipe = pipe
  client.ptyHost = {
    pause: (id) => calls.push(['pause', id]),
    resume: (id) => calls.push(['resume', id])
  }
  const frame = (kind) => client._onFrame(encodeFrame(kind, 0, { sessionId: 's1' }))

  frame(FrameKind.PTY_PAUSE)
  client._sendPtyData('s1', Buffer.from('a'))
  client._sendPtyData('s1', Buffer.from('b'))
  t.is(pipe.listenerCount('drain'), 1, 'one drain listener, however many writes were refused')
  pipe.full = false
  pipe.emit('drain')
  t.alike(calls, [['pause', 's1']], "the pipe's drain does not resume a PTY the core paused")
  frame(FrameKind.PTY_RESUME)
  t.alike(
    calls,
    [
      ['pause', 's1'],
      ['resume', 's1']
    ],
    'the core resuming it does'
  )

  calls.length = 0
  pipe.full = true
  client._sendPtyData('s1', Buffer.from('c'))
  frame(FrameKind.PTY_PAUSE)
  frame(FrameKind.PTY_RESUME)
  t.alike(calls, [['pause', 's1']], 'PTY_RESUME does not resume a PTY the full pipe paused')
  pipe.full = false
  pipe.emit('drain')
  t.alike(
    calls,
    [
      ['pause', 's1'],
      ['resume', 's1']
    ],
    'the drain does'
  )
  t.is(pipe.listenerCount('drain'), 0)
})

// --- the pair ---------------------------------------------------------------

async function sharedPair(t) {
  const hub = new LoopbackHub()
  const pair = { errors: { host: [], viewer: [] }, received: 0, chunks: [] }
  for (const role of ['host', 'viewer']) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `zbterm-share-flood-${role}-`))
    const ptyHost = new FakeHost()
    const engine = new SessionEngine({
      userData: dir,
      ptyHost,
      shareBackend: new LoopbackBackend({ hub, routeKey: 'loop' })
    })
    await engine.ready()
    engine.on('engine:error', (err) => pair.errors[role].push(err))
    pair[role] = engine
    pair[role + 'Pty'] = ptyHost
    t.teardown(async () => {
      await engine.close().catch(() => {})
      // engine.close() does not wait for a snapshot write already under way,
      // so the directory can still be filling for a moment.
      await fs.promises
        .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        .catch(() => {})
    })
  }

  const created = await pair.host.invoke('session.create', { name: 'flooded', cols: 100, rows: 30 })
  pair.sessionId = created.sessionId
  // The host renderer: it acks what it was shown, a tick later.
  pair.host.on('session:data', ({ sessionId, source, data }) => {
    if (source !== 'pty') return
    setImmediate(() => pair.host.ack(sessionId, data.byteLength))
  })
  pair.viewer.on('session:data', ({ sessionId, source, data }) => {
    if (source !== 'socket' || sessionId !== pair.sessionId) return
    pair.received += data.byteLength
    pair.chunks.push(Buffer.from(data))
  })
  const link = await pair.host.invoke('share.createLink', {
    sessionId: pair.sessionId,
    type: 'single',
    autoJoin: true
  })
  pair.join = async () => {
    const joined = new Promise((resolve, reject) => {
      const onChange = (status) => {
        if (status.linkId !== link.linkId) return
        if (status.status === 'joined') {
          pair.viewer.off('share:join-changed', onChange)
          resolve(status)
        } else if (status.status === 'failed') {
          pair.viewer.off('share:join-changed', onChange)
          reject(new Error(`join failed: ${status.message}`))
        }
      }
      pair.viewer.on('share:join-changed', onChange)
    })
    const started = Date.now()
    await pair.viewer.invoke('share.join', { uri: link.uri })
    await joined
    pair.joinedAt = Date.now()
    pair.joinMs = pair.joinedAt - started
  }
  return pair
}

// --- the flood --------------------------------------------------------------

async function flood(t, pair, { joinAt = -1 }) {
  const { host, viewer, hostPty, sessionId } = pair
  const runtime = host.sessions.get(sessionId)
  const packetsBefore = runtime.store.log.length
  const snapshotsBefore = runtime.snapshot.index.snapshots.length
  const baseline = process.memoryUsage()

  const opens = []
  const viewerCounts = []
  const memory = []
  let joining = null
  let pushed = 0
  let pushedChunks = 0
  let pausedPushes = 0
  let dir = 0

  // The viewer renderer: session.open every 350 ms, not waiting for the last.
  const openTick = () => {
    if (!viewer.remoteSessions.has(sessionId) || !pair.joinedAt) return
    const started = Date.now()
    const entry = { started, ms: null, error: null }
    opens.push(entry)
    entry.done = viewer.invoke('session.open', { sessionId }).then(
      () => (entry.ms = Date.now() - started),
      (err) => {
        entry.ms = Date.now() - started
        entry.error = err.message
      }
    )
  }
  const sampleTick = () => {
    if (pair.joinedAt) viewerCounts.push(host.share.status(sessionId).viewerCount)
    memory.push(process.memoryUsage())
  }
  const openTimer = setInterval(openTick, OPEN_EVERY_MS)
  const sampleTimer = setInterval(sampleTick, 250)

  const started = Date.now()
  try {
    while (Date.now() - started < FLOOD_MS) {
      if (joinAt >= 0 && !joining && Date.now() - started >= joinAt) joining = pair.join()
      const chunk = lsChunk(dir, 4096 + Math.floor(Math.random() * 12 * 1024))
      if (hostPty.push(sessionId, chunk)) {
        pushed += chunk.byteLength
        pushedChunks++
        dir++
      } else {
        pausedPushes++
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    clearInterval(openTimer)
  }
  const floodEnded = Date.now()
  if (joining) await joining

  // After the flood: how long until everything pushed has landed.
  const settleStarted = Date.now()
  await untilDelivered(pair, pushed, dir - 1, joinAt >= 0, 120000)
  const deliveredMs = Date.now() - settleStarted
  const remote = viewer.remoteSessions.get(sessionId)
  const mirrorStarted = Date.now()
  if (remote) await within(remote.mirrorQueue, 120000)
  const mirrorSettleMs = Date.now() - mirrorStarted
  host._flushPacketBuffer(sessionId)
  await runtime.appendQueue.catch(() => {})
  await runtime.mirrorQueue.catch(() => {})
  const hostSettleMs = Date.now() - floodEnded
  // Opens still in flight are measured up to now: a stuck one counts as slow.
  await within(Promise.all(opens.map((entry) => entry.done)), 30000)
  const now = Date.now()
  const latencies = opens.map((entry) => (entry.ms === null ? now - entry.started : entry.ms))
  clearInterval(sampleTimer)
  sampleTick()

  const after = process.memoryUsage()
  const result = {
    elapsed: floodEnded - started,
    pushed,
    pushedChunks,
    pausedPushes,
    received: pair.received,
    packets: runtime.store.log.length - packetsBefore,
    snapshots: runtime.snapshot.index.snapshots.length - snapshotsBefore,
    opens: latencies.length,
    worstOpenMs: latencies.length ? Math.max(...latencies) : 0,
    openErrors: opens.filter((entry) => entry.error).map((entry) => entry.error),
    deliveredMs,
    mirrorSettleMs,
    hostSettleMs,
    viewerCounts,
    heapGrowthMb: (after.heapUsed - baseline.heapUsed) / (1024 * 1024),
    rssSamples: memory.map((m) => Math.round(m.rss / (1024 * 1024))),
    heapPeakMb: Math.round(Math.max(...memory.map((m) => m.heapUsed)) / (1024 * 1024))
  }
  t.comment(
    `flood ${mb(pushed)} MiB in ${pushedChunks} chunks over ${result.elapsed} ms ` +
      `(${pausedPushes} pushes refused while paused); join took ${pair.joinMs} ms; ` +
      `viewer got ${mb(result.received)} MiB; ` +
      `delivered +${deliveredMs} ms, viewer mirror settled +${mirrorSettleMs} ms, host +${hostSettleMs} ms`
  )
  t.comment(
    `host: ${result.packets} packets (bytes/64KiB = ${Math.ceil(pushed / PACKET_BYTES)}), ` +
      `${result.snapshots} snapshots (bytes/256KiB = ${Math.floor(pushed / SNAPSHOT_BYTES)})`
  )
  t.comment(
    `viewer session.open: ${result.opens} calls, worst ${result.worstOpenMs} ms, ` +
      `latencies ${summary(latencies)} ms, errors ${result.openErrors.length}`
  )
  t.comment(
    `memory: heap +${result.heapGrowthMb.toFixed(1)} MiB (peak ${result.heapPeakMb} MiB), ` +
      `rss ${thin(result.rssSamples).join('/')} MiB, external ${mb(after.external)} MiB; ` +
      `engine:error host ${pair.errors.host.length}, viewer ${pair.errors.viewer.length}`
  )
  return result
}

function check(t, pair, result, { midFlood }) {
  const { host, viewer, sessionId } = pair
  t.ok(
    result.worstOpenMs < MAX_OPEN_MS,
    `the viewer's worst session.open took ${result.worstOpenMs} ms ` +
      `(< ${MAX_OPEN_MS}; the worker is killed at ${INVOKE_TIMEOUT_MS})`
  )
  t.alike(result.openErrors, [], 'no session.open failed')
  t.ok(
    result.mirrorSettleMs < MAX_SETTLE_MS && result.deliveredMs < MAX_SETTLE_MS,
    `the viewer caught up within ${MAX_SETTLE_MS} ms of the flood ` +
      `(delivered +${result.deliveredMs} ms, mirror +${result.mirrorSettleMs} ms)`
  )
  t.ok(
    result.packets <= Math.ceil(result.pushed / PACKET_BYTES) * 2 + 2,
    `the host coalesced output into ${result.packets} packets ` +
      `(~bytes/64KiB = ${Math.ceil(result.pushed / PACKET_BYTES)}, chunks ${result.pushedChunks})`
  )
  t.ok(
    result.snapshots <= Math.floor(result.pushed / SNAPSHOT_BYTES) + 1,
    `the host wrote ${result.snapshots} snapshots ` +
      `(<= bytes/256KiB + 1 = ${Math.floor(result.pushed / SNAPSHOT_BYTES) + 1})`
  )
  if (!midFlood) {
    t.is(result.received, result.pushed, 'the viewer received every byte pushed')
  } else {
    // A late viewer gets the screen as a bootstrap, then the rest as data:
    // what it was sent must pick up exactly where the bootstrap left off.
    const ids = chunkIds(Buffer.concat(pair.chunks).toString('utf8'))
    const contiguous = ids.length > 0 && ids.every((id, i) => i === 0 || id === ids[i - 1] + 1)
    t.ok(contiguous, `the late viewer's live data has no hole (${ids.length} chunks)`)
    t.is(ids[ids.length - 1], result.pushedChunks - 1, 'and runs to the last chunk pushed')
  }
  const hostScreen = screenText(host.sessions.get(sessionId).mirror)
  const remote = viewer.remoteSessions.get(sessionId)
  const viewerScreen = remote && remote.mirror ? screenText(remote.mirror) : ''
  t.ok(
    hostScreen === viewerScreen,
    `the viewer's screen and scrollback match the host's (${hostScreen.length} chars)`
  )
  t.ok(
    result.viewerCounts.length > 0 && result.viewerCounts.every((n) => n === 1),
    `the host counted exactly one viewer throughout (${summary(result.viewerCounts)})`
  )
  t.alike(pair.errors.host.map(message), [], 'no engine:error on the host')
  t.alike(pair.errors.viewer.map(message), [], 'no engine:error on the viewer')
  t.ok(
    result.heapGrowthMb < MAX_HEAP_GROWTH_MB,
    `heap growth stayed bounded (+${result.heapGrowthMb.toFixed(1)} MiB)`
  )
}

// --- helpers ----------------------------------------------------------------

// Output shaped like `ls -R /`: a directory header, then its entries, each
// line well under the terminal's width so screens compare line for line. The
// header numbers the chunk so a hole in the live stream can be found.
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

function chunkIds(text) {
  const ids = []
  const re = /\/usr\/share\/flood\/dir-(\d+):/g
  for (const match of text.matchAll(re)) ids.push(Number(match[1]))
  return ids
}

// Every byte pushed has reached the viewer; for a late viewer, the last chunk.
async function untilDelivered(pair, pushed, lastId, midFlood, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!midFlood && pair.received >= pushed) return
    if (midFlood && pair.chunks.length) {
      const ids = chunkIds(pair.chunks[pair.chunks.length - 1].toString('utf8'))
      if (ids[ids.length - 1] === lastId) return
    }
    await delay(20)
  }
}

function screenText(frame) {
  const buffer = frame.term.buffer.active
  const lines = []
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i).translateToString(true))
  }
  return lines.join('\n').replace(/\n+$/, '')
}

function summary(values) {
  if (!values.length) return 'none'
  const sorted = values.slice().sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return `min ${sorted[0]} / p50 ${at(0.5)} / p90 ${at(0.9)} / max ${sorted[sorted.length - 1]}`
}

function thin(values, n = 12) {
  if (values.length <= n) return values
  const step = values.length / n
  const out = []
  for (let i = 0; i < n; i++) out.push(values[Math.floor(i * step)])
  out.push(values[values.length - 1])
  return out
}

function message(err) {
  return (err && err.message) || String(err)
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1)
}

// `promise`, or give up after `ms` without leaving a timer behind.
async function within(promise, ms) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  try {
    await Promise.race([promise.catch(() => {}), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
