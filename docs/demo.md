# The demo

`./demo.sh` starts ZBTerm on scratch data and drives its real UI through the
features of [the tour](OVERVIEW.md), with a caption for each. It is the
rehearsal of the demo video: nothing is recorded, you watch it run.

```sh
./demo.sh                 # the whole walk-through, about 6½ minutes
./demo.sh --part 1        # one window: sessions, time travel, search (3½ min)
./demo.sh --part 2        # two windows: invite, approval, live sharing, SSH (3 min)
./demo.sh --fast          # 4x: a check that every step still works (1.5 min)
./demo.sh --step          # stop before each scene; Enter in the terminal goes on
./demo.sh --help          # every option
```

While it runs, keep the mouse and keyboard away from the demo's windows:
it types and clicks in them, and yours would land in the same place. Ctrl+C in
the terminal you started it from closes everything. When it ends the windows
stay open, so you can try things on the demo's data; Enter in that terminal
closes them.

## What it touches

None of your ZBTerm data. The demo makes `/tmp/zbdemo.XXXXXX` and runs its
instances on a `HOME`, storage and settings (`XDG_CONFIG_HOME`) there, shared
by the two, each with its own Electron user data and a free debug-server port.
Your shell's `ZBTERM_*`, `ELECTRON_*`, `NODE_OPTIONS` and `SSH_AUTH_SOCK` variables are not
passed on. The directory is removed when the demo ends (`--keep` keeps it; a
failed run keeps it too and says where). It runs on Linux only: on macOS the
app keeps its window state and settings under the real
`~/Library/Application Support` whatever `HOME` says, so `demo.sh` refuses to
start there. In the checkout, `demo.sh` regenerates `renderer/vendor/` as
`npm start` does. Two things reach outside:

- **The clipboard.** The invite goes from one window to the other the way a
  person moves it: **Copy** in the Share dialog, **Paste** in the Join dialog.
  Whatever your clipboard held is replaced: by the text selected in scene 3
  (Copy on select is on) and, in part two, by a `zbterm://join/…` link to a
  session that no longer exists once the demo closes.
- **The network.** Part two shares over Pear: the two instances find each
  other through the public Hyperswarm DHT, as two machines would. It needs an
  internet connection, and the join takes from a second to (through the relay
  fallback) some ten seconds. Scene 17 connects to `starwarstel.net`, a
  public SSH server that plays a film to anyone, as user `alice` and with no
  key or agent: the demo's own ssh config (below) says so.

## What you see

These are drawn over the app by the demo and are not part of ZBTerm
(`renderer/demo-overlay.js`, off unless a debug command turns it on):

- the **caption card**, bottom centre: a title and a sentence per feature;
- **key badges** above it: every chord, function key, modified click or wheel
  turn the script performs shows as keycaps (`Ctrl` + `Shift` + `F`);
- a **drawn pointer** with a ripple on each click. The script's mouse does not
  move your desktop's pointer, so the page draws one;
- the **title cards** at the start, between the parts and at the end, and a
  yellow **ring** that points out a control now and then.

Everything else is the app itself, reacting to real input events.

## Storyboard

Times are at the default pace (`--speed 1`), from a run on 2026-11-18.

Chords, function keys, modified clicks and wheel turns appear as key badges by
themselves, as do Enter, Esc and the arrows where the script names them;
typing and drags do not. Filling a dialog field flashes a `Ctrl`+`A` badge:
the script selects the field's old text before typing over it.

### Part one: one window (0:00 – 3:50)

