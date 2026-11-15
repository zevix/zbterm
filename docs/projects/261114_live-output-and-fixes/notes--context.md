# Live output and fixes — notes and context

Companion to `goal_requirements.md`: the user's words, the history and the detail behind each
row. Not a spec; nothing here is approved or built from.

## The user's words

2026-11-13 (via the coordinator, `../261113_ui-polish/notes--context.md` *Added task*): the user chose
design A (byte offsets) for the output-delivery bug, as its own follow-up project.

2026-11-14: "whats the projext wkth the desjgn a fix?" — then, offered a new project for it: "yes but
name it correctly for that plus more  ugs and featurs".

2026-11-14, the further items, as first received: the paste stopped after "with the logo screen:
Replace the text of the [+ Font] and [- Font] with" (twice). Rows R4–R7 were written from that.

2026-11-15, the full list (verbatim):

> Zbterm
>
> - When searching (focus in the search box):
>   - Change the default (empty string) text to "Seach (Esc to exit)"
>   - Move the blue closing "x" icon to replace the hourglass icon on the right
>   - Add in search mode up/down keyboard navigation in the session list - change the top (current session) border to our logo green and make it thicker, and allow moving it on up/down keypresses
>   - Add |<<  "start" and >>| "end" buttons on in the history navigation toolbar, so it becomes |<<  |<  >  >|  >>|  [ collapse ]   (where |< > >|  [ collapse ] are the existing buttons". Make syre that >>| is colored and flashes together with the top-right  [ Live ] button
> - In the session list replace the green 'v' indicator of a session template (for CTRL+SHIFT+T etc) with an icon that symbols a template - maybe a stamp?, and place it on the right of any "pin" icon, so the pins are always on the right edge
> - When a session is in an editor like claude code, we can have search results in the history, but some or all of them may not visible. This is confusing especially in the current session where we can see one number in the search box and a higher number in the cyan "N matches"... Can we detect that and show in cyan "12 matches (2 + 10 hidden history matches) ?
> - with the logo screen:
>   - Remove
>     - Based on modules and examples by pears.com/holepunch.to
>     - ZBTerm is not affiliated with Holepunch.to or pears.com
>   - Center-align "See https://github.com/zevix/zbterm for more information"
> - Replace  the text of  the [+ Font] and [- Font] with

2026-11-14, answering Q-1 (verbatim): "Ah sorry the font resize should become [+ A] [- A] preferably
with a serif A like in word processor icons".

## Context

- Predecessor: `../261113_ui-polish/` (done 2026-11-14). Its P4 investigated the bug:
  `delivery-design.md` (root cause, three mechanisms, candidates A/B/C, A recommended),
  `delivery-probe/` (`dup2.sh`, `seam.txt`: the seam check this project turns into R1's assertion).
- First seen: `../261111_buffer-search/acceptance/report--2026-11-13-F3.md` (renderer line count
  above the engine's in 2 of 18 trials, below it in 1 of 18).
- The name covers the user's further bugs and features: R4–R6, named 2026-11-14.

## Requirement notes

- **R1/R2** Mechanism (design A): `session:data` carries `end` (the engine's `runtime.bytesSeen` after
  the chunk); every frame carries `through`, taken with the snapshot in one synchronous step that
  includes `runtime.mirrorPending` (`engine/index.js::_sessionState`). The renderer holds the
  session's chunks while a frame is pending, drops bytes ≤ `through`, cuts the straddling chunk,
  writes only past the last `end` written, and drains xterm (`term.write('', cb)`) before
  `term.reset()`. Main's batcher keeps the last `end` when it joins chunks. Contract: `EVENT_DATA`
  gains a field (`engine/rpc/schema.js`), a minor version in `docs/CORE-CONTRACT.md`.
  Check: the `dup2.sh` seam check as an assertion, N switches under load, zero overlaps and gaps.
- **R3** Joined frames come from the remote mirror: the viewer needs the same counter from the host
  (design A's "second step"). May split into its own phase.
- **U1** A gap between two `end`s, silent today (backlog drops), triggers a resync.
- **U2** `engine/` is published as `zbterm-core`: the new field is optional on read.

- **R4** Today the mark is `fa-check session-default-mark` (green), appended after the pin
  `fa-thumbtack session-pin-mark` in `renderer/app.js::sessionRow` (the `session-marks` span), so a
  template mark sits right of the pin. Wanted: a template icon (the user suggests a stamp;
  `fa-stamp` is in the vendored Font Awesome) appended *before* the pin, so the pin is always
  right-most. The tooltip stays "Template when you …". The user's words "on the right of any pin"
  read together with "so the pins are always on the right edge": the template mark goes left of the
  pin (the outcome is the pin at the right edge).
- **R5** Two counts disagree today: the search box (`#searchCount`, `updateSearchCount`) counts what
  the renderer's xterm buffer holds, which in a full-screen app (alternate screen: Claude Code, vim,
  less) is the alternate screen only; the cyan "N matches" on the session row comes from the
  engine's mirror (`session.searchBuffer`), which also holds the normal-screen history the editor
  covers. Wanted, in the user's example: "12 matches (2 + 10 hidden history matches)" — total, then
  visible + hidden. When nothing is hidden the row reads as today ("N matches"). Applies to every
  row in "Session buffer matches", the current session included. Exact wording is a detail (soft).
- **R6/R7** The `+ Font` / `- Font` buttons (`renderer/index.html` `#fontSizeIncrease`,
  `#fontSizeDecrease`: a `fa-plus`/`fa-minus` icon, then `<span>Font</span>`). R6: the text becomes
  "A" ("+ A", "- A"); the aria-labels ("Increase/Decrease font size") and the CTRL -/+ flash
  (`zoomLiveFontSize`) stay. R7 (soft, the user said "preferably"): the A in a serif face (a CSS
  serif font on the span; no new dependency). The user placed the item under "with the logo
  screen"; the buttons are the same toolbar buttons wherever they show, so the change applies
  everywhere.
- **R8** `renderer/index.html` `#search` has `placeholder="Search (Ctrl+Shift+F)"`. "Seach" in the
  user's words is read as "Search" (soft change). The header "When searching (focus in the search
  box)" scopes it: the focused box reads "Search (Esc to exit)", the unfocused one keeps the shortcut
  hint (otherwise Ctrl+Shift+F would no longer be shown anywhere).
- **R9** The "blue closing x" is Chromium's own `type=search` cancel button (blue, inside the box,
  left of the count). The "hourglass" is the magnifying glass `#searchIcon` (`fa-magnifying-glass`,
  `.search-icon`, decorative, a click focuses the box). Wanted: in search mode the glass gives its
  place to a blue "x" (an own icon, `fa-circle-xmark` in the accent blue, so it shows also with an
  empty focused box), its click = `clearSearch()` as Esc; the native cancel button is hidden.
- **R10** Read: "the top (current session) border" is the selected row's border (the current
  session's row heads the list while searching); Up/Down move the selection itself (`selectSession`,
  the terminal follows) through the rows as drawn, top to bottom, including the "Session buffer
  matches" section; the focus stays in the box so typing goes on. Enter/Shift+Enter keep stepping
  through matches (`stepMatch`). Today `.session-row.selected` uses `--selected-border` (1 px);
  while searching it becomes the logo green (`window.STARTUP_LOGO_COLORS.green`) at 2 px. Other
  reading (not taken): a separate cursor that Enter opens.
