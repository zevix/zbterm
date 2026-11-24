# Profile dialog and command plugins — phases (the HOW)

A builder's brief is: `/zp/zdata/work/ubitron/dev/docs/templates/rules.md`, the repo's `AGENTS.md`,
**one** phase section below, `goal_requirements.md`, `baseline.md`, `design.md` and the status file.
Paths, not pasted bodies. No phase starts before `goal_requirements.md` and `design.md` carry the
user's approval line.

## Conventions

- npm only. One test file per run, always with a scratch `HOME` and a short `TMPDIR` (< 20 chars):
  `HOME=/tmp/zbdp-h TMPDIR=/tmp/zbdp-t timeout 300 npx brittle-node test/<file>.test.js`. Lint:
  `timeout 300 npm run lint`. Every command carries an explicit `timeout`.
- Package after every renderer, engine or main-process change, into the kit's build dir only:
  `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zblive/out timeout 600 npm run package`. A kit run on a build
  older than the source proves nothing (`baseline.md`: the build at 20:50 lacks the 20:52 fix).
- Logs: `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261121_dialog-and-command-plugins/`
  (`p1_*.log`, `p2_*.log`) and the kit's own `<state dir>.logs`.
- Never edit: the other projects' files, `docs/decisions.md` rows, `AppxManifest.xml`. No new deps,
  no commit, no publish (AGENTS.md *Boundaries*). The earlier projects' uncommitted hunks in the same
  files (`baseline.md` *Working tree*) stay as they are.

**Host.** This Linux box (`zr`) with `uisolate`, `xdotool`, `jq`, `curl`, `python3`, `ssh-keygen`,
`/bin/bash`, the packaged build at `/tmp/claude-1000/zblive/out/ZBTerm-linux-x64/ZBTerm` and the
sidecar at `$ZXTERM_CORE_BIN` (`acceptance/activate`). Every GUI run is under `uisolate` with a scratch
`HOME`; never the maintainer's `~/.config/ZBTerm` (it has no `plugins/` yet, and a real first start
would seed it). No sanctioned exception to any rule.

## Order

```
P0  baseline.md, design.md, phases.md, status, kit README (this document work)   needs: —      done 2026-11-21
P1  review the built code against design.md, fix the gaps, R4 restart fix         needs: P0 + approval
P2  release: R9_release.sh, README user docs, agent_docs pointers, full kit       needs: P1
```
P1 and P2 do not reorder: P2's R9 script asserts the tests P1 may change.

## Phase P0: baseline

**Goal.** Record today's behaviour, the cost and the working tree, and plan the rest, without
touching code. **Covers.** `baseline.md`, `design.md`, this file, `status--design.md`, `acceptance/README.md`.
**Steps.** `git show HEAD:<file> | grep …` per *Today* row; `git status --porcelain`;
`acceptance/run_all.sh --needs`. **Acceptance.** Every Today/Cost cell has a command and an output;
no template placeholder line (the `> FILL` marker) is left in the project dir; `run_all.sh --needs`
exits 0 (it did, 2026-11-21).

## Phase P1: review the built code and close the gaps

**Goal.** The code already in the tree (`baseline.md` *Working tree*, "unverified, built before
approval") matches `design.md` as approved, every *Failure scenarios* row is answered in code or in a
kit check, and `R1_dialog_float.sh` and `R4_plugins.sh` pass on a fresh package.
**Covers.** R1–R8, U1–U5; A-1…A-12, Q-1…Q-4 (their dated answers), C1–C12 of `design.md`.
**Code map.** As `design.md` *Interface* (each `file::symbol` named there). Big files: grep
`renderer/app.js` for `261121_dialog-and-command-plugins`, never read it whole. Tests to extend:
`test/command-plugins.test.js` (placeholders, registry, seeding), `test/engine-client-pty.test.js`
(`commandArgs`, `defaultShell`), `test/renderer-static.test.js` (static markup/CSS).
**Steps.**
1. Read the diff of each file in the code map; list every place it departs from `design.md` or the
   goal rows. Write that list to the status file before changing anything.
2. The R4 restart fix: `renderer/app.js::runCommandPluginFile` now runs a file with `new Function`
   inside try/catch, so a throw ("id taken", syntax error) stays in the Plugins dialog (U1) and never
   reaches the window's error handler. Add a unit test that a throwing file leaves the other files'
   plugins registered. Package, then run `R4_plugins.sh` through the restart step.
3. The review's design changes, each with its check (`design.md` *Failure scenarios* F1–F12 hold the
   reasons and the `file:line`s). Q-1, Q-2, Q-4 as the user answered them; with no answer, the
   recommended default written there.
   - **C1** (F1) `launch-core.js::run`: a placeholder in a plugin's `static shellFields` (Shell Command:
     `command`) is filled `quote(value, scope.shell)`. Unit test; R4 kit correction (a name with
     `; touch "$HOME/PWNED"`: no file, the name printed).
   - **C2** (F2) `command-plugins.js::list`: on POSIX, refuse a file or the directory not owned by the
     user, or writable by group or others ("Writable by other users"). Unit test.
   - **C3** (F3) `app.js::loadCommandPlugins`: re-run every file that has an error on each load. Unit test.
   - **C4** (F4) none in code; R4 kit correction: the scratch `.bashrc` also echoes a banner.
   - **C5** (F5) `pty-session.js::commandArgs`: accept a version suffix
     (`^(bash|zsh|fish|ksh|mksh|sh|dash)(-?[0-9.]+)?$`). `test/engine-client-pty.test.js` cases.
   - **C6** (F6) `app.js::showSessionEditor`: an open dialog with changes is kept and focused, with a
     status line; one without changes is replaced. R1 kit correction; R4 kit correction (the profile
     dialog is still open after Plugins Save/Esc).
   - **C7** (F7) clamp on window resize for every editor (the centred one too); `.session-editor`
     `max-height: calc(100vh - 16px); overflow: auto`; `clampPanel` keeps the whole panel inside;
     `lostpointercapture` ends a drag. R1 kit correction (`win_size 900 480`: fully inside, OK visible).
   - **C8** (F8, F10) `command-plugins.js::seed` into a sibling temp dir, then `rename`; target exists
     → drop the temp. `save` → `sendToAll('commandPlugins:changed')`; renderers re-read the choice.
     Unit tests.
   - **C9** (F9) `list()` returns `choiceError` for an unreadable `commands.json`; the Plugins
     dialog shows it; Save copies the bad file to `commands.json.bad` first. Unit tests.
   - **C11** (F11, Q-1) `app.js::renameSession`: steps with a placeholder → `session.update {cwd,
     command}` from `relaunchFor`. Unit test (`slugOf('###') == 'profile'`); R4 kit correction (a
     rename from the menu keeps the plugin step and the new slug).
   - **C12** (F12) `showSessionEditor` awaits `loadCommandPlugins()`; stored steps that name a plugin
     that is not loaded show "<id> is not loaded; its step is shown as a command". Unit test; R4 kit
     correction (`tmux_session.js` renamed away).
   Each kit change carries `# Kit correction <date> (builder P1): why`. This phase touches more than
   ~3 source files; if the builder finds it too big, split C1–C5 (P1a) from C6–C12 (P1b), with the
   same acceptance for both.
