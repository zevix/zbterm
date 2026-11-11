# Search in live session buffers — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-11: plan approved (single box at the bottom left). **P1 built**; **P2 built** (builder; for the verifier): `engine/buffer-search.js` (`scanBuffer`), its byte-identical copy `renderer/buffer-search.js` (not yet loaded by `index.html`: P4 adds the `<script>`), `session.searchBuffer` in `engine/index.js`, `TerminalFrame.generation`/`disposed`, the `docs/CORE-CONTRACT.md` §5.1 row, `test/buffer-search.test.js`. **Next: P3** (box move), then P4; P5 needs P2+P3.

## Done

- P0 baseline (planner, 2026-11-11): `baseline.md`, on `zr`, tree `buffer-search` at ec04775.
- Plan revised for the single box (planner, 2026-11-11) at 3682f01 (ui-chrome, timeline-fixes, session-templates merged); code locations in `design.md`/`phases.md` re-checked there. Committed on `buffer-search`.
- P1 (builder, 2026-11-11): `renderer/app.js` `debugSearchState`/`debugTakeBufferSearchLog` (the renderer state they read is listed in the comment above them: `state.bufferSearch`, `bufferSearchSeq`, `bufferSearchPending`, `bufferSearchCross`, `bufferSearchLog`; P4/P5 fill those or adapt the reads, keeping the answer's shape); `docs/debug_server_howto.md` rows; `acceptance/lib_bs.sh`, `acceptance/color_bs.jq`; every R*/U* body. Kit result: see *Measured*.
- P2 (builder, 2026-11-11): the matcher and `session.searchBuffer` as in `design.md` *Interface*; details in `notes--context.md` *Soft changes* (P2). For P4/P5: `scanBuffer(buffer, query, { from, to, lines, limit })` → `{ count, matches: [{ row, col, len }] newest first, next, lines }`, slice with `from = previous.next`; the renderer copy sets `window.zbtermScanBuffer`. `session.searchBuffer` → `{ sessionId, count, cancelled, gone }`; a request whose `seq` is older than the newest for its `searchKey` answers `cancelled` at once, so the renderer must send a strictly increasing `seq` per window and one fresh `searchKey` per renderer. The renderer copy must stay byte-identical to the engine's (the test compares the files): edit one, `cp` it over.

## Measured

- P1 kit, 2026-11-11 on `zr`, packaged build of the P1 tree (`source acceptance/activate && acceptance/run_all.sh`, ZBUI_TMP=/tmp/zbbs1): 12 run, 0 PASS, 12 FAIL, 0 CANNOT RUN, 752 s wall. Each fails on its first feature assertion: R1 `.box.inSidebar == false`; R2 `.inSession.total == 429`; R3 buffer row for alpha; R4 `.inSession.total >= 1` (after `mode == "playback"` passed); R5 heading; R6 buffer rows in count order; R7 `buffer-search-log` `.entries | length == 4` (`logging: false`); R8 heading in B (the join itself succeeded); R9 box under the pane (`left`/`right` ±1); U1 `.box.focused == true` (after the od lines passed: no 006 byte); U2 heading + `empty`; U3 `.logging == true and entries >= 5` (echo medians: 17 ms without, 20 ms with the retyping, nothing searched yet). U2/U3 re-run alone for their logs: `runs/261111_buffer-search/p1_kit/`.
- `test/renderer-static.test.js`: 35 ok, 0 not ok, 0 skip (`runs/…/p1_renderer-static.log`). `npm run lint`: exit 0, 95 warnings (as at P0).

- P2, 2026-11-11 on `zr`: `test/buffer-search.test.js` 17 tests, 470 ok, 0 not ok, 0 skip. Whole set by `p2_loop.sh`: 66 files, 4408 ok, 8 not ok (the same pre-existing `doctor` 4, `native-linkage` 4, `zxterm-seam` rc=1), 7 skip/todo lines not counted, 322 s wall (target ≤ 369 s) (`runs/…/p2_summary.txt`). `test/core-contract.test.js` 28 ok. `npm run lint`: exit 0, 95 warnings (as at P0) (`runs/…/p2/lint.log`).
- P2 scan timing (`runs/…/p2/p2_scan_bench.log`, 120x40 mirror, 5040 lines, 52 matches, 20 runs): full count 7.75 ms in Bare v1.34.0, 7.2 ms in Node; in 500-line slices (11 per session) 6.95 ms in Bare; a 1-character query with 50 000 positions placed 24.6 ms in Bare. Target ≤ 10 ms per session met.
- P2 packaged boot (`runs/…/p2/boot_check.sh`, `.log`; ZBTerm packaged to `/tmp/claude-1000/zbbs/out` from the P2 tree, under `uisolate`): `POST /invoke {"method":"session.searchBuffer",…}` on a live seeded session → `{"count":3,"cancelled":false,"gone":false}`; an unknown id → `{"count":0,"cancelled":false,"gone":true}`.
- Tests, one file per process: 63 files, 3738 ok, 8 not ok (pre-existing: `doctor`, `native-linkage`, `zxterm-seam`), 7 skip/todo lines, 309 s wall (`runs/261111_buffer-search/p0_summary.txt`, 2026-11-11).
- Lint: exit 0, 95 `require-await` warnings, 3.1 s.
- Full scan of a 5000-line mirror: 6.1 ms in Bare, 5.5 ms in Node; serialising it: 30.2 ms (`p0_scan_bench.log`).

## Gotchas

- `safe_delete` refuses a test `TMPDIR` like `/tmp/zbbs-t2` (not a scratch root); P2's is left there (P0's `/tmp/zbbs-t` likewise). Use a TMPDIR under `/tmp/claude-1000/` only if it stays under 20 characters, which it cannot; leave them.
- Emoji are 1 cell wide in xterm's default Unicode 6 widths; the matcher follows `getWidth()`, so tests compute columns from the buffer.

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

- 2026-11-11 (P2): the matcher's `lines`/`next` slicing and `len` over a pushed wide character; trailing erased cells are not text; an ended join answers `gone`; trimmed rows followed by a marker (`notes--context.md` *Soft changes*).
- 2026-11-11 (P1): U3's echo is timed on the renderer's rows; seeding never polls `stats`; R2's flood paced over ~10 s; R7 asserts log and reads (`notes--context.md` *Soft changes*).
