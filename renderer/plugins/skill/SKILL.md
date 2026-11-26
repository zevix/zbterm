---
name: zbterm-plugin
description: Create, check, install and enable a ZBTerm command plugin — a user-written launch step for the profile (session) editor's "+ Add" menu, kept as a .js file in ~/.config/ZBTerm/plugins/commands/ and switched on in commands.json. Use when asked to write, change, debug, install, enable or disable a ZBTerm plugin / command plugin / launch step (e.g. "make a plugin that attaches to a docker container", "why doesn't my plugin show in + Add").
---

# ZBTerm command plugins

A profile's launch is a chain of steps. Each step is an instance of a launch
plugin; the chain compiles to the `{ cwd, command }` pair the PTY host spawns.
Built-in plugins live in `renderer/plugins/` (`cd`, `shell`, `ssh`, `ssh-cd`).
A **command plugin** is the same thing written by the user: one `.js` file in
the app's data directory, run by the renderer.

This skill ships with ZBTerm (`renderer/plugins/skill/` in its sources). It
runs from two places, and `<skill>` below is this file's directory:

- **in a ZBTerm checkout**, as the project skill `.claude/skills/zbterm-plugin`
  (a link to `renderer/plugins/skill/`); the launch code is `renderer/plugins/`;
- **installed for a user** by the app's Plugins dialog ("Install the Claude
  skill") into `~/.claude/skills/zbterm-plugin/`, which carries a copy of the
  launch code in `<skill>/lib/`. It is a snapshot of the app version that
  installed it: after an app update, install it again from the dialog.

Sources to read when this file is not enough (`renderer/plugins/` in a
checkout, `<skill>/lib/` when installed):

- `launch-core.js` — `LaunchPlugin`, `LaunchContext`, `LaunchScope`, quoting, placeholders, the registry
- `steps-editor.js` — the profile editor's step list and the `ui` toolkit `getUI` receives
- `{change-directory,shell-command,ssh,remote-directory}.js` — the built-ins, the best worked examples
- `samples/*.js` — the three samples the app seeds
- checkout only: `electron/command-plugins.js` (how the directory is found,
  seeded, vetted and `commands.json` read) and README "Command plugins" and
  "Profile-name placeholders"

## Workflow

1. Write the plugin as a file in the session scratchpad (not straight into the
   plugins directory), named `<something>.js`.
2. Check it — this loads it with the app's own launch core and prints what
   its step compiles to locally and after SSH, on Linux and Windows:

   ```sh
   timeout 30 node <skill>/scripts/zbterm-plugin.js check <file.js>
   ```

   Read the printed commands: they are the real shell lines. Fix every
   `error:`; judge each `warning:`.

3. Install and enable it (copies it mode 0644, adds it to `commands.json`,
   both atomically; refuses a different existing file without `--force`):

   ```sh
   timeout 30 node <skill>/scripts/zbterm-plugin.js install <file.js>
   ```

   `--no-enable` installs without ticking it. `enable <name.js>`,
   `disable <name.js>` and `list` manage what is there. `--dir <dir>` targets
   another plugins directory (a scratch instance's:
   `<scratch HOME>/.config/ZBTerm/plugins/commands`).

4. Tell the user: no restart is needed — a running ZBTerm reads new or changed
   files and `commands.json` when a profile dialog or the Plugins dialog next
   opens; the plugin is then under "+ Add" (below the built-ins).

Installing into `~/.config/ZBTerm/plugins/commands/` is writing to the user's
live app, which is what this skill is for — but only install there what the
user asked for, and never start or signal their app. In a ZBTerm checkout, to
_see_ a plugin in the GUI yourself, use a scratch instance (`./run.sh --scratch`
under `uisolate`, AGENTS.md process safety) and `--dir`.

## The directory and commands.json

