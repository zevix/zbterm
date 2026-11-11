# Unrecorded sessions and new-session templates — goal and requirements

**Project:** `261110_session-templates` · **Area:** `renderer/`, `engine/` · **Written:** 2026-11-10 · **Design:** `design.md` · **Evidence:** `../261110_ui-chrome/baseline.md` · **Sibling:** `../261110_ui-chrome/` (its P1 builds the shared kit harness)

## Goal

- **Unrecorded.** A ZBTerm session can run live with nothing stored, replayed or shared.
- **Templates.** Each way to start a session ("+ New", Ctrl+Shift+T, Shift + "+ New") copies one template profile, with or without the dialog. A deleted template survives as a hidden copy.

The checks drive a scratch packaged app under `uisolate`. Reference program: `acceptance/run_all.sh`.

## Requirements

| id | hard/soft | the system shall … | check |
|---|---|---|---|
| R1 | hard | offer "Record session" in the New and Copy dialogs, ticked by default | `acceptance/R1_record_checkbox.sh` |
| R2 | hard | run an unrecorded session live under heavy output, without playback, history copy or sharing | `acceptance/R2_unrecorded_live.sh` |
| R3 | hard | let a profile's dialog, in an expandable Advanced section, make it one trigger's template and offer to skip the dialog | `acceptance/R3_template_choice.sh` |
| R4 | hard | create a session from the trigger's template with all its current settings, opening the dialog unless the template skips it | `acceptance/R4_trigger_creates.sh` |
| R5 | hard | let the settings menu edit each trigger's template, in a section of its own | `acceptance/R5_menu_templates.sh` |
| R6 | hard | keep a deleted template as a hidden copy that still serves its trigger under its own name, until the session it creates becomes the new template | `acceptance/R6_deleted_template.sh` |
| R7 | soft | let a new trigger be added as one entry in one table | `acceptance/R7_one_table.sh` |

### Unwanted behaviour (mandatory)

| id | hard/soft | if … | the system shall … | check |
|---|---|---|---|---|
| U1 | hard | an unrecorded session prints, resizes, ends or is extended | leave none of its output in any file the app writes | `acceptance/U1_unrecorded_nothing_on_disk.sh` |
| U2 | hard | the user deletes a template, or names a profile like a deleted template | warn first, naming the trigger | `acceptance/U2_template_warnings.sh` |
| U3 | hard | the user picks a trigger held by another profile | ask before moving it, naming that profile | `acceptance/U3_template_takeover.sh` |
| U4 | hard | Ctrl+Shift+T is pressed in the terminal | not send it to the program in the terminal | `acceptance/U4_new_hotkey_not_typed.sh` |

## Out of scope

- Archived-session search; auto-deleting history; live sharing of unrecorded sessions.
- Turning recording on or off for an existing session.

## Approval

Approved 2026-11-11 by the user ("approved" in chat, covering all three projects), file at sha256 3eae9d24681e (the file as approved, before this line).

2026-11-11, P1 builder (planner decision): U1's check keeps the on-disk grep for the unrecorded marker; its control reads the recorded marker through playback and it checks that the unrecorded log does not grow across the flood, because recorded history is encrypted on disk (`notes--context.md` *Soft changes*). The approved text above is unchanged.
