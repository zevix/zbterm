# Live output and fixes — design (one page)

**Serves:** `goal_requirements.md` R1–R13, U1–U4 · **Written:** 2026-11-14 (R8–R13, U3–U4: 2026-11-15) · **Reviewed:** 2026-11-14, Sonnet (fresh context, this page and the goal page); R8–R13 2026-11-15, Sonnet (rows 13–21) · **Approved:** see end.

R1–R3/U1/U2 are design A of `../261113_ui-polish/delivery-design.md` (root cause, proof, the two
designs not taken). R4–R7 are renderer details (`notes--context.md` *Requirement notes*).

## Interface

- **`session:data`** (engine event, `docs/CORE-CONTRACT.md` §5, minor/additive) gains `end: uint|null`:
  the session's stream position after this chunk (bytes of output since the core opened the
  session). Own sessions: `runtime.bytesSeen` after the chunk (`engine/index.js::_recordLiveData`).
  Joined: the viewer core's own count, `remote.bytesSeen` (`::applyRemoteData`); never the host's.
- **Frames** (`session.open`'s `frame`, own and joined) gain `through: uint`: the stream position the
  frame contains. A frame and its `through` are taken in one synchronous step after the last await.
- **`session.searchBuffer`** answers gain `hidden: uint` (R5): matches in the normal buffer while the
  alternate screen is shown. Absent from older cores.
- Wire: `engine/rpc/schema.js::EventData` appends `OptionalUint end`, decoded only when bytes remain.
  `engine/worker.js` and `engine/client.js::_onEventData` pass it; `electron/session-data-batcher.js`
  keeps the **last** item's `end` when it joins chunks.
- **`renderer/live-stream.js`** (new, plain script, `window.zbtermLiveStream`, `module.exports` for
  tests): `createLiveStream()` → `{ hold(sessionId), frame(through) → chunks, take(chunk) →
  {write, drop, gap}, reset() }`, pure: no DOM, no xterm.
- Debug server command `live-stream-state` (positions, held, gaps, resyncs) and `live-drop-next`
  (the renderer discards the next session:data of the selected session; U1's injected gap).

## Data and state

Engine, per own session: `bytesSeen` (exists). `_sessionState` computes availability first, then
`await mirrorQueue`, then snapshot + `mirrorPending` tail (as `buildLiveBootstrap`) and
`through = bytesSeen`, synchronously. Per joined session: `bytesSeen` (all data received) and
`mirrorBytes` (set in the mirror chain after each write); `openSession` does its awaits first, then
`await mirrorQueue` and snapshots with `through = mirrorBytes`.

Renderer, one stream state for the selected live session: `sessionId`, `holding`, `held[]`,
`written` (position of the last byte handed to xterm, or `null`: untracked).

1. Before any frame request (select, extend, `session:restored`, clear caches, resync): `hold(id)`.
2. While holding, the session's chunks go to `held` (not written, not acked yet).
3. Frame answer: drop queued live writes, wait for xterm to drain (`term.write('', cb)`), then
   reset + paint; `written = through`; replay `held` through `take`.
4. `take(chunk)`: `end ≤ written` → drop (ack); straddles → cut `written - start` bytes; starts
   past `written` → **gap**: hold again and resync (step 1, `session.open`); else write,
   `written = end`. `end` smaller than `written` by more than the chunk (a restarted core) → gap.
5. `written === null` (a frame-less open: restoring) → the first chunk sets it.
6. No `end` on a chunk, or no `through` on a frame (older core, U2): today's behaviour exactly
   (written untracked; held chunks before a frame are dropped, as the reset wiped them before).

A second open finds the same: positions only grow; nothing on disk changes.

## Refuses

- No resync storm: at most one resync in flight; a gap during a resync is folded into it.
- Never cuts inside an engine chunk except at `through` (always a chunk boundary).
- Does not order Electron IPC (out of scope); correctness no longer depends on it.

## The reference program, step by step

`acceptance/run_all.sh` on `zr`, scratch packaged app under `uisolate`:
R1 seeds a session printing 4000 numbered lines, switches to it N times mid-flood, and compares the
renderer's buffer to the engine's mirror line by line (seam check of `dup2.sh`: no line twice, none
missing). R2 does it across an extend and a restart restore. R3 with a second app joined. U1 sends
`live-drop-next` mid-flood and expects `resyncs ≥ 1` and the buffers equal. U2 runs the renderer
stream module against chunks with no `end` (unit) and the app against an engine started with
`ZBTERM_NO_STREAM_POS=1` (positions left out), expecting today's behaviour. R4–R6 read the DOM.

## R8–R13: search mode, history ends, logo screen (2026-11-15)

Renderer only (`renderer/index.html`, `renderer/app.js`); no engine, wire or contract change.

- **Search mode** = `#search` has focus or holds text. `app.js::syncSearchMode()` (called on the box's
  `focus`, `blur`, `input` and from `clearSearch`) sets `.searching` on `.app` and the placeholder.
- **R8** placeholder: `"Search (Esc to exit)"` while focused, else `"Search (Ctrl+Shift+F)"`.
- **R9** `#searchIcon` swaps `fa-magnifying-glass` for `fa-circle-xmark` in `--accent-blue-border` while
  `.searching`, with `cursor: pointer`, `title="Close search (Esc)"`, `role="button"`; a click calls
  `clearSearch()` (as Esc: the box empties, the focus goes to the terminal), outside search mode it still focuses the box.
  `#search::-webkit-search-cancel-button { display: none }`: one "x", not two. The icon keeps its place
  (right: 11px), so the count (3/17) does not move.
- **R10** In the box's existing `keydown` (same IME/modifier guard): ArrowUp/ArrowDown →
  `moveSearchSelection(±1)`: the rows as drawn in `#sessions` (`.session-row` in DOM order, both
  sections), from the cursor row `state.searchCursor = { section, id }` (else the `selectedId` row,
  else before the top); at either end: stay. Always `preventDefault`, then
  `selectSession(session, { keepFocus: true })`; the row is scrolled into view (`block: 'nearest'`).
  CSS: `.app.searching .session-row.search-cursor { border: 2px solid var(--logo-green); padding: 7px }`
  (padding −1 so the row does not grow); `--logo-green` is set on `:root` from
  `window.STARTUP_LOGO_COLORS.green` at start-up (one source for the logo and the border).
- **R10 focus** `selectSession` gains `options.keepFocus` (skips `state.term.focus()`, `app.js:3947`).
- **R10 anchor** (added while building, 2026-11-15; to be read back to the user): selecting a
  session normally moves it into "Current session", which would reorder the list under the cursor
  on every arrow. `state.searchAnchorId` (set by the first arrow of a walk) keeps that section on
  the session the walk started from; `renderSessions` uses it instead of `selectedSessionEntry()`
  while searching. Any other selection, Esc or leaving the box clears the anchor and the cursor.
- **R11** `#jumpStart` (`fa-backward-fast`, title "Start") before `#stepBack`, `#jumpEnd`
  (`fa-forward-fast`, title "End") after `#stepForward`. `jumpTo('start')`: from live,
  `enterPlaybackMode` (as `step(-1)`), then `player.seek` with `tsMs` of
  `state.timeline[0]` (as `app.js:5029`), cancelling a pending seek and the clock.
  `jumpTo('end')`: a running session → `goLive()`; an ended one → the same path with
  `SCRUBBER_STEPS`. Enabled (`updateTransportControls`): Start as `canStepBack && state.timeline.length`, End as
  `canGoLive || canUseOpenPlayer`.
- **R12** In `updateTransportControls`, `#jumpEnd` gets the four classes `#goLive` gets (`live-on`,
  `live-joined`, `live-host`, `live-beacon`) from the same booleans, on the same line. Phase: `syncLiveBeaconPhase()`, called at the end of
  `updateTransportControls` and when `#playback` is shown, sets `startTime = 0` on every running
  animation of both buttons (`el.getAnimations()`), aligning them to the document timeline whatever
  restarted them.
- **R13** `app.js`: the startup writer and `devLogoText` drop the two lines; the "See …" line is
  written with `writeCenteredTerminalText` (startup) and `centered()` (`devLogoText`), the blank rows
  kept so the block still ends on the grid's last row (no scroll; the comment there stays true).
- **Debug server**: `style-of` gains `borderWidth`, `borderColor`, `disabled` and
  `animationClocks` (`{name, startTime, currentTime}` per animation); added: `search-mode` (`on`,
  `focused`, `activeElement`, `value`, `caret`, `placeholder`, icon class/title/colour, the
  `--accent-blue-border` and `--logo-green` colours, `cancelButtonHidden` (read from the
  stylesheet rule: `getComputedStyle` does not report `-webkit-` pseudo-elements), `selectedId`,
  `anchorId`, `cursor`, `cursorRow`, `rows`) and `logo-text` (`source` `screen` or `dev`: rows as
  text with their first column, `cols`, `logoCols`, `startupLogoActive`) for the checks.

Checks: `R8_search_mode.sh` (focus/blur → placeholder and icon; click the "x" → box empty, no
focus; no visible native cancel button), `R10_search_arrows.sh` (three sessions, type a query,
Down/Down/Up → `state.selectedId` and the row's border 2 px logo green, caret position unchanged,
first/last rows stay, Ctrl+Down ignored), `R11_history_ends.sh` (a recorded running session: Start →
playback at frame 0; End → live; an ended one: End → last frame; buttons' order in the DOM; `>>|`
and Live carry the same classes and their animations the same `currentTime`; End disabled when live; unrecorded → both
disabled), `R13_logo_text.sh` (`logo-text`: neither line present; "See …" centred on the "Written by" line
within a column; in dev text both ±1 of `(cols − length) / 2`. With debugging on, the screen shows
the interlude drawn at the width of that moment, before the grid widens, so screen rows are
compared line against line).

## R14–R15: Ctrl+PgUp/PgDn and no auto-resume in the search walk (2026-11-15)

- **R14** The document's capture `keydown` (where Ctrl+PgUp/PgDn call `switchSessionRelative`)
  checks `document.activeElement === els.search` first: there, Ctrl+PgUp/PgDn (no Shift, as for
  the arrows) call `moveSearchSelection(∓1)`; always `preventDefault` + `stopPropagation`. Elsewhere,
  unchanged.
- **R15** `moveSearchSelection` selects with `{ keepFocus: true, extend: false }`, so an offline
  session opens in playback (the dotted offline view) instead of `extendSession()`. Then, if
  `isOfflineResumable()`, `showResumeHint()` (the usual `resume-hint` toast); otherwise the toast is
  dismissed, so it never stays up for a session it does not apply to. Ctrl+R is already handled by
  the same capture `keydown` (`isOfflineResumable()` → `extendSession()`), which runs with the focus
  in the box; it now passes `{ keepFocus: document.activeElement === els.search }`, and
  `extendSession` hands `keepFocus` to its `selectSession(revived, …)`, so the focus, the cursor and
  the anchor stay. Only a literal `true` counts (the button's click handler passes its event).
  A click on an offline row still resumes it, as today.
- **Debug server**: nothing new; `search-mode` and `playback-state` answer it, plus the toast
  list the state already reports.

Check: `R14_search_resume.sh`: three sessions, one ended. In the box, Ctrl+PgDn/PgUp move the cursor
and the selection exactly as Down/Up do (same rows, `selectedId`, the focus kept, the caret
unchanged). Reaching the ended one leaves it ended (playback, not active) with the "Press ^R to
resume the session" toast shown; moving on dismisses it. Back on it, Ctrl+R in the box resumes it
(it is active and live), with the focus and the caret still in the box, b still selected and the
cursor still on b's row. The rows after the resume are checked as a prefix, not for equality: b's
resumed output matches the query, so a "Session buffer matches" row for b is legitimately appended.

## Failure scenarios

Written by a reviewer in a fresh context (different model) from `goal_requirements.md` and this page only. The planner fills the last column; an empty last column blocks approval.

| # | scenario (input, state, host) | requirement at risk | design answer (change made, or `acceptance/<script>.sh` that catches it) |
|---|---|---|---|
| 1 | `hold(B)` while A's chunks are held; A's chunks arrive while B is held | R1, R2 | `live-stream.js::hold` drops what another session held (already acked); `take` answers `other` for any session but the followed one (written untracked, as today). `test/live-stream.test.js` "other sessions and a switch". |
| 2 | the core restarts: positions start at 0 again, below `written` | R2, U1 | `app.js` clears the stream on `engine:restarting`; the next frame or chunk anchors it again (A-1). |
| 3 | a resync storm: a gap is found again on every resync | U1, R1 | one resync in flight (`resyncLiveStream`), chunks held meanwhile; the batcher joins only consecutive chunks of one session and keeps the last `end` (`test/session-data-batcher.test.js`); `U1_gap_resync.sh` checks one injected loss gives a clean screen. |
| 4 | the lost chunk is the last one: no later chunk shows the gap | U1 | a tail check 700 ms after the last write (or a chunk lost in the renderer) compares `written` with `session.open {frame:false}`'s `position`, and resyncs if still short 700 ms later. `U1_gap_resync.sh` drops a whole burst's tail. A loss above the renderer with no event at all and no prior write within 700 ms is caught at the next output (A-4). |
| 5 | partial presence: frames with `through`, chunks without `end` | U2, R1 | a chunk without `end` turns tracking off (written as it is) until the next chunk with one, which anchors again; worker and client ship in one package, so this mix is not expected. `test/live-stream.test.js` "frame with positions after chunks without them". |
| 6 | joined: `end` (received) runs ahead of `through` (in the mirror) | R3 | by design: a chunk is dropped only when `end ≤ through`, i.e. the mirror holds it; `mirrorBytes` is set in the same chain after each write, also when no mirror exists yet, so it never lags behind a written chunk. `test/stream-positions.test.js`, `R3_joined_exact.sh`. |
| 7 | a stale `session.open` answer for A lands after B was selected | R1, R2 | `selectSession` returns when the selection changed during the await; `renderLiveFrame`'s paint checks a token and the selected id; `stream.frame(A, …)` is a no-op while B is followed. |
| 8 | geometry changes between the snapshot and the paint | R2 | not changed by this project: `renderLiveFrame` fits before painting as today; positions are bytes, independent of the grid. Out of scope. |
| 9 | R5: `hidden` stale or inconsistent with the total | R5, U2 | `count` and `hidden` come from one scan of the same buffers; a session's output re-runs its search (`noteSessionOutputForBufferSearch`); an answer without `hidden` reads "N matches" as before. `R5_hidden_matches.sh`. |
| 10 | R4: order of marks; other states lost with the check | R4 | the only marks are the template mark and the pin; the check meant only "template", so the stamp replaces it with the same tooltip. `R4_template_mark.sh`. |
| 11 | R7: no serif font on the host; "-" vs "−" | R7, R6 | the font list ends in the generic `serif`; `R6_font_labels.sh` resolves the first family with `fc-match` on the host. The button's sign is the existing `fa-minus` icon, unchanged. |
| 12 | held chunks never acked: flow control stalls the frame | R1, U1 | held chunks are acked when held; the frame waits only on the mirror, never on renderer acks. |

| 13 | the "x" pressed in an empty focused box: mousedown blurs it, search mode ends, the click then focuses the box instead of closing | R9 | the icon handles `mousedown` with `preventDefault` (the box keeps focus, so the mode cannot end before the click), and the click acts on the mode read at mousedown. `R8_search_mode.sh` clicks the "x" with an empty focused box. |
| 14 | `.searching` set on `.search-cell` but the border rule reads `.sidebar.searching` | R10 | `syncSearchMode()` sets `.searching` on `.app` (the parent of both); both rules read `.app.searching …`. Design text changed. |
| 15 | a session in both sections: two rows, one id; Down from the id's first row loops on it | R10, U3 | the cursor is a row, not an id: `state.searchCursor = { section, id }`; Down/Up move from that row's index in the drawn rows; the green border goes on the cursor row only (`.search-cursor`), `selected` stays as today. `R10_search_arrows.sh` puts one session in both sections. |
| 16 | the list re-renders mid-search (new match rows, a session ends); `selectSession` focuses the terminal (`app.js:3947`) | R10, U3 | true for the focus: `selectSession(session, { keepFocus: true })` skips `state.term.focus()` (new option, nothing else changes). After a re-render the cursor is found again by `{section, id}`, else by `selectedId`, else none (the next arrow starts at the top). |
| 17 | `>>\|` enabled by `canUseOpenPlayer` while already live | U4 | not so: `canUseOpenPlayer` needs `isPlayback` (`app.js:5479–5480`), false when live, so End is disabled when live. Kept; `R11_history_ends.sh` asserts End disabled when live. |
| 18 | Start with no frame 0 (a joined viewer with no history, a just-started session); with time collapse on, scrubber value 0 is not the first frame | R11, U4 | Start seeks by time, not by scrubber value: `player.seek` with `tsMs` of `state.timeline[0]` (the call of `app.js:5029`), so collapse does not matter; enabled only with `canStepBack && state.timeline.length`. Design text changed. |
| 19 | the toolbar shown again, a theme change or `.live-host`'s other `animation-name` restart the animations out of phase | R12 | phase by the Web Animations API, not a CSS delay: after every `updateTransportControls` (and when `#playback` is shown) each running beacon animation of `#goLive` and `#jumpEnd` gets `startTime = 0`, so all are aligned to the document timeline's origin whatever restarted them or which keyframes they use. Design text changed; `R11_history_ends.sh` compares both animations' `currentTime`. |
| 20 | a grid narrower than the 56-character "See …" line | R13 | `centered()` (`app.js:1211`) and `writeCenteredTerminalText` clip to the line width (no wrap), as for "Written by …"; the block's height does not change, so no scroll. The startup grid is the fixed logo grid. |
| 21 | zero rows, or an end: is the caret moved? | U3 | plain Up/Down in search mode always `preventDefault`, then move if they can; modified keys and IME composition pass through untouched, as today. |

## Questions and assumptions

- **A-1** Positions count bytes per core run, not per recording: a restart starts at 0. The
  renderer treats a backwards `end` as a gap (resync). Other option: persist the count; not needed.
- **A-2** Joined sessions count on the viewer (design A's "second step"); no share wire change, so
  R3 needs no field on the share protocol after all (the out-of-scope row allowed one).
- **A-4** A lost tail is found by a check 700 ms after the last write (or after a chunk lost in
  the renderer); a loss with neither is found at the next output. Other option: poll the position
  every few seconds while live; not taken (an IPC round trip per session per poll).
- **A-3** `ZBTERM_NO_STREAM_POS` exists only to emulate an older core for U2; documented in README's
  environment list.

## Decisions

None hard to reverse: every field is additive and ignored by older consumers.

## Approval

R8–R13 (section above, 2026-11-15): approved by the user 2026-11-15 ("approved, go"), with the readings recapped to them.

R1–R7: not typed on this page. The user said "OK approved go implement" (2026-11-14) on the goal page before
this page existed; the build went ahead on that instruction. The user reads this page with the
report and approves or sends it back.
