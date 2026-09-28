const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')

const { ATTACH_BUFFER_LIMIT, DETACH_SIGNAL } = require('../engine')
const { EngineClient } = require('../engine/client')
const { AccountStore } = require('../engine/account-store')
const { SessionStore } = require('../engine/session-store')
const { PacketKindName } = require('../engine/schema')
const { FrameKind, encodeFrame, decodeFrame } = require('../engine/rpc/schema')

// The sidecar half of test/engine-attach.test.js. Phase 3 proved attach mode
// in-process against a fake host wired straight into SessionEngine; this drives
// a REAL sidecar (engine/worker.js under Bare) over the actual pipe, with the
// fake host on the far side of the seam, and reaches the same assertions:
// byte-identity with spawn mode, input arriving at the host's write(), the drop
// counter under flood, a detach recorded as DETACH_SIGNAL, and close/delete
// never killing a terminal the core did not launch.

// A host-owned terminal registry, entirely host-side: EngineClient reads
// `sessions` (it must be a Map keyed by sessionId) and calls the object-level
// spawn/attach/write/resize/pause/resume/kill. Nothing here runs a process, so
// spawn mode and attach mode can be fed the exact same bytes and compared.
class SeamHost extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.sessions = new Map()
    // Kept after kill()/detach() so "is the host's terminal still alive?" is
    // still answerable; `sessions` only tracks what the core is wired to.
    this.terminals = new Map()
    this.writes = []
    this.resizes = []
    this.pauses = 0
    this.resumes = 0
    this.attachCalls = []
    // A well-behaved host stops pushing when the core pauses it. false models
    // a host (Tabby, a plugin) that cannot honour pause().
    this.honourPause = opts.honourPause !== false
    // Model a host with no attach() at all - the spawn-only half of the
    // contract, which is what electron/pty-host.js still is.
    if (opts.canAttach === false) this.attach = null
  }

  spawn(sessionId, opts = {}) {
    return this._register(sessionId, opts, 'spawn')
  }

  attach(sessionId, opts = {}) {
    this.attachCalls.push({ sessionId, cols: opts.cols, rows: opts.rows })
    return this._register(sessionId, opts, 'attach')
  }

  _register(sessionId, opts, mode) {
    const terminal = {
      sessionId,
      mode,
      cols: opts.cols,
      rows: opts.rows,
      // `alive` is the host's terminal. `registered` is whether the core is
      // wired to it. Detaching clears the second, never the first.
      alive: true,
      registered: true,
      paused: false
    }
    this.sessions.set(sessionId, terminal)
    this.terminals.set(sessionId, terminal)
    return {
      write: (data) => this.write(sessionId, data),
      resize: (cols, rows) => this.resize(sessionId, cols, rows),
      pause: () => this.pause(sessionId),
      resume: () => this.resume(sessionId),
      kill: () => this.kill(sessionId)
    }
  }

  write(sessionId, data) {
    this.writes.push({ sessionId, data: Buffer.from(data).toString('utf8') })
  }

  resize(sessionId, cols, rows) {
    this.resizes.push({ sessionId, cols, rows })
    const terminal = this.terminals.get(sessionId)
    if (terminal) {
      terminal.cols = cols
      terminal.rows = rows
    }
  }

  pause(sessionId) {
    this.pauses++
    const terminal = this.terminals.get(sessionId)
    if (terminal && this.honourPause) terminal.paused = true
  }

  resume(sessionId) {
    this.resumes++
    const terminal = this.terminals.get(sessionId)
    if (terminal) terminal.paused = false
  }

  // The single host-side end-of-terminal call. On a session registered through
  // attach() this DETACHES (docs/CORE-CONTRACT.md 6) - the terminal keeps
  // running and the core just lets go of it. Note the deliberately *string*
  // signal: if EngineClient tried to put it on PTY_EXIT (whose signal is an
  // OptionalUint) the encode would throw, which is exactly what PTY_DETACH
  // exists to avoid.
  kill(sessionId) {
    const terminal = this.terminals.get(sessionId)
    if (!terminal || !terminal.registered) return
    terminal.registered = false
    this.sessions.delete(sessionId)
    if (terminal.mode === 'attach') {
      this.emit('exit', { sessionId, exit: { code: null, signal: DETACH_SIGNAL } })
      return
    }
    terminal.alive = false
    this.emit('exit', { sessionId, exit: { code: 0, signal: null } })
  }

  // The host pushing its terminal's output into the core.
  push(sessionId, data) {
    const terminal = this.terminals.get(sessionId)
    if (!terminal || !terminal.registered) return false
    if (terminal.paused) return false
    this.emit('data', {
      sessionId,
      data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    })
    return true
  }
}

