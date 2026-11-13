# UI polish: timeline, search, menus, size lock — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-13 (session from ~19:00): P1–P3 built and green on the builder's run; P4
(output delivery) written, waiting for the user's choice. Next: the regression run
(`docs/acceptance/run.sh --changed c578251..HEAD --out /tmp/claude-1000/zbui-polish/out`), then a fresh
verifier runs `acceptance/run_all.sh` on the repackaged build and writes `acceptance/report--<date>.md`;
then `status--verifying`.

## Plan

`phases.md`: P0 baseline (late), P1 kit, P2 renderer, P3 prove on a scratch package, P4 output
delivery design (investigation only).

## Done

- Requirements (2026-11-13): approved; R13 added.
- P1, P2 (commits 48516dd, 13aff57, 120f79b, 03c396e).
- `design.md`, `baseline.md`, `phases.md` written after the build (2026-11-13), so the folder follows
  `howto.md`. Reviewer (a different model, fresh context): F1–F8 in `design.md`, each answered; F5 led to
  a design change: R13 now compares row places, not item texts (`sessionRowPositions()`).
- Builder's kit run 2026-11-13 on the package from 13aff57/03c396e (before F5): 14 of 14 PASS
  (`/tmp/claude-1000/accept/5oJ78hXc.logs`). R7's screenshot read: the Advanced controls are spaced and
  indented (closes the old *Open* item).
- Repackaged after F5 (`renderer/app.js` identical to the package's, `cmp`).
- P4: `delivery-design.md` + `delivery-probe/`: two mechanisms proven (drop: output between the snapshot
  and the answer, 5/8 trials with an injected 50 ms window, lost lines = bytes after the snapshot;
  duplicate: xterm's write queue survives `term.reset()`, headless test). Candidates A/B/C; A recommended.

## Open

- **The user:** choose a design in `delivery-design.md` (A recommended). No code until then.
- The verifier's report is not written yet (the builder never grades its own work).
- `docs/projects/README.md`, `docs/register.md`, `docs/decisions.md` are named by AGENTS.md but absent
  (removed in b9a1c7b); no ledger id was taken.

## Soft changes to read back

None to rows. One design detail behind hard row R13 (F5, 2026-11-13): a heading or note whose text
changes no longer arms the guard; only rows that change place do.

## Ids allocated

None.
