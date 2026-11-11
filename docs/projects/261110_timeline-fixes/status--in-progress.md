# Timeline, playback and selection fixes — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-11: P1 and P3 (selection) done; P3 ran before P2. R1, R2, R3 and U1 are green. R4–R7 and U2 still fail on their P1 lines. Next is P2 (time).

## Done

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

- P2 (time): R4 popup, R5 end time (extend or refresh the running session's timeline; the cause is not the trailing-gap cap), R6 Alt+wheel live, R7 compressed clock, U2. R5 needs the design amendment first.
- P4: close.

## Measured

See `baseline.md` and `../261110_ui-chrome/baseline.md`. P1 logs are under `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261110_timeline-fixes/`:
- `p1_R1.log` … `p1_U2.log` are single runs;
- `p1_kit/` and `p1_run_all.txt` are the full kit: 9 FAIL, each on its own `jq -e` line, 7m22s wall;
- `p1_ui-chrome-kit.txt` is the sibling kit: 8/8 PASS after the renderer changes;
- `p1_renderer-static.log` and `p1_lint.log`.
- P3: `p3_R1.log`, `p3_R2.log`, `p3_R3.log`, `p3_U1.log` are single runs. `p3_kit/` and `p3_run_all.txt` are the full kit: R1, R2, R3, U1 PASS; R4, R5, R6, R7, U2 FAIL, each on its P1 line; 8m23s wall. `p3_ui-chrome-kit.txt` is 8/8 PASS. `p3_renderer-static.log` is 34/34 pass, 0 skipped. `p3_lint.log` is exit 0, 95 warnings.

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
- `togglePlay`'s own pause still awaits `player.pause` before `clearPlaybackWrites`, so a packet can land in between. The selection pause does not have this race.
- Xterm's forced-selection mousedown calls `stopPropagation`, so the old bubble-phase terminal mousedown never ran in paused playback with mouse tracking. The capture listener fixes this.

## Soft changes to read back

None.
