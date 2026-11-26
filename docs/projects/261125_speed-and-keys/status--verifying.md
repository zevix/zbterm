# 261125_speed-and-keys — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.

## Now

2026-11-26 (planner): the user accepted the unit-test coverage of U1's joined/pending half and
the soft changes read back (list of 9, in chat): "Yep ok". Waiting on the user's "done".

2026-11-25 (planner): fresh verifier GREEN on the whole kit (`acceptance/report--2026-11-25.md`):
package, lint, all 5 scripts exit 0. Open: coverage finding 1, the joined/pending half of U1
is checked only by the unit test `test/session-keys.test.js` (guard rejects joined and pending),
not by a kit script. Waiting on the user: accept that, or add a kit check; then the soft-change
read-back and "done".

2026-11-25 23:02 (P6 builder): P6 built, NOT verified. Fresh package (`p6/package.log` exit 0).
Kit fitted into run_all's 240 s per script by two harness fixes and one collision fix (no sample
count, threshold or assertion touched; see *Done* P6): `R1_switch_speed.sh` 260 s → 161 s standalone,
`R6_search_states.sh` 197 s → 136 s, `R2_typing_speed.sh` 81 s (unchanged). CHANGELOG entry
under Unreleased (Added: Ctrl+D; Changed: the two search states, Ctrl+PgUp/PgDn wrap; Fixed: the
three speed fixes). README key section checked against `renderer/session-keys.js`: matches.
`agent_docs/`: no statement became false, unchanged. `run_all.sh` exit 0 in 494 s, every
script PASS (longest R1_switch_speed 158 s); lint 0; the nine test files touched by P1-P5 pass,
0 skips. Next per plan: verifier.

2026-11-25 22:15 (P5 builder): P5 built, NOT verified. Two search states: `state.searchActive`
(set on the box's focus, cleared only by Esc, a terminal focusin, a new/joined session,
Ctrl+1..9), the terminal `focusin` rule and the box `blur` rule, the app's focus returns to the
box, Enter/Shift+Enter in the box only step matches, the search line in the status bar, "Search
started here", Ctrl+PgUp/PgDn outside search over the drawn rows, wrapping. On the fresh package
(`p5/package2.log`): `R6_search_states.sh` exit 0 (`p5/R6_run4.log`; runs 1-3 failed on a real
bug, fixed, and two script bugs), `R3_delete_key.sh` exit 0 with its search block
(`p5/R3_run1.log`), `R1_switch_speed.sh` under `timeout 240` exit 124 twice (every timing ok, killed at the
last step, `p5/R1_switch_speed.log`, `.run2.log`), under `timeout 400` exit 0 in 260 s, every timing
ok (`p5/R1_switch_speed.run3.log`; see *Open*);
`test/renderer-static.test.js` 47/47 tests, 326/326 asserts, `test/session-keys.test.js` 10/10,
70/70 (both files, 0 skips); lint 0. Next per plan: verifier, then P6.

2026-11-25 21:40 (P4 builder): P4 built, NOT verified. Ctrl+D beside Ctrl+R in the document
keydown handler, guard in the new `renderer/session-keys.js` (`offlineKeyTarget`: playback, own
closed session, switch drawn), repeat and open dialog ignored (Ctrl+R too now), neighbour after the
delete shown with `{ extend: false }`, toast "Press ^R or Enter to resume the session, ^D to delete
it". On the fresh package (`p4/package.log`): `R3_delete_key.sh` exit 0 (`p4/R3_run2.log`; run 1
was a jq bug in the script), `R1_switch_speed.sh` exit 0, all timings ok, errors 0 (`p4/R1_switch_speed.log`);
`test/session-keys.test.js` 37/37, `test/renderer-static.test.js` 310/310 (both files, 0 skips;
the 310 include P4's new test; re-run after the README edit, same); lint 0. Next per plan: verifier, then P5.

2026-11-25 (planner): Phase PR closed by the user: "I already built and testing, thanks! You can
continue to the next phase". The user built and is testing the release themselves; no CHANGELOG
entry, tag or publish by this project at PR (the CHANGELOG entry goes in P6). Next: builder P4.

2026-11-25 (planner): P2, P2b, P3 built; fresh verifier GREEN on R1_switch_speed, R1_many_profiles,
R2_typing_speed (`acceptance/report--2026-11-25-speed.md`). Phase PR waits on the user's answer:
what "release" means (local Linux installers?) and whether the tree's other uncommitted work goes
in. P4 is held until the release build is cut (same `renderer/app.js`, same package dir).

2026-11-25 20:27 (P3 builder): P3 built, NOT verified. Lazy timeline (engine `timeline: 'lazy'` +
`session.timeline`), renderer timeline cache with sliced fetch, switch generation, stepping from
the last requested target, `checkLiveTail` lazy, scrubber caches per timeline array. On the final
package (`p3/package3.log`): `R1_switch_speed.sh` exit 0, `R2_typing_speed.sh` exit 0 (twice on
the final package, five runs in all, no stall), `R1_many_profiles.sh` exit 0; lint 0. Open items
(2), (5)/(7), (6) resolved below. Next per plan: verifier, then PR.

2026-11-25 20:55 (P2b builder): P2b built, NOT verified. timeline.json is written at most once a
second while live, immediately at exit/close/finalize; a load catches a stale file up from the log.
`R2_typing_speed.sh` run 2 reached its playback step for the first time (all timing ok, terminal
mirror 1..5000 complete) and failed there (*Open* (6)); run 1 stalled at SQDONE as in P2 (*Open* (7)).
Orchestrator to decide on both; next per plan: P3.

2026-11-25 20:00 (P2 builder): P2 stopped, NOT verified, `R2_typing_speed.sh` still exit 1.
The renderer half is done: echo median 12-14 ms at 1M entries with **no** long task (was 74 ms,
long tasks to 170 ms), F8 marks check passes. The script still cannot reach its U4 steps: after
the streaming block the live session's output stops reaching the renderer (engine side, see
*Open* (5)); `engine/` is out of P2's scope, so this is an orchestrator decision.

