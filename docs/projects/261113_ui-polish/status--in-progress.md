# UI polish: timeline, search, menus, size lock — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-13 (builder, from 18:14): requirements approved (R1 bottom right, R13 added,
R4 today's content on two lines, Q-6–Q-11 proposed defaults adopted). The builder writes the kit
(`acceptance/`, kit `up` in `docs/acceptance/index.json`), implements in `renderer/`, and proves it
on a scratch package (`/tmp/claude-1000/zbui-polish/out`).

## Done

- Requirements (2026-11-13): approved; R13 added.

## Open

- R7's defect is read from the CSS; the builder confirms it with a screenshot under `uisolate`.
- R13 interacts with kits that click rows right after the list changes: they must wait out the 500 ms guard.
- `docs/projects/README.md`, `docs/register.md`, `docs/decisions.md` are named by AGENTS.md but absent (removed in b9a1c7b); no ledger id was taken.

## Ids allocated

None.
