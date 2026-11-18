# Session composition plugins — notes and context

## The user's words

Verbatim, 2026-11-18:

> I have a facsinatine project for you - session composition components. Instead of the "Home
> Directory" and "Command" I want to have a plugins system with "Change Directory" and "Shell
> Command" and "SSH"
>
> Its not simple. I want each plugin to be a class in JS file that implements known functions for
> answering if it is available, get UI components to display, get config json object, set from
> config json object
>
> Instead of the "home dir" and "Command" there should be by default two components of "Change
> Directory" and "Shell Command", with delete buttons + "+ Add" button that opens a menu with
> available commands. The user should be able to add commands, edit commands or delete the last
> command
>
> There should be a way for the components to know about each other - think abot the best design
> you can have, so the user can add "ssh" and after that they should have "Change remote directory"
> - subcommand of ssh, with remote browsing, but regular "Change Directory" should not be available
> after ssh

The user then left the work unattended ("dont stop for questions - decide yourself"), so every
choice below that the words above do not settle is the builder's, to be read back to the user.

## Decisions made without the user (read back before "done")

- **Deleting a step that is not last.** The words say "delete the last command"; every row still has
  a delete button ("with delete buttons"). A middle step may be deleted when nothing after it
  changes meaning; otherwise its button is greyed with "Delete the steps after this one first".
- **What several commands mean.** Steps run in order, joined with `&&`; whatever is last keeps the
  terminal. A chain that ends on a command ends when it does (as "Command" always did); a chain
  that ends on a directory, or on an empty Shell Command, ends in an interactive shell.
- **A failing step stops the chain** (`&&`), except after a typed command that `&&` cannot follow
  (it ends in `&`, `;`, a comment…): the next step then starts on a new line and runs regardless.
- **A relative "Change Directory"** is under the directory step before it, or under home.
- **"Change Directory" after a command** is a `cd`; before any command it is the directory the PTY
  starts in, exactly the old "Home Directory" (including its fall-back to home when it is gone).
- **One SSH hop.** A second SSH inside the first is not offered: browsing would need a jump host.
  An `ssh_config` `ProxyJump` alias in the host field covers it.
- **SSH fields:** host (`user@host` or a config alias), port, identity file. No password field:
  ssh asks in the terminal. Browsing uses `BatchMode`, so it needs a key or an agent; without one
  the path can still be typed, and the message says so.
- **Storage.** The steps ride on the catalog entry as an opaque `steps` list next to the `cwd` and
  `command` they compile to (additive to `session.create`/`session.update`). The dialog trusts
  stored steps only while they still compile to that pair.
- **Windows.** The local shell there is `cmd.exe`, whose quoting is best effort (`package.json`
  lists only darwin and linux).

## Kit notes

- The check runs its own `sshd` on 127.0.0.1 as the current user, key only, and puts an `ssh`
  wrapper pinned to a scratch config and `known_hosts` first on the app's PATH: OpenSSH finds
  `~/.ssh` through the password database, not `$HOME`, so a scratch HOME alone would not keep the
  user's own `known_hosts` out of it. The check asserts that file's hash is unchanged.
- The state dir must stay short (the sidecar's socket path, 108 bytes): the default
  `/tmp/claude-<uid>/accept` works, a deep scratch path does not.

## Review

2026-11-18: an adversarial review by a second agent (read-only, given the code and not the
builder's conclusions). Fixed from it: commands joined with `&&` broke after a typed command
ending in `&` or holding a `#` comment (now a new line); `exec "$SHELL"` with no `SHELL` (the PTY
host now sets it); a chain with an SSH step could not be saved where `ssh` was not found (existing
steps are now judged structurally); `cmd.exe` quoting of `"` and `%` (now refused on Windows);
`session.update` renamed before it refused bad `steps`; the compiled ssh command did not guard an
unchecked host or port; a bare relative directory resolved against the app's own working
directory; two small races in the remote browser and the toolkit's `context()`. Found clean: POSIX
quoting, the `app.launchPlugin` surface, the threading of `steps` through templates and copies.
