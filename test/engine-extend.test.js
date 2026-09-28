const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')

const SessionEngine = require('../engine')
const { SessionStore } = require('../engine/session-store')
const { VERSION, PacketKind } = require('../engine/schema')

// Just enough of the PTY host contract to drive output by hand.
class FakeHost extends EventEmitter {
  constructor() {
    super()
    this.spawns = []
    this.writes = []
    this.resizes = []
  }

  spawn(sessionId, opts = {}) {
    const spawn = { sessionId, cols: opts.cols, rows: opts.rows }
    if (opts.cwd) spawn.cwd = opts.cwd
    if (opts.command) spawn.command = opts.command
    this.spawns.push(spawn)
    let alive = true
    return {
      write: (data) => this.writes.push({ sessionId, data: String(data) }),
      resize: (cols, rows) => this.resizes.push({ sessionId, cols, rows }),
      pause: () => {},
      resume: () => {},
      kill: () => {
        if (!alive) return
        alive = false
        setImmediate(() => this.emit('exit', { sessionId, exit: { code: 0, signal: null } }))
      }
    }
  }

  output(sessionId, text) {
    this.emit('data', { sessionId, data: Buffer.from(text) })
  }
}

test('extend goes live before history is restored and writes accumulated output through', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  const originalReadRange = SessionStore.prototype.readRange
  let release = null
  try {
    const created = await engine.invoke('session.create', { cols: 90, rows: 30 })
    const { sessionId } = created
    host.output(sessionId, 'OLD-HISTORY\r\n')
    await engine.invoke('session.resize', { sessionId, cols: 104, rows: 33 })
    await engine.invoke('session.close', { sessionId })
    await waitFor(async () => {
      const list = await engine.invoke('session.list')
      return list.some((item) => item.sessionId === sessionId && !item.active)
    })
    // No cached snapshot: the restore has to replay the whole recording, and
    // the gate below holds that replay open for as long as the test needs.
    await engine.invoke('session.clearCaches', {})

    const gate = new Promise((resolve) => {
      release = resolve
    })
    SessionStore.prototype.readRange = async function* (...args) {
      await gate
      yield* originalReadRange.apply(this, args)
    }
    const restored = new Promise((resolve) => {
      engine.on('session:restored', (event) => {
        if (event.sessionId === sessionId) resolve()
      })
    })
    const live = []
    engine.on('session:data', (event) => {
      if (event.sessionId === sessionId) live.push(Buffer.from(event.data).toString())
    })

    const extended = await engine.invoke('session.extend', { sessionId })
    t.is(extended.active, true)
    t.is(extended.restoring, true, 'extend returns while history is still restoring')
    t.is(host.spawns.length, 2, 'the shell is spawned without waiting for the restore')
    t.alike(host.spawns[1], { sessionId, cols: 90, rows: 30 })

    host.output(sessionId, 'NEW-OUTPUT\r\n')
    t.ok(live.includes('NEW-OUTPUT\r\n'), 'live output reaches the viewer immediately')
    await engine.invoke('session.input', { sessionId, data: 'ls\r' })
    t.alike(host.writes, [{ sessionId, data: 'ls\r' }], 'input works while restoring')
    t.ok(await engine.invoke('session.resize', { sessionId, cols: 90, rows: 30 }))
    const early = await engine.invoke('session.open', { sessionId })
    t.is(early.restoring, true)
    t.is(early.frame, null, 'no half-built frame is handed out mid-restore')

    release()
    await restored
    const opened = await engine.invoke('session.open', { sessionId })
    t.is(opened.restoring, false)
    t.ok(opened.frame.data.includes('OLD-HISTORY'), 'restored screen keeps the history')
    t.ok(opened.frame.data.includes('NEW-OUTPUT'), 'restored screen includes accumulated output')
    t.is(opened.frame.cols, 90)
    t.is(opened.frame.rows, 30)

    await engine.invoke('session.close', { sessionId })
    await waitFor(async () => {
      const list = await engine.invoke('session.list')
      return list.some((item) => item.sessionId === sessionId && !item.active)
    })
    SessionStore.prototype.readRange = originalReadRange
    const store = await SessionStore.open(engine.paths.corestore, sessionId, engine.localDevice)
    try {
      const packets = await store.readAll()
      const summary = packets.map((packet) =>
        packet.kindName === 'DATA'
          ? packet.payload.toString()
          : `${packet.kindName}:${packet.cols}x${packet.rows}`
      )
      // Live data is batched before it is appended while resizes are appended
      // at once, so within one run a resize can precede the output before it.
      const old = summary.indexOf('OLD-HISTORY\r\n')
      const next = summary.indexOf('NEW-OUTPUT\r\n')
      t.ok(old >= 0 && summary.includes('RESIZE:104x33'), 'history is still there')
      t.alike(
        summary.slice(old + 1, next),
        ['RESIZE:90x30', 'RESIZE:90x30'],
        'spawn-geometry fix-up then the mid-restore resize, recorded after history'
      )
      t.is(next, summary.length - 1, 'accumulated output is appended after the restore')
    } finally {
      await store.close()
    }
  } finally {
    if (release) release()
    SessionStore.prototype.readRange = originalReadRange
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

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
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-engine-extend-test-'))
}

test('a session keeps its home directory and command across edits and extends', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  try {
    const created = await engine.invoke('session.create', {
      name: 'box',
      cwd: ' ~/src ',
      command: 'htop',
      cols: 80,
      rows: 24
    })
    const { sessionId } = created
    t.is(created.cwd, '~/src')
    t.is(created.command, 'htop')
    t.alike(host.spawns[0], { sessionId, cols: 80, rows: 24, cwd: '~/src', command: 'htop' })

    const updated = await engine.invoke('session.update', {
      sessionId,
      name: 'renamed',
      cwd: '/tmp',
      command: ''
    })
    t.is(updated.name, 'renamed')
    t.is(updated.cwd, '/tmp')
    t.is(updated.command, null, 'an empty command means the default shell')

    await engine.invoke('session.close', { sessionId })
    await waitFor(async () => {
      const list = await engine.invoke('session.list')
      return list.some((item) => item.sessionId === sessionId && !item.active)
    })
    await engine.invoke('session.extend', { sessionId })
    t.is(host.spawns.length, 2)
    t.is(host.spawns[1].cwd, '/tmp', 'extend launches in the edited directory')
    t.absent(host.spawns[1].command, 'extend launches the default shell')

    const plain = await engine.invoke('session.create', { cols: 80, rows: 24 })
    t.absent(plain.cwd)
    t.absent(plain.command)
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('session.create copyHistoryFrom seeds the new session with the source history', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  try {
    const source = await engine.invoke('session.create', { name: 'src', cols: 90, rows: 30 })
    host.output(source.sessionId, 'OLD-HISTORY\r\n')
    await engine.invoke('session.resize', { sessionId: source.sessionId, cols: 104, rows: 33 })
    host.output(source.sessionId, 'MORE-HISTORY\r\n')
    await engine.invoke('session.close', { sessionId: source.sessionId })
    await waitFor(async () => {
      const list = await engine.invoke('session.list')
      return list.some((item) => item.sessionId === source.sessionId && !item.active)
    })
    const sourcePackets = await readPackets(engine, source.sessionId)
    const sourceEntry = (await engine.invoke('session.list')).find(
      (item) => item.sessionId === source.sessionId
    )
    t.ok(sourceEntry.snapshotCount >= 1, 'the source has a snapshot to reuse')

    const restored = new Promise((resolve) => {
      engine.on('session:restored', (event) => resolve(event.sessionId))
    })
    const copy = await engine.invoke('session.create', {
      name: 'src #2',
      cols: 80,
      rows: 24,
      copyHistoryFrom: source.sessionId
    })
    t.not(copy.sessionId, source.sessionId)
    // A recording this small may finish rebuilding before create even replies.
    t.is(typeof copy.restoring, 'boolean')
    t.is(copy.startedAt, sourcePackets[0].tsMs, 'the copy starts where its history does')
    t.is(copy.info.createdAt, sourcePackets[0].tsMs)
    t.ok(copy.lastStartedAt >= copy.startedAt)
    t.ok(copy.timeline.length >= sourcePackets.length, 'the copied timeline is known up front')
    t.ok(copy.availability.logLength >= sourcePackets.length)
    t.alike(host.spawns[host.spawns.length - 1], { sessionId: copy.sessionId, cols: 80, rows: 24 })
    t.is(await restored, copy.sessionId)
    const copyEntry = (await engine.invoke('session.list')).find(
      (item) => item.sessionId === copy.sessionId
    )
    t.is(copyEntry.snapshotCount, sourceEntry.snapshotCount, 'source snapshots are re-sealed')

    host.output(copy.sessionId, 'NEW-SHELL\r\n')
    const opened = await engine.invoke('session.open', { sessionId: copy.sessionId })
    t.is(opened.restoring, false)
    t.ok(opened.frame.data.includes('MORE-HISTORY'), 'the live screen carries the old output')
    t.ok(opened.frame.data.includes('NEW-SHELL'), 'followed by the new shell')

    await engine.invoke('session.close', { sessionId: copy.sessionId })
    await waitFor(async () => {
      const list = await engine.invoke('session.list')
      return list.some((item) => item.sessionId === copy.sessionId && !item.active)
    })
    const copyPackets = await readPackets(engine, copy.sessionId)
    const strip = (packet) => ({
      tsMs: packet.tsMs,
      kind: packet.kind,
      cols: packet.cols,
      rows: packet.rows,
      hd: packet.hd,
      payload: packet.payload.toString('hex')
    })
    t.alike(
      copyPackets.slice(0, sourcePackets.length).map(strip),
      sourcePackets.map(strip),
      'every source packet is copied verbatim, same seqs'
    )
    const rest = copyPackets.slice(sourcePackets.length)
    t.is(rest[0].kindName, 'RESIZE')
    t.is(`${rest[0].cols}x${rest[0].rows}`, '80x24', 'then the new shell geometry')
    t.ok(
      rest.some(
        (packet) => packet.kindName === 'DATA' && packet.payload.toString() === 'NEW-SHELL\r\n'
      ),
      'then the new output'
    )
    t.alike(
      (await readPackets(engine, source.sessionId)).map(strip),
      sourcePackets.map(strip),
      'the source is left untouched'
    )

    const player = await engine.invoke('player.open', { sessionId: copy.sessionId })
    const early = await engine.invoke('player.seek', {
      sessionId: copy.sessionId,
      tsMs: sourcePackets[sourcePackets.length - 1].tsMs
    })
    t.ok(player.timeline.length >= copyPackets.length)
    t.ok(early.data.includes('MORE-HISTORY'), 'playback shows the copied history')
    t.absent(early.data.includes('NEW-SHELL'), 'before the new shell output')
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('copyHistoryFrom copies a live source and rejects unknown sources', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  try {
    const source = await engine.invoke('session.create', { name: 'live', cols: 80, rows: 24 })
    host.output(source.sessionId, 'STILL-BUFFERED\r\n')
    const copy = await engine.invoke('session.create', {
      cols: 80,
      rows: 24,
      copyHistoryFrom: source.sessionId
    })
    t.ok(
      copy.availability.logLength >= 2,
      'buffered output of the live source is flushed into the copy'
    )
    host.output(source.sessionId, 'AFTER-COPY\r\n')
    await waitFor(async () => {
      const state = await engine.invoke('session.open', { sessionId: copy.sessionId })
      return !state.restoring && state.frame.data.includes('STILL-BUFFERED')
    })
    const state = await engine.invoke('session.open', { sessionId: copy.sessionId })
    t.absent(state.frame.data.includes('AFTER-COPY'), 'later source output stays in the source')

    const before = (await engine.invoke('session.list')).length
    await t.exception(
      engine.invoke('session.create', { copyHistoryFrom: 'f'.repeat(64) }),
      /not found/
    )
    t.is((await engine.invoke('session.list')).length, before, 'a failed copy creates nothing')
    t.is(host.spawns.length, 2)
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

// A closed local session with `count` small DATA packets, one ms apart.
async function makeSource(engine, host, count) {
  const source = await engine.invoke('session.create', { name: 'big', cols: 80, rows: 24 })
  await engine.invoke('session.close', { sessionId: source.sessionId })
  await waitFor(async () => {
    const list = await engine.invoke('session.list')
    return list.some((item) => item.sessionId === source.sessionId && !item.active)
  })
  const store = await SessionStore.open(
    engine.paths.corestore,
    source.sessionId,
    engine.localDevice
  )
  const last = store.timeline[store.timeline.length - 1].tsMs
  const base = (i) => last + Math.floor(i / 20)
  try {
    for (let i = 0; i < count; i++) {
      await store.appendPlain({
        version: VERSION,
        tsMs: base(i),
        kind: PacketKind.DATA,
        cols: null,
        rows: null,
        payload: Buffer.from(`H${i}\r\n`),
        hd: false
      })
    }
  } finally {
    await store.close()
  }
  // History never lies in the future of whatever copies it.
  while (Date.now() <= base(count)) await new Promise((resolve) => setTimeout(resolve, 10))
  return source.sessionId
}

// Holds every SessionStore#appendCopied call until released, one at a time
// or all at once, so a test can act while a history copy is mid-way.
function gateCopies() {
  const original = SessionStore.prototype.appendCopied
  const waiting = []
  const gate = {
    open: false,
    calls: 0,
    release() {
      const next = waiting.shift()
      if (next) next()
      return !!next
    },
    openAll() {
      gate.open = true
      while (gate.release());
    },
    restore() {
      gate.openAll()
      SessionStore.prototype.appendCopied = original
    },
    async waitForCall(n) {
      await waitFor(() => gate.calls >= n && waiting.length > 0)
    }
  }
  SessionStore.prototype.appendCopied = async function (packets) {
    if (packets.length) {
      gate.calls++
      if (!gate.open) await new Promise((resolve) => waiting.push(resolve))
    }
    return await original.call(this, packets)
  }
  return gate
}

function summarize(packets) {
  return packets.map((packet) =>
    packet.kindName === 'DATA'
      ? packet.payload.toString()
      : `${packet.kindName}:${packet.cols}x${packet.rows}`
  )
}

async function exited(engine, sessionId) {
  await waitFor(async () => {
    const list = await engine.invoke('session.list')
    return list.some((item) => item.sessionId === sessionId && !item.active)
  })
}

test('copyHistoryFrom returns before the copy and keeps history, resize, live output in order', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  let gate = null
  try {
    const sourceId = await makeSource(engine, host, 600)
    const sourcePackets = await readPackets(engine, sourceId)
    const errors = []
    engine.on('engine:error', (err) => errors.push(err))
    const progress = []
    engine.on('session:availability-changed', (event) => progress.push(event))
    const live = []
    engine.on('session:data', (event) => live.push(Buffer.from(event.data).toString()))

    gate = gateCopies()
    const copy = await engine.invoke('session.create', {
      cols: 80,
      rows: 24,
      copyHistoryFrom: sourceId
    })
    const copyId = copy.sessionId
    const restored = new Promise((resolve) => {
      engine.on('session:restored', (event) => {
        if (event.sessionId === copyId) resolve()
      })
    })
    t.is(copy.restoring, true, 'create returns while the history is still being copied')
    t.alike(host.spawns[host.spawns.length - 1], { sessionId: copyId, cols: 80, rows: 24 })
    t.is(copy.timeline.length, sourcePackets.length, 'the whole copied timeline is known up front')
    t.alike(copy.availability, { availableLength: 0, logLength: sourcePackets.length, gaps: [] })

    host.output(copyId, 'LIVE-1\r\n')
    t.ok(live.includes('LIVE-1\r\n'), 'live output is shown at once')
    await engine.invoke('session.input', { sessionId: copyId, data: 'x' })

    // First batch; hold it past a slice so the copy lets go of the source.
    await gate.waitForCall(1)
    await new Promise((resolve) => setTimeout(resolve, 300))
    gate.release()
    await waitFor(() => progress.some((event) => event.sessionId === copyId))
    const first = progress.find((event) => event.sessionId === copyId)
    t.is(first.availableLength, 256)
    t.is(first.logLength, sourcePackets.length)
    const mid = await engine.invoke('session.open', { sessionId: copyId })
    t.is(mid.restoring, true)
    t.alike(mid.availability, { availableLength: 256, logLength: sourcePackets.length, gaps: [] })
    t.is(mid.timeline.length, sourcePackets.length)

    // The source is not locked for the whole copy.
    await gate.waitForCall(2)
    const playing = engine.invoke('player.open', { sessionId: sourceId })
    gate.release()
    const player = await playing
    t.is(player.length, sourcePackets.length, 'the source can be played mid-copy')
    const during = await engine.invoke('session.open', { sessionId: copyId })
    t.is(during.availability.availableLength, 512, 'and the copy is still running')

    gate.openAll()
    await restored
    t.is(progress[progress.length - 1].availableLength, sourcePackets.length + 1)
    t.is(progress[progress.length - 1].logLength, sourcePackets.length + 1)
    host.output(copyId, 'LIVE-2\r\n')
    await engine.invoke('session.close', { sessionId: copyId })
    await exited(engine, copyId)

    const packets = await readPackets(engine, copyId)
    const strip = (packet) => [packet.seq, packet.tsMs, packet.kind, packet.payload.toString('hex')]
    t.alike(
      packets.slice(0, sourcePackets.length).map(strip),
      sourcePackets.map(strip),
      'history first, verbatim'
    )
    const rest = summarize(packets.slice(sourcePackets.length))
    t.is(rest[0], 'RESIZE:80x24', 'then the first resize')
    t.alike(rest.slice(1), ['LIVE-1\r\n', 'LIVE-2\r\n'], 'then the live output')
    for (let i = 1; i < packets.length; i++) {
      if (packets[i].tsMs < packets[i - 1].tsMs) {
        t.fail(`timestamps go backwards at seq ${packets[i].seq}`)
        break
      }
    }
    t.ok(packets[sourcePackets.length].tsMs <= packets[sourcePackets.length + 1].tsMs)
    const store = await SessionStore.open(engine.paths.corestore, copyId, engine.localDevice)
    try {
      t.is(store.timeline.length, packets.length, 'the timeline on disk matches the log')
    } finally {
      await store.close()
    }
    t.alike(errors, [])
  } finally {
    if (gate) gate.restore()
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('copyHistoryFrom stops cleanly when the source is deleted mid-copy', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  let gate = null
  try {
    const sourceId = await makeSource(engine, host, 600)
    const sourcePackets = await readPackets(engine, sourceId)
    const errors = []
    engine.on('engine:error', (err) => errors.push(err))
    gate = gateCopies()
    const copy = await engine.invoke('session.create', {
      cols: 80,
      rows: 24,
      copyHistoryFrom: sourceId
    })
    const copyId = copy.sessionId
    const restored = new Promise((resolve) => {
      engine.on('session:restored', (event) => {
        if (event.sessionId === copyId) resolve()
      })
    })
    host.output(copyId, 'LIVE\r\n')
    await gate.waitForCall(1)
    const deleting = engine.invoke('session.delete', { sessionId: sourceId })
    gate.openAll()
    t.ok(await deleting, 'the source is deleted without waiting for the copy')
    await restored
    t.absent(
      (await engine.invoke('session.list')).some((item) => item.sessionId === sourceId),
      'the source is gone'
    )
    const opened = await engine.invoke('session.open', { sessionId: copyId })
    t.is(opened.availability.availableLength, opened.availability.logLength)
    t.is(opened.timeline.length, 257, 'the timeline keeps only what was copied, then the resize')

    await engine.invoke('session.close', { sessionId: copyId })
    await exited(engine, copyId)
    const packets = await readPackets(engine, copyId)
    t.alike(
      summarize(packets.slice(0, 256)),
      summarize(sourcePackets.slice(0, 256)),
      'what was copied is kept'
    )
    t.alike(summarize(packets.slice(256)), ['RESIZE:80x24', 'LIVE\r\n'])
    t.alike(errors, [], 'a vanished source is not an error')
  } finally {
    if (gate) gate.restore()
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('deleting a session mid-copy stops the copy and removes it', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  let gate = null
  try {
    const sourceId = await makeSource(engine, host, 600)
    const sourcePackets = await readPackets(engine, sourceId)
    const errors = []
    engine.on('engine:error', (err) => errors.push(err))
    gate = gateCopies()
    const copy = await engine.invoke('session.create', {
      cols: 80,
      rows: 24,
      copyHistoryFrom: sourceId
    })
    const copyId = copy.sessionId
    host.output(copyId, 'LIVE\r\n')
    await gate.waitForCall(1)
    const deleting = engine.invoke('session.delete', { sessionId: copyId })
    gate.release()
    t.ok(await deleting)
    t.is(gate.calls, 1, 'no further batch is copied')
    const list = await engine.invoke('session.list')
    t.absent(
      list.some((item) => item.sessionId === copyId),
      'the copy is gone'
    )
    t.absent(fs.existsSync(path.join(engine.paths.corestore, copyId)), 'with its recording')
    t.absent(fs.existsSync(path.join(engine.paths.snapshots, copyId)), 'and its snapshots')
    t.alike(await readPackets(engine, sourceId), sourcePackets, 'the source is untouched')
    t.alike(errors, [])
  } finally {
    if (gate) gate.restore()
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('closing the engine mid-copy does not hang and leaves an ordered recording', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  let engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  let gate = null
  try {
    const sourceId = await makeSource(engine, host, 600)
    const sourcePackets = await readPackets(engine, sourceId)
    gate = gateCopies()
    const copy = await engine.invoke('session.create', {
      cols: 80,
      rows: 24,
      copyHistoryFrom: sourceId
    })
    const copyId = copy.sessionId
    host.output(copyId, 'LIVE\r\n')
    await gate.waitForCall(1)
    const closing = engine.close()
    gate.release()
    const started = Date.now()
    await closing
    t.ok(Date.now() - started < 3000, 'close finishes promptly')
    t.is(gate.calls, 1, 'the copy stopped')
    gate.restore()
    gate = null

    engine = new SessionEngine({ userData: dir, ptyHost: new FakeHost() })
    await engine.ready()
    const packets = await readPackets(engine, copyId)
    t.alike(summarize(packets.slice(0, 256)), summarize(sourcePackets.slice(0, 256)))
    t.is(summarize(packets)[256], 'RESIZE:80x24', 'the first resize follows the copied part')
    t.alike(summarize(packets.slice(257)), ['LIVE\r\n'], 'then the held live output')
    const store = await SessionStore.open(engine.paths.corestore, copyId, engine.localDevice)
    try {
      t.is(store.timeline.length, packets.length, 'the timeline on disk matches the log')
    } finally {
      await store.close()
    }
  } finally {
    if (gate) gate.restore()
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

async function readPackets(engine, sessionId) {
  const store = await SessionStore.open(engine.paths.corestore, sessionId, engine.localDevice)
  try {
    return await store.readAll()
  } finally {
    await store.close()
  }
}
