# UI polish — baseline (evidence)

**Written 2026-11-13, after the build**, from the tree as it stood before it: `58cf4e9` (requirements
approved, no code yet). The builder skipped phase 0; every *Today* fact below is read from that commit
(`git show 58cf4e9:<file>`), so it is still the "before". Host `zr`, Node `v24.19.0` (`node --version`).

Read by the planner and builders. The user does not approve this page.

## Reference program

`acceptance/run_all.sh` (kit `up` in `docs/acceptance/index.json`): each script starts the packaged
app `$ZBUI_APP` under `uisolate` with scratch HOME/storage through `../261110_ui-chrome/acceptance/lib.sh`,
drives it with `xdotool` and `POST /renderer/command`, at most 240 s per script.

## Today (at 58cf4e9)

| fact | command → output |
|---|---|
| An unrecorded session keeps the timeline, only disabled | `git show 58cf4e9:renderer/app.js \| grep -n "Not recorded"` → `3070: input.title = usable ? '' : 'Not recorded'`, `5203: els.scrubber.title = unrecorded ? 'Not recorded' : ''` |
| Durations have no day form | `… \| sed -n 9544,9552p` → `formatDuration`: `h:mm:ss` or `m:ss`, hours unbounded |
| The template editor locks "Record session" when a live session backs the template | `… \| grep -n "recordLocked"` → `2082: recordLocked: !!live,`, `3021:`; title `'Fixed when the session was created'` |
| The Advanced section is a grid `<details>` with a 6 px gap | `git show 58cf4e9:renderer/index.html \| sed -n 894,897p` → `display: grid; gap: 6px;` (the gap only reaches the summary: `notes--context.md` R7) |
| No terminal size lock exists | `… \| grep -c "sizeLock"` → `0` |
| `renderer/app.js` size | `git show 58cf4e9:renderer/app.js \| wc -l` → 10824 lines (11360 after the build) |
| Self-check of the test index passes with the kit registered | `docs/acceptance/run.sh --self-check` (2026-11-13, after 120f79b) → all `ok` |
| Kit tools present | `command -v uisolate xdotool jq curl` → all four found; `acceptance/run_all.sh --needs` → `needs: all satisfied on zr` |
| The packaged build carries no sidecar | the kit sets `ZXTERM_CORE_BIN=/zp/zdata/zeev/github/zbterm/npm/zxterm-core-linux-x64/zxterm-core` (`acceptance/activate`) |

## Cost

| what | before | after | measured by |
|---|---|---|---|
| Lint | exit 0, 95 warnings | exit 0, 95 warnings | `npm run lint \| tail -1` (2026-11-13, after the build) |
| This kit | — | see `acceptance/report--2026-11-13.md` | `acceptance/run_all.sh` |

The renderer change adds no work on the output path; R13 adds one pass over the list's children per
`renderSessions()` (tens of rows).
