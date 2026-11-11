# Unrecorded sessions and new-session templates — design (one page)

**Serves:** `goal_requirements.md` R1–R7, U1–U4 · **Written:** 2026-11-10 · **Reviewed:** 2026-11-10, Sonnet 5.5, fresh context, on the combined draft (rows below) · **Approved:** see end.

## Interface

- **Engine.** `session.create` takes `record` (boolean, default `true`).
  - The catalog entry carries `record: false` beside `cwd`/`command` (`engine/index.js::launchOptions`).
  - `record` is fixed at creation: `session.update` refuses to change it, and `session.extend` keeps it.
  - On an unrecorded session, `share.createLink`, `player.open` and `session.create {copyHistoryFrom}` throw `EngineError` `E_NOT_RECORDED` ("session is not recorded").
- **Triggers.** One table, `NEW_SESSION_TRIGGERS` in `renderer/app.js`, ordered most specific first. Each entry is `{ id, choice, menuLabel, verb, source: 'key'|'click', mods: { ctrl, shift, alt, meta }, key? }`, matched on *exact* modifiers. The entries:
  - `ctrlShiftT`: key `t`.
  - `shiftNew`: click, shift.
  - `new`: click, no modifiers. Keyboard activation of the button (Enter/Space) counts as `new`.

  Labels and menu text are in the user's words (`notes--context.md` R3, R5). Everything else, including the dropdown, the menu section, the key and click dispatch and the warning texts, iterates the table. `startNewSession(triggerId, anchor)` is the single entry point.
- **Dialog** (`renderer/app.js::showSessionEditor`, modes new/copy/edit/template):
  - "Record session" checkbox. Unticking it greys "Copy history" and "Share session now".
  - At the bottom, `<details>` "Advanced", holding:
    - "Set this profile as default for new sessions when:";
    - a `<select>`: none plus every trigger, single choice;
    - "Skip new/edit profile dialog and open directly".
  - It resolves with `{ name, cwd, command, record, share, copyHistory, triggerId, skipDialog }`.