- **R11/R12** Toolbar today (`#playback`): `#stepBack` (`fa-backward-step`, "|<"), `#playPause`,
  `#stepForward` (`fa-forward-step`, ">|"), `#collapseGaps`. New: `#jumpStart` (`fa-backward-fast`,
  "|<<", before `#stepBack`) and `#jumpEnd` (`fa-forward-fast`, ">>|", after `#stepForward`). Start =
  `player.seek` to the first frame (from live it enters playback first, as `step(-1)` does). End = a
  running session goes live (`goLive`), an ended one seeks to its last frame. `#goLive` gets
  `live-on`/`live-joined`/`live-host`/`live-beacon` in `updateControls`; `>>|` gets the same classes in
  the same place, and both animations share one phase so they flash together.
- **R13** `renderer/app.js` writes the lines twice: the startup animation (`writeTerminal`, ~line
  1054) and `devLogoText` (~line 1234). Both lose the two lines; the "See …" line goes through the
  same centring as "Written by …". The non-affiliation note stays in README (line 33).
- **R1–R7 are mixed**: R4–R7 are small renderer changes independent of design A and can be built
  first, in their own phase. R8–R13 are renderer-only too (phase P4).

## Soft changes

- R8: "Seach" in the user's words is written "Search".

## Superseded text

None.
