# UI polish: timeline, search, menus, size lock — goal and requirements

**Project:** `261113_ui-polish` · **Area:** `renderer/` (Q-8: the lock is a profile preference; `engine/` untouched) · **Written:** 2026-11-13 · **Notes:** `notes--context.md` (the user's words, where each row lands, decisions on Q-1–Q-11)

## Goal

Small fixes from use, and a terminal size lock, checked on a scratch packaged app under `uisolate`. Reference program: `acceptance/run_all.sh`.

## Requirements

| id | hard/soft | the system shall … | check |
|---|---|---|---|
| R1 | hard | show an unrecorded session's duration alone at the bottom right (right end of the playback bar), without timeline controls | `acceptance/R1_unrecorded.sh` |
| R2 | soft | show a magnifying glass at the search box's right | `acceptance/R2_icon.sh` |
| R3 | hard | while searching, list the unmatched sessions last, dimmed, under a small "Other - unmatched sessions" heading | `acceptance/R3_unmatched.sh` |
| R4 | hard | show the timeline bubble as two centred lines: clock time, then time since start | `acceptance/R4_bubble.sh` |
| R5 | hard | show durations (not clock times) of 24 h or more as "Nd h:mm:ss": 54:32:10 is "2d 6:32:10" | `acceptance/R5_days.sh` |
| R6 | hard | let every "Edit new profile defaults…" editor change "Record session" | `acceptance/R6_record.sh` |
| R7 | soft | space the editor's Advanced section like the rest of the dialog | `acceptance/R7_advanced.sh` |
| R8 | hard | put "STUN/TURN servers…" last before the version, between separators | `acceptance/R8_menu.sh` |
| R9 | hard | put separators around the two "… with CTRL -/+" items | `acceptance/R8_menu.sh` |
| R10 | hard | with the side pane hidden, show the menu's identity and theme items as "&lt;toolbar icon&gt; &lt;its tooltip&gt;", dot on the icon | `acceptance/R10_items.sh` |
| R11 | hard | add a size lock button whose menu is "Unlocked - set by terminal and font sizes", "Current size: R x C", "32 x 120", "25 x 80", with lock icons and separators as drawn | `acceptance/R11_lock_menu.sh` |
| R12 | hard | while locked, keep the session's rows and columns whatever the window or font does | `acceptance/R12_lock_holds.sh` |
| R13 | hard | whenever the left pane's session rows change position, block clicks on them with a no-entry cursor until the list has been still for 500 ms | `acceptance/R13_reorder_guard.sh` |
| R14 | hard | keep the app's zoom when CTRL -/+ goes back from "Zoom whole app" to "Change font size", and across a restart | `acceptance/R14_app_zoom_kept.sh` |
| R15 | hard | make the size lock button the top bar's left-most button | `acceptance/R11_lock_menu.sh` |
| R16 | hard | flash the size lock button red, as blocked typing flashes the keyboard and Live buttons, when CTRL -/+ in font mode is refused by a lock | `acceptance/R12_lock_holds.sh` |
| R17 | hard | with debugging on, show a session joined through the Join dialog live by itself after the diagnostics pause, with no spinner left and no click | `acceptance/R17_debug_join_shows.sh` |

### Unwanted behaviour (mandatory)

| id | hard/soft | if … | the system shall … | check |
|---|---|---|---|---|
| U1 | hard | R6 changes the template of an existing session | never change that session's recording | `acceptance/U1_record.sh` |
| U2 | hard | the session is joined, played back or ended | not offer the lock or resize the host | `acceptance/U2_lock.sh` |

## Out of scope

- Recording on/off for an existing session; new dependencies.

## Approval

Approved by the user, 2026-11-13 (relayed by the orchestrator to the builder, 2026-11-13; the decisions are final): R1 at the bottom right, R13 added (session rows that move block clicks with the not-allowed cursor until 500 ms without a change), R4's bubble keeps today's content in two centred lines, Q-1–Q-11 resolved as recorded in `notes--context.md` *Decisions* (Q-6–Q-11: the proposed defaults). File at 8b601de plus this edit.
Soft changes (2026-11-13, recorded 2026-11-14 in `notes--context.md` *Soft changes*): R1, R5, R6, R11, R12, R13 (detail), U2.
R14–R16 added by the user, 2026-11-14, before "done"; R17 (a bug) the same day (`notes--context.md` *Added before done*).
