# UI polish: timeline, search, menus, size lock — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

proposal, 2026-11-13: requirements written (`goal_requirements.md`, R1–R12, U1–U2; 397 words) from the user's request of 2026-11-13 (verbatim in `notes--context.md` *The user's words*), with the code each row touches located in `notes--context.md` *Requirement notes*. Nothing designed, built or committed. **Next:** the user answers or accepts the proposed defaults of Q-1–Q-11 and approves the rows; then a planner writes `baseline.md`, `design.md`, `phases.md` and the kit (`acceptance/`, registered in `docs/acceptance/index.json`).

## Done

- Requirements (2026-11-13): this folder, uncommitted.

## Open

- Q-1–Q-11 in `notes--context.md` *Open questions*, each with a proposed default: R1's placement and ended duration, R2's icon beside the count, R3's membership and behaviour, R4's compressed second line, R5's exact format, R6's meaning for a template backed by a session, R8/R9's separators and the version, R11/R12's storage, "Current size", the font while locked and the button's place, R10's identity tooltip.
- R7's defect is read from the CSS; the builder confirms it with a screenshot under `uisolate`.
- Existing kits that may need dated *Kit corrections* once built: `261110_ui-chrome` R2 (bubble text), `261111_buffer-search` R3/R5/R10/R11 (a fourth list section), possibly `261110_session-templates` R4 (reads the record box's state; no kit today asserts the box is disabled in the template editor).
- `docs/projects/README.md`, `docs/register.md`, `docs/decisions.md` are named by AGENTS.md but absent (removed in b9a1c7b); no ledger id was taken.

## Ids allocated

None.
