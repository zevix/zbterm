// 261111_buffer-search: the buffer matcher (engine/buffer-search.js and its
// renderer copy) and the engine's session.searchBuffer, which counts matches
// in a live session's in-memory mirror - own or joined - in slices, and
// answers `cancelled` for a superseded query and `gone` for a session whose
// mirror ended or was repainted mid-scan.
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')
const test = require('brittle')

require('./helpers/zxterm-core')

const SessionEngine = require('../engine')
const LoopbackBackend = require('../engine/backends/loopback')
const { LoopbackHub } = require('../engine/backends/loopback')
const { TerminalFrame } = require('../engine/terminal-frame')
const { scanBuffer, foldText } = require('../engine/buffer-search')

const ROOT = path.join(__dirname, '..')
const ENGINE_COPY = path.join(ROOT, 'engine', 'buffer-search.js')
const RENDERER_COPY = path.join(ROOT, 'renderer', 'buffer-search.js')

// --- the matcher -------------------------------------------------------------

test('the engine and renderer copies of the matcher are the same file', (t) => {
  t.is(
    fs.readFileSync(RENDERER_COPY, 'utf8'),
    fs.readFileSync(ENGINE_COPY, 'utf8'),
    'renderer/buffer-search.js is byte for byte engine/buffer-search.js'
  )
})

test('both copies answer the same on the same buffer', async (t) => {
  const sandbox = { window: {} }
  vm.runInNewContext(fs.readFileSync(RENDERER_COPY, 'utf8'), sandbox, { filename: RENDERER_COPY })
  const rendererScan = sandbox.window.zbtermScanBuffer
  t.is(typeof rendererScan, 'function', 'the plain script sets window.zbtermScanBuffer')

  const frame = await frameWith(20, 6, 200, mixedText())
  const buffer = frame.term.buffer.active
  for (const query of ['needle', 'NEEDLE', 'e', '漢字', 'wrap-across', 'İst', 'x ', 'nothing']) {
    for (const opts of [{}, { limit: 3 }, { limit: 0 }, { from: 5, lines: 4 }]) {
      const engine = scanBuffer(buffer, query, opts)
      // Across vm contexts the objects differ only by their prototypes.
      const renderer = JSON.parse(JSON.stringify(rendererScan(buffer, query, opts)))
      t.alike(
        renderer,
        JSON.parse(JSON.stringify(engine)),
        `${JSON.stringify(query)} ${JSON.stringify(opts)}`
      )
    }
  }
  frame.dispose()
})

test('a match across a soft wrap is one match, mapped to its cells', async (t) => {
  const frame = await frameWith(10, 5, 50, 'hello WORLD foo\r\n')
  const buffer = frame.term.buffer.active
  t.ok(buffer.getLine(1).isWrapped, 'the line wrapped (precondition)')
  const result = scanBuffer(buffer, 'world')
  t.is(result.count, 1)
  t.alike(
    result.matches,
    [{ row: 0, col: 6, len: 5 }],
    'starts at row 0 col 6, runs 5 cells into row 1'
  )
  t.is(scanBuffer(buffer, 'd foo').count, 1, 'a match starting on the wrapped row')
  frame.dispose()
})

test('wide characters: columns are cells, and a wide character pushed to the next row', async (t) => {
  const frame = await frameWith(10, 5, 50, '漢字漢字漢字xNEEDLE\r\n🙂🙂ab\r\n')
  const buffer = frame.term.buffer.active
  t.alike(
    scanBuffer(buffer, 'xneedle').matches,
    [{ row: 1, col: 2, len: 7 }],
    'after CJK on a wrapped row'
  )
  t.alike(scanBuffer(buffer, '漢字').matches.length, 3, 'three CJK pairs')
  t.alike(
    scanBuffer(buffer, '漢字漢字漢字').matches,
    [{ row: 0, col: 0, len: 12 }],
    'CJK across the wrap: 12 cells'
  )
  // Emoji widths are the terminal's (Unicode 6 in xterm by default: 1 cell).
  const emoji = buffer.getLine(2).getCell(0).getWidth()
  t.alike(
    scanBuffer(buffer, 'ab').matches,
    [{ row: 2, col: 2 * emoji, len: 2 }],
    'after two emoji (surrogate pairs)'
  )

  // 9 columns: the fifth CJK character does not fit and leaves the last cell empty.
  const odd = await frameWith(9, 5, 50, '漢字漢字漢\r\n')
  const oddBuffer = odd.term.buffer.active
  t.is(
    oddBuffer.getLine(0).getCell(8).getChars(),
    '',
    'the last cell of row 0 is empty (precondition)'
  )
  t.alike(
    scanBuffer(oddBuffer, '字漢').matches.length,
    2,
    'the empty cell before a wrapped wide character is not a space'
  )
  t.alike(
    scanBuffer(oddBuffer, '字漢').matches[0],
    { row: 0, col: 6, len: 5 },
    'newest first: 字 at col 6, 漢 on row 1 col 0; len spans the empty cell'
  )
  frame.dispose()
  odd.dispose()
})

