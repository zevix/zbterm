# Quit, pins, reorder, offline navigation, relay — status

The file name is the state: `status--proposal` | `design` | `in-progress` | `verifying` | `done`.

## Now

2026-11-15: requirements R1–R22, U1–U5 approved by the user (P3–P6 became R19–R22). Pin loss on an
AppImage version change traced to the prune in `refreshSessions()` (notes) and removed.

Built: Ctrl+Q popup (renderer; main no longer quits on Ctrl+Q, `app.quit` invoke), pins never pruned
and written only once read for the profile, drag reorder (`sortAt` in the catalog, `session.update`,
contract row), offline Ctrl+PgUp/PgDn and Enter resume, `zbterm-relay` two-key rewrite
(`relay/keys.js`, registry-publish removed, `--rotate-access-key`, `--print-key`, `--check`, firewall
warning, registry only with `ZBTERM_REGISTRY_SEED`), the "ZBTerm relay access key…" setting and the
relay status line (`share.setRelayKey`, `share.relayStatus`), README and ARCHITECTURE updated.

2026-11-16, after the user's review: the drag rebuilt (R23–R27: hand cursor throughout, the row
lifted out into a ghost on a top layer that follows the pointer in the window, a bold dashed line in
the gap, its own place included, a 180 ms fly-in on release, fly home on Escape or no gap; renders
wait while a drag holds the rows), Ctrl+PgUp/PgDn scroll the list to the selection (R28), F2 edits
the selected session with the "F2 for edit" setting below "Copy on select" (R29). Kit: `R5` rewritten
for the new drag (`drag_lift`/`drag_move`/`drag_drop`), new `R28_nav_scroll_f2.sh`; `xkey_raw.py`
because xdotool sends F2 with Alt_L held on the private display (seen with xev).

2026-11-16, the user's second review (R30–R36, U6): the setting renamed "Map F2 to edit profile";
the drop line always shown (nearest gap of the row's group wherever the pointer is, its own place
when alone; a release drops there, only Escape flies home); the size lock as tall as the font
buttons; the stamp left of the template dropdown; the search highlights rebuilt on xterm
decorations (`renderer/search-highlights.js`, `design--search-highlights.md`): kept on scroll,
the alternate screen redone per write with per-row trackers, owned markers because xterm 6.0.0
leaks a decoration whose marker it disposes (Fable's review), a 2000-row cap around the view, the
overlay boxes removed. No dependency added (the user allowed `@xterm/addon-search`; its matcher would
disagree with the engine's counts). Kit: new `R32_ui_tweaks.sh`, `R34_search_highlights.sh`; `R5`,
`R28` and `261111_buffer-search/R2` changed (dated notes); unit `test/search-highlights.test.js`.

Checks, each passed alone on the scratch package: `R1_quit_popup`, `R4_pins_kept`, `R5_drag_reorder`,
`R9_offline_nav`, `R11_relay_keys`, `R18_relay_setting`; unit tests `test/catalog-sort.test.js`,
`test/relay-keys.test.js`. Not checked by a script: R21's firewall warning (seen once against the
public DHT by hand; the local testnet never reports firewalled), the window close-button quit path of
R4 (pins are written when pinned, not at quit), the `pkg`-built relay binary with `relay/keys.js`.

2026-11-16, checks on the final scratch package: the kit's run_all — R1, R4, R5, R9, R11, R18, R28,
R32 PASS, R34 failed on a kit bug (its 4500-row wait read `.inSession.total` off the in-session object
itself), fixed, and R34 then PASS alone; `261111_buffer-search` R2, R3, R10 PASS against this build;
`test/search-highlights.test.js` 11/11; lint clean; `test/renderer-static.test.js` only its two
earlier failures (credits newline, "the section is rendered last").

2026-11-16, the user's third review (R37–R41): the hidden-template warning reads "(hidden or
deleted) is the current template"; a template's edit dialog opens with Advanced shown; (hide)/(show)
links on the search sections; "Map Ctrl+1 to Ctrl+9 to pinned profiles" (above F2, on by default)
with the pin numbers; the dot screens fainter (offline 0.25, history 0.175). Kit: new
`R37_tweaks3.sh`; `R28` (the F2 item is now two below Copy on select) and
`261110_session-templates/U2` (the new wording) changed with dated notes; two static tests added, one
static check moved to `sessionSectionTitle` (dated note). README updated, including a stale line
about a drop away from the list (R31).

Checks on the scratch package: `R37_tweaks3`, `R28_nav_scroll_f2`, `261110_session-templates/U2`
and `261111_buffer-search/R2` PASS; lint clean; static tests only the two earlier failures. U2 failed
once on its delete step, before the changed line: the New dialog saves the template choice just
after the session appears (`createSessionFromEditor`), so a delete clicked in that gap shows no
template warning; it passed twice on rerun. Pre-existing, left as is.

## R42: the Share warning and verified-only links (2026-11-16)

The Share form's warning now follows its options (`shareWarning`): verified-only, approval on,
or no approval (red only for a group link that lets anyone in). New "Only verified people can
join" (`verifiedOnly` on `share.createLink`, stored on the link, listed): on Pear the host refuses
an unverified requester right after the identity gate (reason `unverified`); on Freenet such a link
is registered with the core as one that asks, and `_onCorePending` refuses it there (the core
reports the identity outcome before its pending event). The approval dialog's unidentified line is
plain prose. Viewer refusal text added. README link options updated.

Checks: `identity-handshake` 14/14 and `freenet-session` 14/14 (each with a new verified-only test),
`share-join-outcomes` 7/7, `share-manager` 10/10; static tests only the two earlier failures (one
test updated with a dated note, one added); lint clean; packaged build; `R42_share_warning.sh` PASS
on it.

## R43–R44 (2026-11-16)

- R43: `previewPinNumbers` (renderer/app.js) renumbers the pinned rows and the ghost on every pointer move of a pinned drag, and again on landing (Escape/home restores the old numbers); a pin pushed past the ninth loses its number, one pulled in gets one. Mid-drag a hovered row keeps its marks and shows no hover menu. The ghost's pin and number use `--drag-handle` (near-white dark, near-black light).
- R44: `.session-handle` is content-box with 8/6 px padding and matching negative margins: hit area 30 x 58 px instead of 16 x 58, icon in place.
- `style-of` reports `visibility`; `session-order`'s drag ghost reports `pinNumber` and `pinColor`.
- Results on the packaged build: R43_drag_pin_numbers PASS, R5_drag_reorder PASS, R37_tweaks3 PASS; lint clean. Not covered by a script: a tenth pin moving into the first nine.

## R45 and the ECONNRESET crash (2026-11-16)

- R45: `relayStatusText` returns "Relay (default): N/A" for source registry with no key and not found; `shareSafetyDot` adds the dot (`--warn` off, `--ok` on). R42_share_warning (extended) and R18_relay_setting PASS on the packaged build; lint clean.
- Crash: the user saw "Uncaught Exception: Error: read ECONNRESET at Pipe.onStreamRead" in the main process. `engine/client.js` had no 'error' listener on the worker IPC pipe (FramedStream over bare-sidecar); it now treats a pipe error as a worker failure (respawn path) and logs errors on the worker's stdio pipes. Test in `test/engine-client-pty.test.js` (fails without the fix with the same error). Why the worker dropped the pipe is not known: the user's debug_main.log was not read.
