# UI polish: timeline, search, menus, size lock — notes and context

Companion to `goal_requirements.md`: the user's words, where each row lands in the code, and
the questions the request leaves open. Not a spec; nothing here is approved or built from.

## The user's words

**2026-11-13, the request** (relayed by the orchestrator; verbatim, typos kept):

> When session is not recorded - do not show the timeline controls - just session duration on the bottom left
> Add magnifying glass on right of search box
> In search results show unmatched sessions with opacity on the bottom, below "Other - unmatched sessions" small text heading
>
> The time slider tooltip change to two lines - clock time, below it the times since session start, both middle centered
> In all the time displays (except clock time) if more than 24 hours, sow "Nd h:m:ss" like 54:32:10 should be 2d 6:32:10
>
> When opening the profile editor via "Edit new profile defaults *" settings menu, allow editing the "Record session" checkbox
> In the profile editor fix the spacing under advanced - it almost have none - take a screenshot and look
> Fix the settings menu:
>     Move "STUN/TURN servers..." to the end, separator below and above
>     Assure we have separators above and below the two "... with CTRL -/+"
>     When the side pane is hidden, identity and theme should look like "<icon> text" having the same icon they have on the toolbar (the green/orange dot of the profile should be on the icon and not on the right end) and the text of the tooltip of the original buttons according to their state
> Add "lock terminal size" lock button that opens a menu:
>     <open lock icon> Unlocked - set by terminal and font sizes
>     ----
>     <close lock icon> Current size: 37 x 124
>     ----
>     <close lock icon> 32 x 120
>     <close lock icon> 25 x 80

Read by the planner (2026-11-13): "sow" is "show"; "Nd h:m:ss" with the example "2d 6:32:10" means minutes and seconds padded to two digits, hours not. "Edit new profile defaults *" means all three items of that name (`NEW_SESSION_TRIGGERS[].menuLabel`). "with opacity" means dimmed. "----" lines are menu separators.

## Context

- One project, not split: the goal page is 397 words (`sed -n '/^## Goal/,/^## Approval/p' goal_requirements.md | wc -w`), under the 400-word cap the earlier projects used.
- `docs/projects/README.md`, `docs/register.md` and `docs/decisions.md`, which AGENTS.md names, are not in this repository (removed in b9a1c7b "rm projects", 2026-10-26). This folder follows the layout of the four `2611xx_` projects (`goal_requirements.md`, `notes--context.md`, `status--<state>.md`; `design.md`, `baseline.md`, `phases.md` and `acceptance/` come at planning). No ledger row was added.
- Every row lands in `renderer/app.js` and `renderer/index.html` (Electron `^40`, Chromium 144); none needs `electron/`. Line numbers below are at 820495d and drift.
- The kit, when written, goes into `docs/acceptance/index.json` (a new kit short name, its scripts in topics; the self-check fails until then, `docs/acceptance/README.md`).

## Requirement notes