test('case folding keeps lengths; the query is used as typed', async (t) => {
  t.is(foldText('İSTANBUL'), 'İstanbul', 'İ (lower case two code units) is kept as is')
  t.is(foldText('ΟΔΟΣ'), 'οδοσ', 'Σ folds to σ, the same everywhere')
  t.is(foldText('HeLLo'), 'hello')

  const frame = await frameWith(40, 5, 50, 'İstanbul ISTANBUL istanbul\r\nfoo\r\nfoo bar\r\n')
  const buffer = frame.term.buffer.active
  t.is(scanBuffer(buffer, 'istanbul').count, 2, 'İstanbul does not fold to istanbul')
  t.is(scanBuffer(buffer, 'İSTANBUL').count, 1, 'İSTANBUL matches İstanbul only')
  t.alike(
    scanBuffer(buffer, 'İst').matches,
    [{ row: 0, col: 0, len: 3 }],
    'columns stay right after İ'
  )
  t.alike(
    scanBuffer(buffer, 'bul').matches[0],
    { row: 0, col: 23, len: 3 },
    'offsets after İ are cells'
  )
  t.is(scanBuffer(buffer, 'foo').count, 2)
  t.is(scanBuffer(buffer, 'foo ').count, 1, 'a trailing space is kept: only "foo bar"')
  t.is(scanBuffer(buffer, ' ').count, 0, 'an all-whitespace query is refused')
  t.is(scanBuffer(buffer, '').count, 0, 'an empty query is refused')
  t.is(scanBuffer(buffer, 'aaa').count, 0)
  const runs = await frameWith(40, 5, 50, 'aaaaa\r\n')
  t.is(scanBuffer(runs.term.buffer.active, 'aa').count, 2, 'non-overlapping: aaaaa holds aa twice')
  frame.dispose()
  runs.dispose()
})

test('the count is exact; positions stop at the limit, newest first', async (t) => {
  const frame = await frameWith(
    120,
    40,
    5000,
    repeatLines(5040, () => 'e'.repeat(100))
  )
  const buffer = frame.term.buffer.active
  const result = scanBuffer(buffer, 'e')
  let expected = 0
  for (let y = 0; y < buffer.length; y++) {
    expected += (buffer.getLine(y).translateToString(true).match(/e/g) || []).length
  }
  t.ok(expected > 500000, `precondition: ${expected} e in the buffer`)
  t.is(result.count, expected, 'every e in the scrollback and the screen is counted')
  t.is(result.matches.length, 50000, 'positions stop at 50 000')
  t.ok(
    result.matches[0].row > result.matches[1].row || result.matches[0].col > result.matches[1].col,
    'newest first'
  )
  const last = lastRowWith(buffer, 'e')
  t.alike(result.matches[0], { row: last, col: 99, len: 1 }, 'the first is the newest e')
  t.is(scanBuffer(buffer, 'e', { limit: 0 }).matches.length, 0, 'limit 0 counts only')
  frame.dispose()
})

test('slices: a range reads the logical lines that start in it, no more, no less', async (t) => {
  const frame = await frameWith(
    10,
    5,
    500,
    repeatLines(300, (i) => (i % 3 === 0 ? 'NEEDLE-and-wrapped' : `line ${i}`))
  )
  const buffer = frame.term.buffer.active
  const whole = scanBuffer(buffer, 'needle', { limit: 0 }).count
  t.is(whole, 100)
  for (const lines of [1, 7, 50]) {
    let row = 0
    let count = 0
    let calls = 0
    while (row < buffer.length) {
      const slice = scanBuffer(buffer, 'needle', { from: row, lines, limit: 0 })
      t.ok(slice.next > row, 'every slice moves on')
      count += slice.count
      row = slice.next
      calls++
    }
    t.is(count, whole, `${lines}-line slices add up to the whole (${calls} calls)`)
  }
  // A slice that starts on a continuation row leaves that line to the slice before.
  t.is(scanBuffer(buffer, 'needle', { from: 1, to: 2 }).count, 0, 'row 1 continues row 0')
  frame.dispose()
})

