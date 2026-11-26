# 261125_speed-and-keys — phases (the HOW)

A builder's brief is: `/zp/zdata/work/ubitron/dev/docs/templates/rules.md`, the repo's `AGENTS.md`,
**one** phase section below, `goal_requirements.md`, `design.md`, `baseline.md`, and the status file.

## Conventions

- Work in the main checkout `/zp/zdata/zeev/github/zbterm`, shell at the repo root: no worktree,
  no copy of the repo, no `git stash`/`checkout`, no git write at all. The tree holds the user's
  uncommitted work (`baseline.md` *Working tree*): edit around it, never revert it.
- `renderer/app.js` is ~13 800 lines: grep it, read ranges, never the whole file.
- npm only. One test file per run: `HOME=<scratch> TMPDIR=/tmp/zb25 npx brittle-node test/<file>.test.js`,
  ≤ 3 min each. Lint: `npm run lint` (≤ 3 min); `npm run format` fixes style.
- Package for the kit: `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zblive/out npm run package` (≤ 15 min),
  after every renderer, engine or main-process change that a kit script is to see.
- A kit script: `timeout 240 docs/projects/261125_speed-and-keys/acceptance/<script>.sh`; the whole
  kit `timeout 1500 …/run_all.sh`. Every app instance on its own `uisolate` display with scratch
  HOME/storage (`acceptance/activate` does it). Signal only PIDs you started.
- Logs: `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261125_speed-and-keys/`.
- Time: every command carries a timeout; a phase is at most 60 minutes of work; over that, write
  the status file and report what is left.
- Deletes: only what you created, by literal absolute path, with
  `/ubitron/dev/.venv/bin/python -m ubitron.envs.safe_delete <path>`.
- A builder writes the status file (*Done*, *Gotchas*, *Soft changes to read back*) before stopping
  and never declares the work done; the verifier does.

**Host.** `zr` (Linux, X11): `uisolate`, `xdotool`, `jq`, `curl`, `npm`, the packaged build at
`$ZBUI_APP`, the sidecar at `$ZXTERM_CORE_BIN` (both set by `acceptance/activate`).

## Order

```
P0  baseline (done 2026-11-25, baseline.md)                       needs: —
P1  the perf probe, the big-timeline fixture, R1*/R2 scripts red   needs: P0
P2  typing: scheduled scrubber                                     needs: P1
P2b engine: timeline.json flushed at most 1/s, not per packet      needs: P2 (found in P2, planner 2026-11-25)
P3  switching: lazy timeline, switch generation                    needs: P2b
PR  build and release of the speed fixes (the user, 2026-11-25)     needs: P2, P3
P4  Ctrl+D and the toast                                           needs: — (after P3: same file)
P5  the two search states                                          needs: P4
P6  package, run_all.sh, README/CHANGELOG, status                  needs: all
```
All phases edit `renderer/app.js`, so they run one after another, never in parallel.

## Phase P0: baseline

Done: `baseline.md`, measured by a read-only agent on 2026-11-25; scripts kept under the runs dir `p0/`.

## Phase P1: probe, fixture and the two speed scripts

