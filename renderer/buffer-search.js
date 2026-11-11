// The buffer matcher of 261111_buffer-search: counts and places the matches of
// a plain-text query in an xterm buffer (`@xterm/xterm` or `@xterm/headless`,
// `term.buffer.active`/`.normal`/`.alternate`). Pure: it only reads the buffer.
// Two copies, byte for byte the same, are kept equal by
// test/buffer-search.test.js: engine/buffer-search.js (the engine's
// `session.searchBuffer`, required) and renderer/buffer-search.js (the
// renderer's in-session search, loaded as a plain script:
// window.zbtermScanBuffer). engine/ is published apart from renderer/, so
// neither can load the other's.
//
// - Soft-wrapped rows (`isWrapped`) are joined into one logical line, built
//   cell by cell, so a match across a wrap or after a wide (CJK, emoji)
//   character maps back to the cells it covers. A logical line belongs to the
//   call whose range holds its first row; a range that starts on a
//   continuation row skips it (the previous range read it), except at row 0,
//   where scrollback trimming can leave one.
// - Erased cells inside a line read as a space; those at the end of a logical
//   line are not text and are dropped. Written spaces are kept, so the query
//   is used as typed: "foo " does not match "foo" at a line's end.
// - Case-insensitive: each character is folded to lower case only when its
//   lower case has the same length (`İ` is kept as is), so string offsets in
//   the folded text are the cells' offsets. Non-overlapping occurrences.
// - An empty or all-whitespace query is refused: `{ count: 0, matches: [] }`.
//
// scanBuffer(buffer, query, { from, to, lines, limit }) reads the logical
// lines that start in rows [from, to) - at most `lines` of them - and returns
// { count, matches, next, lines }:
//   count    every match in those lines (exact, never capped);
//   matches  { row, col, len } of the newest `limit` of them, newest first
//            (`len` in cells from the first to the end of the last,
//            empty cells between included; a match across a wrap runs on
//            into the next row); `limit` 0 places none (a count only),
//            default 50 000;
//   next     the row to start the next call at (`>= to` when done);
//   lines    the logical lines read.
;(() => {
  const DEFAULT_LIMIT = 50000

  // Lower case, one character at a time, keeping each character's length.
  // toLowerCase() on the whole string is the same except for U+0130 (whose
  // lower case is two code units) and U+03A3 (final sigma depends on the
  // next character), so only strings holding one of them take the slow path.
  function foldText(text) {
    if (!/[İΣ]/.test(text)) return text.toLowerCase()
    let out = ''
    for (const ch of text) {
      const lower = ch.toLowerCase()
      out += lower.length === ch.length ? lower : ch
    }
    return out
  }

  // A wide character that did not fit at the end of a row leaves that row's
  // last cell empty and goes on at the start of the next (wrapped) row; that
  // cell is not text.
  function skipsLastCell(buffer, row, col, cols, end) {
    if (col !== cols - 1 || row + 1 >= end) return false
    const next = buffer.getLine(row + 1)
    if (!next || !next.isWrapped) return false
    const first = next.getCell(0)
    return !!first && first.getWidth() === 2
  }

  // One logical line from `start`: its text, and for each row the offset in
  // the text where the row begins. `next` is the first row after it.
  function readLogicalLine(buffer, start, end, cell) {
    let text = ''
    let pendingBlank = ''
    const rowStarts = []
    let row = start
    while (row < end) {
      const line = buffer.getLine(row)
      if (!line) break
      if (row > start && !line.isWrapped) break
      rowStarts.push(text.length + pendingBlank.length)
      const next = row + 1 < end ? buffer.getLine(row + 1) : null
      const wrapsOn = !!(next && next.isWrapped)
      const cols = line.length
      for (let col = 0; col < cols; col++) {
        line.getCell(col, cell)
        const width = cell.getWidth()
        if (width === 0) continue
        const chars = cell.getChars()
        if (chars === '') {
          if (wrapsOn && skipsLastCell(buffer, row, col, cols, end)) continue
          pendingBlank += ' '
          continue
        }
        if (pendingBlank) {
          text += pendingBlank
          pendingBlank = ''
        }
        text += chars
      }
      // Blank cells at the end of a row that wraps on are text (the row was
      // full); only those at the end of the logical line are dropped.
      if (wrapsOn && pendingBlank) {
        text += pendingBlank
        pendingBlank = ''
      }
      row++
    }
    return { text, rowStarts, next: row }
  }

  // The (row, col) of a string offset in a logical line read from `start`,
  // and the cell after the code unit at that offset.
  function cellAt(buffer, start, rowStarts, offset, cell) {
    const total = buffer.length
    let r = rowStarts.length - 1
    while (r > 0 && rowStarts[r] > offset) r--
    const row = start + r
    const line = buffer.getLine(row)
    let at = rowStarts[r]
    const cols = line.length
    for (let col = 0; col < cols; col++) {
      line.getCell(col, cell)
      const width = cell.getWidth()
      if (width === 0) continue
      const chars = cell.getChars()
      if (chars === '' && skipsLastCell(buffer, row, col, cols, total)) continue
      const size = chars === '' ? 1 : chars.length
      if (offset < at + size) return { row, col, end: col + width }
      at += size
    }
    return { row, col: cols - 1, end: cols }
  }

  function scanBuffer(buffer, query, opts = {}) {
    const empty = { count: 0, matches: [], next: Infinity, lines: 0 }
    if (typeof query !== 'string' || query.trim() === '' || !buffer) return empty
    const total = buffer.length
    const to = Math.min(Number.isFinite(opts.to) ? opts.to : total, total)
    let row = Math.max(0, Number.isFinite(opts.from) ? opts.from : 0)
    const maxLines = Number.isFinite(opts.lines) && opts.lines > 0 ? opts.lines : Infinity
    const limit = Number.isFinite(opts.limit) ? Math.max(0, opts.limit) : DEFAULT_LIMIT
    const needle = foldText(query)
    const cell = buffer.getNullCell()
    let count = 0
    let lines = 0
    let matches = []

    if (row > 0) {
      while (row < to) {
        const line = buffer.getLine(row)
        if (!line || !line.isWrapped) break
        row++
      }
    }
    while (row < to && lines < maxLines) {
      const start = row
      const logical = readLogicalLine(buffer, start, total, cell)
      row = Math.max(logical.next, start + 1)
      lines++
      if (logical.text.length < needle.length) continue
      const hay = foldText(logical.text)
      let at = hay.indexOf(needle)
      while (at !== -1) {
        count++
        if (limit > 0) {
          const first = cellAt(buffer, start, logical.rowStarts, at, cell)
          const last = cellAt(buffer, start, logical.rowStarts, at + needle.length - 1, cell)
          const cols = buffer.getLine(first.row).length
          matches.push({
            row: first.row,
            col: first.col,
            len: (last.row - first.row) * cols + last.end - first.col
          })
          // Keep the newest `limit`, trimming in batches.
          if (matches.length >= limit * 2) matches = matches.slice(matches.length - limit)
        }
        at = hay.indexOf(needle, at + needle.length)
      }
    }
    if (matches.length > limit) matches = matches.slice(matches.length - limit)
    matches.reverse()
    return { count, matches, next: row, lines }
  }

  const api = { scanBuffer, foldText, DEFAULT_LIMIT }
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api
  }
  if (typeof window === 'object' && window) {
    window.zbtermScanBuffer = scanBuffer
  }
})()
