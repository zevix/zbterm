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
and stops only the `uisolate` session it started. `lib.sh` holds `start_app`, `stop_app`,
`cmd`, `state` and `key` (real keys via `xdotool` on the private display); the sibling
`../../261110_session-templates/acceptance/` uses it too.

| script | proves |
|---|---|
| `R1_version_in_menu.sh` | the version is the settings menu's last item and gone from the brand bar |
| `R2_bubble_clock.sh` | the bubble shows the wall clock beside the elapsed time, in the three formats, across midnight and DST |
| `R3_button_colours.sh` | the New icon is green, the Join icon blue |
| `R4_pane_toggle.sh` | the logo shows a hamburger on hover and toggles the pane, Ctrl+Shift+B too; the tooltip names the hotkey; the state survives a restart |
| `R5_collapsed_layout.sh` | collapsed: top-bar left cluster in order, pane colour, identity/theme in the menu, title box fills the rest; expanded: all back |
| `R6_identity_dot.sh` | the identity dot is orange without an identity and green with one |
| `U1_hotkeys_not_typed.sh` | a real Ctrl+Shift+B never reaches the shell |
| `U2_narrow_and_modal.sh` | narrow window: the toggle still works; open menu: closed first; open dialog: no action |