| # | Scene | What happens | Keys and gestures |
| - | ----- | ------------ | ----------------- |
| 1 | Intro | Title card; the idle screen with the logo. | |
| 2 | A new session | **+ New**, the dialog (name `build`; its first launch step, **Change Directory**, `~/shop-api`), **OK**. `ls`, `./build.sh`, `./deploy.sh staging` run in a real shell. | typing |
| 3 | Time travel | Alt+wheel steps back through the build; the slider's bubble; a click on the slider; **\|<<** and **>\|**; the compressed-time button folds the 3 s upload wait (the time label's tip shows the uncompressed time); replay; a drag selects text in history and pauses the replay; **Live**. | `Alt`+`Wheel`, drag |
| 4 | More sessions | **+ New** again: `logs`, with **Advanced** making it the Ctrl+Shift+T template that skips the dialog; `./logs.sh` streams. Ctrl+Shift+T opens a copy at once; F2 renames it `deploy`. Ctrl+PgDn / Ctrl+PgUp walk the list. | `Ctrl`+`Shift`+`T`, `F2`, `Enter`, `Ctrl`+`PgDn`, `Ctrl`+`PgUp` |
| 5 | Pins and order | Pin `build` and `logs`; Ctrl+2, Ctrl+1 jump; `logs` is dragged by its icon above `build`, the pointer carrying the lifted row. | `Ctrl`+`2`, `Ctrl`+`1`, drag |
| 6 | Search | Ctrl+Shift+F, `error`: the list filters, matches light up, the count shows; Enter, Enter, Shift+Enter step; ↓ ↓ ↑ pick sessions under *Session buffer matches*; Esc. | `Ctrl`+`Shift`+`F`, `Enter`, `Shift`+`Enter`, `↓`, `↑`, `Esc` |
| 7 | The window | Ctrl+Shift+B folds and shows the side pane; Ctrl+= / Ctrl+- resize the font; the theme switch, light and back; the settings menu. | `Ctrl`+`Shift`+`B`, `Ctrl`+`=`, `Ctrl`+`-`, `Esc` |
| 8 | End, compose, resume | `exit` in `build`: the session becomes a recording. F2 opens its launch steps: the empty **Shell Command** gets `./build.sh`; **+ Add** (its menu: Change Directory, Shell Command, SSH) adds a Shell Command `./deploy.sh canary`, and another, empty, so a shell stays open; **OK**. Ctrl+R starts the session again from its steps: it builds, deploys and leaves a prompt in `~/shop-api`. | `F2`, `Ctrl`+`R` |

### Part two: sharing (3:50 – 6:30)

| # | Scene | What happens | Keys and gestures |
| - | ----- | ------------ | ----------------- |
| 9 | Side by side | Title card; Alice's window glides to the right half of the screen. | |
| 10 | A second ZBTerm | A second instance opens in the left half. Alice's profile is in use, so it shows **Choose Profile**: `Bob` is typed, **Create**. The identity wizard opens on the new profile: **Not now**. | typing |
| 11 | The invite | Alice: **Share**, the **Group** link type (approval turns on with it), **Share**, the `zbterm://join/…` key, **Copy**, **Done**. | |
| 12 | Joining | Bob: **Join**, **Paste**, **Join**. His window waits for the host's approval. | |
| 13 | Approval | Alice gets *Approve bob?* with what is known of Bob's identity: **Approve**. | |
| 14 | Live | Bob has the live terminal. Alice runs `./build.sh`; both windows show it. | typing |
| 15 | The viewer in history | Bob steps back with Alt+wheel while Alice runs `./deploy.sh staging`; his view stays in the past while hers moves on; **Live** catches up. | `Alt`+`Wheel` |
| 16 | Keyboard sharing | Alice: the keyboard button, **Share Keyboard**. Bob types a command into Alice's shell. Alice takes the keyboard back. | typing |
| 17 | SSH | Alice: **+ New** `star wars`, the empty Shell Command deleted, **+ Add** → **SSH**. `st` in the host field lists `starwars` and `staging-db` from the demo's ssh config; ↓, Enter takes `starwars`. ↓ in the identity field lists the demo's two keys; Esc. **OK**: `starwarstel.net` plays Star Wars in ASCII. A **Single-use** link; Bob joins it the same way and watches the film. | typing, `↓`, `Enter`, `Esc` |
| 18 | Outro | Closing cards in both windows. | |

In the overview's feature list but not in the demo, to keep it short:
the Change Remote Directory step and its browser (the demo's SSH host is a
film, not a shell), unrecorded sessions, Copy with history, HD, the terminal size lock, the
row and terminal context menus, *Only verified people can
join* and a verified GitHub identity (the Share dialog and the wizard are
shown, not used), Freenet, the relay settings, whole-app zoom and the narrow
layout.

## Options

