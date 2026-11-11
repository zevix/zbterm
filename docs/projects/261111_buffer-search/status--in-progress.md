# Search in live session buffers — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-11: plan approved (single box at the bottom left). **P1 built** (builder; for the verifier): `npm ci`, packaged build at `/tmp/claude-1000/zbbs/out`, debug commands `search-state` and `buffer-search-log`, `acceptance/lib_bs.sh` + `color_bs.jq`, all twelve kit bodies written and red for the right reason. **Next: P2** (engine search) and **P3** (box move); both need only P1.

## Done

- P0 baseline (planner, 2026-11-11): `baseline.md`, on `zr`, tree `buffer-search` at ec04775.
- Plan revised for the single box (planner, 2026-11-11) at 3682f01 (ui-chrome, timeline-fixes, session-templates merged); code locations in `design.md`/`phases.md` re-checked there. Committed on `buffer-search`.
- P1 (builder, 2026-11-11): `renderer/app.js` `debugSearchState`/`debugTakeBufferSearchLog` (the renderer state they read is listed in the comment above them: `state.bufferSearch`, `bufferSearchSeq`, `bufferSearchPending`, `bufferSearchCross`, `bufferSearchLog`; P4/P5 fill those or adapt the reads, keeping the answer's shape); `docs/debug_server_howto.md` rows; `acceptance/lib_bs.sh`, `acceptance/color_bs.jq`; every R*/U* body. Kit result: see *Measured*.

## Measured

- P1 kit, 2026-11-11 on `zr`, packaged build of the P1 tree (`source acceptance/activate && acceptance/run_all.sh`, ZBUI_TMP=/tmp/zbbs1): 12 run, 0 PASS, 12 FAIL, 0 CANNOT RUN, 752 s wall. Each fails on its first feature assertion: R1 `.box.inSidebar == false`; R2 `.inSession.total == 429`; R3 buffer row for alpha; R4 `.inSession.total >= 1` (after `mode == "playback"` passed); R5 heading; R6 buffer rows in count order; R7 `buffer-search-log` `.entries | length == 4` (`logging: false`); R8 heading in B (the join itself succeeded); R9 box under the pane (`left`/`right` ±1); U1 `.box.focused == true` (after the od lines passed: no 006 byte); U2 heading + `empty`; U3 `.logging == true and entries >= 5` (echo medians: 17 ms without, 20 ms with the retyping, nothing searched yet). U2/U3 re-run alone for their logs: `runs/261111_buffer-search/p1_kit/`.
- `test/renderer-static.test.js`: 35 ok, 0 not ok, 0 skip (`runs/…/p1_renderer-static.log`). `npm run lint`: exit 0, 95 warnings (as at P0).

- Tests, one file per process: 63 files, 3738 ok, 8 not ok (pre-existing: `doctor`, `native-linkage`, `zxterm-seam`), 7 skip/todo lines, 309 s wall (`runs/261111_buffer-search/p0_summary.txt`, 2026-11-11).
- Lint: exit 0, 95 `require-await` warnings, 3.1 s.
- Full scan of a 5000-line mirror: 6.1 ms in Bare, 5.5 ms in Node; serialising it: 30.2 ms (`p0_scan_bench.log`).

## Gotchas

- The worktree has no `node_modules`; tests and lint resolve to the main checkout's. P1 runs `npm ci` here before packaging.
- Tests and the app need `ZXTERM_CORE_BIN=/zp/zdata/zeev/github/zbterm/npm/zxterm-core-linux-x64/zxterm-core`.
- This kit's packaged build goes to `/tmp/claude-1000/zbbs/out` (not ui-chrome's `zbui/out`, which other agents use).
- `Bare.Thread` exists but a thread loaded from a file path fails in the bundled runtime (`MODULE_NOT_FOUND`); only `source:` worked (`p0_bare_thread.log`). Moot: Q-1 was answered "no threads".
- The host has no `bc` and no `/usr/bin/time`; time with `date +%s%N`.
- `GET /sessions/:id/stats` calls `player.open` (reads the recording) and serialises the whole mirror: the kit never polls it; `lib_bs.sh::mirror_has` reads `GET /sessions/:id` (`session.open` only).
- Seed commands never hold the query literally (`p=ZQ; echo "${p}X"`): the echoed command line would add a match.
- `buffer-search-log` entries are one per request (`answeredAt` null until answered); `search-state.sessions.pending` must reach 0 and `searching` false for `lib_bs.sh::wait_search`.
- Search-state reads the list by DOM: the heading is `.session-section-title`; "searching…" / "No matches in live sessions" are matched by text after it; "No matching sessions" before it.
- The bottom bar moves out of `.main` (P3): done kits of `../261110_ui-chrome/` and `../261110_timeline-fixes/` assert rects near it. They are regression checks (P3, P6), never edited; reds go to `phases.md` *Regression notes*.
- `baseline.md` line numbers are at ec04775; `phases.md` code maps are at 3682f01.

## Ids allocated

None.

## User owes

- The approval line on `goal_requirements.md` (and `design.md`'s *Approval*).
- A look at the planner's single-box decisions, `design.md` Q-3 to Q-7, especially Q-5 (collapsed width read as the top bar's left group).

## Open

- `engine/package.json` version: a new method is a minor contract change (`docs/CORE-CONTRACT.md` *Versioning*). Bumping the core's version is release work, left to the maintainer.
- `design.md` rows 17–22 (the single-box revision) were added by the planner and not seen by the reviewer.

## Soft changes to read back

- 2026-11-11 (P1): U3's echo is timed on the renderer's rows; seeding never polls `stats`; R2's flood paced over ~10 s; R7 asserts log and reads (`notes--context.md` *Soft changes*).
