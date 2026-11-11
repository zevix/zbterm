# Search in live session buffers — design (one page)

**Serves:** `goal_requirements.md` R1–R9, U1–U3
**Written:** 2026-11-11; revised 2026-11-11 for the user's single-box change (`notes--context.md`): one box, `#search`, moved to the bottom bar; no `#bufferSearch`.
**Reviewed:** 2026-11-11, Sonnet, fresh context, from `goal_requirements.md` and the first version of this page. Its 16 rows are answered under *Failure scenarios*; rows 17–22 were added by the planner for the revision and were not reviewed.
**Approved:** see end.

## Interface

- **Matcher** (pure, two copies kept identical by a test; `engine/` is published apart from `renderer/`): `engine/buffer-search.js` and `renderer/buffer-search.js` (a plain script like `renderer/wall-clock.js`) export `scanBuffer(buffer, query, { from, to, limit })`.
  - Joins soft-wrapped rows (`line.isWrapped`) into one logical line, built cell by cell (`getCell`, width 2 for wide characters), keeping a string-index → `(row, col)` map, so a match across a wrap or after CJK/emoji maps to the right cells.
  - Case-insensitive, plain text; folds each character only when its lower case has the same length (no offset shift, e.g. `İ`). Non-overlapping occurrences. The query is used as typed; only an all-whitespace query is refused.
  - Returns `{ count, matches }`: `count` is exact; `matches` (`{ row, col, len }`, possibly two rows long) stops at `limit`, newest first.
- **Engine method** `session.searchBuffer` (`engine/index.js::SessionEngine.invoke` → `searchBuffer`): args `{ sessionId, query, searchKey, seq }` → `{ sessionId, count, cancelled, gone }`.
  - Reads only `this.sessions.get(id).mirror` or `this.remoteSessions.get(id).mirror`: the normal buffer with its scrollback, plus the alternate screen while it is active. No mirror (ended, pending, unknown) → `{ count: 0, gone: true }`.
  - Scans 500 logical lines per slice, then `setImmediate`. At each yield it stops with `cancelled` if a newer `seq` arrived for its `searchKey`, and with `gone` if the session's mirror was disposed or replaced (end, resync).
  - Added to `docs/CORE-CONTRACT.md` §5.1 (a minor addition; `test/core-contract.test.js` checks the table).
- **Hotkey** `isSearchHotkey(event)`: `ctrlKey && shiftKey && !altKey && !metaKey`, and `key.toLowerCase() === 'f'`, or `code === 'KeyF'` when `key` is not an ASCII letter (non-Latin layouts).
  - In the capture `keydown` on `document` (`renderer/app.js` ~1255), before `isSidePaneHotkey` and `keyTriggerFor`, with the same modal rule: while `sidePaneBlocked()`, nothing happens and the event is not `preventDefault`ed.
  - `attachCustomKeyEventHandler` (~861) returns `false` for it, via one `isAppHotkey(event)` = side pane ∨ search ∨ `keyTriggerFor`, so xterm never encodes it, dialog or not.
  - `focusSearch()`: focus `#search` and select its text (also when it already has focus).
- **The box** is today's `<input id="search" type="search">`, moved out of `.tools` into the bottom bar's first cell, with `#searchCount` (`3/17`, `0/0`) inside its right end, where `#activeOnly` sat. Placeholder "Search (Ctrl+Shift+F)".
  - One `input` handler: the name filter as today (`state.query`, `refreshSessions()`, immediate); `scheduleInSessionSearch()` (120 ms); `scheduleSessionBufferSearch()` (200 ms) only while the list is shown (pane expanded, not the narrow layout).
  - Keys, ignored while `event.isComposing`: Enter → `stepMatch(-1)`, older; Shift+Enter → `+1`, newer; with no current match the first step picks the newest. A step re-scans first when the buffer changed, and calls `term.scrollToLine`. Esc → `clearSearch()`, `preventDefault` (no native `type=search` clear): empty the box, run the name filter with `''`, drop matches, marker, decorations and the buffer section, bump `seq`; focus `state.term` if there is one.
  - `#activeOnly` ("All") stays in the side pane, as the third cell of `.tools` after New and Join: it filters the list, which only the pane shows.
