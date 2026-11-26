# 261125_speed-and-keys — design (one page)

**Serves:** `goal_requirements.md` R1–R11, U1–U4 · **Written:** 2026-11-25 · **Reviewed:** 2026-11-25, Claude Opus (fresh context, goal + design only) · **Approved:** see end.

## Interface

Speed (R1, R2, U3, U4). The cause is in `baseline.md`: work proportional to the selected
session's timeline, done on every output chunk and on every open.

- `renderer/app.js::renderScrubberIndicators` becomes `scheduleScrubberIndicators()`: at most one
  run per animation frame, and at most one per 250 ms while output arrives. Its timeline-sized
  inputs (`idleSegments`, `sessionHasHd`, `timelineActivityMap`, `getTimeCollapseMap`) are cached
  on (timeline array, its length, the start/end bucket). The throttle always has a trailing run,
  reads the state when it runs (never a captured session), and a switch cancels a pending run and
  draws at once (F8). The second `updateTransportControls` call
  per chunk goes. Nothing about what is written to the terminal or recorded changes (U4).
- The timeline no longer rides on every open. `session.open` and `player.open` take an optional
  `timeline: 'lazy'`: the answer then carries `timelineLength` and no `timeline`. A new invoke
  `session.timeline { sessionId, from, limit }` returns `{ entries, length }`. Without the option
  both calls answer as today (debug server, tests, other hosts: additive, Q-2).
- The renderer keeps `state.timelineCache: Map<sessionId, { entries, fetching }>`, the only writer
  of a session's timeline. A switch draws the frame first, shows the cached timeline at once if it
  has one, then fetches from the cached length in slices of 10 000 between timers until `length`
  is reached, and redraws the scrubber once at the end. One fetch per session at a time; a slice
  is applied only if its cache entry is still the same object and `from` equals its length
  (F3, F5, F6). Each request carries the cached last entry's `tsMs`; the engine compares it with
  its own entry at `from - 1` and answers `reset: true` with entries from 0 when they differ (F4).
  The entry is replaced (not emptied) on `session.clearCaches`, delete and `engine:restarting`.
  Until a playback's timeline is complete, play, step, seek and the scrubber are disabled; the
  frame and the saved position are already shown (F7).
- A switch carries a generation number (`state.switchSeq`): every await in `selectSession`,
  `openPlayback` and the timeline fetch returns when a newer switch began (U3). Ctrl+PgUp/PgDn
  step from the last *requested* target, not from the last drawn one.
