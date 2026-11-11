# Timeline, playback and selection fixes — design (one page)

**Serves:** `goal_requirements.md` R1–R7, U1–U2 · **Written:** 2026-11-10 · **Reviewed:** 2026-11-10, Sonnet 5.5, fresh context (13 rows below, answered) · **Approved:** see end.

## Causes (read from the code, 2026-11-10; P1 reproduces each before any fix)

| row | cause | status |
|---|---|---|
| R7 | `tickPlaybackClock` advances the clock in *real* time. `buildTimeCollapseBreakpoints` maps a gap of length g to `min(g, threshold)`, so inside a long gap `realToCompressed` moves at `threshold/g` of the speed: the current time stalls. The engine player (`_playheadTsMs`) already jumps the gap after `threshold`, so the screen and the clock disagree. | confirmed by reading |
| R6 | `step(delta)` (`renderer/app.js` ~3512) never goes live. Only `commitScrub` (~3539) calls `goLive()` at `SCRUBBER_STEPS` for an active session. | confirmed by reading |
| R4 | `updateTimeLabels` rewrites `els.timeLabel.title` on every clock frame (`requestAnimationFrame`). Chromium re-shows a native tooltip whose text changes, so it blinks. The text also reads "Ucompresses". | likely |
| R5 | For a running session `currentPlaybackEndTs()` is `Date.now()`, so the trailing idle gap is capped at `threshold` and the total stops growing; or the cache in `getTimeCollapseMap` is stale after `applyTimeCollapse`. | to reproduce |
| R1 | Every `renderFrame` calls `resetVisibleTerminal()`, which clears the xterm selection. A re-render of the *same* frame (fit, resize, a late packet, a clock refresh) wipes a fresh selection. | to reproduce |
| R3 | Not xterm itself: its selection service ignores a right press while a selection exists. Candidates: a program that owns the mouse gets the right press and redraws; live output or `renderLiveFrame` resets the screen. | to reproduce in a plain shell and in a mouse-owning program |

## Interface

- **Clock** (R7). One pair of helpers is the only reader and writer of the running clock:
  - `anchorClock(realTs)` sets `clockStartedTs`, `clockStartedComp` and `clockStartedAt`;
  - `runningClockTs()` returns `compressedToReal(map, clockStartedComp + elapsed × speed)` while collapse is on, and today's real-time sum otherwise.

  `startPlaybackClock`, `tickPlaybackClock`, `currentRunningPlaybackTs`, `freezePlaybackClock`, `changePlaybackSpeed`, `toggleTimeCollapse` and `updatePlaybackClockFromPacket` call these two and nothing else.
  - Inside a gap the compressed clock is clamped just below the next breakpoint until that packet arrives, so it never shows a frame's time before the frame and never steps back.
  - For a running session the map is rebuilt at most once a second, not on every frame.
- **Popup** (R4):
  - `#timeLabel` loses its `title`.
  - A tip element, `#timeLabelTip`, is `position: fixed` with `pointer-events: none`, kept inside the viewport and shown on hover while collapse is on.
  - Its text is set only when the string changes, and reads `Uncompressed: <cur> / <total>`.
  - The label's own text is also assigned only on change.
- **End time** (R5). The total comes from the map built for the current end on every call. `applyTimeCollapse` invalidates the map. `toggleTimeCollapse` keeps the clock's exact ts, not the scrubber's rounded one (`updateDragTime`). P1 also logs `playbackClockTs` before and after a toggle.
- **Frame step** (R6, U2). In `step(delta)` with `delta > 0`, remember the `seq` before the step. If `player.step` returns the same `seq`, the step was asked for at the last frame. An active session then calls `goLive()`; an ended one stays put. Stepping *onto* the last frame stays in playback, and a coalesced `step(+5)` from last−2 lands on last without going live.
- **Selection** (R1, R2, U1):
  - In `renderFrame`, when `seq`, cols and rows are unchanged, the selection (start, end) is saved before the reset. It is re-selected inside the `write` callback, with the length computed from start, end and cols. Otherwise it is dropped (A-1).
  - `copySelectionOnPointerUp` builds the forced selection whatever `copyOnSelect` is set to. Only the clipboard write depends on that setting.
  - Pause for selection: a left drag that *starts in the terminal*, of at least `SELECTION_DRAG_MIN_PX`, while playing.
    - It pauses synchronously: `freezePlaybackClock()`, a flag, and `clearPlaybackWrites()` before any awaited call.
    - Then it selects from the drag anchor with `select()`, as `selectDraggedCells` does, so the selection exists even though xterm saw the mousedown while playing.
    - A plain click does nothing (U1).
- **Paused-for-selection mark** (R2). `updateTransportControls` derives the class from state: paused and paused by selection and `hasSelection()` gives `selection-paused`. Every path that changes the frame or mode therefore clears it. The icon becomes `fa-i-cursor` in `var(--terminal-selection)`, with a CSS blink animation.
- **Right-click** (R3).
  - A `mousedown` capture listener for `button === 2` saves `{ text, start, end }`.
  - On `contextmenu` the highlight is restored with `select()`, and Copy is enabled from the saved text.
  - Copy writes the saved text even if the highlight was lost after the menu opened.
