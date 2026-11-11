# UI chrome and collapsible side pane — goal and requirements

**Project:** `261110_ui-chrome` · **Area:** `renderer/` · **Written:** 2026-11-10 · **Design:** `design.md` · **Evidence:** `baseline.md` · **Sibling:** `../261110_session-templates/` (split off for the 400-word cap)

## Goal

The ZBTerm desktop window gets a tidier frame:
- the version moves into the settings menu;
- the timeline bubble shows the real time;
- New and Join get coloured icons;
- the identity button shows whether an identity is set up;
- the left pane can be collapsed from the logo or a hotkey. The top bar then carries the brand, New, Join and Settings.

The checks drive a scratch packaged app under `uisolate`, through the debug server and real key presses. Reference program: `acceptance/run_all.sh`.

## Requirements

| id | hard/soft | the system shall … | check |
|---|---|---|---|
| R1 | soft | show the app version as the last item of the settings menu, not in the brand bar | `acceptance/R1_version_in_menu.sh` |
| R2 | hard | show the wall-clock time of the playhead or hover point in the bubble above the timeline, beside the elapsed time, shorter the more recent it is | `acceptance/R2_bubble_clock.sh` |
| R3 | soft | colour the New icon green and the Join icon blue | `acceptance/R3_button_colours.sh` |
| R4 | hard | toggle the left pane from the ZBTerm logo (a hamburger on hover) and from Ctrl+Shift+B, naming the hotkey in the tooltip | `acceptance/R4_pane_toggle.sh` |
| R5 | hard | while the pane is collapsed: put the logo, "ZBTerm", New and Join (with text), and Settings at the left of the top bar, in the pane's colour; put identity and theme in the settings menu; let the title box fill the rest | `acceptance/R5_collapsed_layout.sh` |
| R6 | hard | mark the identity button with a green dot when an identity is set up, and an orange one when not | `acceptance/R6_identity_dot.sh` |

### Unwanted behaviour (mandatory)

| id | hard/soft | if … | the system shall … | check |
|---|---|---|---|---|
| U1 | hard | Ctrl+Shift+B is pressed while the terminal has focus | not send it to the program in the terminal | `acceptance/U1_hotkeys_not_typed.sh` |
| U2 | hard | the window is narrow (single-column layout) or a dialog is open | keep the pane toggle working without hiding or covering the open dialog | `acceptance/U2_narrow_and_modal.sh` |

## Out of scope

- Everything about new-session dialogs, recording and templates: `../261110_session-templates/`.
- macOS menu accelerators (`electron/main.js::installAppMenu`).
- Restyling anything not named above.

## Approval

Approved 2026-11-11 by the user ("approved" in chat, covering all three projects), file at sha256 523ab5119b40 (the file as approved, before this line).
