# Improvements and fixes — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

2026-11-21: **done**, closed on the user's word ("after fixing the bug close the previos project and
start a new one"). R1–R16, U1–U5 built and packaged (1.9.2). The bug was the All/Active toggle above
the profile list, hidden by R15: its toggles reused `#activeOnly`'s class `search-toggle`; they are
now `.search-opt`, and `acceptance/R14_search_toggles.sh` checks the toggle is shown (kit
correction 2026-11-21). Final `acceptance/run_all.sh` on the repackaged build: 7/7 PASS (R1, R2, R5,
R8, R10, R13, R14). Full `npm test` (scratch HOME), before the fix: 644/648, the four failures
exactly `baseline.md`'s. Nothing committed; the `powerMonitor` shutdown branch is unverified on
this host. The user's next items continue in `261121_dialog-and-command-plugins`.

## Soft changes (closed with the project)

- R12 (detail): "Disable ..." → "Disable HD (save and share fewer updates)".
- R4 (detail): the status cell is narrow at 1280 px and cuts the hint; the line's tooltip holds it all.
- R10 (detail): Remove HD's icon is now the eraser, so it does not share the rocket with Enable HD.
- R16 (soft): the gain on zr is small (~1.15 s → ~1.12 s launch to list); a cached list shown before
  the engine answers was not built.
- R14–R16, U5 rows were written by the planner from the user's message and built at once.
- R2–R13 rows were written by the planner from the user's list and built on the instruction to
  proceed; they are read back with these before "done".

## Ids allocated

None.
