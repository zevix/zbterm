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

Dated, old → new, why. Read back to the user before "done".

- 2026-11-11 (P1, planner decision), U1 check detail. Old (`design.md` *The reference program*): "As a control, the same marker in a recorded session must be found" by the on-disk `grep -rF`. New: the control reads the recorded session's marker back through playback (`player.open` + `player.seek`, the mirror the recording rebuilds), and U1 also checks that the unrecorded session's log does not grow across the 5 MB flood (`GET /sessions/<id>/stats` log length, before = after). Why: recorded history and snapshots are encrypted on disk, so the marker of a recorded session is never in any file either (`../261110_ui-chrome/status--done.md` *Gotchas*: `grep -rlF` → none); the on-disk control could never pass. The on-disk grep for the unrecorded marker is unchanged.
- 2026-11-11 (P1), R2/U1 mechanism detail. Old (`design.md` *Unrecorded runtime*): "`_recordLiveData` does not add to `appendBacklog`/`pendingBytes`". New: it does not add to `appendBacklog`; it still adds to `pendingBytes`. Why: `pendingBytes` is the renderer's flow window, lowered by the renderer's `session.ack` for every byte it is sent, recorded or not; it cannot stall, and dropping it would remove the only backpressure between a flood and the renderer. `appendBacklog` (the store's queue) is the counter that would never drain (review row 1). Covered by `test/engine-unrecorded.test.js` "a 5 MB flood …" (`appendBacklog` stays 0, `pendingBytes` back to 0 after acks, the PTY is not left paused).
- 2026-11-11 (P1), U1 mechanism detail. Old: "After the header and first resize the log takes nothing more", with no word on where the geometry lives. New: the engine logs no resize after the first (the store itself refuses every non-resize packet, `E_NOT_RECORDED`), and on exit the last `cols`/`rows` go into the store's info, which Extend relaunches at. Why: Extend of a recorded session takes its geometry from the snapshot or the replayed log; an unrecorded one has neither.
- 2026-11-11 (P1), *Refuses* detail. `session.create` with `record: false` and `copyHistoryFrom` answers `E_INVALID` (copied history would be recorded); `session.update` with the session's current `record` value is accepted as no change, and only a different value is refused with `E_INVALID`. `E_INVALID` and `E_NOT_RECORDED` are new `CODES`. Why: the design names the codes but not these two cases; restating the value lets a dialog send its whole form.
- 2026-11-11 (P1), *Unrecorded runtime* detail. "`archiveMirror` is not built": no archive replay is built; the runtime keeps the empty in-memory `TerminalFrame` every runtime starts with, never written. Why: every teardown path disposes it; an object that is never written holds nothing and needs no null checks.
- 2026-11-11 (P2), *Triggers* detail. Old (`design.md` *Interface*): `NEW_SESSION_TRIGGERS` "ordered most specific first". New: the table's order is the order shown (dropdown and menu: + New, Ctrl+Shift+T, Shift + "+ New", as R3 and R5 list them); a click or key matches only on its exact modifiers, so no entry can shadow another and the order does not decide a match. A click chord no entry names (Alt+click, say) counts as the plain click, as before templates. Why: R3's and R5's checks fix the shown order, which is not the most-specific order; exact matching already gives what the ordering was for (R7's Ctrl+Shift click is covered).
- 2026-11-11 (P2), *Triggers* detail. Two more optional entry fields: `noTemplate: 'dialog'` (with no template, open an empty New dialog; without it the default shell starts, A-8) and `migrateFrom` (the older preference that trigger takes over, *Migration*). Why: R7 requires that no trigger id or label appears outside the table, so the A-8 difference and the migration source are table data, not code naming a trigger.
- 2026-11-11 (P2), A-9 detail. A template that skips the dialog and carries a share choice shares with no wizard: the link is made with the stored options, copied when they say Auto Copy, and the status line reports it. Through the dialog, "Share session now" still opens the Share key wizard. Why: R4's check expects no dialog open after a skip-dialog creation; a wizard waiting for Done would be one.
- 2026-11-11 (P2), *Data and state* detail. The stored value of `newSessionTemplate.<id>` is the JSON text of `{ sessionId, copy }` (preferences hold strings); an empty string means the trigger has no template (released from the dialog's "none"). Why: the engine's `preference.set` stores `String(value)`.
- 2026-11-11 (P3), U2/U3 wording detail. Old (`design.md` *Refuses*): "<A> is the template for <verb>. …", "<name> is the template for <verb>. It will be restored as <name> the next time you <verb>.", "<name> is the deleted template for <verb>; this profile will replace it." New: "for new sessions when you <verb>" in all three, names quoted ("\"u3 a\" is the template for new sessions when you press CTRL+SHIFT+T. Make this profile the template instead?"). Why: the table's verbs are imperatives ("press CTRL+SHIFT+T") that read right after "the next time you", not after "the template for". The kit regexes match both.
- 2026-11-11 (P3), U2/U3 mechanism detail. The dialog's questions (U2 name, U3 takeover) are asked at OK, over the open dialog, before it closes; Cancel leaves the dialog as it was. The `createSession` funnel asks the name question only for dialog-less creations (Shift-Copy, skip-dialog templates); the Rename prompt asks before `session.rename`. Why: U3's check needs the dialog open after Cancel; asking after the dialog closed would lose the user's input.
- 2026-11-11 (P3), U2 "this profile will replace it". On OK, a profile that holds no trigger of its own takes the hidden copy's place as that trigger's template (its name, home, command and record; the trigger's skip-dialog and share choice carry over). A profile that picked a trigger in Advanced keeps only that one (one trigger per profile, Q-4), and the hidden copy stays (restored later as `<name> #N`). Why: the user's words "warn it will override"; the design names the text, not the effect.
- 2026-11-11 (P3), U2 detail. Deleting a template always shows the confirmation, also with Shift (which otherwise skips it). Why: U2 says "warn first".
- 2026-11-11 (P3), U3 detail. Picking a trigger whose template is a hidden copy also asks, with the hidden-copy text. Why: moving it silently would drop the hidden copy.
- 2026-11-11 (P3), R2 detail. Besides Share and Playback (Play), Step back and the scrubber are disabled with the title "Not recorded", and the Copy dialog of an unrecorded source greys "Copy history" even when Record is ticked. When an unrecorded session ends, no playback opens: its last screen stays under the offline dots and the status line says "ended, not recorded"; selecting an ended one without extending shows an empty screen. Why: each of these would otherwise call `player.open` or `copyHistoryFrom` and get `E_NOT_RECORDED`.
- 2026-11-11 (P3), dialog layering detail. A confirmation asked while the session editor is open gets z-index 26 (`.modal-overlay-over-editor`); other `.modal-overlay`s keep 20. Why: a Share key wizard left open behind a new dialog must stay behind it (P2).

## Superseded text

None.
