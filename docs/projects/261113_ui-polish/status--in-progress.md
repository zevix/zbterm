# UI polish: timeline, search, menus, size lock — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-13 (builder, from 18:14): requirements approved (R1 bottom right, R13 added,
R4 today's content on two lines, Q-6–Q-11 proposed defaults adopted). The builder writes the kit
(`acceptance/`, kit `up` in `docs/acceptance/index.json`), implements in `renderer/`, and proves it
on a scratch package (`/tmp/claude-1000/zbui-polish/out`).

## Plan

1. Kit (`acceptance/`, kit `up`), Kit corrections to ui-chrome R2 and buffer-search R3/R5/R10/R11.
2. Renderer: R1–R13 (U1/U2 follow).
3. Scratch package, the kit green.
4. Last, after the kit is green (added by the user 2026-11-13, via the coordinator; investigation only, no fix): *Output delivery design*: a design note here with the root cause (switching to a session while it prints shows 1-2 lines twice or drops one: `session:data` IPC events and `session.open`/`extend`/`resync` invoke answers are not ordered against each other), proved with `/tmp/claude-1000/zbv4/probe/dup.sh` (each run under `timeout 600`), 2-3 candidate designs with trade-offs, one recommendation; then stop for the user's approval. Budget 45 min.

## Done

- Requirements (2026-11-13): approved; R13 added.

## Open

- R7's defect is read from the CSS; the builder confirms it with a screenshot under `uisolate`.
- R13 interacts with kits that click rows right after the list changes: they must wait out the 500 ms guard.
- `docs/projects/README.md`, `docs/register.md`, `docs/decisions.md` are named by AGENTS.md but absent (removed in b9a1c7b); no ledger id was taken.

## Ids allocated

None.
