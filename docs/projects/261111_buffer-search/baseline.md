# Search in live session buffers — baseline (evidence, phase 0)

**Measured:** 2026-11-11 on this Linux host (`zr`). Node `v24.19.0` (`node --version`); Bare `v1.34.0` (`Bare.version`, the `bare-sidecar` prebuild). Tree: `buffer-search` at ec04775.
**Log:** `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261111_buffer-search/` (`p0_loop.sh`, `p0_summary.txt`, `p0_files/<test>.log`, `p0_lint.log`, `p0_scan_bench.log`, `p0_bare_thread.log`).

Read by the planner and builders. The user does not approve this page.

**Host rule.** Every fact below was measured on this host, in this worktree, on 2026-11-11. Line numbers are at ec04775. A number with no command beside it is not a fact.

## Reference program

`acceptance/run_all.sh`. Each script:
- starts the packaged app (`$ZBUI_APP`) under `uisolate` through `../261110_ui-chrome/acceptance/lib.sh`, with scratch HOME, storage and TMPDIR and a free debug port;
- seeds live sessions with known text through the debug server;
- drives the app with real keys (`xdotool`) and `POST /renderer/command`;
- asserts on `search-state`, `buffer-search-log`, `GET /events` and the terminal's rows.

The symbols served are listed in `design.md` *Interface*.

## Today

| fact | command → output |
|---|---|
| Each own live session has a headless mirror in the Bare worker, with 5000 lines of scrollback | `grep -n "mirror: new TerminalFrame" engine/index.js` → `1253: mirror: new TerminalFrame(cols, rows, { scrollback: LIVE_SCROLLBACK }),`; `grep -n "LIVE_SCROLLBACK =" engine/terminal-frame.js` → `7:const LIVE_SCROLLBACK = 5000` |
| The mirror is `@xterm/headless` 6.0.0; its buffer can be read line by line | `head -2 engine/terminal-frame.js` → `require('@xterm/headless')`, `require('@xterm/addon-serialize')`; `grep '"version"' node_modules/@xterm/headless/package.json` (main checkout) → `"version": "6.0.0"` |
| A joined session's mirror is made on its first bootstrap, with the host's scrollback capacity | `sed -n 2447,2451p engine/index.js` → `remote.mirror = new TerminalFrame(frame.cols, frame.rows, { scrollback: frame.scrollback \|\| LIVE_SCROLLBACK })` |
| A resync sends a joined viewer only 500 lines of scrollback | `grep -n "RESYNC_SCROLLBACK" engine/share-manager.js` → `79:const RESYNC_SCROLLBACK = 500`, `913: scrollback: RESYNC_SCROLLBACK,` |
| Playback frames have no scrollback | `sed -n 92,95p engine/player.js` → `new TerminalFrame(base.cols \|\| …, base.rows \|\| …)` (no options; `DEFAULT_SCROLLBACK = 0`, `engine/terminal-frame.js:6`) |
| The renderer has one xterm, 5000 lines of scrollback | `grep -n "new Terminal(\|scrollback: 5000" renderer/app.js` → `758: state.term = new Terminal({`, `764: scrollback: 5000,` |
| The renderer keeps no buffer for unselected sessions: switching resets the terminal and repaints from the engine's mirror | `grep -n "resetVisibleTerminal()" renderer/app.js` → `2989:` (in `selectSession`, 2955); `3001: const opened = await api.invoke('session.open', …)`, `3008: renderLiveFrame(opened.frame, …)`; `sed -n 2059,2060p engine/index.js` → `frame = runtime.mirror.snapshot(runtime.store.log.length)` (full scrollback) |
| "Search sessions" filters by name only, in the engine's catalog | `sed -n 1101,1104p renderer/app.js` → `els.search.addEventListener('input', …) state.query = els.search.value; await refreshSessions()`; `grep -n "includes(q)" engine/catalog.js` → `66: if (q && !value.name.toLowerCase().includes(q)) continue` |
| The row subtitle is built in `renderSessions` | `grep -n "const meta = session.pending" -A3 renderer/app.js` → `2027:` `` `${status}${joined}${shared} · ${formatTime(session.startedAt)} · ${formatBytes(…)}` `` (e.g. `live · 03:45 · 40 B`) |
| The bottom bar is a two-column grid: status, then playback | `sed -n 1205,1208p renderer/index.html` → `.bottom { display: grid; grid-template-columns: 1fr auto;`; `grep -n 'id="status"' renderer/index.html` → `2309:` |
| No cyan colour token exists | `grep -ci "cyan" renderer/index.html renderer/app.js` → `0` and `0` |
| No buffer search exists | `grep -rn "searchBuffer\|bufferSearch\|search-state\|addon-search" engine renderer electron docs` → nothing |
| `@xterm/addon-search` is not a dependency | `ls node_modules/@xterm/` (main checkout) → `addon-fit addon-serialize addon-webgl headless xterm` |
| The app's hotkeys go through two places | `grep -n "isSidePaneHotkey" renderer/app.js` → `794:` (`attachCustomKeyEventHandler`), `1188:` (capture `keydown` on `document`), `7325:` (definition) |
| xterm.js sends no bytes for Ctrl+Shift+letter | `sed -n 307,310p node_modules/@xterm/xterm/src/common/input/Keyboard.ts` → `if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) { if (ev.keyCode >= 65 && ev.keyCode <= 90) {`; later branches need `!ev.ctrlKey` or `ev.key` `_`/`@` |
| Electron binds only Ctrl+Q and Ctrl+Shift+I; Linux and Windows have no menu | `sed -n 1558,1571p electron/main.js` (`installAppShortcuts`: `key === 'q' && !input.shift`, `key === 'i' && input.shift`); `Menu.setApplicationMenu(null)` at 1551 |
| Engine invokes run concurrently in the worker | `sed -n 121,137p engine/worker.js` → `pipe.on('data', async (raw) => { … await engine.invoke(…)` (each frame has its own async handler, no queue) |
| A new method needs a `CORE-CONTRACT.md` row | `sed -n 8,11p docs/CORE-CONTRACT.md` → "`test/core-contract.test.js` compares the method and event tables below against `engine/index.js` … and fails the build when they drift"; §Versioning: "minor — a method … added" |
| The debug server can call any engine method | `grep -n "POST /invoke" docs/debug_server_howto.md` → `` `POST /invoke` \| yes \| any engine method: `{ method, args }` `` |
| Bare has threads built in; no thread or channel package is installed | `p0_bare_thread.log`: `typeof Bare.Thread function`; a thread from `source` ran, `thread counted 3`, `joined in 37 ms`. `ls node_modules \| grep -i -E 'bare-worker\|bare-thread\|bare-atomics'` → nothing; `npm ls bare-channel` → only under `brittle@4.0.2` (dev). A thread loaded from a file path failed in the bundled runtime: `MODULE_NOT_FOUND … child.js` |
| The renderer is sandboxed | `sed -n 1424,1429p electron/main.js` → `sandbox: true, nodeIntegration: false, contextIsolation: true` |
| The worktree has no `node_modules` of its own | `ls node_modules` → `No such file or directory`; tests and lint resolve to the main checkout's |
| The worktree has no staged sidecar | as in `../261110_ui-chrome/baseline.md`; tests need `ZXTERM_CORE_BIN=/zp/zdata/zeev/github/zbterm/npm/zxterm-core-linux-x64/zxterm-core` |
| Kit tools present | `command -v uisolate xdotool jq curl setxkbmap` → `/home/zeev/.local/bin/uisolate /usr/bin/xdotool /usr/bin/jq /usr/bin/curl /usr/bin/setxkbmap` |
| Test suite, one process per file | `p0_loop.sh` (`HOME=/tmp/claude-1000/zbbs/h TMPDIR=/tmp/zbbs-t ZXTERM_CORE_BIN=… brittle-node <file>`): 63 files (`test/*.test.js test/backends/*.test.js`), 3738 `ok`, 8 `not ok`, 7 skip/todo lines, not counted as passing (`backends/freenet-client.test.js`, `zxterm-seam-codec.test.js`) |
| Pre-existing failures, same as `../261110_ui-chrome` P0/P4 | `grep -v 'rc=0 ' p0_summary.txt` → `doctor.test.js` (4 not ok), `native-linkage.test.js` (4 not ok), `zxterm-seam.test.js` (`Error: no such seam method: test.echo`). Not this project's. |
| Lint is clean, with warnings | `npm run lint` → exit 0, `95 warnings` (`grep -c require-await p0_lint.log` → 95) |
| No packaged build of this tree yet; the kit cannot run | `acceptance/run_all.sh --needs` → `cannot run here: /tmp/claude-1000/zbbs/out/ZBTerm-linux-x64/ZBTerm missing (packaged build under test)`. P1 runs `npm ci` in the worktree, then packages. |