- **In-session search** (`renderer/app.js`): `scanBuffer(state.term.buffer.active, query, { limit: 50000 })` in slices of 2000 lines between `setTimeout(0)`s; `state.bufferSearch = { query, count, matches, index, marker }`.
  - The current match holds an xterm marker (`registerMarker`); a trimmed-away marker drops the current match.
  - Highlights: `registerDecoration` for every match in the rows on screen, redone on `term.onScroll` and after each re-scan; the current one in `--search-current`, the rest in `--search-match`.
  - Re-run: on `input`; live, after writes (300 ms); playback, after frames (150 ms); on session switch (the query stays in the box, so clicking a buffer-match row shows that session with its matches).
- **Cross-session** (`renderer/app.js`): `runSessionBufferSearch(query, seq)`: `session.list({ activeOnly: true })`, then one `session.searchBuffer` per live, non-pending session, all sent together. An answer is kept if its `seq` is current, `count > 0` and not `gone`; it is inserted into `state.bufferMatches` by count (ties keep the list's order); the section is redrawn after each answer.
  - `session:list-changed` (~1369) while the box holds text: searches sessions that became live, drops rows of sessions that ended.
  - Collapsing the pane (or going narrow) bumps `seq` and drops the section; expanding with text in the box starts a search.
  - `renderSessions()` (~2515) appends, after every name row (pinned included) or after "No matching sessions" (today's early return), `.session-section-title` "Session buffer matches", then "searching…" until the first answer, then the rows, or "No matches in live sessions".
  - Rows come from the existing row code with the subtitle replaced by `.session-sub.match-count`: "N matches", or "1 match", in `var(--match-cyan)`, light and dark values each ≥ 4.5:1 against `--panel-bg`.
- **Debug commands** (`window.__zbtermDebugCommand` ~9386, listed in `docs/debug_server_howto.md`):
  - `search-state` → `{ box: { id, rect, focused, value, placeholder, countText, inSidebar }, statusRect, bottomCells, sidebarRect, topbarBrandRect, sideCollapsed, narrow, crossSession, inSession: { query, total, index, current, viewportY, rows, decorations, mode, buffer }, sessions: { query, seq, pending, heading, empty, rows: [{ id, name, sub, subColor, rowBg, section }] } }`;
  - `buffer-search-log` → since the last call, each `session.searchBuffer` request and answer `{ sessionId, seq, count, cancelled, gone, sentAt, answeredAt }`.

## Data and state

- Nothing is written to disk: no preference, no catalog field. A restart starts with an empty box.
- Renderer: `state.query` (as today), `state.bufferSearch`, `state.bufferMatches`, `state.bufferSearchSeq`, `state.bufferSearchLog` (ring of 500).
- Engine: `this._bufferSearchSeq: Map<searchKey, seq>`; `searchKey` is a random id made once per renderer, so two windows never cancel each other.
- **Layout** (`renderer/index.html`): `<footer class="bottom">` moves out of `.main` to a child of `.app`, row 2, `grid-column: 1 / -1`; `.app` rows become `minmax(0, 1fr) auto` (collapsed: the same; narrow: `auto minmax(0, 1fr) auto`). The side pane and `.sidebar-resizer` end above the bar. `.bottom` columns: `var(--search-col) minmax(0, 1fr) auto` (box, status, playback); the box cell has no outer padding on its left, so its edges meet the pane's.
  - `--search-col` is `var(--sidebar-width)` while expanded (it follows a drag of the resizer), and the measured width of `.topbar-brand` while collapsed, kept by a `ResizeObserver` on it.
  - The box cell has the pane's background (`--panel-bg`) in both states, so it reads as the pane's foot.
  - Narrow (under 780px): the box is the bar's first row at full width; status hidden as today; the list is hidden, so the box searches the selected session and filters the dropdown by name.
  - `syncTerminalLayout` (~7591) already subtracts `els.bottom`'s height; it is kept, measured from the new place.

## Refuses

- An all-whitespace query: no search, no section, no highlights (the name filter behaves as today).
- Ctrl+Shift+F with a dialog or the profile picker open: nothing happens, and the key is not swallowed.
- An ended session, a pending join, an unknown id: never searched or listed; the engine answers `{ count: 0, gone: true }`, never an error.

## The reference program, step by step

`acceptance/run_all.sh` → each script:
1. `../../261110_ui-chrome/acceptance/lib.sh::start_app` (packaged app under `uisolate`, scratch HOME and storage, free debug port). This kit's helpers go in `acceptance/lib_bs.sh` (P1).
2. It seeds sessions with known text: `POST /sessions`, then `POST /sessions/:id/input` with `printf` loops, and waits until the text is in `GET /sessions/:id/stats`.
3. Real keys: `key ctrl+shift+f`, `key ctrl+shift+b`, `xdo type`, `key Return`, `shift+Return`, `Escape`; `click_at` the box; the resizer is dragged with `xdo mousedown/mousemove/mouseup` as in `../../261110_ui-chrome`.
4. It asserts with `jq -e` on `search-state`, `buffer-search-log`, `GET /events` and `term_text`.
5. R8 starts a second app (`lib_bs.sh::start_second_app`) and joins it with `POST /join` and the host's approval, as in `test/debug-server-e2e.js`.

## Failure scenarios

| # | scenario | at risk | design answer |
|---|---|---|---|
| 1 | Non-Latin layout: `key` is "а", the chord is missed | R1, U1 | `code === 'KeyF'` when `key` is not an ASCII letter (*Hotkey*). xterm sends nothing for Ctrl+Shift+letter in any layout (`baseline.md`). `U1_hotkey_not_typed.sh` repeats under `setxkbmap ru`. |
| 2 | IME composition: Enter/Esc commit it and also step or close | R2, R3 | Box keys are ignored while `event.isComposing` (*The box*). |
| 3 | `vim`/`less` on the alternate screen | R2, R5 | Engine: normal buffer with its scrollback, plus the alt screen while active. Box: `buffer.active`, what the user can scroll to. `search-state` reports `buffer`. `R5_buffer_section.sh` has a session in `less` with the word only in its earlier scrollback. |
| 4 | 1-character query, huge counts, too few decorations | R2, U3 | The count stays exact; positions stop at 50 000; decorations cover every match on screen; the scan runs in slices. `U3_responsive.sh` uses a 1-character query. |
| 5 | Output trims scrollback while stepping | R2 | The current match holds an xterm marker; a step re-scans when the buffer changed. `R2_in_session_matches.sh` steps during a running `yes NEEDLE \| head`. |
| 6 | A match across a wrap, or after CJK/emoji | R2 | Logical lines joined, cell map from `getCell`; two-row matches get two decorations. `R2_in_session_matches.sh` seeds both and checks `current`'s row and column. |
| 7 | Trailing space trimmed; lower case changes length | R2, R5 | The query is used as typed; folding keeps lengths (*Matcher*). `test/buffer-search.test.js` covers both. |
| 8 | Sessions start, or output arrives, after the scan | R5, R7 | Answers are a snapshot taken at search time (A-4). `session:list-changed` searches new live sessions and drops ended ones. `R7_stream_and_cancel.sh` starts a session mid-search. |
| 9 | Session ends or resyncs mid-scan | U2, R7, R8 | At each yield the mirror is checked; a changed one answers `gone` and the row is dropped. `test/buffer-search.test.js` disposes a mirror between slices. |
| 10 | A joined copy holds less than the host | R8 | R8 says "the copy this app holds"; `searchBuffer` has no network path. The engine test reads `remote.mirror` in an in-process pair, as in `test/share-flood.test.js`. `R8_joined_session.sh` checks the joined row in B. |
| 11 | Playback at speed rescans every frame; scrollback built while playing | R4, U3 | 150 ms debounce in playback. "On screen" means what the terminal holds (`notes--context.md` R4). |
| 12 | Duplicate rows; pinned rows; no name rows; rows re-sorting | R5, R6 | The heading follows every name row, pinned included, or "No matching sessions". A session can be in both sections (Q-2). Rows are inserted in count order as answers come. |
| 13 | Narrow window; cyan contrast in light theme | R1, R6 | Under 780px the box is the bar's first row; the dropdown gets no buffer section (out of scope). `R6_order_and_count.sh` computes the contrast of `subColor` on `rowBg` in both themes (≥ 4.5). `R1_box_and_hotkey.sh` checks 700x600. |
| 14 | One Bare thread: time-slicing, not parallel; U3 has no bound | R7, U3 | Q-1 (answered). The bound is 150 ms echo, median of 10 (`notes--context.md` U3). |
| 15 | Caps Lock; box focused; dialog open with xterm focused | U1 | `toLowerCase()`; a second press reselects. With a dialog open, xterm drops the chord and the document handler leaves it alone. `U1_hotkey_not_typed.sh` presses it with a dialog open. |
| 16 | Esc with no session or no terminal; first Enter's direction | R3, R2 | `state.term` is checked before `focus()`; the first step picks the newest match. `R3_escape.sh` presses Esc with no session selected. |
| 17 | The pane is resized by drag, or restored from the profile at another width | R9 | `--search-col` is `var(--sidebar-width)`, the same variable the resizer sets. `R9_box_width.sh` drags the resizer and compares the box with the pane. |
| 18 | The collapsed left group changes width (font, zoom, the identity dot, wrapping in a narrow window) | R9 | A `ResizeObserver` on `.topbar-brand` updates `--search-col`. `R9_box_width.sh` checks after collapse and after a window resize; the narrow layout is its own rule (scenario 13). |
| 19 | Typing with the pane collapsed still runs engine searches nobody sees | R9, U3 | The cross-session search runs only while the list is shown; `R9_box_width.sh` asserts no `searchBuffer` request in `buffer-search-log` while collapsed, and one per live session after expanding. |
| 20 | `type=search` clears itself on Esc natively, firing `input`, before our handler | R3 | The handler runs on `keydown` and calls `preventDefault`, then clears in one place (`clearSearch`). `R3_escape.sh` checks the list filter is empty and the focus is in the terminal. |
| 21 | Moving the footer under `.app` changes rects that done kits assert | R1, R9 | No done kit references `#search` (2026-11-11: `grep -rln search ../261110_*/acceptance/` → `261110_ui-chrome/acceptance/lib.sh` for `xdo search`, and a sentence in `261110_session-templates/acceptance/report--2026-11-11.md`). The footer move can touch `../261110_ui-chrome` R2, R4, R5, U2 and `../261110_timeline-fixes` R1–R7, U1–U2 (timeline and bubble rects). P3 and P6 re-run those kits as regression checks; a red one is recorded with a dated note in `phases.md`, never by editing a done kit. |
| 22 | The box moved, but the list filter and the "All" toggle drift apart | R5 | `#activeOnly` stays in the pane and keeps working; `R5_buffer_section.sh` clicks it with a query in the box and checks the name rows are filtered by both. |

## Questions and assumptions

- **Q-1** (answered 2026-11-11, recommendation accepted) Threads: **no new dependency**. Each live session is searched by its own engine call; the calls are sent together, interleave in the Bare worker in 500-line slices, and each row appears when its session finishes (~6 ms per 5000-line session in Bare, `baseline.md`).
- **Q-2** (answered 2026-11-11, recommendation accepted) A session whose name and buffer both match **shows in both sections**.
- **Q-3** (planner, 2026-11-11, from the single-box change) Enter in the box: it did nothing before (no handler on `#search`), so it steps to the older match, Shift+Enter to the newer. It never selects a list row.
- **Q-4** (planner) Esc clears everything the box drives (name filter, buffer section, highlights) and focuses the terminal; on an empty box it only focuses the terminal.
- **Q-5** (planner) "The same width as the top bar" when collapsed is read as the collapsed top bar's left group (logo, "ZBTerm", New, Join, Settings; `.topbar-brand`): the whole top bar is the window's width, which leaves no room for the status. The user may correct this at approval.
- **Q-6** (planner) The "All/Active" toggle stays in the side pane (third cell of `.tools`), since it filters the list only the pane shows.
- **Q-7** (planner) Placeholder "Search (Ctrl+Shift+F)"; the count `3/17` sits inside the box's right end. Switching sessions keeps the query and re-runs the in-session search there.
- **A-1** Plain text, case-insensitive, non-overlapping; no regex or case modes.
- **A-4** Buffer-match counts are taken when the query is typed; refreshed when sessions start or end, not as output arrives.
- **A-5** In playback, the box searches what the terminal holds. Cross-session search lists live sessions only, whatever is selected.
- **A-6** The in-session count (renderer's xterm) and a row's count (engine mirror) can differ for the same session: widths, a joined copy, the alt screen. Each is right for its own buffer.
- **A-7** Joined sessions are included while `active`.
- **A-8** `../261110_session-templates/` (Ctrl+Shift+T, `NEW_SESSION_TRIGGERS`, `keyTriggerFor`) and `../261110_timeline-fixes/` (`#timeLabelTip`, the time label) are merged at 3682f01. `isAppHotkey` folds Ctrl+Shift+B, Ctrl+Shift+F and `keyTriggerFor`; Ctrl+Shift+F is checked first.

## Decisions

None hard to reverse.

## Approval

Approved 2026-11-11 by the user ("I want one change - have a single search box on the bottom left - move our current search box to the bottom, and when collapsed keep it the same width as the top bar, go!", in chat, on the plan with Q-1/Q-2 as recommended; this revision applies that change), file at sha256 c646d0ce3e56 (the file before this line).
