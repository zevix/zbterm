# Session composition plugins — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.

## Before closing

2026-11-18: built in one unattended session from the user's request (`notes--context.md`); the
requirements in `goal_requirements.md` are the builder's reading of it and are **not yet approved
by the user**, nor are the decisions listed in the notes. Nothing is committed.

Built: the plugin framework (`renderer/plugins/launch-core.js`: `LaunchPlugin`, the launch context
and its scopes, the registry, compile/addable/canRemove/firstError/stepsFor), four plugins
(`change-directory.js`, `shell-command.js`, `ssh.js`, `remote-directory.js`), the dialog's step
list (`steps-editor.js`, wired into `renderer/app.js::showSessionEditor`), the plugins'
main-process half (`electron/launch-plugin-host.js`, `app.launchPlugin`, `app.launchPlugins.env`),
`steps` on the catalog entry (`engine/index.js`, `session.create`/`session.update`, additive
`docs/CORE-CONTRACT.md` rows), `steps` carried through copies and templates, the debug commands
`launch-*`, README "Session steps", `docs/ARCHITECTURE.md` and `agent_docs/architecture.md`
pointers, CHANGELOG.

## Checks

- `acceptance/R1_launch_steps.sh`: PASS on a scratch package (`ZBTERM_FORGE_OUT_DIR`) under
  `uisolate`, against a throwaway local `sshd`: default steps, the Add menu before and after SSH,
  delete rules, the missing-host message, remote browsing, the composed session running its remote
  command in the browsed directory, the steps kept and shown again on Edit, stale steps falling
  back, an old-style session opening as two steps.
- Unit: `test/launch-plugins.test.js` (12 tests), `test/engine-extend.test.js` (the new last test).
- `npm run lint`: clean (the 95 warnings are the same 95 as before the change).
- Full `npm test` (scratch HOME, short TMPDIR): 629/632; the three failures are the same three
  that fail without this change (`renderer-static` "startup logo text" and "buffer-search: the
  buffer-match section", `share-manager-seam` "golden: diagnostics() key set"). One earlier run
  died in `engine-unrecorded` on "File descriptor could not be locked"; it did not repeat in two
  further full runs or alone.
- Regression on the same package: `261110_session-templates` `R4_trigger_creates`,
  `R3_template_choice`, `R1_record_checkbox` (they fill the dialog's `cwd` and `command` fields).
- An adversarial review by a second agent; what it found and what was fixed is in the notes.

## Not checked

- Windows (`cmd.exe` quoting is best effort and unrun; `package.json` lists darwin and linux).
- macOS.
- Password-only SSH hosts: the session itself works (ssh asks in the terminal); browsing cannot,
  and says so. Seen only through the unit test's stubbed failure.
- A shell other than bash as `$SHELL` (fish): the glue (`&&`, `cd`, `exec "$SHELL"`) is meant to be
  valid there, unrun.

## Open for the user

The decisions under "Decisions made without the user" in `notes--context.md`.

## 2026-11-21, done

Closed on the user's instruction ("if there is another project open and waiting for my approval
to close and it looks complete close it"). It was waiting only on the user's read of the
requirements and of "Decisions made without the user" in `notes--context.md`; everything built had
passed its checks (above), and the user had since built on it (`9fa00de` "demo of plugins and
ssh"). Those requirements and decisions stand as approved by that instruction. The *Not checked*
list above (Windows, macOS, password-only SSH browsing, fish) stays as it is: unrun, not failed.