## Cost (mandatory)

| what | today | target | measured by |
|---|---|---|---|
| Full test loop, file by file | 309 s wall | ≤ today + 60 s | `p0_loop.sh` (`wall` line of `p0_summary.txt`) |
| Lint | 3.1 s | same | `s=$(date +%s%N); npm run lint; echo $(( ($(date +%s%N)-s)/1000000 ))` → `3129 ms` |
| One full scan of a 5000-line mirror (120 cols, 5040 lines) | 6.1 ms in Bare, 5.5 ms in Node | ≤ 10 ms per session in the engine | `p0_scan_bench.log` (`bench.js`: `translateToString(true)` + `includes`, 20 runs) |
| Serialising the same mirror (what a renderer-side search of other sessions would ship) | 30.2 ms in Bare | not used | same log, `serializeMsPerSession` |
| Echo latency during a cross-session search | not measurable yet | ≤ 150 ms median of 10 | `acceptance/U3_responsive.sh` |
| Kit run | not runnable yet (bodies in P1) | ≤ 10 min | `time acceptance/run_all.sh` |

> 2026-11-12 (builder P6): the kit-run target is now **≤ 20 min**, approved by the user 2026-11-12 in chat ("the user accepts ~18 min"); measured 1067 s on 2026-11-12 (P6, `runs/261111_buffer-search/p6/kit_bs.txt`; P5 also 1067 s). The row above is kept as written. Lint: measured 3.9 s at P6 (3909 ms idle, 3977 ms under a kit run) against 3.1 s at P0; recorded as noise-level, per the user 2026-11-12. P6b kit run after the R7 kit correction: 1132 s, 12/12 PASS (`runs/261111_buffer-search/p6b/kit_bs.txt`).

## Working tree

Worktree `buffer-search` (`git status --porcelain`): `?? docs/projects/261111_buffer-search/`. These are the planning files only; no code has changed.

The main checkout (`git -C /zp/zdata/zeev/github/zbterm status --porcelain`, branch `extend-reset-modes`) holds unrelated release work, left alone:

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
