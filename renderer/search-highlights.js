// The in-session search's highlights (261115_quit-pins-reorder R34-R36, U6;
// design--search-highlights.md): xterm decorations kept while the view
// scrolls and changed only where the rows' matches change. Loaded as a plain
// script (window.zbtermSearchHighlights), required by
// test/search-highlights.test.js.
//
// One record per highlighted row: { marker, key, decorations, tracker }.
// `key` is the row's runs ("x:w,x:w"): the matches touching on a row merged
// into one run, a match across a wrap split per row.
//
// The decorations hang on markers this file owns, not on xterm's: xterm
// 6.0.0's Marker.dispose() sets `line` to -1 before it fires onDispose, so
// the DecorationService looks the decoration up under -1 in its list sorted
// by line and, unless it happens to sit first, leaves it behind and breaks
// the lookups of the others (ED, CSI M/L, a screen switch, a reflow dispose
// markers). An owned marker keeps its line until its decorations are gone.
// Its line is moved here, the way xterm moves its own:
// - normal buffer: every record by the same amount, the rows trimmed off the
//   scrollback, measured by one real marker on a scrollback row (the
//   DecorationService's list relies on uniform shifts, as xterm's own do);
// - alternate screen: each record follows a real marker of its own (at most
//   one per screen row), so a line that a program scrolls keeps its record;
//   a record whose real marker xterm disposed goes first, then the others
//   take their real markers' lines (order kept).
// A diff keeps a record only when its line wants exactly its runs, so where
// xterm shifts cells in place (a scroll region not starting at row 0) the
// rows are simply redone. Disposals all come before registrations
// (SortedList flushes pending deletes on insert and back).
//
// createSearchHighlights(term, { scan, colors, maxRows, windowScreens, onLost }):
//   scan(buffer, query, { from, to, limit })  the shared matcher (buffer-search.js)
//   colors()  { match, current, currentFg } as #rrggbb
//   onLost()  the trim measure was lost (scrollback cleared): re-scan
//   setMatches(query, matches)  after a full scan (matches: { row, col, len })
//   refreshLive()    after a write: the rows output reached since the last one
//   viewportMoved()  on scroll: nothing unless capped (more than maxRows rows)
//   bufferChanged()  on a screen switch (U6)
//   resized()        after a resize (reflow moved the rows)
//   setCurrent(match | null), clear(), recolor(), stats(), drawn(top, rows)
;(() => {
  const LIVE_LIMIT = 200000
  let nextMarkerId = 1000000000

  // The runs of `matches` per row: Map<row, { key, runs: [{ x, width }] }>.
  // `shift` moves every match by the rows trimmed since the scan.
  function rowRuns(matches, cols, shift = 0, length = Infinity) {
    const pieces = new Map()
    for (const match of matches) {
      let left = match.len
      let x = match.col
      for (let r = match.row + shift; left > 0; r++) {
        const width = Math.min(left, cols - x)
        if (width <= 0) break
        if (r >= 0 && r < length) {
          if (!pieces.has(r)) pieces.set(r, [])
          pieces.get(r).push({ x, width })
        }
        left -= width
        x = 0
      }
    }
    const out = new Map()
    for (const [row, list] of pieces) {
      list.sort((a, b) => a.x - b.x)
      const runs = []
      for (const piece of list) {
        const last = runs[runs.length - 1]
        if (last && piece.x <= last.x + last.width) {
          last.width = Math.max(last.width, piece.x + piece.width - last.x)
        } else {
          runs.push({ ...piece })
        }
      }
      out.set(row, { key: runs.map((run) => `${run.x}:${run.width}`).join(','), runs })
    }
    return out
  }

  // An IMarker of our own: what registerDecoration reads (line, isDisposed,
  // onDispose) and nothing that xterm moves.
  function ownMarker(line) {
    const listeners = new Set()
    const marker = {
      id: nextMarkerId++,
      line,
      isDisposed: false,
      onDispose(fn) {
        listeners.add(fn)
        return { dispose: () => listeners.delete(fn) }
      },
      dispose() {
        if (marker.isDisposed) return
        marker.isDisposed = true
        for (const fn of Array.from(listeners)) {
          try {
            fn()
          } catch {}
        }
        listeners.clear()
      }
    }
    return marker
  }

  function disposeQuietly(item) {
    try {
      if (item && !item.isDisposed) item.dispose()
    } catch {}
  }

  function createSearchHighlights(term, options = {}) {
    const scan = options.scan
    const colors = options.colors || (() => ({}))
    const onLost = options.onLost || (() => {})
    const maxRows = options.maxRows || 2000
    const windowScreens = options.windowScreens || 3
    const records = new Set()
    const counts = { registered: 0, disposed: 0 }
    let query = ''
    // The last full scan of the screen on show: { type, cols, matches,
    // offset (rows trimmed since) }; the normal buffer's is kept while the
    // alternate screen shows (normalStored).
    let stored = null
    let normalStored = null
    let windowRange = null
    // The normal buffer's trim measure: a real marker on a scrollback row.
    let anchor = null
    let anchorRow = 0
    // The first row output could reach since the last refresh.
    let liveFrom = 0
    // The current match: { match, parts: [{ marker, tracker, decorations }] }.
    let current = null

    const active = () => term.buffer.active
    const isAlt = () => active().type === 'alternate'
    const liveTop = () => (isAlt() ? 0 : active().baseY)

    function realMarker(row) {
      const buffer = active()
      try {
        const marker = term.registerMarker(row - (buffer.baseY + buffer.cursorY))
        return marker && !marker.isDisposed && marker.line === row ? marker : null
      } catch {
        return null
      }
    }

    function dropRecord(record) {
      if (!records.delete(record)) return
      counts.disposed++
      for (const decoration of record.decorations) disposeQuietly(decoration)
      disposeQuietly(record.marker)
      disposeQuietly(record.tracker)
    }

    function dropCurrent() {
      if (!current) return
      for (const part of current.parts) {
        for (const decoration of part.decorations) disposeQuietly(decoration)
        disposeQuietly(part.marker)
        disposeQuietly(part.tracker)
      }
      current = null
    }

    function dropAll() {
      dropCurrent()
      for (const record of Array.from(records)) dropRecord(record)
    }

    function dropAnchor() {
      disposeQuietly(anchor)
      anchor = null
    }

    function setAnchor() {
      dropAnchor()
      const buffer = active()
      if (buffer.type !== 'normal' || buffer.baseY <= 0) return
      anchorRow = buffer.baseY - 1
      anchor = realMarker(anchorRow)
    }

    // Records' lines brought up to date with the buffer. Returns the rows
    // trimmed (normal buffer), or null when that measure was lost.
    function follow() {
      if (isAlt()) {
        const parts = current ? current.parts : []
        let lostCurrent = false
        for (const record of Array.from(records)) {
          if (!record.tracker || record.tracker.isDisposed) dropRecord(record)
        }
        for (const part of parts) if (!part.tracker || part.tracker.isDisposed) lostCurrent = true
        if (lostCurrent) dropCurrent()
        for (const record of records) record.marker.line = record.tracker.line
        if (current) for (const part of current.parts) part.marker.line = part.tracker.line
        followText()
        followCurrentText()
        return 0
      }
      if (!anchor) {
        setAnchor()
        return 0
      }
      if (anchor.isDisposed) return null
      const shift = anchor.line - anchorRow
      if (shift) {
        for (const record of records) record.marker.line += shift
        if (current) for (const part of current.parts) part.marker.line += shift
        for (const record of Array.from(records)) if (record.marker.line < 0) dropRecord(record)
        if (current && current.parts.some((part) => part.marker.line < 0)) dropCurrent()
        if (stored) stored.offset += shift
        liveFrom = Math.max(0, liveFrom + shift)
      }
      setAnchor()
      return shift
    }

    function rowText(row) {
      const line = active().getLine(row)
      return line ? line.translateToString(true) : null
    }

    // Alternate screen: where xterm moved a line's cells but not its marker
    // (a reverse index at the region's top, a scroll inside a region below
    // row 0: shiftElements), the record follows its text to the row it went
    // to, the nearest one; a record whose text is gone is dropped. The new
    // lines must keep the records' order (the DecorationService's list is
    // sorted by line), else those records are left to the diff.
    function followText() {
      const sorted = Array.from(records).sort((a, b) => a.marker.line - b.marker.line)
      const rows = term.rows
      const texts = new Map()
      const textAt = (row) => {
        if (!texts.has(row)) texts.set(row, rowText(row))
        return texts.get(row)
      }
      const moves = new Map()
      const claimed = new Set()
      for (const record of sorted) {
        const line = record.marker.line
        if (textAt(line) === record.text) {
          claimed.add(line)
          continue
        }
        moves.set(record, null)
      }
      for (const record of moves.keys()) {
        const line = record.marker.line
        for (let d = 1; d < rows; d++) {
          const hit = [line - d, line + d].find(
            (row) => row >= 0 && row < rows && !claimed.has(row) && textAt(row) === record.text
          )
          if (hit !== undefined) {
            moves.set(record, hit)
            claimed.add(hit)
            break
          }
        }
      }
      if (!moves.size) return
      // Gone first (keys unchanged), then the order check, then the moves.
      for (const [record, to] of moves) if (to === null) dropRecord(record)
      let last = -1
      let ordered = true
      for (const record of sorted) {
        if (!records.has(record)) continue
        const to = moves.has(record) ? moves.get(record) : record.marker.line
        if (to <= last) ordered = false
        last = to
      }
      if (!ordered) return
      for (const [record, to] of moves) {
        if (to === null || !records.has(record)) continue
        const tracker = realMarker(to)
        if (!tracker) {
          dropRecord(record)
          continue
        }
        disposeQuietly(record.tracker)
        record.tracker = tracker
        record.marker.line = to
      }
    }

    // The current match on the alternate screen follows its row's text the
    // same way: placed again (a fresh registration keeps the list sorted).
    function followCurrentText() {
      if (!current || !current.parts.length) return
      const part = current.parts[0]
      if (typeof part.text !== 'string' || rowText(part.marker.line) === part.text) return
      for (let d = 1; d < term.rows; d++) {
        const hit = [part.marker.line - d, part.marker.line + d].find(
          (row) => row >= 0 && row < term.rows && rowText(row) === part.text
        )
        if (hit !== undefined) {
          setCurrent({ ...current.match, row: hit })
          return
        }
      }
      dropCurrent()
    }

    function addRecord(row, want, palette) {
      const tracker = isAlt() ? realMarker(row) : null
      if (isAlt() && !tracker) return
      const marker = ownMarker(row)
      const record = { marker, key: want.key, decorations: [], runs: [], tracker }
      if (tracker) record.text = rowText(row)
      for (const run of want.runs) {
        const decoration = term.registerDecoration({
          marker,
          x: run.x,
          width: run.width,
          backgroundColor: palette.match,
          layer: 'bottom'
        })
        if (!decoration) continue
        record.decorations.push(decoration)
        record.runs.push(run)
      }
      if (!record.decorations.length) {
        disposeQuietly(marker)
        disposeQuietly(tracker)
        return
      }
      records.add(record)
      counts.registered++
    }

    // Rows [from, to) to look as `desired` (Map<row, { key, runs }>) says.
    function diff(from, to, desired) {
      const kept = new Set()
      for (const record of Array.from(records)) {
        const line = record.marker.line
        if (line < from || line >= to) continue
        const want = desired.get(line)
        if (want && want.key === record.key && !kept.has(line)) kept.add(line)
        else dropRecord(record)
      }
      let palette = null
      for (const [row, want] of desired) {
        if (row < from || row >= to || kept.has(row)) continue
        palette = palette || colors()
        addRecord(row, want, palette)
      }
    }

    function inWindow(row) {
      return !windowRange || (row >= windowRange[0] && row < windowRange[1])
    }

    // The stored scan over the rows output can no longer reach (the normal
    // buffer's scrollback): all its rows, or, past maxRows, those within
    // windowScreens screens of the view (R36).
    function applyStored() {
      windowRange = null
      if (!stored || stored.type !== 'normal' || isAlt()) return
      const buffer = active()
      const all = rowRuns(stored.matches, term.cols, stored.offset, buffer.length)
      if (all.size > maxRows) {
        const top = buffer.viewportY
        windowRange = [
          Math.max(0, top - windowScreens * term.rows),
          Math.min(buffer.length, top + (windowScreens + 1) * term.rows)
        ]
      }
      const until = Math.min(liveTop(), buffer.length)
      const desired = new Map()
      for (const [row, want] of all) if (row < until && inWindow(row)) desired.set(row, want)
      diff(0, until, desired)
    }

    // The rows output reached since the last refresh, and the screen.
    function scanLive() {
      if (!query || !scan) return
      const buffer = active()
      let from = Math.min(liveFrom, liveTop())
      while (from > 0) {
        const line = buffer.getLine(from)
        if (!line || !line.isWrapped) break
        from--
      }
      const to = Math.min(buffer.length, buffer.baseY + term.rows)
      const result = scan(buffer, query, { from, to, limit: LIVE_LIMIT })
      const all = rowRuns(result.matches || [], term.cols, 0, buffer.length)
      const desired = new Map()
      for (const [row, want] of all) if (inWindow(row)) desired.set(row, want)
      diff(from, to, desired)
      liveFrom = liveTop()
      if (current && !currentStillThere(desired, from, to)) dropCurrent()
    }

    function currentStillThere(desired, from, to) {
      const part = current.parts[0]
      if (!part || part.marker.isDisposed) return false
      const row = part.marker.line
      if (row < from || row >= to) return true
      const want = desired.get(row)
      const x = current.match.col
      return !!(want && want.runs.some((run) => run.x <= x && x < run.x + run.width))
    }

    function refreshLive() {
      if (!query) return
      if (follow() === null) {
        lost()
        return
      }
      scanLive()
    }

    // The trim measure is gone (scrollback cleared): start over.
    function lost() {
      dropAll()
      dropAnchor()
      stored = null
      windowRange = null
      liveFrom = 0
      setAnchor()
      scanLive()
      onLost()
    }

    function setMatches(text, matches) {
      query = text || ''
      if (!query) {
        clear()
        return
      }
      if (follow() === null) {
        lost()
        return
      }
      const buffer = active()
      stored = { type: buffer.type, cols: term.cols, matches: matches || [], offset: 0 }
      if (buffer.type === 'normal') normalStored = null
      applyStored()
      // The scan read the screen too, but output may have changed it since a
      // slice read it: the screen is read again now; the scrollback was done.
      liveFrom = liveTop()
      scanLive()
    }

    function viewportMoved() {
      if (!windowRange || !stored) return
      const buffer = active()
      const top = buffer.viewportY
      const [from, to] = windowRange
      const nearTop = from > 0 && top - from < term.rows
      const nearBottom = to < buffer.length && to - (top + term.rows) < term.rows
      if (!nearTop && !nearBottom) return
      if (follow() === null) {
        lost()
        return
      }
      applyStored()
      scanLive()
    }

    // U6: nothing of one screen on the other. The normal buffer's scan is
    // kept while the alternate screen shows, and drawn again on the way back.
    function bufferChanged() {
      dropAll()
      dropAnchor()
      windowRange = null
      liveFrom = 0
      if (isAlt()) {
        if (stored && stored.type === 'normal') normalStored = stored
        stored = null
      } else {
        stored = normalStored && normalStored.cols === term.cols ? normalStored : null
        normalStored = null
      }
      if (!query) return
      setAnchor()
      applyStored()
      scanLive()
    }

    // A reflow moved the rows: the screen again now, the rest at the scan.
    function resized() {
      dropAll()
      dropAnchor()
      stored = null
      normalStored = null
      windowRange = null
      liveFrom = liveTop()
      if (!query) return
      setAnchor()
      scanLive()
    }

    // The current match (rows as now) on the top layer, one piece per row.
    function setCurrent(match) {
      dropCurrent()
      if (!match || !query) return
      if (!isAlt()) follow()
      const palette = colors()
      const parts = []
      const pieces = rowRuns([match], term.cols, 0, active().length)
      for (const [row, want] of Array.from(pieces).sort((a, b) => a[0] - b[0])) {
        const tracker = isAlt() ? realMarker(row) : null
        if (isAlt() && !tracker) continue
        const marker = ownMarker(row)
        const part = { marker, tracker, decorations: [], runs: [] }
        if (tracker) part.text = rowText(row)
        for (const run of want.runs) {
          const decoration = term.registerDecoration({
            marker,
            x: run.x,
            width: run.width,
            backgroundColor: palette.current,
            foregroundColor: palette.currentFg,
            layer: 'top'
          })
          if (!decoration) continue
          part.decorations.push(decoration)
          part.runs.push(run)
        }
        parts.push(part)
      }
      current = parts.length ? { match, parts } : null
    }

    function clear() {
      dropAll()
      dropAnchor()
      stored = null
      normalStored = null
      windowRange = null
      liveFrom = 0
      query = ''
    }

    // A theme change: the colours are in the decorations, so they are made
    // again.
    function recolor() {
      if (!query) return
      const was = current ? { ...current.match, row: current.parts[0].marker.line } : null
      dropAll()
      if (follow() === null) {
        lost()
        return
      }
      applyStored()
      liveFrom = 0
      scanLive()
      if (was) setCurrent(was)
    }

    // What is registered in viewport rows [top, top + rows), for the debug
    // server: on the alternate screen xterm hides the decorations' elements
    // (the renderer paints the cells), so this is read from the records.
    function drawn(top, rows) {
      const out = []
      const add = (item, layer) => {
        const row = item.marker.line - top
        if (row < 0 || row >= rows) return
        item.decorations.forEach((decoration, i) => {
          if (decoration.isDisposed) return
          out.push({ row, col: item.runs[i].x, width: item.runs[i].width, layer })
        })
      }
      for (const record of records) add(record, 'bottom')
      if (current) for (const part of current.parts) add(part, 'top')
      return out.sort((a, b) => a.row - b.row || a.col - b.col)
    }

    function decorations() {
      const out = []
      for (const record of records) out.push(...record.decorations)
      if (current) for (const part of current.parts) out.push(...part.decorations)
      return out
    }

    function stats() {
      let count = 0
      for (const record of records) count += record.decorations.length
      return {
        rows: records.size,
        decorations: count,
        registered: counts.registered,
        disposed: counts.disposed,
        window: windowRange ? windowRange.slice() : null,
        current: current && current.parts.length ? current.parts[0].marker.line : null,
        trackers: Array.from(records).filter((r) => r.tracker).length,
        anchored: !!anchor
      }
    }

    return {
      setMatches,
      refreshLive,
      viewportMoved,
      bufferChanged,
      resized,
      setCurrent,
      clear,
      recolor,
      drawn,
      decorations,
      stats,
      get query() {
        return query
      }
    }
  }

  const api = { createSearchHighlights, rowRuns, ownMarker }
  if (typeof module === 'object' && module.exports) module.exports = api
  if (typeof window === 'object') window.zbtermSearchHighlights = api
})()
