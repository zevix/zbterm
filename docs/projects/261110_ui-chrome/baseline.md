# UI chrome and collapsible side pane — baseline (evidence, phase 0)

**Measured:** 2026-11-10 on this Linux host. Node `v24.19.0` (`node --version`). Tree is `ui-chrome` at 8173c60 (= `main`).
**Log:** `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261110_ui-chrome/` (`p0_*.log`, `p0_files/<test>.log`, `p0_summary.txt`).

Read by the planner and builders, for both this project and `../261110_session-templates/`. The user does not approve this page.

## Reference program

`acceptance/run_all.sh` in each project. Each script:
- starts the packaged app (`$ZBUI_APP`) under `uisolate`, with scratch HOME, storage and TMPDIR and a free debug-server port;
- drives it through `POST /renderer/command` (`renderer/app.js::window.__zbtermDebugCommand`) and real keys (`xdotool`);
- asserts on `ui-state`, `GET /sessions` and the files under the scratch dirs.

The symbols served are listed in each `design.md` *Interface*.

## Today

| fact | command → output |
|---|---|
| The version sits in the brand bar | `grep -n 'id="version"' renderer/index.html` → `2044: <span id="version" class="version"></span>` |
| The settings menu holds 5 items: 4 toggles and STUN/TURN; no separators, no version | `sed -n 2607,2638p renderer/app.js` (`settingsMenuItems`) |
| The bubble shows elapsed time only | `grep -n "return formatDuration(realElapsed)" renderer/app.js` → `6065` (in `scrubberTipTextForTs`, line 6054) |
| No pane collapse exists, only a width resizer | `grep -cE "sidebar-collapsed\|side-collapsed\|toggleSidePane" renderer/app.js renderer/index.html` → 0 matches; `SIDEBAR_WIDTH_*` at `renderer/app.js:86-97` |
| No Ctrl+Shift hotkeys in the renderer | `grep -cE "ctrlKey && event.shiftKey" renderer/app.js` → 0 |
| No identity dot | `grep -c "data-identity\|identity-dot" renderer/app.js renderer/index.html` → 0; `identity.self` returns `configured` (`engine/index.js:2107`) |
| The engine has no unrecorded mode | `grep -nE "opts\.record\|record:" engine/index.js` → 0; every chunk goes to `appendData` (`engine/index.js:1700`) |
| The Edit dialog has a Shift+New default | `grep -n "Default for new sessions (hold SHIFT on New)" renderer/app.js` → `2349` |
| Narrow-window layout | `grep -n "@media (max-width: 780px)" renderer/index.html` → `1936` |
| Kit tools present | `command -v uisolate xdotool jq curl` → `/home/zeev/.local/bin/uisolate /usr/bin/xdotool /usr/bin/jq /usr/bin/curl` |
| The worktree has no staged sidecar; tests need the main checkout's | Without it: `npm test` → `EngineError: zxterm-core sidecar binary not found for linux-x64` (`p0_npm_test.log`). With `ZXTERM_CORE_BIN=/zp/zdata/zeev/github/zbterm/npm/zxterm-core-linux-x64/zxterm-core` the suite runs. |
| The packaged build has no sidecar either | `find /tmp/claude-1000/zbui/out -name zxterm-core -type f` → nothing. The kit must export `ZXTERM_CORE_BIN` for the app (added to `acceptance/activate`). |
| Test suite, file by file (62 files) | `p0_summary.txt` loop (`node_modules/.bin/brittle-node <file>`, one process per file): 520 `ok`, 2 `not ok`, 1 file crashed (below) |
| Pre-existing failures, not caused by this project | `doctor.test.js` *not ok 8* "run() reports every check and exits 0 on this machine"; `native-linkage.test.js` *not ok 3* (expected `dirty/pty.node`, got `clean/clean.node`); `zxterm-seam.test.js` crashes with `no such seam method: test.echo` (the main checkout's sidecar is not a test build). Not diagnosed. |
| Lint is clean (warnings only) | `npm run lint` → exit 0, 95 `require-await` warnings (`grep -c require-await p0_lint.log` → 95; corrected 2026-11-11, was "5") |

## Cost (mandatory)

| what | today | target | measured by |
|---|---|---|---|
| Full test loop, file by file | 642 s (sum of per-file times; `p0_summary.txt` reports 321 s wall for the loop) | ≤ today + 60 s | `awk '{s+=$2} END{print s}' p0_summary.txt` |
| Lint | 3.9 s | same | `time npm run lint` |
| Package (scratch out dir) | 4.0 s | same | `time ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbui/out npm run package` |
| `npm ci` (warm cache) | 50 s | — | `p0_npmci.log` |
| Kit run | not runnable yet (bodies come in P1) | ≤ 10 min per project | `time acceptance/run_all.sh` |

## Working tree

Main checkout (`git -C /zp/zdata/zeev/github/zbterm status --porcelain`, on branch `extend-reset-modes`). This is unrelated release work, left alone:

```
 M AGENTS.md
 M agent_docs/packaging.md
 M build/AppxManifest.xml
 M build_all.sh
 M flatpak/net.z33v.zbterm.metainfo.xml
 M flatpak/net.z33v.zbterm.yml
 M package-lock.json
 M package.json
?? .claude/
?? flatpak/releases/
?? scripts/flatpak-release.js
```

Worktree `ui-chrome` (`git status --porcelain`): `?? docs/projects/`. These are the planning files only; no code has changed.
