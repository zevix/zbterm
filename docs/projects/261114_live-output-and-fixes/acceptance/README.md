# Acceptance kit (261114_live-output-and-fixes)

Run as the user would, on the target host:
`source acceptance/activate && acceptance/run_all.sh`.
`activate` sets a private state dir (scratch HOME and storage), so no real store is touched.
One script per requirement: `R<n>_<slug>.sh` / `U<n>_<slug>.sh`; it prints what it runs; exit 0 is pass.
`run_all.sh` gives each script at most 240 s. A script exits 75 "cannot run here" when this host
lacks a `need`; `run_all.sh` lists it as CANNOT RUN, a FAIL. `run_all.sh --needs` says whether this
host can run the kit at all. The verifier (fresh context; `goal_requirements.md` and this directory
only) writes `report--<date>.md`.

**Host.** Linux (`zr`) with `uisolate`, `xdotool`, `jq`, `curl`, `fc-match`, and a packaged build at
`$ZBUI_APP` (default `/tmp/claude-1000/zblive/out/ZBTerm-linux-x64/ZBTerm`, made by
`ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zblive/out npm run package`; repackage after any renderer or
engine change). Each script starts its own app (R3 two) on a free debug-server port with scratch
storage, drives it through the debug server and real keys on the private display, and stops only
the `uisolate` session it started. Harness: `../../261110_ui-chrome/acceptance/lib.sh` and
`../../261113_ui-polish/acceptance/lib_up.sh` (both reused unchanged), and `lib_lo.sh` (this kit).

| script | proves |
|---|---|
| `R1_switch_exact.sh` | 8 switches to a session mid-flood: every line 1..1200 once in the renderer |
| `R2_repaint_exact.sh` | the same across an extend (history restored behind live output) and after an app restart |
| `R3_joined_exact.sh` | the same in a viewer that joined the session from a second app |
| `R4_template_mark.sh` | a template row shows a stamp, not the check, and a pin sits right of it |
| `R5_hidden_matches.sh` | "12 matches (2 + 10 hidden history matches)" for history behind the alternate screen; "3 matches" otherwise |
| `R6_font_labels.sh` | R6 and R7: "+ A" / "- A", aria-labels kept, the A in a serif face this host has |
| `U1_gap_resync.sh` | a chunk lost mid-flood, and a lost tail, are repainted from a fresh frame |
| `U2_old_peer.sh` | against a core sending no positions (`ZBTERM_NO_STREAM_POS=1`) the app works as before |
