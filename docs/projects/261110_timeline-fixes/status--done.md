# Timeline, playback and selection fixes — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

done, 2026-11-11: the user said "Done for now, we will do bug fixes later" (2026-11-11, in chat) after the three soft changes were read back to them. Verifier report `acceptance/report--2026-11-11.md`: GREEN 9/9 at e487c53 on `zr`. The Open items below are deferred to a later bug-fix project.

## Done

- 2026-11-11 builder P4 (`renderer/app.js`, `renderer/time-collapse.js`, `test/time-collapse.test.js`, `README.md`, `docs/ARCHITECTURE.md`):
  - R5 margin: a running session's labels showed up to 1 s late (free-running 1 s timer) and, between map rebuilds, an in-place end past the threshold dropped time. `startSessionClock` now ticks just after the shown total's next second (`msToNextSecond`); `retargetTimeCollapseMap(..., pending)` asks for a rebuild in that case. Two new tests failed first. Soft change, recorded.
  - README *Implemented* gained compressed time, Alt+wheel and selection bullets; ARCHITECTURE §11 a paragraph on collapsed time (player re-anchor, renderer map).
  - Packaged boot: the kits ran the P4 package under `uisolate`; the sidecar booted and recorded sessions in every script.
  - No kit corrections. No `D-nn` (the project takes none).
- 2026-11-11 builder P2 (`renderer/app.js`, `renderer/index.html`, new `renderer/time-collapse.js`, `engine/player.js`; tests `test/time-collapse.test.js`, a new case in `test/player.test.js`, a new case in `test/renderer-static.test.js`):
  - R7: the running clock has one writer, `anchorClock`, and one reader, `runningClockTs`. With collapse on it advances on the compressed timeline (`compressedClockTs`), so a gap passes in the threshold with the time moving. It is held just below the next packet until that packet lands, so it never steps back. `startPlaybackClock`, `freezePlaybackClock`, `tickPlaybackClock`, `changePlaybackSpeed`, `toggleTimeCollapse` and `updatePlaybackClockFromPacket` use only these two. `engine/player.js` now re-anchors its playhead after jumping a collapsed gap; before, the packets after a gap stalled for (gap - threshold). This is a soft change.
  - R5: the map, the compressed timeline and its clock functions now live in `renderer/time-collapse.js` (`window.zbtermTimeCollapse`). The map takes in live output times (`state.liveTimeline`, fed from `session:data`, reset by `setTimeline`). It is rebuilt at most once a second; in between only its end moves to "now", in place. `toggleTimeCollapse` keeps the clock's exact ts. This is a soft change (the planner's decision).
  - R4: `#timeLabel` has no `title`. `#timeLabelTip` is `position: fixed` with `pointer-events: none`. It is shown and placed once on mouseenter and hidden on mouseleave. Its text node changes only when the text changes, and it reads `Uncompressed: <cur> / <total>`. The label's own text is also written only on change.
  - R6/U2: in `step(delta > 0)`, if `player.step` returns the frame already shown, a running session goes live and an ended one stays put. This also applies to the Step forward button.
  - The pause race: `togglePlay`'s pause freezes the clock, sets `state.playbackPaused`, clears queued writes and only then awaits `player.pause`. `player:data` is dropped while that flag is set, and every `player.play` (`invokePlayerPlay`) clears it.
  - No kit corrections.
- 2026-11-11 builder P3 (`renderer/app.js`, `renderer/index.html`):
  - R1: `renderFrame` keeps the selection when it re-renders the frame already shown (same `seq`, cols and rows). It saves the range before the reset and re-selects it in the write's callback (`selectionToKeep`). A restore still waiting on an earlier render of the same frame carries over. `resetVisibleTerminal` voids it.
  - R2: a left drag that starts in the terminal while playing pauses once it has moved `SELECTION_DRAG_MIN_PX` (`handleTerminalDragMove`). The pause is synchronous: freeze, `state.selectionPaused`, `clearPlaybackWrites`, then `player.pause`. `player:data` is dropped while paused for a selection. With mouse tracking on, the selection is built from the drag anchor. `updateTransportControls` derives `selection-paused` (an `fa-i-cursor` caret in `--terminal-selection` with a 1 s opacity blink) from paused + flag + `hasSelection()`. It is redrawn on selection change, and the flag clears on resume, on a mode change, or when a different frame renders.
  - R3: the terminal's mousedown listener now runs in the capture phase (`handleTerminalMouseDown`), before xterm's. On a right press it saves `{text, start, end}`. `openTerminalMenu` restores the highlight and enables Copy from the saved text. A one-shot window mouseup restores it again after xterm reports the release, which clears it a second time. Copy writes the saved text.
  - The forced-selection `clearSelection()` now runs before xterm's mousedown (the P1 *Open* item). `copySelectionOnPointerUp` builds the forced selection whatever copy on select is set to; only the clipboard write depends on it.
  - The drag's mousemove listener is on the window in the capture phase, because xterm's selection calls `stopImmediatePropagation` on a drag's mousemove at the document.
  - No kit corrections.
- 2026-11-11 builder P1:
  - `renderer/app.js` gained the kit's debug commands: `selection-state`, `terminal-menu-state`, `time-labels`, `playback-state`, `popup-shows`, `style-of` and `selection-log`. They are reads and observers only, and they are listed in `docs/debug_server_howto.md` *Renderer commands*.
  - `acceptance/tf.sh` holds the helpers and fixtures, and the nine script bodies are written.
  - Causes:
    - R1: a seek onto the same frame re-renders it and clears the selection.
    - R3: xterm reports the right press to a mouse-owning program as typed input, and its selection service clears on typed input.
    - R5: live output never extends `state.timeline`, so the compressed total stalls.
  - R4, R6 and R7 are confirmed by their scripts.
  - Kit corrections in R1, R5, R7, U1 and U2 are dated in each script and in `acceptance/README.md`.
