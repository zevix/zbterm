const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')
const b4a = require('b4a')

const SessionEngine = require('../engine')
const { ATTACH_BUFFER_LIMIT, DETACH_SIGNAL } = require('../engine')
const { SessionStore } = require('../engine/session-store')
const { PacketKindName } = require('../engine/schema')
const ShareManager = require('../engine/share-manager')
const { loadOrCreateLocalDevice } = require('../engine/crypto')
const { SEND_INPUT } = require('../engine/caps')
const { CODES } = require('../engine/errors')

// A fake PTY host that implements the same adapter contract in both modes:
// spawn() launches a terminal the core owns, attach() registers one the host
// already owns. Neither runs a real process, so the two modes can be fed the
// exact same byte stream and compared.
class FakeHost extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.terminals = new Map()
    this.writes = []
    this.resizes = []
    this.pauses = 0
    this.resumes = 0
    // A well-behaved host stops pushing when the core pauses it. Set false to
    // model a host (Tabby, a plugin) that cannot honour pause().
    this.honourPause = opts.honourPause !== false
    // Model a host that detaches without saying why: the core has to supply
    // the detach signal itself.
    this.silentDetach = !!opts.silentDetach
  }

  spawn(sessionId, opts = {}) {
    return this._register(sessionId, opts, 'spawn')
  }

  attach(sessionId, opts = {}) {
    return this._register(sessionId, opts, 'attach')
  }

  _register(sessionId, opts, mode) {
    const terminal = {
      sessionId,
      mode,
      cols: opts.cols,
      rows: opts.rows,
      // `alive` is the host's terminal process. `registered` is whether the
      // core is wired to it. Detaching clears the second, never the first.
      alive: true,
      registered: true,
      paused: false,
      killCalls: 0
    }
    this.terminals.set(sessionId, terminal)
    return {
      write: (data) => {
        this.writes.push({ sessionId, data: String(data) })
      },
      resize: (cols, rows) => {
        this.resizes.push({ sessionId, cols, rows })
        terminal.cols = cols
        terminal.rows = rows
      },
      pause: () => {
        this.pauses++
        if (this.honourPause) terminal.paused = true
      },
      resume: () => {
        this.resumes++
        terminal.paused = false
      },
      kill: () => {
        terminal.killCalls++
        if (!terminal.registered) return
        terminal.registered = false
        if (mode === 'attach') {
          // Detach: the terminal keeps running, the core just lets go of it.
          this.emit('exit', {
            sessionId,
            exit: this.silentDetach ? null : { code: null, signal: DETACH_SIGNAL }
          })
          return
        }
        terminal.alive = false
        this.emit('exit', { sessionId, exit: { code: 0, signal: null } })
      }
    }
  }

  // The host pushing terminal output into the core.
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

const STREAM = [
  '\x1b[2J\x1b[H',
  'hello from a host-owned terminal\r\n',
  '$ ls -la\r\n',
  'total 8\r\ndrwxr-xr-x  2 user user 4096 Jan  1 00:00 .\r\n',
  '\x1b[31mred\x1b[0m and \x1b[32mgreen\x1b[0m\r\n'
]
const TAIL = 'after the resize\r\n'

