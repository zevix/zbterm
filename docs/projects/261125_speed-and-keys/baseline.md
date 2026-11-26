# 261125_speed-and-keys — baseline (evidence, phase 0)

**Measured:** 2026-11-25 on `zr`, dev Electron from the working tree and the HEAD package, tree at `99719af` plus 37 uncommitted paths (below) · **Logs and scripts:** `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261125_speed-and-keys/p0/` (`drv.js` drives the renderer over CDP through a `NODE_OPTIONS=--require hook.js` hook; `seed.sh` makes the 12-session store; `wt.*.log` are the runs)

Read by the planner and builders by path. The user does not approve this page.

## Reference program

`acceptance/run_all.sh` on the packaged build. The two speed scripts time a switch and a typed key
on a scratch store holding one session whose `timeline.json` has 200 000 entries.

## Today

Times run from the keydown to the last change of the visible terminal rows. "Entries" is the
length of a session's timeline: one `{seq, tsMs, hd}` per recorded packet (`timeline.json`).

| fact | command → output |
|---|---|
| A switch is fast on small histories | `node drv.js wt switches 26` (12 sessions, timelines ≤ 109 entries, live↔live, live↔offline) → median 38 ms, max 82, 0 long tasks |
| Text in the search box does not slow it | `node drv.js wt switches 14` with "perf" in the box → 38 ms |
| The number of profiles hardly matters | `node drv.js wt profswitch 30` (100 sessions, 30 live) → median 55 ms; `renderSessions` ≈ 6 ms of it |
| A switch slows with the target's history | `node drv.js wt switches 25` → 10k entries: 42–55 ms; 100k: 286–323 ms with one 173–213 ms long task; 1M: long tasks 2038–2094 ms + ~250 ms, the next keydown delayed 2.3 s |
| Leaving a big live session costs too | `node drv.js wt switches 14` → 156 ms synchronous in the keydown handler when leaving a live 1M-entry session |
| Typing is fast on small histories | `node drv.js wt type 50 100 any` → echo median 15.7 ms, p90 17.7, 0 long tasks; with 5 background sessions printing 20 lines/s: 16.1 ms |
| Typing slows with the selected session's history | `node drv.js wt type 50 100 any prof` → 100k entries: median 17.2 ms, the `session:data` handler ~5 ms per chunk; 1M: median 107 ms, p90 136, 72 long tasks (57–134 ms) in 50 keys, 5 echoes not seen within 3 s |
| It is not this week's code | the HEAD package on the same store: 100 sessions 55 ms, 100k entries 286–310 ms (`switches 6`, `updown 3`); `git blame` on the hot lines → 2026-10-26; `git diff` does not touch the switch or key path |
| The user's store has such histories | `find ~/.config/ZBTerm -name timeline.json -size +1M -printf '%s\n' \| sort -n \| tail -5` → 1737355, 2163591, 2292797, 4604034, 5989919 bytes (≈ 46 bytes an entry: about 38k to 130k entries; 99 timelines in all). Sizes only; the real store was not run. |
| Per output chunk the scrubber is rebuilt twice | `renderer/app.js` `api.on('session:data')` → `updateLiveClock` → `updateTimeLabels` → `updateTransportControls` → `renderScrubberIndicators`, then `updateTransportControls` again; `renderScrubberIndicators` walks the whole timeline (`idleSegments`, `sessionHasHd`, `timelineActivityMap`, `getTimeCollapseMap`); `idleSegments` leads the CPU profile |
| Every open ships the whole timeline | `engine/index.js::_sessionState` returns `timeline: runtime.store.timeline`; `player.open` the same; the 100k/1M long tasks sit in "(program)" + GC (IPC decoding: inferred from the profile category) |
| Two flooding sessions can starve the worker | once, synthetic (two sessions at ~2000 writes/s): `session.open` hit the 60 s invoke timeout. Not this project (design *Open*). |
| No eval route in the debug server | the measurer needed the CDP hook; the kit needs a probe command (design *Interface*) |

Not measured: the user's real store running; a commit older than HEAD; resume (offline→live) cost;
joined sessions; typing while the selected session itself floods.

## Cost (mandatory)

| what | today | target | measured by |
|---|---|---|---|
| switch to a 200k-entry session, key → drawn | ≈ 0.5 s (interpolated: 0.3 s at 100k, 2.3 s at 1M) | ≤ 150 ms median, no long task > 100 ms | `acceptance/R1_switch_speed.sh` |
| key echo in a live 200k-entry session | ≈ 10 ms per output chunk in the handler; long tasks at 1M | median ≤ 30 ms, no long task > 50 ms in 50 keys | `acceptance/R2_typing_speed.sh` |
| switch on small histories | median 38 ms | no worse than 60 ms | `acceptance/R1_switch_speed.sh` |
| package for the kit | ≈ 3 min | the same | `ZBTERM_FORGE_OUT_DIR=… npm run package` |

## Working tree

`git status --porcelain` at the start, 2026-11-25 (in-flight work that is not this project's):

```
 M CHANGELOG.md  M README.md  M agent_docs/architecture.md  M build/AppxManifest.xml
 M build/icon.icns  M build/icon.ico  M build/icon.png  M build/icon/icon-{16,32,64,128,256,512}x…png
 M electron/command-plugins.js  M electron/main.js  M package-lock.json  M package.json
 M renderer/app.js  M renderer/index.html  M renderer/logo-ascii.js  M renderer/logo.svg
 M renderer/plugins/{change-directory,launch-core,remote-directory,shell-command,ssh,steps-editor}.js
 M renderer/plugins/samples/python_venv.js  M scripts/generate-icons.js  M scripts/logo.js
 M test/command-plugins.test.js  M test/launch-plugins.test.js
?? .claude/  ?? renderer/middle-click.js  ?? renderer/plugins/skill/  ?? test/middle-click.test.js
?? docs/projects/261125_speed-and-keys/
```
