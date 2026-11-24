# Improvements and fixes — design (one page)

**Serves:** `goal_requirements.md` R1–R16, U1–U5 · **Written:** 2026-11-21 · **Reviewed:** 2026-11-21, Sonnet (fresh context) · **Approved:** see end.

## Interface

No new commands, flags or launch surfaces. Changed surfaces, all in the renderer unless named:

| row | where | what |
|---|---|---|
| R1/U1 | `electron/main.js::createWindow` `close`, `::confirmExternalClose`, `::noteSystemEnding` | outside close of the last window with live host sessions → native box Cancel/Close + "Don't ask again" (writes `zbterm.confirmClose = '0'`); settings check "Ask before closing with running sessions" |
| R2 | `renderer/app.js::buildSessionRow` (`options.nameMatch`) | the name's matching runs wrapped in `<mark class="name-match">`, CSS `color: var(--match-cyan)`, no background |
| R3/U2 | the document capture `keydown` in `renderer/app.js::bindEvents` | Esc, no modifiers, `searchIsOn()`, focus not in the box, no dialog (`sidePaneBlocked`) and no menu open → `clearSearch()`, event swallowed |
| R4 | `renderer/app.js::updateSearchCount` | writes `N/M (In terminal Enter/Shift+Enter, in profiles ⬆️/⬇️ )` with `setStatus`; `#searchCount` stays hidden; clearing the query clears that status text only if it is still ours |
| R5/R7 | `::templateMenuItems`, `::stunTurnMenuItem`, `::relayKeyMenuItem` | `icon:` `fa-stamp` / `fa-tower-broadcast` / `fa-server` (the menu's existing iconic item) |
| R6 | `::showSessionEditor` | Advanced opens when `mode` is `edit` or `template` and a trigger is chosen |
| R8 | `::anchorPanel` | first `place()` as today; later panel resizes keep `top` and only clamp it so the bottom stays inside the window; a window resize places afresh |
| R9 | `renderer/index.html` `#extendSession`, `#extendSessionHidden`, status texts, README | "Extend" → "Resume" in every visible string; ids and RPC (`session.extend`) unchanged |
| R10–R12/U3/U4 | `::profileMenuItems(session)` (new), `::openSessionMenu` | the row's right-click selects the row (`extend: false`) and opens the menu built from state; separators are `{ separator: true }` items |
| R12 | `engine/share-manager.js::status` | adds `liveLinks`: unrevoked links in `share.links` (additive field; `isSharing` unchanged; dated in `docs/CORE-CONTRACT.md` `session.list`) |
| R14 | `renderer/app.js::updateSearchCount`, `index.html` `.search-pos-*` | the status line is built as `<span.search-pos-index>M</span> / <span.search-pos-total>N</span> hint`; its text is still `M / N hint`, so ownership (`state.searchCountStatus`) compares as before |
| R15/U5 | `#searchCase`, `#searchWord` in `.search-cell`; `::searchOptions`, `::toggleSearchOption`; `engine/buffer-search.js` (`caseSensitive`, `wholeWord`, `findInText`, both copies); `engine/catalog.js::list`; `engine/index.js::searchBuffer` | a toggle re-runs the three searches with the same text; `session.list` and `session.searchBuffer` take the two flags (additive, dated in `docs/CORE-CONTRACT.md`); with neither flag the name filter is the old `includes` |
| R16 | `electron/main.js` whenReady; `renderer/app.js::init`, `::renderSessionsLoading` | `startPearRuntime()` before `loadAppWindow`; the first list read in `Promise.all` with `loadShareBackends` and `refreshPeerIdentities`; `state.sessionsLoaded` false → "Loading profiles…"; `ui-state.startup.marks` times each step |

Profile menu, top to bottom (icon · label · action · enabled when):

```
fa-clone            Clone                          copySessionProfile(shift)   not pending/joined
fa-copy             Create a copy, edit first      copySessionProfile          not pending/joined
───
fa-pen              Edit                           editSessionProfile          not pending
fa-eraser           Remove HD                      removeHd                    offline, has HD
fa-clock-rotate-left Delete History                clearCaches                 not pending/joined
fa-trash            Delete                         deleteSession               always
───
fa-share-nodes      Share Session | Unshare Session  shareSession | unshareSession   own, live, recorded, sharing available
fa-keyboard         Share Keyboard | Unshare Keyboard toggleInputMode          same
fa-rocket           Enable HD (save and share more updates) | Disable HD (save and share fewer updates)  toggleHd   own, live
───
fa-arrow-rotate-right Resume                       extendSession               canExtendSession
```

`unshareSession`: confirm ("Stop sharing <name>? Its invite links stop working and viewers are
disconnected; the session keeps running."), then `share.listLinks` → `share.revokeLink` for every
unrevoked link, then `refreshSessions`.

## Data and state

- `zbterm.confirmClose` in the app preferences file (main process reads, renderer writes).
- No other stored state. `liveLinks` is computed per `session.list`.
- Debug state (`ui-state`) gains `sessionMenu`: the open profile menu's rows, in the settings menu's
  shape (`kind, label, disabled, icon, rect`); the dialog's place is read with `style-of`.

## Refuses

- A disabled menu item does nothing on click (U3); Unshare on a session with no live link is
  disabled-free but a no-op (label is "Share Session" then).
- Esc with no search text goes to the terminal untouched (U2).

## The reference program, step by step

The user, on the packaged 1.9.2: types `tmp` in search → name rows show `tmp` in cyan (R2), the
status reads `1/3 (In terminal …)` (R4); clicks a row, presses Esc in the terminal → search ends
(R3); right-clicks a live profile → the menu above (R10); Clone → a second profile appears with no
dialog (R11); Share Session → wizard → link; right-click again → "Unshare Session" → confirm →
links revoked, session still live (R12/U4); opens settings → stamp items → dialog with Advanced
open (R5/R6); in a profile dialog, SSH + Change Remote Directory → Browse → types a filter → the
dialog's top edge does not move (R8); offline profile → "Resume" button (R9).

## Failure scenarios

Written by a reviewer in a fresh context (Sonnet, 2026-11-21) from `goal_requirements.md` and this
page only; the last column is the planner's answer.

| # | scenario | at risk | answer |
|---|---|---|---|
| 1 | vim in insert mode while the box still holds text: the first Esc ends the search and is swallowed | U2, R3 | Accepted as asked (A-3): only while the box holds text; `R2_search_keys.sh` proves the Esc is not passed on, and that with no search it is |
| 2 | another `setStatus` (copy, share) overwrites N/M while the search is on | R4 | Accepted: the count is rewritten on every step and scan; clearing only removes it while the line still holds it (`state.searchCountStatus`). The line's tooltip holds the whole text (a narrow cell cuts the hint) |
| 3 | the profile goes away while its menu is open; a click acts on a stale object | R10, U3 | `runSessionMenuAction` re-resolves the id and says "that profile is gone"; labels come from the row selected when the menu opened |
| 4 | one `share.revokeLink` throws mid-way | R12, U4 | each link in its own try/catch; the list is refreshed in `finally`; the status names revoked and failed counts; the label follows `liveLinks`, so Unshare stays offered |
| 5 | window shrunk, or the list grows near the bottom: the kept top leaves the dialog off-screen | R8 | later resizes clamp `top` into the window (`clampY`); a window resize places afresh; `R8_dialog_steady.sh` asserts the dialog inside the window at every step. A dialog taller than the window stays clamped at 8 px (as before) |
| 6 | Esc with a menu, a dialog, a `<select>` or an IME composition open | R3, U2 | the Esc branch needs `!isComposing`, `!sidePaneBlocked()` (dialogs, picker) and `!anyMenuOpen()` (all four menus); a native `<select>` keeps its own Esc (it lives in a dialog) |
| 7 | logout/shutdown while the close box is up, or joined-only sessions | R1, U1 | main counts own live sessions only (`!isJoined`); `powerMonitor` `shutdown` and Windows `query-session-end` set `systemEnding`: no question, and a question already up is answered Close; main writes `zbterm.confirmClose` itself. Not exercisable on this host without a real logind shutdown (said in the report) |
| 8 | Clone clicked twice, or fails silently | R11 | `state.cloning` lets one run at a time; the status says "cloning …"; errors go through `showError` |
| 9 | an engine without `liveLinks` hides Unshare | R12, U3 | `sessionSharedNow`: no `liveLinks` → shared while `isSharing` (Unshare offered) |
| 10 | "Extend" survives in a tooltip or label, or "Resume" means two things | R9 | the toolbar button, the hidden button, the status text and README renamed; the other "resume" (the ^R hint) is the same action; `test/renderer-static.test.js` refuses a visible "Extend" in the page |

## Questions and assumptions

- A-1 Unshare revokes links rather than adding an engine "stop share" RPC: revoke already disconnects
  and rekeys on both backends and is tested; a new RPC would touch the Freenet core path.
- A-2 Right-click selects the profile first, so every label reflects that session's live state
  (`state.hd`, input mode); the old menu selected it on the click of an item anyway.
- A-3 R3 swallows Esc only while the box holds text; full-screen programs get Esc again once the
  search has ended.
- A-4 The two "Delete" entries of the row's trash button menu stay as they are; only the right-click
  menu changes.

Added 2026-11-21 for R14–R16 (planner; no fresh reviewer, the user's instruction to proceed):

| # | scenario | at risk | answer |
|---|---|---|---|
| 11 | a toggle's click blurs the empty box and ends search mode before it lands | U5 | mousedown's default is cancelled, as the x does; the kit clicks for real and checks focus and text |
| 12 | the engine is ready before the page asks, so `pear:ready` is missed | R16 | the renderer reads `profile.current` after it listens and goes on when `engineReady`; a start error still reaches it through `profile.current` (not ready, not starting → the picker) |
| 13 | the first list read fails at startup, leaving "Loading profiles…" | R16 | as before an error goes to `showError`; the next `session:list-changed` refresh draws the list |
| 14 | whole word on a query that starts or ends with punctuation never matches | R15 | only the query's word-character ends are checked (`"-x"` matches in `a-x`), a unit test pins it |

## Decisions

None hard to reverse.

## Approval

See `goal_requirements.md` *Approval*: built on the user's instruction of 2026-11-21 to proceed without
stopping; read back before "done".
