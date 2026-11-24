# Profile dialog and command plugins — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

`in-progress`, 2026-11-21. P1 and P2 built by builders (not graded; a fresh verifier judges). Next:
verifier runs `acceptance/run_all.sh` (R1, R4, R9). Stopped items: the D-nn row (see *Open*).

## Built in P2 (2026-11-21)

- `acceptance/R9_release.sh` (new): lint; command-plugins, launch-plugins, engine-client-pty whole
  (no `not ok`); renderer-static failing titles == the two baseline titles; the packaged
  `resources/app` byte-identical (`cmp`) to the project's source files; boot on a scratch HOME under
  `uisolate`, `/health` ok + engineReady + renderer.ok, plugins dir seeded. `need` lines; exit 75 via `need`.
- README: Highlights bullets (floating dialog, command plugins); *Session steps* gains the floating
  dialog paragraph and *Shell Command and your shell*, *Profile-name placeholders*, *Command plugins*
  (dir per platform, seeding, "+ Add", Plugins dialog, `commands.json`, load failures, trusted user
  code + the owner/permission rule, a sample plugin); TOC entries.
- `agent_docs/architecture.md` launch-plugins bullet: samples are not built-ins, renderer-only, may
  touch `window`; `electron/command-plugins.js` and `app.commandPlugins.list/save/open`.
- `docs/ARCHITECTURE.md` §4 shell-only `app.*` list + the code-map bullet: `app.commandPlugins.*`,
  `commandPlugins:changed`, samples, `-i -c` / `-l -i -c`.
- Kit corrections: `activate`'s stale `./lib_qp.sh (this kit)` comment; kit README R9 row and gap.
- No source change in P2, so no repackage (build `cmp`-identical to source; README in the package is older).

## Commands run in P2 (logs `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261121_dialog-and-command-plugins/p2_*.log`)

- `acceptance/R9_release.sh` → **0** (`p2_R9.log`).
- `HOME=/tmp/claude-1000/zt/h TMPDIR=/tmp/claude-1000/zt npm test` → 1: 658/662 pass, 269 s
  (baseline 279 s). Failing, all four baseline by title (`261121_improvements-and-fixes/baseline.md`):
  `native-linkage: scan follows the dependency graph and flags libnode` (257), `the startup logo text
  ends on the last row without scrolling` (356), `buffer-search: the buffer-match section, …` (362),
  `golden: diagnostics() key set` (424). No new failure.

## Built in P1 (each C item, and its check)

