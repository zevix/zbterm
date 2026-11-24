# Acceptance kit — 261121_dialog-and-command-plugins

Run as the user would, on the target host:
`docs/projects/261121_dialog-and-command-plugins/acceptance/run_all.sh` (it sources `activate`).
`activate` makes a private state dir (scratch HOME, storage, Electron user data, a short TMPDIR
`/tmp/zbdp-k`), so no real store is touched — in particular never the maintainer's
`~/.config/ZBTerm/plugins/`. Every app runs on its own `uisolate` display. One script per requirement
group; it prints what it runs (`set -x`); exit 0 is pass, 75 is "cannot run here" (a FAIL).
`run_all.sh --needs` says whether this host can run the kit at all (2026-11-21 on `zr`: yes).
The verifier (fresh context; reads `goal_requirements.md` and this directory only) writes
`report--<date>.md`.

**Host.** Linux (`zr`, the maintainer's box) with `uisolate`, `xdotool`, `jq`, `curl`, `python3`
(R1's stand-in `<user>.keys` server), `ssh-keygen`, `/bin/bash`, `npm` (R9); the packaged build under
test at `/tmp/claude-1000/zblive/out/ZBTerm-linux-x64/ZBTerm` (`$ZBUI_APP`), built with
`ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zblive/out npm run package`, and the zxterm-core sidecar at
`$ZXTERM_CORE_BIN` (default `npm/zxterm-core-linux-x64/zxterm-core` in the checkout). Repackage after
every renderer, engine or main-process change: a build older than the source proves nothing.

| script | proves |
|---|---|
| `R1_dialog_float.sh` | R1, R2, R3, U4: the identity's name in the tooltip and the collapsed settings menu; the Edit dialog's title and grip, no dimming, a drag by the title, kept inside the window; it stays open while the terminal is clicked, copied from, typed into and sent Esc; paste into a field; Esc inside closes it |
| `R4_plugins.sh` | R4–R8, U1–U3: seeding on first start; the "+ Add" menu's tail and icon; the Plugins dialog's sections, rows and failed files with reasons; Save rewrites `commands.json` and the menu; `{{name}}`/`{{slug}}`; a bash alias and a `~/.bashrc` PATH entry in a Shell Command; an unticked plugin's step kept; a Clone's own name; no re-seed after a restart |
| `R9_release.sh` | R9 (and U5 through `test/engine-client-pty.test.js`): lint; the command-plugins, launch-plugins and engine-client-pty tests whole; renderer-static whole too (kit correction 2026-11-21, orchestrator: its 2 baseline failures were fixed); the packaged build's `resources/app` byte-identical to the project's source files; it boots on a scratch HOME under `uisolate`, `/health` ok with engine and renderer ready, the plugins directory seeded. Written 2026-11-21 (builder P2) |

Helpers: `lib_dp.sh` (this kit: `editor`, `pstate`, `drag_xy`, `center`, `plugins_dir`), and the
harness reused unchanged from `../../261110_ui-chrome/acceptance/lib.sh`,
`../../261113_ui-polish/acceptance/lib_up.sh` and `../../261115_quit-pins-reorder/acceptance/lib_qp.sh`.

## Gaps (rows or parts of rows with no check here)

- **R9**: the full `npm test` suite is not run (it is over R9's 600 s limit); only the three named
  test files and renderer-static. (Kit correction 2026-11-21 (builder P2): was "no script until P2".)
- **U5**: checked only by the unit test `test/engine-client-pty.test.js` (`commandArgs` with xonsh),
  which R9 will run; no GUI check with a shell outside the list.
- **R2**: only the "Edit profile" title is checked; "New profile", "Copy profile" and
  "New-session template" are not.
- **R4**: only bash on Linux is run for real; zsh/fish `-i` and macOS's `-l -i` rest on the unit test.
- **R8**: a Clone's own name is checked; a template's "#N" launch and the Copy dialog are not.
- **U1**: the failed files are listed with reasons and the other plugins stay; "the app keeps working"
  rests on the harness's renderer health at the restart step, no separate assertion.
- **R6 / R7 across windows and processes** (F8): two windows' "+ Add" after one Saves, and two app
  processes seeding at once, rest on unit tests (P1 C8); no GUI check.
- P1 kit corrections made 2026-11-21 (builder P1): R1 has C6/C7 steps, R4 has C1/C4/C6/C11/C12 steps (each marked `# Kit correction`). C11 renames through the hidden `#rename` button (the row menu has no Rename).
