# Improvements and fixes — goal and requirements (the WHAT)

**Project:** `261121_improvements-and-fixes` · **Area:** `electron/main.js`, `renderer/`, `engine/share-manager.js` · **Written:** 2026-11-21 · **Design:** `design.md` · **Evidence:** `baseline.md` · **Notes:** `notes--context.md`

## Goal

A running list of improvements and fixes the user raises, each landed and checked on a scratch
packaged app under `uisolate`, ending in a release-ready 1.9.2 build (lint and tests green but for
the failures recorded in `baseline.md`, the kit green). Rows are added as items arrive.

## Requirements

| id | hard/soft | the system shall … | check |
|---|---|---|---|
| R1 | hard | ask for confirmation before a window closes while it still has live sessions, when the close comes from outside the app (title-bar close, Alt+F4, taskbar "Close"), with a "Don't ask again" choice | `acceptance/R1_close_confirm.sh` |
| R2 | hard | in search results, show the part of each name in "Session name matches" that matches the search text in cyan | `acceptance/R2_search_keys.sh` |
| R3 | hard | while a search is active, end it on Esc even when the terminal has the focus | `acceptance/R2_search_keys.sh` |
| R4 | hard | show the in-session match position N/M in the status line, not in the search box, followed by the hint "(In terminal Enter/Shift+Enter, in profiles ⬆️/⬇️ )" | `acceptance/R2_search_keys.sh` |
| R5 | hard | show the stamp icon at the left of each settings-menu "Edit new profile defaults…" item | `acceptance/R5_settings_menu.sh` |
| R6 | hard | open the profile dialog from those items with its Advanced section already open, as F2 does on a template | `acceptance/R5_settings_menu.sh` |
| R7 | soft | show an icon at the left of the "STUN/TURN servers…" and "ZBTerm relay access key…" items | `acceptance/R5_settings_menu.sh` |
| R8 | hard | keep the profile dialog in place while its remote-directory list is filtered or changes height (moving only as far as needed to stay inside the window) | `acceptance/R8_dialog_steady.sh` |
| R9 | hard | call "Resume" what the app now calls "Extend" (the toolbar button and every other visible word) | `acceptance/R10_profile_menu.sh` |
| R10 | hard | offer, on a profile's right-click, the items Clone · Create a copy, edit first │ Edit · Remove HD · Delete History · Delete │ Share Session · Share Keyboard · Enable HD │ Resume, in that order and grouping, each with an icon | `acceptance/R10_profile_menu.sh` |
| R11 | hard | make "Clone" create the copy at once and "Create a copy, edit first" open the copy dialog | `acceptance/R10_profile_menu.sh` |
| R12 | hard | turn the three sharing items into their opposites while that state is on (Unshare Session, Unshare Keyboard, Disable HD), each doing what its label says | `acceptance/R10_profile_menu.sh` |
| R13 | hard | leave the tests and the static checks updated to the new behaviour, and the version's packaged build booting | `acceptance/R13_release.sh` |
| R14 | hard | show the search position in the status line as "M / N", M bold cyan, the slash plain, N cyan and not bold | `acceptance/R14_search_toggles.sh` |
| R15 | hard | offer, beside the search box's x, two small toggles "Match case" and "Match whole word", each with its hover text, that apply to every search the box drives (profile names and their marks, the terminal's matches, the live sessions' counts) | `acceptance/R14_search_toggles.sh` |
| R16 | soft | draw the profile list sooner at startup, and say "Loading profiles…" in the list until it is in | `acceptance/R14_search_toggles.sh` |

### Unwanted behaviour (mandatory)

| id | hard/soft | if … | the system shall … | check |
|---|---|---|---|---|
| U1 | hard | the quit came from the app (Ctrl+Q popup, `app.quit`), a logout or shutdown, or no session is live | not ask before closing | `acceptance/R1_close_confirm.sh` |
| U2 | hard | no search is active | pass Esc to the terminal unchanged | `acceptance/R2_search_keys.sh` |
| U3 | hard | a menu item does not apply to the right-clicked profile (pending, joined, offline, unrecorded) | show it disabled and do nothing on a click | `acceptance/R10_profile_menu.sh` |
| U4 | hard | the user picks "Unshare Session" | end the invites and viewers only: the session keeps running and keeps its history | `acceptance/R10_profile_menu.sh` |
| U5 | hard | a toggle is clicked while the box holds text | keep the box's focus and its text, and keep the toggles' state across a restart | `acceptance/R14_search_toggles.sh` |

## Out of scope

- No publish, tag or GitHub release (AGENTS.md *Never*); "release ready" means built and verified.
- The share wizard, the profile dialog's fields and the toolbar's own buttons other than the rename.
- The Freenet core's own revoke path (`_coreRevokeLink`): reused, not changed.

## Approval

Approved by the user 2026-11-21 ("yes approved and yes add dont ask again"), with a "Don't ask again" checkbox: R1, U1.

R2–R13, U2–U4: from the user's list of 2026-11-21 (`notes--context.md`), with the instruction to build
without stopping for questions ("Please take over … dont stop for questions"). That instruction stands
in for the approval line; the rows are read back to the user, with the soft changes, before "done".

R14–R16, U5: from the user's message after the morning report of 2026-11-21 ("A few more things please", `notes--context.md`),
written by the planner and built at once on the standing instruction not to stop; read back with the rest
before "done".
