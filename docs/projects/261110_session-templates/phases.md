# Unrecorded sessions and new-session templates — phases (the HOW)

A builder's brief is: `/ubitron/dev/docs/templates/rules.md`, **one** phase section below,
`goal_requirements.md`, `../261110_ui-chrome/baseline.md`, and the status file. Paths, not pasted bodies.

## Conventions

Same as `../261110_ui-chrome/phases.md` *Conventions* and *Host* (the commands, logs, sidecar, packaged build and `uisolate`), except:
- Logs go under `runs/261110_session-templates/`.
- The kit sources `../261110_ui-chrome/acceptance/lib.sh`.
- `D-tbd` takes the next free id in `docs/decisions.md` at landing time. That is zbterm's own rule; the file is gitignored and local.

## Order

```
P1  engine: record:false, E_NOT_RECORDED, single store guard   needs: sibling P1 (kit harness)
P2  dialog: Record checkbox, Advanced, trigger table, templates, migration   needs: P1, sibling P2 (menu kinds)
P3  deleted templates, warnings, takeover, Ctrl+Shift+T         needs: P2
P4  kit at HEAD, packaged boot, docs, D-nn, status               needs: all
```

## Phase P1: engine `record: false`

**Goal.** Unrecorded sessions in the engine.
**Covers.** R2 (engine side), U1; D-tbd.
**Code map.**
- `engine/index.js`:
  - `createSession` (~337): `launchOptions` (~2900), the `_registerCreatedSession` entry;
  - `_recordLiveData` (~1650), `_flushPacketBuffer` (~1688), `_maybeSnapshot`;
  - resize and restore (~1074–1110, ~1212: `archiveMirror`, `_maybeSnapshot(…, true)`, `buildArchiveMirror`);
  - `extendSession`, `updateSession`, `openPlayer`, `_planHistoryCopy`.
- `engine/session-store.js`: `create` (~73), `appendPlain` (~765), `appendData` (~734). The store refuses data when `info.record === false`.
- `engine/share-manager.js::createLink`.
- `engine/errors.js::CODES`.
- Tests: `test/engine-session.test.js` and `test/engine-extend.test.js`. Copy their create, close and extend pattern.

**Acceptance.** New brittle tests pass:
- a marker is in no file under the test root after print, resize, flood, extend and close;
- the log holds no data packets;
- share, player and copy refuse; update refuses `record`;
- a 5 MB flood finishes.

Also `test/engine-session.test.js`, `test/engine-extend.test.js` and `test/store.test.js` pass, and `U1_*.sh` is green after packaging.

**Gotchas.** `appendBacklog`/`pendingBytes` must not grow on skipped paths, or the PTY stalls (review row 1).

## Phase P2: dialog and templates

**Goal.** R1, R3, R4, R5, R7.
**Code map.**
- `renderer/app.js`:
  - `showSessionEditor` (~2300), `newSessionProfile` (~2183), `copySessionProfile` (~2207), `uniqueSessionName`, `createSessionFromEditor`;
  - `setDefaultSession` and `DEFAULT_SESSION_PREFERENCE` (~1480–1515; migrate);
  - the `newSession` click (~1100);
  - `settingsMenuItems` (the sibling's `kind` items).
- `renderer/index.html`: CSS for `.session-editor details`, `select`, and the disabled checkboxes.

**Acceptance.** R1, R3, R4, R5 and R7 are green; lint passes.

**Gotchas.** A Shift-click must match only `shiftNew` (exact modifiers). A rename must refresh `copy`.

## Phase P3: deleted templates, warnings, hotkey

**Goal.** R6, U2, U3, U4, and the unrecorded UI marks (R2).
**Code map.**
- `renderer/app.js`:
  - `deleteSession` (~3031);
  - the rename flow (grep `session.rename`);
  - the capture `keydown` (~1175) and xterm's `attachCustomKeyEventHandler` (from the sibling's P3);
  - the share, playback and extend buttons' enable logic (grep `shareSession.disabled`).

**Acceptance.** R2, R6, U2, U3 and U4 are green.

## Phase P4: close

**Steps.**
1. Repackage, then run `acceptance/run_all.sh` at HEAD.
2. Run the test files one by one, then `npm run lint`.
3. Update the README (unrecorded sessions, templates, Ctrl+Shift+T) and `docs/ARCHITECTURE.md` (the unrecorded mode).
4. Write the `D-nn` row.
5. Rename the status file to `status--verifying.md`.

## Do not

- Never lower a tolerance, weaken an assertion or re-bless a count to get green.
- No new dependencies.
- Do not change the share protocol or the store format beyond the `record` flag in `info`.
- Do not touch the main checkout's working tree.
