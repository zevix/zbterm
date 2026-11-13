# Acceptance kit (261113_ui-polish)

Run as the user would, on the target host:
`source acceptance/activate && acceptance/run_all.sh`.
`activate` sets a private state dir (scratch HOME and storage), so no real store is touched.
One script per requirement: `R<n>_<slug>.sh` / `U<n>_<slug>.sh`; it prints what it runs; exit 0 is pass.
`run_all.sh` gives each script at most 240 s. A script exits 75 "cannot run here" when this host
lacks a `need`; `run_all.sh` lists it as CANNOT RUN, a FAIL. `run_all.sh --needs` says whether this
host can run the kit at all. The verifier (fresh context; `goal_requirements.md` and this directory
only) writes `report--<date>.md`.

**Host.** Linux with `uisolate`, `xdotool`, `jq`, `curl`, and a packaged build at `$ZBUI_APP`
(default `/tmp/claude-1000/zbui-polish/out/ZBTerm-linux-x64/ZBTerm`, made by
`ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbui-polish/out npm run package`; repackage after any
renderer change). Each script starts its own app on a free debug-server port with scratch storage,
drives it through `POST /renderer/command` and real pointer and keys on the private display, and
stops only the `uisolate` session it started. The harness is `../../261110_ui-chrome/acceptance/lib.sh`
(reused unchanged) and `lib_up.sh` (a copy of the buffer-search kit's helpers plus this kit's own).
In `docs/acceptance/index.json` this kit is `up`.

| script | proves |
|---|---|
| `R1_unrecorded.sh` | an unrecorded session shows only its duration at the bar's right end; ticking live, frozen once ended |
| `R2_icon.sh` | the magnifying glass at the box's right, the count left of it, a click focuses the box |
| `R3_unmatched.sh` | while searching, the unmatched sessions last, dimmed, under "Other - unmatched sessions"; a late match moves up |
| `R4_bubble.sh` | the bubble is two centred lines: clock, then elapsed (today's content) |
| `R5_days.sh` | durations of 24 h or more read "Nd h:mm:ss" |
| `R6_record.sh` | every "Edit new profile defaults…" editor changes "Record session", and the choice sticks |
| `R7_advanced.sh` | the Advanced section's controls are spaced (>= 6 px) and indented; a screenshot for the reader |
| `R8_menu.sh` | R8 and R9: STUN/TURN last before the version between separators; separators around the CTRL -/+ pair |
| `R10_items.sh` | pane hidden: identity and theme items are the toolbar icon plus its tooltip, the dot on the icon |
| `R11_lock_menu.sh` | the size lock button and its menu (labels, icons, separators, ticks); locking and unlocking |
| `R12_lock_holds.sh` | locked: the grid holds through window resizes, CTRL -/+ and a restart; the font follows the window |
| `R13_reorder_guard.sh` | rows that move block clicks with the not-allowed cursor until 500 ms without a change |
| `U1_record.sh` | the template editor's Record box never changes its live session's recording |
| `U2_lock.sh` | joined, scrolled back or ended: no lock button, and the viewer never resizes the host |
