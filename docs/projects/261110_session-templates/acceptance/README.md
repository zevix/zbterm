# Acceptance kit

Run as the user would, on the target host:
`source acceptance/activate && acceptance/run_all.sh`.
`activate` sets a private state dir (scratch HOME and storage), so no real store is touched.
One script per requirement: `R<n>_<slug>.sh` / `U<n>_<slug>.sh`; it prints what it runs; exit 0 is pass.
A script exits 75 "cannot run here" when this host lacks a `need`; `run_all.sh` lists it as CANNOT RUN, a FAIL.
`run_all.sh --needs` says whether this host can run the kit at all (phase 0 checks it).
The verifier (fresh context; reads `goal_requirements.md` and this directory only)
writes `report--<date>.md` from `/ubitron/dev/docs/templates/project/acceptance/report--template.md`.
New checks start from `/ubitron/dev/docs/templates/project/acceptance/check--template.sh`.

**Host.** Linux with `uisolate` (the app runs only on a private display), `jq`, `curl`,
and a packaged build at `$ZBUI_APP` (default `/tmp/claude-1000/zbui/out/ZBTerm-linux-x64/ZBTerm`,
made by `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbui/out npm run package`; repackage after
any renderer change). Each script starts its own app on a free debug-server port with
scratch storage, drives it through `POST /renderer/command` (`docs/debug_server_howto.md`),
and stops only the `uisolate` session it started. `../../261110_ui-chrome/acceptance/lib.sh` holds `start_app`, `stop_app`,
`cmd`, `state` and `key` (real keys via `xdotool` on the private display).

| script | proves |
|---|---|
| `R1_record_checkbox.sh` | New and Copy show "Record session", ticked; unticking greys Copy history and Share |
| `R2_unrecorded_live.sh` | an unrecorded session echoes live after a 5 MB flood; Share/Playback/Copy history disabled; engine refuses them |
| `R3_template_choice.sh` | the Advanced section offers none + the three triggers, one choice, and the skip-dialog box; the choice is stored |
| `R4_trigger_creates.sh` | each trigger creates from its template's current settings; skip-dialog opens directly, else the dialog opens prefilled |
| `R5_menu_templates.sh` | the settings menu's three edit items, between separators, each open their trigger's template |
| `R6_deleted_template.sh` | a deleted template still serves its trigger under its own name (or `#N` on a clash), and the created session becomes the template |
| `R7_one_table.sh` | a fourth trigger added as one table entry appears in the dropdown and the menu, and Shift+New still maps to its own trigger |
| `U1_unrecorded_nothing_on_disk.sh` | a marker from an unrecorded session is in no file under scratch HOME, storage, TMPDIR after print, resize, flood, extend, close; control found |
| `U2_template_warnings.sh` | deleting a template, and reusing a deleted template's name (via New, Copy, skip-dialog, rename), warn and name the trigger |
| `U3_template_takeover.sh` | taking a trigger from another profile asks, names it; Cancel changes nothing, OK moves it |
| `U4_new_hotkey_not_typed.sh` | a real Ctrl+Shift+T never reaches the shell and creates a session |