2026-11-25 (planner): P1 accepted as red at timing (R1 run 2, R2 run 2). The 1M R2 end-of-run
checks are left as they are: they wait on today's lag, the fix must make them reachable (script
timeout 300 s kept). R1 run 3's U3 marker miss is handed to P3 as a possible real bug. The user
added phase PR (build and release after the speed fixes) and moved the condensed timeline index
to a separate project (`notes--context.md`). Next: builder P2.

2026-11-25 19:25: P1 second builder stopped, NOT verified. `R1_switch_speed.sh` now runs through
every assertion and is red at timing (run 2), but run 3 failed U3's marker check (see *Open*).
`R2_typing_speed.sh` on the 1 000 000-entry fixture does not reach its end on today's build: the
renderer cannot keep up with the stream at 1M, so a harness wait times out before the later
non-timing checks (see *Open*): an orchestrator decision. Phases one at a time.

## Done

- 2026-11-25 P6 (builder; logs `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261125_speed-and-keys/p6/`).
  Where the time went (`R1_profile.log`, `R6_profile.log`: scripts run with `PS4='+[${SECONDS}] '`):
  - R1: every `keys 700 ctrl+…` press came 1.4 s apart, not 700 ms: xdotool spends `--delay` per
    key of a chord (half after each press, half after each release), so a 2-key chord doubles it.
    The nine warm rounds took 17 s each (153 s of 260). Fix in `acceptance/lib_sk.sh::keys`: the
    delay is divided by the chord's key count, so presses are `<delay>` apart as the helper's
    header always said. Plain keys (R6's Up/Down, R3's Up/Down) are unchanged. Side effects, all
    toward the headers: R1's U3 burst is now 15 presses 15 ms apart (≈ 225 ms; header "within
    300 ms", before ≈ 450 ms), `R1_many_profiles.sh` 400 ms apart (was 800), `walk_to` 700 ms.
  - R6: `lib_up.sh::seed_session` waited a fixed 20 s for a `$ ` prompt the mirror never shows
    (P5 Gotchas), three times (60 s). R6 now has `seed_fast` (the same create, selected, the
    same input, the same 60 s wait for the text) without that wait. Two 15 s `xdotool mousemove
    --sync` stalls (first move into the top bar) remain: `lib.sh`, an earlier kit, not edited.
  - run_all only: `lib.sh` names storage/HOME by the id's part before `_`, so
    `R1_many_profiles` and `R1_switch_speed` shared `storage/R1`; under run_all (one state dir)
    R1_switch_speed started on the 100 profiles and failed its 60 s `all_closed` wait (length 12)
    in both first kit runs (`run_all.log`, `run_all2.log`). `R1_many_profiles.sh` now has
    `ZBUI_ID=R1m_many_profiles` (its app log is `R1m_many_profiles.app.log`).
  - Standalone after the fixes: `R1_fixed.log` exit 0 in 161 s (cold closed 108 ms, live 37.2;
    warm big median 60.4, small 42.6, longest task 51; row click 38.2, arrow 29.1, errors 0);
    `R6_search_states_p6.log` exit 0 in 136 s; `R2_typing_speed_p6.log` exit 0 in 81 s (quiet
    median 13 ms, streaming 12, no long task, sequence shown in 10 s).
  - Kit, final tree, fresh package: `timeout 1500 acceptance/run_all.sh` exit 0 in 494 s
    (`p6/run_all3.log`, logs `/tmp/claude-1000/accept/pFibD690.logs`): PASS R1_many_profiles 24 s
    (median 69.6 ms, max 87.8, no long task), PASS R1_switch_speed 158 s (cold closed 93.1 / live
    29.2 ms, warm big median 57.95, small 36.8, no long task, row click 25.7, arrow 24.3), PASS
    R2_typing_speed 75 s (quiet 12.3 ms, streaming 11.95, no long task), PASS R3_delete_key 83 s,
    PASS R6_search_states 137 s. Durations from the per-script log files' times. Runs 1 and 2
    (before the `R1m` fix): R1_switch_speed FAIL at its 12-profile wait, the other four PASS.
  - `npm run lint` exit 0 (97 warnings, 0 errors; `p6/lint.log`).
  - Tests, one file per run, `HOME=<scratch> TMPDIR=/tmp/zb25`, 0 skips, 0 todo: renderer-static
    47/47 (326 asserts), session-keys 10/10, engine-timeline 1/1 (39), store 20/20,
    engine-session 11/11, time-collapse 11/11, engine-extend 11/11, engine-attach 9/9,
    core-contract 3/3 (`p6/test-*.log`).
  - `CHANGELOG.md` (Unreleased: one Added, two Changed, a new Fixed section with three entries;
    the user's own edits kept as they were).

- 2026-11-25 P5 (builder; logs `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261125_speed-and-keys/p5/`):
  `renderer/session-keys.js` (+ `searchBoxKey`, `searchStatus`, `wrapStep`, `currentHeading`),
  `renderer/app.js` (`state.searchActive`, `statusErrorShown`; the box's focus/blur/keydown, the
  terminal `focusin`, a `MutationObserver` on `body` for closed dialogs; `endSearchForTerminal`,
  `scheduleSearchFocusReturn`/`returnSearchFocus`; `clearSearch` drops the flag before
  `term.focus()`; `focusPrimaryTarget` and `selectSession` keep the box; exits in the Ctrl+1..9
  branch, the key-trigger branch, `createSession`, `joinSharedSession`; `clickSessionRow`;
  `switchSessionRelative` over `sessionRowsInOrder()`; `updateSearchCount` draws the search line,
  called from `renderSessions`, the three `drawnId` sets and `session:exit`; `setStatus` brings the
  line back after 2 s; `showError` holds it until the next key; "Search started here" in
  `renderSessions` and both section maps; `debugSearchState` + `searchActive`, `sectionsDrawn`,
  `statusErrorShown`, `mode`; `debugSearchMode` + `active`), bug fix: `extendSession` and
  `deleteSession`/`deleteSessionByKey` look a session up past the box's name filter
  (`selectedSessionEntry`/`sessionEntryById`, `unfilteredSessions`).
  `test/session-keys.test.js` (+4 tests), `test/renderer-static.test.js` (4 assertions on replaced
  behaviour changed with dated comments, +1 test), `README.md` (search keys, the two states,
  Ctrl+PgUp/PgDn wrap, Enter resumes only from the terminal), `acceptance/R6_search_states.sh`
  (written), `acceptance/R3_delete_key.sh` (search block filled).

- 2026-11-25 P4 (builder; logs `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261125_speed-and-keys/p4/`):
  `renderer/session-keys.js` (new, loaded by `index.html` before `app.js`; `canExtendSession`,
  `offlineKeyTarget`, `switchUndrawn`, `neighbourCandidates`, `pickNeighbour`), `test/session-keys.test.js`
  (new: joined/pending/live never pass the guard, undrawn switch, neighbour rules), `renderer/app.js`
  (`state.drawnId` set when a switch's frame is written — `renderFrame`, `renderLiveFrame`,
  `showUnrecordedEnded` — reset in `selectSession`; the Ctrl+R/Ctrl+D branch; `deleteSession`
  takes `sessionId` and `after` and resolves true/false; `deleteSessionByKey`), `RESUME_HINT_TOAST`,
  `test/renderer-static.test.js` (one new test), `README.md` (toast text, a Ctrl+D bullet),
  `acceptance/R3_delete_key.sh` (written; search-box block left marked for P5).

- 2026-11-25 P0: `baseline.md`, measured on `zr` by a read-only agent (dev Electron + CDP hook,
  scratch store). Scripts and logs: `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261125_speed-and-keys/p0/`.
- 2026-11-25 review: 16 failure scenarios (Claude Opus, fresh context), all answered in `design.md`.
- 2026-11-25 P1 (builder, unfinished; logs `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261125_speed-and-keys/p1/`,
  packaged build of this tree, one run each, `npm run lint` exit 0):
  the `perf` debug command in `renderer/app.js`, `acceptance/lib_sk.sh`, the three scripts written.
  - `R1_many_profiles.sh`: exit 0 (PASS, not red). 100 profiles, 30 live, 30 switches: median
    60.7 ms, max 77.6, no long task, errors 0 (`R1_many_profiles.run1.log`).
  - `R2_typing_speed.sh`: exit 1 in 43 s, but NOT at a timing assertion. Timing passed on today's
    build: quiet 50/50 echoes, median 12.9 ms, max 28, no long task; streaming 50/50, median
    12.45 ms, max 44.4, no long task. The engine served the fixture (length 200 004). First
    failure: the marks comparison (F8), `marks` "11:-1760101035" vs `marksRefreshed`
    "11:-245633670" (`R2_typing_speed.run1.log`). Nothing after it has ever run.
  - `R1_switch_speed.sh`: exit 1 in 38 s, in the cold step, before any timing: the first
    Ctrl+PgDn made no switch (`switches: []`) and the selected profile was not the one the script
    had just selected. No switch number measured (`R1_switch_speed.run1.log`).

- 2026-11-25 P1 second builder (logs in the same `p1/` dir; package `package3.log` exit 0,
  `lint2.log` exit 0). Changes: `renderer/app.js` `renderScrubberIndicators(probeEnd)` takes an
  optional clock and, with the probe on, records the clock it drew at (`state.perf.drawEnd`);
  `debugPerf` read with `refresh` redraws at that clock and returns `drawEnd` (probe off: no
  change). `lib_sk.sh`: `timing_le`/`timing_verdict` (a timing failure is printed and the script
  goes on; it exits 1 at the end) and `walk_to` (keyboard walk, see *Gotchas*). R1: reaches the
  start by `select_session` on a live profile + `walk_to`, checks the walk did not reorder, null
  checks for cold/click/arrow samples, A-B-A reads compared once they agree (≤ 5 s). R2: 1M
  fixture, header updated, `drawEnd` in the marks check, SQDONE wait 60 → 150 s (a harness wait,
  time printed).
  - `R1_switch_speed.run2.log`: exit 1. Timing: cold big closed 812.8 ms, cold big live 710.9
    (≤ 150), cold longest task 518 (≤ 100); warm big median 743.5 (n 18, ≤ 150), small median
    44.8 (n 90, ≤ 60, ok), longest task 609 (≤ 100); row click 727.1, search arrow 700.3 (≤ 150).
    Non-timing: cold samples complete-or-disabled, step back changed the frame, errors 0, U3 burst
    (right profile, own marker only, status clean) all passed; first non-timing failure was A-B-A:
    renderer 200 027 entries vs engine 200 028 (engine's last entry 36 s newer, read 0.2 s
    later) → the settle-then-compare fix above, not yet re-observed at that step.
  - `R1_switch_speed.run3.log`: exit 1. Timing as run 2 (cold 749.3 / 665.4, warm big median
    733.05, small 40.5, row click 842.9, arrow 767.5, long tasks ~500 ms). First non-timing
    failure: U3, after 15 Ctrl+PgDn the right profile was selected (its switch 1168.9 ms) but
    `markers_shown` was empty 1.5 s later (expected SKM11K). Steps after it did not run.
  - `R2_typing_speed.run2.log` (1M): exit 1. Quiet echoes 50/50, streaming 50/50, 0 misses (medians
    computed from the log, the script stopped before printing them: quiet 74 ms, streaming
    76.7 ms vs ≤ 30; longest task 170 / 133 ms vs ≤ 50: timing red), end label 0:31 → 0:42, marks
    `13:-1379388134` = same-clock redraw (drawEnd 1795626924462): F8 passes. Then the 1..5000
    sequence was not shown within 60 s (SQDONE).
  - `R2_typing_speed.run3.log` (1M): exit 1. Quiet: 50 echoes, 24 long tasks 72–168 ms. Streaming:
    46 echoes of 0.7–3.0 s, 4 misses (> 3 s), end label 0:28 → 0:29; STDONE (170 lines) not on
    screen within 30 s: the renderer fell behind the stream. Nothing after it ran.

- 2026-11-25 P2 builder (logs `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261125_speed-and-keys/p2/`;
  `package1.log` exit 0, `lint.log` exit 0, `test-renderer-static.log` 45/45, `test-time-collapse.log` 11/11).
  Changes, `renderer/app.js`: `scheduleScrubberIndicators` / `requestScrubberFrame` /
  `runScheduledScrubberIndicators` / `cancelScrubberIndicators` / `flushScrubberIndicators`
  (`updateTransportControls` now schedules: once per frame with a 100 ms timer fallback for a
  covered window, once per `SCRUBBER_OUTPUT_THROTTLE_MS` = 250 while `session:data` of the shown
  live session arrives; the pending run is the trailing one and reads state at run time; cancelled
  at `selectSession` start, flushed at the end of its live branch, of `openPlayback` and of
  `seekFromScrubber`); `updateLiveClock` no longer calls `updateTransportControls` a second time;
  `timelineDerived()` caches in `state.timelineDerived`, reset by `setTimeline`: `sessionHasHd`
  (incremental), `idleSegments` via `idleCandidates` (gaps >= 5 s kept once per timeline+start,
  extended on in-place growth; fuzzed equal to the old function, 20 000 cases), `getTimeCollapseMap`
  via `collapseMapFromBase`; `timelineActivityMap`/`timelineHistoryMap` also key on length.
  `renderer/time-collapse.js`: `timeCollapseBase`, `extendTimeCollapseBase` (+2 tests in
  `test/time-collapse.test.js`, equal to `buildTimeCollapseMap` on 50 random cases).
  - `R2_typing_speed.run1.log`: exit 1. Quiet 50/50 echoes, median ~12.4 ms, longest task none
    (`longTasks: []`); streaming 50/50, median ~13.5 ms, no long task (thresholds 30 / 50 ms:
    met; the script did not print them because it stopped earlier). End label advanced; F8
    marks `10:1709218000` = same-clock redraw. Failed at `wait_until 150 term_has SQDONE`: no
    `session:data` at all reached the renderer for 150 s after the 1..5000 sequence started.
  - `R2_typing_speed.run2.log`: exit 1. Quiet 50/50, median ~13.8 ms, no long task. Streaming: all
    50 `session.input` invokes answered together 3 s late (17:34:09.994 in the app log), echoes
    521-2998 ms; then nothing more from the session; STDONE not drawn within 30 s.
  - `R1_many_profiles.run1.log`: exit 0. 30 switches, median 63.6 ms (<= 80), max 105.1, longest
    task 52, errors 0.
  - `R1_switch_speed.run1.log`: exit 1, red at timing as expected before P3: cold big closed 707.5 ms,
    big live 689.4 (<= 150), cold longest task 497 (<= 100); warm big median 705.15 (n 18), small
    median 36.9 (n 90, <= 60 ok), longest task 635; row click 775.5, search arrow 660.4. Then the
    U3 marker check failed again as in P1 run 3 (`markers_shown` empty, expected SKM11K): *Open* (2).

- 2026-11-25 P2b builder (logs `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261125_speed-and-keys/p2b/`; `package.log` exit 0, `lint.log` exit 0).
  Changes: `engine/session-store.js`: `TIMELINE_FLUSH_MS` = 1000, `scheduleTimelineFlush(onError)`
  (one trailing timer, delay = time left to 1 s since the last write; a no-op when clean or armed),
  `_cancelTimelineFlush` (in `close()` and `_abandon()`; `delete()` goes through `close()`),
  `_timelineFlushedAt` set by `_flushTimelineNow`; `loadTimeline` of a local store whose last `seq`
  is below `log.length` calls `extendTimeline()` (reads only the missing range, keeps the file's
  part, writes the result back once); `_timelineEnd()`. `engine/index.js`: `_flushPacketBuffer`
  (live append) and `resize` now call `store.scheduleTimelineFlush(this._timelineFlushError)`
  (errors still reach `engine:error`). Kept immediate: `finalize()` (PTY exit), `close()` (exit,
  engine shutdown/restart, delete), `endHistoryCopy` + the history copy's closing resize (l.575),
  `clearCaches` (both branches), `removeHd`, `rebuildTimeline`, `extendTimeline`, joined sessions'
  `flushRemoteTimeline` (unchanged). `share-manager.js::broadcastTimeline` reads the in-memory
  timeline from its cursor, not the file: cadence unchanged.
  - Tests (one file per run, `HOME=/tmp/zb2b/home TMPDIR=/tmp/zb2b/t`, 0 skips): `store.test.js`
    20/20 (new: coalesced flush, 398 appends in 2.5 s → 3 writes 1001 ms apart, trailing write and
    close write equal the in-memory timeline; stale file caught up, only range [9, 20] read, file
    part kept), `engine-session.test.js` 11/11 (new: 114 resizes in 2.5 s → 3 writes, file equals
    timeline after `session.close`), `engine-extend` 11/11, `engine-delete-race` 2/2,
    `engine-unrecorded` 5/5, `engine-attach` 9/9, `engine-store-lock` 3/3, `engine-attach-seam` 7/7,
    `freenet-history` 6/6.
  - `R1_many_profiles.run1.log`: exit 0, 30 switches, median 63.05 ms, max 88.7, no long task, errors 0.
  - `R2_typing_speed.run1.log`: exit 1. Quiet 50/50, median 12.2 ms, no long task; streaming 50/50,
    median 12.3 ms, no long task (not printed: computed from the log); STDONE drawn (first time at
    1M); end label 0:28 → 0:29; F8 marks equal. Failed at `wait_until 150 term_has SQDONE`: no
    `session.ack` in the app log after 17:44:34 (UTC), timeline.json last written 19:44:33 local.
  - `R2diag.run1.log` (scratch copy of R2 without the typing steps, polling `session.diagnostics`):
    the sequence was on screen in ~9 s, `flowPaused` false throughout, `pendingBytes` ≤ 80,
    timeline.json rewritten every ~3 s while the sequence printed.
  - `R2_typing_speed.run2.log`: exit 1. `MEASURED` quiet median 12.4 ms, streaming 13.25 ms, longest
    task 0/0: every `TIMING ok`; sequence shown in 8 s; F8 ok; live-seam 5000 lines 1..5000, no
    dups/missing. First failure: playback `{"length":1000026,"frames":9,"seen":285,"missing":4715}`.

- 2026-11-25 P3 builder (logs `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261125_speed-and-keys/p3/`; packages `package1..3.log` exit 0, `lint1..3.log` exit 0).
  Changes:
  - `engine/index.js`: `invoke` wraps `session.open`, `session.extend`, `player.open` in
    `lazyTimeline(result, args)` (`timeline: 'lazy'` → `timelineLength`, no `timeline`; without it
    unchanged, so `electron/debug-server.js` and every test still get `timeline`); new invoke
    `session.timeline` → `SessionEngine#timelineSlice` / `sliceTimeline` `{ entries, from, length,
    reset }` (default 10 000, max 50 000; lock-free on a held store, else `_withStore`; `reset` when
    `lastTsMs`/`lastSeq` differ from the engine's entry at `from - 1` or `from` is past the end: F4).
    `docs/CORE-CONTRACT.md` method table: the option and the new row (`core-contract.test.js` checks it).
  - `renderer/app.js`: `state.timelineCache`, `state.switchSeq`, `state.switchTarget`;
    `switchStale`, `timelineCacheEntry`, `noteTimelineLength`, `timelineBehind`, `timelineComplete`,
    `showCachedTimeline`, `timelineIsCached`, `ensureTimeline` (one fetch per session), 
    `runTimelineFetch` (slices of 10 000, applied only on the same entry at `from == length`,
    `reset` replaces the array, `sleep(0)` between slices, a scrubber run scheduled per slice),
    `finishTimeline`, `catchUpTimeline`. `selectSession`: generation checked after every await;
    draws the frame, then fetches. `openPlayback(sessionId, seq)`: lazy `player.open`, frame and
    saved position drawn first, `playerReady` (so play/step/seek/speed) and the scrubber only once
    the timeline is in (F7), then the scrubber range and the frame's place are set again.
    `enterPlaybackMode`, `clearCaches`, `refreshJoinedAvailability`, `resyncLiveStream`,
    `session:restored`, `extendSession` (`session.extend`) and `checkLiveTail` open lazily;
    `checkLiveTail` and the joined refresh catch the cache up when the engine's length moved.
    `switchSessionRelative` steps from `state.switchTarget` (U3). Cache entry dropped on clear,
    delete; whole map replaced on `engine:restarting` (F5). `timelineActivityMap` extends in place
    (`activityLength`) instead of a `map` over the whole timeline per length change;
    `setTimeline` keeps the scrubber caches (signal, derived, collapse map) per array in a
    `WeakMap`. `renderScrubberIndicators` draws nothing in playback until `playerReady`. Probe:
    `timeline.engine` = engine length as last heard, `complete` = cache complete and shown,
    `timelineMs` set when the fetch completes; new debug command `playback-text` (see (c)).
  - `test/engine-timeline.test.js` (new): lazy open, slices put together = timeline, F4 resets
    (other tsMs, past end, cleared and regrown), lazy `player.open`, slice with no store held,
    not-found. Test files, one per run, `HOME=/tmp/zb3/home TMPDIR=/tmp/zb3/t`, 0 skips:
    engine-timeline 1/1 (39 asserts), engine-session 11/11, engine-extend 11/11, engine-attach 9/9,
    core-contract 3/3, renderer-static 45/45, time-collapse 11/11.
  - Kit, final package (`package3.log`):
    `R1_switch_speed.run3.log` exit 0: cold big closed 111.5 ms, big live 23.3 (≤ 150), cold
    longest task none (≤ 100); warm big median 59.25 (n 18, max 104.8, ≤ 150), small median 37.15
    (n 90, ≤ 60), longest task none (≤ 100); row click 29, search arrow 30.1 (≤ 150); F7 samples all
    disabled, step back changed seq; U3 marker ok; A-B-A cached = engine = 200 029; errors 0.
    `R2_typing_speed.run4.log` / `run5.log` exit 0: quiet median 14 / 11.9 ms, streaming 12.5 /
    11.8 (≤ 30), longest task none (≤ 50), sequence shown in 8 / 9 s, F8 marks equal, live-seam
    1..5000, playback 5000 lines in order, F6 renderer = engine 1 000 026.
    `R1_many_profiles.run2.log` exit 0: median 67.25 ms (≤ 80), max 82.4, no long task.
  - Earlier runs on package 1/2: `R1_switch_speed.run1.log` exit 0 (cold closed 128.4, warm big
    median 75.1, long task 52); `R1_switch_speed.run2.log` exit 0 but warm longest task exactly
    100 (≤ 100), which led to the per-array caches; `R2_typing_speed.run1.log` exit 1 (quiet long
    task 75 ms: the full activity-map rebuild at the end of the 1M fetch, fixed by the incremental
    map; playback parse missed `S 1`, see (c)); `run2.log`, `run3.log` exit 0;
    `R1_many_profiles.run1.log` exit 0 (median 73.5).
  - Resolutions: (a) U3 marker miss: real app bug, fixed. `openPlayback` had no stale check after
    `player.open`/`player.seek`, and `selectSession`'s check (`selectedId`) passes for an older open
    of the same id, so a slower, older open could draw its frame (or set `playerReady`/the
    timeline) over the newest switch's. Now every await checks `state.switchSeq`; U3 passed in all
    3 R1 runs. (b) The R2 stall: gone in 5/5 runs (sequence shown in 8-9 s each), with the lazy
    `checkLiveTail` (it shipped the 42 MB timeline on every quiet moment) plus P2b's flush; not
    seen again, cause not isolated further. (c) R2's playback check: debug command
    `playback-text` (renderer, beside `perf`): seeks the engine's player to the last entry before
    the sequence (`startSeq` must be ≤ that seq), plays at 8x, collects every `player:data`
    packet's bytes in order, decodes them as one stream; the script takes each line's text after
    its last carriage return and asserts the `S n` lines equal exactly [1..5000]. Every run since:
    `lines 5000, first 1, last 5000, inOrder true`, 9 packets, 39 107 bytes.

## Measured

- Switch, small histories: median 38 ms; onto 100k timeline entries 286–323 ms; onto 1M ≈ 2.3 s
  (`node drv.js wt switches 25`, 2026-11-25).
- Echo: 15.7 ms median small; 107 ms median at 1M entries with 72 long tasks in 50 keys
  (`node drv.js wt type 50 100 any`, 2026-11-25).
- HEAD package = working tree (not a recent regression in code; it grows with the history).

## Gotchas

- P5: a real bug found by R6 run 1: Ctrl+R in search on a closed session that is not a name
  match (a buffer or "Other" row) did nothing: `extendSession` looked the session up in
  `state.sessions`, which the box's name filter narrows. The Delete confirmation then named
  "this session". Both fixed; R6's Ctrl+R step on `closed-c` (an unmatched row) and R3's search
  block reproduce it.
- P5: buttons keep the box's focus already (the document `mousedown` prevents a button's
  default); a row click blurs the box (rows are divs) and the blur rule puts it back before the
  click handler runs. A dialog's overlay removed leaves the focus on `body`; the observer on
  `body` (childList only) returns it to the box.
- P5: `R6_search_states.sh` needs about 200-215 s of its 240 s (`timeout 240`): many real key
  walks with 500 ms between keys. Adding steps needs a longer timeout or shorter waits.
- P5: in jq, `$b | index(.)` inside `select` rebinds `.` to `$b`; bind the item first
  (`. as $id | ($b | index($id))`).
- P5: a session made by Ctrl+Shift+T without a template: `mirror_has "$ns" '$ '` (the
  `GET /sessions/<id>` frame) did not see a prompt within 20 s, although the terminal showed it
  and typed text echoed; R6 uses `term_has` there. Not diagnosed.

- P4: "drawn" for the Ctrl+R/Ctrl+D guard = `state.drawnId === state.selectedId` and no newer
  switch target; a path that shows a session without a frame write leaves both keys doing nothing
  (fail-closed). While a switch onto a non-live session is undrawn both keys are swallowed, never
  sent to the session being left; onto a live one they fall through to the program.
- P4: `test/renderer-static.test.js` held no toast text before P4 (the brief said it did); the new
  test quotes it.

- The debug server has no eval; P1 adds the `perf` command the kit reads.
- The kit's script files exist with headers only and exit 1 ("NOT WRITTEN YET") until their phase.
- `timeline.json` in a scratch store can be hand-written with the app stopped (P0 did it).
- The working tree holds the user's uncommitted work; no git writes by any agent.
- All phases edit `renderer/app.js`: strictly one builder at a time.
- P1, the probe: `state.perf` is unset until `perf start` (every hook is `if (state.perf)`). Its
  listeners sit on `window`, capture phase. A switch is timed only when an input caused it
  (Ctrl+PgUp/PgDn, an arrow in the search box, a click on a row); the debug server's `/switch` is
  not timed. `cold` = first visit since the first `perf start`; `timelineMs` = `ms`,
  `timeline.engine` = `timeline.cached`, `timeline.complete` = no switch pending and the player
  ready: P3 gives these their real meaning. `read` with `"refresh": true` (an addition to the
  design's two actions) redraws the scrubber marks and returns `marksRefreshed`.
- P1, the fixture: `seed_big_timeline` keeps the real entries and adds entries over the same time
  span, each naming the packet shown at its time (duplicate `seq`, valid packets). The engine
  loads it as written and appends to it on resume. A session that only echoes and exits has 2
  real entries over about a second, so the 200 000 sit in that second: a dense, gap-free
  timeline. P0's recipe for its big timelines is not in `p0/` and may have been shaped differently.
- P1, the harness: a row click and the debug server's `/switch` RESUME a closed session; only the
  keyboard walk shows one closed. `mirror_has` and `GET /sessions/<id>` ship the whole timeline
  (about 9 MB at 200k): the scripts use `term_has` and `engine_timeline` instead.
  A live session is made after a restart with `engine_extend` (`/invoke session.extend`).
- P1, R2 at 200 000 entries is green for timing today, as `baseline.md` itself predicts (100k:
  median 17.2 ms, long tasks only at 1M). The header's size and thresholds cannot show the typing
  problem; that is a design question for the orchestrator, not something a builder may tune.
- P1, R2's marks assertion fails today although the marks are drawn synchronously: the digest is
  the marks' class names in order (`activity|history|socket` + `low|medium|high`), and a redraw
  half a second later gives other levels. Either the comparison must be made at one frozen clock,
  or the digest is too strict. Undecided.

- P1 (2nd): the debug server's `/switch` and a row click RESUME a closed session, which sets its
  `lastStartedAt` and moves it to the top of the list: an order computed before is then wrong.
  That was R1's cold-step bug (the first Ctrl+PgDn left the resumed profile, now at the top, for
  the old `order[0]`). `walk_to <sid> [avoid..]` reaches a closed profile by real Ctrl+PgDn/PgUp
  and never passes the avoided (big) ones, so their first visit stays the cold one.
- P1 (2nd): timing assertions are `timing_le` (reported, the script continues, exit 1 at the end),
  so a red timing result no longer hides the non-timing assertions after it.
- P1 (2nd): a live session's engine timeline gains entries with no output (R1 run 2: +24 over the
  run on BL); compare renderer and engine only once the reads agree, or after a bounded wait.
