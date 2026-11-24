# Profile dialog and command plugins — baseline (evidence, phase 0)

**Measured:** 2026-11-21 (20:56–21:10 +0200) on `zr` (the maintainer's Linux box), node v24.19.0, tree at
`6d81b4b` (2026-11-19) plus the uncommitted work of earlier projects and of this one (*Working tree*
below) · **Logs:** none kept; every command and its output is in the tables. The planner did not run
the app, the tests or `npm run package` (its brief forbade it).

Read by the planner and builders by path. The user does not approve this page.

**How "Today" is read.** The earlier projects' uncommitted changes (`261121_improvements-and-fixes`,
`261118_session-plugins`) are part of today. This project's code is already in the tree too, built
before any approval (see *Working tree*). So *Today* is HEAD's behaviour for every row this project
touches, shown with `git show HEAD:<file>`. Those files changed in the earlier projects only in ways
that leave these rows alone: the `git diff HEAD` hunks that touch these rows carry this project's tag
`261121_dialog-and-command-plugins` in their comments.

## Reference program

The packaged app, as the user runs it: `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zblive/out npm run package`,
then `/tmp/claude-1000/zblive/out/ZBTerm-linux-x64/ZBTerm`. The user works in a profile's dialog
(New / Edit / Copy / template) while the terminal is in use, adds launch steps from "+ Add", and
keeps `.js` command plugins in `~/.config/ZBTerm/plugins/commands/`. The kit drives the app the same
way on a private display (`acceptance/README.md`).

## Today

