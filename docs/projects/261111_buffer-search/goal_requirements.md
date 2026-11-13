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
| R5 | hard | while the box holds text and the side pane is shown, list the current session and the name matches (R11), then a "Session buffer matches" heading with each live session whose buffer contains the text | `acceptance/R5_buffer_section.sh` |
| R6 | hard | order those rows by match count, most first, showing "N matches" in cyan instead of "live · …" | `acceptance/R6_order_and_count.sh` |
| R7 | hard | search the live sessions concurrently, add each row when its session finishes, and drop stale results when the text changes | `acceptance/R7_stream_and_cancel.sh` |
| R8 | hard | include joined live sessions, searching the copy this app holds | `acceptance/R8_joined_session.sh` |
| R9 | hard | make the box as wide as the side pane, aligned under it, while the pane is shown, and as wide as the collapsed top bar's left group while it is collapsed, searching then the selected session only | `acceptance/R9_box_width.sh` |
| R10 | hard | on a click in the terminal, end the search as Esc does (typing then reaches the program at once) but keep the text, and put it back, selected, the next time the box takes the focus | `acceptance/R10_click_terminal.sh` |
| R11 | hard | while the box holds text, show in the list, in order: a "Current session" heading with the selected session in its selected colour, whether it matches or not; a "Session name matches" heading with the other name matches in their usual order, only when there are some; then the buffer matches (R5); with the box empty, the usual list | `acceptance/R11_selected_on_top.sh` |

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

2026-11-11 (builder P5): R2 strengthened with an alternate-screen block in `R2_in_session_matches.sh` (dated *Kit correction*; matches in `less` highlighted by an overlay on xterm's cell grid); soft details behind R5–R7 (the name filter kept on list changes, sessions that start during a search re-searched on their output, the section's texts and `--match-cyan`) and a U3 performance fix (match placement and merged highlight runs, results unchanged), recorded in `notes--context.md` *Soft changes*; no row or check weakened. To be read back to the user before done.

2026-11-12 (builder P6): R7's kit timing fixed on the user's decision of 2026-11-12 ("Fix the check's timing"; a dated *Kit correction* in `R7_stream_and_cancel.sh` and `lib_bs.sh`): a larger big session and the reads started before the debounce; the reads assertion unchanged, no product change. Recorded in `notes--context.md` *Soft changes*; no row or check weakened. To be read back to the user before done.

2026-11-13 (builder fix round): R10 and R11 added as hard rows on the user's request of 2026-11-13 (relayed by the orchestrator, verbatim in `notes--context.md` *The user's words*), which is their approval; R11 is built as "first in each section it is listed in" and the literal reading (always at the top of the list, even when it matches nothing) is an open question to the user (status file *Open*). Soft changes behind R10/R11 (Esc forgets the text, a primary click only, the restored text used once), behind U2 (the engine's own count of history reads, `debug.historyReads`), U3 (output timed too), R7 (a wider big session, ≥ 5 reads), U1 (the dialog's element receives the key) and the kit's logs (kept beside the state dir), recorded in `notes--context.md` *Soft changes*; R6's check corrected for R11 (dated *Kit correction*, as strict for the other rows); no row or check weakened. To be read back to the user before done.

2026-11-13 (builder F2): R11 replaced and R5 reworded on the user's answer of 2026-11-13 (their layout, verbatim in `notes--context.md` *The user's words*), relayed by the orchestrator as their approval to change R11 and R5 (and R3/R6 where affected; their rows' words are unchanged, their checks corrected with dated *Kit corrections* in R3, R5, R6, R10 and R11). Soft changes behind R11 (the current session not repeated among the name matches, kept with its count among the buffer matches; no "Current session" section without a selection; "No matching sessions" only when nothing at all is listed) recorded in `notes--context.md` *Soft changes*; no check loosened. To be read back to the user before done.

2026-11-13 (builder F3): the six indirect checks of report 2026-11-13 made direct (R2, U3, R11, R8; R5/R7 headers; the tiers), with dated *Kit corrections*; U3's new throughput check found a renderer stall under a flood during a search, fixed in `electron/main.js` (output batched) and the renderer (lighter re-scans). Soft details behind U3, R2, R11 and R8 recorded in `notes--context.md` *Soft changes* (F3); no row changed, no check loosened. To be read back to the user before done.

2026-11-13: the user approved the final state, rows as revised (R5, R11), the soft changes read back, F3's figures and the planner's single-box choices (design.md Q-3 to Q-7) as built ("Done, approve all", in chat). Project done.