- P1 (2nd): at 1M entries today's renderer has 100–170 ms long tasks continuously while live and
  falls seconds behind streaming output; any `wait_until … term_has` after output is at risk.

- P2: the scrubber's marks are drawn one frame (or one 100 ms timer) after a transport update, and
  up to 250 ms late while the shown live session prints; a switch, a seek and `perf read refresh`
  draw at once. Debug commands that settle (`debugSettle`) already wait a frame, so kits see them.
- P2: `state.timeline` is still never appended to in place in the renderer; the caches handle
  in-place growth anyway (P3's `timelineCache` may rely on it), and reset on a new array.
- P2: the engine rewrites the whole `timeline.json` after each appended packet
  (`engine/index.js::_flushPacketBuffer` → `store.flushTimeline()`; coalesced only when appends
  queue). At 1M entries that is 42 MB: `JSON.stringify` alone 275 ms in Node on this host. The
  renderer's `checkLiveTail` (`session.open {frame:false}`, 700 ms after output) also gets the
  whole timeline: 540-680 ms per call in the app log. Both stall the worker at 1M.

- P2b: a live session's timeline.json lags its log by up to ~1 s plus one write (at 1M entries a
  write took ~2-3 s of wall time in the packaged app). Anything reading the file of a live session
  must not expect it current; nothing in `engine/`/`electron/` does (only `loadTimeline`). A crash
  loses no entries: the next open extends from the log.
