# Search in live session buffers — notes and context

Companion to `goal_requirements.md`: the user's words, the history and the detail behind each
row, so the goal page stays one screen. Not a spec; nothing here is approved or built from.

## The user's words

**2026-11-11, the request** (verbatim, typos kept):

> lets do search in the memory buffers of the live sessions only instead.
>
> 1) searh in current session with  ATRL+SHIFT+F that will move the focus to a new search box that will be on the bottom left (move the status a bit to the right of the search)
>
> 2) search in buffers of all live sessions - when typing in the "Search sessions" box after the session name match, add a "Session buffer matches" subtitle, and below it start adding session with a match in the session buffers. Create multiple search threads and to the ordered by numbner of matches. When showing sessions with matches replace the subtutle from "live..." to "N matches" in cyan

Read by the orchestrator (2026-11-11): "ATRL" means Ctrl. "Instead" means instead of searching recorded history on disk, which is encrypted; only live sessions' in-memory buffers are searched.

**2026-11-11, after reviewing the first plan** (verbatim):

> I want one change - have a single search box on the bottom left - move our current search box to the bottom, and when collapsed keep it the same width as the top bar, go!

In the same reply, relayed by the orchestrator: the recommendations were accepted, Q-1 no new dependency (concurrent, time-sliced per-session engine calls, no true threads) and Q-2 a session matching both name and buffer shows in both sections.

Read by the planner (2026-11-11): "our current search box" is "Search sessions" (`#search`); it becomes the only box and also does the in-session search, so the planned `#bufferSearch` is dropped. "The same width as the top bar" when collapsed is read as the collapsed top bar's left group (`.topbar-brand`), since the whole top bar is the window's width (`design.md` Q-5). The details the user left open were decided by the planner as `design.md` Q-3 to Q-7, for the user to overrule at approval.

## Context

- **Replaces an earlier idea.** Before this request the plan was a full-text search of recorded history on disk. Recorded history and snapshots are encrypted (measured in `../261110_ui-chrome/status--done.md` *Gotchas*: a `grep -rlF` for a recorded marker finds nothing), so such a search would have to decrypt and replay every session. "Instead" drops that: this project searches memory only, and the on-disk search is out of scope.
- **Predecessors.** `../261110_ui-chrome/` (done 2026-11-11) set the hotkey pattern (Ctrl+Shift+B in the capture `keydown` and in `attachCustomKeyEventHandler`), the kit harness `acceptance/lib.sh` and the `ui-state` debug command. This kit reuses `lib.sh`.
- **Siblings (2026-11-11).** `../261110_session-templates/` (Ctrl+Shift+T, `NEW_SESSION_TRIGGERS`) and `../261110_timeline-fixes/` (the time label, `#timeLabelTip`) are done and merged into `buffer-search` at 3682f01, with `../261110_ui-chrome/` (collapsed top bar, Ctrl+Shift+B). Code locations in `design.md` and `phases.md` are re-checked at 3682f01; `baseline.md`'s line numbers are at ec04775.
- **No done kit references `#search`** (2026-11-11, `grep -rln search ../261110_*/acceptance/`). Moving the footer out of `.main` can still move rects those kits assert; P3 and P6 re-run them (`design.md` scenario 21).
- Planned on branch `buffer-search` (worktree `.claude/worktrees/buffer-search`) from ec04775.

## Requirement notes

