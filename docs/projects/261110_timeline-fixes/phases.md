# Timeline, playback and selection fixes — phases (the HOW)

A builder's brief is: `/ubitron/dev/docs/templates/rules.md`, **one** phase section below,
`goal_requirements.md`, `baseline.md`, and the status file. Paths, not pasted bodies.

## Conventions

Same as `../261110_ui-chrome/phases.md` *Conventions* and *Host* (the commands, sidecar, packaged build and `uisolate`), except:
- Logs go under `runs/261110_timeline-fixes/`.
- The kit sources `../261110_ui-chrome/acceptance/lib.sh`.
- This project takes no `D-nn`.

## Order

```
P1  debug commands, recording fixture, kit bodies; reproduce R1/R3/R5   needs: sibling ui-chrome P2 (lib.sh, updateTimeLabels)
P2  time: R4 popup, R5 end time, R6 Alt+wheel live, R7 compressed clock    needs: P1
P3  selection: R1 keep, R2 pause + blink, R3 right-click, U1               needs: P1 (may run before P2)
P4  kit at HEAD, tests, lint, status                                        needs: all
```

## Phase P1: harness and reproduction

**Goal.** The kit runs end to end and is red for the right reasons. The causes of R1, R3 and R5 are written into `design.md` *Causes* as dated blockquotes.
**Code map.**
- `renderer/app.js::window.__zbtermDebugCommand`: add the commands in `design.md` *Interface*.
- Recording fixture: a session in the scratch app that prints lines, sits idle 20 s, then prints more. Run it with `cmd` input and a real wait. No engine fixture.
- `docs/debug_server_howto.md` *Renderer commands*.

**Acceptance.** Every script fails on its own `jq -e` line. The three causes are recorded, each with the log line that shows it.
**Gotchas.** xdotool coordinates come from `ui-state` element rects plus the window origin (`xdotool getwindowgeometry`).

## Phase P2: time

**Goal.** R4, R5, R6, R7, U2.
**Code map.** `renderer/app.js`:
- `updateTimeLabels` (~6020);
- `applyTimeCollapse` and `toggleTimeCollapse` (~7174–7222);
- `getTimeCollapseMap` (~7230);
- `startPlaybackClock`, `tickPlaybackClock`, `currentRunningPlaybackTs`, `freezePlaybackClock`, `updatePlaybackClockFromPacket` (~3883–3940);
- `step` (~3512), `goLive` (~3161).

`renderer/index.html`: `#timeLabel` and a new `#timeLabelTip`.

**Acceptance.** R4–R7 and U2 are green. Lint passes. Add a unit test for the compressed clock mapping in `test/renderer-static.test.js`, or a new pure-function test.
**Gotchas.** Every place that reads the running clock (`currentRunningPlaybackTs`, `freezePlaybackClock`, `changePlaybackSpeed`, `toggleTimeCollapse`) must use the same compressed-time rule, or a toggle mid-play jumps.

## Phase P3: selection

**Goal.** R1, R2, R3, U1.
**Code map.**
- `renderer/app.js`:
  - `renderFrame` (~2968), `resetVisibleTerminal`;
  - the terminal `mousedown` (~778) and `copySelectionOnPointerUp` (~6959);
  - `openTerminalMenu` (~2547), `copyTerminalSelection` (~2730);
  - `enablePausedTerminalSelection` (~2795);
  - the play/pause button's update in `updateTransportControls`.
- `renderer/index.html`: `.selection-paused` and its keyframes.

**Acceptance.** R1, R2, R3 and U1 are green. Lint passes.
**Gotchas.**
- xterm's selection service only selects while playing if `shouldForceSelection` says so. The pause must land before the drag is lost.
- In a program that owns the mouse, R3 depends on the forced selection (`selectDraggedCells`).

## Phase P4: close

1. Repackage, then run `acceptance/run_all.sh` at HEAD.
2. Run the test files one by one, then `npm run lint`.
3. Rename the status file to `status--verifying.md`.

## Do not

- Never lower a tolerance, weaken an assertion or re-bless a count to get green.
- No new dependencies. Do not patch xterm in `node_modules`.
- Leave `engine/player.js` alone unless P1 shows the bug is there; that becomes a soft change, recorded.
- Do not touch the main checkout's working tree.