- P2b: `loadTimeline`'s catch-up is local-store only; joined stores' callers already run
  `extendTimeline()` against `availableLength()`.
- P2b: `_updateFlow`'s pause: every decrement (ack, mirror write done, append done) calls it, so a
  pause always gets its resume check; in the diag run `flowPaused` stayed false. Not the stall.

- P3: `playerReady` now means "the player is open AND the playback's timeline is in"; older
  kits waiting on it wait for the fetch too (≈ 1 s for 200k cold). The scrubber draws nothing in
  playback before that.
- P3: a cold playback still builds its scrubber caches once at the end of the fetch (its range
  is unknown until then); measured fine at 200k (R1 cold longest task none / 52 ms), not measured
  for a closed 1M session.
- P3: a live session's cached timeline now grows (tail catch-up after a quiet moment, joined
  refresh); the scrubber caches extend in place. The activity map skips points past the draw's
  end at the time they are added (same as the old rebuild for live/playback ends).
- P3: bash writes `\e[?2004l\r` before the first output line of a command: a text check must
  take a line's text after its last `\r`, not match `^S` at the raw line start.
- P3: debug-server callers and `acceptance/lib_sk.sh::engine_timeline` use the opens without the
  option (full timeline, 42 MB at 1M over HTTP): by design (Q-2).

