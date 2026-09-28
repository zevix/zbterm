# Session UI fixes and enhancements: plan

Two phases, run one after the other because both touch `renderer/app.js` and
`renderer/index.html`. Each phase is implemented by one agent and then checked by
a separate verification agent.

## Ground rules (all agents)

- The working tree has uncommitted work from earlier tasks. Do not commit,
  stash, reset or revert anything. Leave all changes in the working tree.
- Never `pkill`/`killall` Electron or ZBTerm broadly. The user runs this
  session inside ZBTerm. If you launch a test instance (see
  `docs/debug_server_howto.md`), give it a unique storage path and kill only that
  process, by that path.
- Never open a GUI on the user's display. Run every Electron/ZBTerm instance
  on a private display with uisolate:
  `PYTHONPATH=/ubitron/dev python3 -m ubitron.envs.uisolate run -t 60 -- <cmd>`
  (or `start --name X` / `run --name X -- <cmd>` / `screenshot X out.png` /
  `stop X`).
- Match the surrounding code style: vanilla JS in `renderer/app.js`, CSS inside
  `renderer/index.html`, short comments explaining _why_.
- Engine RPC changes go through `engine/index.js` `invoke()`, and must be
  reflected in `docs/CORE-CONTRACT.md` (checked by
  `test/core-contract.test.js`) and `engine/rpc/schema.js` if it validates the
  method.
- Per-profile settings use the engine `preference.get` / `preference.set` RPC
  (stored in the profile's `preferences.json`). App-wide settings use
  `app.preference.*` (electron/main.js).
- Finish with `npx prettier --write` on the touched files, `npm run lint` (0
  errors; pre-existing warnings OK) and `npm test` (all passing). Add brittle
  tests for engine-side logic you add.

---

## Phase 1: bugs and standalone enhancements

### B1. Startup log text breaks one or two characters per line

The startup screen (logo, see `devLogoText()` and the startup-logo sizing near
`fontSizeForGrid` / `sizeTerminalToGrid` in `renderer/app.js`) prints status
lines such as `[1:20:47 PM] checking selected profile`. Some lines wrap every 2
characters, because they were written while the terminal grid was tiny, before
it was sized or fitted. Later lines render fine. Find the root cause (status
written before the terminal is sized, or a reflow at a transient width) and
fix it so every startup line renders on one row. A fix could be buffering status
lines until the grid is sized, or sizing before the first write. Don't just
hide the symptom by removing the lines.

### B2. Extending a session starts it at a default size

`extendSession()` in `renderer/app.js` passes `dimensions()` (the current
viewport/playback grid) to `session.extend`. It should revive the session with
the font size and grid (cols/rows) the session last had. Find where the live
font size (`state.liveFontSize`, `setTerminalFontSize`, the zoom handlers) and
the recorded grid (last frame / `info.cols`/`rows`, `session.resize`) live.
Make extend reuse the session's last recorded cols/rows and its last live font
size. If the font size isn't persisted per session today, persist it (for
example in session info/catalog via the engine, or per-session preference) so
it survives a restart. Cover the engine side with a test (see
`test/engine-session.test.js` 'engine extends a recorded local session').

### E1. Remember the session-pane (sidebar) width per profile

Today the width is stored under `zbterm.sidebarWidth` in localStorage plus
`app.preference.*` (app-wide) (`persistSidebarWidth`, `restoreSidebarWidth`,
`wireSidebarResizer`). Make it per profile: store and load it with the engine
`preference.*` RPC. Apply it once the profile's engine is ready, and again on
profile switch. Keep the app-wide/localStorage value only as the first-paint
fallback.

### E2. Remove the top menu bar (ZBTerm / View)

`installAppMenu()` in `electron/main.js` builds the menu for non-macOS. Remove
the visible menu bar on Linux and Windows. It must not come back on Alt either
(use `Menu.setApplicationMenu(null)` / `win.removeMenu()` / `autoHideMenuBar`
as appropriate). Keep the keyboard shortcuts working: Ctrl+Q quits through
`requestAppQuit`, and Ctrl+Shift+I toggles DevTools, for example via
`webContents.on('before-input-event')`. Don't bind Ctrl+R: it is shell
reverse-search. Leave macOS behaviour unchanged.

### E4b. Delete confirmation aligned to the Delete button