test('the alternate screen is read by the buffer it is', async (t) => {
  const frame = await frameWith(40, 5, 100, 'SCROLLBACK-WORD\r\n')
  await frame.write('\x1b[?1049h\x1b[HALT-WORD on screen')
  t.is(frame.term.buffer.active.type, 'alternate', 'precondition: alt screen shown')
  t.is(scanBuffer(frame.term.buffer.normal, 'word').count, 1, 'normal buffer')
  t.is(scanBuffer(frame.term.buffer.alternate, 'word').count, 1, 'alternate buffer')
  frame.dispose()
})

// --- session.searchBuffer ----------------------------------------------------

test('searchBuffer counts a live session, normal buffer plus the shown alt screen', async (t) => {
  const { engine, pty } = await engineWith(t)
  const { sessionId } = await engine.invoke('session.create', { name: 'one', cols: 80, rows: 24 })
  await push(
    engine,
    pty,
    sessionId,
    repeatLines(2000, (i) => (i % 10 === 0 ? `hit Needle ${i}` : `line ${i}`))
  )
  let answer = await engine.invoke('session.searchBuffer', {
    sessionId,
    query: 'NEEDLE',
    searchKey: 'w',
    seq: 1
  })
  t.alike(answer, { sessionId, count: 200, cancelled: false, gone: false })

  await push(engine, pty, sessionId, '\x1b[?1049h\x1b[Hneedle in less\r\n')
  answer = await engine.invoke('session.searchBuffer', {
    sessionId,
    query: 'needle',
    searchKey: 'w',
    seq: 2
  })
  t.is(answer.count, 201, 'normal buffer (200) plus the alt screen (1)')
  await push(engine, pty, sessionId, '\x1b[?1049l')
  answer = await engine.invoke('session.searchBuffer', {
    sessionId,
    query: 'needle',
    searchKey: 'w',
    seq: 3
  })
  t.is(answer.count, 200, 'alt screen left: its text is gone with it')

  answer = await engine.invoke('session.searchBuffer', {
    sessionId,
    query: '   ',
    searchKey: 'w',
    seq: 4
  })
  t.alike(
    answer,
    { sessionId, count: 0, cancelled: false, gone: false },
    'all whitespace: no search'
  )
})

test('searchBuffer never opens the recording', async (t) => {
  const { engine, pty } = await engineWith(t)
  const { sessionId } = await engine.invoke('session.create', { name: 'one', cols: 80, rows: 24 })
  await push(engine, pty, sessionId, 'secret-word\r\n')
  const opened = []
  for (const name of ['openSession', 'openPlayer', 'playerView', '_currentRemoteFrame']) {
    const original = engine[name]
    if (typeof original !== 'function') continue
    engine[name] = function (...args) {
      opened.push(name)
      return original.apply(this, args)
    }
  }
  const runtime = engine.sessions.get(sessionId)
  const snapshot = runtime.mirror.snapshot
  runtime.mirror.snapshot = function (...args) {
    opened.push('mirror.snapshot')
    return snapshot.apply(this, args)
  }
  const answer = await engine.invoke('session.searchBuffer', { sessionId, query: 'secret-word' })
  t.is(answer.count, 1)
  t.alike(opened, [], 'no player, no session.open, no serialised screen')
  t.is(engine.players.size, 0, 'no player was made')
})

