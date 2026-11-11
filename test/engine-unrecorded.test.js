// Unrecorded sessions (session.create `record: false`, 261110_session-templates
// P1): live only. The store keeps its header and first resize and nothing the
// program printed; no snapshot, share, playback or history copy.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')

require('./helpers/zxterm-core')

const SessionEngine = require('../engine')
const { SessionStore } = require('../engine/session-store')
const { CODES } = require('../engine/errors')

// Just enough of the PTY host contract to drive output by hand; pause and
// resume are counted so a stalled flow shows.
class FakeHost extends EventEmitter {
  constructor() {
    super()
    this.spawns = []
    this.paused = 0
    this.resumed = 0
  }

  spawn(sessionId, opts = {}) {
    this.spawns.push({ sessionId, cols: opts.cols, rows: opts.rows })
    let alive = true
    return {
      write: () => {},
      resize: () => {},
      pause: () => this.paused++,
      resume: () => this.resumed++,
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

test('an unrecorded session leaves its output in no file, through print, resize, flood, extend and close', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  // Built at run time, so this file's source never holds the marker itself.
  const marker = ['zbunrec', process.pid, Date.now(), 'out'].join('-')
  let closed = false
  try {
    const created = await engine.invoke('session.create', {
      name: 'live only',
      cols: 80,
      rows: 24,
      record: false
    })
    const { sessionId } = created
    t.is(created.record, false, 'the create result says it is unrecorded')
    t.is(created.info.record, false, 'the store info says so too')
    const listed = (await engine.invoke('session.list')).find((s) => s.sessionId === sessionId)
    t.is(listed.record, false, 'the catalog entry carries record: false')

    const live = []
    engine.on('session:data', (event) => {
      if (event.sessionId === sessionId) live.push(Buffer.from(event.data).toString())
    })
    host.output(sessionId, `${marker}\r\n`)
    t.ok(live.join('').includes(marker), 'output still reaches the viewer live')
    await engine.invoke('session.resize', { sessionId, cols: 100, rows: 30 })
    host.output(sessionId, `${marker} after resize\r\n`)
    const opened = await waitFor(async () => {
      const state = await engine.invoke('session.open', { sessionId })
      return state.frame && state.frame.data.includes('after resize') ? state : null
    })
    t.ok(opened.frame.data.includes(marker), 'the in-memory screen keeps it, for redraws')

    await engine.invoke('session.close', { sessionId })
    await exited(engine, sessionId)
    const extended = await engine.invoke('session.extend', { sessionId })
    t.is(extended.active, true, 'Extend relaunches it')
    t.is(extended.restoring, false, 'with no history to restore')
    t.is(extended.info.record, false, 'still unrecorded')
    t.alike(host.spawns[1], { sessionId, cols: 100, rows: 30 }, 'at its last geometry')
    host.output(sessionId, `${marker} after extend\r\n`)
    await engine.invoke('session.resize', { sessionId, cols: 90, rows: 28 })
    await engine.invoke('session.close', { sessionId })
    await exited(engine, sessionId)

    t.alike(
      summarize(await readPackets(engine, sessionId)),
      ['RESIZE:80x24'],
      'the log holds its first resize and no data packet'
    )
    t.is(
      await fs.promises.readdir(path.join(engine.paths.snapshots, sessionId)).catch(() => null),
      null,
      'no snapshot directory'
    )

    await engine.close()
    closed = true
    t.alike(await filesHolding(dir, marker), [], 'no file under the test root holds the marker')
  } finally {
    if (!closed) await engine.close()
  }
})

test('control: a recorded session in the same engine holds its marker in its log', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  const marker = ['zbrec', process.pid, Date.now(), 'out'].join('-')
  try {
    const { sessionId } = await engine.invoke('session.create', { cols: 80, rows: 24 })
    host.output(sessionId, `${marker}\r\n`)
    await engine.invoke('session.close', { sessionId })
    await exited(engine, sessionId)
    const packets = summarize(await readPackets(engine, sessionId))
    t.ok(
      packets.some((p) => p.includes(marker)),
      'the recorded session logged it (encrypted on disk, read back here)'
    )
  } finally {
    await engine.close()
  }
})

test('a 5 MB flood in an unrecorded session finishes and leaves no backlog', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  try {
    const { sessionId } = await engine.invoke('session.create', {
      cols: 80,
      rows: 24,
      record: false
    })
    const runtime = engine.sessions.get(sessionId)
    const line = 'yes 0123456789abcdefghijklmnopqrstuvwxyz\r\n'
    const chunk = line.repeat(Math.ceil((64 * 1024) / line.length))
    let sent = 0
    let seen = 0
    engine.on('session:data', (event) => {
      if (event.sessionId !== sessionId) return
      // The renderer's acks, as it sends them.
      seen += event.data.byteLength
      engine.invoke('session.ack', { sessionId, bytes: event.data.byteLength })
    })
    while (sent < 5 * 1024 * 1024) {
      host.output(sessionId, chunk)
      sent += Buffer.byteLength(chunk)
      t.is(runtime.appendBacklog, 0, 'nothing is queued for the store')
      // Let the mirror catch up when it is behind, as a paused PTY would.
      if (runtime.flowPaused) await waitFor(() => !runtime.flowPaused)
    }
    host.output(sessionId, 'flood-done\r\n')
    await runtime.mirrorQueue
    t.is(seen, sent + 'flood-done\r\n'.length, 'every byte reached the viewer')
    t.is(runtime.appendBacklog, 0)
    t.is(runtime.mirrorBacklog, 0, 'the live screen caught up')
    t.is(runtime.pendingBytes, 0, 'every byte was acked')
    t.is(runtime.flowPaused, false, 'the PTY is not left paused')
    t.is(host.paused, host.resumed, 'every pause was resumed')
    t.is(runtime.packetBuffer.length, 0, 'no packet buffered')
    const opened = await engine.invoke('session.open', { sessionId })
    t.ok(opened.frame.data.includes('flood-done'), 'the screen shows the end of the flood')
    t.is(runtime.store.log.length, 1, 'the log took nothing')
  } finally {
    await engine.close()
  }
})

