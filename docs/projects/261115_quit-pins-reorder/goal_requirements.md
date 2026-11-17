# Quit, pins, reorder, offline navigation, relay — goal and requirements (the WHAT)

**Project:** `261115_quit-pins-reorder` · **Area:** `electron/`, `renderer/`, `engine/`, `relay/`, `scripts/build-relay.js`, README · **Written:** 2026-11-15 · **Notes:** `notes--context.md`

## Goal

Make Ctrl+Q safe, make pins survive a quit, let the user put sessions in any order by dragging,
stop keyboard navigation from silently resuming ended sessions, and cut running a relay down to
starting a single program. Checked on a scratch packaged app under `uisolate` on host `zr`, and on
`relay/server.js` running with a scratch HOME. Reference program: `acceptance/run_all.sh`.

## Requirements

| id | hard/soft | the system shall … (one testable sentence) | check |
|---|---|---|---|
| R1 | hard | when Ctrl+Q is pressed while the terminal does not have the focus, show a popup with three buttons, Quit, Cancel and "Send ^Q to the terminal", and not quit | `acceptance/R1_quit_popup.sh` |
| R2 | hard | in that popup, Quit quits the app; Cancel (and Esc) closes the popup and changes nothing; "Send ^Q to the terminal" sends the byte 0x11 to the selected live session and puts the focus in the terminal | `acceptance/R1_quit_popup.sh` |
| R3 | hard | when Ctrl+Q is pressed while the terminal has the focus, send 0x11 to the session as any other key, with no popup and no quit | `acceptance/R1_quit_popup.sh` |
| R4 | hard | keep the pinned sessions, and their order, across a quit (through the R1 popup, the window's close button, or SIGTERM) and the next start, also when the next start is another app version, lists no sessions or only some of them for a while, or switches profile; a pin is dropped only when the user unpins it or deletes its session | `acceptance/R4_pins_kept.sh` |
| R5 | hard | while the pointer is over a session row's left icon (the terminal or view icon), show a drag-handle icon in its place, near-white in the dark theme and near-black in the light theme | `acceptance/R5_drag_reorder.sh` |
| R6 | hard | let the user drag a row by that handle to another place in the list, with a drop marker between rows, and keep the new order across a restart | `acceptance/R5_drag_reorder.sh` |
| R7 | hard | order unpinned sessions by a new catalog field, `sortAt` (a manual "pseudo time" in ms), used instead of the session's last start time when it is set; when a row is dropped, set its `sortAt` to the midpoint of the sort times of the rows above and below it, or, at the top, the first row's time + 42 min, and at the bottom, the last row's time − 42 min (the list is newest first) | `acceptance/R5_drag_reorder.sh` |
| R8 | hard | when a pinned row is dragged among the pinned rows, change the pin order, not `sortAt` | `acceptance/R5_drag_reorder.sh` |
| R9 | hard | when Ctrl+PgUp/Ctrl+PgDn (and the other session-switching keys) land on an offline session outside search, do as R15 of `261114_live-output-and-fixes` does in search: show it in playback, do not resume it, and show the resume toast | `acceptance/R9_offline_nav.sh` |
| R10 | hard | let Enter resume such an offline session, as Ctrl+R does: in the terminal outside search, and in the search box (there only while that session's resume toast shows, so Enter still steps through matches otherwise); the toast reads "Press ^R or Enter to resume the session" | `acceptance/R9_offline_nav.sh` |
| R11 | hard | run a private relay as one program, `zbterm-relay`, with two keys: a relay secret (never leaves the box) and a public access key (what users paste); `zbterm-relay-registry-publish` and `relay/registry-publish.js` are removed (`scripts/build-relay.js`, `build_all.sh`, README) | `acceptance/R11_relay_keys.sh` |
| R12 | hard | take the relay secret from `ZBTERM_RELAY_SEED`, else `~/.zbterm/relay-secret`; when neither exists, make one, write it there (mode 0600, the directory 0700) and say so in an info line | `acceptance/R11_relay_keys.sh` |
| R13 | hard | derive the key pair the relay listens on from the secret and a rotation salt kept in `~/.zbterm/relay-access` (made the same way when missing); its public key is the access key, so only someone who holds it can reach the relay | `acceptance/R11_relay_keys.sh` |
| R14 | hard | when a file exists and the matching variable (`ZBTERM_RELAY_SEED`, `ZBTERM_RELAY_ACCESS_SALT`) holds a different value, use the variable for this run, leave the file as it is, and print a note that says so | `acceptance/R11_relay_keys.sh` |
| R15 | hard | when a file exists and no variable is given, check it (64 hex characters) and use it; a file that fails the check stops the relay with an error naming the file, and is never overwritten | `acceptance/R11_relay_keys.sh` |
| R16 | hard | print, on start, the one line a user needs: "ZBTerm relay access key: <key>" (paste it into ZBTerm's settings) | `acceptance/R11_relay_keys.sh` |
| R17 | hard | have `zbterm-relay --rotate-access-key` write a new salt, print the new access key, and make a running relay switch to it (it watches the file), so the old key stops reaching the relay | `acceptance/R11_relay_keys.sh` |
| R18 | hard | add "ZBTerm relay access key…" to the settings menu, below "STUN/TURN servers…": a field where the user pastes that key; it is checked (64 hex), saved install-wide, and used as the relay to fall back to instead of the one the built-in registry names; empty means the default; `ZBTERM_RELAY_PUBLIC_KEY` still wins | `acceptance/R18_relay_setting.sh` |
| R19 | hard | show the relay's state in the "ZBTerm relay access key…" dialog and in the Share dialog, one line: where the key comes from (default registry, setting, `ZBTERM_RELAY_PUBLIC_KEY`, or none), and whether the relay was found on the DHT (looking, found, not found) and has relayed a connection this run | `acceptance/R18_relay_setting.sh` |
| R20 | hard | have `zbterm-relay --print-key` print the access key line and exit, and `zbterm-relay --check` check both files (and the variables) and exit 0 when they are usable, non-zero with the reason otherwise; neither writes a file nor opens the network | `acceptance/R11_relay_keys.sh` |
| R21 | hard | print a warning on start when the relay's DHT node reports itself firewalled (its UDP port not reachable from outside); README carries a systemd unit example for the relay | `acceptance/R11_relay_keys.sh` |
| R22 | soft | fix the comments that name `engine/share-manager.js` or `relay/registry-publish.js` as where the registry key or publishing lives | review |
| R23 | hard | from the press on a row's drag handle until the drag ends (drop, Escape, cancel), show the hand (`grab`) cursor wherever the pointer is in the window | `acceptance/R5_drag_reorder.sh` |
| R24 | hard | once the pointer moves, take the dragged row out of the list (its neighbours close up) and show it as a copy on a layer above everything, following the pointer freely anywhere inside the app window | `acceptance/R5_drag_reorder.sh` |
| R25 | hard | mark the place the row would land with a bold dashed line (at least 3 px) between the two rows it would go between (above the first or below the last at the ends), not on a row | `acceptance/R5_drag_reorder.sh` |
| R26 | hard | offer the row's own former place as one of those gaps, marked the same way; a drop there changes nothing | `acceptance/R5_drag_reorder.sh` |
| R27 | hard | on release, fly the copy with a quick animation (about 180 ms) into its gap and put the row back in the list there; a release with no gap (off the list, off its group) or Escape flies it back to its former place | `acceptance/R5_drag_reorder.sh` |
| R28 | hard | when Ctrl+PgUp/Ctrl+PgDn select another session, scroll the session list so the selected row is fully in view | `acceptance/R28_nav_scroll_f2.sh` |
| R29 | hard | map F2 (no modifiers) to editing the selected session's profile, as its row's Edit button does, from anywhere in the window but an open dialog; add "F2 for edit" to the settings menu right below "Copy on select", checked by default, saved install-wide; unchecked, F2 goes to the terminal | `acceptance/R28_nav_scroll_f2.sh` |
| R30 | hard | name R29's setting "Map F2 to edit profile" (was "F2 for edit"); same place, default and saved key | `acceptance/R28_nav_scroll_f2.sh` |
| R31 | hard | while a row is dragged, always show the dashed line at one gap of the row's group, wherever the pointer is in the window: the gap nearest the pointer, including above the group's first row, below its last, and the row's own place when it is the only row of its group; a release drops the row into the gap shown (a drop in its own place changes nothing); only Escape (or a lost pointer) flies it home. Replaces R27's "a release with no gap" and U2's "outside the list" | `acceptance/R5_drag_reorder.sh` |
| R32 | hard | draw the size-lock button in the top bar exactly as tall as the font-size buttons beside it (wide and narrow window) | `acceptance/R32_ui_tweaks.sh` |
| R33 | hard | in the profile editor's Advanced part, show the stamp icon (the session list's template mark) on the left of the "default for new sessions" dropdown, the dropdown on its right in the same row | `acceptance/R32_ui_tweaks.sh` |
| R34 | hard | draw the in-session search highlights as xterm decorations tied to the buffer lines they mark (one marker per highlighted row), registered when a scan finds them and kept while the view scrolls: scrolling the terminal (wheel, scrollbar, Shift+PgUp/PgDn) neither disposes nor registers any highlight; a new scan changes only the rows whose highlights differ | `acceptance/R34_search_highlights.sh` |
| R35 | hard | on the alternate screen (vim, less), use the same decorations, kept current after every write: rows whose highlights are unchanged (text that moved with a scroll and kept its marker included) keep theirs, rows with new text get theirs, rows that left the screen lose theirs; no row shows a highlight its text does not have for longer than one frame after the write is drawn (checked: 150 ms) | `acceptance/R34_search_highlights.sh` |
| R36 | hard | bound the highlights: at most 2000 highlighted rows; with more, the rows within three screens of the view, re-chosen when the view nears that window's edge; on a switch between the normal and the alternate screen every highlight is disposed before the other screen draws; a resize re-scans (wrapped rows move) | `acceptance/R34_search_highlights.sh` |
| R37 | hard | when the edit dialog opens on a profile that is a template (holds a trigger), open its Advanced part; a plain profile's stays closed. Replacing a hidden or deleted template, the warning reads `"<name>" (hidden or deleted) is the current template for new sessions when you …; this profile will replace it.` | `acceptance/R37_tweaks3.sh`, `261110_session-templates/acceptance/U2_template_warnings.sh` |
| R38 | hard | while searching, end every section heading but "Current session" with a link: "(hide)" in the match cyan, dimmer and underlined, drops the section's rows (the heading stays, the arrows skip them); "(show)", bright, brings them back; a hidden section stays hidden for the rest of the run | `acceptance/R37_tweaks3.sh` |
| R39 | hard | offer "Map Ctrl+1 to Ctrl+9 to pinned profiles" in the settings menu right above "Map F2 to edit profile", on by default, remembered install-wide; on, Ctrl+N selects the Nth pinned profile (pin order, pending joins left out) as a click on its row does; with no Nth pin, or off, the chord is the terminal's; a dialog leaves it alone | `acceptance/R37_tweaks3.sh` |
| R40 | hard | while R39 is on, show each of the first nine pinned rows' number (1–9) left of its pin icon | `acceptance/R37_tweaks3.sh` |
| R41 | hard | draw the offline dot screen at the opacity the history screen had (0.25), and the history screen at 70% of that (0.175), in both themes | `test/renderer-static.test.js` |
| R42 | hard | replace the Share dialog's "until we add user authentication" warning with one that follows its options (approval, verified-only, link type), add "Only verified people can join" (the host refuses a requester with no verified identity, on Pear and Freenet), and word the approval dialog's unidentified-requester line plainly | `acceptance/R42_share_warning.sh`, `test/identity-handshake.test.js`, `test/backends/freenet-session.test.js`, `test/renderer-static.test.js` |
| R43 | hard | while a pinned row is dragged, every pin's Ctrl+N number (the dragged row's too) shows the one it would have if let go at the gap shown, Escape restoring the old ones; the dragged row's pin and number are white in dark mode, black in light | `acceptance/R43_drag_pin_numbers.sh` |
| R44 | hard | widen the drag handle's hit area past the row's left icon (the row's left padding and part of the gap to the name, full row height) | `acceptance/R43_drag_pin_numbers.sh`, `acceptance/R5_drag_reorder.sh` |
| R45 | hard | with no default relay key to name (the registry gave none), the relay line reads "Relay (default): N/A"; the Share dialog's "Require approval to join" and "Only verified people can join" lines end in a dot, orange while unticked, green while ticked | `acceptance/R42_share_warning.sh`, `acceptance/R18_relay_setting.sh` |

### Unwanted behaviour (mandatory)

| id | hard/soft | if … (the wrong input, state or host) | the system shall … | check |
|---|---|---|---|---|
| U1 | hard | Ctrl+Q while the popup is already open, or "Send ^Q" with no live session selected | do nothing more (no second popup); the Send button is disabled | `acceptance/R1_quit_popup.sh` |
| U2 | hard | a drop onto the row itself, outside the list, from an unpinned row into the pinned rows (or back), or a drag while the search box holds text | change nothing (no drag handle while searching) | `acceptance/R5_drag_reorder.sh` |
| U3 | hard | a catalog entry with no `sortAt` (every session today), or an engine that does not know the field | sort exactly as today | `acceptance/R5_drag_reorder.sh` |
| U4 | hard | a relay key typed into the setting that is not 64 hex characters | refuse it with a message; keep the old value | `acceptance/R18_relay_setting.sh` |
| U5 | hard | `~/.zbterm` or a key file cannot be written (read-only HOME) | run with the generated key, print it and an error that it was not saved (the key will change on restart) | `acceptance/R11_relay_keys.sh` |
| U6 | hard | a highlight registered on one screen (normal or alternate) | never show on the other: all are disposed in the buffer switch's own event | `acceptance/R34_search_highlights.sh` |

## Out of scope

- Authorized relay users and managing the relay from ZBTerm's UI (later versions, the user). macOS (Cmd+Q comes from the app menu there). A headless ZBTerm host. A change to the invite format
  (see notes, proposal P2). New dependencies (the user allowed one for R34–R36 on 2026-11-16;
  none was needed, see `design--search-highlights.md`).

## Approval

Rows R1–R8 are the user's items 1–3 (2026-11-15). R3 follows their answer "Send ^Q to terminal".
Rows R9–R18 and U4–U5 are items 4–5, added the same day; R11–R18 rewritten to the user's two-key model (relay secret + rotatable public access key; authorized users and UI management are for later versions). Approved by the user
2026-11-15 ("I approve your changed relay spec"), with proposals P3–P6 as R19–R22. R4 widened after
the user's scenario: "I lose pins when I change the AppImage version I use."
Rows R23–R29 are the user's review of the built app (2026-11-16): R23–R27 replace the first drag
look ("cheap and confusing"), R28 the list scroll on Ctrl+PgUp/PgDn, R29 F2 and its setting.
Rows R30–R36 and U6 are the user's second review (2026-11-16): R30 the setting's name, R31 "ALWAYS
show the dashed target location", R32 the lock button's height, R33 the stamp beside the dropdown,
R34–R36 the search highlights rebuilt on xterm's decorations ("design a solution that on scrolling
only adds markings where new text came into the frame, and if needed for memory accounting remove the
old markings"); design in `design--search-highlights.md`.
Rows R37–R41 are the user's third review (2026-11-16): R37 their items 1–2 (the warning's wording,
Advanced open on a template), R38 item 3, R39–R40 items 5–6, R41 item 4 ("still too strong").
R42 is the user's follow-up (2026-11-16): asked whether the Share warning should change now that
GitHub identities verify, they approved the proposed wording and the verified-only option ("yep go").

R43–R44 are the user's follow-up (2026-11-16): live pin numbers while reordering pins, the dragged pin in white/black, and an easier-to-hit drag handle.
R45 is the user's follow-up (2026-11-16): the relay line's wording, and a colour cue on the two safety options since only one warning case is red.
