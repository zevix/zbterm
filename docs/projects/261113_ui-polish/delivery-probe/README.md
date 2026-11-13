# Delivery probes (2026-11-13)

Evidence for `../delivery-design.md`. The `.sh` probes reuse the `261111_buffer-search` kit harness and
run an instrumented copy of the scratch package at `/tmp/claude-1000/zbdeliv/out`: the engine's
`_sessionState` adds `probeSnapBytes`/`probeAnswerBytes` to the frame (and sleeps `DELIV_DELAY_MS`
after the snapshot when set), and the renderer logs `DELIVPROBE {…}` from `renderLiveFrame`. That copy
was patched by hand and is not in the repo; the patch is described in the note. Run each under
`timeout 600`. `xterm_reset.js` runs from the repo root (it needs `@xterm/headless`).
`probe1-3.txt` are the trial lines of runs 1-3.

From the parallel run (`zr-todo`, 2026-11-13; copied from `/tmp/claude-1000/zbui-polish/probe/` on
2026-11-14): `dup2.sh <as-is|clear> [trials]` runs the verifier's `dup.sh` against another instrumented
copy (`/tmp/claude-1000/zbui-polish/probe-out`, debug command `dup-variant`, state `.dupProbe`: whether a
write was in flight when the frame was painted, the frame's last line, the next three chunks' first
lines); `as-is.txt` (14 trials) and `seam.txt` (18 trials) are its output. That copy is not in the repo
either.