- **Debug commands** (on top of the sibling's `ui-state`):
  - `selection-state`: `{ has, text }`;
  - `terminal-menu-state`: `{ open, copyEnabled }`;
  - `time-labels`: `{ current, total, popupText, popupShown }`;
  - `playback-state`: `{ mode, playing, clockTs, seq, lastSeq, pauseReason }`;
  - `popup-shows`: hidden-to-shown changes of `#timeLabelTip`, plus mutation records on its subtree, since the last call;
  - `style-of` (`{ selector }`): `animationName`, `color` and the number of animations, for the blink.

## Data and state

Nothing is persisted. The new state is all in the renderer and lasts the session: `state.clockStartedComp`, `state.selectionPaused`, `state.rightClickSelection`.

## Refuses

- The Alt+wheel go-live does nothing on an ended session (U2).
- The pause-for-selection does nothing in live mode, or when paused already.

## The reference program, step by step

Each script follows the same shape:
1. Run `start_app` (sibling's `lib.sh`).
2. Seed a session with a scripted recording: lines, a 20 s idle gap, more lines.
3. Drive it with `cmd` and real input from `xdotool` (`mousedown`, `mousemove`, `mouseup`, `click 3`, `key`, wheel buttons 4/5 with `keydown alt`).
4. Assert with `jq -e` on the debug commands.

R5 uses an *ended* session recorded with fixed sleeps, so its compressed total is a constant written in the script, not one computed by the app's own rule. R3 and R1 run in a plain shell and in a mouse-owning program (`less` with `--mouse`), with output arriving between the selection and the click.

## Failure scenarios

| # | scenario | at risk | design answer |
|---|---|---|---|
| 1 | The R3 cause is wrong: xterm keeps a selection on a right press; a mouse-owning program or live output clears it. A check in a quiet shell passes while the bug stays. | R3 | Cause table corrected. P1 logs `hasSelection()` at mousedown, mouseup, contextmenu and menu open. R3 runs in a plain shell and in `less --mouse`, with output between selection and click. The highlight is restored on `contextmenu`. |
| 2 | Going live when the returned frame *is* the last means one can never rest on it; a coalesced `step(+5)` overshoots. | R6, U2 | Live only when `player.step` returns the same `seq` (the step was asked for at the last frame). R6 also steps onto the last frame and asserts it is still in playback. |
| 3 | The compressed clock outruns the packet in a gap, then the packet re-anchor steps it back. | R7 | Clamped below the next breakpoint until the packet arrives; one `anchorClock`. R7 samples `clockTs` every 100 ms through the gap and asserts it is monotonic and moving. |
| 4 | Other clock readers stay in real units; pause or toggle mid-gap saves a wrong ts. The map is rebuilt at 60 Hz for a running session. | R7, R5 | `runningClockTs()` is the only reader. The map is rebuilt at most once a second. R7 pauses mid-gap, plays, and asserts no jump. |
| 5 | Restoring the selection after `renderFrame` reflows, or runs before the write lands, highlights the wrong cells. | R1 | Restore inside the write callback, only with `seq`, cols and rows unchanged. R1 asserts the exact text, and includes a resize. |
| 6 | With copy-on-select off, no forced selection is built in mouse-owning programs. | R1–R3 | The selection is built regardless; only the clipboard write is conditional. R1 and R3 run with the setting off as well. |
| 7 | The pause lands after the mousedown and packets overwrite the drag; a drag from the scrubber into the terminal pauses. | R2, U1 | Synchronous freeze, then select from the anchor. Only drags that start in the terminal count. U1 adds a drag from the scrubber into the terminal. |
| 8 | `popup-shows` misses flicker from text or position rewrites; a class can pass without a visible blink. | R4, R2 | Mutation records and two rect samples in R4. In R2, `style-of` asserts `animationName`, the colour and a running animation. |
| 9 | The R4 cause is untested, and a custom tip can be clipped by the bar or hidden on `mouseleave`. | R4 | P1 reproduces it. The tip is `position: fixed`, `pointer-events: none`, kept inside the viewport, with text set on change only. R4 asserts its rect is inside the viewport. |
| 10 | The R5 check is circular (same rule as the app), and the scrubber rounding in a toggle is a likely cause. | R5 | Ended session with a fixed constant; toggle off, on, off, on and assert the same total each time; the toggle keeps the exact clock ts. |
| 11 | `state.timeline` lags for a running session, so "last `seq`" is stale. | R6 | Detection uses the `player.step` result only (row 2). |
| 12 | The blink outlives a step or session switch. | R2 | The class is derived from state in `updateTransportControls`. R2 steps with Alt+wheel and asserts the class is gone. |
| 13 | A late clear after the menu opens loses the highlight or the text; a left click while the menu is open clears it. | R3 | Copy uses the saved text. R3 clicks Copy after the menu has been open for 2 s. |

## Questions and assumptions

- **A-0** The project relies on xterm's private `_core._selectionService` (already used at `renderer/app.js:2795`). An xterm upgrade must re-run R1–R3.

- **A-1** A selection is dropped when the frame changes (seek, step, play), because the text under it changed. Otherwise it stays only until the user clears it.
- **A-2** In compressed playback an empty stretch plays for the threshold (as drawn on the compressed timeline) with the clock moving. The alternative is to skip it outright, which would also change the timeline drawing.
- **A-3** The blink is a 1 s opacity pulse, and it stops when playback resumes. The caret is `fa-i-cursor`.
- **A-4** The auto-pause starts on the drag, not on the mousedown, so U1's plain click (which also focuses the terminal) never pauses.

## Decisions

None. Nothing here is hard to reverse.

## Approval

Approved 2026-11-11 by the user ("approved" in chat, covering all three projects), file at sha256 c27b7e7abd94 (the file as approved, before this line).