// Keeps the sidecar's own stdout off brittle's TAP stream while still draining
// both pipes (the default hook forwards stdout to process.stdout).
class TestClient extends EngineClient {
  _attachWorkerOutput(worker) {
    worker.stdout?.on('data', (chunk) => process.stderr.write(chunk))
    worker.stderr?.on('data', (chunk) => process.stderr.write(chunk))
  }
}

const STREAM = [
  '\x1b[2J\x1b[H',
  'hello from a host-owned terminal\r\n',
  '$ ls -la\r\n',
  'total 8\r\ndrwxr-xr-x  2 user user 4096 Jan  1 00:00 .\r\n',
  '\x1b[31mred\x1b[0m and \x1b[32mgreen\x1b[0m\r\n'
]
const TAIL = 'after the resize\r\n'
// engine/index.js flushes its packet buffer on a timer (ARCHIVE_PROFILES.normal
// maxMs = 1200ms). The in-process test calls _flushPacketBuffer() directly;
// across the seam there is no such handle, so the recording is allowed to
// settle before the next timeline-ordered call is made.
const FLUSH_MS = 1500

test('attach mode over the sidecar records byte-for-byte identically to spawn mode', async (t) => {
  t.timeout(180000)
  const env = await sidecar(t)
  const { client, host } = env

  const live = new Map()
  client.on('session:data', ({ sessionId, data }) => {
    if (!live.has(sessionId)) live.set(sessionId, [])
    live.get(sessionId).push(Buffer.from(data))
  })

  await client.ready()
  const spawned = await record(client, host, { name: 'spawn mode', cols: 90, rows: 24 })
  const attached = await record(client, host, {
    name: 'attach mode',
    cols: 90,
    rows: 24,
    mode: 'attach'
  })

  t.is(host.terminals.get(spawned).mode, 'spawn', 'the spawn-mode session crossed as PTY_SPAWN')
  t.is(host.terminals.get(attached).mode, 'attach', 'the attach-mode session crossed as PTY_ATTACH')
  t.alike(
    host.attachCalls,
    [{ sessionId: attached, cols: 90, rows: 24 }],
    'ptyHost.attach() was called once, with the geometry from the PtyAttach body'
  )

  // The live stream the host sees coming back out of the seam.
  t.is(
    Buffer.concat(live.get(attached)).toString('hex'),
    Buffer.concat(live.get(spawned)).toString('hex'),
    'the session:data stream is identical in both modes'
  )

  const spawnPlayback = await client.invoke('player.open', { sessionId: spawned })
  const attachPlayback = await client.invoke('player.open', { sessionId: attached })
  t.is(attachPlayback.length, spawnPlayback.length, 'both play back the same number of packets')
  t.is(attachPlayback.frame.data, spawnPlayback.frame.data, 'the played-back frame is identical')
  t.is(attachPlayback.frame.cols, 100, 'playback geometry follows the recorded resize')
  t.is(attachPlayback.frame.rows, 30)
  t.is(attachPlayback.frame.cols, spawnPlayback.frame.cols)
  t.is(attachPlayback.frame.rows, spawnPlayback.frame.rows)

  const sessions = await client.invoke('session.list')
  const spawnEntry = sessions.find((s) => s.sessionId === spawned)
  const attachEntry = sessions.find((s) => s.sessionId === attached)
  t.is(attachEntry.active, false, 'the attach-mode session is catalogued as ended')
  t.is(attachEntry.owner, spawnEntry.owner, 'both are catalogued as locally owned')

  // The recordings themselves, read from storage in plain Node once the
  // sidecar has exited and released the corestore.
  await client.close()
  const spawnRecording = await readRecording(env.profilePath, spawned)
  const attachRecording = await readRecording(env.profilePath, attached)

  t.comment(
    `spawn: ${spawnRecording.packets} packets, ${spawnRecording.bytes.byteLength} bytes, ` +
      `sha256 ${sha256(spawnRecording.bytes)}, shape ${spawnRecording.shape.join(' -> ')}`
  )
  t.comment(
    `attach: ${attachRecording.packets} packets, ${attachRecording.bytes.byteLength} bytes, ` +
      `sha256 ${sha256(attachRecording.bytes)}, shape ${attachRecording.shape.join(' -> ')}`
  )
  t.ok(spawnRecording.bytes.byteLength > 0, 'the spawn-mode recording is not empty')
  t.is(
    attachRecording.bytes.toString('hex'),
    spawnRecording.bytes.toString('hex'),
    'attach-mode and spawn-mode recordings are byte-for-byte identical'
  )
  t.alike(
    attachRecording.shape,
    spawnRecording.shape,
    'the packet-kind / geometry sequence is identical too'
  )
})

