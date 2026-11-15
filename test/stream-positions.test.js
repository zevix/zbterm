// 261114_live-output-and-fixes (design A): every session:data chunk carries
// `end`, the session's stream position after it, and every frame `through`,
// the position it holds, taken in one synchronous step with the snapshot.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')

require('./helpers/zxterm-core')

const SessionEngine = require('../engine')
const { TerminalFrame } = require('../engine/terminal-frame')

test('ends count the stream; a frame holds exactly the bytes through `through`', async (t) => {
  const { engine, pty, seen } = await engineWith(t)
  const { sessionId } = await engine.invoke('session.create', { name: 'one', cols: 80, rows: 24 })
  await push(engine, pty, sessionId, 'first\r\n')
  await push(engine, pty, sessionId, 'second\r\n')
  const mine = seen.filter((e) => e.sessionId === sessionId)
  let at = 0
  for (const e of mine) {
    at += e.data.byteLength
    t.is(e.end, at, 'end is the position after the chunk')
  }
  const opened = await engine.invoke('session.open', { sessionId })
  t.is(opened.frame.through, at, 'the frame holds everything emitted')
  t.is(opened.position, at, 'and the state says where the stream is')
  const quiet = await engine.invoke('session.open', { sessionId, frame: false })
  t.is(quiet.frame, null, 'frame: false leaves the screen out')
  t.is(quiet.position, at)
})

test('output while session.open is in flight is in the frame or after `through`, never neither', async (t) => {
  const { engine, pty, seen } = await engineWith(t)
  const { sessionId } = await engine.invoke('session.create', { name: 'race', cols: 80, rows: 24 })
  await push(engine, pty, sessionId, 'before\r\n')
  for (let trial = 0; trial < 20; trial++) {
    const marker = `MARK${trial}X`
    const opening = engine.invoke('session.open', { sessionId })
    // Lands while the open awaits availability or the mirror.
    for (let k = 0; k < trial % 4; k++) await Promise.resolve()
    pty.push(sessionId, Buffer.from(`${marker}\r\n`))
    const opened = await opening
    const chunk = seen.find(
      (e) => e.sessionId === sessionId && Buffer.from(e.data).includes(marker)
    )
    t.ok(chunk, `trial ${trial}: the chunk was emitted`)
    const inFrame = opened.frame.data.includes(marker)
    t.is(
      inFrame,
      chunk.end <= opened.frame.through,
      `trial ${trial}: in the frame iff end <= through`
    )
    await settle(engine, sessionId)
  }
})

test('a joined session counts on this core: end on each chunk, through once the mirror has it', async (t) => {
  const { engine, seen } = await engineWith(t)
  const mirror = new TerminalFrame(80, 24, { scrollback: 100 })
  t.teardown(() => mirror.dispose())
  const remote = { active: true, mirror, mirrorQueue: Promise.resolve(), hd: false }
  engine.remoteSessions.set('joined-1', remote)
  engine.applyRemoteData('joined-1', Buffer.from('abc\r\n'))
  engine.applyRemoteData('joined-1', Buffer.from('defg\r\n'))
  const mine = seen.filter((e) => e.sessionId === 'joined-1')
  t.alike(
    mine.map((e) => e.end),
    [5, 11],
    'the viewer core’s own positions'
  )
  t.is(remote.bytesSeen, 11)
  await remote.mirrorQueue
  t.is(remote.mirrorBytes, 11, 'the mirror holds them all')
  engine.remoteSessions.delete('joined-1')
})

test('searchBuffer: hidden counts the normal buffer behind the alternate screen (R5)', async (t) => {
  const { engine, pty } = await engineWith(t)
  const { sessionId } = await engine.invoke('session.create', { name: 'alt', cols: 80, rows: 24 })
  await push(
    engine,
    pty,
    sessionId,
    'needle one\r\nneedle two\r\n\x1b[?1049h\x1b[Hneedle shown\r\n'
  )
  const answer = await engine.invoke('session.searchBuffer', { sessionId, query: 'needle' })
  t.is(answer.count, 3)
  t.is(answer.hidden, 2)
})

class FakeHost extends EventEmitter {
  constructor() {
    super()
    this.terminals = new Map()
  }

  spawn(sessionId) {
    const terminal = { sessionId, registered: true }
    this.terminals.set(sessionId, terminal)
    return {
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => this.end(sessionId)
    }
  }

  end(sessionId) {
    const terminal = this.terminals.get(sessionId)
    if (!terminal || !terminal.registered) return
    terminal.registered = false
    this.emit('exit', { sessionId, exit: { code: 0, signal: null } })
  }

  push(sessionId, data) {
    const terminal = this.terminals.get(sessionId)
    if (!terminal || !terminal.registered) return false
    this.emit('data', { sessionId, data })
    return true
  }
}

async function engineWith(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-streampos-'))
  const pty = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: pty })
  await engine.ready()
  const seen = []
  engine.on('session:data', (e) => {
    seen.push(e)
    if (e.source === 'pty') setImmediate(() => engine.ack(e.sessionId, e.data.byteLength))
  })
  t.teardown(async () => {
    await engine.close().catch(() => {})
    await fs.promises
      .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      .catch(() => {})
  })
  return { engine, pty, seen }
}

async function push(engine, pty, sessionId, text) {
  pty.push(sessionId, Buffer.from(text))
  await settle(engine, sessionId)
}

async function settle(engine, sessionId) {
  const runtime = engine.sessions.get(sessionId)
  const deadline = Date.now() + 20000
  while (runtime.mirrorPending.length) {
    if (Date.now() > deadline) throw new Error('timed out: the mirror caught up')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await runtime.mirrorQueue
}
