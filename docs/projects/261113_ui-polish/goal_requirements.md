# UI polish: timeline, search, menus, size lock — goal and requirements

**Project:** `261113_ui-polish` · **Area:** `renderer/` (`engine/index.js` only if Q-8 keeps the lock per session) · **Written:** 2026-11-13 · **Notes:** `notes--context.md` (the user's words, where each row lands, open questions Q-1–Q-11)

## Goal

Small fixes from use, and a terminal size lock, checked on a scratch packaged app under `uisolate`. Reference program: `acceptance/run_all.sh` (not written yet).

## Requirements

| id | hard/soft | the system shall … | check |
|---|---|---|---|
| R1 | hard | show an unrecorded session's duration alone at the bottom left, without timeline controls (Q-1) | `acceptance/R1_unrecorded.sh` |
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

### Unwanted behaviour (mandatory)

| id | hard/soft | if … | the system shall … | check |
|---|---|---|---|---|
| U1 | hard | R6 changes the template of an existing session | never change that session's recording | `acceptance/U1_record.sh` |
| U2 | hard | the session is joined, played back or ended | not offer the lock or resize the host | `acceptance/U2_lock.sh` |

## Out of scope

- Recording on/off for an existing session; new dependencies.

## Approval

Not approved: proposal of 2026-11-13.