| Option | Meaning |
| ------ | ------- |
| `--part <1\|2\|all>` | Which part to run. Part two alone starts with one live session to share. Default: `all`. |
| `--speed <n>` | Pacing. Pauses for the viewer are divided by `n`; waits for the app (a build finishing, a join completing) are not. Default: `1`. |
| `--fast` | `--speed 4`. |
| `--step` | Wait for Enter before each scene. |
| `--no-captions` | No caption cards; the title cards, key badges, the ring and the pointer stay. |
| `--packaged` | Run the packaged app from `out/` (or `--out <dir>`, or `$ZBTERM_FORGE_OUT_DIR`) instead of this checkout. The package must be built from a checkout that has the demo's instrumentation; the demo says so when it is not. |
| `--screen <WxH+X+Y>` | The screen area to lay the windows out in. Default: the work area of the display the first window opens on. |
| `--wayland` | Do not force X11. On Linux the demo starts the app as an X11 client (XWayland under a Wayland desktop) because a Wayland client cannot place its own window; with this option the windows open wherever the compositor puts them. |
| `--shots <dir>` | Save a PNG of each window at the end of every scene and at its key moments. |
| `--keep` | Keep the scratch directory. |
| `--close` | Close the windows when the demo ends, without waiting for Enter. |
| `--verbose` | Print every caption as it is shown, and at the end the captions that were replaced before they could be read. |

Part two puts each window in half of the screen area. On a screen 1560 px
wide or less a half is 780 px or less, where ZBTerm swaps the session list for
a drop-down: the demo says so when it starts part two, and what it shows of
the side pane is not there.

## How it works

`demo.sh` checks the dependencies and the sidecar, then runs
`scripts/demo/demo.js`:

- `scripts/demo/lib.js` starts the instances (from this checkout with
  Electron, or the packaged app) and wraps the debug server: input, the
  overlay, and the reads every wait is built on.
- `scripts/demo/fixtures.js` writes the scratch `HOME`: a prompt
  (`alice@laptop`, `bob@laptop`; the shells are bash whatever your `$SHELL`
  is) and the `shop-api` project whose `build.sh`, `deploy.sh` and `logs.sh`
  print the same lines on every run (the log's timestamps aside), without the
  network. `deploy.sh staging` fails on its third node, which the search scene
  finds; any other target succeeds. It writes the demo's `~/.ssh` (two
  fresh keys and a config with four made-up hosts, `starwars` among them),
  which the app gets as `--custom-dot-ssh-path`: ssh itself finds the real
  home directory from the user database, not `$HOME`, so without the flag it
  would read your `~/.ssh`. The config turns off the agent and every key but
  its own, and accepts the host key on the first connection. It also writes the scratch settings the demo starts from: Developer
  Mode off and the dark theme.
- `scripts/demo/demo.js` is the script itself: one function per part, one
  `scene()` per row of the tables above. A scene is a list of captions and
  actions; changing the demo is editing that list.

Every action is a real input event: the debug server's `POST /input/key`,
`/input/text` and `/input/mouse` hand keys, typed characters, pointer moves,
presses and wheel turns to Chromium (`webContents.sendInputEvent`), so hotkeys,
the terminal and the dialogs behave exactly as under a person's hands, on X11,
Wayland alike, with no `xdotool`. Every wait reads the app's state
(a session exists, the terminal shows a line, a dialog is open) instead of
sleeping, so a slow machine or a slow join stretches the demo without breaking
it. Two things are set rather than performed: the choice in the Advanced
drop-down of scene 4 (a native drop-down's list cannot be clicked from the
page), and the identity wizard of the first window, dismissed behind the title
card. All of it is described in
[debug_server_howto.md](debug_server_howto.md).

## Recording it

Not done yet, on purpose: the script is to be approved first. When it is,
record the screen while `./demo.sh` runs. Points to settle then:

- the screen size (`--screen 1920x1080+0+0` on a larger display gives a fixed
  frame) and whether to hide the desktop behind the windows;
- the pace: `--speed 0.8` if the captions are to be read aloud;
- a packaged build (`npm run package`, then `./demo.sh --packaged`), so the
  video shows what users install;
- the idle screen: the demo turns Developer Mode off for its scratch settings
  so the logo shows instead of the diagnostics log.

## When it fails

A failed step stops the demo with the scene's name and what it waited for,
saves `failed-<window>.png` in the scratch directory, and (started from a
terminal, without `--close`) leaves the windows open until Enter. `alice.log` and `bob.log` there hold each instance's output.

| Symptom | Likely cause |
| ------- | ------------ |
| `No zxterm-core sidecar` | Build it: `npm run build:sidecar`. |
| `this build has no demo instrumentation` | `--packaged` found a package older than the demo. `npm run package`. |
| `Timed out … the approval request` | No route between the two instances: no internet, or the DHT is unreachable from this network. Part one does not need it. |
| The windows are not placed side by side | A Wayland session with `--wayland`, or a window manager that ignores placement requests. |
| The clicks land beside their targets | Something moved or resized a window by hand during the run. |
