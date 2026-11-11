# Unrecorded sessions and new-session templates — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-11: `goal_requirements.md` and `design.md` approved by the user (approval lines hold the hashes). No phase started; the next is P1. No code has been touched.

## Done

- 2026-11-11 planner: approval lines written (user said "approved" in chat).
- 2026-11-10 planner: project files, review (Sonnet, fresh context, 15 rows, answered), P0 baseline (`../261110_ui-chrome/baseline.md`).

## Measured

See `../261110_ui-chrome/baseline.md` (test loop, lint, package times, 2026-11-10).

## Gotchas

- Tests need `ZXTERM_CORE_BIN=/zp/zdata/zeev/github/zbterm/npm/zxterm-core-linux-x64/zxterm-core`. The worktree has no staged sidecar (`npm/` is gitignored).
- `node_modules` resolves upward to the main checkout's for some packages (brittle came from `/zp/zdata/zeev/github/zbterm/node_modules`); the worktree has its own after `npm ci`.
- Work lives on branch `ui-chrome`, worktree `.claude/worktrees/ui-chrome`. The main checkout has unrelated uncommitted release work; leave it alone.

## Ids allocated

None. One `D-nn` is pending (design *Decisions*), to be taken at landing time from `docs/decisions.md`.

## User owes

None.

## Open

None.

## Soft changes to read back

None.