- 2026-11-11 planner: approval lines written (user said "approved" in chat).
- 2026-11-10 planner: project files; *Causes* read from the code (R6, R7 confirmed by reading); review (Sonnet, fresh context, 13 rows, answered; R3 cause corrected).

## Next

- Verifier: run `acceptance/run_all.sh` on a fresh package; read the soft changes back to the user.

## Measured

See `baseline.md` and `../261110_ui-chrome/baseline.md`. P1 logs are under `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261110_timeline-fixes/`:
- `p1_R1.log` … `p1_U2.log` are single runs;
- `p1_kit/` and `p1_run_all.txt` are the full kit: 9 FAIL, each on its own `jq -e` line, 7m22s wall;
- `p1_ui-chrome-kit.txt` is the sibling kit: 8/8 PASS after the renderer changes;
- `p1_renderer-static.log` and `p1_lint.log`.
- P2: `p2_R4.log` … `p2_U2.log` are single runs, all exit 0. `p2_player-before.log` is the new player case failing before the engine fix; `p2_player.log` is 17/17 pass. `p2_time-collapse.log` is 7/7 pass. `p2_renderer-static.log` is 35/35 pass, 0 skipped. `p2_lint.log` is exit 0 with 95 warnings. `p2_kit/` with `p2_run_all.txt` is the full kit: 9/9 PASS in 526 s wall. `p2_uichrome_kit/` with `p2_ui-chrome-kit.txt` is the sibling kit: 8/8 PASS.
- P3: `p3_R1.log`, `p3_R2.log`, `p3_R3.log`, `p3_U1.log` are single runs. `p3_kit/` and `p3_run_all.txt` are the full kit: R1, R2, R3, U1 PASS; R4, R5, R6, R7, U2 FAIL, each on its P1 line; 8m23s wall. `p3_ui-chrome-kit.txt` is 8/8 PASS. `p3_renderer-static.log` is 34/34 pass, 0 skipped. `p3_lint.log` is exit 0, 95 warnings.

- P4: `p4_package.log`, `p4_package2.log` (after the fix), exit 0. `p4_R5_run{1,2,3}.log` before the fix: exit 0, last running check 16 s for 17 s each time. `p4_time-collapse-before.log`: the two new cases fail. `p4_R5_fix_run{1,2,3}.log` after: exit 0, every running check exact. `p4_time-collapse.log` 9/9 pass. `p4_kit/` with `p4_run_all.txt`: 9/9 PASS, 8m44s wall. `p4_uichrome_kit/` with `p4_ui-chrome-kit.txt`: 8/8 PASS, 1m57s. `p4_lint.log`: exit 0, 95 warnings (same as P2). `p4_tests/` (54 files, one per run, `summary.txt`): 51 files exit 0; 411/413 tests pass, 0 skipped, 0 todo; `zxterm-seam` aborts. The three failing files are host issues outside this project's diff: `doctor` (no `DISPLAY` in a non-GUI shell; no staged `npm/` binary in the worktree), `native-linkage` (its libnode fixture case), `zxterm-seam` (`no such seam method: test.echo` from the staged sidecar).

## Gotchas

- Same as `../261110_session-templates/status--design.md` *Gotchas* (sidecar path, worktree, main checkout left alone).
- Runs after `261110_ui-chrome` P2: both change `updateTimeLabels`.
- Never select an ended session's row in a kit script: a closed session is extended on entry and goes live. The ended-session fixtures stay selected from creation.
- `settings-click` leaves the settings menu open over the terminal, where a later drag hits it. `tf.sh::set_copy_on_select` closes it.
- Each `xdo`/`uisolate run` call costs about a second; U2 and R1 take 2–3 min each.

## Ids allocated

None.

## User owes

None.

## Open

- Every frame step still renders its frame twice (`player:frame` event and `step`). It is harmless to R1 now: the second render is the same frame and keeps the selection.
- Resume after a pause mid-gap, with collapse on: the engine resumes from its last packet, not from where the clock was paused, so it plays the gap's full threshold again. The compressed clock then waits just below the next packet for the time it had already played (no step back). R7 passes (it checks the first 0.3 s after resume). The same mismatch exists with collapse off, where the clock steps back on the next packet. It is older than this project.
- A running session in *playback* still uses the timeline from `player.open`; only live mode takes in new output for the collapse map.
- Xterm's forced-selection mousedown calls `stopPropagation`, so the old bubble-phase terminal mousedown never ran in paused playback with mouse tracking. The capture listener fixes this.
- Host-only test failures, not from this project: `test/doctor.test.js` (2 asserts), `test/native-linkage.test.js` (1 case), `test/zxterm-seam.test.js` (abort at `test.echo`); logs in `runs/261110_timeline-fixes/p4_tests/`.

## Soft changes to read back

All three are in `notes--context.md` *Soft changes*, dated 2026-11-11:
- R5: the collapse map takes in a running session's live output, rebuilt at most once a second.
- R7: `engine/player.js` re-anchors its playhead after a collapsed gap (the goal's *Out of scope* exception; the evidence was found in P2, not P1).
- R5 (P4): a running session's time labels tick on the shown second, and the map rebuilds when its in-place end would drop time; the check is unchanged.
