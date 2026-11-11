# Search in live session buffers — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-11: the user reviewed the plan, accepted Q-1 (no new dependency) and Q-2 (both sections), and asked for one change: a single search box at the bottom left (`#search` moved to the bottom bar; collapsed, as wide as the top bar's left group). The plan is revised to that (R1, R3, R5 reworded; R9 added; phases now P1–P6) and the user approved it; the user writes the approval line on `goal_requirements.md`. **Next: P1** (kit harness, debug commands, kit bodies red). No build phase starts before that approval line exists.

## Done

- P0 baseline (planner, 2026-11-11): `baseline.md`, on `zr`, tree `buffer-search` at ec04775.
- Plan revised for the single box (planner, 2026-11-11) at 3682f01 (ui-chrome, timeline-fixes, session-templates merged); code locations in `design.md`/`phases.md` re-checked there. Committed on `buffer-search`.

## Measured

- Tests, one file per process: 63 files, 3738 ok, 8 not ok (pre-existing: `doctor`, `native-linkage`, `zxterm-seam`), 7 skip/todo lines, 309 s wall (`runs/261111_buffer-search/p0_summary.txt`, 2026-11-11).
- Lint: exit 0, 95 `require-await` warnings, 3.1 s.
- Full scan of a 5000-line mirror: 6.1 ms in Bare, 5.5 ms in Node; serialising it: 30.2 ms (`p0_scan_bench.log`).

## Gotchas

- The worktree has no `node_modules`; tests and lint resolve to the main checkout's. P1 runs `npm ci` here before packaging.
- Tests and the app need `ZXTERM_CORE_BIN=/zp/zdata/zeev/github/zbterm/npm/zxterm-core-linux-x64/zxterm-core`.
- This kit's packaged build goes to `/tmp/claude-1000/zbbs/out` (not ui-chrome's `zbui/out`, which other agents use).
- `Bare.Thread` exists but a thread loaded from a file path fails in the bundled runtime (`MODULE_NOT_FOUND`); only `source:` worked (`p0_bare_thread.log`). Moot: Q-1 was answered "no threads".
- The host has no `bc` and no `/usr/bin/time`; time with `date +%s%N`.
- The kit's script bodies are `> FILL (P1)` on purpose: P1 writes them from the headers. Every other `FILL:` left is an approval line.
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

None.