The session row's Delete action (`openSessionDeleteMenu` → `deleteSession` →
`askConfirm`) and the History menu's "Delete History" confirmation currently
open centred. Let `askConfirm` (and `deleteSession`/`clearCaches`) take an
anchor. Anchor the dialog under the row's delete button with
`anchorModal(overlay, panel, anchor, 'left')`, like the Join/Identity wizards.
Stay centred when there is no visible anchor.

---

## Phase 2: session editor features

All of these live around `renderSessionActions`, `openSessionDeleteMenu`,
`editSessionProfile`, `newSessionProfile`, `copySessionProfile`,
`showSessionEditor`, `createSession`, `showShareWizard` in `renderer/app.js`.

### E3. Default session for new sessions

- Add a checkbox to the **Edit** dialog only: "Default for new sessions (hold
  SHIFT on New)". Hide it for joined and pending sessions, which can't be
  copied.
- It is checked when this session is the current default. Checking it and
  saving makes this session the default and replaces any previous one.
  Unchecking the current default and saving clears the default, which gives
  today's behaviour.
- Store it per profile with `preference.set` (key such as
  `zbterm.defaultSessionId`). A default pointing to a deleted session is
  treated as no default, and deleting the default session clears it.
- In the session list, show a check icon (`fa-check`) right after the default
  session's name.

### E4. Unique names in New and Copy

The New and Copy dialogs prefill a name that is unique among existing sessions.
New already gets `session.defaultName` (`… #N`). For Copy, strip a trailing
` #N` from the source name, then use `${base} #${n}` with n = the next number
after the highest existing `base #N`. A bare `base` counts as 1, so the first
copy of "foo" is "foo #2". Put this in one helper, shared by the dialogs and the
SHIFT shortcuts below. It only prefills; the user can still type any name.

### E5. SHIFT alternatives (check `event.shiftKey` on click)

- **New**: SHIFT skips the dialog and creates a copy of the default session
  (its cwd/command, E4 unique name from its name). With no default, it creates a
  plain default-shell session with the auto-name. Tooltip: "New session (hold
  SHIFT to skip dialog and copy from <default name>)", or "… from default shell"
  when there is no default. Keep the tooltip updated when the default or its name
  changes.
- **Copy** (row action): SHIFT skips the dialog and creates the copy with the E4
  unique name and the same cwd/command, without copying history. Tooltip: "Copy
  (hold SHIFT to skip dialog)".
- **Delete** (row action): SHIFT skips the menu and opens the delete
  confirmation directly, anchored per E4b. Tooltip: "Delete (hold SHIFT to
  delete session)".
- In the delete menu, rename the "Delete" item to **"Delete session"** with the
  tooltip "Hold SHIFT to skip confirmation". SHIFT+click on it deletes without
  confirmation. Menu items need a `title` and access to the click event.

### E6. "Copy history" checkbox (Copy dialog only)

A checkbox, always off by default, shown only in the Copy dialog. When
checked, the new session starts with a copy of the source session's recorded
history (log + timeline) before its shell starts, so playback shows the old
output followed by the new shell. This needs engine support, for example a
`copyHistoryFrom: sessionId` arg on `session.create` that copies the source
store's entries and timeline into the new session's store under the store lock
(`_withStoreLock`). Update `docs/CORE-CONTRACT.md`, `engine/rpc/schema.js` and
add a test. Investigate `engine/session-store.js` first. If a faithful copy is
not feasible, report back instead of faking it.

### E7. "Share session now" in New/Copy dialogs

- Add a bottom checkbox "Share session now" to the New and Copy dialogs.
- Checking it expands the dialog with the Share wizard's option contents,
  without the Share wizard's buttons. Refactor `showShareWizard` so its option
  form is a reusable builder instead of duplicating it.
- After the session is created, share it right away with those options,
  running the same code path the Share wizard uses once confirmed. Show the
  resulting link/invite the same way Share does.
- The SHIFT shortcuts from E5 never share.
- The dialog stays anchored and re-places itself as it grows (`anchorPanel`
  already observes size).

---

## Verification (separate agent after each phase)

- Review the diff for the phase against this plan, item by item. Report every
  item as done / partial / missing, with file:line evidence.
- Look for regressions: other callers of changed functions (`askConfirm`,
  `showSessionEditor`, `showShareWizard`, `createSession`, `installAppMenu`),
  error paths, joined/pending sessions, no-profile startup.
- Run `npm run lint` and `npm test`.
- Where practical, run the app under uisolate with a unique storage path (per
  `docs/debug_server_howto.md`), take screenshots to check the behaviour, and
  stop only that uisolate session.
- Fix clear, small defects directly. Report anything larger rather than
  rewriting.