test('input crosses the seam and reaches the attached host write()', async (t) => {
  t.timeout(120000)
  const { client, host } = await sidecar(t)
  await client.ready()

  const created = await client.invoke('session.create', { name: 'attached', mode: 'attach' })
  const sessionId = created.sessionId

  // session.input and the share path make the *same* call inside the core -
  // runtime.pty.write(...) (engine/index.js input(), "Same call in both
  // modes"). Everything downstream of that call is what this seam adds:
  // PTY_WRITE -> EngineClient -> ptyHost.write(). test/engine-attach.test.js
  // covers the share-manager half in-process, against the same handle.
  await client.invoke('session.input', { sessionId, data: 'echo local\r' })
  await client.invoke('session.input', { sessionId, data: 'echo remote\r' })
  // A UTF-8 payload as well, so the buffer round trip is not just ASCII.
  await client.invoke('session.input', { sessionId, data: 'echo ünïcödé ✓\r' })

  t.alike(
    host.writes.map((item) => item.data),
    ['echo local\r', 'echo remote\r', 'echo ünïcödé ✓\r'],
    'every input reached the attached host write(), in order, across the seam'
  )
  t.alike(
    host.writes.map((item) => item.sessionId),
    [sessionId, sessionId, sessionId],
    'each write was routed to the right host terminal'
  )
  t.ok(host.terminals.get(sessionId).alive, 'the host terminal is untouched by input routing')

  // And the other direction, on the same handle: output pushed by the host is
  // recorded by the core across the seam.
  const seen = waitForEvent(
    client,
    'session:data',
    (p) => p.sessionId === sessionId && String(p.data).includes('local')
  )
  host.push(sessionId, 'echo local\r\n')
  await seen
  t.pass('output pushed by the attached host came back as session:data')
})

test('detaching across the seam records DETACH_SIGNAL, not a crash and not a number', async (t) => {
  t.timeout(120000)
  const { client, host } = await sidecar(t)
  const errors = []
  client.on('engine:error', (err) => errors.push(err))
  await client.ready()

  const created = await client.invoke('session.create', { name: 'detach me', mode: 'attach' })
  const sessionId = created.sessionId
  host.push(sessionId, 'work in progress\r\n')
  await delay(FLUSH_MS)

  const event = await closeAndSettle(client, sessionId)

  t.is(event.exit.signal, DETACH_SIGNAL, 'the exit event carries the detach signal')
  t.is(typeof event.exit.signal, 'string', 'and it survived the seam as a string, not a number')
  t.is(event.exit.code, null, 'and no exit code, because nothing exited')

  const entry = (await client.invoke('session.list')).find((s) => s.sessionId === sessionId)
  t.is(entry.active, false, 'the catalog entry is closed')
  t.is(entry.exit.signal, DETACH_SIGNAL, 'the catalog records the detach signal')
  t.ok(entry.endedAt > 0, 'the catalog records when it detached')
  t.alike(errors, [], 'detaching raised no engine error')

  const terminal = host.terminals.get(sessionId)
  t.absent(terminal.registered, 'the core let go of the terminal')
  t.ok(terminal.alive, 'the host terminal is still alive after the detach')

  const playback = await client.invoke('player.open', { sessionId })
  t.ok(playback.length > 0, 'the detached session still plays back')
})

