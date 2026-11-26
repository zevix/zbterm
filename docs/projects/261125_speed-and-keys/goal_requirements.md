# Speed and keys: fast switching, ^D delete, one search key map — goal and requirements

**Project:** `261125_speed-and-keys` · **Area:** `renderer/`, `electron/` · **Written:** 2026-11-25 · **Design:** `design.md` · **Evidence:** `baseline.md` · **Notes:** `notes--context.md`

## Goal

Switching profiles and typing feel immediate again, whatever the number of profiles or the size
of their history. A closed session can be deleted with Ctrl+D wherever Ctrl+R would resume it.
The keyboard has two states and no third: *search* while the search box has the focus, *terminal*
otherwise; each key means one thing in each state, and the status line names the search state and
its keys. Reference program: `acceptance/run_all.sh` on the packaged build.

## Requirements

| id | hard/soft | the system shall … | check |
|---|---|---|---|
| R1 | hard | show the profile a switch lands on (Ctrl+PgUp/PgDn, a row click, an arrow in search) without a perceptible wait, independent of the number of profiles and of their history size | `acceptance/R1_switch_speed.sh`, `acceptance/R1_many_profiles.sh` |
| R2 | hard | echo a key typed in a live terminal without perceptible lag, also while output streams | `acceptance/R2_typing_speed.sh` |
| R3 | hard | on Ctrl+D, wherever Ctrl+R would resume a closed session, delete that session after the usual confirmation | `acceptance/R3_delete_key.sh` |
| R4 | soft | name Ctrl+D in the resume message: "Press ^R or Enter to resume the session, ^D to delete it" | `acceptance/R3_delete_key.sh` |
| R5 | soft | after such a delete, show the neighbouring profile (not resumed) | `acceptance/R3_delete_key.sh` |
| R6 | hard | never show search results (sections, name filter, highlights) while keys go to the terminal: when the focus goes to the terminal the search ends, its text kept for the box's next focus | `acceptance/R6_search_states.sh` |
| R7 | hard | keep the focus in the box, and the search going, on a click on a result row or a toolbar button, on Ctrl+R, on Ctrl+D and when a dialog or menu opened from search closes | `acceptance/R6_search_states.sh` |
| R8 | hard | give each key one meaning in search: Up/Down and Ctrl+PgUp/PgDn move between profiles; Enter/Shift+Enter move between the matches in the shown profile and never resume it; Ctrl+R resumes; Ctrl+D deletes; Esc ends the search | `acceptance/R6_search_states.sh` |
| R9 | hard | in search, always show in the status line that search is on and what its keys do, with the match position when there are matches | `acceptance/R6_search_states.sh` |
| R10 | hard | outside search, walk the whole profile list in the order drawn, wrapping, on Ctrl+PgUp/PgDn | `acceptance/R6_search_states.sh` |
| R11 | soft | during a search walk, not label a profile "Current session" unless it is the one shown | `acceptance/R6_search_states.sh` |

### Unwanted behaviour (mandatory)

| id | hard/soft | if … | the system shall … | check |
|---|---|---|---|---|
| U1 | hard | Ctrl+D is pressed in a live session, or on a session that cannot be resumed (joined, pending) | pass it to the program or do nothing; never delete | `acceptance/R3_delete_key.sh` |
| U2 | hard | the delete confirmation is cancelled | delete nothing and return the focus to where it was | `acceptance/R3_delete_key.sh` |
| U3 | hard | switch keys arrive faster than profiles can be drawn (a held Ctrl+PgDn) | end on the profile that many steps away and draw only it correctly: no stale screen, no error | `acceptance/R1_switch_speed.sh` |
| U4 | hard | a speed fix would drop output, history or a recorded byte | not do it: what the terminal shows and what is recorded stay as before | `acceptance/R2_typing_speed.sh` |

## Out of scope

- The search itself (what matches, the sections, the toggles, the highlights' drawing).
- Mouse behaviour in the terminal, apart from a row click keeping the search.
- Enter resuming a closed session from the terminal (kept as it is).
- The engine's storage format and the sharing protocol.

## Approval

Approved 2026-11-25 by the user ("approved, go", in chat, on the summary naming Q-1, Q-2 and A-1 as recommended), file at sha256 `21e89f2953e97a9c9f1fefe4b82d7ebedb92db5f1d2df65f635a53cdd7df3108` (before this line).
