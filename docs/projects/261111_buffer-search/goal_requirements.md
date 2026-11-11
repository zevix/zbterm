# Search in live session buffers — goal and requirements

**Project:** `261111_buffer-search` · **Area:** `renderer/`, `engine/index.js` · **Written:** 2026-11-11 (revised the same day: one search box) · **Design:** `design.md` · **Evidence:** `baseline.md` · **Notes:** `notes--context.md`

## Goal

ZBTerm searches the text live sessions hold in memory, never history on disk, from one box at the bottom left of the window (Ctrl+Shift+F): it filters the session list by name, lists the live sessions whose buffers match, and highlights the matches in the selected session. The checks drive a scratch packaged app under `uisolate`. Reference program: `acceptance/run_all.sh`.

## Requirements

| id | hard/soft | the system shall … | check |
|---|---|---|---|
| R1 | hard | have one search box, the side pane's former "Search sessions" box, first in the bottom bar at the window's bottom left with the status text to its right, and focus it on Ctrl+Shift+F | `acceptance/R1_box_and_hotkey.sh` |
| R2 | hard | while the box holds text, highlight every match in the selected session's buffer, scrollback included, show the count, and step through matches with Enter and Shift+Enter, scrolling each into view | `acceptance/R2_in_session_matches.sh` |
| R3 | hard | on Esc in the box, clear its text, the highlights and the list filter, and focus the terminal | `acceptance/R3_escape.sh` |
| R4 | soft | in playback, search the frame on screen, again whenever it changes | `acceptance/R4_playback.sh` |
| R5 | hard | while the box holds text and the side pane is shown, list the name matches, then a "Session buffer matches" heading with each live session whose buffer contains the text | `acceptance/R5_buffer_section.sh` |
| R6 | hard | order those rows by match count, most first, showing "N matches" in cyan instead of "live · …" | `acceptance/R6_order_and_count.sh` |
| R7 | hard | search the live sessions concurrently, add each row when its session finishes, and drop stale results when the text changes | `acceptance/R7_stream_and_cancel.sh` |
| R8 | hard | include joined live sessions, searching the copy this app holds | `acceptance/R8_joined_session.sh` |
| R9 | hard | make the box as wide as the side pane, aligned under it, while the pane is shown, and as wide as the collapsed top bar's left group while it is collapsed, searching then the selected session only | `acceptance/R9_box_width.sh` |

### Unwanted behaviour (mandatory)

| id | hard/soft | if … | the system shall … | check |
|---|---|---|---|---|
| U1 | hard | Ctrl+Shift+F is pressed in the terminal, or with a dialog open | never send it to the program; with a dialog open, do nothing | `acceptance/U1_hotkey_not_typed.sh` |
| U2 | hard | the text is only in an ended session or recorded history | not list that session, and not read history from disk | `acceptance/U2_live_only.sh` |
| U3 | hard | a cross-session search runs over several full buffers | keep typing and output in the terminal responsive | `acceptance/U3_responsive.sh` |

## Out of scope

- Searching history on disk; regex, whole-word and case modes; buffer matches in the narrow layout's dropdown; new dependencies (`design.md` Q-1).

## Approval

Approved 2026-11-11 by the user ("I want one change - have a single search box on the bottom left - move our current search box to the bottom, and when collapsed keep it the same width as the top bar, go!", in chat, on the plan with Q-1/Q-2 as recommended; this revision applies that change), file at sha256 02875b2c64f0 (the file before this line).

2026-11-11 (builder P1): soft detail changes behind U3 (echo timed on the renderer's rows), R2 (the flood paced over ~10 s), R7 (log and reads both asserted) and the kit's seeding (no `stats` probe), recorded in `notes--context.md` *Soft changes*; no row or check weakened. To be read back to the user before done.

2026-11-11 (builder P2): soft detail changes behind R2/R7 (the matcher's `lines`/`next` slicing and `len` over a pushed wide character), scenario 7 (trailing erased cells are not text) and U2/R8 (an ended join answers `gone`; trimmed rows followed by a marker), recorded in `notes--context.md` *Soft changes*; no row or check weakened. To be read back to the user before done.

2026-11-11 (builder P3): soft detail changes behind R1/R9 (the box fills its bar cell, the pane's border drawn on it; the collapsed width kept in `--topbar-brand-width`, the resizer ending above the bar) and Q-6 (`#activeOnly` an ordinary button in `.tools`), recorded in `notes--context.md` *Soft changes*; no row or check weakened. To be read back to the user before done.

2026-11-11 (builder P4): soft detail changes behind R2 (re-scan timer, the current match after a re-scan, wrap-round steps, highlight tokens, no highlights on the alternate screen, the count's place) and a harness fix in `R2_in_session_matches.sh` (a JSON path; no assertion changed), recorded in `notes--context.md` *Soft changes*; no row or check weakened. To be read back to the user before done.