test('searchBuffer: ended, pending and unknown sessions answer gone', async (t) => {
  const { engine, pty } = await engineWith(t)
  const { sessionId } = await engine.invoke('session.create', { name: 'one', cols: 80, rows: 24 })
  await push(engine, pty, sessionId, 'only-in-ended\r\n')
  t.is(
    (await engine.invoke('session.searchBuffer', { sessionId, query: 'only-in-ended' })).count,
    1
  )
  pty.end(sessionId)
  await until(() => !engine.sessions.has(sessionId), 'the session ended')
  t.alike(
    await engine.invoke('session.searchBuffer', { sessionId, query: 'only-in-ended' }),
    {
      sessionId,
      count: 0,
      cancelled: false,
      gone: true
    },
    'ended: gone, the recording is not read'
  )
  t.alike(
    await engine.invoke('session.searchBuffer', { sessionId: 'no-such-session', query: 'x' }),
    { sessionId: 'no-such-session', count: 0, cancelled: false, gone: true },
    'unknown: gone, not an error'
  )
  // A joined session before its bootstrap has no mirror yet.
  engine.remoteSessions.set('pending-join', { active: true, mirror: null })
  t.is(
    (await engine.invoke('session.searchBuffer', { sessionId: 'pending-join', query: 'x' })).gone,
    true,
    'pending join: gone'
  )
  engine.remoteSessions.delete('pending-join')
})

test('searchBuffer reads in slices: a newer seq cancels the older one for its key only', async (t) => {
  const { engine, pty } = await engineWith(t)
  const { sessionId } = await engine.invoke('session.create', { name: 'big', cols: 120, rows: 40 })
  await push(
    engine,
    pty,
    sessionId,
    repeatLines(6000, (i) => `line ${i} needle some text here`)
  )

  const first = engine.invoke('session.searchBuffer', {
    sessionId,
    query: 'needle',
    searchKey: 'win-a',
    seq: 1
  })
  const other = engine.invoke('session.searchBuffer', {
    sessionId,
    query: 'needle',
    searchKey: 'win-b',
    seq: 1
  })
  const second = engine.invoke('session.searchBuffer', {
    sessionId,
    query: 'needle',
    searchKey: 'win-a',
    seq: 2
  })
  const stale = await engine.invoke('session.searchBuffer', {
    sessionId,
    query: 'needle',
    searchKey: 'win-a',
    seq: 1
  })
  t.alike(
    await first,
    { sessionId, count: 0, cancelled: true, gone: false },
    'seq 1 stopped at its first yield'
  )
  t.is(stale.cancelled, true, 'a request older than the newest is cancelled at once')
  const done = await second
  t.is(done.cancelled, false)
  t.ok(done.count >= 5000, `seq 2 counted the whole buffer (${done.count})`)
  t.is((await other).count, done.count, 'another window (searchKey) is not cancelled')
})

test('searchBuffer: interleaved searches each answer when their own session is done', async (t) => {
  const { engine, pty } = await engineWith(t)
  const big = await engine.invoke('session.create', { name: 'big', cols: 120, rows: 40 })
  const small = await engine.invoke('session.create', { name: 'small', cols: 120, rows: 40 })
  await push(
    engine,
    pty,
    big.sessionId,
    repeatLines(6000, (i) => `line ${i} needle`)
  )
  await push(engine, pty, small.sessionId, 'one needle\r\n')
  const order = []
  const a = engine
    .invoke('session.searchBuffer', {
      sessionId: big.sessionId,
      query: 'needle',
      searchKey: 'k',
      seq: 7
    })
    .then((r) => order.push('big') && r)
  const b = engine
    .invoke('session.searchBuffer', {
      sessionId: small.sessionId,
      query: 'needle',
      searchKey: 'k',
      seq: 7
    })
    .then((r) => order.push('small') && r)
  const [ra, rb] = await Promise.all([a, b])
  t.alike(order, ['small', 'big'], 'the small session answers first, though asked second')
  t.is(rb.count, 1)
  t.ok(ra.count >= 5000)
})

