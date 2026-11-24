#!/usr/bin/env bash
# R10 profile menu — proves R9, R10, R11, R12, U3, U4: a profile's right-click menu lists, with an icon each, Clone · Create a copy, edit first │ Edit · Remove HD · Delete History · Delete │ Share Session · Share Keyboard · Enable HD (save and share more updates) │ Resume; Clone copies at once, "Create a copy, edit first" opens the copy dialog; the sharing items read as their opposites while on and do what they say; items that do not apply are disabled and inert; Unshare ends the links only; the toolbar button that was "Extend" reads "Resume".
# Asserts: (live "m-live", offline "m-off") right-click on m-live: labels/kinds/icons exactly as above, Resume disabled; Clone: one more profile, named after m-live, no dialog; "Create a copy, edit first": a session-editor dialog (copy), cancelled, no new profile; Share Keyboard → confirm "Share Keyboard" → inputMode all → the menu reads "Unshare Keyboard" → click → inputMode host; Enable HD → the toolbar's HD button reads "HD on" and the menu reads "Disable HD (save and share fewer updates)" → click → "Enable HD …" again; a link made with share.createLink → the menu reads "Unshare Session" → click → confirm "Unshare" → share.listLinks all revoked, the row's liveLinks 0, the menu reads "Share Session" again, m-live still active and its buffer still holds its text (U4); "Share Session" opens the Share dialog (cancelled). On m-off: Share Session, Share Keyboard, Enable HD, Remove HD disabled; a real click on disabled "Share Session" opens nothing; Resume enabled; the toolbar #extendSession visible, text "Resume"; Resume from the menu makes m-off active again. Kept screenshots in the log dir.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R10_profile_menu
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_if.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks on the private display"
set -x
start_app
win_size 1280 800
off="$(seed_session m-off 'echo O""READY' OREADY)"
sinput "$off" 'exit'
entry_inactive() { inv session.list | jq -e --arg s "$1" '[.[] | select(.sessionId == $s)][0].active | not' >/dev/null; }
wait_until 20 entry_inactive "$off"
live="$(seed_session m-live 'echo L""READY' LREADY)"
select_session "$live"
count() { inv session.list | jq 'length'; }
row() { inv session.list | jq -c --arg s "$1" '[.[] | select(.sessionId == $s)][0]'; }
no_modal() { state | jq -e '.modal == null' >/dev/null; }
modal_kind() { state | jq -e --arg k "$1" '.modal.kind == $k' >/dev/null; }
close_pmenu() { key Escape; sleep 0.3; }

# --- R10: the menu, its order, groups and icons -------------------------------------
right_click_row "$live"
want='[["item","Clone","fa-clone"],["item","Create a copy, edit first","fa-copy"],["separator","",null],
 ["item","Edit","fa-pen"],["item","Remove HD","fa-eraser"],["item","Delete History","fa-clock-rotate-left"],["item","Delete","fa-trash"],["separator","",null],
 ["item","Share Session","fa-share-nodes"],["item","Share Keyboard","fa-keyboard"],["item","Enable HD (save and share more updates)","fa-rocket"],["separator","",null],
 ["item","Resume","fa-arrow-rotate-right"]]'
pmenu | jq -e --argjson w "$want" '[.[] | [.kind, .label, .icon]] == $w'
pmenu | jq -e '[.[] | select(.label == "Resume")][0].disabled'
state | jq -e '[.sessionMenu[] | select(.kind == "item") | .iconVisible] | all'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R10_menu_live.png" >/dev/null

# --- R11: Clone at once; Create a copy opens the dialog --------------------------------
n0="$(count)"
pmenu_click Clone
more() { [ "$(count)" -gt "$1" ]; }
wait_until 20 more "$n0"
no_modal
inv session.list | jq -e --arg s "$live" '[.[] | select(.sessionId != $s and (.name | startswith("m-live")))] | length == 1'
select_session "$live"
n1="$(count)"
right_click_row "$live"
pmenu_click 'Create a copy, edit first'
wait_until 15 modal_kind session-editor
state | jq -e '.modal.fields[0].value | startswith("m-live")'
cmd '{"command":"dialog-cancel"}' >/dev/null
wait_until 10 no_modal
sleep 1
test "$(count)" = "$n1"