test('an attach-mode session records and plays back identically to a spawn-mode one', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()

  try {
    const spawned = await record(engine, host, { name: 'spawn mode', cols: 90, rows: 24 })
    const attached = await record(engine, host, {
      name: 'attach mode',
      cols: 90,
      rows: 24,
      mode: 'attach'
    })

    t.is(host.terminals.get(spawned).mode, 'spawn', 'the spawn-mode session used spawn()')
    t.is(host.terminals.get(attached).mode, 'attach', 'the attach-mode session used attach()')

    const spawnRecording = await readRecording(engine, spawned)
    const attachRecording = await readRecording(engine, attached)

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

    const spawnEntry = await engine.catalog.get(spawned)
    const attachEntry = await engine.catalog.get(attached)
    t.is(attachEntry.active, false, 'the attach-mode session is catalogued as ended')
    t.is(attachEntry.owner, spawnEntry.owner, 'both are catalogued as locally owned')

    const spawnPlayback = await engine.invoke('player.open', { sessionId: spawned })
    const attachPlayback = await engine.invoke('player.open', { sessionId: attached })
    t.is(attachPlayback.length, spawnPlayback.length, 'both play back the same number of packets')
    t.is(
      attachPlayback.frame.data,
      spawnPlayback.frame.data,
      'the played-back terminal frame is identical'
    )
    t.is(attachPlayback.frame.cols, 100, 'playback geometry follows the recorded resize')
    t.is(attachPlayback.frame.rows, 30)
    t.is(attachPlayback.frame.cols, spawnPlayback.frame.cols)
    t.is(attachPlayback.frame.rows, spawnPlayback.frame.rows)
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('input reaches an attached host, including sealed input from the share path', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  const viewer = await loadOrCreateLocalDevice({ root: path.join(dir, 'viewer-device') })

  try {
    const created = await engine.invoke('session.create', { name: 'attached', mode: 'attach' })
    const sessionId = created.sessionId
    const runtime = engine.sessions.get(sessionId)

    await engine.invoke('session.input', { sessionId, data: 'echo local\r' })
    t.alike(
      host.writes,
      [{ sessionId, data: 'echo local\r' }],
      'local input is written to the attached handle'
    )

    // The share path: a viewer seals input, the host opens it and writes it to
    // runtime.pty - the same two calls engine/share-manager.js makes when an
    // authorized peer sends input over the wire.
    const viewerManager = new ShareManager({
      localDevice: viewer,
      remoteSessions: new Map([
        [
          sessionId,
          {
            store: { epoch: runtime.store.epoch, writerDeviceKey: engine.localDevice.publicKey },
            inputCtr: 0
          }
        ]
      ])
    })
    t.teardown(() => viewerManager.close())
    const peer = {
      confirmed: true,
      caps: SEND_INPUT,
      deviceKeyHex: b4a.toString(viewer.publicKey, 'hex'),
      identityKeyHex: b4a.toString(viewer.identityPublicKey, 'hex'),
      identityProofHex: b4a.toString(viewer.identityProof, 'hex'),
      inputCounterKey: b4a.toString(viewer.publicKey, 'hex'),
      inputCounters: new Map(),
      inputCtr: 0
    }
    const sealed = viewerManager.sealInput(sessionId, 'echo remote\r')
    const opened = engine.share._openInputMessage(runtime, peer, { data: sealed })
    t.is(opened, 'echo remote\r', 'the sealed viewer input opened')
    runtime.pty.write(opened)

    t.alike(
      host.writes.map((item) => item.data),
      ['echo local\r', 'echo remote\r'],
      'remote input delivered through the share path reached the fake host write()'
    )
    t.ok(host.terminals.get(sessionId).alive, 'the host terminal is untouched by input routing')
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('detaching ends the session with a detach signal instead of crashing', async (t) => {
  const dir = await temp()
  const host = new FakeHost({ silentDetach: true })
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  const errors = []
  engine.on('engine:error', (err) => errors.push(err))

  try {
    const created = await engine.invoke('session.create', { name: 'detach me', mode: 'attach' })
    const sessionId = created.sessionId
    host.push(sessionId, 'work in progress\r\n')
    await settle(engine, sessionId)

    const exited = new Promise((resolve) => engine.once('session:exit', resolve))
    await engine.invoke('session.close', { sessionId })
    const event = await exited

    t.is(event.exit.signal, DETACH_SIGNAL, 'the exit event carries the detach signal')
    t.is(event.exit.code, null, 'and no exit code, because nothing exited')

    const entry = await engine.catalog.get(sessionId)
    t.is(entry.active, false, 'the catalog entry is closed')
    t.is(entry.exit.signal, DETACH_SIGNAL, 'the catalog records the detach signal')
    t.ok(entry.endedAt > 0, 'the catalog records when it detached')
    t.alike(errors, [], 'detaching raised no engine error')

    const terminal = host.terminals.get(sessionId)
    t.absent(terminal.registered, 'the core let go of the terminal')
    t.ok(terminal.alive, 'the host terminal is still alive after the detach')

    const playback = await engine.invoke('player.open', { sessionId })
    t.ok(playback.length > 0, 'the detached session still plays back')
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('closeSession and deleteSession never kill a host-owned terminal', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()

  try {
    const closed = await engine.invoke('session.create', { name: 'closed', mode: 'attach' })
    const deleted = await engine.invoke('session.create', { name: 'deleted', mode: 'attach' })
    const killed = await engine.invoke('session.create', { name: 'spawned' })
    host.push(closed.sessionId, 'a\r\n')
    host.push(deleted.sessionId, 'b\r\n')
    host.push(killed.sessionId, 'c\r\n')
    await settle(engine, closed.sessionId)
    await settle(engine, deleted.sessionId)
    await settle(engine, killed.sessionId)

    await engine.invoke('session.close', { sessionId: closed.sessionId })
    await engine.invoke('session.delete', { sessionId: deleted.sessionId })
    await engine.invoke('session.close', { sessionId: killed.sessionId })
    await waitFor(async () => {
      const entry = await engine.catalog.get(killed.sessionId)
      return entry && entry.active === false
    })

    t.ok(
      host.terminals.get(closed.sessionId).alive,
      'closeSession left the attached terminal alive'
    )
    t.ok(
      host.terminals.get(deleted.sessionId).alive,
      'deleteSession left the attached terminal alive'
    )
    t.absent(host.terminals.get(closed.sessionId).registered, 'closeSession detached it')
    t.absent(host.terminals.get(deleted.sessionId).registered, 'deleteSession detached it')
    t.absent(
      host.terminals.get(killed.sessionId).alive,
      'spawn-mode behaviour is unchanged: the core still kills what it launched'
    )
    t.absent(await engine.catalog.get(deleted.sessionId), 'the deleted recording is gone')
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('a flooded attached host that ignores pause() buffers to a cap and drops, counted', async (t) => {
  // 60s is the acceptance criterion; the committed default is short so the
  // suite stays fast. ZBTERM_ATTACH_FLOOD_MS=60000 runs the full version.
  const floodMs = Number(process.env.ZBTERM_ATTACH_FLOOD_MS || 2000)
  t.timeout(floodMs + 60000)
  const dir = await temp()
  const host = new FakeHost({ honourPause: false })
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()

  try {
    const created = await engine.invoke('session.create', { name: 'flooded', mode: 'attach' })
    const sessionId = created.sessionId
    const CHUNK = 64 * 1024

    // Warm up past the flow limit first so the baseline reading is taken with
    // the recording machinery already allocated.
    while (!engine.diagnostics(sessionId).sessions[0].flowPaused) {
      host.push(sessionId, Buffer.alloc(CHUNK, 0x78))
    }
    await settle(engine, sessionId)
    const baseline = process.memoryUsage()

    let pushed = 0
    const samples = []
    const started = Date.now()
    let nextSample = started + floodMs / 4
    while (Date.now() - started < floodMs) {
      for (let i = 0; i < 16; i++) {
        // A fresh allocation per push: re-pushing one buffer would make the
        // "bounded memory" claim trivially true by aliasing.
        host.push(sessionId, Buffer.alloc(CHUNK, 0x78))
        pushed += CHUNK
      }
      if (Date.now() >= nextSample) {
        nextSample += floodMs / 4
        samples.push(Math.round(process.memoryUsage().rss / (1024 * 1024)))
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    const elapsed = Date.now() - started
    const after = process.memoryUsage()
    const stats = engine.diagnostics(sessionId).sessions[0]
    samples.push(Math.round(after.rss / (1024 * 1024)))
    const heapGrowthMb = (after.heapUsed - baseline.heapUsed) / (1024 * 1024)
    const rssGrowthMb = (after.rss - baseline.rss) / (1024 * 1024)
    const rssDriftMb = samples[samples.length - 1] - samples[0]

    t.comment(
      `flooded ${(pushed / (1024 * 1024)).toFixed(1)} MiB over ${elapsed}ms; ` +
        `buffered=${stats.bufferedBytes} (cap ${stats.bufferLimit}) ` +
        `dropped=${stats.droppedBytes}B/${stats.droppedChunks} chunks; ` +
        `heap +${heapGrowthMb.toFixed(1)} MiB, rss +${rssGrowthMb.toFixed(1)} MiB, ` +
        `rss samples ${samples.join('/')} MiB`
    )

    t.ok(host.pauses > 0, 'the core asked the host to pause')
    t.ok(stats.flowPaused, 'and still considers the session paused')
    t.is(stats.mode, 'attach')
    t.ok(pushed > ATTACH_BUFFER_LIMIT * 4, 'the flood pushed far more than the buffer holds')
    t.ok(stats.bufferedBytes <= ATTACH_BUFFER_LIMIT, 'the buffer stayed under its cap')
    t.is(stats.bufferLimit, ATTACH_BUFFER_LIMIT)
    t.ok(stats.droppedChunks > 0, `the drop counter is non-zero (${stats.droppedChunks} chunks)`)
    t.ok(stats.droppedBytes > 0, `and counts the dropped bytes (${stats.droppedBytes})`)
    t.is(
      stats.droppedBytes + stats.bufferedBytes,
      pushed,
      'every flooded byte was either buffered or counted as dropped'
    )
    t.ok(heapGrowthMb < 64, `heap did not grow unboundedly (+${heapGrowthMb.toFixed(1)} MiB)`)
    t.ok(
      rssDriftMb < 128,
      `rss plateaued across the flood (${samples.join('/')} MiB, drift ${rssDriftMb} MiB)`
    )

    // The buffered 4 MiB is filler; replaying it into the xterm mirror at
    // teardown would cost seconds and prove nothing.
    const runtime = engine.sessions.get(sessionId)
    runtime.attachBuffer.length = 0
    runtime.attachBufferedBytes = 0
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('output buffered under backpressure is replayed once acks resume the flow', async (t) => {
  const dir = await temp()
  const host = new FakeHost({ honourPause: false })
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()

  try {
    const created = await engine.invoke('session.create', { name: 'backpressure', mode: 'attach' })
    const sessionId = created.sessionId
    const chunk = Buffer.alloc(64 * 1024, 0x79)
    while (!engine.diagnostics(sessionId).sessions[0].flowPaused) host.push(sessionId, chunk)

    host.push(sessionId, 'buffered tail\r\n')
    const paused = engine.diagnostics(sessionId).sessions[0]
    t.is(paused.bufferedBytes, Buffer.byteLength('buffered tail\r\n'), 'the tail was buffered')
    t.is(paused.droppedBytes, 0, 'nothing was dropped below the cap')

    await engine.invoke('session.ack', { sessionId, bytes: paused.pendingBytes })
    const resumed = engine.diagnostics(sessionId).sessions[0]
    t.ok(host.resumes > 0, 'the core resumed the host')
    t.absent(resumed.flowPaused, 'the session is no longer paused')
    t.is(resumed.bufferedBytes, 0, 'the buffer drained')

    await settle(engine, sessionId)
    const recorded = await liveRecording(engine, sessionId)
    t.ok(recorded.includes('buffered tail\r\n'), 'the buffered tail reached the recording')
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('the core records an attached terminal geometry but never resizes it', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()

  try {
    const attached = await engine.invoke('session.create', { name: 'attached', mode: 'attach' })
    const spawned = await engine.invoke('session.create', { name: 'spawned' })

    await engine.invoke('session.resize', { sessionId: attached.sessionId, cols: 120, rows: 40 })
    await engine.invoke('session.resize', { sessionId: spawned.sessionId, cols: 120, rows: 40 })

    t.alike(
      host.resizes,
      [{ sessionId: spawned.sessionId, cols: 120, rows: 40 }],
      'only the core-owned terminal was resized'
    )
    const runtime = engine.sessions.get(attached.sessionId)
    t.is(runtime.cols, 120, 'the core recorded the geometry the host reported')
    t.is(runtime.rows, 40)

    for (const bad of [null, undefined, 0, -1, 24.5, NaN, '80']) {
      await t.exception(
        engine.invoke('session.resize', {
          sessionId: attached.sessionId,
          cols: bad,
          rows: 40
        }),
        { code: CODES.E_INTERNAL },
        `cols=${String(bad)} is refused before it can corrupt playback geometry`
      )
    }
    t.is(engine.sessions.get(attached.sessionId).cols, 120, 'geometry survived the bad resizes')
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('attach mode is refused when the injected host cannot attach', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  // A host that only implements the spawn half of the contract (attach() is on
  // the prototype, so shadow it rather than deleting an own property).
  host.attach = null
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()

  try {
    await t.exception(
      engine.invoke('session.create', { name: 'nope', mode: 'attach' }),
      { code: CODES.E_INTERNAL },
      'a host without attach() cannot be asked to attach'
    )
    const spawned = await engine.invoke('session.create', { name: 'fine' })
    t.is(engine.diagnostics(spawned.sessionId).sessions[0].mode, 'spawn', 'spawn mode still works')
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

async function record(engine, host, opts) {
  const created = await engine.invoke('session.create', opts)
  const sessionId = created.sessionId
  for (const piece of STREAM) host.push(sessionId, piece)
  await settle(engine, sessionId)
  await engine.invoke('session.resize', { sessionId, cols: 100, rows: 30 })
  host.push(sessionId, TAIL)
  await settle(engine, sessionId)
  await engine.invoke('session.close', { sessionId })
  await waitFor(async () => {
    const entry = await engine.catalog.get(sessionId)
    return entry && entry.active === false
  })
  return sessionId
}

// Concatenated payload bytes plus the packet-kind/geometry sequence. Packet
// *boundaries* are a timing artifact of _schedulePacketFlush, so the bytes are
// compared as one stream and only the non-DATA packets keep their positions.
async function readRecording(engine, sessionId) {
  const store = await SessionStore.open(engine.paths.corestore, sessionId, engine.localDevice)
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

async function liveRecording(engine, sessionId) {
  const runtime = engine.sessions.get(sessionId)
  const packets = await runtime.store.readAll()
  return Buffer.concat(
    packets.filter((p) => PacketKindName[p.kind] === 'DATA').map((p) => p.payload)
  ).toString('utf8')
}

async function settle(engine, sessionId) {
  const runtime = engine.sessions.get(sessionId)
  if (!runtime) return
  engine._flushPacketBuffer(sessionId)
  await runtime.appendQueue.catch(() => {})
  await runtime.mirrorQueue.catch(() => {})
}

async function waitFor(fn) {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    const result = await fn()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for condition')
}

function temp() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-engine-attach-test-'))
}
