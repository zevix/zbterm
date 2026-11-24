# Profile dialog and command plugins — goal and requirements (the WHAT)

**Project:** `261121_dialog-and-command-plugins` · **Area:** `renderer/` (session editor, steps editor, plugins), `electron/` (PTY spawn, command-plugin files) · **Written:** 2026-11-21 · **Design:** `design.md` · **Notes:** `notes--context.md`

## Goal

The profile dialog becomes a floating, draggable window that can stay open while the user copies
from the terminal; the launch steps gain user command plugins (`.js` files in the app's config
dir), a Plugins dialog to choose what "+ Add" offers, profile-name placeholders, and a Shell
Command that runs like the user's own shell. Checked on a scratch packaged app under `uisolate`.

## Requirements

| id | hard/soft | the system shall … | check |
|---|---|---|---|
| R1 | hard | when an identity is set, name it (e.g. `user@github.com`) in the identity button's tooltip and in the settings menu's identity item (shown when the profile list is collapsed), in place of "Choose your identity" | `acceptance/R1_dialog_float.sh` |
| R2 | hard | show the profile dialog as a floating window with a title (New profile / Edit profile / Copy profile / New-session template) and a drag icon at the title's left, movable by dragging the title and kept inside the window | `acceptance/R1_dialog_float.sh` |
| R3 | hard | keep the profile dialog open while the user clicks in the terminal, selects and copies text there, and pastes it into the dialog's fields; the app behind it is not dimmed | `acceptance/R1_dialog_float.sh` |
| R4 | hard | run a profile's command through the user's shell as an interactive shell (a login one on macOS), so aliases, functions and a PATH set in the shell's start-up files work as at the session's own prompt | `acceptance/R4_plugins.sh` |
| R5 | hard | end the "+ Add" menu with a separator, the chosen command plugins (by default "Sample custom command"), a separator, and "Plugins…" with an icon | `acceptance/R4_plugins.sh` |
| R6 | hard | open from "Plugins…" a Plugins dialog with a checkbox per plugin in two sections, "Built-in" and "From ~/.config/ZBTerm/plugins/commands/" (every `.js` file there), whose choice decides what "+ Add" offers and is saved in that directory's `commands.json` | `acceptance/R4_plugins.sh` |
| R7 | hard | create, when that directory does not exist, sample command plugins in it (`sample_custom_command.js` among them) and a `commands.json` choosing every built-in and only `sample_custom_command.js` | `acceptance/R4_plugins.sh` |
| R8 | hard | replace `{{name}}` in any step's settings with the profile's name ("Work #2") and `{{slug}}` (also spelled `{{name_can}}`) with its slug ("work-2") when the launch is composed, a new name (copy, template "#N") getting its own | `acceptance/R4_plugins.sh` |
| R9 | hard | leave lint, the tests and the static checks updated, and the packaged build booting | `acceptance/R9_release.sh` |

### Unwanted behaviour (mandatory)

| id | hard/soft | if … | the system shall … | check |
|---|---|---|---|---|
| U1 | hard | a plugin file fails to load (syntax error, throws, an id already taken) | list it in the Plugins dialog with the reason, and keep every other plugin and the app working | `acceptance/R4_plugins.sh` |
| U2 | hard | the plugins directory or `commands.json` already exists | never overwrite or add to it | `acceptance/R4_plugins.sh` |
| U3 | hard | a plugin is unticked in the Plugins dialog | still open and keep a profile's steps that use it; only "+ Add" stops offering it | `acceptance/R4_plugins.sh` |
| U4 | hard | the focus is in the terminal while the profile dialog is open | give keys (Esc included) to the terminal, not to the dialog; the dialog closes only by OK, Cancel or Esc inside it | `acceptance/R1_dialog_float.sh` |
| U5 | hard | the user's shell is not one known to take `-i` (bash, zsh, fish, ksh, mksh, sh, dash) | run the command with `-c` as before | `test/engine-client-pty.test.js` |

## Approval

Approved 2026-11-21 by the user (chat: "Approve with defaults"), goal_requirements.md at git-hash bb163dbd, design.md at git-hash a4e1fc7f. Defaults adopted: Q-1 rename recompiles; Q-2 a second dialog keeps the edited one and focuses it; Q-3 no off switch; Q-4 {{name}} filled shell-quoted; R6 shows the real platform path; "command plugins are trusted user code" goes to docs/decisions.md as a new row.