**Goal.** The kit can time a switch and a key echo on a packaged build, on a store with a
200 000-entry timeline, and says RED on today's code for the reason in `baseline.md`.
**Covers.** The checks of R1, R2, U3, U4 (not their fixes); design *Interface* `perf`.
**Code map.** `renderer/app.js`: the debug command dispatch (`if (command === 'search-mode') return debugSearchMode()`, ~l.13628; `debugSearchState` l.12860 is the model for a read-only command); the document keydown handler l.1549–1694 (stamp the switch's keydown at the `PageUp`/`PageDown` branch l.1641); `selectSession` l.5458, `renderLiveFrame` l.5674, `renderFrame` l.5623 (the frame write whose render ends a switch); `state.term.onData` l.1086 and xterm's `onWriteParsed`/`onRender` for the echo. Kit: copy the shape of `../261121_improvements-and-fixes/acceptance/R2_search_keys.sh`; harness `../261110_ui-chrome/acceptance/lib.sh` (`start_app`, `cmd`, `key`, `wait_until`), `../261113_ui-polish/acceptance/lib_up.sh`, `../261121_improvements-and-fixes/acceptance/lib_if.sh`, reused unchanged; new helpers in `acceptance/lib_sk.sh`. Fixture: the P0 store recipe is `runs/…/p0/seed.sh`; the timeline file is `timeline.json` in the session's directory under the scratch storage (find one after seeding; entries `{seq, tsMs, hd}`), rewritten with the app stopped.
**Steps.** 1 Add the `perf` command (start resets; read returns `longTasks` from a `PerformanceObserver('longtask')`, `switches`, `echoes`). 2 `lib_sk.sh`: `seed_big_timeline <sessionId> <entries>`, `perf_start`, `perf_read`, `median`. 3 Write `R1_switch_speed.sh`, `R1_many_profiles.sh` and `R2_typing_speed.sh` per their headers (both header lines: *Asserts* and *Also*) and design *reference program* steps 1–2. 4 Package, run both.
**Acceptance.** `npm run lint` exits 0; both scripts run to their timing assertions and FAIL there on this build (quote the measured numbers in the status file); every non-timing assertion in them passes.
**Gotchas.** The probe must cost nothing when not started. A long-task observer needs `PerformanceObserver.supportedEntryTypes` to include `longtask` (Chromium does). If the engine regenerates or rejects a hand-written `timeline.json`, stop and report: the fixture then needs a real recording and the plan changes.

## Phase P2: typing

**Goal.** A key typed in a live session with a 200k-entry timeline echoes as on a small one.
**Covers.** R2, U4; design *Interface* first bullet; A-2.
**Code map.** `renderer/app.js`: `api.on('session:data')` l.1770–1791; `updateLiveClock` l.7032 (ends in `updateTimeLabels()` and `updateTransportControls()`: the double run); `updateTransportControls` l.7074 calls `renderScrubberIndicators()` at ~l.7221; `renderScrubberIndicators` l.9313; `timelineActivityMap` l.9361; `idleSegments` l.9588; `sessionHasHd` l.7332; `getTimeCollapseMap` l.11753; `setTimeline` l.7688 (the one place the timeline array is replaced: reset the caches there).
**Steps.** Schedule instead of call; cache the timeline-sized inputs; keep an immediate run where a user action needs the scrubber right now (a seek, a drag, a switch's final draw).
**Acceptance.** `acceptance/R2_typing_speed.sh` exits 0; `test/renderer-static.test.js` and any test file naming the touched functions pass; lint.
**Gotchas.** Tests and older kits read the scrubber's marks right after an action: a mark that is 250 ms late may break them; find them (`grep -rn "idle\|scrubber" test/ | head`) before choosing where to stay synchronous. Playback (`updatePlaybackClock`) runs through the same function at frame rate.

## Phase P3: switching

**Goal.** A switch draws the target at the same speed whatever its history; a held Ctrl+PgDn ends where it should.
**Covers.** R1, U3; design *Interface* bullets 2–4; Q-2.
**Code map.** `engine/index.js`: the invoke table l.292 (`session.open` → `openSession(args.sessionId, args)`), l.309 (`player.open` → `openPlayer`), `_sessionState` l.2310 (`timeline: runtime.store.timeline`). `renderer/app.js`: `switchSessionRelative` l.5364, `selectSession` l.5458–5547 (`session.open` at ~l.5513, stale guard after it), `openPlayback` l.5550 (`player.open`, `setTimeline(player.timeline)`, `player.seek` with the saved position), `clearCaches` l.5881, `api.on('engine:restarting')` l.1793, `setTimeline` l.7688, `configureScrubber`. `electron/debug-server.js` l.207, 273, 389, 398 call both opens without the option and must keep getting `timeline`.
**Steps.** Engine: the `timeline: 'lazy'` option and `session.timeline` with the last-`tsMs` check (design F4). Renderer per design F3, F5–F7: Renderer: the cache, the sliced fetch, `state.switchSeq` checked after every await, stepping from the last requested target. A unit test for the engine half beside the existing engine tests.
**Acceptance.** `acceptance/R1_switch_speed.sh` exits 0; `R2_typing_speed.sh` still 0; the new engine test and lint pass; the packaged app boots (the kit's `start_app` proves it).
**Gotchas.** Playback needs the timeline for stepping and for the scrubber's range: while the fetch runs, the frame and the saved position must already be right, and the transport buttons that need the timeline stay disabled until it is in. A live session's timeline grows in the engine while cached in the renderer: fetch from the cached length on every open. `engine/` changes: check in the packaged build (AGENTS.md).

## Phase PR: build and release of the speed fixes

**Goal.** The user gets the two speed fixes now (their words, 2026-11-25: "add a build and release
after the first fix because this is urgent"). **Covers.** R1, R2, U3, U4 shipped.
**Steps.** Fresh verifier on `R1_switch_speed.sh`, `R1_many_profiles.sh`, `R2_typing_speed.sh`
(report saved as `acceptance/report--<date>-speed.md`); CHANGELOG entry; then the release itself
only in the form the user names at that point (version, channel: `docs/RELEASING.md`,
`agent_docs/releases.md`) — a tag, publish or release is never done without that explicit word.
**Gotchas.** The working tree holds the user's own uncommitted work (`baseline.md` *Working tree*):
what goes into the release is the user's call.

## Phase P4: Ctrl+D and the toast

**Goal.** Ctrl+D deletes the closed session where Ctrl+R would resume it.
**Covers.** R3, R4, R5, U1, U2; A-1.
**Code map.** `renderer/app.js`: `RESUME_HINT_TOAST` l.127; the Ctrl+R branch l.1634–1640 (the model: same guard `isOfflineResumable()`, `event.repeat` ignored, `sidePaneBlocked()` respected); `deleteSession` l.5839 (ends in `showNoSessionSelected()`); `sessionRowsInOrder` l.11047; `selectSession(…, { extend: false })`; `askConfirm` l.8973. `test/renderer-static.test.js` and `README.md` l.84 quote the toast text. `electron/main.js` l.1651–1690 explains which Ctrl chords the menu leaves to the page.
**Steps.** The key with its guards (design F1, F2: no repeat, no open dialog, no undrawn switch, the id captured); the neighbour selection (F13); the toast text; a unit test that joined and pending sessions never pass the guard; the script `R3_delete_key.sh` per its header.
**Acceptance.** `acceptance/R3_delete_key.sh` exits 0; `test/renderer-static.test.js` passes; lint.
**Gotchas.** The search-box half of the script (focus kept after Ctrl+D) belongs to P5: P4's script leaves that block for P5 to add.

## Phase P5: the two search states

**Goal.** Design *Interface* key table holds; the third state cannot be reached (design F9–F14).
**Covers.** R6–R11; Q-1; A-3, A-4, A-6.
**Code map.** `renderer/app.js`: the box's keydown l.1405–1426 (the Enter/resume overload at l.1412); the document handler's Ctrl+R l.1634, PageUp/PageDown l.1641–1653, Esc l.1655–1674; `switchSessionRelative` l.5364; `selectSession` l.5458 (`keepFocus`, `term.focus()` l.5498); `focusPrimaryTarget` ~l.11945; `guard` ~l.11937; `handleTerminalMouseDown` l.10461 (`leaveSearchForTerminal` l.10963); `searchIsOn` l.10957, `searchModeOn` l.11009, `syncSearchMode` l.11013; `moveSearchSelection` l.11100; `SEARCH_COUNT_HINT` and `updateSearchCount` l.11129–11164; `renderSessions` l.3004 (the "Current session" heading; the same title strings are keys in `SEARCH_SECTION_KEYS` l.3122, `sessionRowsInOrder` l.11048 and a third map ~l.12671); `debugSearchState` l.12860 and `debugSearchMode` l.13212 (extend them for the script's assertions). README l.81–103 describes the keys.
**Steps.** The `state.searchActive` flag; the terminal `focusin` rule and the box's `blur` rule; the exits (new/joined session, Ctrl+1..9); focus returns; Enter; the status line; the heading; Ctrl+PgUp/PgDn outside search over drawn rows; `R6_search_states.sh` and the search block of `R3_delete_key.sh`.
**Acceptance.** `acceptance/R6_search_states.sh` and `R3_delete_key.sh` exit 0; `test/renderer-static.test.js` passes (assertions on replaced behaviour updated, each with a dated comment); lint.
**Gotchas.** xterm focuses its hidden textarea on many paths (a click, `term.focus()` in `clearSearch`, `guard`): the `focusin` rule must not recurse through `clearSearch`. A window that loses and regains the OS focus fires `focusin` on the element that had it: the box stays the box. The reorder guard (`armSessionReorderGuard`) blocks clicks for a moment after the list changes: row-click steps wait for it.

## Phase P6: package, kit, docs

**Goal.** A fresh package, `run_all.sh` at the final tree, the manual in step.
**Covers.** all rows; A-5.
**Steps.** README key section and CHANGELOG entry; `agent_docs/` only if a descriptive statement became false; package; `timeout 1500 acceptance/run_all.sh`; `npm run lint`; the test files touched by P1–P5, one per run; status file.
**Acceptance.** Every kit script PASS in the builder's own run (the verifier's run is the one that counts); lint 0.

## Do not

- No git writes, no publish, no version bump, no new dependency, no asar, no new CLI flag.
- Do not touch the user's stores (`~/.config/ZBTerm`), nor signal a process this phase did not start.
- Do not edit earlier projects' kits or reports (A-6).
- Never lower a threshold, weaken an assertion or re-bless a count to get green; a threshold that
  cannot be met is a report to the orchestrator with the measured numbers.
