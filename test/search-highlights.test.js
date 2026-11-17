// 261115_quit-pins-reorder R34-R36, U6: renderer/search-highlights.js keeps
// the in-session search's highlights as decorations tied to buffer lines.
// An @xterm/headless terminal gives the real buffer and markers; it has no
// renderer, so registerDecoration is a stand-in that ties each decoration to
// its marker the way xterm's DecorationService does. Headless refuses a
// marker on the alternate screen; the browser build (renderer/vendor/xterm)
// does not - CoreBrowserTerminal.registerMarker is
// `this.buffer.addMarker(this.buffer.ybase + this.buffer.y + offset)` on the
// active buffer - so registerMarker is that same line here.
const test = require('brittle')
const { Terminal } = require('@xterm/headless')
const { scanBuffer } = require('../engine/buffer-search')
const { createSearchHighlights, rowRuns } = require('../renderer/search-highlights')

function makeTerm(cols, rows, scrollback = 1000) {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  term.registerMarker = (offset = 0) => {
    const buffer = term._core.buffer
    return buffer.addMarker(buffer.ybase + buffer.y + offset)
  }
  term.registerDecoration = (options) => {
    if (options.marker.isDisposed) return undefined
    const listeners = []
    const decoration = {
      marker: options.marker,
      options,
      isDisposed: false,
      onRender: () => ({ dispose() {} }),
      onDispose: (fn) => listeners.push(fn),
      dispose() {
        if (this.isDisposed) return
        this.isDisposed = true
        for (const fn of listeners) fn()
      }
    }
    options.marker.onDispose(() => decoration.dispose())
    return decoration
  }
  return term
}

const write = (term, data) => new Promise((resolve) => term.write(data, resolve))

function highlighter(term, opts = {}) {
  return createSearchHighlights(term, {
    scan: scanBuffer,
    colors: () => ({ match: '#5c4a12', current: '#f3c969', currentFg: '#111316' }),
    ...opts
  })
}

function fullScan(term, hl, query) {
  const result = scanBuffer(term.buffer.active, query, { limit: 50000 })
  hl.setMatches(query, result.matches)
  return result
}

// The rows highlighted now, as { line: key }.
function drawnRows(hl) {
  const out = {}
  for (const d of hl.decorations()) {
    if (d.options.layer !== 'bottom') continue
    const line = d.marker.line
    out[line] = (out[line] ? out[line] + ',' : '') + `${d.options.x}:${d.options.width}`
  }
  return out
}

test('rowRuns merges touching matches and splits a match across a wrap', (t) => {
  const runs = rowRuns(
    [
      { row: 0, col: 2, len: 3 },
      { row: 0, col: 5, len: 2 },
      { row: 1, col: 8, len: 4 }
    ],
    10
  )
  t.is(runs.get(0).key, '2:5')
  t.is(runs.get(1).key, '8:2')
  t.is(runs.get(2).key, '0:2')
})

test('normal buffer: a scroll of the view registers and disposes nothing (R34)', async (t) => {
  const term = makeTerm(40, 10)
  let text = ''
  for (let i = 0; i < 60; i++) text += i % 3 === 0 ? `line ${i} FOOX here\r\n` : `line ${i}\r\n`
  await write(term, text)
  const hl = highlighter(term)
  fullScan(term, hl, 'FOOX')
  const before = hl.stats()
  t.is(before.rows, 20, 'every matching row highlighted, not only the visible ones')
  term.scrollLines(-30)
  hl.viewportMoved()
  term.scrollToTop()
  hl.viewportMoved()
  const after = hl.stats()
  t.is(after.registered, before.registered, 'nothing registered on scroll')
  t.is(after.disposed, before.disposed, 'nothing disposed on scroll')
  // The same scan again: nothing changes.
  fullScan(term, hl, 'FOOX')
  t.is(hl.stats().registered, before.registered, 'an unchanged rescan keeps every record')
  // New output with one new match: one more record, none disposed.
  await write(term, 'tail FOOX\r\n')
  hl.refreshLive()
  fullScan(term, hl, 'FOOX')
  const later = hl.stats()
  t.is(later.registered, before.registered + 1, 'one record for the new row')
  t.is(later.disposed, before.disposed, 'none disposed')
  hl.clear()
  t.is(hl.stats().rows, 0, 'clear leaves no record')
  t.is(hl.decorations().length, 0, 'and no decoration')
})

