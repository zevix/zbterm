# 261125_speed-and-keys — notes and context

Companion to `goal_requirements.md`: the user's words, the history and the detail behind each
row, so the goal page stays one screen. Not a spec; nothing here is approved or built from.

## The user's words

**2026-11-25** (the request that opened the project):

> Please start a new mini project by @/zp/zdata/work/ubitron/dev/docs/templates/howto.md with the
> following fixes and enhancments:
> - profile switching (like with Ctrl+PgDn) became owfully slow. There is also general sluggisness
>   in typing responsiveness - please check
> - add support for ^D to delete close session where ^R resumes (add to the message)
> - Check the whole search result navigation and keyboard handling - I quicly find myself in an
>   unkonwn state - am I navigating sessions? moving between search results? something is not
>   defined well - please review what we have carefully and suggest a solution while working on
>   the other things

**2026-11-25** (on the plan, with Q-1, Q-2 and A-1 put to them):

> approved, go

**2026-11-25** (after P1, on the root cause; planner proposed an engine-side timeline summary):

> Okay very good but I feel two things are missing from the solution I'm hearing. One is starting
> with displaying the last frame and letting the user start walking and loading the history in the
> background and the other is any type of index single something especially about updating the
> whole progress bar. We must have some kind of a concentrated view type of data structure in memory

> Yes, just please add a build and release after the first fix because this is urgent and the
> other part of this complex index should be a separate project

Planner's reading: this project keeps its approved speed fixes (P2 scheduled scrubber, P3 lazy
timeline), then phase PR builds and releases them; the condensed timeline index (engine-side
summary, walk from the last frame while history loads, slices on demand) is a separate, later
project that supersedes P3's full fetch.

> Okay, plan is approved to go on

(2026-11-25, on the order P2 → P3 → PR → P4 → P5 → P6 and the release asked about at PR.)

## Context

- Search grew over five projects, one key at a time: `261111_buffer-search` (the one box, Enter
  steps matches, a terminal click ends the search and remembers the text), `261114_live-output-and-fixes`
  R8–R10, R14, R15 (search mode, the arrow walk, Ctrl+PgUp/PgDn as arrows in the box, no resume
  from the walk), `261115_quit-pins-reorder` R9, R10, R38 (the resume toast outside search, Enter
  resumes, hidden sections), `261121_improvements-and-fixes` R3, R4 (Esc from the terminal, the
  status-line hint). No page ever stated the whole key map; this project's review is the first.
- "Profile" in the user's words is a row of the session list (a session and its launch profile).
- The working tree carried uncommitted work when the project started (`baseline.md` *Working tree*).

## The search review (2026-11-25, planner, from `renderer/app.js`)

What the code does today. "Box" is the search box; "text" means the box is not empty.

