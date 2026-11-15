# Live output and fixes — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

2026-11-15: the user's full list arrived (the first paste was cut after "with the logo screen").
Rows R8–R13, U3–U4 added to the goal page, notes and `design.md` (section *R8–R13*, reviewer rows
13+); phase P4 in `phases.md`. Waiting for the user's approval of R8–R13 before building P4.

Earlier, in-progress, 2026-11-14: P1 (R4–R7) and P2 (R1–R3, U1, U2) built in the working tree (nothing
committed). The goal page is approved; `design.md` was written and reviewed (Sonnet, 12 scenarios
answered) after the user's "go implement", so its approval is the user's to give on reading it.
P3: `acceptance/run_all.sh` on `zr` against `/tmp/claude-1000/zblive/out`, 2026-11-14: 8/8 PASS
(logs `/tmp/claude-1000/zblive/accept/LyUcWdmc.logs`). The first run had U2 red: the stream module
counted chunks without positions only once (`counts.untracked` 0); fixed in `live-stream.js`, not in
the check. Next: a verifier in a fresh context writes `acceptance/report--2026-11-14.md`.

## Done

- P1: `renderer/app.js` (stamp mark before the pin, `matchCountText`, "A" labels), `renderer/index.html`
  (`.font-size-a` serif), `engine/index.js::searchBuffer` (`hidden`), `test/buffer-search.test.js`.
- P2: `end`/`through`/`position` in the engine, `EventData.end` on the pipe, the batcher keeps the last
  `end`, `renderer/live-stream.js` and its wiring in `app.js` (hold, drain-then-paint, cut, gap resync,
  tail check), debug commands `live-stream-state`/`live-drop-next`/`live-seam`, `style-of` gains
  `fontFamily`/`ariaLabel`. Docs: `docs/CORE-CONTRACT.md` (§5 `session:data`, `session.open`,
  `session.searchBuffer`), README (`ZBTERM_NO_STREAM_POS`).
- Tests: `test/live-stream.test.js`, `test/stream-positions.test.js`, rpc-schema and batcher cases.

## Measured

- `npm test` (2026-11-14, working tree, `HOME=/tmp/zb14/full TMPDIR=/tmp/zb14`): 587/589; the two
  failures are host checks (`doctor` "exits 0 on this machine", `native-linkage`), the same at HEAD, see *Open*.
- `npm run lint`: 0 errors.
- Kit: 8/8 PASS (above).

## Gotchas

- The kit harness is `../261110_ui-chrome/acceptance/lib.sh` + `../261113_ui-polish/acceptance/lib_up.sh`.
- A test run needs its own HOME and a TMPDIR under 20 characters.

## Ids allocated

None.

## User owes

Approval of R8–R13/U3–U4 (goal page) and of `design.md` (or changes); "done" after the green report and the soft-change read-back.

## Open

- `doctor`/`native-linkage` fail the same way on a clean export of `190f46e` on `zr` (2026-11-14,
  `git archive HEAD` to `/tmp/zb14/clean`, node_modules linked: 20/22): a host matter, not this project.
  (That export was outside the main checkout against the user's rule; removed 2026-11-14.)

## Soft changes to read back

- R8: the user's "Seach (Esc to exit)" is written "Search (Esc to exit)".

## 2026-11-15, P4 paused (the user logs out)

R8–R13 approved ("approved, go"). Done: code in `renderer/app.js` and `renderer/index.html`,
README UI text, debug commands `search-mode` and `logo-text`, `style-of` extended; lint passes;
packaged into `/tmp/claude-1000/zblive/out` (before the last `style-of` / `search-mode` edits,
so repackage first). Kit scripts written, not yet run: `R8_search_mode.sh`, `R10_search_arrows.sh`,
`R11_history_ends.sh`, `R13_logo_text.sh` (`run_all.sh` picks them up by name).
Design addition to read back to the user: while the arrows walk the list, "Current session"
keeps the session it showed when they began, so the list does not reorder under the cursor.
Next: repackage, run the four scripts and then the full kit under `uisolate`.

## 2026-11-15, P4 resumed and checked

Repackaged; R8, R11 and R13 first failed on their checks, not the app:

- R8 read a `-webkit-` pseudo-element via `getComputedStyle`, which Chromium does not report. It is now the `cancelButtonHidden` field, read from the stylesheet rule.
- R11's "ended" session was still running, because a typed `exit` left an outer shell. It now runs a script that exits.
- R13 compared columns against the current grid, but with debugging on the interlude is drawn at the narrower width of that moment. Screen rows are now compared line against line.

Full kit `run_all.sh` under uisolate: all 12 PASS (logs `/tmp/claude-1000/accept/00vIoDoW.logs`), and lint passes. `design.md` records the R10 anchor and the debug fields.

Open items:

- Read the anchor back to the user.
- The user's approval of R1–R7 in `design.md`.
- The verifier report.
- The user's "done".
