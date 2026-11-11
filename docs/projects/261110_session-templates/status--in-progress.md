# Unrecorded sessions and new-session templates — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.
Rewritten in place after every phase; this is the memory between sessions, not a log.

## Now

in-progress, 2026-11-11: P1 (engine `record: false`) built on branch `session-templates`. The next phase is P2 (dialog and templates).

## Done

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

## Ids allocated

None. One `D-nn` is pending (design *Decisions*), to be taken at landing time from `docs/decisions.md`.

## User owes

None.

## Open

- `docs/CORE-CONTRACT.md` still lists `session.create` without `record` and `session.update` without its refusal. §2 does not name `E_NOT_RECORDED`/`E_INVALID`. These are additive and nothing there is false. For P4 to document with the ARCHITECTURE update.

## Soft changes to read back

Five, dated 2026-11-11 (P1), in `notes--context.md` *Soft changes*:
- U1's control (planner decision);
- `pendingBytes` kept for unrecorded output;
- no resize logged after the first, with the geometry kept in the info;
- the two `E_INVALID` cases;
- the empty `archiveMirror` kept.
