# UI chrome and collapsible side pane — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

done, 2026-11-11: the user tried the build and said "its great - its what I asked for" (2026-11-11, in chat), after the soft changes below were read back to them. Verifier report `acceptance/report--2026-11-11b.md`: GREEN 8/8 at e56faf6 on `zr`. The first report (`report--2026-11-11.md`) was RED from a packaging gap (`npm run package` did not vendor renderer assets), fixed in e56faf6.

## Done

- P0 baseline (planner, 2026-11-10): `baseline.md`; planning commit 925e56d.
- P1 kit harness, debug commands, kit bodies (red for the right reasons): f31ed6b.
- P2 menu `kind`s and version in the settings menu, wall-clock bubble (`renderer/wall-clock.js`), New/Join icon colours, identity dot: 513d048.
- P3 collapsible side pane: logo/hamburger toggle, Ctrl+Shift+B, collapsed top bar, state kept across restarts: 40cc7b0.
- P4 close (2026-11-11): repackage, both kits, every test file one by one, lint; README UI text (wall-clock bubble, side pane and Ctrl+Shift+B, collapsed top bar, identity dot, version in the settings menu); `docs/debug_server_howto.md` already listed all 12 added commands (checked against `__zbtermDebugCommand`), unchanged; no `FILL:` markers (`grep -rn 'FILL:'` → none); this file renamed. Commit: see `git log` (the P4 commit on `ui-chrome`).

## Measured (P4, at 40cc7b0 + the README change; renderer code unchanged since P3)

Logs: `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261110_ui-chrome/` — `p4_package.log`, `p4_kit_ui/` + `p4_kit_ui.out`, `p4_kit_templates/` + `p4_kit_templates.out`, `p4_files/<test>.log`, `p4_summary.txt`, `p4_freenet-backend_rerun{1,2,3}.log`, `p4_lint.log`.

**This kit** (`ACCEPT_LOG_DIR=… acceptance/run_all.sh`, host `zr`) → exit 0, 1 min 58 s wall:

| script | result |
|---|---|
| R1_version_in_menu | PASS |
| R2_bubble_clock | PASS |
| R3_button_colours | PASS |
| R4_pane_toggle | PASS |
| R5_collapsed_layout | PASS |
| R6_identity_dot | PASS |
| U1_hotkeys_not_typed | PASS |
| U2_narrow_and_modal | PASS |

**Sibling kit** (`../261110_session-templates/acceptance/run_all.sh`) → 11 FAIL, 0 CANNOT RUN, 1 min 2 s wall; each fails on the same line as in P1–P3 (its features are not built):

| script | fails on |
|---|---|
| R1 | `jq -e '[… "Record session"][0] \| .type == "checkbox" and .checked == true'` |
| R2, U1 | `jq -e '.set == true'` |
| R3, R4, R6, U2, U3 | `jq -e '.modal.details \| any(.summary == "Advanced")'` |
| R5 | `jq -e --arg a 'Edit new profile defaults' …` (the three template menu items) |
| R7 | `grep -E 'NEW_SESSION_TRIGGERS *= *(Object\.freeze\()?\[' …/resources/app/renderer/app.js` |
| U4 | `jq -e -n --argjson a 1 --argjson b 1 '$b == $a + 1'` (no session created) |

