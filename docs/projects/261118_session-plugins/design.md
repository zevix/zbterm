# Session composition plugins — design (the HOW)

Companion to `goal_requirements.md`. Code: `renderer/plugins/`, `electron/launch-plugin-host.js`.

## The shape

```
session dialog ── steps editor ── [ step, step, step ]      renderer/plugins/steps-editor.js
                                     │ each an instance of a LaunchPlugin subclass
                                     ▼ folded in order through
                                  LaunchContext (a stack of scopes)   launch-core.js
                                     ▼ render()
                                  { cwd, command }  +  steps (JSON)
                                     ▼ session.create / session.update
                                  catalog entry ── PTY host spawns `$SHELL -c command` in cwd
```

Nothing below the dialog knows plugins exist (U1). The stored `steps` exist so the dialog can show
the chain again.

## The plugin interface

One class per file, extending `LaunchPlugin`, registering itself with `launch.register(Class)`:

| member | what it answers |
|---|---|
| `static id`, `title`, `icon` | the stored name (stable), the menu and row label, a Font Awesome icon |
| `static isAvailable(ctx)` | may a step of this kind be added where the chain now ends? |
| `static defaults()` | the config's keys and their defaults (all strings) |
| `getUI(ui)` | the step's controls, built with the dialog's toolkit `ui` |
| `getConfig()` / `setConfig(config)` | the settings as a plain JSON object, and back; unknown keys are dropped, values kept as trimmed strings |
| `validate(ctx)` | `''`, or why the step cannot run |
| `apply(ctx)` | what the step does to the launch context |
| `static host = { probe(), … }` | optional, main process only: functions the UI reaches with `ui.host(plugin, method, args)`; `probe()`'s answer is `ctx.facts[id]` |

Adding a plugin: the file, one `require` in `renderer/plugins/index.js`, one `<script>` in
`renderer/index.html` (a test checks the two lists agree).

## How steps know about each other

They do not name each other; they share the **launch context**, a stack of **scopes**.

- The bottom scope is `local`: the user's shell on this machine.
- A step may push a scope. SSH pushes `ssh`, with `data.target` (host, port, identity) and a
  `close()` that renders the scope into the one `ssh …` command its parent runs.
- Every later step runs in the top scope. `isAvailable(ctx)` reads `ctx.scope.kind`:
  "Change Directory" wants `local`, "Change Remote Directory" wants `ssh`, "Shell Command" takes
  any, SSH wants `local` (one hop).
- A sub-step reaches its parent through the scope, live: the remote browser reads
  `ui.context().scope.data.target` when Browse is clicked, so it follows edits to the SSH step.

A scope collects a starting directory, a list of commands, and `interactive` (true unless the last
thing in it was a command). `render()` closes scopes from the top down and joins commands with
`&&`; an interactive scope with commands ends in `exec "$SHELL"` (`-l` remotely; the PTY host
sets `SHELL` to the shell it runs when the app's environment has none).

A plugin adds a command it built with `scope.add()` and one the user typed with `scope.run()`. A
typed command is passed on as typed, so it may end in something `&&` cannot follow (a `#` comment,
a trailing `&`, `;`, `|` or `\`, a line break); such a command is followed by a new line instead,
and then does not stop the chain when it fails. `cmd.exe` takes one line, so there it is always
`&&`.

| chain | `cwd` | `command` |
|---|---|---|
| cd `~/`, shell (empty) | `~/` | (default shell) |
| cd `~/a`, shell `make` | `~/a` | `make` |
| shell `make`, cd `~/b` | | `make && cd ~/b && exec "$SHELL"` |
| ssh `me@box` | | `ssh me@box` |
| ssh `box`, remote cd `/srv` | | `ssh -t box 'cd /srv && exec "$SHELL" -l'` |
| ssh `box`, remote cd `/srv`, shell `htop` | | `ssh -t box 'cd /srv && htop'` |

## Availability and the machine

`isAvailable(ctx)` may read `ctx.facts` (SSH: is there an `ssh` binary?). Only "+ Add" passes the
facts; the checks on a chain that already exists (`firstError`, `canRemove`) are structural, so a
session with an SSH step stays editable on a machine where `ssh` was not found.

## Deleting

`canRemove(steps, i)` replays the chain without step `i`: allowed when every later step is still
available and still runs at the same scope depth and kind. The last step always qualifies. SSH with
remote steps after it does not, and neither does an SSH whose only follower is a Shell Command
(which would silently become a local command).

## Quoting (U2)

The user's Shell Command text is passed as typed. Everything else is an argument: paths go through
`quotePath` (a leading `~` stays outside the quotes; a leading `-` becomes `./-…`), the host and
the whole remote script through `quote`, in the dialect of the scope that runs them (`posix`, or
`cmd` for a local Windows shell). The host may not start with `-` or contain white space; the port
is 1–65535 (and should an unchecked chain be compiled anyway, the port is quoted and such a host
follows `--`). `cmd.exe` cannot quote `"` or `%`, so on Windows a step whose path, host, identity
file or remote command holds either is refused by `validate`. The browser's `ssh` runs through `execFile` (no shell) with `BatchMode=yes` and `--`
before the host.

## Main-process half

`app.launchPlugins.env` → `{ platform, facts }` (each plugin's `probe()`, once).
`app.launchPlugin { plugin, method, args }` → that plugin's own `host[method](args)`; only an own
property of the declared `host` object is callable.

## Storage and staleness (R8, U3)

`session.create` and `session.update` take an optional `steps`: a list of `{ plugin, config }`,
checked by the engine for shape and size only (32 steps, 16 KB) and stored on the catalog entry. A
`session.update` that changes `cwd`/`command` without restating `steps` clears them. On top of
that, `launch.stepsFor(session)` uses stored steps only while they compile to the session's own
`cwd` and `command`; otherwise the dialog opens with the two steps those fields stand for. So a
template copy, an older build or the debug server can never make the dialog show a launch that is
not the one that runs.

## Debug commands (the kit's)

`launch-state` (steps, addable plugins, menu, error, compiled launch), `launch-add { plugin }`,
`launch-remove { index }`, `launch-set { index, field, value }`, `launch-menu { open }`.