- **R1** The box is today's `#search`, moved from the side pane's `.tools` to the first cell of `.bottom`; `#status` is the second cell. Placeholder "Search (Ctrl+Shift+F)". The box is always there; the hotkey focuses it and selects its text. Clicking it works too. Typing does three things: filters the list by name (immediate, as today), searches the selected session (R2), and, while the list is shown, the live sessions (R5).
- **R2** Plain text, case-insensitive. The count reads `3/17` (current/total), `0/0` when nothing matches, inside the box's right end. Enter goes to the next older match (upwards), Shift+Enter to the next newer one; the first match after typing is the newest one, nearest the bottom. Before this project Enter in `#search` did nothing, so nothing is lost (`design.md` Q-3). Lines that wrap are joined. Matches are highlighted in the rows on screen; the current one has its own colour. While live output arrives, the search re-runs (debounced) and keeps the current match where it was. Switching sessions keeps the query and searches the new session.
- **R3** Esc empties the box, which also clears the list filter and the buffer section, removes every highlight and focuses the terminal; on an empty box it only focuses the terminal (Q-4). The native `type=search` Esc clear is replaced by this one.
- **R4** A playback frame holds no scrollback (`engine/player.js` builds its frames with `scrollback: 0`), so after a seek the box searches the screen only; while playing, the terminal also builds scrollback from the played output (`renderer/app.js` `player:data` → `enqueuePlaybackWrite`), and that is searched too: "the frame on screen" means what the terminal holds. It re-runs after each new frame (seek, step, play), debounced 150 ms. Soft: the user asked for live sessions; playback only needs to behave sensibly.
- **R5** The heading appears as soon as the query is not empty and the list is shown, with "searching…" under it until the first result, and "No matches in live sessions" when every search finished empty. A session whose name matched may appear in both sections (Q-2, answered). Live means `active` in the session list, both own and joined. The "All/Active" toggle stays in the pane and still filters the name rows (Q-6).
- **R6** Ties keep the session list's order (most recently started first). The cyan is a new colour token `--match-cyan` with a light and a dark value. The row keeps its icon, name, marks and hover actions; only the subtitle line changes.
- **R7** One engine call per live session, issued together; the calls interleave in the Bare worker and each answers when its session is done (Q-1, answered: no threads, no new dependency). Typing is debounced (200 ms); every query has a sequence number, and both the renderer and the engine drop work for an older one.
- **R8** A joined session's buffer is `remoteSessions.get(id).mirror` in the viewer's engine: the host's screen plus up to 5000 lines of scrollback from the bootstrap, then live output. After a resync the host sends only 500 lines (`engine/share-manager.js::RESYNC_SCROLLBACK`), so a joined copy can hold less than the host's.
- **R9** Expanded: the box's left and right edges are the side pane's (±1 px), and follow a drag of the resizer. Collapsed: its width is `.topbar-brand`'s (±1 px), at the window's left edge. The list is hidden while collapsed, so no cross-session search runs then; expanding with text in the box starts one. The narrow layout (under 780 px) is not this rule: the box is the bar's first row at full width (`design.md` scenario 13).
- **U1** xterm.js sends nothing for Ctrl+Shift+letter (`Keyboard.ts`: the a–z branch requires `!ev.shiftKey`), so U1 guards against a regression. It is checked with real keys and `od -c`, as `../261110_ui-chrome` U1.
- **U2** The search reads only `runtime.mirror` / `remote.mirror`. Ended sessions have no runtime. The check also confirms no store is opened (no `session.open`/`player.open` in `GET /events` while the search runs).
- **U3** "Responsive": a typed key's echo returns within 150 ms while the search runs over five sessions with 5000 lines each (baseline: one full scan costs ~6 ms in Bare).

## Soft changes

Details behind hard rows, reworded to what the kit can measure (builder P1, 2026-11-11). None weakens a check.