test('closeSession and deleteSession across the seam never kill a host-owned terminal', async (t) => {
  t.timeout(120000)
  const { client, host } = await sidecar(t)
  await client.ready()

  const closed = await client.invoke('session.create', { name: 'closed', mode: 'attach' })
  const deleted = await client.invoke('session.create', { name: 'deleted', mode: 'attach' })
  const killed = await client.invoke('session.create', { name: 'spawned' })
  host.push(closed.sessionId, 'a\r\n')
  host.push(deleted.sessionId, 'b\r\n')
  host.push(killed.sessionId, 'c\r\n')
  await delay(FLUSH_MS)

  await closeAndSettle(client, closed.sessionId)
  await client.invoke('session.delete', { sessionId: deleted.sessionId })
  await closeAndSettle(client, killed.sessionId)

  t.ok(host.terminals.get(closed.sessionId).alive, 'session.close left the attached terminal alive')
  t.ok(
    host.terminals.get(deleted.sessionId).alive,
    'session.delete left the attached terminal alive'
  )
  t.absent(host.terminals.get(closed.sessionId).registered, 'session.close detached it')
  t.absent(host.terminals.get(deleted.sessionId).registered, 'session.delete detached it')
  t.absent(
    host.terminals.get(killed.sessionId).alive,
    'spawn-mode behaviour is unchanged: the core still kills what it launched'
  )

  const sessions = await client.invoke('session.list')
  t.absent(
    sessions.find((s) => s.sessionId === deleted.sessionId),
    'the deleted recording is gone'
  )
})

test('flooding an attached host that ignores pause() across the seam drops and counts', async (t) => {
  t.timeout(180000)
  const { client, host } = await sidecar(t, { honourPause: false })
  await client.ready()

  const created = await client.invoke('session.create', { name: 'flooded', mode: 'attach' })
  const sessionId = created.sessionId
  const CHUNK = 64 * 1024

  // Warm up past the flow limit first, so the accounting below starts from the
  // moment the core considers the session paused. The pipe is a single ordered
  // stream, so every PTY_DATA frame written before the session.diagnostics
  // INVOKE frame is processed by the worker before it.
  // One chunk per check, exactly as the in-process test does it: the chunk that
  // trips the pause is still *recorded*, so at the moment flowPaused is first
  // observed nothing is buffered or dropped yet and the accounting below is
  // exact rather than approximate.
  while (!(await stats(client, sessionId)).flowPaused) {
    host.push(sessionId, Buffer.alloc(CHUNK, 0x78))
  }
  const start = await stats(client, sessionId)
  t.is(start.bufferedBytes, 0, 'nothing is buffered at the moment the core pauses the host')
  t.is(start.droppedBytes, 0, 'and nothing has been dropped yet')
  const baseline = process.memoryUsage()

  let pushed = 0
  const samples = []
  const target = ATTACH_BUFFER_LIMIT * 8
  while (pushed < target) {
    for (let i = 0; i < 8; i++) {
      // A fresh allocation per push: re-pushing one buffer would make the
      // "bounded memory" claim trivially true by aliasing.
      host.push(sessionId, Buffer.alloc(CHUNK, 0x78))
      pushed += CHUNK
    }
    if (pushed % (target / 4) === 0) samples.push(Math.round(process.memoryUsage().rss / 1048576))
    await tick()
  }
  const after = process.memoryUsage()
  const s = await stats(client, sessionId)
  samples.push(Math.round(after.rss / 1048576))
  const heapGrowthMb = (after.heapUsed - baseline.heapUsed) / 1048576
  const rssGrowthMb = (after.rss - baseline.rss) / 1048576

  t.comment(
    `flooded ${(pushed / 1048576).toFixed(1)} MiB across the seam; ` +
      `buffered=${s.bufferedBytes} (cap ${s.bufferLimit}) ` +
      `dropped=${s.droppedBytes}B/${s.droppedChunks} chunks; ` +
      `heap +${heapGrowthMb.toFixed(1)} MiB, rss +${rssGrowthMb.toFixed(1)} MiB, ` +
      `host rss samples ${samples.join('/')} MiB`
  )

  t.ok(host.pauses > 0, 'the core asked the host to pause, as a PTY_PAUSE frame')
  t.ok(s.flowPaused, 'and still considers the session paused')
  t.is(s.mode, 'attach', 'the core knows the session is attached')
  t.ok(pushed > ATTACH_BUFFER_LIMIT * 4, 'the flood pushed far more than the buffer holds')
  t.ok(s.bufferedBytes <= ATTACH_BUFFER_LIMIT, 'the buffer stayed under its cap')
  t.is(s.bufferLimit, ATTACH_BUFFER_LIMIT)
  t.ok(s.droppedChunks > 0, `the drop counter is non-zero (${s.droppedChunks} chunks)`)
  t.ok(s.droppedBytes > 0, `and counts the dropped bytes (${s.droppedBytes})`)
  t.is(
    s.droppedBytes + s.bufferedBytes,
    pushed,
    'every flooded byte was either buffered or counted as dropped - no second buffer in the proxy'
  )
  t.ok(rssGrowthMb < 128, `host rss stayed bounded (+${rssGrowthMb.toFixed(1)} MiB)`)

  // The buffered filler would be replayed into the xterm mirror at teardown,
  // which costs seconds and proves nothing.
  const drained = waitForEvent(client, 'session:exit', (e) => e.sessionId === sessionId)
  await client.invoke('session.delete', { sessionId }).catch(() => {})
  await Promise.race([drained, delay(5000)])
})