- Debug command `perf` (renderer, through the debug server's `/renderer/command`):
  `{"command":"perf","action":"start"|"read"}` → `{ longTasks: [ms…], switches: [{ sessionId, ms }],
  echoes: [ms…] }`. A switch is timed from its keydown to the first terminal render after its frame
  was written; an echo from a terminal keydown to the next parsed write. Observation only.

Keys (R3–R11, U1, U2). One flag, `state.searchActive`: set when the search box takes the focus,
cleared only by an exit (Esc, the terminal taking the focus, a new or joined session, Ctrl+1..9).
Invariant: while it is set the focus is in the box, or in a dialog or menu opened meanwhile.

| key | in search | in the terminal |
|---|---|---|
| Up/Down, Ctrl+PgUp/PgDn | cursor to the previous/next row as drawn, no wrap; that profile is shown, never resumed | Ctrl+PgUp/PgDn: previous/next row as drawn (`sessionRowsInOrder`), wrapping, shown not resumed |
| Enter / Shift+Enter | older / newer match in the shown profile; nothing else, ever | the program's; on a closed session Enter resumes (as today) |
| Ctrl+R | resume the closed session shown; focus stays | the same; the program's on a live session |
| Ctrl+D | delete the closed session shown, after the confirmation; focus stays | the same; the program's on a live session (U1) |
| Esc | end the search, text forgotten, focus to the terminal | the program's |
| a click on a row | show it; focus stays in the box | show it (resumes a closed one, as today) |
| a click in the terminal | end the search, text remembered | — |

- The third state is removed at two points. A `focusin` on the terminal while the flag is set
  calls `leaveSearchForTerminal()` (text remembered). The box's `blur` while the flag is set, when
  the focus lands neither in the terminal nor in a dialog or menu (a toolbar button, the side-pane
  toggle), puts the focus back in the box (F9). So results are never on screen with keys going
  to the shell (R6).
- The app's own focus returns go to the box while the flag is set, text or no text:
  `focusPrimaryTarget` and `selectSession`'s `term.focus()` pick the box then (R7, F10).
  Creating or joining a session and Ctrl+1..9 are exits: the search ends first, the terminal
  gets the focus (F11).
- The status line in search, from focus to end: `[M / N] Search: ⬆️/⬇️ profiles · Enter/Shift+Enter
  matches · Esc exit`, plus `· ^R resume · ^D delete` while the shown session is closed (R9; the
  wording is soft). It replaces `SEARCH_COUNT_HINT`; other status texts show for their moment and
  the line comes back; an error (`showError`, an identity refusal) stays until the next key (F14).
  One function draws it, called from every list redraw, switch end and `session:exit` (F12).
- The top section is headed "Current session" only while its row is the shown one; once the walk
  has moved off it the heading reads "Search started here" (R11).
- Ctrl+D (`document` keydown, beside Ctrl+R, same guard `isOfflineResumable()`): `deleteSession()`
  with its confirmation (and the template warning). The key is ignored on repeat, while any dialog
  is open, and while a switch is not yet drawn; the session id is taken at the keypress, named in
  the confirmation, and that id is what is deleted (F1, F2). Then the next drawn row with another
  id, else the previous, else the first listed, is selected with `{ extend: false }`; with no
  session left, the empty screen as today (R5, F12, F13). `RESUME_HINT_TOAST` becomes
  "Press ^R or Enter to resume the session, ^D to delete it" (R4).

## Data and state

No stored format changes. New in memory: `state.timelineCache`, `state.switchSeq`, the scrubber
caches, the `perf` probe's buffers. `state.searchAnchorId`/`searchCursor` stay. The engine keeps no
new state: `session.timeline` slices `store.timeline`.

## Refuses

- Ctrl+D on a live, joined or pending session: not handled, the key goes where it went (U1).
- Ctrl+D or Ctrl+R with a dialog open: left alone, as the other app keys (`sidePaneBlocked`).
- Cancel in the confirmation: nothing deleted; focus back to the box (text held) or the terminal (U2).
- `session.timeline` for an unknown session: the engine's usual not-found error; the renderer
  drops that fetch.

## The reference program, step by step

`acceptance/run_all.sh` (packaged build, scratch store, own display):
1. `R1_switch_speed.sh`: seeds 12 sessions and writes a 200 000-entry `timeline.json` into one live
   and one closed session before the app starts; `perf start`; ten Ctrl+PgDn rounds; asserts the
   medians and long tasks of `baseline.md` *Cost*, cold (after a restart) and warm; then 15 Ctrl+PgDn in 300 ms and asserts the
   selected and drawn session is the one 15 steps on, its text on screen, no error status (U3).
2. `R2_typing_speed.sh`: in the live 200k session types 50 keys, quiet and while it prints; asserts
   echo median and long tasks; asserts the session's mirror and the recorded log hold every byte
   of a numbered sequence printed during the run (U4).
3. `R3_delete_key.sh`: Ctrl+PgDn onto a closed session → the toast text (R4); Ctrl+D → the
   confirmation; Cancel keeps it (U2); Ctrl+D + confirm deletes it and shows the neighbour, not
   resumed (R3, R5); the same from the search box with the focus kept; Ctrl+D in a live shell
   waiting in `cat` ends `cat` and deletes nothing (U1).
4. `R1_many_profiles.sh`: 100 small profiles, the switch median ≤ 80 ms.
5. `R6_search_states.sh`: after each of row click, Ctrl+R, a dialog opened and closed: box focused,
   sections still drawn (R7); a terminal click: box empty, plain list, text back on the next focus
   (R6); Enter with the resume toast up steps a match and the session stays closed (R8); the
   status line names search with zero matches (R9); outside search Ctrl+PgDn visits every drawn
   row in order and wraps (R10); the heading during a walk (R11).

## Failure scenarios

| # | scenario (input, state, host) | requirement at risk | design answer |
|---|---|---|---|
| F1 | Ctrl+PgDn then Ctrl+D before the new profile is drawn: the delete hits a session never seen | R3, U1, U3 | changed: Ctrl+D (and Ctrl+R) ignored while a switch is undrawn; id taken at the keypress and named in the dialog. `R3_delete_key.sh` |
| F2 | held Ctrl+D: queued confirmations, a reflex Enter deletes the neighbour | R3, U2 | changed: repeat ignored, ignored while a dialog is open, the captured id is deleted. `R3_delete_key.sh` (held key) |
| F3 | A→B→A: the old and the new slice fetch both append | U4, R1 | changed: one fetch per session, slice applied only at `from == length` on the same entry. `R1_switch_speed.sh` (A→B→A, then cached == engine) |
| F4 | timeline cleared and regrown past the cached length | U4 | changed: last-`tsMs` check, `reset: true`. Engine unit test (P3) |
| F5 | engine restart between slices | U4, U3 | changed: restart replaces the entry object; the old loop's slices no longer apply. Engine/renderer unit test (P3) |
| F6 | live session fetched while it streams | U4 | changed: the cache is the only writer; a fetch ends at the `length` of its last answer, the next open continues. `R2_typing_speed.sh` (cached == engine, last entries equal) |
| F7 | seek or play before a playback's timeline is in | U4, R1 | changed: transport disabled until complete. `R1_switch_speed.sh` (cold closed profile: disabled, then a step changes the frame) |
| F8 | no trailing run; a pending run draws the old session's marks | U4, U3 | changed: trailing run, state read at run time, cancelled by a switch. `R2_typing_speed.sh` (marks settle ≤ 500 ms after output stops) |
| F9 | toolbar button, side-pane toggle, menu, window blur: box blurs, no terminal focusin | R6, R9 | changed: the blur rule. `R6_search_states.sh` (button, Ctrl+Shift+B, settings menu: box focused after each) |
| F10 | box emptied by backspace, then Ctrl+R or a dialog: focus falls to the terminal | R7 | changed: a flag, not "holds text". `R6_search_states.sh` |
| F11 | a new session during search: first keys land in the box | R6, R8 | changed: creation, join and Ctrl+1..9 are exits. `R6_search_states.sh` (new session by key: the typed key reaches its shell) |
| F12 | the shown session exits, or the anchor or the last session is deleted, during search | R9, R11, R5 | changed: one status function on every redraw; no session left → the empty screen. `R6_search_states.sh` (exit → `^R`/`^D` appear ≤ 2 s), `R3_delete_key.sh` (last profile) |
| F13 | "row after" is the same profile's second row, or gone after the re-filter | R5, R7 | changed: next row with another id, checked against the refreshed list. `R3_delete_key.sh` (search block) |
| F14 | the search hint overwrites an error; U3's "no error status" passes on a hidden error | R9, U3 | changed: errors outrank the hint; the probe counts `errors`. `R1_switch_speed.sh` asserts `errors == 0` |
| F15 | R1's check is warm after round 1, two big sessions, 12 profiles, timer stops before the cold fetch | R1, U3 | check extended: cold switches after a restart asserted, long tasks watched until `timelineMs`, and `R1_many_profiles.sh` (100 profiles) |
| F16 | echo timed to the program's output; U4 ignores the cached timeline; R8/R9/U1 forms unchecked; IME | R2, U4, R8, R9, U1 | check changed: echo = the write holding the typed character; cached-vs-engine timeline asserted; `R6_search_states.sh` adds Shift+Enter, Ctrl+R, `M / N`, the `^R`/`^D` suffix; joined, pending and IME (`isComposing`) are unit tests in `test/` (P4, P5), a real joined session being out of this kit's reach |

## Questions and assumptions

- **Q-1** (to the user, with approval): Enter in the search box no longer resumes a closed session
  (`261115_quit-pins-reorder` R10's box half), and a row click in search keeps the focus in the box
  (the old `261121` R3 case, "search on, focus in the terminal", cannot happen any more).
  Recommended: yes, both; otherwise Enter keeps two meanings and the third state stays.
- **Q-2** (to the user, with approval): `session.open`/`player.open` gain an optional parameter and
  the engine a new invoke. Additive; `docs/CORE-CONTRACT.md` freezes the spawn seam, not the
  invoke list, but `engine/` is published as `zbterm-core`, so it is named here.
- **A-1** The confirmation on Ctrl+D stays (Enter confirms). Other option: delete at once.
- **A-2** `renderSessions` is not made incremental: 6 ms at 100 profiles (`baseline.md`).
- **A-3** The search walk still opens each profile it passes; at ≈ 40 ms a switch no debounce.
- **A-4** Esc forgets the text and a terminal click remembers it, as today.
- **A-5** No version bump; a CHANGELOG entry and the README's key section are updated in the last phase.
- **A-6** Earlier kits that assert the replaced behaviour (`261121…/R2_search_keys.sh`'s row click,
  `261115…` R10 in the box) are history and are not edited; unit tests in `test/` that assert it
  are updated with a dated comment.

## Decisions

None that needs a ledger row (this repo has no `docs/decisions.md`; nothing here is hard to reverse).

**Open, not built:** two sessions flooding at once can starve the worker
(`electron/session-data-batcher.js`, `baseline.md`): a project of its own.

## Approval

Approved 2026-11-25 by the user ("approved, go", in chat, on the summary naming Q-1, Q-2 and A-1 as recommended), file at sha256 `bd27d11abad2b79a530fcca02ac7fb8d7ae02929e692c2e085a44852559e3aad` (before this line).
