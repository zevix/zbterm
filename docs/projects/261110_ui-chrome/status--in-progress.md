# UI chrome and collapsible side pane — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-11: P2 is built. R1, R2 and R3 are green. R6 is green up to its last two lines, which need the side-pane toggle (P3): it fails on `jq -e '.sideCollapsed == true and .identityDotSettings == "set"'`. R4, R5, U1 and U2 still fail on their P1 lines. The next phase is P3 (side pane); R6 goes green with it.

## Next

P3 (side pane): `toggleSidePane`/`applySidePane` (call `updateIdentityDot()` from it), the hamburger, Ctrl+Shift+B, the collapsed top bar, and the collapsed-only Identity and Theme menu items (give the Identity item `identity: identityDotState()`; place them before the separator). Then R4, R5, R6, U1, U2.

## Done

- 2026-11-11 builder P2:
  - Settings menu items carry a `kind` (`check`, `field`, `separator`, `info`): `renderer/app.js::settingsMenuItems` (= `settingsPreferenceItems()`, a separator, then `info` "ZBTerm v<version>"), `renderSettingsMenuItem`, `settingsMenuItemKind` (an item without `kind` still works: `field: true` → field, else check). Every rendered row has `data-kind`; info rows are disabled; separators are `<div role="separator" class="context-menu-separator">`. The sibling's template section goes into `settingsMenuItems` before the separator.
  - `#version` is gone from the brand bar (span, `.version` CSS, `els.version`); the version is `state.appVersion` from `bridge.pkg()`.
  - Bubble: `renderer/wall-clock.js` (new, a plain script before `app.js`; `window.zbtermFormatWallClock`, and `module.exports` for tests) holds `formatWallClock(tsMs, nowMs)`. `scrubberTipTextForTs` returns `<clock> · <elapsed>` (with collapsed gaps `<clock> · 0:42 (1:05)`). `bubble-format` answers `{ text }`.
  - Colours: tokens `--new-green`, `--join-blue`, `--ok`, `--warn` for both themes; `#newSession .btn-icon` green, `#joinLink .btn-icon` blue.
  - Identity dot: `applyIdentity` → `updateIdentityDot()` sets `data-identity="set|unset"` on `#identitySetup`, and on `#settingsToggle` only while `.app.side-collapsed` (P3 must call `updateIdentityDot()` from `applySidePane`). CSS `[data-identity]::after` draws the 8px dot. A menu item with `identity: 'set'|'unset'` gets the same attribute (for P3's collapsed Identity item).
  - Tests: `test/wall-clock.test.js` (new, TZ=Europe/Berlin, the kit's cases plus midnight and padding), one new static test in `test/renderer-static.test.js`.
  - Kit correction in `acceptance/lib.sh::start_app` (dated comment): the script's `TZ` is passed to the app; `uisolate run` does not forward the caller's environment, so R2's `TZ=Europe/Berlin` never reached it.
- 2026-11-11 builder P1:
  - `renderer/app.js::window.__zbtermDebugCommand` gained `ui-state`, `bubble-format`, `click`, `settings-open`, `settings-click`, `dialog-set`, `dialog-submit`, `dialog-cancel`, `confirm-state`, `confirm-answer`, `templates` and `triggers-add` (helpers `debugUiState`, `debugOverlayState`, `debugSettingsMenuState`, `debugFields` just above it). Features not built yet read as absent: `bubble-format` answers `null`, `templates` answers `{ triggers: [], newSessionTemplates: {}, defaultSessionId }`, `triggers-add` throws "no trigger table". P2 replaces these three.
  - `docs/debug_server_howto.md` *Renderer commands*: a table of the new commands.
  - `acceptance/lib.sh` (start_app, stop_app, quit_app, restart_app, cmd, state, api, key, xdo, mouse_to, click_at, focus_terminal, term_text, wait_until, free_port, run_bg; session/dialog helpers for the sibling kit) and `acceptance/color.jq` (hue classes `is_green`/`is_blue`/`is_orange`).
  - Every R*/U* body in both kits, from its header.
- 2026-11-11 planner: approval lines written (user said "approved" in chat).
- 2026-11-10 planner: project files, review (Sonnet, fresh context, 15 rows, answered), P0 baseline (`baseline.md`).

## Measured

P2 logs: same dir, `p2_kit_ui/`, `p2_kit_templates/`, `p2_kit_ui_r2/` (R2 alone after the TZ correction), `p2_wall-clock.log`, `p2_renderer-static.log`, `p2_lint.log`, `p2_package.log`.

- Package → exit 0. `test/wall-clock.test.js` → `tests = 3/3 pass`, `asserts = 16/16 pass`, 0 skipped. `test/renderer-static.test.js` → `tests = 34/34 pass`, `asserts = 206/206 pass`, 0 skipped.
- `npm run lint` → exit 0, 95 `require-await` warnings (`grep -c require-await p2_lint.log` → 95), as before.
- This kit → PASS R1, R2, R3; FAIL R4, R5, R6, U1, U2 (56 s wall). Sibling kit → 11 FAIL, each on the same line as in P1 (63 s wall). Failing lines that changed from P1: R6 now fails on `jq -e '.sideCollapsed == true and .identityDotSettings == "set"'` (needs P3's toggle); every other failing line is the P1 one below.

P1 logs: `p1_kit_ui/`, `p1_kit_templates/`, `p1_renderer-static.log`, `p1_lint.log`, `p1_package.log`.

- Package: `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbui/out npm run package` → exit 0, 5.3 s.
- `HOME=/tmp/claude-1000/zbui/h TMPDIR=/tmp/zbui-t ZXTERM_CORE_BIN=… npx brittle-node test/renderer-static.test.js` → `tests = 33/33 pass`, `asserts = 196/196 pass`, 0 skipped.
- `npm run lint` → exit 0, 95 `require-await` warnings, 0 errors (P0's `p0_lint.log` also holds 95; `baseline.md` says 5).
- `ACCEPT_LOG_DIR=… acceptance/run_all.sh` (this kit) → 8 FAIL, 0 CANNOT RUN, 54 s wall. Sibling kit → 11 FAIL, 0 CANNOT RUN, 60 s wall. The failing line, last `+` line of each log:

| script | fails on |
|---|---|
| R1 | `jq -e '.menu[-1].kind == "info"'` |
| R2 | `jq -e … '.bubble.text \| test($re)'` (hover bubble reads `0:02`) |
| R3 | `jq -e … '.colors.newIcon \| is_green'` |
| R4 | `jq -e '.brandMark.hamburger == true'` |
| R5 | `jq -e '.sideCollapsed == true'` |
| R6 | `jq -e '.identityDot == "unset"'` |
| U1 | `jq -e '.sideCollapsed == true'` |
| U2 | `jq -e '.sideCollapsed == true'` |
| templates R1 | `jq -e '[… "Record session"][0] \| .type == "checkbox" and .checked == true'` |
| templates R2, U1 | `jq -e '.set == true'` (dialog-set "Record session") |
| templates R3, R4, R6, U2, U3 | `jq -e '.modal.details \| any(.summary == "Advanced")'` |
| templates R5 | `jq -e … '.menu as $m \| …'` (the three menu items between separators) |
| templates R7 | `grep -E 'NEW_SESSION_TRIGGERS *= *(Object\.freeze\()?\[' …/resources/app/renderer/app.js` |
| templates U4 | `jq -e -n … '$b == $a + 1'` (no session created) |

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

- Commit is on `ui-chrome` (not pushed). The sibling projects' `status--in-progress.md` edits that were uncommitted before P1 are left uncommitted.

## Open

- R6's last two lines click the logo and need the side pane collapsed: P2 cannot turn R6 green without building P3's toggle. Left red on that line for P3.
- Sibling design's reference program says the U1 control is "found" by the on-disk grep; with encryption that cannot happen. The kit uses the header's wording ("in a recorded session's mirror") instead. Planner to confirm.

## Soft changes to read back

- 2026-11-11 (P2), R2 detail: a timestamp later *today* shows the time only; only a later *day* gets the full date (`notes--context.md` *Soft changes*).