test('a host that cannot attach gets a session that detaches instead of hanging', async (t) => {
  t.timeout(120000)
  const { client, host } = await sidecar(t, { canAttach: false })
  await client.ready()

  const exited = waitForEvent(client, 'session:exit', () => true)
  const created = await client.invoke('session.create', { name: 'nowhere', mode: 'attach' })
  const event = await exited

  t.is(event.sessionId, created.sessionId, 'the refused session ended')
  t.is(event.exit.signal, DETACH_SIGNAL, 'as a detach, not a hang and not a crash')
  t.is(host.terminals.size, 0, 'and no terminal was ever registered')
})

test('the new frame kinds are appended, and PtyExit is byte-identical', (t) => {
  // 0-12 are wire-compatible state: pinned here as literals, so a reorder is a
  // test failure and not a silent protocol break.
  t.alike(
    Object.fromEntries(Object.entries(FrameKind).filter(([, v]) => v <= 12)),
    {
      INVOKE: 0,
      REPLY_OK: 1,
      REPLY_ERR: 2,
      EVENT_JSON: 3,
      EVENT_DATA: 4,
      PTY_SPAWN: 5,
      PTY_WRITE: 6,
      PTY_RESIZE: 7,
      PTY_KILL: 8,
      PTY_PAUSE: 9,
      PTY_RESUME: 10,
      PTY_DATA: 11,
      PTY_EXIT: 12
    },
    'FrameKind 0-12 are unchanged'
  )
  t.is(FrameKind.PTY_ATTACH, 13, 'PTY_ATTACH was appended as 13')
  t.is(FrameKind.PTY_DETACH, 14, 'PTY_DETACH was appended as 14')

  // Golden PtyExit encodings. These are what the kind produced before
  // PTY_ATTACH/PTY_DETACH existed; adding a field to PtyExit (instead of a
  // second frame kind) would have changed every one of them.
  t.is(
    encodeFrame(FrameKind.PTY_EXIT, 0, { sessionId: 's1', code: 0, signal: null }).toString('hex'),
    '0c00000000027331010000',
    'PTY_EXIT { code: 0, signal: null } encodes to the same 11 bytes as before'
  )
  t.is(
    encodeFrame(FrameKind.PTY_EXIT, 0, { sessionId: 's1', code: null, signal: 9 }).toString('hex'),
    '0c00000000027331000109',
    'PTY_EXIT { code: null, signal: 9 } is unchanged'
  )
  t.is(
    encodeFrame(FrameKind.PTY_EXIT, 7, { sessionId: 'abc', code: 137, signal: null }).toString(
      'hex'
    ),
    '0c0700000003616263018900',
    'PTY_EXIT with a non-zero invoke id is unchanged'
  )

  // PtyAttach is PtySpawn minus shell/cwd: same prefix, without the two
  // absent-optional bytes.
  t.is(
    encodeFrame(FrameKind.PTY_ATTACH, 0, { sessionId: 's1', cols: 90, rows: 24 }).toString('hex'),
    '0d000000000273315a18'
  )
  t.is(
    encodeFrame(FrameKind.PTY_SPAWN, 0, {
      sessionId: 's1',
      cols: 90,
      rows: 24,
      shell: null,
      cwd: null
    }).toString('hex'),
    '05000000000273315a180000'
  )
  t.is(
    encodeFrame(FrameKind.PTY_DETACH, 0, { sessionId: 's1' }).toString('hex'),
    '0e00000000027331',
    'PTY_DETACH reuses SessionIdOnly - it carries no signal at all'
  )

  const attach = decodeFrame(
    encodeFrame(FrameKind.PTY_ATTACH, 0, { sessionId: 's1', cols: 90, rows: 24 })
  )
  t.alike(attach, { kind: 13, id: 0, body: { sessionId: 's1', cols: 90, rows: 24 } })
  const detach = decodeFrame(encodeFrame(FrameKind.PTY_DETACH, 0, { sessionId: 's1' }))
  t.alike(detach, { kind: 14, id: 0, body: { sessionId: 's1' } })
})