- **R1** Today `updateTransportControls()` (`app.js` ~5135) keeps `#playback` (`index.html` ~2475: `#stepBack`, `#playPause`, `#stepForward`, `#collapseGaps`, `.scrubber-wrap`, `#timeLabel`, `#speed`) shown for an unrecorded session and only disables the play button and scrubber with the title "Not recorded" (`isUnrecordedSession()` ~5347). Wanted: those controls hidden and only the duration shown (`#totalTime`, or a new element), formatted by `formatDuration()` (R5). Live: `updateLiveClock()` ticks it. Ended: `showUnrecordedEnded()` (~3847); the catalog entry has `startedAt` and `endedAt` (`engine/index.js`, `engine/catalog.js`). Placement: Q-1. `261110_session-templates` R2's kit accepts `hidden` for those controls already.
- **R2** `#search` sits in `.search-cell` (`index.html` ~2470, CSS ~1285–1335) with `#searchCount` ("3/17") absolutely placed at the input's right end (`right: 10px`, input `padding-right: 64px`). The icon (`fa-magnifying-glass`, in the vendored Font Awesome) shares that end: Q-2. The narrow layout restyles `.search-cell` (~2284).
- **R3** `renderSessions()` (~2605) draws "Current session", "Session name matches" (the name filter is the engine's `session.list {query}`, `refreshSessions()` ~1604), then `renderSessionBufferSection()` (~8800, "Session buffer matches"). The unmatched rows are not in `state.sessions` while the box holds text, so they need an unfiltered list (as `uniqueSessionName()` and `runSessionBufferSearch()` already ask `session.list` without `query`). Heading: `sessionSectionTitle()` (`.session-section-title`). The kit reads sections through `debugSearchState` (~10145; the `headings` map ~10010: "Current session" → current, …); a new section key (proposed `other`) is needed. `261111_buffer-search` R3/R5/R10/R11 assert the list's sections and "No matching sessions"; their kits may need dated *Kit corrections*. Which sessions count: Q-3.
- **R4** The bubble is `#scrubberTip` (`index.html` ~2489, CSS `.scrubber-tip` ~1410: `white-space: nowrap`, one line). Its text comes from `scrubberTipTextForTs()` (~7162: `"14:32:05 · 0:42"`, collapsed `"14:32:05 · 0:42 (1:05)"`), set by `updateTimeLabels()` (~7080) and `handleScrubberHover()`; the clock is `renderer/wall-clock.js::formatWallClock`. Two lines, both centred (`text-align: center`, the bubble still centred on the playhead by `translateX(-50%)`). `261110_ui-chrome` R2's kit parses the one-line text; it needs a dated *Kit correction*. Compressed mode: Q-4.
- **R5** All durations go through one function, `formatDuration()` (~9506, `h:mm:ss` / `m:ss`): `#currentTime`, `#totalTime`, the bubble's elapsed part, and the "Uncompressed: … / …" tip (`setTimeLabelTipText()`). Clock times (`formatWallClock`, `formatTime()` in the session rows) are not durations and stay. Proposed: `formatDuration` alone changes; a unit test beside `test/wall-clock.test.js` (it is inside `app.js`'s closure today, so it may move to a small module like `wall-clock.js`). Details: Q-5.
- **R6** The menu items come from `templateMenuItems()` (~2100) → `editNewSessionTemplate()` (~2063) → `showSessionEditor(…, { mode: 'template', recordLocked: !!live })` (~2966). In template mode the checkbox is there (`addCheck('Record session', …)` ~3012) but disabled with the title "Fixed when the session was created" whenever the template is backed by a session that still exists (`resolveTemplate()` ~1832 `live`). Two places to change: drop `recordLocked` for the template editor, and stop `resolveTemplate()` overriding the stored copy's `record` with the live session's (`record: live.record !== false`), or the saved choice (`saveTemplateChoice()` → `templateCopy()`, which already writes `record`) is lost on the next read. Which value wins: Q-6.
- **R7** *The defect, from the CSS* (to be confirmed by the builder's screenshot, which is part of the check). `.session-editor-advanced` (`index.html` ~894) is a `<details>` with `display: grid; gap: 6px`. In Chromium a `<details>`'s children other than `<summary>` sit in one internal slot (`::details-content`), so the grid has two items and the 6 px gap falls only between the summary and that slot; inside it the label ("Set this profile as default for new sessions when:", a `<label>`, inline), the `<select>` and the skip checkbox stack with no gap at all, and `.session-editor-advanced .modal-check { margin-top: 0 }` removes the checkbox's usual 7 px top margin. The section also has no indent or top space of its own: its summary follows the "Share session now" row at the panel's 8 px grid gap, then everything inside is flush. Built in `showSessionEditor()` (~3078–3110). Wanted: the inside spaced like the panel's own rows (8 px), the controls set off from the summary. Check: a screenshot under `uisolate`, plus measured gaps between the summary, label, select and checkbox (`getBoundingClientRect`), each ≥ 6 px.
- **R8, R9** The menu is `settingsMenuItems()` (~3389): `settingsPreferenceItems()` (Developer Mode, Copy on select, Change font size with CTRL -/+, Zoom whole app with CTRL -/+, STUN/TURN servers…), separator, `templateMenuItems()`, then while collapsed a separator and `collapsedPaneItems()` (Identity…, Dark theme), separator, the version (`info`, last: `261110_ui-chrome` R1). Today there is no separator around the CTRL pair. Proposed order (Q-7):
  ```
  Developer Mode
  Copy on select
  ----
  Change font size with CTRL -/+
  Zoom whole app with CTRL -/+
  ----
  Edit new profile defaults (×3)
  ----                                  (collapsed only)
  <id-badge> Choose your identity       (collapsed only, R10)
  <sun|moon> Switch to light|dark theme (collapsed only, R10)
  ----
  STUN/TURN servers…
  ----
  ZBTerm vX.Y.Z
  ```
  Separators render through `renderSettingsMenuItem()` (~3504, `.context-menu-separator`); the kit reads them through `debugSettingsMenuState()` (~9880), which reports `separator` kinds.
- **R10** `collapsedPaneItems()` (~3437) gives a `field` "Identity…" (with `data-identity`) and a `check` "Dark theme". `renderSettingsMenuItem()` puts a tick icon in front of every item (hidden when not checked) and `[data-identity]::after` (`index.html` ~433) draws the dot at the button's top-right corner, which on a full-width menu row is its right end, the user's complaint. The toolbar buttons are `#identitySetup` (`fa-id-badge`, title "Choose your identity", static; dot via `updateIdentityDot()` ~6231) and `#themeToggle` (`fa-moon`/`fa-sun`, title "Switch to dark theme"/"Switch to light theme", set by `applyTheme()` ~7877). Wanted: each item shows that icon then that title, the dot on the icon (e.g. the `data-identity` on the icon's wrapper, not the row). The identity title has no state today: Q-11. `261110_ui-chrome` R5's kit matches the labels by `/identity/i` and `/theme/i`, which these titles still match.
- **R11, R12** No size lock exists. The grid follows the container: a `ResizeObserver` (~969) → `fitAndResize()` (~7592) → `fitLiveTerminal()` (FitAddon `fit()` in `fitTerminalToContainer()`, then `sizeTerminalToGrid()`) → `session.resize {cols, rows, fontSize}` when `canResizeSelectedLiveSession()` (~7624: own, live, not joined). Font changes (`adjustLiveFontSize()` ~4271, CTRL -/+ via `ctrlZoomDelta()`) refit the same way; the session's font size is kept by the engine (`engine/index.js::resize`, catalog `fontSize`). A fixed grid already exists for playback and joined views: `fitPlaybackFrame()` (~7685) picks the font with `fontSizeForGrid(cols, rows)` (~7737) and letterboxes. The button goes with the Font buttons in `.topbar-actions` (`index.html` ~2423; proposed, Q-10), shown and enabled in `updateTransportControls()` under the same rule as the Font buttons (`canAdjustSessionFont`), icons `fa-lock-open` / `fa-lock`; its menu is a `.context-menu` like `#settingsMenu` (new element, or the `#sessionMenu` pattern). The "R x C" order, what "Current size" means, the font while locked and where the lock is kept: Q-8, Q-9, Q-10.
- **U1** The engine refuses a `record` change on `session.update` (`E_INVALID`, `261110_session-templates` design *Refuses*), and `editNewSessionTemplate()` sends `session.update` without `record` today. The check: a template backed by a recorded live session, ticked off in the editor and saved; the session stays recorded (Share enabled, `player.open` works), and the next session from that template is unrecorded.
- **U2** `canResizeSelectedLiveSession()` already excludes joined and ended sessions. While a live session is scrolled back (`state.mode === 'playback'`) the Font buttons hide; the lock button follows them (proposed). A joined viewer never sends `session.resize` for the host's session.

## Decisions (user, 2026-11-13)

- **Q-1:** bottom *right*, not left (the user corrected it): the duration takes the right end of the `#playback` cell and nothing else of `#playback` shows; ended sessions show `endedAt − startedAt`, frozen; plain "2:41".
- **Q-2:** accepted: icon at the far right, "3/17" just left of it.
- **Q-3:** accepted as proposed (rows move up when a late buffer match arrives), plus a new requirement **R13**: whenever the session rows in the left pane change position (any cause: R3 promotions, refreshes, pinning, sorting), the list blocks clicks on the rows (`pointer-events` guard or click swallow) and shows the `not-allowed` cursor; after 500 ms without another change, clicks and the normal cursor return. Each new change restarts the 500 ms.
- **Q-4:** the bubble's content is exactly today's, only split in two centred lines: the clock part on line 1, the rest ("0:42" or "0:42 (1:05)") on line 2. The "Uncompressed" popup is untouched.
- **Q-5:** accepted: "1d 0:00:00" at exactly 24 h, hours unpadded.
- **Q-6 – Q-11:** the user asked for no further questions (2026-11-13): every proposed default below is adopted as decided.

## Open questions (resolved: see *Decisions*)

Each with a proposed default, marked *proposed*; none is decided.

- **Q-1 (R1) Where is "the bottom left"?** The bottom bar's left cell is the search box (`261111_buffer-search` R1/R9), then `#status`, then `#playback` at the right. *Proposed:* the duration takes the place where the timeline starts, the left end of the `#playback` cell (right after the status), and nothing else of `#playback` shows. Alternative: right after the search box, before the status text. Also: while live it ticks; ended, *proposed* `endedAt − startedAt`, frozen; shown as plain "2:41" (*proposed*), or with a prefix like "Duration 2:41"?
- **Q-2 (R2) The icon and the "3/17" count share the box's right end.** *Proposed:* the icon at the far right, the count just left of it (the input's right padding grows by the icon's width); the icon is decorative but a click on it focuses the box (as Ctrl+Shift+F does). Alternative: the icon replaces the count's place while the box is empty and the count takes over while searching.
- **Q-3 (R3) Which sessions are "unmatched", and how do they behave?** *Proposed:* every session in the list (respecting the All/Active toggle) that is neither the current session, a name match nor a buffer match, in the list's usual order (pinned first); shown only while the box holds text and the side pane is shown; `opacity: 0.5`, full on hover; a click selects it as usual (it then becomes "Current session"). Does a buffer search still running ("searching…") move a session out of "Other" when its answer comes in? *Proposed:* yes, the row moves up when its count arrives. The narrow layout's dropdown (`renderSessionSelect()`) is left as it is (*proposed*).
- **Q-4 (R4) What does the second line say in compressed mode?** Today the one line reads "14:32:05 · 0:42 (1:05)" (compressed, then real elapsed). *Proposed:* line 1 "14:32:05", line 2 "0:42 (1:05)". Also: does "the time slider tooltip" include the "Uncompressed: … / …" popup over the time label (`#timeLabelTip`)? *Proposed:* no, only the bubble.
- **Q-5 (R5) The exact format.** *Proposed:* under 24 h unchanged ("0:42", "3:05:09"); from 24 h "Nd h:mm:ss" with hours unpadded, so 24:00:00 is "1d 0:00:00" and 54:32:10 is "2d 6:32:10"; applies to the current and total time labels, the bubble's second line and the "Uncompressed" popup. The user wrote "more than 24 hours"; exactly 24:00:00 is proposed as "1d 0:00:00".
- **Q-6 (R6) What the checkbox means for a template backed by an existing session.** That session's recording is fixed at creation and cannot change (out of scope, U1). *Proposed:* the box sets only what new sessions from that template get; it opens showing the template's stored choice (the session's own setting when the template has none yet); the stored choice wins over the session's in `resolveTemplate()`; a small note under the box, e.g. "Applies to new sessions", replaces the "Fixed when the session was created" title. Should Copy / Edit of that session (not via the settings menu) behave the same? *Proposed:* unchanged; the request names only the "Edit new profile defaults" items.
- **Q-7 (R8, R9) Separator placement.** "To the end": the version is the menu's last item (`261110_ui-chrome` R1). *Proposed:* STUN/TURN is the last actionable item, directly above the version, so the separator "below" it is the one before the version. Where two groups meet, one separator, never two in a row, none first or last (the order drawn under R8, R9 in *Requirement notes*). Alternative: the version moves above STUN/TURN, which would change ui-chrome R1.
- **Q-8 (R11, R12) Where is the lock kept?** *Proposed:* per session, kept across restarts and Extend, as a profile preference keyed by session id (renderer only, like the pinned sessions; `engine/` untouched). Alternatives: per session in the engine catalog next to `fontSize` (an `engine/index.js` and `docs/CORE-CONTRACT.md` change), or one lock for the window/app that applies to whichever session is shown. A new session starts unlocked (*proposed*); a template copies no lock (*proposed*).
- **Q-9 (R11) What "37 x 124" and "Current size" mean.** The user's presets "25 x 80" and "32 x 120" read as rows × columns, so *proposed:* every label is "rows x cols". "Current size" *proposed:* the session's grid at the moment the menu opens (`state.term.rows` × `cols`), choosing it locks that snapshot; while locked, that line shows the locked size (which is then the current size) and its item is marked as the chosen one. If the current size equals a preset, *proposed:* both lines stay. Is the chosen item marked (tick, bold)? *Proposed:* yes, a tick like the settings menu's checks.
- **Q-10 (R12) What the terminal does while locked.** *Proposed:* the grid stays at the locked rows × columns and the font is chosen to fit the window (`fontSizeForGrid()`, letterboxed, as a joined view does), so window resizes change the font, not the grid; the Font −/+ buttons and CTRL −/+ (font mode) are disabled with a tooltip saying the size is locked. Alternative: the font stays as set and the grid is clipped or scrolled when the window is too small. Button: *proposed* in the top bar with the Font buttons, icon only, the open or closed lock showing the state, tooltip "Terminal size: unlocked" / "Terminal size locked: 32 x 120".
- **Q-11 (R10) The identity button's tooltip has no state.** `#identitySetup`'s title is always "Choose your identity"; only the dot shows the state. *Proposed:* the menu item uses the button's title as it is ("Choose your identity"), so the text follows the button if it ever gains a state. Alternative: give the button (and item) a state text, e.g. "Identity: <name>" when set up and "Choose your identity" when not, which changes the toolbar too.

## Added task (user, 2026-11-13)

- **Output delivery design** (relayed by the coordinator, 2026-11-13; from `261111_buffer-search` F3/F4, the user: "this bug sounds like a bad design"): investigation only, no fix. Switching to a session while it prints can show 1-2 lines twice or drop one; main forwards `session:data` as IPC events and answers `session.open`/`extend`/`resync` frames through `ipcMain.handle`, and Electron does not order the two. `renderLiveFrame` (`renderer/app.js`) clears live writes and paints `buildLiveBootstrap`'s screen (`engine/index.js`). Deliverable: a short design note in this folder (root cause proved with the probe `/tmp/claude-1000/zbv4/probe/dup.sh`, 2-3 candidate designs, one recommendation), then the user approves. Evidence: `261111_buffer-search/acceptance/report--2026-11-13-F3.md`, commit bceccbb.

- **Decision (user, 2026-11-13):** design A, byte offsets ("stream positions" in `delivery-design.md`),
  as its own follow-up project; nothing is fixed in ui-polish. The user chose it reading the parallel
  run's note (`zr-todo` at fcf4534, design letters A/B/C there; its B is C here). Riders from that note:
  the new project's kit reuses the seam check of `delivery-probe/dup2.sh` as an assertion (zero overlaps,
  zero gaps in N trials), and the snapshot fix (`_sessionState` takes the snapshot and its position
  together, with `mirrorPending`) lands in the same change.

## Added before done (user, 2026-11-14)

The user's words: "Before we close lets fix one bug and one ask I was not clear about + one minor
feature 1) after we switch to "zoom all app with ctrl -/+" mode, zooming works, but when returning to
"zoom font" mode, the application zoom is restored to what it was - the app zooming is not kept - need
to keep it 2) I want the zoom lock button to be the left-most button on the toolbar to be more visible
+ if the user clicks CTRL -/+ in font zoom mode and zoom lock, flash in red the zoom lock button like
when typing when the keyboard and live flash in playback and trying to type"