| platform | directory                                                |
| -------- | -------------------------------------------------------- |
| Linux    | `~/.config/ZBTerm/plugins/commands/`                     |
| macOS    | `~/Library/Application Support/ZBTerm/plugins/commands/` |
| Windows  | `%APPDATA%\ZBTerm\plugins\commands\`                     |

- A file counts when its name ends in `.js`, does not start with `.`, and it
  is at most 256 KB (200 files at most). Files load in name order.
- On Linux/macOS the app **refuses** a file, or the whole directory, that is
  not owned by the user or is writable by others (world-writable, or
  group-writable by a group other than the user's primary one). Keep files
  `0644` and the directory `0755`.
- `commands.json` is the "enabled" list:
  `{"builtin": ["cd", "shell"], "commands": ["my_plugin.js"]}`. `commands`
  names files (not ids) that "+ Add" offers; `builtin` lists built-in ids and
  is left out to offer all of them. Preserve whatever `builtin` is there.
  Unticking only hides a plugin from "+ Add": profiles that use it keep working.
- The app seeds the samples only when the directory **does not exist**. Never
  `mkdir` it by hand — the install command seeds it the way the app would.
- If the user ticks/unticks in the Plugins dialog, its Save rewrites
  `commands.json`; do not keep a stale copy and write it back.

## Shape of a plugin

```js
// What it does, in a line or two.
;(() => {
  const launch = window.zbtermLaunch

  class DockerExec extends launch.LaunchPlugin {
    static id = 'my-docker-exec' // stable and unique; stored in every profile that uses it
    static title = 'Docker exec' // the "+ Add" label and the step's label
    static icon = 'fa-box' // a Font Awesome solid icon name

    static isAvailable(ctx) {
      return ctx.platform !== 'win32' // optional; default: everywhere
    }

    static defaults() {
      return { container: '{{slug}}' } // every setting, all strings
    }

    getUI(ui) {
      return ui.input({
        name: 'container',
        placeholder: 'container name',
        value: this.config.container,
        onInput: (value) => {
          this.config.container = value.trim()
        }
      })
    }

    validate(ctx) {
      return this.config.container ? '' : 'Name the container' // '' = fine
    }

    apply(ctx) {
      ctx.scope.run(`docker exec -it ${ctx.quote(this.config.container)} bash`)
    }
  }

  launch.register(DockerExec)
})()
```

Rules the code enforces:

- Wrap the file in an IIFE; it runs as a plain script in the app's page with
  `window.zbtermLaunch`. The page is sandboxed: **no `require`, no Node, no
  `fs`**. A syntax error, a throw, registering nothing, a class that does not
  extend `LaunchPlugin`, or an id held by a built-in or another file makes
  the file fail (shown greyed with the reason in the Plugins dialog).
- **`id`**: pick a prefixed one (`my-…`); never `cd`, `shell`, `ssh`,
  `ssh-cd`, nor the samples' `sample-…`. Changing it later orphans the steps
  of profiles that used it (they open as a plain Shell Command).
- **`defaults()` values must be strings.** `setConfig` drops unknown keys and
  keeps only trimmed strings; a flag is `''` / `'1'`, a number is its text.
- **`static host` and `ui.host()` do not work** in a command plugin (the main
  process only loads the built-ins), and `ctx.facts` holds only built-ins'
  probes. A command plugin cannot probe the machine; it can only compose text.
- One file may register several plugins.

## apply(ctx): composing the launch

`ctx.scope` is the innermost scope — the local shell, the remote one after
an SSH step, or one a wrapper plugin opened. A plugin never names another
plugin; it reads the scope (`ctx.scope.machine.kind` for "which machine am I
on": `'local'` or `'ssh'`).

| call                                                                                          | meaning                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.scope.add(cmd)`                                                                          | a command **you built and quoted**; joined to the next with `&&`. Does not change who keeps the terminal.                                                                                                                       |
| `ctx.scope.run(line)`                                                                         | a command line that **keeps the terminal**: the session ends when it does, unless a later step follows (then `&&`). Sets `interactive = false`.                                                                                 |
| `ctx.scope.interactive = true`                                                                | after this step the session goes on to the next step, or to an interactive shell. Set it after `add()` for "do X, then give me a shell".                                                                                        |
| `ctx.scope.cwd = path`                                                                        | the scope's directory, set by Change Directory before any command: where the PTY starts (root), else see [Wrapping the rest of the chain](#wrapping-the-rest-of-the-chain).                                                     |
| `ctx.quote(text)`                                                                             | one shell word for this scope's shell (`posix` or `cmd`).                                                                                                                                                                       |
| `ctx.quotePath(text)`                                                                         | the same, keeping a leading `~`/`~/` expandable.                                                                                                                                                                                |
| `ctx.unquotable(text)`                                                                        | true on Windows for text holding `"` or `%` — return an error from `validate`.                                                                                                                                                  |
| `ctx.scope.kind`, `.shell`, `.data`, `.commands`                                              | `'local'`/`'ssh'`/…, `'posix'`/`'cmd'`, what the scope's opener shared, commands so far.                                                                                                                                        |
| `ctx.scope.machine`                                                                           | the scope that opened the machine this scope runs on: the root (`kind 'local'`), an SSH scope (`'ssh'`, with its `data.target`), or the scope itself.                                                                           |
| `ctx.platform`, `ctx.depth`, `ctx.has(id)`, `ctx.stepsOf(id)`                                 | the host OS, scope depth (1 = local), earlier steps.                                                                                                                                                                            |
| `ctx.pushScope(kind, { shell, data, owner, interactiveShell, close, sameMachine, takesCwd })` | open a scope the following steps run **inside** (as SSH does); `close(script)` returns the one command the parent runs, `script` being the inner steps (maybe `''`). See `ssh.js` and [below](#wrapping-the-rest-of-the-chain). |

Choosing between them:

- "Set something up, then a shell / the next step" (activate a venv, export a
  variable, `cd`): `add()` + `interactive = true`.
- "This program is the session" (tmux, a REPL, `docker exec`): `run()`.
- "Everything after me runs somewhere else" (a container, `sudo -i`, another
  host): `pushScope()` with a `close` that quotes `script` with the
  **parent's** shell: `launch.quote(script, parent.shell)`. Give the scope its
  own `kind`; without `sameMachine` it counts as another machine, so
  `Change Directory` and SSH are no longer offered inside.
- "Everything after me runs inside me, on this machine" (a multiplexer,
  `ubt run TREE -- …`): the same with `sameMachine: true` — next section.

## Wrapping the rest of the chain

A wrapper is a plugin whose `apply` calls `ctx.pushScope(...)`, so every later
step runs inside it and its `close(script)` turns their script into one
command. Three things to know:

**Indentation is by depth.** The profile editor indents each step once per
scope it runs inside (`ctx.depth - 1`; the row carries `data-depth`). The
kind, owner and `sameMachine` do not matter: any pushed scope indents, a
custom kind like `'ubtrees'` included, and nested wrappers indent further.
The wrapper's own row is in its parent scope, so it sits at its parent's
level and the steps after it sit under it.

**`sameMachine: true`** marks the scope as running on its parent's machine.
`ctx.scope.machine` then stays the parent's, and the built-ins decide by the
machine, not by the kind: inside a local wrapper Change Directory and SSH are
offered, inside a wrapper opened after SSH Change Remote Directory is
(Shell Command words its placeholder by machine too). The scope inherits the
parent's `shell` unless you give one. Leave `sameMachine` out for something
that really is elsewhere (a container, another host). Write `isAvailable`
with `ctx.scope.machine.kind`, not `ctx.scope.kind`, so your plugin is
offered inside other wrappers as well.

**A directory inside the wrapper.** Change Directory as the first step
inside a pushed scope sets that scope's `cwd` (later ones, after a command,
add a `cd`). The root's `cwd` is where the PTY starts; a nested scope's is
handled one of two ways:

- by default its script starts with `cd <dir> && …`, so a wrapper that runs
  `script` in a shell needs to do nothing;
- with `takesCwd: true` the wrapper passes it on itself: read `scope.cwd` (the
  object `pushScope` returned) inside `close`, which runs after every step,
  and no `cd` is added.

```js
apply(ctx) {
  const parent = ctx.scope
  const scope = ctx.pushScope('spitty', {
    sameMachine: true,
    takesCwd: true,
    close: (script) => {
      const args = ['spitty']
      if (scope.cwd) args.push('--cwd', launch.quotePath(scope.cwd, parent.shell))
      // `script` is shell syntax: hand it to a shell, as one quoted word.
      if (script) args.push('--', 'sh', '-c', launch.quote(script, parent.shell))
      return args.join(' ')
    }
  })
}
```

`close('')` means nothing follows the wrapper: start it with its default
program. A wrapper that sets `takesCwd` but cannot take a directory would
silently drop it, so set it only when `close` reads `scope.cwd`.

The chain _spitty → SSH → Change Remote Directory → ubtrees (`sameMachine`)
→ Shell Command `claude`_ compiles to

```
spitty -- sh -c 'ssh -t box '\''cd /srv && ubt run TREE -- sh -c claude'\'''
```

with ubtrees offered Change Remote Directory and Shell Command inside, and
each step indented one level deeper than the scope opener before it.

