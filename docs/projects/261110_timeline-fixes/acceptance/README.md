# Acceptance kit

Run as the user would, on the target host:
`source acceptance/activate && acceptance/run_all.sh`.
`activate` sets the interpreter and a private state dir, so no real store is touched.
One script per requirement: `R<n>_<slug>.sh` / `U<n>_<slug>.sh`; it prints what it runs; exit 0 is pass.
A script exits 75 "cannot run here" when this host lacks a `need`; `run_all.sh` lists it as CANNOT RUN, a FAIL.
`run_all.sh --needs` says whether this host can run the kit at all (phase 0 checks it).
The verifier (fresh context; reads `goal_requirements.md` and this directory only)
writes `report--<date>.md` from `/ubitron/dev/docs/templates/project/acceptance/report--template.md`.
New checks start from `/ubitron/dev/docs/templates/project/acceptance/check--template.sh`.

**Host.** Linux with `uisolate` (the app runs only on a private display), `jq`, `curl`,
and a packaged build at `$ZBUI_APP` (default `/tmp/claude-1000/zbui/out/ZBTerm-linux-x64/ZBTerm`,
made by `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbui/out npm run package`; repackage after
any renderer change). Each script starts its own app on a free debug-server port with
scratch storage, drives it through `POST /renderer/command` (`docs/debug_server_howto.md`),
and stops only the `uisolate` session it started. `../../261110_ui-chrome/acceptance/lib.sh` holds `start_app`, `stop_app`,
`cmd`, `state` and `key`; mouse drags, right-clicks and Alt+wheel are real `xdotool` input on the private display.
`tf.sh` (this directory) holds this kit's own helpers: the debug reads, terminal cells as
page coordinates, real drags, right-clicks and Alt+wheel notches, and the recording fixtures
(lines, a 20 s idle gap, more lines; or an ended session from a `sh` script). R3 reads the
clipboard with `xclip` inside the app's `uisolate` session.

| script | proves |
|---|---|
| `R1_history_selection.sh` | in paused playback a real drag selects text; the exact text is still selected after 3 s and a window resize, in a plain shell and in less --mouse, with copy-on-select on and off; a step forward clears it (A-1) |
| `R2_select_pauses.sh` | a real drag starting in the terminal during playback pauses it; the play button has selection-paused, fa-i-cursor, the selection colour and a running blink animation (style-of); Play, or an Alt+wheel step, removes it |
| `R3_right_click_copy.sh` | in live, drag-select echoed text then right-click it, in a plain shell and in less --mouse, with output arriving in between: Copy is enabled, the highlight is back, and Copy clicked after 2 s puts the exact text on the clipboard |
| `R4_uncompressed_popup.sh` | collapse on, playing, hovering the time label for 3 s: the popup stays shown, its rect is constant and inside the viewport, no hide/show and only text-change mutations, the text reads Uncompressed: |
| `R5_compressed_end_time.sh` | an ended session recorded with fixed sleeps: the compressed total equals the constant written here; toggling off, on, off, on gives the same total each time |
| `R6_altwheel_live.sh` | on a running session: Alt+wheel back 3 frames, forward onto the last frame stays in playback, one more forward returns to live (as the plain wheel does) |
| `R7_compressed_playback.sh` | collapse on, playing across the 20 s gap at 1x: clockTs sampled every 100 ms is monotonic and keeps moving, the gap passes in about the threshold, and pause then play mid-gap does not jump |
| `U1_click_no_pause.sh` | a plain click on the terminal, and a drag from the scrubber into the terminal, during playback leave it playing with no selection-paused class |
| `U2_altwheel_edges.sh` | Alt+wheel forward at the end of an ended session stays on the last frame with no error; Alt+wheel back from live enters playback |

> **Kit corrections 2026-11-11 (builder P1)**, each a dated comment in its script:
> - R1 also scrolls the timeline one wheel notch inside the same frame (`seq` unchanged) and asserts the selection stays. That is where P1 reproduced R1; the steps in its header passed.
> - R5 also checks a running session (a line every second, so no gap is over the threshold): the compressed total must equal the real one, before and after toggling. That is where P1 reproduced R5; the ended-session part passed.
> - U1 and U2 end on a positive control (a terminal drag does pause; a forward step at the last frame of a running session does go live). Without it their checks pass whether or not the behaviour they guard exists.
> - R7 measures "keeps moving" on `compMs`, the clock on the compressed timeline the user sees. Today `clockTs` does move inside the gap, in real units, so a check on it alone would pass while the shown time stalls.