## Ids allocated

None (this repo has no `docs/register.md` / `docs/decisions.md`).

## User owes

`git add docs/projects/261125_speed-and-keys` and the
touched sources.

## Open

- P6 (2026-11-25): the two P5 items below (R1 at ~260 s, R6 at 200-215 s) are resolved by P6's
  kit fixes (R1 158 s, R6 137 s in run_all). Left: (a) `lib.sh::mouse_to`'s `xdotool mousemove
  --sync` stalls ~15 s on the first move into the top bar (twice in R6, once in R1 and R2):
  an earlier kit's helper, not edited; ~45 s of the kit. (b) R1's A-B-A step sends its three
  keys with a raw `xdotool --delay 60`, so they span ≈ 240 ms against the header's "within
  200 ms" (same chord doubling as `keys`); not changed, as tightening a check is not harness
  overhead: orchestrator's call. (c) The verifier's run is the one that counts.
- P5 (2026-11-25): `R1_switch_speed.sh` takes about 260 s on this host and so cannot finish under
  the `timeout 240` the briefs give. That is not new in P5: P4's own run spans 256 s in its app
  log (`/tmp/claude-1000/accept/sMvOSkE1.logs`, 19:34:33-19:38:49). Under `timeout 240` it is
  killed at its last step (F3, A-B-A) with every timing passed. `run_all.sh` keeps the user's
  rule "one script at most 240 s" (2026-11-13), so there R1 is a FAIL (124). Orchestrator/user:
  shorten R1's walks (its 700 ms key delays) or change that rule. No threshold or
  assertion was touched.
- P5: `R6_search_states.sh` takes about 200-215 s of its 240 s.

- P4: R3's held-key step holds Ctrl+D with `xdotool keydown` for 1.5 s; whether the uisolate
  display's autorepeat actually sends repeat events was not checked (peak overlays 1 either way).
  Repeat handling is also covered by the `if (!target || event.repeat) return` line (static test).

- Two flooding sessions can starve the worker: `electron/session-data-batcher.js` (not built here).
- P1 left (2026-11-25 19:25, second builder):
  (1) R2 at 1M cannot run to its end on today's build: in run 3 STDONE (170 lines) was not drawn
  within 30 s and 4 echoes took over 3 s; in run 2 the 5000-line sequence was not drawn within
  60 s. These are the typing slowness itself, hitting harness waits and the "50 echoes, 0 misses"
  check, not a harness bug. The script timeout (300 s) leaves no room for waits long enough to
  outlast it. Orchestrator to decide: longer waits plus a longer script timeout, or the U4
  sequence on its own profile/smaller fixture. Not decided by the builder; the 1..5000 mirror and
  playback checks and the F6 timeline comparison have never run at 1M.
  (2) R1 U3 failed in run 3 (passed in run 2): after a 15-key burst crossing the big profiles the
  selected profile was right but its terminal showed no marker 1.5 s later. Possibly the real U3
  bug (a stale or missing frame after a burst), possibly the frame still drawing; not diagnosed.
  (3) R1's A-B-A settle fix has not been observed reaching that step (run 3 stopped at U3).
  (4) No worker or `engine/` file was touched in P1.

- P2 left (2026-11-25 20:00): (5) `R2_typing_speed.sh` at 1M stops before its U4 steps on the
  P2 build, for a reason outside the renderer's scrubber: in run 1 no output reached the renderer
  for 150 s after the sequence started (`timeline.json` last written before it, 17:30:05); in run 2
  the worker answered 50 inputs 3 s late at once and the session then went silent (timeline.json
  last written 17:34:11, +12 entries). The renderer had no long task in either. Suspects (not
  diagnosed, read-only look): the per-packet 42 MB timeline rewrite and the full timeline in every
  `session.open` keep the worker busy; then the PTY flow pause (`_updateFlow`: `pendingBytes` /
  backlog) may never resume. P1 run 3 showed the same symptom before P2. Fixing it needs
  `engine/` (the open half is P3's lazy timeline; the per-packet rewrite is in no phase).
  Orchestrator to decide; no threshold or assertion was touched.

- P2b left (2026-11-25 20:55): (6) R2's playback check counts the `S n` lines in the 30-row frame at
  each new packet's time; the 5000 lines were recorded in ~9 packets (frames 9, seen 285 ≈ 9 × 31),
  so lines scrolled past inside one packet are never on a frame. The live mirror has all 5000. Most
  likely the check's method, not a lost byte, but NOT verified by decoding the packets (the store
  needs the zxterm-core device key). Orchestrator: verify the recording another way (concatenate
  the packets' payloads after `seq0`) or change the check; no assertion was touched.
  (7) Intermittent: in R2 run 1 nothing reached the renderer after the sequence's `sinput`
  (no ack, no timeline write after it, app quit 2.5 min later); run 2 and the diag run were fine.
  Same symptom as P2 run 1 / P1 run 3, so it predates P2b; cause not found (flow pause ruled out
  above; the input may not have reached the PTY, or the worker was stuck in `session.open`).

- P3 (2026-11-25 20:27): (2), (5)/(7), (6) above are resolved (see *Done* P3 (a)-(c)); (1) and (3)
  no longer apply (R2 runs to its end at 1M; A-B-A reached and passed). Left: the cold 1M
  playback's one-time scrubber build (not measured); the switch's terminal marks keep the previous
  session's marks until its timeline is in (a cold big one: ~1 s).

## Soft changes to read back

- 2026-11-25 (P6 builder): the kit's `keys` helper now spaces chord presses by the delay it is
  given (xdotool had doubled it for two-key chords). R1's warm and cold walks run at 700 ms per
  switch instead of 1.4 s, the U3 burst at ≈ 225 ms for 15 keys instead of ≈ 450 ms, R1_many
  at 400 ms instead of 800: every spacing now what the scripts' text says. Samples, thresholds
  and assertions unchanged.
- 2026-11-25 (P6 builder): R6 seeds its three live profiles with `seed_fast` (no 20 s prompt
  wait); `R1_many_profiles.sh` runs under `ZBUI_ID=R1m_many_profiles` (own storage/HOME dir).
- 2026-11-25 (P6 builder): CHANGELOG wording is the builder's (Added/Changed/Fixed under
  Unreleased); the user may want it shorter.

- 2026-11-25 (P5 builder): a row click in search shows the session **without resuming** a
  closed one (as the arrows do) and puts the cursor on that row. The design table says only
  "show it; focus stays in the box" for search and "(resumes a closed one, as today)" for the
  terminal; read as no resume in search. Ctrl+R resumes it.
- 2026-11-25 (P5 builder): the exits other than Esc (a terminal focus, a new or joined session,
  Ctrl+1..9) all keep the text for the box's next focus; the design names only Esc (forgets) and
  the terminal click (remembers), A-4.
- 2026-11-25 (P5 builder): another status text shows for 2 s in search, then the search line
  comes back (design: "for their moment"). An error stays until the next key.
- 2026-11-25 (P5 builder): R6's header says the status line "starts with M / N"; it starts with
  the design's "[M / N]" and the script asserts that bracketed form
  (`^\[[0-9]+ / [0-9]+\] Search: `). The "dialog opened from search" is the "+ New" dialog
  (cancelled with Esc); the toolbar buttons are `#themeToggle` and `#activeOnly` (each twice).
  F12's 2 s are measured from sending `exit` to the shell.
