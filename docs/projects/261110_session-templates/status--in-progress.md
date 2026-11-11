# Unrecorded sessions and new-session templates — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-11: P1 (engine `record: false`), P2 (dialog and templates) and P3 (warnings, takeover, unrecorded marks) built on branch `session-templates`. The full kit is green on this host (11/11). The next phase is P4 (close: kit at HEAD, tests, README/ARCHITECTURE, `D-nn`, rename to `status--verifying.md`).

## Done

- 2026-11-11 P3 builder: warnings, takeover and the unrecorded marks (`renderer/app.js`, `renderer/index.html`).
  - R2: on an unrecorded session (`isUnrecordedSession`, `entry.record === false`) Share, Play, Step back and the scrubber are disabled with the title "Not recorded"; `shareSession` and `enterPlaybackMode` refuse it. When it ends, `openPlayback` calls `showUnrecordedEnded` instead of `player.open`: the last screen stays under the offline dots, status "ended, not recorded". A Copy of an unrecorded source greys "Copy history".
  - U2: deleting a template always asks (Shift too), naming the trigger and the restore name. A name equal to a hidden copy's (`hiddenCopiesNamed`) asks "… is the deleted template for new sessions when you …; this profile will replace it." in the New/Copy/Edit/template dialogs at OK (`templateChecks`, via `showSessionEditor`'s new `beforeSubmit`), in the `createSession` funnel for dialog-less paths (Shift-Copy, skip-dialog) and before Rename. On OK a profile with no trigger of its own becomes that trigger's template (`claimHiddenCopies`). The trigger being restored is exempt (`restoring`).
  - U3: at OK, a picked trigger held by another live profile asks "… is the template for new sessions when you …. Make this profile the template instead?"; Cancel keeps the dialog open and unchanged. A trigger held by a hidden copy asks with the hidden-copy text.
  - Confirmations asked while the session editor is open get `.modal-overlay-over-editor` (z-index 26 > the editor's 25); other `.modal-overlay`s stay at 20, so a Share key wizard left open still sits behind a new dialog.
  - Debug: `confirm-state`/`confirm-answer` act on the top `.modal-overlay`; `dialog-submit` and `confirm-answer` wait (≤ 5 s) until the editor's OK checks have asked or ended (`debugSettleEditorChecks`). `docs/debug_server_howto.md` updated.
  - Kit: R2 gained one assertion (kit correction, dated in the script): after the unrecorded session ends, the status line has no engine refusal. It fails on this build with the `openPlayback` guard removed (`p3_base_R2_noguard.log`: status "session is not recorded").
  - "Share session now" from the dialog: its wizard opens after the dialog closed and after the template write, so it does not interfere; no change.
- 2026-11-11 P2 builder: the dialog and the templates (`renderer/app.js`, `renderer/index.html`).
  - `NEW_SESSION_TRIGGERS` (top of `renderer/app.js`): + New, Ctrl+Shift+T, Shift + "+ New". The dropdown, the settings-menu section, the click and key dispatch, the row mark and the + New tooltip iterate it. `startNewSession(triggerId, anchor)` is the one entry point.
  - Dialog (`showSessionEditor`, modes new/copy/edit/template): unticking "Record session" unticks and greys "Copy history" and "Share session now" (title "Not recorded"). An "Advanced" `<details>` holds the trigger `<select>` (none + the table) and the skip-dialog box (greyed while none is chosen). The Edit dialog's "Default for new sessions (hold SHIFT on New)" is gone.
  - Templates: one preference per trigger, `newSessionTemplate.<id>`. Written at submit (read-modify-write); a profile holds one trigger; choosing none releases it. Rename and Edit rewrite the copy. A delete keeps the copy with `sessionId: null`, and the next creation from it is named `copy.name` (or `#N` when taken) and becomes the template; the U2 warnings around it are still P3.
  - Migration of `zbterm.defaultSessionId` to Shift + "+ New" (`migrateLegacyTemplates`, on profile load), written before the old key is cleared.
  - Settings menu: a separator, the three `menuLabel` items (each opens mode `template`), a separator.
  - Ctrl+Shift+T is handled like Ctrl+Shift+B (document capture plus xterm's custom key handler, left alone while a dialog is open). Planned for P3, but R4 presses it.
  - Debug: `templates` and `triggers-add` serve the table. Dialog commands act on the overlay on top (z-index, then the newest), so a Share key wizard left behind a new dialog no longer hides it. `POST /sessions/:id/switch` now always reaches the renderer (`electron/debug-server.js`); before, a switch back to the session the server last selected was dropped after the app had moved on by itself (U4 failed on it). `docs/debug_server_howto.md` updated.
- 2026-11-11 P1 builder: unrecorded sessions in the engine.
  - `session.create {record: false}`: the store info and the catalog entry carry `record: false`. There is no snapshot cache (null) and no archive replay. Output is not buffered for the log, broadcast or snapshotted; the live mirror is kept.
  - One guard, `runtime.record` (`engine/index.js::_recorded`). `SessionStore.appendPlain` refuses every non-resize packet when its info says `record: false` (`E_NOT_RECORDED`). The engine logs no resize after the first and keeps the last geometry in the info on exit. Extend relaunches at that geometry, unrecorded, on an empty screen.
  - `share.createLink`, `player.open` and `session.create {copyHistoryFrom}` answer `E_NOT_RECORDED`. `session.update` answers `E_INVALID` when `record` changes. `create {record: false, copyHistoryFrom}` answers `E_INVALID`. `E_INVALID` and `E_NOT_RECORDED` are new `CODES` (`engine/errors.js`).
  - Renderer, the minimum U1 drives: a "Record session" checkbox in the New and Copy dialogs, ticked by default (Copy takes it from its source), passed to `session.create`. Greying Copy history and Share is left to P2.
  - New tests: `test/engine-unrecorded.test.js`.
  - Planner decision on U1's control, recorded (`notes--context.md` *Soft changes*, plus a dated line under `goal_requirements.md` *Approval*).
- 2026-11-11 planner: approval lines written (user said "approved" in chat).
- 2026-11-10 planner: project files, review (Sonnet, fresh context, 15 rows, answered), P0 baseline (`../261110_ui-chrome/baseline.md`).

## Measured

P3, 2026-11-11, logs under `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261110_session-templates/p3_*.log`. Package: `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbst/out npm run package`, exit 0 (`p3_package2.log`; the packaged app booted in every kit script). Kit: `ZBUI_OUT=/tmp/claude-1000/zbst/out ZBUI_TMP=/tmp/zbst3 acceptance/run_all.sh` on host zr, 2 min 9 s, exit 0 (`p3_run_all.log`):

| check | before (P2) | after (P3) |
|---|---|---|
| R1, R3, R4, R5, R6, R7, U1, U4 | PASS | PASS |
| R2 | FAIL at Share's "Not recorded" title | PASS (with the new quiet-end assertion) |
| U2 | FAIL at the delete warning | PASS |
| U3 | FAIL at the takeover prompt | PASS |
| `test/renderer-static.test.js` | 34/34 | 34/34, 0 skips |
| `test/debug-server-share.test.js` | 1/1 | 1/1, 0 skips |
| `test/engine-unrecorded.test.js` | 5/5 | 5/5, 0 skips |
| `npm run lint` | exit 0, 95 warnings | exit 0, 95 warnings (`p3_lint.log`) |

P2, 2026-11-11, logs under `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261110_session-templates/p2_*.log`. Package: `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbst/out npm run package`, exit 0. Kit: `ZBUI_OUT=/tmp/claude-1000/zbst/out ZBUI_TMP=/tmp/zbst2 acceptance/<script>.sh`, one at a time, on this host. Before is P1's run of the same scripts (`p1_kit_p1_*.log`).

| check | before (P1) | after (P2, `p2_final_*.log`) |
|---|---|---|
| R1 | FAIL at "Share … disabled" | PASS |
| R3 | FAIL at the Advanced section | PASS |
| R4 | FAIL at the Advanced section | PASS |
| R5 | FAIL at the menu section | PASS |
| R7 | FAIL at the table grep | PASS |
| R6 | FAIL | PASS (`p2_final_R6_deleted_template.log`) |
| U1 | PASS | PASS |
| U4 | FAIL at the session count | PASS (`p2_kit_U4_new_hotkey_not_typed.log`) |
| R2 | FAIL at Share's "Not recorded" title | same line (P3) |
| U2 | FAIL | FAIL at the delete warning text (P3) |
| U3 | FAIL | FAIL at the takeover prompt (P3) |
| `test/renderer-static.test.js` | — | 34/34, 0 skips |
| `test/debug-server-share.test.js` | — | 1/1, 0 skips |
| `npm run lint` | — | exit 0, 95 warnings (`tail -1 p2_lint.log`) |

P1, 2026-11-11, logs under `~/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261110_session-templates/p1_*.log`. Each test file ran in its own process, with scratch HOME and TMPDIR. 0 skips in each.

| check | result |
|---|---|
| `test/engine-unrecorded.test.js` (new) | 5/5 tests, 121/121 asserts |
| `test/engine-session.test.js` | 10/10 |
| `test/engine-extend.test.js` | 9/9 |
| `test/store.test.js` | 18/18 |
| also run, all pass | backend-boundary 8/8, debug-server-share 1/1, engine-attach 9/9, engine-attach-seam 7/7, engine-client-pty 7/7, engine-delete-race 2/2, engine-store-lock 3/3, player 16/16, share-flood 4/4, share-manager 10/10, share-manager-seam 9/9, share-join-outcomes 7/7 |
| `npm run lint` | exit 0, 95 warnings (`tail -1 p1_lint.log`) |
| package | `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zbst/out npm run package`, exit 0 |
| U1 (packaged, `uisolate`) | PASS (`p1_U1.log`): log length 1 → 1 across the flood; control found by playback; marker files: none. The packaged app booted (start_app ready). |
| other kit scripts | All FAIL. Base is HEAD's files in a copy of the same package (`p1_kit_base_*.log`); P1 is `p1_kit_p1_*.log`. Same failing line in both for R3–R7 and U2–U4. R1 now passes the "Record session" checkbox line and stops at "Share … disabled" (P2). R2 now passes `record == false` and the flood echo and stops at the Share control's "Not recorded" title (P3). |

## Gotchas

- Tests need `ZXTERM_CORE_BIN=/zp/zdata/zeev/github/zbterm/npm/zxterm-core-linux-x64/zxterm-core`. The worktree has no staged sidecar (`npm/` is gitignored).
- The worktree needs its own `npm ci` (done for P1, about 1 min).
- Work lives on branch `session-templates`, worktree `.claude/worktrees/session-templates`. The main checkout has unrelated uncommitted release work; leave it alone.
- When an unrecorded session ends, the renderer opens playback for it (`renderer/app.js::openPlayback`). That now fails with `E_NOT_RECORDED` and shows an error. P3 owns the Playback enable logic and must not open playback for `record === false` entries.
- A recorded entry has no `record` key; only an unrecorded entry carries `record: false`. Read it as `entry.record !== false`.
- The debug server's `POST /sessions` does not pass `record`. The kits create unrecorded sessions through the dialog, or through `POST /invoke`.

- P2: the Share key wizard opened by "Share session now" stays open until Done. The kit's later steps rely on a real click on the terminal (`focus_terminal`) closing it through its overlay.
- P2: `state.templates` is a per-window cache for marks and titles only; every write reads its key first.
- P3: the debug server's renderer status is at `GET /renderer/layout` → `.renderer.app.status`. The renderer sees an engine error's message without its code ("session is not recorded").
- P3: a kit that answers an editor question must go through `dialog-submit`/`confirm-answer` (they wait for the editor's async checks); a bare `click` on OK returns before the question is up.

## Ids allocated

None. One `D-nn` is pending (design *Decisions*), to be taken at landing time from `docs/decisions.md`.

## User owes

None.

## Open

- `docs/CORE-CONTRACT.md` still lists `session.create` without `record` and `session.update` without its refusal. §2 does not name `E_NOT_RECORDED`/`E_INVALID`. These are additive and nothing there is false. For P4 to document with the ARCHITECTURE update.

## Soft changes to read back

Seven, dated 2026-11-11 (P3), in `notes--context.md` *Soft changes*:
- warning wording "for new sessions when you …";
- the questions are asked at the dialog's OK (the funnel asks only without a dialog);
- what "this profile will replace it" does;
- a template delete always asks, Shift too;
- a takeover of a hidden-copy trigger asks;
- the further "Not recorded" controls and the quiet end of an unrecorded session;
- the raised confirmation layer over the editor only.

Four, dated 2026-11-11 (P2), in `notes--context.md` *Soft changes*:
- the trigger table's order is the shown order, with exact-modifier matching;
- the `noTemplate` and `migrateFrom` table fields;
- skip-dialog templates share without the wizard;
- templates are stored as JSON text.

Five, dated 2026-11-11 (P1), in `notes--context.md` *Soft changes*:
- U1's control (planner decision);
- `pendingBytes` kept for unrecorded output;
- no resize logged after the first, with the geometry kept in the info;
- the two `E_INVALID` cases;
- the empty `archiveMirror` kept.
