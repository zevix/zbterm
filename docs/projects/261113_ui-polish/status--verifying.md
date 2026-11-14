# UI polish: timeline, search, menus, size lock — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

verifying, 2026-11-13: the verifier's report is GREEN (`acceptance/report--2026-11-13.md`, 15 of 15 rows,
tree b365b0b). "Done" is the user's word, after the soft-change read-back below. P4: the user chose
design A (byte offsets) on 2026-11-13, to be built as its own follow-up project; nothing is fixed here.
2026-11-14: merged the parallel run's docs (`zr-todo` at fcf4534, retired; reviewed by a fresh Fable
agent before the merge).
2026-11-14: the user added R14–R16 before "done" (app zoom kept when leaving app mode; the lock button
left-most; a red flash on the lock when CTRL -/+ is refused). Built and checked by the builder; no fresh
verifier has run on them yet.
2026-11-14: R17 (a bug the user found: with debugging on, a joined session waited for a click behind
the diagnostics, spinner up). Fixed; red/green shown on two builds; full tier on 1.3.5 GREEN before it.

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
- Regression (2026-11-13, `docs/acceptance/run.sh --changed c578251..HEAD --out /tmp/claude-1000/zbui-polish/out`):
  118 PASS, 2 KNOWN (`native-linkage`, `zxterm-seam`, their known reasons), 1 FAIL: `st/U2_template_warnings`
  (the delete confirmation lacked the template warning; the script deletes right after the session
  appears). Rerun alone: PASS on this package and PASS on the pre-polish `zbbs` package, so a timing flake
  in that kit, not this change. Logs `/tmp/claude-1000/zbtiers/runs/uipolish-1921`.
- Committed b365b0b. Verifier (fresh context, Sonnet): GREEN, report saved verbatim. Its findings 1-7 are
  notes on check strength (R7 measures >= 6 px; the screenshot supplies "like the rest"); none asks for a change.
- P4: `delivery-design.md` + `delivery-probe/`: two mechanisms proven (drop: output between the snapshot
  and the answer, 5/8 trials with an injected 50 ms window, lost lines = bytes after the snapshot;
  duplicate: xterm's write queue survives `term.reset()`, headless test). Candidates A/B/C; A recommended.

- Parallel run (another session on the same project, `zr-todo` 26dfb6e/fcf4534, forked at 03c396e, docs
  only): its own kit run (14/14 PASS on the tree at 120f79b), a second fresh verifier (GREEN with
  findings, tree 26dfb6e, saved verbatim as `acceptance/report--2026-11-13-26dfb6e.md`; it predates F5,
  so R13's guard code differs, and the other 14 rows ran on identical renderer code), and a delivery
  note whose probe (`delivery-probe/dup2.sh`, `seam.txt`) found mechanism 3, merged into
  `delivery-design.md`. Its finding 8 (the current session also listed under buffer matches) is
  buffer-search behaviour that kit expects, outside this project: not carried.
- History: the kit corrections to `261110_ui-chrome` R2 and `261111_buffer-search` R3/R5/R10/R11 went in
  with the maintainer's commit 03c396e "wip" (18:44), which took the whole working tree.

- R14–R16 (2026-11-14): `renderer/app.js`, `renderer/index.html`; new `acceptance/R14_app_zoom_kept.sh`,
  R15 in `R11_lock_menu.sh`, R16 in `R12_lock_holds.sh`; `R14` in the `chrome` topic. Package at
  `/tmp/claude-1000/zbui-polish/out`: R11, R12, R14 PASS alone; `docs/acceptance/run.sh --topic chrome
  --out /tmp/claude-1000/zbui-polish/out`: 63 PASS, 1 FAIL `test/engine-session.test.js` (a `waitFor`
  timeout; alone 3 of 5 runs pass, two different subtests time out; no engine or test file changed, so a
  flake outside this change). Logs `/tmp/claude-1000/zbtiers/runs/20261114-014428-topic`. A first run
  without `--out` used an older package and failed every `up/` script: a wrong-package run, not a result.
- Full tier on 1.3.5 (b8d648f, `docs/acceptance/run.sh --full --package --out /tmp/claude-1000/zbui-polish/out135`):
  124 PASS, 0 FAIL/CANNOT RUN, 3 KNOWN (`doctor`, `native-linkage`, `zxterm-seam`, their known reasons); wall
  1156 s. Logs `/tmp/claude-1000/zbtiers/runs/20261114-021055-full`. (Two earlier attempts with `--out out`
  found no `ZBTerm-linux-x64/ZBTerm` — build_all names it `ZBTerm-1.3.5` — and are not results.)
- R17 (2026-11-14): `beginLiveReveal` ends the pause itself; `ui-state.liveReveal`; new
  `acceptance/R17_debug_join_shows.sh` (real clicks and typing in the Join dialog of a second app), in the
  `chrome` topic. The fixed build: PASS; the same build minus the one line: FAIL (held "paused before live").

## Measured (parallel run, 2026-11-13, host `zr`, package from the tree at 120f79b)

`npm run package` 4 s (incremental); `acceptance/run_all.sh` 14/14 in 555 s: R1 34, R2 32, R3 118, R4 31,
R5 27, R6 19, R7 6, R8 7, R10 23, R11 37, R12 48, R13 109, U1 10, U2 51 s. Older kits' corrected
scripts: bs/R3 87, bs/R5 153, bs/R10 61, bs/R11 215, uc/R2 11 s, all PASS. Lint 4 s.

## Open

- Follow-ups from the second verifier (`report--2026-11-13-26dfb6e.md`; still true on this tree, the kit
  is the same): R10 checks only the orange (no identity) dot, not the green one; R12 exercises CTRL -/+
  in font mode only, not "Zoom whole app"; U2 resizes only the viewer, never the host's window during
  scrollback; `acceptance/activate:42` pins `ZXTERM_CORE_BIN` to this checkout's sidecar, so the kit is
  tied to this host. bs/R11 takes ~214 s: it would fail only under a 240 s cap like this kit's
  `run_all.sh`, which does not run it (`docs/acceptance/run.sh` allows 1200 s).
- `docs/projects/README.md`, `docs/register.md`, `docs/decisions.md` are named by AGENTS.md but absent
  (removed in b9a1c7b); no ledger id was taken.

## Soft changes to read back

The full list, with reasons, is in `notes--context.md` *Soft changes* (merged 2026-11-14; this line
first said "none to rows", which understated it).

- R1: the duration is a new `#sessionDuration` element, and it ticks once a second.
- R5: the check works on the formatter, plus the live labels under 24 h.
- R6: the note reads "Applies to new sessions" and sits beside the box's label.
- R11: a preset lock ticks the preset; a "Current size" lock ticks "Current size".
- R12: while locked, CTRL -/+ is swallowed and the status line says "Terminal size is locked".
- R13: CSS guard; real clicks are blocked, the debug server's synthetic `click` still gets through. Only
  rows that change place arm it; a heading's text changing does not (F5).
- U2: for an ended session, the check is that the lock no longer applies.
- R14: leaving app-zoom mode keeps the level; to change it the user turns app mode back on (Ctrl 0
  resets there). R16's flash also sits on the "± Font" path, which is disabled while locked.
- R17: a click, Enter or Play still ends the 2.5 s diagnostics pause early; it is not removed.
- Tiers: `test/session-data-batcher.test.js` added to sanity/engine/search/keyboard to fix the self-check.
- Checks narrower than the row: R7 as gaps ≥ 6 px plus the screenshot read; R12 sampled; R3 "dimmed" as
  opacity 0.4–0.6.

## Ids allocated

None.