- 2026-11-25 (P5 builder): the README key section was updated in P5, as its brief asked; the
  phases file puts it in P6 (the CHANGELOG entry is still P6's).

- 2026-11-25 (P4 builder): design says Ctrl+D is ignored "while any dialog is open" via
  `sidePaneBlocked`; Ctrl+R now has the same guards (dialog open, repeat, undrawn switch), as
  design F1/Refuses state for it. A Ctrl+R typed during an open dialog no longer resumes.
- 2026-11-25 (P4 builder): R3's F1 step and U1 step avoid sending Ctrl+D toward the live profile
  during a switch (it would end its shell); the U1 check is the separate `cat` step.

- 2026-11-25 (P3 builder): R2's playback assertion now reads the recorded text through the new
  debug command `playback-text` (every packet after the sequence started, via the engine's player)
  instead of 30-row frames sampled per packet; the assertion is stronger (exact 1..5000 in order,
  no extras, `startSeq` ≤ the last seq before the sequence). Planner decision, per the P3 brief.
- 2026-11-25 (P3 builder): design says the scrubber is redrawn once at the end of a fetch; a live
  session's scrubber is redrawn per slice instead (the caches grow with the slices, so the 1M fetch
  has no single long pass at its end). Playback keeps the once-at-the-end rule.

- 2026-11-25 (planner, after P2): design addition, phase P2b: the engine rewrote the whole
  `timeline.json` after every recorded packet (`engine/index.js` append path →
  `SessionStore._flushTimelineNow`; 42 MB / ~275 ms stringify at 1M entries, ~6 MB on the user's
  largest), stalling live output. Now flushed at most once a second and on close/finalize; on load
  a timeline shorter than the log is caught up from the log. R2's full pass is expected after P3
  (`checkLiveTail` → `session.open` ships the whole timeline until the lazy option).

- 2026-11-25 (planner, after P1): `R2_typing_speed.sh` runs on a **1 000 000-entry** timeline, not
  200 000 (design step 2, phases P1/P2): at 200k today's build already passes the echo thresholds
  (median 12.9 ms), so the check could not catch the lag; at 1M today measures 107 ms median with
  long tasks (`baseline.md`). Thresholds unchanged (stricter test, not a weaker one).
- 2026-11-25 (planner, after P1): the F8 marks check compares the drawn marks with a redraw **at
  the same clock** as the last draw (the live scrubber's span grows with time, so a redraw 500 ms
  later legitimately differs). Assertion kept, its clock fixed.
