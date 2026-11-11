# UI chrome and collapsible side pane — phases (the HOW)

A builder's brief is: `/ubitron/dev/docs/templates/rules.md`, **one** phase section below,
`goal_requirements.md`, `baseline.md`, and the status file. Paths, not pasted bodies.

## Conventions

- **Repo rules.** This repo's `AGENTS.md` governs: npm only; `npm run lint`; process safety; ledgers. Where `rules.md` names ubitron tools, use the equivalents below.
- **Interpreter.** Node (version in `baseline.md`); there is no `.venv` here. Deletions still go through `/ubitron/dev/.venv/bin/python -m ubitron.envs.safe_delete <literal path>`.
- **Tests.** One test file per run, scratch `HOME` and a short `TMPDIR`, the staged sidecar:
  `HOME=/tmp/claude-1000/zbui/h TMPDIR=/tmp/zbui-t ZXTERM_CORE_BIN=/zp/zdata/zeev/github/zbterm/npm/zxterm-core-linux-x64/zxterm-core npx brittle-node test/<file>.test.js`
- **Logs.** Under `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261110_ui-chrome/`.
- **Ledgers.** This project takes no `D-nn` or `S-nn`.
- **Do not edit:**
  - `electron/main.js` argv and paparam;
  - `forge.config.js`, `AppxManifest.xml`;
  - the main checkout's uncommitted release work.

**Host.** This Linux machine, with `uisolate`, `xdotool`, `jq`, `curl`, and a packaged build:
`ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbui/out npm run package` (repackage after every renderer change). The kit starts the app only under `uisolate`, with a free debug port and scratch HOME and storage. That is the one sanctioned GUI launch (`AGENTS.md` *Process safety*).

## Order

```
P0  baseline (done by the planner, 2026-11-10)                 needs: —
P1  kit harness lib.sh + debug commands; kit red for the right reasons   needs: P0
P2  menu kinds + version, clock bubble, icon colours, identity dot       needs: P1
P3  side pane: toggle, hamburger, Ctrl+Shift+B, collapsed top bar        needs: P2
P4  kit at HEAD, packaged boot, docs, status                              needs: all
```

The sibling `../261110_session-templates/` depends on P1 (its kit uses `lib.sh`) and on P2's menu `kind`s.

## Phase P0: baseline

**Goal.** Done: `baseline.md`.
**Acceptance.** Every Today/Cost cell has a command and output, and `acceptance/run_all.sh --needs` exits 0. Its only gap, the packaged build, is made in P1.

## Phase P1: kit harness and debug commands

**Goal.** Both projects' kits run end to end, and are red for the right reasons.
**Covers.** Every script body in `acceptance/`; `lib.sh`; the design's *Debug commands*.
**Code map.**
- `renderer/app.js::window.__zbtermDebugCommand`: grep `__zbtermDebugCommand` and add the commands from `design.md`. Each is a pure read, or a click on a real element.
- `docs/debug_server_howto.md` *Renderer commands*: list the new ones.
- `acceptance/lib.sh` (new): `start_app`, `stop_app`, `cmd <json>`, `state` (`ui-state`), `key <xdotool chord>`, `free_port`.
- Model the profile-picker and port handling on `test/debug-server-e2e.js`.

**Steps.**
1. Write the commands and package.
2. Write `lib.sh` and each script body from its header.
3. Run both kits and save the logs.

**Acceptance.**
- Every script fails on its own `jq -e`/`grep` line, not on the harness; each FAIL log ends on that line.
- `test/renderer-static.test.js` and `npm run lint` pass.

**Gotchas.**
- Answer the `profile-picker` popup first.
- `uisolate run --name` reuses a running session; `stop_app` must stop only its own.

## Phase P2: chrome

**Goal.** R1, R2, R3, R6.
**Code map.**
- `renderer/index.html`: `#version` (the brand `h1`), `.brand-actions`, `#identitySetup`, the theme tokens (`:root` and dark).
- `renderer/app.js`:
  - `settingsMenuItems` and `renderSettingsMenu` (~2607–2700): add `kind`;
  - `scrubberTipTextForTs` (~6054) and `updateTimeLabels` (~6020);
  - `applyIdentity` (~5185).
- Unit test `formatWallClock` in `test/renderer-static.test.js`, or a new `test/wall-clock.test.js` that loads the pure function.

**Acceptance.** R1, R2, R3 and R6 are green; the new unit test passes; lint passes.

## Phase P3: side pane

**Goal.** R4, R5, U1, U2.
**Code map.**
- `renderer/index.html`:
  - `.app` grid (~124), `.sidebar`, `.brand`, `.brand-mark` (~181–250);
  - `.topbar` (~934);
  - `@media (max-width: 780px)` (~1936).
- `renderer/app.js`:
  - the capture `keydown` (~1175);
  - xterm setup (grep `new Terminal(`) for `attachCustomKeyEventHandler`;
  - the sidebar width code (~7020);
  - `fitTerminal`/resize (grep `fit(`).

**Acceptance.**
- R4, R5, U1 and U2 are green.
- `uisolate screenshot` of the expanded, collapsed and narrow layouts is saved to the run log directory for the user.

**Gotchas.**
- The terminal must refit after a toggle.
- A width preference saved while collapsed must not be the collapsed width.

## Phase P4: close

**Steps.**
1. Repackage, then run `acceptance/run_all.sh` at HEAD.
2. Run the test files one by one, then `npm run lint`.
3. Update the README UI text (the hotkey) and `docs/debug_server_howto.md`.
4. Rename the status file to `status--verifying.md`.

## Do not

- Never lower a tolerance, weaken an assertion or re-bless a count to get green.
- No new dependencies, and no Electron bump.
- Do not touch the main checkout's working tree, or another session's processes.