**Quoting is the plugin's job.** Every setting that reaches the shell goes
through `ctx.quote` / `ctx.quotePath`. The one exception is a field meant to
be shell syntax typed by the user (like Shell Command's): list it in
`static shellFields = ['command']` so a placeholder in it is filled as one
quoted word, and pass it with `run()`.

**Placeholders.** In any setting, `{{name}}` is the profile's name
(`Work #2`) and `{{slug}}` / `{{name_can}}` its slug (`work-2`). They are
filled before `validate` and `apply` see `this.config`, raw (so quote the
result) except in `shellFields`. The stored settings keep the placeholders.
Good defaults use them: `{ session: '{{slug}}' }`.

## getUI(ui): the step's controls

Return one DOM node (or null for a step with no settings). The row's label is
`label()` (default: the title). Toolkit:

- `ui.input({ name, placeholder, value, onInput, className })` — a text field;
  `onInput(value)` must store into `this.config`.
- `ui.combo({ ..., items })` — a text field with suggestions; `items()` returns
  (a promise of) `[{ value, label?, detail? }]`.
- `ui.iconButton({ icon, title, onClick })`, `ui.button({ text, icon, title, className, onClick })`
- `ui.row(...nodes)` side by side (first takes the room), `ui.stack(...nodes)` one under another
- `ui.el(tag, className, text, children)`, `ui.document` — anything else (a
  `<select>`, a checkbox); call `ui.changed()` after changing `this.config`
  from a control that is not `ui.input`.
- `ui.setValue(input, value)` — set a field as if typed; `ui.chooseDirectory(defaultPath)` — the native folder picker (promise of a path or nothing).
- `ui.context()` — the launch context this step runs in, always current;
  `ui.showError(err)`.

There is no `ui.checkbox`, `ui.select` or `ui.label`: build those with
`ui.el`. Read state in `getUI` from `this.config`, never from closures that
outlive a re-render (rows are rebuilt when steps are added or removed).

## Gotchas

- **Changing `apply()` of a plugin profiles already use.** A profile stores
  its steps _and_ the compiled `cwd`/`command`; the steps are trusted only
  while they still compile to that pair. After the change such a profile
  keeps launching the old command, and its dialog shows plain Change
  Directory + Shell Command until it is re-saved. Say so when editing an
  installed plugin.
- A step after `run()` is joined with `&&`: it runs when the program exits
  successfully. That is how the chain works, not a bug.
- Local commands run as `$SHELL -i -c '<command>'` (plus `-l` on macOS), so
  aliases and rc-file `PATH` apply; on Windows it is `cmd /c`.
- A plugin offered after SSH has its command embedded in one quoted ssh
  argument; the check output shows it. If it makes no sense remotely, return
  `ctx.scope.machine.kind === 'local'` from `isAvailable` (`ctx.scope.kind`
  would also hide it inside a same-machine wrapper).
- An endless loop at load time hangs the window; keep top-level code to class
  definitions and `register`.
- Plugins are trusted user code with the renderer's rights. Do not fetch or
  eval remote code in one, and do not install a file the user has not seen.
- Not in "+ Add"? Run `list`: the file must load without `ERROR`, be ticked
  (`[x]`), and `isAvailable` must be true where the chain ends; the directory
  and file must pass the ownership rule above.

## Adding a built-in instead

Only in a ZBTerm checkout, and only when the user asks for a plugin shipped
with the app: one file in
`renderer/plugins/` using the node/browser header of the built-ins
(`const node = …; const launch = node ? require('./launch-core.js') : window.zbtermLaunch`),
one `require` line in `renderer/plugins/index.js`, one `<script>` in
`renderer/index.html` in the same order (`test/launch-plugins.test.js` checks
they agree). Only built-ins may have `static host` (main-process functions,
`probe()` → `ctx.facts[id]`). Read `agent_docs/architecture.md` first, and
run `npm run lint` and the tests per AGENTS.md.