- **2026-11-11 (P1), U3 detail (the measure):** the echo is timed from `POST /sessions/current/input` to the typed text on the selected session's rows in `GET /renderer/terminal-display` (what the user sees), not in `GET /sessions/:id/stats`'s frame. `stats` also calls `player.open` (reads the recording from disk) and serialises the whole 5000-line mirror on every poll (`baseline.md`: 30 ms), so it would time the probe, not the echo, and would itself read history. To keep a search running through the ten samples, each round retypes the 1-character query (a new search over the five buffers) 250 ms before the key.
- **2026-11-11 (P1), seeding (all scripts):** `lib_bs.sh::seed_session` waits on `GET /sessions/:id` (`opened.frame`, `session.open` only) instead of `GET /sessions/:id/stats`, for the same reason: `stats` opens the player, which U2 must not see while it searches.
- **2026-11-11 (P1), R2 detail (the flood):** `yes NEEDLE | head -n 20000` finishes in milliseconds, before the first step. The kit runs the same 20 000 lines as 100 rounds of `yes NEEDLE | head -n 200; sleep 0.1` (~10 s), so the steps land while output scrolls the buffer.
- **2026-11-11 (P1), R7 detail:** "all sent before the first answer" and "the big session's row after the small ones" are read from `buffer-search-log` (`sentAt`, `answeredAt`) as well as from `search-state` polled as fast as it answers; both are asserted.
- **2026-11-11 (P2), matcher interface detail (R2, R7):** `scanBuffer` also takes `lines` (the most logical lines to read) and also returns `next` (the row to start the next slice at) and `lines`, so a caller can slice by logical lines (`design.md`: the engine's 500-line slices); `from`/`to` are buffer rows, and a logical line belongs to the slice holding its first row. A match's `len` counts cells from its first cell to the end of its last, so a match across a wrap whose last row starts with a pushed-down wide character also covers the empty cell that character left. Additive; no row or check changes.
- **2026-11-11 (P2), scenario 7 detail (trailing space):** "the query is used as typed" is built as: erased cells at the end of a logical line are not text (dropped), written spaces are, so "foo " matches "foo bar" but not "foo" at a line's end; erased cells inside a line read as one space each. `test/buffer-search.test.js` asserts both.
- **2026-11-11 (P2), engine detail (U2, R8):** a joined session whose `remote.active` is false (the host ended it) answers `gone`, like an ended own session; a scan follows rows that output trims away while it yields with an xterm marker on its next row (the oldest rows are trimmed, so a trimmed marker means row 0 is next).
- **2026-11-11 (P3), R1/R9 detail (the box's cell):** the input fills its bar cell edge to edge and top to bottom, with the pane's right border drawn on the input, so its edges are the pane's (R9, measured equal widths, 0 px) and its bottom is the window's (R1); the bar has no left or vertical padding, the status and playback cells carry their own 8 px. In the narrow layout it is an ordinary rounded input in the bar's first row, with the bar's 8 px gutters.
- **2026-11-11 (P3), R9 detail (the collapsed width's mechanism):** the measured `.topbar-brand` width is kept in `--topbar-brand-width` (a `ResizeObserver` on `.topbar-brand`, plus a synchronous read in `applySidePane`), and the CSS picks `--search-col` from it under `.app.side-collapsed` (from `--sidebar-width` otherwise), instead of the observer writing `--search-col` itself. The same observer writes `--bottom-bar-height`, where `.sidebar-resizer` now ends (it no longer runs over the bar).
- **2026-11-11 (P3), Q-6 detail:** `#activeOnly` ("All"/"Active") is an ordinary `text-btn` in `.tools`' third, auto-width column, no longer an overlay inside the box. `#searchCount` is not added in P3; P4 adds it with the count.
- **2026-11-11 (P4), R2 detail (re-scan timing):** "after writes (300 ms)" is built as a timer started by the first parsed write of a burst and not pushed back by later ones (a debounce reset by every write would never fire during a flood); 150 ms in playback. A step (Enter / Shift+Enter) re-scans synchronously first when a write was parsed since the last scan, keeping the current match by its marker.
- **2026-11-11 (P4), R2 detail (the current match):** a scan that finds no current match (a new query, a session switch, the current one trimmed away) makes the newest match current; only typing and a step scroll it into view, a re-scan after output does not move the viewport. Stepping wraps round at either end (Enter past the oldest goes to the newest).
- **2026-11-11 (P4), R2 detail (highlights):** xterm's decorations are proposed API (`allowProposedApi: true` on the terminal) and take only `#rrggbb` colours; tokens `--search-match`, `--search-current` and `--search-current-fg` (the current match's text) in both themes. xterm draws no decorations on the alternate screen (`registerDecoration` returns undefined there), so in `vim`/`less` the count and the steps work but the matches are not highlighted; see *Open* in the status file.
- **2026-11-11 (P4), R2 detail (the count):** `#searchCount` sits in the box's right end (64 px of right padding) and is hidden while the box is empty or nothing is selected; it reads `index/total` (`0/N` with no current match).
- **2026-11-11 (P4), kit harness fix:** `R2_in_session_matches.sh` line 65 read the terminal's columns as `.terminal.cols` of `GET /renderer/layout`, which answers `{ …, renderer: { terminal: { cols } } }`; it now reads `.renderer.terminal.cols` (it set `cols=null` and the script died on `set -u`, before its wrap assertion). No assertion changed.

## Superseded text

- 2026-11-11, first plan (before the user's single-box change): a second box `#bufferSearch` "Search buffer (Ctrl+Shift+F)" in the bottom bar for the selected session, while "Search sessions" stayed at the top of the side pane and drove the buffer-match section. Replaced by one box, `#search`, at the bottom left (R1, R9).
