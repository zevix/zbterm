# Profile dialog and command plugins — notes and context

## The user's words

Verbatim, 2026-11-21 (after 261121_improvements-and-fixes R14–R16):

> great. except - where did the active/all toggle go from the top of the profile list?
> - please replace "coose your identity" in the tooltip and settings menu when profiles collapsed to user@github.com when identified
> - Make the profile dialog float, add a title, add it a "drag" icon on the left of the title and allow draggint it from its title
> - Allow keeping it open - allow clicking in the terminal and copying commands and paths from the terminal to the profile dialog
> In the profile commands:
> - Fix the "Shell command" to work for anything that should work for the user - aliases, commands that are in the path etc
> - Add to the bottom of the command plugins list (from + Add) a separator, "sample custom command", separator and "Plugins..." with icon which opens a plugins dialog
> - The "Plugins" dialog should allow selecting with checkboxes the plugins to show in the menu. should have two sections - builtin and "from ~/.config/ZBTerm/plugins/commands/ and list all .js files from there
> - add a few sample js files under ~/.config/ZBTerm/plugins/commands/ one of them sample_custom_command.js
> - have a commands.json in that dir that will have only sample_custom_command.js selected by default
> - Add support in the plugins to use {{name}} to replace the profile name (like "Work #2") and {{name_can}} to canonical (better name?) like "work-1"

Then: "ok please after fixing the bug close the previos project and start a new one".

The All/Active toggle was a regression of 261121 R15 (the new toggles reused the class
`search-toggle` of `#activeOnly`); it was fixed and checked in that project before it closed.

## Readings (the planner's, to read back)

- "canonical (better name?)": `{{slug}}`, the usual word for a lower-case, dash-joined name;
  `{{name_can}}` is accepted too. "Work #2" → `work-2` (the user's "work-1" read as an example of
  the shape, not a rule that the number changes).
- "selected by default": `commands.json` lists the chosen files; built-ins are all chosen.
  Unticking only hides a plugin from "+ Add" (U3).
- "~/.config/ZBTerm": the app's own data directory (`app.getPath('userData')` before the
  per-process Chromium redirect), which is `~/.config/ZBTerm` on Linux and the platform's
  equivalent elsewhere.
- "Shell command … aliases, PATH": the PTY spawned `$SHELL -c "<command>"`, a non-interactive
  shell that reads no rc file and (bash) expands no alias. Now known shells get `-i -c`: the same
  start-up files as the session's own prompt (which is an interactive non-login shell), so what
  works at that prompt works as a command. `-l` as well on macOS only, where an app started from
  the Finder has only the system PATH and terminals start login shells. With no `SHELL` in the
  app's environment the user's login shell (`os.userInfo().shell`) is used, then bash.
- A command plugin is a `.js` file in the built-in plugins' own format (a `LaunchPlugin`
  subclass registered with `window.zbtermLaunch.register`), run in the renderer. It is the user's
  own code from their own config directory, trusted like their shell start-up files.

## Soft changes

- 2026-11-21 (builder P1) C2: phases.md said refuse a file "writable by group or others". Changed to: o+w, or g+w by a group other than the user's primary gid → "Writable by other users"; another owner → "Not owned by you". Why: with this host's umask 0002 every file the user makes is 0664 by their private group, so the literal rule refused them all (the kit's thief.js too). Open for the user (status *Open*).
- 2026-11-21 (builder P1) C11: design said "rename from the right-click menu". The row menu has no Rename; `renameSession` is the hidden `#rename` button, which R4 clicks. Edit-dialog renames already compiled with the typed name.
- 2026-11-21 (builder P1) C12: "tmux_session.js renamed away": R4 now moves it to `tmux_session.js.off` in place of the `rm` (U2's checks are unchanged).
- 2026-11-21 (builder P1) C6: the kept dialog takes focus (it keeps it through `guard()`'s return to the terminal) and flashes an outline; the status says "Close the open profile dialog first".
- 2026-11-21 (builder P1) C7: when the panel scrolls, its OK row stays sticky at the foot; the "+ Add" menu is `position: fixed` on the window (inside a scrolling panel it would be clipped) and closes on scroll.
- 2026-11-21 (builder P1) Interface: `runCommandPluginFile` only runs the source; the try/catch, "registered no plugin" and the reload rules are `launch.runFile`/`launch.reloadFiles` (in reach of the unit tests). New: `launch.missingPlugins`, `LaunchPlugin.shellFields`, `list().choiceError`, IPC event `commandPlugins:changed`.
- 2026-11-21 (builder P1) test: `echo "{{name}}"` → `echo {{name}}` (filled `echo 'Work #2'`), per A-12.
- 2026-11-21 (builder P2) R9: phases.md step 1 said "the packaged build boots … renderer reports healthy". Built: that, plus a `cmp` of the packaged `resources/app` against the project's source files and a check that the scratch plugins dir was seeded. Why: the kit README says a build older than the source proves nothing; the extra checks only add.
- 2026-11-21 (builder P2) README: the user docs sit as three subsections of *Session steps* (Shell Command and your shell, Profile-name placeholders, Command plugins) plus two Highlights bullets, not one section. Why: the README's existing style keeps feature detail under *Session steps*.
- 2026-11-21 (builder P2) phases.md step 4 ("Package fresh; `run_all.sh`"): not repackaged (P2 changed no source; the build is `cmp`-identical) and `run_all.sh` left to the verifier, per the P2 brief.