4. The samples' header says "restart ZBTerm to see a change"; the Plugins dialog re-reads the files
   when it opens. Make the two say the same thing.
5. Package; run `R1_dialog_float.sh` and `R4_plugins.sh`; lint.
**Acceptance.** `acceptance/R1_dialog_float.sh` exits 0 and `acceptance/R4_plugins.sh` exits 0 (with
the kit corrections above), each
on a package built after the last source change (`stat` of the build newer than every changed file);
`timeout 300 npm run lint` exits 0; `test/command-plugins.test.js` and `test/engine-client-pty.test.js`
pass whole.
**Gotchas / re-planning signals.** The kit's `plugins_dir` is `$ZBUI_APP_HOME/.config/ZBTerm/...`:
the scratch HOME, via `stableUserData`. The Plugins dialog goes through `showModal`; check it does not
close the floating profile dialog behind it. A `bash -i` in a PTY prints the rc file's own output into
the session (expected). A change that needs a new kit check is a dated `# Kit correction` comment.

## Phase P2: release

**Goal.** The project is releasable: one script proves lint, the tests and the packaged boot; the
README tells a user how to use what P1 left; the agent docs point at the new code.
**Covers.** R9, and U5 through its unit test.
**Code map.** `acceptance/R9_release.sh` (new; copy the shape of
`../261121_improvements-and-fixes/acceptance/R13_release.sh`); `README.md` — the *Session steps*
section (`## Session steps`, around the `Shell Command` table; grep `Steps are plugins`); `agent_docs/architecture.md` —
the launch-plugins bullet (grep `The launch plugins`).
**Steps.**
1. Write `acceptance/R9_release.sh`: `npm run lint` exits 0; `test/command-plugins.test.js`,
   `test/launch-plugins.test.js` and `test/engine-client-pty.test.js` pass whole;
   `test/renderer-static.test.js` fails only its 2 baseline tests (the startup logo text, buffer-search),
   compared by name with `grep -F`; the packaged build boots on a scratch HOME under `uisolate` and its
   renderer reports healthy.
2. README: command plugins (where the files live, the file shape, `commands.json`, the Plugins dialog,
   a file that fails to load), the placeholders `{{name}}`, `{{slug}}`/`{{name_can}}`, Shell Command
   running as an interactive shell (`-i`; `-l -i` on macOS; `-c` for other shells), the floating dialog.
3. `agent_docs/architecture.md`: the launch-plugins bullet says `renderer/plugins/samples/` are not
   built-ins (not in `index.js`/`index.html`, renderer-only, may touch `window` at load), and points at
   `electron/command-plugins.js`. Flag the change in the summary (AGENTS.md *Always*).
4. Package fresh; `acceptance/run_all.sh`.
**Acceptance.** `acceptance/R9_release.sh` exits 0; `acceptance/run_all.sh` prints PASS for
`R1_dialog_float`, `R4_plugins`, `R9_release`.
**Gotchas / re-planning signals.** The full suite takes ~279 s (inherited); R9 runs only the named
files to stay under its 600 s limit. A new renderer-static failure is a P1 regression, not a baseline one.

## Do not

- Never lower a tolerance, weaken an assertion or re-bless a count to get green; the 2 renderer-static
  failures are the baseline's, by name, not a count to grow.
- Do not touch the earlier projects' hunks, their kits (`lib.sh`, `lib_up.sh`, `lib_qp.sh` are reused
  unchanged), or the maintainer's real `~/.config/ZBTerm`.
- Do not make command plugins run in the main process, or add `static host` support (out of this design).
