# Unrecorded sessions and new-session templates — notes and context

Companion to `goal_requirements.md`. Not a spec; nothing here is approved or built from.

## The user's words

Verbatim, dated 2026-11-10, in `../261110_ui-chrome/notes--context.md` *The user's words*: the request (lines 3 and 4 of the list), and every answer about recording, the default, triggers, deleted templates and fields. They are kept in one place because the two projects come from one request.

## Context

- Split from `261110_ui-chrome` on 2026-11-10 because of the 400-word cap (see that page's *Context*).
- "Profile" in the user's words means a session's launch profile: the name, home directory, command and the options in its dialog. The code already calls the flows `newSessionProfile` and `copySessionProfile` (`renderer/app.js`).
- The Edit dialog's existing "Default for new sessions (hold SHIFT on New)" (`renderer/app.js::showSessionEditor`, `setDefaultSession`, `DEFAULT_SESSION_PREFERENCE`) is replaced by R3. Its stored value migrates to the Shift + "+ New" template.
- Today the engine has no unrecorded mode. Every session appends to its encrypted Hypercore log (`engine/index.js::_flushPacketBuffer`) and writes snapshots (`_maybeSnapshot`). Sharing replicates that log, which is why "Live only, no sharing" was chosen.

## Requirement notes

- **R1** Copy pre-ticks the box from its source (A-3). Unticking it greys "Copy history" and "Share session now".
- **R2** An unrecorded session stays listed with a "not recorded" mark, and can be extended (relaunched, still unrecorded) and used as a template. Share, Playback and Copy-with-history refuse it.
- **R3** The heading, in the user's words (2026-11-10): "Set this profile as default for new sessions when:". The dropdown entries are none, then:
  - `The "+ New" button is clicked`
  - `CTRL+SHIFT+T is pressed`
  - `The "+ New" button is clicked while holding "Shift"`

  The checkbox reads `Skip new/edit profile dialog and open directly`. The Advanced section is in the New, Copy and Edit dialogs.
- **R4** "All its settings" means everything the profile's dialog sets:
  - name, numbered `<name> #N`;
  - home directory and command;
  - record and skip-dialog;
  - the share choice and its options;
  - later, delete-history-after.

  A trigger with no template: A-8.
- **R5** The menu items, in the user's words:
  - `Edit new profile defaults`
  - `Edit new profile defaults for CTRL+SHIFT+t`
  - `Edit new profile defaults for Shift + "+ New" button`

  There is a separator above and below them.
- **R6** The hidden copy is restored under the deleted profile's own name. Only its trigger uses it.
- **R7** The user's example of a later trigger is Ctrl+Shift + "+ New".
- **U1** The marker search covers the scratch HOME, storage and TMPDIR, because the app's data, Electron `userData`, logs and caches all live under them.
- **U2** The warning texts are in `design.md` *Refuses*.
- **U4** Without the change, Ctrl+Shift+T reaches the shell as `^T` (transpose-chars).

## Soft changes

None.

## Superseded text

None.
