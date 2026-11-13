# UI polish — phases

**Written 2026-11-13, after P1–P2 ran**; it records the phases as executed and the ones left.

## P0 — baseline

Done late, from `58cf4e9` (see `baseline.md`). Acceptance: `acceptance/run_all.sh --needs` exits 0.

## P1 — the kit

`acceptance/` R1–R13, U1–U2 (R9 inside `R8_menu.sh`), kit `up` registered in
`docs/acceptance/index.json` topics chrome, search, timeline, templates, sharing; dated kit corrections
in `261110_ui-chrome` R2 and `261111_buffer-search` R3, R5, R10, R11. Commits 48516dd, 120f79b, 03c396e.
Acceptance: `docs/acceptance/run.sh --self-check` exits 0.

## P2 — renderer

R1–R13 in `renderer/` per `design.md`; `formatDuration` moved to `renderer/wall-clock.js` with unit
tests. Commit 13aff57. Acceptance: `npm run lint`, `test/wall-clock.test.js`,
`test/renderer-static.test.js`.

## P3 — prove on a scratch package

`ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbui-polish/out npm run package`; `acceptance/run_all.sh` green;
`docs/acceptance/run.sh --changed c578251..HEAD --out /tmp/claude-1000/zbui-polish/out` green (the
earlier kits this change touches, through their corrections). A fresh verifier writes
`acceptance/report--<date>.md`.

## P4 — output delivery design (investigation only, no fix)

`delivery-design.md`: the root cause of the duplicated or dropped lines on switching to a session
that prints, proved with an instrumented scratch copy of the package and the probe
`/tmp/claude-1000/zbv4/probe/dup.sh` (each run under `timeout 600`), candidate designs, one
recommendation. Stops for the user's approval. Budget 45 min.
