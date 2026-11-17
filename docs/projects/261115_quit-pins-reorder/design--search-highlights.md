# In-session search highlights on xterm decorations — design (R34–R36, U6)

**Written:** 2026-11-16 (revised the same day after Fable's review, below) · **Requirements:** `goal_requirements.md` R34–R36, U6 · **Stack:** `@xterm/xterm`
6.0.0 + `@xterm/addon-webgl` 0.19.0 (vendored by `scripts/vendor-assets.js`)

## What is wrong today

`renderer/app.js` (`drawSearchDecorations`, `drawSearchOverlay`, `scheduleSearchDecorations`):

- Decorations exist only for the rows on screen. Every scroll (and every scan) disposes all of them and
  registers new ones a frame + up to 100 ms later: highlights lag and jump while scrolling.
- On the alternate screen the highlights are not decorations at all but absolutely placed `<div>`s in
  a layer inside xterm's `.xterm-screen` (private DOM), sized in percent of the grid. They are redrawn
  only on scan (300 ms after output), so when vim/less scroll, the boxes stay on the old cells.
- A resize redraws but does not re-scan (wrapped rows move); a theme change does not redraw; a
  switch of screens leaves the old highlights up to 300 ms.

The comment that motivated the overlay ("xterm draws no decorations on the alternate screen:
registerDecoration answers undefined there") is wrong for 6.0.0: the typings still say so, but
`DecorationService.registerDecoration` refuses only a disposed marker, and `registerMarker` adds the
marker to the *active* buffer (`CoreBrowserTerminal.registerMarker` → `this.buffer.addMarker`). The
WebGL `CellColorResolver` applies bottom-layer then top-layer decoration colours per cell, for any
buffer (the alternate buffer's `ydisp` is 0, so marker lines are screen rows).

## The dependency question

The user allowed a new dependency (`@xterm/addon-search`). Not taken:

- It brings its own matcher (regex/case/whole-word options, no wide-character or soft-wrap mapping
  like `buffer-search.js`). The session list's "N matches" counts come from the engine's copy of
  `buffer-search.js`; highlights from another matcher would disagree with them (case folding of `İ`,
  wide characters, matches across a wrap).
- It re-searches the whole buffer on every change and caps highlights at 1000, and it draws with the
  same `registerMarker` + `registerDecoration` API used below. The integration it would give is the
  one this design uses directly, without a second matcher.

No patch to xterm is needed: every hook used is public API (`registerMarker`, `registerDecoration`,
`IMarker.onDispose`, `onWriteParsed`, `buffer.onBufferChange`, `onScroll`, `onResize`).

## Design

A new plain script, `renderer/search-highlights.js` (`window.zbtermSearchHighlights`, also
`module.exports` for unit tests), owns the highlights of one terminal:

```
const hl = createSearchHighlights(term, { scan, colors, maxRows: 2000, windowScreens: 3 })
hl.setMatches(query, matches)   // after a full scan: diff the whole buffer
hl.refreshLive()                // after a write: re-scan the live rows, diff them only
hl.viewportMoved()              // on scroll: nothing, unless capped (R36)
hl.setCurrent(match | null)     // the current match: its own top-layer decoration
hl.clear()                      // dispose everything (buffer switch, query cleared, reset)
hl.recolor()                    // theme change: clear + redraw from the stored matches
hl.stats()                      // { rows, decorations, registered, disposed, window } for debug
```

### Records: one marker per highlighted row (see Review 1: owned markers)

`records`: a `Set` of `{ marker, key, decorations[] }`. `key` is the row's runs, `"x:w,x:w…"` (the
matches touching on a row merged into one run, a match across a wrap split per row, as
`searchHighlightRuns` does today). One marker per row, shared by its runs' decorations (fewer
listeners on xterm's `CircularList` events than one marker per match). `marker.onDispose` (xterm
disposes a marker whose line is trimmed from the scrollback or deleted by `CSI M`) removes the record
and its decorations: memory follows the buffer by itself.

The current match is not part of `key`: every match is in the plain (bottom-layer) runs; the current
one has one more decoration on `layer: 'top'` with its own marker and colours, which the renderer
paints over the plain one. Stepping with Enter moves only that decoration.

### The diff

`diff(from, to, desired)` — `desired`: `Map<row, key>` for rows in `[from, to)`:

1. Index the records whose `marker.line` is in `[from, to)` by line (a disposed marker's record is
   already gone).
2. For each record: `desired.get(line) === record.key` → keep it; otherwise dispose it.
3. For each desired row with no kept record: register a marker at that row
   (`registerMarker(row − (baseY + cursorY))`) and one decoration per run.

Records outside `[from, to)` are not touched. Correctness never depends on where xterm moves markers:
a record is kept only when its marker's *current* line wants exactly its runs. When xterm moves lines
with their markers (`lines.splice` in `CSI L`/`CSI M`/`CSI S`/`CSI T`, and `onTrim` when a full-height
region scrolls), a scrolled highlight is kept; where it shifts cells in place instead
(`BufferService.scroll` with a scroll region whose top is not row 0: `shiftElements`), the markers stay
and the diff replaces those rows — still correct, only more work.

### When it runs

- **Full scan** (as today: 300 ms live / 150 ms playback after output, a session switch, a step after
  a change): `setMatches` diffs `[0, buffer.length)` against the scan's matches. Most rows keep their
  records; nothing is disposed and re-registered for rows that did not change.
- **After each write** (`onWriteParsed`, synchronously, so before xterm's next render frame):
  `refreshLive` scans the live rows with the shared matcher (`scanBuffer(buffer, query, { from, to })`)
  and diffs them. Live rows: the alternate screen's `[0, rows)`; the normal buffer's
  `[baseY, baseY + rows)`, widened up to the start of a logical line that wraps into it. Only rows the
  program can still change are read (≈ rows × cols cells, well under a millisecond), so text that
  scrolls in gets its highlights in the same frame, and highlights on text that changed are gone in
  the same frame (R35). Rows above `baseY` in the normal buffer are scrollback: they do not change, and
  their records stay until the scan or a trim drops them.
- **Scroll of the view** (`onScroll`): nothing, unless the match rows exceed the cap (below). This is
  the fix for the lag: the highlights already live on every matched row.
- **Resize** (`onResize`): marks the search dirty and re-scans (reflow moves wrapped rows), then
  `setMatches` diffs.
- **Screen switch** (`buffer.onBufferChange`): `clear()` in the event itself (U6: xterm fires it while
  parsing the switch sequence, before the next render), then the re-scan of the new screen.
- **Theme change** (`applyTheme`): `recolor()`.
- **Query cleared / session switch / terminal disposed**: `clear()`.

### Bound (R36)

When the scan's matches cover more than `maxRows` (2000) rows, `desired` holds only the rows within
`windowScreens` (3) screens above and below the view (`[viewportY − 3·rows, viewportY + 4·rows)`), and
`setMatches` records that window. `viewportMoved` (on scroll) re-runs the diff from the stored matches
when the view comes within one screen of the window's edge; between scans the stored rows are moved
by the rows trimmed since the scan, measured with a marker placed at the cursor row at scan time
(never the first to be trimmed). The diff disposes the records that fell out of the new window, so at
most ~2000 + 7 screens of records exist. Under the cap (the usual case) a scroll does nothing.

### What goes away

`drawSearchDecorations`, `drawSearchOverlay`, `searchOverlayLayer`, `scheduleSearchDecorations`,
`SEARCH_DECORATIONS_MIN_MS`, `state.searchDecoration*`, the `.search-overlay`/`.search-mark` CSS and
the overlay's static test line. `bs.decorations` is replaced by the highlighter; `markerAtRow` stays
for the current match's place and the sliced scan. The debug `in-session` state keeps `decorations`
and `drawn` (read off the decorations' elements, which xterm makes for every decoration in the
viewport, on both screens) and adds `highlights: hl.stats()`.

`261111_buffer-search/acceptance/R2_in_session_matches.sh` checks the alternate screen through
`.search-mark.current`; it changes to the current decoration's element (the top-layer one, class
`search-current-highlight` via `IDecoration.element` once rendered), with a dated note.

## Checks

- `test/search-highlights.test.js` (unit, `@xterm/headless` + a fake `registerDecoration` that tracks
  its marker): a scroll registers nothing; a new scan with one changed row re-registers one record;
  `CSI S` on a 24-row alt-style buffer keeps the moved rows' records and adds one for the row scrolled
  in; a deleted line's record is gone; the cap keeps ≤ 2000 rows inside the window and re-chooses it
  near the edge; `clear` leaves zero records.
- `acceptance/R34_search_highlights.sh` (packaged app, `uisolate`): normal buffer, matches over several
  screens: Shift+PgUp ×N and wheel leave `registered`/`disposed` unchanged and every drawn highlight
  on a row whose text holds the query; `less` on a file: after `j` and `k` (sent to the PTY), within
  150 ms, `registered` grew by at most the rows scrolled in and every drawn highlight sits on the
  query's cells; `q` back to the shell: no drawn highlight on a row without the query; 6000 matching
  rows: `rows ≤ 2000`, the view's rows highlighted, scrolled to the top: the top rows highlighted;
  a window resize: the drawn highlights still on the query's cells.

## Review (Fable, 2026-11-16) and what changed

Fable checked the design against the xterm 6.0.0 sources and with scripts on the installed bundles.
Held: decorations and markers work on the alternate screen (WebGL resolves `y + ydisp`, bottom then
top layer); `onBufferChange` fires inside the switch (and on reset); synchronous work in
`onWriteParsed` lands before the next frame (rendering is debounced to an animation frame), with no
refresh storm; rejecting `@xterm/addon-search` is right. Found, and taken:

1. **Blocker — xterm-disposed markers leak decorations.** `Marker.dispose()` sets `line = -1` before
   firing `onDispose` (`common/buffer/Marker.ts:30-33`); the `DecorationService` then deletes the
   decoration from its list sorted by line under key -1 (`SortedList.ts:76-91`) and misses unless it
   sits first: the decoration stays, and the lookups of others break. ED/EL resets, `CSI M`/`L`,
   leaving the alternate screen, reflow and `CSI 3J` all dispose markers. Measured: 24 decorated
   alternate rows, `CSI 9;1H CSI M` → one leaked entry and rows 6–7 no longer found. **Change:** the
   decorations hang on markers the highlighter owns (`{ id, line, isDisposed, onDispose, dispose }`,
   all `registerDecoration` and the renderers read); their lines are moved by the highlighter:
   normal buffer — all by the trim, measured by one real marker on the newest scrollback row
   (`baseY − 1`; uniform shifts are what the DecorationService's sorted list relies on); alternate
   screen — each record follows a real "tracker" marker of its own (at most one per screen row, not
   attached to any decoration), records whose tracker xterm disposed go first, then the rest take
   their trackers' lines (order kept). R35 holds as stated: a line a program scrolls keeps its
   record.
2. **2000 real markers cut flood throughput ~6×** with a full scrollback (every trim fires every
   marker's `onTrim`: 410k → 64k lines/s). Gone with 1: one real marker on the normal buffer.
3. **"drawn" cannot be read off decoration elements on the alternate screen**
   (`BufferDecorationRenderer.ts:109-110` hides them there; WebGL paints the cells). **Change:** the
   debug state's `drawn` comes from the highlighter's records (row, x, width, layer) with the text
   they cover now; R2 of `261111_buffer-search` and R34 assert on that.
4. **Trim anchor on the cursor row** would be erased/shifted. **Change:** on `baseY − 1`; a disposed
   anchor (`CSI 3J`) → clear, redo the screen, `onLost` asks for a re-scan.
5. **Resize showed a wrong frame** until the async re-scan. **Change:** `resized()` drops everything and
   redoes the screen synchronously; the scan does the rest.
6. **A sliced scan could overwrite fresher live rows.** **Change:** `setMatches` diffs only the
   scrollback (`[0, baseY)`) from the scan, and re-reads the screen itself.
7. **Back from the alternate screen, scrollback highlights missing ~300 ms.** **Change:** the normal
   buffer's scan is kept while the alternate screen shows and drawn again inside the switch event
   (unless the width changed).
8. **A flood can pass a row through the live area within one write slice.** **Change:** `refreshLive`
   covers from the previous refresh's live top (moved by the trim) to the screen's bottom.
9. **Diff order.** Disposals all come before registrations (`SortedList` flushes pending deletes on
   insert and back).

Not taken: "always the ±3-screen window" (one code path) — it would register on scroll, against R34.
In capped mode `refreshLive` keeps to the window too, so the cap is exact.

Unit tests added for 1, 4, 7, 8 (`test/search-highlights.test.js`: `CSI M` + `ED` under highlights,
a flood through a full scrollback, `CSI 3J`, the way back from the alternate screen).

## Found in the first acceptance run (2026-11-16)

less's `k` scrolls back with a reverse index at the top (`ESC M`), which xterm does with
`shiftElements` (`InputHandler.ts:3302-3311`): cells move, markers do not, so every row was redone
(10 registered, 10 disposed for one line). **Change:** on the alternate screen each record keeps the
text of its row; after the trackers are followed, a record whose row no longer holds its text looks
for it at the nearest row (unclaimed, either direction) and moves there with a new tracker; a record
whose text is gone is dropped; if the moves would break the records' order, they are left to the
diff. The same covers scrolls inside a region below row 0. Unit test: "a reverse index at the top".