test('share, playback and history copy refuse an unrecorded session; update refuses record', async (t) => {
  const dir = await temp()
  const host = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  try {
    const { sessionId } = await engine.invoke('session.create', {
      name: 'u',
      cols: 80,
      rows: 24,
      record: false
    })
    await refuses(
      t,
      engine.invoke('share.createLink', { sessionId, backend: 'pear' }),
      CODES.E_NOT_RECORDED,
      'share.createLink'
    )
    await refuses(t, engine.invoke('player.open', { sessionId }), CODES.E_NOT_RECORDED, 'player')
    await refuses(
      t,
      engine.invoke('session.create', { copyHistoryFrom: sessionId }),
      CODES.E_NOT_RECORDED,
      'copy history from it'
    )
    await refuses(
      t,
      engine.invoke('session.update', { sessionId, record: true }),
      CODES.E_INVALID,
      'turning recording on'
    )
    const same = await engine.invoke('session.update', { sessionId, record: false, name: 'u2' })
    t.is(same.name, 'u2', 'restating record: false is no change')
    t.is(same.record, false)

    await engine.invoke('session.close', { sessionId })
    await exited(engine, sessionId)
    await refuses(t, engine.invoke('player.open', { sessionId }), CODES.E_NOT_RECORDED, 'ended')
    await refuses(
      t,
      engine.invoke('session.create', { copyHistoryFrom: sessionId }),
      CODES.E_NOT_RECORDED,
      'ended, copy history'
    )

    const recorded = await engine.invoke('session.create', { cols: 80, rows: 24 })
    await refuses(
      t,
      engine.invoke('session.update', { sessionId: recorded.sessionId, record: false }),
      CODES.E_INVALID,
      'turning recording off'
    )
    await refuses(
      t,
      engine.invoke('session.create', { record: false, copyHistoryFrom: recorded.sessionId }),
      CODES.E_INVALID,
      'an unrecorded copy with history'
    )
    t.absent(recorded.record, 'a recorded entry carries no record flag')
  } finally {
    await engine.close()
  }
})

test('the store refuses data packets when its info says record: false, across reopen', async (t) => {
  const dir = await temp()
  const engine = new SessionEngine({ userData: dir, ptyHost: new FakeHost() })
  await engine.ready()
  const root = engine.paths.corestore
  try {
    const store = await SessionStore.create(root, engine.localDevice, {
      name: 'u',
      cols: 80,
      rows: 24,
      record: false
    })
    const sessionId = store.sessionId
    t.is(store.recorded, false)
    t.is(store.log.length, 1, 'header and first resize')
    await refuses(t, store.appendData(Buffer.from('secret')), CODES.E_NOT_RECORDED, 'appendData')
    t.is(store.log.length, 1)
    await store.close()

    const reopened = await SessionStore.open(root, sessionId, engine.localDevice)
    try {
      t.is(reopened.recorded, false, 'the flag is kept in the stored info')
      await refuses(t, reopened.appendData(Buffer.from('x')), CODES.E_NOT_RECORDED, 'reopened')
      await refuses(
        t,
        Promise.resolve().then(() => reopened.beginHistoryCopy(3)),
        CODES.E_NOT_RECORDED,
        'a history copy into it'
      )
      await reopened.updateInfo({ cols: 90 })
      t.is(reopened.recorded, false, 'an info update keeps it')
    } finally {
      await reopened.close()
    }
  } finally {
    await engine.close()
  }
})

async function refuses(t, promise, code, what) {
  try {
    await promise
    t.fail(`${what}: expected ${code}`)
  } catch (err) {
    t.is(err.code, code, `${what} refuses with ${code}`)
  }
}

async function waitFor(fn) {
  const started = Date.now()
  while (Date.now() - started < 10000) {
    const result = await fn()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for condition')
}

async function exited(engine, sessionId) {
  await waitFor(async () => {
    const list = await engine.invoke('session.list')
    return list.some((item) => item.sessionId === sessionId && !item.active)
  })
}

async function readPackets(engine, sessionId) {
  const store = await SessionStore.open(engine.paths.corestore, sessionId, engine.localDevice)
  try {
    return await store.readAll()
  } finally {
    await store.close()
  }
}

function summarize(packets) {
  return packets.map((packet) =>
    packet.kindName === 'DATA'
      ? packet.payload.toString()
      : `${packet.kindName}:${packet.cols}x${packet.rows}`
  )
}

// Every regular file under `root` whose bytes contain `text` (grep -rlF).
async function filesHolding(root, text) {
  const needle = Buffer.from(text)
  const hits = []
  const walk = async (folder) => {
    for (const item of await fs.promises.readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, item.name)
      if (item.isDirectory()) await walk(full)
      else if (item.isFile() && (await fs.promises.readFile(full)).includes(needle)) {
        hits.push(full)
      }
    }
  }
  await walk(root)
  return hits
}

function temp() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-unrecorded-test-'))
}