// ---------------------------------------------------------------- helpers

async function sidecar(t, opts = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-attach-seam-'))
  // An explicit profile path, not a profile id: a plain directory needs no
  // pre-existing profile registry, which is what a non-ZBTerm host has.
  const profilePath = path.join(dir, 'storage')
  const host = new SeamHost(opts)
  const client = new TestClient({ userData: dir, profileId: '', profilePath, ptyHost: host })
  t.teardown(async () => {
    await client.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  return { dir, profilePath, host, client }
}

async function record(client, host, opts) {
  const created = await client.invoke('session.create', opts)
  const sessionId = created.sessionId
  for (const piece of STREAM) host.push(sessionId, piece)
  await delay(FLUSH_MS)
  await client.invoke('session.resize', { sessionId, cols: 100, rows: 30 })
  host.push(sessionId, TAIL)
  await delay(FLUSH_MS)
  await closeAndSettle(client, sessionId)
  return sessionId
}

// session.close, then wait until the core is completely done with the session's
// store. `session:exit` is not enough: _onPtyExit finishes by emitting
// `session:list-changed`, and listSessions() transiently re-opens every ended
// session's store to measure it (logicalHistorySize). A player.open racing that
// open fails with "File descriptor could not be locked" - a pre-existing
// condition of the corestore lock, nothing to do with the seam.
async function closeAndSettle(client, sessionId) {
  const exited = waitForEvent(client, 'session:exit', (e) => e.sessionId === sessionId)
  const settled = waitForEvent(client, 'session:list-changed', (list) => {
    const item = (list || []).find((s) => s.sessionId === sessionId)
    return item && item.active === false
  })
  await client.invoke('session.close', { sessionId })
  const event = await exited
  await settled
  return event
}

// Concatenated payload bytes plus the packet-kind/geometry sequence, exactly as
// test/engine-attach.test.js reads them: packet *boundaries* are a timing
// artifact of _schedulePacketFlush, so the bytes are compared as one stream and
// only the non-DATA packets keep their positions.
async function readRecording(profilePath, sessionId) {
  const account = new AccountStore(path.join(profilePath, 'account'))
  await account.ready()
  const localDevice = await account.getLocalDevice()
  const store = await SessionStore.open(path.join(profilePath, 'corestore'), sessionId, localDevice)
  try {
    const packets = await store.readAll()
    const shape = []
    const payloads = []
    for (const packet of packets) {
      if (PacketKindName[packet.kind] === 'DATA') {
        payloads.push(packet.payload)
        if (shape[shape.length - 1] !== 'DATA') shape.push('DATA')
        continue
      }
      shape.push(`${PacketKindName[packet.kind]}:${packet.cols}x${packet.rows}`)
    }
    return { bytes: Buffer.concat(payloads), shape, packets: packets.length }
  } finally {
    await store.close()
  }
}

async function stats(client, sessionId) {
  const result = await client.invoke('session.diagnostics', { sessionId })
  return result.sessions[0]
}

function waitForEvent(client, name, predicate) {
  return new Promise((resolve) => {
    const onEvent = (payload) => {
      if (!predicate(payload)) return
      client.removeListener(name, onEvent)
      resolve(payload)
    }
    client.on(name, onEvent)
  })
}

function sha256(buf) {
  return require('crypto').createHash('sha256').update(buf).digest('hex')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}