- **Settings menu** (sibling project's `kind` items): a separator, then one `menuLabel` item per trigger (it opens mode `template` for that trigger), then a separator.
- **Hotkey.** Ctrl+Shift+T is handled exactly as the sibling's Ctrl+Shift+B: document capture plus `attachCustomKeyEventHandler`, ignored while a modal is open.
- **Debug commands** (on top of the sibling's):
  - `dialog-set` (`{ field, value }`), `dialog-submit`, `dialog-cancel`;
  - `confirm-state`, `confirm-answer` (`{ ok }`);
  - `templates`: the stored state;
  - `triggers-add`: test-only, appends a table entry (R7).

## Data and state

- **Templates.** One profile preference per trigger: `newSessionTemplate.<triggerId>` = `{ sessionId | null, copy: { name, cwd, command, record, skipDialog, share } }`. Separate keys mean no lost update between triggers.
  - Writes are read-modify-write of that one key, at submit time.
  - `copy` is rewritten whenever the template session is created, edited or renamed.
  - When `sessionId` resolves to a live catalog entry, its current values win; `copy` is the hidden copy.
  - A template-mode edit with no session writes `copy` only.
- **Hidden copy.** When the template session is deleted, `sessionId` is set to `null` and `copy` stays.
  - The trigger creates from `copy`, named `copy.name`, or `copy.name #N` if that name is taken (A-5). The created session, under whatever name it got, becomes `sessionId`.
  - The U2 name check compares exact names against the hidden copies of every trigger.
- **Migration** (once, idempotent): if `newSessionTemplate.shiftNew` is absent and `DEFAULT_SESSION_PREFERENCE` names a live session, the new key is written from it with `skipDialog: true`; the old key is cleared only after the write. If that session is gone, nothing migrates and Shift+New keeps today's no-default behaviour. A second window finds the new key and does nothing.
- **Unrecorded runtime.** One guard, `runtime.record === false`:
  - `SessionStore.appendPlain` refuses data packets, and the store also refuses them itself when its info says `record: false`. After the header and first resize the log takes nothing more.
  - `SnapshotCache` is not created (a `null` snapshot).
  - `archiveMirror` is not built.
  - `share.broadcastData` is skipped.
  - `_recordLiveData` does not add to `appendBacklog`/`pendingBytes`. `runtime.mirror`, the in-memory screen, is kept, so switching sessions redraws.

## Refuses

- Share, Playback, Copy history on an unrecorded session: disabled, with the tooltip "Not recorded"; the engine returns `E_NOT_RECORDED`.
- Changing `record` through `session.update`: `E_INVALID`.
- A trigger held by another profile (U3) asks: "<A> is the template for <verb>. Make this profile the template instead?" Cancel keeps the dialog unchanged.
- Deleting a template (U2): the confirmation adds "<name> is the template for <verb>. It will be restored as <name> the next time you <verb>."
- Creating or renaming to a hidden copy's name (U2): "<name> is the deleted template for <verb>; this profile will replace it." This is checked in the renderer's single `createSession` funnel and in `session.rename`, so it covers skip-dialog, Copy and Extend. Joined sessions are not profiles and are exempt.

## The reference program, step by step

Like the sibling's (`../261110_ui-chrome/design.md`), with `lib.sh` from there. U1 greps `-rF` the marker across `$ZBUI_HOME`, `$ZBUI_STORAGE` and `$ZBUI_TMP` (Electron `userData`, logs and Chromium caches live there). It runs after:
- printing;
- a resize;
- a 5 MB flood;
- Extend;
- closing the app.

As a control, the same marker in a recorded session must be found.

## Failure scenarios

| # | scenario | at risk | design answer |
|---|---|---|---|
| 1 | Flood in an unrecorded session freezes flow control | R2 | Backlog counters are untouched when unrecorded (*Unrecorded runtime*). `R2_unrecorded_live.sh` floods 5 MB, then echoes a marker. |
| 2 | Resize, restore and snapshot paths outside `_recordLiveData` write output | U1 | One guard at the store and the snapshot (no snapshot, no archive mirror). U1 runs a resize, Extend and app close. |
| 3 | `record` flipped on a live session | U1, R2 | Fixed at creation; `session.update` refuses (*Refuses*). Covered by the engine test in P2. |
| 4 | Template edited while a dialog is open; two windows writing one blob | R4, U3 | One key per trigger, read-modify-write at submit. The prefill is a snapshot of open time (A-10). |
| 5 | Name-setting routes without a dialog | U2, R6 | Check in the single `createSession` funnel and in rename; joins exempt (*Refuses*). `U2_template_warnings.sh` covers Copy and skip-dialog. |
| 6 | Restored as `bash #2`, which is the template? | R6 | The created session, whatever its name (*Hidden copy*). `R6_deleted_template.sh` covers the clash. |
| 7 | Migration from a dead default; two windows | R4, R6 | Migrates only a live session, writes before clearing, idempotent (*Migration*). |
| 13 | Shift+click, keyboard activation, Ctrl+Shift+click order | R4, R7 | Exact modifiers, most specific first; Enter/Space counts as `new`. `R7_one_table.sh` adds Ctrl+Shift + "+ New" and checks that Shift+New still maps to `shiftNew`. |
| 14 | Output reaching disk outside the storage dir | U1 | U1 greps HOME, storage and TMPDIR, all scratch. The debug server already reduces `session:data` to a byte count. |
| 8, 9, 15 | Hotkey focus, layout, synthetic events | U4 | As in the sibling: modal guard, `key.toLowerCase()` with exact modifiers, xterm handler; U4 uses `xdotool` and `od -c`. |

## Questions and assumptions

- **Q-1**, 2026-11-10: unrecorded means live only, with no sharing.
- **Q-4**, 2026-11-10: one trigger per profile; a skip-dialog checkbox; menu items; a hidden copy restored by name; templates carry everything (`notes--context.md`).
- **A-3** Copy pre-ticks Record from its source, and New pre-ticks it from its template; otherwise it is ticked.
- **A-4** An unrecorded session stays listed with a "not recorded" mark, and Extend relaunches it unrecorded.
- **A-5** A hidden copy whose name is taken by a live session is restored as `<name> #N`.
- **A-8** A trigger with no template: + New opens an empty dialog; Shift+New and Ctrl+Shift+T start the default shell.
- **A-9** A template's share choice and options are applied, so a skip-dialog trigger can create and share in one step.
- **A-10** The dialog shows the template as it was when the dialog opened.

## Decisions

- **D-tbd: unrecorded sessions keep a `SessionStore`, holding a header only.**
  - **Context:** the catalog, the list, Extend and delete all assume a store.
  - **Decision:** create the store with its info and first resize; the store refuses data packets.
  - **Why:** a storeless session would fork every path, and a header-only log holds nothing the program printed.

## Approval

Approved 2026-11-11 by the user ("approved" in chat, covering all three projects), file at sha256 ab178b602685 (the file as approved, before this line).