test('alternate screen: a scroll keeps the moved rows and adds the new one (R35)', async (t) => {
  const term = makeTerm(30, 8)
  await write(term, '\x1b[?1049h\x1b[H')
  t.is(term.buffer.active.type, 'alternate')
  // Rows 0..7: every other one holds the query.
  let screen = ''
  for (let i = 0; i < 8; i++) screen += `\x1b[${i + 1};1H${i % 2 ? `row ${i} QZ` : `row ${i}`}`
  await write(term, screen)
  const hl = highlighter(term)
  fullScan(term, hl, 'QZ')
  t.alike(Object.keys(drawnRows(hl)).map(Number), [1, 3, 5, 7])
  const before = hl.stats()
  // One line up (CSI S, as less/vim do), a new last line with a match.
  await write(term, '\x1b[1S\x1b[8;1Hnew QZ')
  hl.refreshLive()
  const rows = drawnRows(hl)
  t.alike(Object.keys(rows).map(Number), [0, 2, 4, 6, 7], 'the highlights moved with their text')
  for (const line of Object.keys(rows).map(Number)) {
    const text = term.buffer.active.getLine(line).translateToString(true)
    t.ok(text.includes('QZ'), `row ${line} holds the query`)
  }
  const after = hl.stats()
  t.is(after.registered - before.registered, 1, 'one record for the row scrolled in')
  t.is(after.disposed - before.disposed, 0, 'none disposed: the top row had no match')
  // A rewritten row loses its highlight in the same pass.
  await write(term, '\x1b[1;1H\x1b[2Kgone')
  hl.refreshLive()
  t.absent(drawnRows(hl)[0], 'the rewritten row is not highlighted')
})

test('alternate screen inside a scroll region: still right where xterm shifts in place', async (t) => {
  const term = makeTerm(30, 8)
  await write(term, '\x1b[?1049h\x1b[H')
  let screen = ''
  for (let i = 0; i < 8; i++) screen += `\x1b[${i + 1};1H${i % 2 ? `row ${i} QZ` : `row ${i}`}`
  await write(term, screen)
  const hl = highlighter(term)
  fullScan(term, hl, 'QZ')
  // A region from row 2 to 7 (vim's text area below a tab line), scrolled by
  // a line feed at its bottom.
  await write(term, '\x1b[2;7r\x1b[7;1H\n\x1b[7;1Hfresh QZ\x1b[r')
  hl.refreshLive()
  const rows = drawnRows(hl)
  for (const line of Object.keys(rows).map(Number)) {
    const text = term.buffer.active.getLine(line).translateToString(true)
    t.ok(text.includes('QZ'), `row ${line} holds the query`)
  }
  for (let line = 0; line < 8; line++) {
    const text = term.buffer.active.getLine(line).translateToString(true)
    if (text.includes('QZ')) t.ok(rows[line], `row ${line} with the query is highlighted`)
  }
})

test('the cap keeps at most maxRows rows, near the view, and re-chooses them (R36)', async (t) => {
  const term = makeTerm(20, 10, 5000)
  let text = ''
  for (let i = 0; i < 400; i++) text += `HX ${i}\r\n`
  await write(term, text)
  const hl = highlighter(term, { maxRows: 100, windowScreens: 3 })
  fullScan(term, hl, 'HX')
  const stats = hl.stats()
  t.ok(stats.rows <= 100, `capped: ${stats.rows} rows`)
  const buffer = term.buffer.active
  t.ok(stats.window[0] <= buffer.viewportY && stats.window[1] >= buffer.viewportY + 10)
  for (const line of Object.keys(drawnRows(hl)).map(Number)) {
    t.ok(line >= stats.window[0] && line < stats.window[1], `row ${line} inside the window`)
  }
  term.scrollToTop()
  hl.viewportMoved()
  const top = drawnRows(hl)
  t.ok(top[0] && top[5], 'the top rows highlighted after scrolling there')
  t.ok(hl.stats().rows <= 100, 'still capped')
})

test('a switch of screens: clear leaves nothing behind (U6)', async (t) => {
  const term = makeTerm(30, 8)
  await write(term, 'a QZ\r\nb QZ\r\n')
  const hl = highlighter(term)
  fullScan(term, hl, 'QZ')
  hl.setCurrent({ row: 0, col: 2, len: 2 })
  t.ok(hl.stats().rows > 0 && hl.stats().current === 0)
  hl.clear()
  t.is(hl.decorations().length, 0)
  t.is(hl.stats().current, null)
})

// Every highlighted row holds the query, and every row holding it (in rows
// [from, to)) is highlighted.
function checkRows(t, term, hl, query, from, to, label) {
  const rows = drawnRows(hl)
  const buffer = term.buffer.active
  let bad = 0
  for (const line of Object.keys(rows).map(Number)) {
    const text = buffer.getLine(line) ? buffer.getLine(line).translateToString(true) : ''
    if (!text.includes(query)) bad++
  }
  let missing = 0
  for (let line = from; line < to; line++) {
    const text = buffer.getLine(line).translateToString(true)
    if (text.includes(query) && !rows[line]) missing++
  }
  t.is(bad, 0, `${label}: no highlight on a row without the query`)
  t.is(missing, 0, `${label}: every row with the query highlighted`)
}