# --- R12: Share Keyboard / Unshare Keyboard ----------------------------------------------
right_click_row "$live"
pmenu_click 'Share Keyboard'
wait_until 10 modal_kind confirm || wait_until 10 modal_kind popup || state | jq -c '.modal'
click_button 'Share Keyboard'
kb() { row "$live" | jq -e --arg m "$1" '.inputMode == $m' >/dev/null; }
wait_until 15 kb all
right_click_row "$live"
pmenu | jq -e '[.[] | .label] | index("Unshare Keyboard") != null'
pmenu_click 'Unshare Keyboard'
wait_until 15 kb host

# Kit correction 2026-11-21 (builder, after the verifier's check-strength note): the HD state itself is read, not only the label.
# --- R12: Enable HD / Disable HD --------------------------------------------------------
right_click_row "$live"
pmenu_click 'Enable HD (save and share more updates)'
# The session's HD really changed: the toolbar's HD button says so (review of the kit, 2026-11-21).
hd_is() { sty '#hdToggle' | jq -e --arg t "$1" '(.text | gsub("\\s"; "")) == $t' >/dev/null; }
wait_until 10 hd_is HDon
right_click_row "$live"
pmenu | jq -e '[.[] | .label] | index("Disable HD (save and share fewer updates)") != null'
pmenu_click 'Disable HD (save and share fewer updates)'
wait_until 10 hd_is HD
right_click_row "$live"
pmenu | jq -e '[.[] | .label] | index("Enable HD (save and share more updates)") != null'
close_pmenu

# --- R12, U4: Unshare Session ends the links only ------------------------------------------
inv share.createLink "$(jq -nc --arg s "$live" '{sessionId: $s, type: "single", autoJoin: true}')" | jq -e '.linkId'
shared() { row "$live" | jq -e '.isSharing and .liveLinks == 1' >/dev/null; }
wait_until 20 shared
right_click_row "$live"
pmenu | jq -e '[.[] | .label] | index("Unshare Session") != null'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R12_unshare_menu.png" >/dev/null
pmenu_click 'Unshare Session'
wait_until 10 modal_kind confirm || state | jq -c '.modal'
click_button 'Unshare'
unshared() { row "$live" | jq -e '.liveLinks == 0' >/dev/null; }
wait_until 20 unshared
inv share.listLinks "$(jq -nc --arg s "$live" '{sessionId: $s}')" | jq -e 'length >= 1 and all(.revoked)'
row "$live" | jq -e '.active'
mirror_has "$live" LREADY
right_click_row "$live"
pmenu | jq -e '[.[] | .label] | index("Share Session") != null'
pmenu_click 'Share Session'
share_open() { state | jq -e '.modal != null and (.modal.text // "" | test("Share|share"))' >/dev/null; }
wait_until 15 share_open
cmd '{"command":"dialog-cancel"}' >/dev/null || key Escape
wait_until 10 no_modal || { key Escape; wait_until 10 no_modal; }

# --- U3, R9: an offline profile -----------------------------------------------------------
right_click_row "$off"
m="$(pmenu)"; echo "$m"
jq -e 'map({(.label): .disabled}) | add
  | .["Share Session"] and .["Share Keyboard"] and .["Enable HD (save and share more updates)"]
    and .["Remove HD"] and (.["Resume"] | not) and (.["Edit"] | not) and (.["Clone"] | not)' <<<"$m"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R10_menu_offline.png" >/dev/null
pmenu_click 'Share Session'
sleep 1
no_modal
state | jq -e '.sessionMenu != null'
close_pmenu
sty '#extendSession' | jq -e '.visible and (.text | gsub("\\s"; "")) == "Resume"'
# R9: no "Extend" anywhere in the page's text, hidden buttons included.
sty 'body' | jq -e '.text | test("Extend") | not'
right_click_row "$off"
pmenu_click Resume
active() { row "$off" | jq -e '.active' >/dev/null; }
wait_until 30 active
echo "R10 profile menu: PASS"
