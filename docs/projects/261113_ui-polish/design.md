# UI polish: timeline, search, menus, size lock — design

**Written 2026-11-13, after the build** (commit 13aff57): the builder went from the approved goal page
straight to the kit (48516dd) and the code; this page records the design as built so the folder follows
`howto.md`. It changes nothing that was built. The goal page's approval line covers the rows; the
decisions behind them (Q-1–Q-11) are in `notes--context.md` *Decisions*. This page is read back to the
user with the soft changes before "done".

## Shape

Renderer only: `renderer/app.js`, `renderer/index.html`, `renderer/wall-clock.js`. `engine/` and
`electron/` untouched; no new dependency, no new engine method, no new preference key in the engine
(the size lock uses the existing `preference.get`/`set`).

| row | where | how |
|---|---|---|
| R1 | `syncUnrecordedDuration()`, `#sessionDuration` | `#playback.unrecorded` hides every control; one label at the cell's right end. Live: a 1 s ticker, `now − startedAt`. Ended: `endedAt − startedAt`, frozen (the time `session:exit` arrived when the catalog has no `endedAt` yet). Formatted by `formatDuration` (R5). |
| R2 | `.search-cell` | `fa-magnifying-glass` at the far right, `#searchCount` moved left of it (padding grows); a click on the icon focuses the box. |
| R3 | `renderUnmatchedSessionSection()` | `state.unfilteredSessions` (one extra `session.list` without `query` while the box holds text) minus current, name and buffer matches; heading "Other - unmatched sessions", rows `.unmatched` (opacity 0.5, full on hover). A late buffer match moves its row up. Debug state: section key `other`. |
| R4 | `setScrubberTip()` | two spans, `.scrubber-tip-clock` and `.scrubber-tip-elapsed`, stacked and centred; text unchanged from the one-line form. |
| R5 | `wall-clock.js::formatDuration` | moved out of `app.js` so it is unit-tested; ≥ 24 h → `Nd h:mm:ss`, hours unpadded. Clock times untouched. |
| R6, U1 | `editNewSessionTemplate()`, `resolveTemplate()` | template mode no longer locks the box; the stored copy's `record` wins over the live session's; note "Applies to new sessions". `session.update` never carries `record` (engine refuses it anyway). |
| R7 | `.session-editor-advanced-body` | the `<details>` controls in a body `div` of their own (grid, 8 px gap, indent, top space): `::details-content` had swallowed the grid gap. |
| R8, R9 | `settingsMenuItems()` | groups joined by one separator: checks; CTRL pair; templates; (collapsed) identity + theme; STUN/TURN; version. |
| R10 | `collapsedPaneItems()`, `renderSettingsMenuItem()` | `item.icon` read from the toolbar button's `<i>`; label = the button's `title`; `data-identity` on the icon span, so the dot sits on the icon. |
| R11 | `#sizeLock`, `#sizeLockMenu`, `sizeLockMenuItems()` | top bar beside the Font buttons, shown by the same rule (`canAdjustSessionFont`). Menu as drawn; rows x cols; tick on the chosen line. |
| R12 | `fitLockedTerminal()` first in `fitAndResize()` | locked: grid fixed, font from `fontSizeForGrid()`, letterboxed; Font −/+ and CTRL −/+ (font mode) refused with "Terminal size is locked". Locks per session id in the profile preference `zbterm.sizeLocks`, so they survive restart and Extend. |
| R13 | `noteSessionRowOrder()`, `armSessionReorderGuard()` | after each `renderSessions()`, each row's place among the list's items is compared with the last render (`sessionRowPositions()`); a row present in both at another place arms the guard: `.reorder-guard` (rows `pointer-events: none`, list `cursor: not-allowed`) for 500 ms after the last change. Rows only added or dropped, and headings whose text changes, do not (F5). |
| U2 | `canResizeSelectedLiveSession()` | the lock button follows the Font buttons: hidden for joined, ended and scrolled-back views; `activeSizeLock()` is null there, so nothing locked is ever sent for them. |

## Interface the kit reads

`POST /renderer/command` (debug server only): `search-state` (the `other` section, heading styles,
`guard` = the R13 guard), `ui-state` (`menu` = the settings menu's items with `icon` and `separator`
kinds), `size-lock-state`, `duration-format {ms}`, `bubble-format`, plus the existing `style-of`,
`playback-state`, `time-labels`.

## Kit corrections to earlier kits

`261110_ui-chrome/R2_bubble_clock.sh` (two-line bubble), `261111_buffer-search/R3, R5, R10, R11`
(the new `other` section; R13's 500 ms guard before clicking a row). Each carries a dated
`# Kit correction 2026-11-13 (builder)` comment (commit 03c396e).

## Q/A

- *Why a profile preference, not the engine catalog, for the lock?* Q-8 decided renderer only; the
  engine already keeps the font size, and the lock only constrains what the renderer asks for.
- *Why compare row places, not a MutationObserver, for R13?* `renderSessions()` rebuilds the list on
  every refresh; every rebuild would look like a change. Row places say whether anything moved.

## Failure scenarios (reviewer)

Written 2026-11-13 by a reviewer (a different model, fresh context, `goal_requirements.md` and this
page only, allowed to grep `renderer/`). The *answer* column is the planner's, checked in the code.

| id | row | scenario | answer |
|---|---|---|---|
| F1 | R1 | Ended unrecorded session after a restart: no `endedAt`, the label reads "0:00". | No change: the engine writes `endedAt` on exit (`engine/index.js` ~1956) and marks sessions left active at a restart ended with `endedAt` (`engine/catalog.js:29`); `state.unrecordedEnded` only covers the moments before the list refreshes. Check: `R1_unrecorded.sh` (ended, frozen). |
| F2 | R12 | A small window with a 32 x 120 lock: a font floor clips the grid. | No change: `fontSizeForGrid` clamps at 5 px, not 8, and the grid is set by `term.resize(cols, rows)` whatever the font; letterboxed. Check: `R12_lock_holds.sh` (window resizes, rows x cols unchanged). |
| F3 | R12 | Restart: the first fit runs before `loadSizeLocks()` resolves and resizes the PTY. | No change: `boot()` awaits `loadSessionListPreferences()` (which loads the locks) before it asks for the sessions (`renderer/app.js` ~555). Check: `R12_lock_holds.sh` (restart). |
| F4 | R13 | A row activated from the keyboard during the guard. | No change: session rows are plain `div`s with no `tabindex` and no key handler (`buildSessionRow`); they cannot take focus. |
| F5 | R13 | A heading or note whose text changes ("searching…" → "No matches in live sessions") counts as a move and re-arms the guard though no row moved. | **Design change**, 2026-11-13: the guard compares each row's place among the list's items before and after (`sessionRowPositions()`); a heading's text no longer counts, a heading inserted above a row still does. Check: `R13_reorder_guard.sh`. |
| F6 | R3 | A session created or ended after the unfiltered fetch is missing from "Other". | No change: `refreshSessions()` fetches both lists on every `session:list-changed`. Check: `R3_unmatched.sh`. |
| F7 | U2 | Lock, scroll back or join, return: the host is resized where U2 forbids. | No change: `activeSizeLock()` and `session.resize` both require `canResizeSelectedLiveSession()` (own, live, not joined, not playback). Check: `U2_lock.sh`. |
| F8 | R6, U1 | The stored copy lacks `record` and the live value is used; `record` leaks into `session.update`. | No change: Q-6 decided the editor opens with the session's own setting when the template has none yet; `session.update` is built without `record`. Check: `U1_record.sh`. |