| key | focus in the box | focus in the terminal, box holds text | terminal, box empty |
|---|---|---|---|
| Up / Down | walks the rows as drawn, no wrap, selects each session, never resumes (`moveSearchSelection`) | the shell's | the shell's |
| Ctrl+PgUp/PgDn | the same as Up / Down | switches through `state.sessions`, which is then the **name-filtered** list only, wraps, in list order not drawn order (`switchSessionRelative`) | switches through the whole list, wraps |
| Enter | steps to the older match, **or** resumes the session when the resume toast happens to be up (`wireEvents`, the box's keydown) | the shell's (live) or resumes (offline) | the same |
| Shift+Enter | steps to the newer match | the shell's | the shell's |
| Esc | ends the search, focus to the terminal | ends the search, swallowed | the shell's |
| Ctrl+R | resumes, focus stays | resumes | resumes (offline) or the shell's |
| a click on a row | selects it, focus goes to the terminal, **text and sections stay** | the same | selects |
| a click in the terminal | ends the search, text remembered | the same | nothing |

Where a person gets lost (each is a code fact, `file::symbol`):

1. **A third, unnamed state.** The box holds text but the terminal has the focus (after a row
   click, Ctrl+1..9, any toolbar button via `guard` → `focusPrimaryTarget`, a dialog closing). The
   list is still cut into the four search sections and the highlights are on, but every key goes to
   the shell, and Ctrl+PgDn cycles only the name matches in an order the list does not show.
   `searchModeOn` (focus or text) and `searchIsOn` (text) are two different predicates.
2. **Enter means two things in the box**, chosen by whether a 4-second toast is still on screen
   (`state.toasts.has('resume-hint')`): step a match, or resume the session.
3. **Ctrl+PgUp/PgDn means three things** (the table's second row): no wrap and drawn order in the
   box; wrap and filtered order in the terminal with text; wrap and full order without.
4. **Two "current" sessions during a walk.** `state.searchAnchorId` keeps the session the walk
   started on under the heading "Current session", while the selected (shown) session is another
   row with the green border.
5. **The hint is ambiguous.** "(In terminal Enter/Shift+Enter, in profiles ⬆️/⬇️ )" reads as "when
   the terminal has the focus"; it means "the terminal's matches". It shows only when a session has
   matches, so with zero matches nothing says which keys do what.
6. **Nothing names the mode.** The only signs are the box's placeholder (invisible once it holds
   text) and the icon turning into an "x".
7. **Every arrow press switches the session for real** (`selectSession`: `session.open` or
   `player.open` round-trip, terminal reset, list rebuild), so the walk is as slow as a switch.

## Requirement notes

- **R1** "Without a perceptible wait": key → drawn median ≤ 150 ms onto a profile with a 200 000-entry
  timeline, cold and warm, ≤ 60 ms onto small ones, ≤ 80 ms with 100 profiles, no long task over
  100 ms (`baseline.md` *Cost*; today ≈ 0.3 s at 100k entries, 2.3 s at 1M). The numbers are the
  detail; the outcome is the row. Mechanism (design): the timeline is fetched after the draw, in
  slices, and cached.
- **R2** Echo median ≤ 30 ms and no long task over 50 ms in 50 keys, in a live session with a
  200 000-entry timeline (today: fine at 100k, 107 ms median at 1M; the cost is per output chunk).
- **R3** The guard is the one Ctrl+R uses (`isOfflineResumable`): one of the user's own sessions,
  closed, shown in playback. The confirmation is the Delete button's, template warning included.
  Ignored on key repeat, while a dialog is open and while a switch is not yet drawn (design F1, F2).
- **R4** The exact toast text is in the row because the user asked to "add to the message".
- **R5** "Neighbouring": the next row as drawn, else the previous; none left → the empty screen.
- **R6, R7** The search is on from the box taking the focus until an exit: Esc (text forgotten), the
  terminal taking the focus (text remembered), a new or joined session, Ctrl+1..9. This replaces the
  "search on, focus in the terminal" case that `261121_improvements-and-fixes` R3 served.
- **R8** Changes `261115_quit-pins-reorder` R10: Enter in the box no longer resumes. Enter in the
  terminal on a closed session still does.
- **R9** Wording (soft): `[M / N] Search: ⬆️/⬇️ profiles · Enter/Shift+Enter matches · Esc exit`, plus
  `· ^R resume · ^D delete` on a closed session. An error message outranks it until the next key.
- **R11** The heading reads "Search started here" once the walk has left that row.
- **U3** A held Ctrl+PgDn steps from the last requested profile, not the last drawn one.
- **U4** Covers the timeline too: what the renderer caches equals what the engine holds.
- **Over the caps:** the goal page is ~680 words (cap 400) and the design ~160 lines (cap ~120):
  three topics in one project, as asked ("a new mini project … with the following"); the 16 review
  rows are a third of the design page.
- **Not in this project:** two sessions flooding at once starving the worker (`baseline.md`).

## Soft changes

See `status--in-progress.md` *Soft changes to read back* (R2 fixture at 1M entries; F8 marks
compared at one clock), both 2026-11-25, planner, after P1.

## Superseded text

None.
