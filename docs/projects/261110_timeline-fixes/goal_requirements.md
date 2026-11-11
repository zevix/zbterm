# Timeline, playback and selection fixes — goal and requirements

**Project:** `261110_timeline-fixes` · **Area:** `renderer/` · **Written:** 2026-11-10 · **Design:** `design.md` · **Evidence:** `baseline.md` · **Siblings:** `../261110_ui-chrome/`, `../261110_session-templates/`

## Goal

Six bugs the user found in the timeline, playback and selection are fixed:
- a selection survives in history and in the live terminal's right-click menu;
- starting a selection pauses playback, and the play button says so;
- the compressed-time labels stay correct and steady;
- compressed playback keeps moving through empty time;
- Alt+wheel returns to live like the plain wheel.

Checks drive a scratch packaged app under `uisolate` with real mouse and keys. Reference program: `acceptance/run_all.sh`.

## Requirements

| id | hard/soft | the system shall … | check |
|---|---|---|---|
| R1 | hard | keep a selection made in history (playback, paused) until the user clears it or the frame changes | `acceptance/R1_history_selection.sh` |
| R2 | hard | when a selection starts while playback is playing, pause playback and blink the play/pause button with a caret icon in the selection colour until playback resumes | `acceptance/R2_select_pauses.sh` |
| R3 | hard | keep a live-terminal selection when right-clicking it, with Copy enabled and copying it | `acceptance/R3_right_click_copy.sh` |
| R4 | hard | show the uncompressed-time popup on the end-time label steadily, without blinking, while hovered | `acceptance/R4_uncompressed_popup.sh` |
| R5 | hard | show the correct compressed end time, including after switching to real time and back | `acceptance/R5_compressed_end_time.sh` |
| R6 | hard | return to live when Alt+wheel steps forward past the last frame of a running session, as the plain wheel does | `acceptance/R6_altwheel_live.sh` |
| R7 | hard | in compressed playback, keep the current time moving through empty time instead of stalling on it | `acceptance/R7_compressed_playback.sh` |

### Unwanted behaviour (mandatory)

| id | hard/soft | if … | the system shall … | check |
|---|---|---|---|---|
| U1 | hard | the user clicks the terminal without dragging during playback | not pause playback or blink the button | `acceptance/U1_click_no_pause.sh` |
| U2 | hard | Alt+wheel steps forward at the end of an ended session, or back from live | stay on the last frame without error; still enter playback going back | `acceptance/U2_altwheel_edges.sh` |

## Out of scope

- The bubble's wall-clock text (`../261110_ui-chrome/` R2), which this project builds on.
- The engine player's own gap timing (`engine/player.js`), unless P1 proves the bug lives there.
- Selection inside programs that own the mouse, beyond today's forced selection.

## Approval

Approved 2026-11-11 by the user ("approved" in chat, covering all three projects), file at sha256 5db0b8ebda1f (the file as approved, before this line).

2026-11-11 (builder P2): R5's mechanism changed (soft): the compressed map also takes in a running session's live output, rebuilt at most once a second; see `notes--context.md` *Soft changes*.

2026-11-11 (builder P2): for R7, `engine/player.js` changed (the *Out of scope* exception, evidence found in P2): the playhead re-anchors after a collapsed gap; see `notes--context.md` *Soft changes*.

2026-11-11 (builder P4): R5's running total now ticks on the shown second and rebuilds the map when the in-place end would drop time (soft, mechanism only; the check is unchanged); see `notes--context.md` *Soft changes*.