**Test files**, one process per file (`HOME=/tmp/claude-1000/zbui/h4 TMPDIR=/tmp/zbui-t ZXTERM_CORE_BIN=… node_modules/.bin/brittle-node <file>`), 63 files (`test/*.test.js` + `test/backends/*.test.js`; P0 had 62, P2 added `wall-clock.test.js`): 3736 `ok`, 10 `not ok` (P0: 3708 / 8, counted the same way over all subtest lines), 7 skipped asserts, not counted as passing (same 7 as P0): 1 in `backends/freenet-client.test.js` (the zxterm submodule's `contracts/hashes.json` is not checked out in this worktree) and 6 in `zxterm-seam-codec.test.js` (seam golden fixtures missing). Files with exit ≠ 0:
- `doctor.test.js` not ok 8 — pre-existing.
- `native-linkage.test.js` not ok 3 — pre-existing.
- `zxterm-seam.test.js` crash `no such seam method: test.echo` — pre-existing.
- `backends/freenet-backend.test.js` not ok 2 / sub-assert 5 "the core's debug event carries the tag" (`host.debug.find((e) => e.event === 'host:announce')` found nothing) — **new vs P0, but flaky and not this project's**: three reruns of the file alone pass (`p4_freenet-backend_rerun1..3.log`, 0 `not ok` each), and this branch changes only `renderer/`, two renderer tests and docs (`git diff 8173c60 HEAD --name-only`). Looks like a race on the core's debug-event log. Reported, not fixed.

**Cost:**

| what | P0 | P4 | target | met |
|---|---|---|---|---|
| Full test loop | 321 s per-file sum, 321 s wall (`baseline.md` quotes 642 s: its `awk '{s+=$2}'` also adds the `total` line) | 318 s per-file sum, 320 s wall (same awk → 638) | ≤ today + 60 s | yes |
| Lint | 3.9 s | 3.8 s, exit 0, 95 `require-await` warnings (`grep -c require-await p4_lint.log` → 95) | same | yes |
| Package | 4.0 s | 3.8 s, exit 0 | same | yes |
| Kit run | — | 1 min 58 s (this kit), 1 min 2 s (sibling) | ≤ 10 min per project | yes |

## Gotchas

- Tests need `ZXTERM_CORE_BIN=/zp/zdata/zeev/github/zbterm/npm/zxterm-core-linux-x64/zxterm-core`. The worktree has no staged sidecar (`npm/` is gitignored).
- `node_modules` resolves upward to the main checkout's for some packages; the worktree has its own after `npm ci`.
- Work lives on branch `ui-chrome`, worktree `.claude/worktrees/ui-chrome`. The main checkout has unrelated uncommitted release work; leave it alone.
- `uisolate` keeps its sessions under the real `$HOME`: the scratch HOME must be set *inside* `uisolate run` (lib.sh wraps the app in `env HOME=…`), or `run --name` cannot find the session and fails "Unit … already loaded".
- `uisolate run` detaches the command: killing the `uisolate run` client does not stop the app, and after `uisolate stop` the client lingers. lib.sh finds the app's PID by parentage from `session.json` `groups` and checks its command line before SIGTERM; `stop_app` also kills its own `uisolate run` clients (run_bg ones too).
- Unix socket limit: the sidecar socket lives under `--storage`; per-script dirs are named `R1`/`U2`, not the script name (`…/storage/R1_version_in_menu/…/zxterm-core.sock` was 108 bytes and the sidecar died).
- Under `run_all.sh` the state dir is shared and `activate` sets no EXIT trap in the scripts; lib.sh then sets one that stops the app. Per-script HOME/storage subdirs keep scripts apart.
- A fresh storage auto-selects the `default` profile (no picker); the startup identity wizard is closed with "Not now" (identity stays unset).
- New and Copy open their dialog after an engine call: use `open_dialog`/`row_action`, which wait for the dialog.
- xterm.js today sends **no bytes** for Ctrl+Shift+B or Ctrl+Shift+T (`od -c` shows only the control key `x`). So U1's and U4's "no byte" lines already pass; both kits fail later on the toggle / session-created line. `notes--context.md` U4 ("reaches the shell as ^T") is not what this build does.
- Recorded history and snapshots are encrypted on disk: a grep for a recorded session's marker finds nothing (measured: `grep -rlF` → none). The sibling U1's on-disk grep therefore passes even for a recorded session; its control reads the recorded session's mirror by playback, and it also checks the unrecorded log does not grow across the flood (today 6 → 149 entries).

## Ids allocated

None.

## User owes

None. Commits are on `ui-chrome`, not pushed or merged.

## Open

- Sibling design's reference program says the U1 control is "found" by the on-disk grep; with encryption that cannot happen. The kit uses the header's wording ("in a recorded session's mirror") instead. Planner to confirm.

- `backends/freenet-backend.test.js` "the core's debug event carries the tag" failed once in the P4 loop and passed in three reruns; outside this project's code. Worth a look on `main`.

## Soft changes (read back to the user 2026-11-11; accepted with the build)

- 2026-11-11 (P2), R2 detail: a timestamp later *today* shows the time only; only a later *day* gets the full date (`notes--context.md` *Soft changes*).
- 2026-11-11 (P3), R5 detail: the collapsed top bar's brand cluster uses `--panel-bg` (the sidebar's real token), not the design's non-existent `--sidebar-bg` (`notes--context.md` *Soft changes*).