- R4 fix: `launch-core.js::runFile`/`reloadFiles` hold the try/catch; `app.js::runCommandPluginFile` only runs `new Function`. Unit test "a throwing file leaves the others registered"; R4 restart step.
- C1 `run` fills a `static shellFields` field (Shell Command `command`) as `quote(value, scope.shell)`. Unit test; R4 (name `z; touch "$HOME/PWNED"`).
- C2 `command-plugins.js::unsafeReason`: not owned → "Not owned by you"; o+w, or g+w by a group not the user's primary → "Writable by other users"; a bad folder refuses every file. Unit test (chmod 0666, folder 0777). See *Open* on the group rule.
- C3 `reloadFiles` drops gone files first and re-runs every failed file. Unit test (a.js/b.js claim `t-x`).
- C4 kit only: R4's `.bashrc` echoes ZB-BANNER.
- C5 `commandArgs` matches `^(bash|zsh|fish|ksh|mksh|sh|dash)(-?[0-9.]+)?$`. `engine-client-pty` cases.
- C6 `replaceOpenSessionEditor`: an edited dialog is kept and focused, status "Close the open profile dialog first"; an untouched one is replaced. `focusPrimaryTarget` honours a 1 s focus claim (the `guard()` wrapper refocused the terminal). R1 and R4 checks.
- C7 `clampPanel` keeps the whole panel inside; resize clamp for every editor; `max-height: calc(100vh - 16px)`, `overflow: auto`, sticky OK row; `lostpointercapture`; the "+ Add" menu is `position: fixed` (else clipped). R1 (900x480).
- C8 `seed` into `.commands.seed-*` + `rename`; `save` → `sendToAll('commandPlugins:changed')`, renderer refreshes. Unit tests (existing/appearing target, interrupted seed).
- C9 `list().choiceError`, dialog notice, Save keeps `commands.json.bad`. Unit tests.
- C11 `renameSession` → `session.update {cwd, command, steps}` from `relaunchFor`. Unit test (`slugOf('###')`, rename); R4 (#rename → "Work #9").
- C12 `showSessionEditor` is async, awaits `loadCommandPlugins()`; `launch.missingPlugins` → "<id> is not loaded; its step is shown as a command". Unit test; R4 (tmux_session.js moved away).
- Step 4: the sample header and the dialog note both say "read when the Plugins dialog or a profile dialog opens".

## Commands run in P1 (2026-11-21; logs `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261121_dialog-and-command-plugins/p1_*.log`)

- `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zblive/out npm run package` → 0 (twice; the last one after the last source change: build mtime 1795289033 > app.js 1795289022).
- `acceptance/R1_dialog_float.sh` → 1 (run 1, C6 focus bug, fixed in code), then **0** (run 2, fresh build).
- `acceptance/R4_plugins.sh` → 1 (run 1, kit stand-in tmux exited too early), then **0** (run 2, 43 s).
- `npm run lint` → **0**. Tests (`HOME=/tmp/claude-1000/zt/h TMPDIR=/tmp/claude-1000/zt node test/<f>.test.js`):
  command-plugins **0** (14/14), launch-plugins **0** (14/14), engine-client-pty **0** (8/8),
  renderer-static **1**, only `not ok 31` (startup logo) and `not ok 37` (buffer-search), the baseline's.

## Kit corrections

P1: R1 (C6, C7) and R4 (C1, C4, C6, C11, C12). P2: `activate` comment, kit README. Each marked `# Kit correction 2026-11-21 (builder Pn)`.

## Open

- **Stopped: the D-nn row.** `docs/decisions.md` (and `docs/register.md`) do not exist at HEAD; the last commit to touch it (60e8604, 2026-10-26) said "Next free id: D-40". Appending is impossible and recreating the ledger would invent its contents and its next id. Needs the user: where the ledger lives now. Text ready: "Command plugins (`<app data>/plugins/commands/*.js`) are the user's own code, run in the renderer with its full rights, trusted like shell rc files; files another user owns or can write are refused (261121_dialog-and-command-plugins A-9, C2)."
- **C2's group rule (a brief/reality conflict, for the user):** the brief says refuse "writable by group"; this host's umask is 0002, so every file the user makes is 0664 by their private group, and the literal rule refuses all of them, the kit's `thief.js` included. Built: group-writable is refused only when the group is not the user's primary gid. The user decides whether that's acceptable.
- AGENTS.md (and `agent_docs/`) describe `docs/decisions.md`/`register.md` as present; that was false before this phase. Not changed here. P2 re-found them: AGENTS.md *Boundaries* (ledgers row, Ask-first row), `agent_docs/architecture.md:48`, `agent_docs/updates.md:6`; left for the user.
- No GUI check for two windows (F8) or two processes seeding at once: unit tests only (`acceptance/README.md` *Gaps*).

## Soft changes to read back

The planner's readings, still unheard (`design.md` A-1…A-12): `{{slug}}` primary / `{{name_can}}` alias;
"work-1" read as "work-2"; `-i -c` (`-l -i -c` on macOS); three samples; seeded only when missing;
unticking only hides; fully inside the window; plugins trusted like rc files; a deleted dir is re-seeded;
same slug shared; `{{name}}` one quoted word; the heading shows the platform's dir. Plus P1's (dated in `notes--context.md`):
- C2: a refused file's reason is "Not owned by you" or "Writable by other users"; group-writable by the user's own primary group is allowed.
- C11: there is no Rename in the row's right-click menu; the rename that recompiles is `renameSession` (the hidden `#rename` button); Edit's rename already compiled with the typed name.
- C12: the file is moved away (`.js.off`), not deleted, in R4's restart step.
- C6: the kept dialog flashes an outline as well as taking focus.
- C7: the OK row is sticky at the panel's foot when the panel scrolls; the "+ Add" menu is placed on the window.
- `runCommandPluginFile` keeps its name but only runs the source; the catch is `launch.runFile`.
- The test's `echo "{{name}}"` became `echo {{name}}` → `echo 'Work #2'` (A-12).
- P2 (dated in `notes--context.md`): R9 also checks the build is `cmp`-identical to the source and the plugins dir is seeded; README's placeholder/plugin docs live under *Session steps* subsections.
