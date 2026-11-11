# Search in live session buffers — phases (the HOW)

A builder's brief is: `/ubitron/dev/docs/templates/rules.md`, **one** phase section below,
`goal_requirements.md`, `baseline.md`, and the status file. Paths, not pasted bodies.

## Conventions

- **Repo rules.** This repo's `AGENTS.md` governs: npm only; `npm run lint`; process safety; ledgers; packaged-boot check for `engine/` changes. Where `rules.md` names ubitron tools, use the equivalents below.
- **Interpreter.** Node `v24.19.0`; there is no `.venv` here. Deletions go through `/ubitron/dev/.venv/bin/python -m ubitron.envs.safe_delete <literal path>`.
- **Tests.** One test file per run, scratch `HOME`, short `TMPDIR`, the staged sidecar:
  `HOME=/tmp/claude-1000/zbbs/h TMPDIR=/tmp/zbbs-t ZXTERM_CORE_BIN=/zp/zdata/zeev/github/zbterm/npm/zxterm-core-linux-x64/zxterm-core node_modules/.bin/brittle-node test/<file>.test.js`
  The whole set: `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261111_buffer-search/p0_loop.sh` (copy it per phase, `p<n>_`).
- **Logs.** Under `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261111_buffer-search/`.
- **Ledgers.** This project takes no `D-nn` or `S-nn` (`design.md` *Decisions*: none).
- **Do not edit:**
  - `electron/main.js` argv and paparam; `forge.config.js`; `AppxManifest.xml`;
  - `../261110_ui-chrome/acceptance/lib.sh` (reuse it; this kit's helpers go in `acceptance/lib_bs.sh`), and every other file of the done projects `../261110_ui-chrome/`, `../261110_timeline-fixes/`, `../261110_session-templates/` (their kits are regression checks here, P6);
  - the main checkout's uncommitted release work.

**Host.** This Linux machine (`zr`), with `uisolate`, `xdotool`, `setxkbmap`, `jq`, `curl`, and a packaged build:
`ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbbs/out npm run package` (repackage after every renderer or engine change). The kit starts the app only under `uisolate`, with a free debug port and scratch HOME and storage. That is the one sanctioned GUI launch (`AGENTS.md` *Process safety*). R8 also needs the network the pear backend uses for a join between two local apps; without it R8 exits 75.

## Order

```
P0  baseline (done by the planner, 2026-11-11)                          needs: —
P1  npm ci + package; debug commands; lib_bs.sh; kit bodies (red)       needs: P0
P2  engine: buffer-search.js matcher + session.searchBuffer + contract  needs: P1
P3  one box: move #search to the bottom bar, width rule, Ctrl+Shift+F   needs: P1
P4  in-session search in the box: highlights, count, Enter, Esc         needs: P3
P5  cross-session section in the session list                           needs: P2, P3
P6  kit at HEAD, done kits as regression, packaged boot, tests, docs    needs: all
```

Line numbers below are at 3682f01 (ui-chrome, timeline-fixes and session-templates merged), re-checked by the planner on 2026-11-11.

## Phase P0: baseline

**Goal.** Done: `baseline.md` (at ec04775).
**Acceptance.** Every Today/Cost cell has a command and output. `acceptance/run_all.sh --needs` fails only on the packaged build, which P1 makes.

## Phase P1: kit harness and debug commands

**Goal.** The kit runs end to end and every script is red for the right reason.
**Covers.** Every script body in `acceptance/`; `acceptance/lib_bs.sh`; `design.md` *Debug commands*.
**Code map.**
- `npm ci` in the worktree first (`baseline.md`: it has no `node_modules`), then package.
- `renderer/app.js::window.__zbtermDebugCommand` (~9386): add `search-state` and `buffer-search-log`. Each reads what exists and reports absent features as `null`, `false` or `[]` (today `#search` exists, in the pane: `box.inSidebar == true`). Model on `debugUiState` (~9041), which already reports `sidebar`, `titleBox.topbarBrand` and `sideCollapsed`.
- `docs/debug_server_howto.md` *Renderer commands*: list both.
- `acceptance/lib_bs.sh` (new):
  - `seed_session <name> <shell text>`: `POST /sessions`, input, wait until the text is in `GET /sessions/:id/stats`;
  - `start_second_app` / `stop_second_app`: own HOME, storage, port and `uisolate` session, modelled on `lib.sh::start_app` and `test/debug-server-e2e.js`'s join;
  - `drag_resizer <dx>`: as `../261110_ui-chrome`'s resizer drags;
  - `is_cyan` and `contrast` jq helpers (or a `color.jq` here).
- Each script's header says what it does and asserts; write the body from it. Keep the `need` lines.

**Acceptance.**
- `source acceptance/activate && acceptance/run_all.sh`: every script FAILs on its own `jq -e`/`grep` line, not on the harness; each log ends on that line. R8 may be CANNOT RUN only with a join error quoted.
- `test/renderer-static.test.js` and `npm run lint` pass.

**Gotchas.** From `../261110_ui-chrome/status--done.md` *Gotchas*: scratch HOME inside `uisolate run`; short per-script dir names (108-byte socket path); answer the profile picker; close the identity wizard.

## Phase P2: engine search

**Goal.** `session.searchBuffer` counts matches in a live session's mirror, own or joined, in slices, cancellable.
**Covers.** R7 (engine half), R8, U2; `design.md` *Matcher*, *Engine method*, scenarios 3, 6, 7, 9, 10; Q-1.
**Code map.**
- `engine/buffer-search.js` (new): `scanBuffer`, pure.
- `engine/index.js::invoke` (`session.diagnostics` at ~265): add the method beside it. `this.sessions` (runtime `mirror`, made at ~1292), `this.remoteSessions` (`remote.mirror`, made at ~2518).
- `docs/CORE-CONTRACT.md` §5.1: one row.
- `test/buffer-search.test.js` (new): `scanBuffer` on a `TerminalFrame` (wrap, CJK, alt screen, fold, trailing space, 50 000 cap); `searchBuffer` cancel by `seq`; `gone` when the mirror is disposed between slices; a joined pair like `test/share-flood.test.js`.
- `renderer/buffer-search.js` (new, plain script, like `renderer/wall-clock.js`): the same `scanBuffer`. A test runs both copies on the same buffer and compares the results.

**Acceptance.** `test/buffer-search.test.js`, `test/core-contract.test.js`, lint pass. A packaged build boots and `POST /invoke {"method":"session.searchBuffer",…}` answers for a live session (log it).
**Gotchas.** `@xterm/headless` in Bare needs the `navigator`/`performance` shims (`engine/worker.js:13-15`). Do not await `mirrorQueue` in the scan: a flood would hold it.

## Phase P3: one box at the bottom left

**Goal.** R1, R9 (width and placement), U1 green; the name filter works from the new place as before.
**Covers.** `design.md` *Hotkey*, *The box* (placement, `#activeOnly`), *Layout*; scenarios 1, 13, 15, 17, 18, 21, 22; Q-5, Q-6, Q-7, A-8.
**Code map.**
- `renderer/index.html`: `#search` and `#activeOnly` (~2298, inside `.search-wrap` in `.tools`); `.tools` (~340, two columns → New, Join, All), `.search-wrap`/`.search-toggle` (~358); `<footer class="bottom">` (~2368) moves out of `.main` to `.app`; `.app` (~129), `.app.side-collapsed` (~272), `.sidebar-resizer` (~139, `top:0; bottom:0`); `.bottom` (~1239); `@media (max-width: 780px)` (~2154, its `.app`, `.bottom`, `.status`).
- `renderer/app.js`: `els` (~387: `search`, `bottom`, `topbarBrand`); `attachCustomKeyEventHandler` (~861) → `isAppHotkey`; capture `keydown` (~1255, before `isSidePaneHotkey` and `keyTriggerFor`); `isSidePaneHotkey`, `sidePaneBlocked`, `applySidePane` (~8137–8200; `applySidePane` sets the collapsed width source); `applySidebarWidth` (~8222, sets `--sidebar-width`); the `ResizeObserver` (~934) and `syncTerminalLayout` (~7591).
- Tests that read `index.html`'s structure: `test/renderer-static.test.js`.

**Acceptance.** R1, R9 (except its no-request check, which needs P5), U1 green; `../261110_ui-chrome/acceptance/run_all.sh` against this build: R4, R5, U2 green, and any other red recorded under *Regression notes* below with its cause; `test/renderer-static.test.js`, lint pass.
**Gotchas.** `applySidePane` moves New, Join and Settings into `.topbar-brand` and back by their saved homes; `#activeOnly` is not one of them and must stay in `.tools`. The terminal height comes from `syncTerminalLayout`, which subtracts the bar's height: check the terminal still fits after the move, collapsed and expanded.

## Phase P4: in-session search

**Goal.** R2, R3, R4 green.
**Covers.** `design.md` *The box* (keys), *In-session search*; scenarios 2, 4, 5, 6, 11, 16, 20; Q-3, Q-4, A-1, A-5.
**Code map.**
- `renderer/index.html`: `<script src="buffer-search.js">` before `app.js`; `--search-match`, `--search-current` in both themes; `#searchCount`.
- `renderer/app.js`: the `#search` `input` handler (~1170); a `keydown` on `#search` for Enter, Shift+Enter, Esc; `createTerminal` (~814); `renderLiveFrame` (~3795), `renderFrame` (~3744), `selectSession` (~3599) for re-runs.

**Acceptance.** R2, R3, R4 green; R1, R9, U1 still green; lint passes.

## Phase P5: cross-session section

**Goal.** R5, R6, R7, R8, U2, U3 green.
**Covers.** `design.md` *Cross-session*; scenarios 8, 12, 14, 19; Q-1, Q-2, A-4, A-6, A-7.
**Code map.**
- `renderer/app.js`: the `#search` `input` handler (~1170), `refreshSessions` (~1519), `renderSessions` (~2515; the early return for an empty list ~2518; the subtitle at ~2541), `renderSessionSelect` (~3084, unchanged: no buffer section in the dropdown), `api.on('session:list-changed')` (~1369), `applySidePane` (cancel on collapse, search on expand).
- `renderer/index.html`: `.session-sub` (~1102); `--match-cyan` in both themes' token blocks; `.session-section-title`.

**Acceptance.** R5, R6, R7, R8, U2, U3 green, and R9's no-request check; R1–R4 still green; `test/renderer-static.test.js`, lint pass.

## Phase P6: close

**Steps.**
1. Repackage; run `acceptance/run_all.sh` at HEAD.
2. Regression: run the done kits `../261110_ui-chrome/acceptance/run_all.sh`, `../261110_timeline-fixes/acceptance/run_all.sh` and `../261110_session-templates/acceptance/run_all.sh` against this build (point their `ZBUI_APP`/out dir at it). A red caused by the footer move or the box move is fixed in the code, or, if the done kit asserted the old position itself, recorded under *Regression notes* with the date, the script, the line and why; the done kit is never edited.
3. Run every test file one by one; `npm run lint`.
4. README: the box at the bottom left, Ctrl+Shift+F, the buffer-match section. `docs/debug_server_howto.md` checked against `__zbtermDebugCommand`.
5. If a statement in `AGENTS.md` or `agent_docs/` is now false, fix it and say so.
6. `grep -rn 'FILL:'` → nothing; rename the status file to `status--verifying.md`.

**Acceptance.** The kit is green, the done kits are green or every red is a dated regression note, the Cost targets in `baseline.md` are met, and the packaged app boots.

## Regression notes

Dated entries for done-project kit rows this project's layout change affects (`design.md` scenario 21). None yet; at planning time (2026-11-11) no done kit references `#search`.

- 2026-11-11 (builder P3): after the box and footer move, against the P3 package (`/tmp/claude-1000/zbbs/out`), `../261110_ui-chrome/acceptance/run_all.sh` 8/8 PASS (116 s) and `../261110_timeline-fixes/acceptance/run_all.sh` 9/9 PASS (526 s); no red, nothing to record. Logs `runs/261111_buffer-search/p3/kit_uichrome.txt`, `kit_tf.txt`.
- 2026-11-11 (builder P3), for P4/P5: `R9_box_width.sh` cannot pass in P3 as written, and not because of its no-request line only: its collapsed block asserts `.inSession.total > 0` (P4) before the no-request check, and its last block the heading (P5). P3 ran every width/placement line (expanded, after the drag, collapsed, collapsed at 1000x700: all true) and a scratch copy with the search lines replaced by expand-and-compare (`p3/r9_widths_p3.txt`, 16/16 true); the kit itself is unchanged and fails on `.inSession.total > 0`.
- 2026-11-11 (builder P4): `R3_escape.sh` cannot pass in P4: its line 36 asserts the buffer-match row for alpha (P5). P4 ran a scratch copy with only that line replaced (`runs/…/p4/r3_p4_scratch.sh`, `.log`): every other line true. `R9_box_width.sh` now passes `.inSession.total > 0` and the collapsed no-request line, and fails on the P5 heading (`.sessions.heading == "Session buffer matches"`).
- 2026-11-11 (builder P5): `R7_stream_and_cancel.sh` line 43 (the reads line) fails at this design's timing: requests leave 200 ms after the last key, the read loop starts after `type_box`'s 0.3 s sleep, and the search takes ~16 ms; every other line passes (`runs/…/p5/r7_p5_scratch.log`). Left unchanged; see the status file *Open*. `R2_in_session_matches.sh` gained a dated alternate-screen block (a strengthening).

## Do not

- Never lower a tolerance, weaken an assertion or re-bless a count to get green.
- No new dependencies (`@xterm/addon-search`, `bare-channel`), no Electron bump (Q-1 answered: none).
- Never read, decrypt or replay history on disk for a search.
- Never edit a done project's files, its kit included.
- Do not touch the main checkout's working tree or another session's processes.