test('searchBuffer answers gone when the mirror is disposed or repainted between slices', async (t) => {
  const { engine, pty } = await engineWith(t)
  const { sessionId } = await engine.invoke('session.create', { name: 'big', cols: 120, rows: 40 })
  await push(
    engine,
    pty,
    sessionId,
    repeatLines(6000, (i) => `line ${i} needle`)
  )
  const runtime = engine.sessions.get(sessionId)

  // Repainted (a resync, an extend's restore): restore() bumps the generation.
  let scan = engine.invoke('session.searchBuffer', { sessionId, query: 'needle' })
  const restoring = runtime.mirror.restore({ cols: 120, rows: 40, data: 'repainted needle\r\n' })
  t.alike(
    await scan,
    { sessionId, count: 0, cancelled: false, gone: true },
    'repainted mid-scan: gone'
  )
  await restoring

  // Ended: the mirror is disposed (and the runtime dropped) between slices.
  await push(
    engine,
    pty,
    sessionId,
    repeatLines(6000, (i) => `again ${i} needle`)
  )
  scan = engine.invoke('session.searchBuffer', { sessionId, query: 'needle' })
  const old = runtime.mirror
  runtime.mirror = new TerminalFrame(120, 40, { scrollback: 10 })
  old.dispose()
  t.alike(
    await scan,
    { sessionId, count: 0, cancelled: false, gone: true },
    'disposed mid-scan: gone'
  )
})

test('searchBuffer follows rows that output trims away mid-scan', async (t) => {
  const { engine, pty } = await engineWith(t)
  const { sessionId } = await engine.invoke('session.create', { name: 'full', cols: 80, rows: 24 })
  // Fill the 5000-line scrollback, so every new line trims the oldest one.
  await push(
    engine,
    pty,
    sessionId,
    repeatLines(5100, (i) => (i % 2 === 0 ? `even ${i} needle` : `odd ${i}`))
  )
  const before = await engine.invoke('session.searchBuffer', { sessionId, query: 'needle' })
  // At the first yield (after 500 rows), 600 lines without the word arrive
  // and trim rows 0-599: the 100 rows not yet read (500-599, 50 matches) are
  // gone; the scan goes on at what was row 600, now row 0.
  const mirror = engine.sessions.get(sessionId).mirror
  const realSetImmediate = global.setImmediate
  let flooded = false
  global.setImmediate = (fn, ...args) => {
    if (!flooded) {
      flooded = true
      mirror.term._core.writeSync(repeatLines(600, (i) => `plain ${i}`))
    }
    return realSetImmediate(fn, ...args)
  }
  let during
  try {
    during = await engine.invoke('session.searchBuffer', { sessionId, query: 'needle' })
  } finally {
    global.setImmediate = realSetImmediate
  }
  t.ok(flooded, 'the output arrived mid-scan')
  t.is(during.gone, false)
  t.is(
    during.count,
    before.count - 50,
    `no line counted twice, none skipped but the trimmed (${before.count} before, ${during.count} during)`
  )
})

test('searchBuffer reads a joined session in the copy the viewer holds', async (t) => {
  t.timeout(120000)
  const pair = await sharedPair(t)
  const { host, viewer, hostPty, sessionId } = pair
  await pair.join()
  hostPty.push(
    sessionId,
    Buffer.from(repeatLines(50, (i) => (i % 5 === 0 ? `joined ${i} BEACON` : `x ${i}`)))
  )
  const answer = await untilAnswer(async () => {
    const r = await viewer.invoke('session.searchBuffer', {
      sessionId,
      query: 'beacon',
      searchKey: 'v',
      seq: 1
    })
    return r.count === 10 ? r : null
  })
  t.alike(
    answer,
    { sessionId, count: 10, cancelled: false, gone: false },
    'the viewer counts its remote.mirror'
  )
  t.ok(viewer.remoteSessions.get(sessionId).mirror, 'it is the joined copy (remote.mirror)')
  t.ok(!viewer.sessions.has(sessionId), 'the viewer has no runtime for it')
  const hostAnswer = await host.invoke('session.searchBuffer', { sessionId, query: 'beacon' })
  t.is(hostAnswer.count, 10, 'the host counts its own mirror the same')

  viewer.remoteSessions.get(sessionId).active = false
  t.is(
    (await viewer.invoke('session.searchBuffer', { sessionId, query: 'beacon' })).gone,
    true,
    'an ended join: gone'
  )
  viewer.remoteSessions.get(sessionId).active = true
})