- **R14** (the bug): `applyAppZoom(false)` put the level back to 0 on purpose, and the restore applied
  the stored level only in app mode. Now the level outlives the mode: leaving app mode keeps it, and a
  restart restores it in either mode. To change it again the user turns app mode back on (Ctrl 0 resets
  there). Checked with Electron's own `getZoomLevel` (`/renderer/layout`).
- **R15**: `#sizeLock` is the first child of `.topbar-actions`, before "+ Font".
- **R16**: the refusal in `adjustLiveFontSize` calls `flashInputBlockedButton(els.sizeLock)`, the same
  red flash as the keyboard and Live buttons; the icon turns light like theirs (CSS for an icon-only
  button). It also covers the "± Font" buttons, but those are disabled while locked, so in practice
  only the keys reach it. Debug `size-lock-state` gained `button.first`, `button.flashing`, `flashes`,
  `appZoom`.

- **R17** (a bug, the user's words: "when debugging is on and I join a session, it shows the debug
  window with progress animation forever when done until I click it"). With debugging on (the default)
  a Join-dialog join ends in `beginLiveReveal`, which stopped the diagnostics log, waited 2.5 s and then
  waited for a click, Enter or Play (`showRevealedLiveStream`); meanwhile the pending placeholder stayed
  the current session, so its "Joining"/"Syncing" spinner could stay up. Now the pause ends by itself
  in `showRevealedLiveStream` (a click, Enter or Play still ends it sooner). Debug `ui-state` gained
  `liveReveal` `{pending, devLog, spinner, meta}`. Red first: the same build minus that one line failed
  R17 (held at "Joined - paused before live" past the 15 s limit); with it, PASS.

## Soft changes

2026-11-13 (builder). Each rewords or fixes a detail; no outcome dropped, no check weakened. Merged
2026-11-14 from the parallel run (`zr-todo`, fcf4534), which listed the build's details; the R13 entry
is this line's (after F5).

- **R1** "the duration" is a new element, `#sessionDuration`, at the right end of `#playback` (the rest of `#playback` hidden by the class `unrecorded`), not `#totalTime`; it ticks once a second while live (the live clock only moved on output).
- **R5** The check reads the one formatter (`renderer/wall-clock.js::formatDuration`, debug command `duration-format`) on fixed values, plus live labels under 24 h; no session of 24 h or more is made in the GUI.
- **R6** The note under the box reads "Applies to new sessions" and sits beside the label, not in it (the box's label stays "Record session" for the kits' `dialog-set`).
- **R11** A lock chosen from a preset ticks that preset; one chosen as "Current size" ticks "Current size". The "Current size" line shows the locked size while locked (Q-9).
- **R12** While locked, CTRL -/+ (font mode) is taken and does nothing but say "Terminal size is locked" in the status line, so the chord is not typed into the shell either.
- **R13** The guard is CSS (`pointer-events: none` on the rows, `cursor: not-allowed` on the list), so it blocks real pointer clicks; the debug server's synthetic `click` command still reaches a row (the other kits' row actions use it). Design detail (reviewer F5, `design.md`): the guard first armed on any list item whose key changed, including a heading's or note's text ("searching…" → "No matches in live sessions"); now only a row that sits at another place among the list's items arms it. Rows only added or dropped do not.
- **U2** "not resize the host" for an ended session is checked as the lock no longer applying (`size-lock-state .active == false`): an ended session has no grid to read.
- **Tiers** `test/session-data-batcher.test.js` (from bceccbb, not this project) was in no topic, so `run.sh --self-check` failed; it is now in sanity, engine, search and keyboard.

Checks narrower than their row's words (verifier, `acceptance/report--2026-11-13.md` findings 1, 3, 4):
**R7** measured as gaps ≥ 6 px (the screenshot read supplies "like the rest"); **R12** "whatever the
window or font does" sampled (three window sizes, one Ctrl+= and one Ctrl+−, a restart); **R3** "dimmed"
checked as opacity 0.4–0.6.

## Superseded text

None.
