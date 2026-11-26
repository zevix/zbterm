# Changelog

Notable changes to ZBTerm. The format follows [Keep a Changelog](https://keepachangelog.com/),
and the project uses [semantic versioning](https://semver.org/) as described in
[`docs/RELEASING.md`](docs/RELEASING.md).

## Unreleased

### Added

- First public open-source release, and the first release published to npm (`npm install -g zbterm`).
- Interactive PTY-backed shells with encrypted local recording and playback with a time scrubber.
- Peer-to-peer live sharing over Hyperswarm, with single-user and group invite links, per-link
  permission caps, host approval, keyboard sharing and key rotation on join and leave.
- Optional relay fallback for NAT traversal, discovered through a DHT record.
- Experimental Freenet share backend, through the `zxterm-core` sidecar.
- Multiple profiles and multiple concurrent sessions.
- Session composition: the session dialog builds a launch from plugin steps ("Change Directory",
  "Shell Command", "SSH", and "Change Remote Directory" with a remote directory browser) in place
  of the fixed "Home Directory" and "Command" fields. Existing sessions open as the two equivalent
  steps.
- A `zbterm-plugin` Claude skill that writes, checks, installs and enables command plugins: the
  project's own skill in a checkout, and installed for Claude Code by the Plugins dialog's
  "Install the Claude skill" button.
- Command plugins can wrap the rest of a session on the same machine (a multiplexer, `ubt run`):
  `pushScope(kind, { sameMachine: true })` keeps Change Directory and SSH (or, after SSH, Change
  Remote Directory) offered inside, and a directory set inside becomes a leading `cd` or, with
  `takesCwd`, the wrapper's own option. Steps in the profile editor indent once per scope level.
- `zbterm doctor`, `zbterm install-desktop` / `uninstall-desktop`, and a localhost debug REST API.
- The Rust `zxterm-core` sidecar, built from the `zxterm/` submodule and shipped as one optional
  npm package per platform (`@zbterm/zxterm-core-<platform>-<arch>`).

- [`docs/OVERVIEW.md`](docs/OVERVIEW.md), a tour of every feature and key binding for a new user,
  and `./demo.sh` ([`docs/demo.md`](docs/demo.md)), a guided walk-through that drives the real app
  on scratch data: one window first, then two side by side sharing a terminal.
- Debug server: real input (`POST /input/key`, `/input/text`, `/input/mouse`, sent as Chromium
  input events), `POST /window/focus`, `GET /window/screenshot`, and the `demo-*` renderer
  commands (captions, key badges, a drawn pointer) the walk-through is built on.
- Ctrl+D deletes an ended session wherever Ctrl+R would resume it (in the terminal and in the
  search box), after the usual confirmation, and then shows the next session in the list without
  resuming it. In a live session Ctrl+D is still the program's. The resume hint now reads "Press
  ^R or Enter to resume the session, ^D to delete it".

### Changed

- New logo and icons: the Freenet rabbit's head, in profile, on the striped Pear pear. The mark is
  now a square grid of square pixels (`renderer/logo-ascii.js`); the startup splash draws it at
  twice the vertical resolution with half-block glyphs, and the icons are square with rounded,
  transparent corners.
- The logo is now the left half of the Freenet rabbit and the right half of the Pear pear, and the
  splash screen credits "Written by Zeev Kotzer".
- `docs/` updated to the current architecture: both share backends, the `zxterm-core` sidecar,
  and distribution without an OTA updater.
- The keyboard has two states and no third. *Search* lasts while the search box has the focus:
  the session list shows its sections and matches, and the status line always reads "Search:
  ⬆️/⬇️ profiles · Enter/Shift+Enter matches · Esc exit" (with "[M / N]" in front when there are
  matches and "· ^R resume · ^D delete" while the shown session has ended). A click on a row, a
  toolbar button, Ctrl+Shift+B, Ctrl+R, Ctrl+D and a dialog or menu opened meanwhile keep the focus
  in the box. Enter and Shift+Enter in the box only step through the matches; they no longer resume
  an ended session (Ctrl+R does). *Terminal* is every other moment: giving the terminal the focus,
  a new or joined session or Ctrl+1 to Ctrl+9 end the search (its text comes back on the box's next
  focus); Esc ends it and forgets the text. While a search walk has left the first row, its heading
  reads "Search started here" instead of "Current session".
- Ctrl+PgUp and Ctrl+PgDn outside the search box walk the whole session list in the order drawn and
  wrap round at either end.

### Fixed

- Typing in a live session with a long history lagged, worst while it printed: the scrubber's marks
  were rebuilt from the whole timeline on every output chunk. They are now redrawn at most once per
  frame (once per 250 ms while output arrives) from cached inputs.
- The engine rewrote a live session's whole `timeline.json` after every recorded packet (tens of MB
  on a long session), stalling live output. It is now written at most once a second and at once on
  exit or close; a timeline found shorter than its log on load is caught up from the log.
- Switching to a session with a long history took up to seconds: every open shipped its whole
  timeline. `session.open` and `player.open` take an optional `timeline: 'lazy'` and the new
  `session.timeline` invoke serves the timeline in slices, which the renderer caches per session
  and fetches after the frame is drawn; playback controls stay disabled until it is in. A burst of
  switch keys ends on the session that many steps away, drawn correctly, never an older switch's
  frame.