test('timing: a full count of a 5000-line mirror', async (t) => {
  const frame = await frameWith(
    120,
    40,
    5000,
    repeatLines(
      6000,
      (i) =>
        `line ${i} some output text here with words foo bar baz ${i % 97 === 0 ? 'NEEDLE' : ''} \x1b[32mgreen\x1b[0m`
    )
  )
  const buffer = frame.term.buffer.active
  const reps = 20
  let started = process.hrtime.bigint()
  let count = 0
  for (let r = 0; r < reps; r++) count = scanBuffer(buffer, 'needle', { limit: 0 }).count
  const countMs = Number(process.hrtime.bigint() - started) / 1e6 / reps
  started = process.hrtime.bigint()
  for (let r = 0; r < reps; r++) scanBuffer(buffer, 'e', { limit: 50000 })
  const placeMs = Number(process.hrtime.bigint() - started) / 1e6 / reps
  t.comment(
    `node ${process.version}: ${buffer.length} lines, ${count} matches, count ${countMs.toFixed(2)} ms, 'e' with 50 000 positions ${placeMs.toFixed(2)} ms`
  )
  t.is(count, 52)
  frame.dispose()
})

// --- helpers -----------------------------------------------------------------

function repeatLines(n, line) {
  let out = ''
  for (let i = 0; i < n; i++) out += line(i) + '\r\n'
  return out
}

function mixedText() {
  return (
    repeatLines(30, (i) => `row ${i} needle Needle e`) +
    '漢字漢字漢字漢字漢字漢字 wrap-across the edge x \r\n' +
    'İstanbul İST x y\r\n' +
    '\x1b[31mNEEDLE\x1b[0m in red\r\n'
  )
}

async function frameWith(cols, rows, scrollback, text) {
  const frame = new TerminalFrame(cols, rows, { scrollback })
  await frame.write(text)
  return frame
}

function lastRowWith(buffer, text) {
  for (let y = buffer.length - 1; y >= 0; y--) {
    if (buffer.getLine(y).translateToString(true).includes(text)) return y
  }
  return -1
}

// The spawn half of test/share-flood.test.js's FakeHost, plus end().
class FakeHost extends EventEmitter {
  constructor() {
    super()
    this.terminals = new Map()
  }

  spawn(sessionId) {
    const terminal = { sessionId, paused: false, registered: true }
    this.terminals.set(sessionId, terminal)
    return {
      write: () => {},
      resize: () => {},
      pause: () => {
        terminal.paused = true
      },
      resume: () => {
        terminal.paused = false
      },
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
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-bufsearch-'))
  const pty = new FakeHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: pty })
  await engine.ready()
  engine.on('session:data', ({ sessionId, source, data }) => {
    if (source === 'pty') setImmediate(() => engine.ack(sessionId, data.byteLength))
  })
  t.teardown(async () => {
    await engine.close().catch(() => {})
    await fs.promises
      .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      .catch(() => {})
  })
  return { engine, pty }
}

// Through the PTY path, then until the mirror has written it.
async function push(engine, pty, sessionId, text) {
  const data = Buffer.from(text)
  for (let at = 0; at < data.length; at += 64 * 1024) {
    pty.push(sessionId, data.subarray(at, at + 64 * 1024))
  }
  const runtime = engine.sessions.get(sessionId)
  await until(() => runtime.mirrorPending.length === 0, 'the mirror caught up')
  await runtime.mirrorQueue
}

async function until(check, what, ms = 20000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function untilAnswer(probe, ms = 30000) {
  const deadline = Date.now() + ms
  for (;;) {
    const r = await probe()
    if (r) return r
    if (Date.now() > deadline) throw new Error('timed out waiting for an answer')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// test/share-flood.test.js's in-process pair on the loopback backend.
async function sharedPair(t) {
  const hub = new LoopbackHub()
  const pair = {}
  for (const role of ['host', 'viewer']) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `zbterm-bufsearch-${role}-`))
    const ptyHost = new FakeHost()
    const engine = new SessionEngine({
      userData: dir,
      ptyHost,
      shareBackend: new LoopbackBackend({ hub, routeKey: 'loop' })
    })
    await engine.ready()
    pair[role] = engine
    pair[role + 'Pty'] = ptyHost
    t.teardown(async () => {
      await engine.close().catch(() => {})
      await fs.promises
        .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        .catch(() => {})
    })
  }
  const created = await pair.host.invoke('session.create', { name: 'shared', cols: 100, rows: 30 })
  pair.sessionId = created.sessionId
  pair.host.on('session:data', ({ sessionId, source, data }) => {
    if (source === 'pty') setImmediate(() => pair.host.ack(sessionId, data.byteLength))
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
    await pair.viewer.invoke('share.join', { uri: link.uri })
    await joined
  }
  return pair
}
