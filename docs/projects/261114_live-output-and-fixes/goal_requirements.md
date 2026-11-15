# Live output and fixes — goal and requirements (the WHAT)

**Project:** `261114_live-output-and-fixes` · **Area:** `engine/`, `electron/`, `renderer/` · **Written:** 2026-11-14 · **Design:** `design.md` · **Evidence:** `baseline.md` · **Notes:** `notes--context.md`

## Goal

The terminal shows a live session's output exactly once whenever the app repaints it from the
engine's snapshot (switch, history extension, restart), whatever order snapshot and stream arrive
in: design A ("stream positions") of `../261113_ui-polish/delivery-design.md`. Plus the user's
smaller fixes (R4–R7) and the rest of their list (R8–R13: search mode, the history toolbar's ends,
the logo screen). Checked on a scratch packaged app under `uisolate` on host `zr`. Reference
program: `acceptance/run_all.sh`.

## Requirements

| id | hard/soft | the system shall … (one testable sentence) | check |
|---|---|---|---|
| R1 | hard | when the user selects an own live session while it prints, show every output line exactly once | `acceptance/R1_switch_exact.sh` |
| R2 | hard | do the same when extending the history and when restoring after a restart | `acceptance/R2_repaint_exact.sh` |
| R3 | hard | do the same for a joined session in the viewer | `acceptance/R3_joined_exact.sh` |
| R4 | hard | mark a template session in the session list with a template icon, not the green check, left of any pin so pins stay at the right edge | `acceptance/R4_template_mark.sh` |
| R5 | hard | while searching, when a session has matches its terminal cannot show (history behind a full-screen editor), split the cyan count into shown and hidden | `acceptance/R5_hidden_matches.sh` |
| R6 | hard | label the font-size buttons "+ A" and "- A" instead of "+ Font" and "- Font" | `acceptance/R6_font_labels.sh` |
| R7 | soft | draw that A in a serif face, as word processors do | `acceptance/R6_font_labels.sh` |
| R8 | hard | while the search box has focus, show "Search (Esc to exit)" as its empty text ("Search (Ctrl+Shift+F)" when it has no focus, as today) | `acceptance/R8_search_mode.sh` |
| R9 | hard | while searching (the box has focus or holds text), show a blue close "x" where the magnifying glass is, instead of it, that ends the search as Esc does; no second "x" inside the box | `acceptance/R8_search_mode.sh` |
| R10 | hard | while the search box has focus, let Up and Down select the previous and next session in the session list (top to bottom, the "Session buffer matches" rows included), the focus staying in the box; the selected row's border is the logo green and thicker while searching | `acceptance/R10_search_arrows.sh` |
| R11 | hard | lay out the history toolbar as `\|<<  \|<  >  >\|  >>\|  [collapse]`: `\|<<` ("Start") shows the session's first frame, `>>\|` ("End") its end (live for a running session, the last frame for an ended one) | `acceptance/R11_history_ends.sh` |
| R12 | hard | colour `>>\|` as the Live button is coloured and flash it in step with it | `acceptance/R11_history_ends.sh` |
| R13 | hard | on the logo screen, leave out "Based on modules and examples by pears.com/holepunch.to" and "ZBTerm is not affiliated with Holepunch.to or pears.com", and centre "See https://github.com/zevix/zbterm for more information" | `acceptance/R13_logo_text.sh` |
| R14 | hard | while the search box has focus, make Ctrl+PgUp and Ctrl+PgDn do exactly what Up and Down do there (R10), not their usual switch to the previous or next session | `acceptance/R14_search_resume.sh` |
| R15 | hard | when moving between sessions from the search box with the keyboard (R10, R14), do not resume an offline session (one of ours whose shell has ended): show it as when looked at, bring up the usual "Press ^R to resume the session" toast, and let Ctrl+R pressed in the search box resume it, the focus staying in the box | `acceptance/R14_search_resume.sh` |

### Unwanted behaviour (mandatory)

| id | hard/soft | if … (the wrong input, state or host) | the system shall … | check |
|---|---|---|---|---|
| U1 | hard | output between the engine and the screen is lost (a gap in the stream) | repaint the session from a fresh snapshot instead of showing a silent hole | `acceptance/U1_gap_resync.sh` |
| U2 | hard | an engine or app of the previous contract version is on the other side | keep working as today (no crash, no blank terminal) | `acceptance/U2_old_peer.sh` |
| U3 | hard | Up/Down in the search box while an IME composes, with Ctrl/Alt/Meta held (Ctrl+PgUp/PgDn are R14), at the list's first or last row, or with no rows | do nothing beyond today's behaviour (no wrap-around, no error) | `acceptance/R10_search_arrows.sh` |
| U4 | hard | `\|<<` or `>>\|` on a session with no history (unrecorded, or nothing recorded yet), or `>>\|` already live | stay disabled or do nothing, as the step buttons do today | `acceptance/R11_history_ends.sh` |

## Out of scope

- Electron's own ordering of IPC replies against events; the share backends' wire formats beyond the field R3 needs; new dependencies.

## Approval

Approved 2026-11-14 by the user ("OK approved go implement", rows R1–R7, U1–U2), file at `2b98c8a5ef26` (`git hash-object`).
Rows R8–R13, U3–U4 added 2026-11-15 from the user's full list (`notes--context.md`); approved by the user 2026-11-15 ("approved, go").
Rows R14–R15 (and U3's pointer to R14) added 2026-11-15 after the user's manual test ("its very good!"); the user asked for them with "Please update the reqs design and the code, then I approve" (approval given in advance with the request).
