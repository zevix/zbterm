# Delivery probes (2026-11-13)

Evidence for `../delivery-design.md`. The `.sh` probes reuse the `261111_buffer-search` kit harness and
run an instrumented copy of the scratch package at `/tmp/claude-1000/zbdeliv/out`: the engine's
`_sessionState` adds `probeSnapBytes`/`probeAnswerBytes` to the frame (and sleeps `DELIV_DELAY_MS`
after the snapshot when set), and the renderer logs `DELIVPROBE {…}` from `renderLiveFrame`. That copy
was patched by hand and is not in the repo; the patch is described in the note. Run each under
`timeout 600`. `xterm_reset.js` runs from the repo root (it needs `@xterm/headless`).
`probe1-3.txt` are the trial lines of runs 1-3.