| fact | command → output |
|---|---|
| the identity button's tooltip is the fixed text "Choose your identity", even once an identity is set | `git show HEAD:renderer/index.html \| grep -n 'id="identitySetup"'` → `2957: <button id="identitySetup" class="icon-btn" title="Choose your identity">`; `git show HEAD:renderer/app.js \| grep -c 'identitySetup.title ='` → `0` (nothing sets it) |
| the settings menu's identity item (profile list collapsed) reuses that tooltip, so it says "Choose your identity" too | `git show HEAD:renderer/app.js \| grep -n "identitySetup.title) \|\|"` → `4436: label: (els.identitySetup && els.identitySetup.title) \|\| 'Choose your identity',` |
| the profile dialog is modal: a full-window layer dims the app | `git show HEAD:renderer/index.html \| grep -n -A5 '\.session-editor-overlay {'` → `position: fixed; inset: 0; z-index: 25; background: rgba(0, 0, 0, 0.48);` |
| a click outside the profile dialog (the terminal, the list) closes it | `git show HEAD:renderer/app.js \| grep -n 'if (event.target === overlay) close(null)'` → `3971:` (showSessionEditor), also `7348:`, `8073:` (other dialogs, not this project's) |
| the profile dialog has no title, no drag handle and cannot be moved | `git show HEAD:renderer/app.js \| grep -c 'session-editor-title\|dragByTitle'` → `0` |
| a profile's command is spawned as `$SHELL -c "<command>"`: no rc file, no aliases (bash), no PATH added in `~/.bashrc` | `git show HEAD:electron/pty-session.js \| grep -n "\['-c', text\]"` → `90: return platform === 'win32' ? ['/c', text] : ['-c', text]` |
| with no `SHELL` in the app's environment the shell is plain `bash` | `git show HEAD:electron/pty-session.js \| grep -n "env.SHELL \|\| 'bash'"` → `109: return env.SHELL \|\| 'bash'` |
| no command plugins: no main-process module, no IPC, no samples | `git show HEAD:electron/main.js \| grep -c commandPlugins` → `0`; `git ls-tree HEAD renderer/plugins/` → `change-directory.js index.js launch-core.js remote-directory.js shell-command.js ssh.js steps-editor.js` (no `samples/`) |
| "+ Add" lists the addable built-in plugins only: no separators, no "Plugins…", no Plugins dialog | `git show HEAD:renderer/plugins/steps-editor.js \| grep -n 'for (const Plugin of launch.addable'` → `289:` (the whole menu); `git show HEAD:renderer/app.js \| grep -c 'Plugins…'` → `0` |
| a second registration of an id throws, and nothing marks where a plugin came from | `git show HEAD:renderer/plugins/launch-core.js \| grep -n 'registered twice'` → `261: if (registry.has(Plugin.id)) throw new Error(...)` |
| no placeholders: a step's settings go to the launch as typed | `git show HEAD:renderer/plugins/launch-core.js \| grep -c '{{'` → `0` |
| the user's real plugins directory does not exist yet (so the maintainer's own first start would seed it) | `ls ~/.config/ZBTerm/plugins` → `No such file or directory` |
| the packaged build under test predates the last renderer fix (the R4 restart fix, `new Function`) | `stat -c '%y' renderer/app.js` → `20:52:58`; the build `…/ZBTerm-linux-x64/ZBTerm` → `20:50:00`; `grep -c 'new Function' …/resources/app/renderer/app.js` → `0` |
| this host can run the kit | `acceptance/run_all.sh --needs` → `needs: all satisfied on zr`, exit 0 |
| known test failures older than this project (inherited, not re-measured here) | `261121_improvements-and-fixes/baseline.md` (2026-11-21): `npx brittle-node test/renderer-static.test.js` → `not ok 31 - the startup logo text …`, `not ok 37 - buffer-search: …`; the full suite 4 failures (240, 339, 345, 403) |

## Cost

| what | today | target | measured by |
|---|---|---|---|
| a shell start per profile command, bash with no rc file | 3 ms (`-c`), 3 ms (`-i -c`) | `-i` adds the rc file's own time only | `HOME=<empty scratch> bash $m true`, 20 runs each, 2026-11-21 |
| the same with the maintainer's real `~/.bashrc` (read, not changed) | 20 ms (`-i -c`) | ≤ the time the session's own prompt takes to appear | `bash -i -c true`, 20 runs, 2026-11-21 |
| full unit suite | 279 s (inherited) | unchanged ± 10 % | `261121_improvements-and-fixes/baseline.md` `# time = 279054ms`; P2 re-measures |
| package | ~4 min (inherited) | unchanged | same source; P1 re-measures (`time npm run package`) |
| kit | — | ≤ 240 s per GUI script, ≤ 600 s for R9 | `acceptance/run_all.sh` limits |

## Working tree

`git status --porcelain` on 2026-11-21 21:00:

```
 M README.md
 M build/AppxManifest.xml
 M docs/CORE-CONTRACT.md
RM docs/projects/261118_session-plugins/status--verifying.md -> docs/projects/261118_session-plugins/status--done.md
 M electron/main.js
 M electron/pty-session.js
 M engine/buffer-search.js
 M engine/catalog.js
 M engine/index.js
 M engine/share-manager.js
 M package-lock.json
 M package.json
 M renderer/app.js
 M renderer/buffer-search.js
 M renderer/index.html
 M renderer/plugins/launch-core.js
 M renderer/plugins/steps-editor.js
 M test/buffer-search.test.js
 M test/catalog-sort.test.js
 M test/engine-client-pty.test.js
 M test/launch-plugins.test.js
 M test/renderer-static.test.js
 M test/share-manager.test.js
?? docs/projects/261121_dialog-and-command-plugins/
?? docs/projects/261121_improvements-and-fixes/
?? electron/command-plugins.js
?? renderer/plugins/samples/
?? test/command-plugins.test.js
```

**This project's code — unverified, built before approval.** The previous session wrote it with no
baseline, design, review or approval. P1 reviews it against `design.md`; nothing here counts as done.

| file | this project's part |
|---|---|
| `electron/command-plugins.js` (new) | the whole file: configure, seed, list, save |
| `renderer/plugins/samples/{sample_custom_command,tmux_session,python_venv}.js` (new) | the whole dir |
| `test/command-plugins.test.js` (new, 7 tests) | the whole file |
| `electron/main.js` | `commandPlugins.configure` and the three `app.commandPlugins.*` IPC methods only; the close confirm, `powerMonitor` and the early engine start are `261121_improvements-and-fixes` R1/U1/R16 |
| `electron/pty-session.js` | `commandArgs` (`-i`, `-l` on macOS), `defaultShell`/`loginShell` |
| `renderer/plugins/launch-core.js` | placeholders, `loadingFrom`/`unregisterFrom`, `stepsFor` names, `relaunchFor`, `withName` |
| `renderer/plugins/steps-editor.js` | `offered`, the grouped menu, "Plugins…", `refresh`, `named()` |
| `renderer/app.js` | `commandPlugins`/`runCommandPluginFile`/`loadCommandPlugins`/`commandPluginShown`, `showPluginsDialog`, `clampPanel`/`dragByTitle`, the editor's title and floating layer, `launchName`, `relaunchFor` in createSession, `identityButtonTitle`, the `plugins-state` debug command, `showModal`'s `body`/`panelClass`; the rest of its diff is the earlier projects' |
| `renderer/index.html` | the `.session-editor-floating`/`-title`/`-grip` and `.plugins-dialog*` styles |
| `test/engine-client-pty.test.js`, `test/launch-plugins.test.js`, `test/renderer-static.test.js` | the hunks tagged `261121_dialog-and-command-plugins` |

Last known state (the previous session's claims, not re-run here): `acceptance/R1_dialog_float.sh`
PASS; `acceptance/R4_plugins.sh` passed up to the restart step; lint passed. The R4 restart fix
(`runCommandPluginFile` → `new Function` in try/catch) is in the tree but not in the packaged build.