test('lines deleted and erased under the highlights leave none behind (xterm disposes the lines)', async (t) => {
  const term = makeTerm(30, 24)
  await write(term, '\x1b[?1049h\x1b[H')
  let screen = ''
  for (let i = 0; i < 24; i++) screen += `\x1b[${i + 1};1Hrow ${i} QZ`
  await write(term, screen)
  const hl = highlighter(term)
  fullScan(term, hl, 'QZ')
  t.is(hl.stats().rows, 24)
  // CSI M at row 9 (two lines deleted), then an erase below row 15.
  await write(term, '\x1b[9;1H\x1b[2M\x1b[15;1H\x1b[J')
  hl.refreshLive()
  checkRows(t, term, hl, 'QZ', 0, 24, 'after CSI M and ED')
  t.is(hl.stats().rows, 14, 'rows 0-13 still hold the query')
  t.is(hl.stats().trackers, hl.stats().rows, 'one tracker per alternate-screen record')
})

test('a flood through a full scrollback moves every record by the trim (one real marker)', async (t) => {
  const term = makeTerm(30, 10, 100)
  let text = ''
  for (let i = 0; i < 150; i++) text += i % 2 ? `f${i} QZ\r\n` : `f${i}\r\n`
  await write(term, text)
  const hl = highlighter(term)
  fullScan(term, hl, 'QZ')
  t.ok(hl.stats().anchored, 'a real marker measures the trim')
  for (let k = 0; k < 5; k++) {
    let more = ''
    for (let i = 0; i < 37; i++) more += i % 3 ? `g${k}-${i}\r\n` : `g${k}-${i} QZ\r\n`
    await write(term, more)
    hl.refreshLive()
  }
  const buffer = term.buffer.active
  checkRows(t, term, hl, 'QZ', 0, buffer.length, 'after 185 more lines')
  fullScan(term, hl, 'QZ')
  checkRows(t, term, hl, 'QZ', 0, buffer.length, 'after the next scan')
})

test('a cleared scrollback (CSI 3J) starts over and asks for a scan', async (t) => {
  const term = makeTerm(30, 10, 100)
  let text = ''
  for (let i = 0; i < 60; i++) text += `c${i} QZ\r\n`
  await write(term, text)
  let lost = 0
  const hl = highlighter(term, { onLost: () => lost++ })
  fullScan(term, hl, 'QZ')
  await write(term, '\x1b[3J')
  hl.refreshLive()
  t.is(lost, 1, 'onLost called once')
  checkRows(t, term, hl, 'QZ', 0, term.buffer.active.length, 'after CSI 3J')
})

test('back from the alternate screen the normal highlights return at once (U6)', async (t) => {
  const term = makeTerm(30, 8)
  let text = ''
  for (let i = 0; i < 40; i++) text += `n${i} QZ\r\n`
  await write(term, text)
  const hl = highlighter(term)
  term.buffer.onBufferChange(() => hl.bufferChanged())
  fullScan(term, hl, 'QZ')
  const normalRows = hl.stats().rows
  await write(term, '\x1b[?1049h\x1b[H\x1b[3;1Halt QZ')
  t.is(term.buffer.active.type, 'alternate')
  hl.refreshLive()
  t.alike(Object.keys(drawnRows(hl)).map(Number), [2], 'only the alternate screen row')
  await write(term, '\x1b[?1049l')
  t.is(term.buffer.active.type, 'normal')
  t.is(hl.stats().rows, normalRows, 'the normal rows drawn again in the switch itself')
  checkRows(t, term, hl, 'QZ', 0, term.buffer.active.length, 'back on the normal buffer')
})

test('alternate screen: a reverse index at the top (cells shifted in place) keeps the moved rows', async (t) => {
  const term = makeTerm(30, 8)
  await write(term, '\x1b[?1049h\x1b[H')
  let screen = ''
  for (let i = 0; i < 8; i++) screen += `\x1b[${i + 1};1H${i % 2 ? `row ${i} QZ` : `row ${i}`}`
  await write(term, screen)
  const hl = highlighter(term)
  fullScan(term, hl, 'QZ')
  hl.setCurrent({ row: 3, col: 6, len: 2 })
  const before = hl.stats()
  // less's "k": ESC M at row 1, then the new top line.
  await write(term, '\x1b[1;1H\x1bM\x1b[1;1Htop QZ')
  hl.refreshLive()
  checkRows(t, term, hl, 'QZ', 0, 8, 'after ESC M')
  const after = hl.stats()
  t.is(after.registered - before.registered, 1, 'one record for the new top row')
  t.is(after.disposed - before.disposed, 1, 'one for the row pushed off the bottom')
  t.is(after.current, 4, 'the current match went down with its text')
})
