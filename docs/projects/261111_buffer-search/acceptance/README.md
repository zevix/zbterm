# Acceptance kit

Run as the user would, on the target host:
`source acceptance/activate && acceptance/run_all.sh`.
`activate` sets a private state dir (scratch HOME and storage), so no real store is touched.
Per-script logs go beside it, `<state dir>.logs` (kept after a passing run too; `run_all.sh` prints the path).
One script per requirement: `R<n>_<slug>.sh` / `U<n>_<slug>.sh`; it prints what it runs; exit 0 is pass.
A script exits 75 "cannot run here" when this host lacks a `need`; `run_all.sh` lists it as CANNOT RUN, a FAIL.
`run_all.sh --needs` says whether this host can run the kit at all (phase 0 checks it).
The verifier (fresh context; reads `goal_requirements.md` and this directory only)
writes `report--<date>.md` from `/ubitron/dev/docs/templates/project/acceptance/report--template.md`.
New checks start from `/ubitron/dev/docs/templates/project/acceptance/check--template.sh`.

**Host.** Linux with `uisolate` (the app runs only on a private display), `xdotool`, `jq`, `curl`,
and a packaged build at `$ZBUI_APP` (default `/tmp/claude-1000/zbbs/out/ZBTerm-linux-x64/ZBTerm`,
made by `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbbs/out npm run package`; repackage after any
renderer or engine change). Each script starts its own app on a free debug-server port with scratch
storage, drives it through `POST /renderer/command` (`docs/debug_server_howto.md`) and real keys,
and stops only the `uisolate` session it started. The harness is
`../../261110_ui-chrome/acceptance/lib.sh` (`$ZBUI_LIB`), reused unchanged; this kit's own helpers
are in `lib_bs.sh` (P1). `R8` starts a second app and joins it, so it also needs the network the
pear backend uses; a failed join is exit 75 with the reason.

**Done kits as regression checks.** The box move takes the bottom bar out of `.main`. P6 re-runs
`../../261110_ui-chrome/`, `../../261110_timeline-fixes/` and `../../261110_session-templates/` kits against
this build; those kits are never edited here (`../phases.md` *Regression notes*).

| script | proves |
|---|---|
| `R1_box_and_hotkey.sh` | one box (`#search`), first in the bottom bar at the bottom left, status to its right; Ctrl+Shift+F focuses it; it still filters by name; also at 700x600 |
| `R2_in_session_matches.sh` | every match highlighted and counted, scrollback, wraps and wide characters included; Enter / Shift+Enter step and scroll |
| `R3_escape.sh` | Esc clears the box, the highlights and the list filter, and focuses the terminal |
| `R4_playback.sh` | in playback the box searches the frame shown and follows seeks |
| `R5_buffer_section.sh` | "Session buffer matches" follows the name matches and lists the live sessions whose buffers match; the pane's "All" toggle still filters names |
| `R6_order_and_count.sh` | rows ordered by count; "N matches" in a legible cyan in both themes |
| `R7_stream_and_cancel.sh` | concurrent per-session searches, rows as they finish, stale results dropped |
| `R8_joined_session.sh` | a joined live session is searched and listed |
| `R9_box_width.sh` | the box is as wide as the side pane and under it (also after a resize drag); collapsed, as wide as the top bar's left group, searching the selected session only |
| `R10_click_terminal.sh` | a click in the terminal ends the search (as Esc), typing reaches the program at once with no "input blocked" flash; the box's next focus (click or Ctrl+Shift+F) brings the text back selected; Esc forgets it |
| `R11_selected_on_top.sh` | while searching, the selected session's row, in its selected colour, leads each section it is in; the other rows keep their order |
| `U1_hotkey_not_typed.sh` | Ctrl+Shift+F never reaches the program (also collapsed, and under a Russian layout); nothing happens with a dialog open |
| `U2_live_only.sh` | text only in an ended session or in recorded history is never listed; no history is opened (the engine's `debug.historyReads` count does not move; a positive control moves it) |
| `U3_responsive.sh` | typing echoes, and output reaches the screen, within 150 ms (medians) while five full buffers are searched |
