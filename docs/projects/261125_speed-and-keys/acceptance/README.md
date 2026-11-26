# Acceptance kit — 261125_speed-and-keys

Run as the user would, on the target host:
`timeout 1500 docs/projects/261125_speed-and-keys/acceptance/run_all.sh` (it sources `activate`).
`activate` makes a private state dir (scratch HOME, storage, Electron user data, short TMPDIR), so
no real store is touched; every app runs on its own `uisolate` display. Each script prints what it
runs (`set -x`); exit 0 is pass, 75 is "cannot run here" (a FAIL); one script at most 240 s.
`run_all.sh --needs` says whether this host can run the kit at all.

**Host.** Linux with `uisolate`, `xdotool`, `jq`, `curl`, `npm`; the packaged build under test at
`$ZBUI_APP` (default `/tmp/claude-<uid>/zblive/out/ZBTerm-linux-x64/ZBTerm`, made with
`ZBTERM_FORGE_OUT_DIR=/tmp/claude-<uid>/zblive/out npm run package`) and the zxterm-core sidecar at
`$ZXTERM_CORE_BIN`. Repackage after every renderer, engine or main-process change.

| script | proves |
|---|---|
| `R1_switch_speed.sh` | R1, U3: key-to-drawn time of a switch onto profiles with a 200 000-entry history, cold and warm; a burst of switch keys ends on the right profile |
| `R1_many_profiles.sh` | R1: the same with 100 profiles |
| `R2_typing_speed.sh` | R2, U4: key echo in a live profile with a large history, quiet and streaming; no output, recorded byte or timeline entry lost |
| `R3_delete_key.sh` | R3, R4, R5, U1, U2: Ctrl+D on a closed session, the toast, the neighbour, cancel, live sessions untouched |
| `R6_search_states.sh` | R6–R11: the two keyboard states, one meaning per key, the status line |

The thresholds are in each script's header and in `../baseline.md` *Cost*. Times come from the
app's own probe (debug command `perf`), not from the script's clock.

Helpers: `lib_sk.sh` (this kit), and the harness reused unchanged from
`../../261110_ui-chrome/acceptance/lib.sh`, `../../261113_ui-polish/acceptance/lib_up.sh` and
`../../261121_improvements-and-fixes/acceptance/lib_if.sh`.

The verifier (fresh context; reads `../goal_requirements.md` and this directory only) writes
`report--<date>.md`, one verdict per requirement, from the exit codes.
