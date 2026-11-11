# Timeline, playback and selection fixes — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-11: P1 done (harness and reproduction). The kit runs end to end and every script fails on its own `jq -e` line. The causes of R1, R3 and R5 are in `design.md` *Causes* (dated blockquotes, with log lines). No fix has been made. Next is P2 (time) or P3 (selection); either may go first.

## Done

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

- P2 (time): R4 popup, R5 end time (extend or refresh the running session's timeline; the cause is not the trailing-gap cap), R6 Alt+wheel live, R7 compressed clock, U2.
- P3 (selection): R1 keep across same-frame re-renders (the seek path as well as `step`), R2 pause and blink, R3 keep on a right press in a mouse-owning program (the saved-selection design covers it), U1.

## Measured

See `baseline.md` and `../261110_ui-chrome/baseline.md`. P1 logs are under `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261110_timeline-fixes/`:
- `p1_R1.log` … `p1_U2.log` are single runs;
- `p1_kit/` and `p1_run_all.txt` are the full kit: 9 FAIL, each on its own `jq -e` line, 7m22s wall;
- `p1_ui-chrome-kit.txt` is the sibling kit: 8/8 PASS after the renderer changes;
- `p1_renderer-static.log` and `p1_lint.log`.

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

- Seen in P1, not failing any row today: every frame step renders its frame twice (`player:frame` event and `step`). After a selection the app forced, the next drag's xterm listeners are removed by `clearSelection()` at `app.js:799`. See `design.md` *Causes*, R1.

## Soft changes to read back

None.
