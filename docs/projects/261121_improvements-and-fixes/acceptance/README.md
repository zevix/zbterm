# Acceptance kit — 261121_improvements-and-fixes

Run as the user would, on the target host:
`docs/projects/261121_improvements-and-fixes/acceptance/run_all.sh` (it sources `activate`).
`activate` makes a private state dir (scratch HOME, storage, Electron user data, short TMPDIR), so
no real store is touched; every app runs on its own `uisolate` display. One script per requirement
group; it prints what it runs (`set -x`); exit 0 is pass, 75 is "cannot run here" (a FAIL).
`run_all.sh --needs` says whether this host can run the kit at all.

**Host.** Linux with `uisolate`, `xdotool`, `jq`, `curl`, `python3` (libX11 for `wm_close.py`),
`sshd` and `ssh-keygen` (R8's throwaway server on 127.0.0.1), `npm`; the packaged build under test
at `$ZBUI_APP` (default `/tmp/claude-<uid>/zblive/out/ZBTerm-linux-x64/ZBTerm`, made with
`ZBTERM_FORGE_OUT_DIR=/tmp/claude-<uid>/zblive/out npm run package`) and the zxterm-core sidecar at
`$ZXTERM_CORE_BIN`. Repackage after every renderer, engine or main-process change.

| script | proves |
|---|---|
| `R1_close_confirm.sh` | R1, U1: outside close with a live session asks; Cancel keeps; Close + "Don't ask again" quits and turns it off; the setting turns it back on; no question with no live session, on Ctrl+Q → Quit, on SIGTERM |
| `R2_search_keys.sh` | R2, R3, R4, U2: cyan name matches; N/M + hint in the status line; Esc ends a search from the terminal and is not passed on; without a search Esc reaches the shell |
| `R5_settings_menu.sh` | R5, R6, R7: stamp icons, Advanced open from the template items, STUN/relay icons |
| `R8_dialog_steady.sh` | R8: the profile dialog keeps its top while the remote list is filtered and unfiltered (fails on the pre-fix build: 142 → 266 px) |
| `R10_profile_menu.sh` | R9–R12, U3, U4: the right-click menu, Clone / copy, the three toggles, Unshare keeps the session, disabled items on an offline profile, Resume |
| `R14_search_toggles.sh` | R14–R16, U5: "M / N" styled, the match case / whole word toggles on all three searches with the box keeping its focus, remembered across a restart; "Loading profiles…" while the engine starts, and the engine started before the page's first call |
| `R13_release.sh` | R13: one version everywhere, the packaged build boots and names it, lint, the unit and static tests (only the baseline's known failures; the matcher and catalog tests whole) |

Helpers: `lib_if.sh` (this kit), `wm_close.py` (a window manager's close message), and the harness
reused unchanged from `../../261110_ui-chrome/acceptance/lib.sh`, `../../261113_ui-polish/acceptance/lib_up.sh`
and `../../261115_quit-pins-reorder/acceptance/lib_qp.sh`.
