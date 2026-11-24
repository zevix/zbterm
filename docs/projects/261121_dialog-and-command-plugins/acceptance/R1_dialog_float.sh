#!/usr/bin/env bash
# R1 dialog float — proves R1, R2, R3, U4: with no identity the identity button's tooltip is "Choose your identity"; once a GitHub identity is set it is "<user>@github.com", and so is the settings menu's identity item while the profile list is collapsed. The profile dialog has a title ("Edit profile") with a drag icon at its left, does not dim or block the app, moves when its title is dragged and stays inside the window; it stays open while the user double-clicks a path in the terminal (copy on select), types in the terminal (the keys reach the shell) and presses Esc there; the path pastes into the dialog's Shell Command field; Esc inside the dialog closes it.
# Asserts: #identitySetup title "Choose your identity", then "zbdp-r1@github.com"; collapsed, a settings-menu item labelled "zbdp-r1@github.com" with icon fa-id-badge. Edit dialog: heading "Edit profile", the grip visible and left of the heading, the layer transparent with pointer-events none. A real drag of the title by (+180, +60): the dialog's rect moves by that (±3 px); a drag to the window's bottom-right corner: the dialog stays inside (right <= innerWidth - 7, top <= innerHeight - 47). A real double-click on "/srv/zb/the-path-XYZ" in the terminal: the dialog still open, the terminal focused; typed "echo TYPED""-OK" + Enter shows TYPED-OK; Esc in the terminal: still open; a click in the Shell Command field, Ctrl+A, Ctrl+V: its value is "/srv/zb/the-path-XYZ"; Esc in the field: the dialog is gone. Kit corrections 2026-11-21 (builder P1, C6/C7): after the corner drag the panel is wholly inside the window (7 px), also at 900x480 where its OK button is on screen inside the panel; " EDITED" typed in Name, then New: the Edit dialog stays with "pathy EDITED" and the status says "Close the open profile dialog first"; an untouched Edit dialog is replaced by New.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R1_dialog_float
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_dp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks, drags and keys on the private display"
need ssh-keygen "makes the throwaway identity key"
need python3 "serves the stand-in <user>.keys endpoint"
set -x
user=zbdp-r1
# As 261110_ui-chrome R6: a throwaway key, published by a local stand-in for github.com/<user>.keys.
mkdir -p "$ZBUI_APP_HOME/.ssh"; chmod 700 "$ZBUI_APP_HOME/.ssh"
ssh-keygen -q -t ed25519 -N '' -C "$user@zbdp-kit" -f "$ZBUI_APP_HOME/.ssh/id_ed25519"
fp="$(ssh-keygen -lf "$ZBUI_APP_HOME/.ssh/id_ed25519.pub" | awk '{print $2}')"
keys="$ZBUI_APP_HOME/keys-www"; mkdir -p "$keys"
cp "$ZBUI_APP_HOME/.ssh/id_ed25519.pub" "$keys/$user.keys"
kport="$(free_port)"
start_app_with_keys() {
  run_bg python3 -m http.server "$kport" --bind 127.0.0.1 --directory "$keys"
  ZBUI_APP_ENV=("ZBTERM_GITHUB_KEYS_BASE=http://127.0.0.1:$kport")
  start_app
}
start_app_with_keys
win_size 1400 800

# --- R1: the identity's name -------------------------------------------------------------
sty '#identitySetup' | jq -e '.title == "Choose your identity"'
cmd '{"command":"identity-open"}' >/dev/null
cmd '{"command":"identity-choose","provider":"github"}' >/dev/null
cmd "{\"command\":\"identity-username\",\"value\":\"$user\"}" >/dev/null
key_listed() { cmd '{"command":"modal-state"}' | jq -e --arg fp "$fp" 'any(.identity.candidates[]?; .fingerprint == $fp and .onProvider)'; }
wait_until 30 key_listed
cmd "{\"command\":\"identity-select-key\",\"fingerprint\":\"$fp\"}" >/dev/null
cmd '{"command":"identity-submit"}' >/dev/null
is_github() { api GET /identity | jq -e '.provider == "github"'; }
wait_until 30 is_github
titled() { sty '#identitySetup' | jq -e --arg t "$user@github.com" '.title == $t'; }
wait_until 10 titled
collapse_pane
menu | tee "$ACCEPT_LOG_DIR/R1_menu.json" | jq -e --arg t "$user@github.com" \
  'any(.[]; .label == $t and (.icon // "" | contains("fa-id-badge")))'
menu | jq -e 'all(.[]; .label != "Choose your identity")'
close_menu
expand_pane

# --- R2: the floating dialog -------------------------------------------------------------
a="$(seed_session pathy 'echo /srv/zb/the-path-XYZ; echo P""READY' PREADY)"
select_session "$a"
row_action "$a" edit >/dev/null
e="$(editor)"; echo "$e"
jq -e '.open and .heading == "Edit profile" and .gripVisible' <<<"$e"
jq -e '.gripRect.right <= .headingRect.left' <<<"$e"
jq -e '.overlay.backgroundColor == "rgba(0, 0, 0, 0)" and .overlay.pointerEvents == "none"' <<<"$e"
state | jq -e '.modal.kind == "session-editor" and .modal.title == "Edit profile"'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R1_dialog.png" >/dev/null
# Held by the title (right of the heading), dragged by (+180, +60).
r0="$(jq -c '.rect' <<<"$e")"
read -r hx hy < <(jq -r '.titleRect | "\((.right - 60) | floor) \((.top + .height / 2) | floor)"' <<<"$e")
drag_xy "$hx" "$hy" $((hx + 180)) $((hy + 60))
r1="$(editor | jq -c '.rect')"; echo "$r1"
jq -e --argjson a "$r0" --argjson b "$r1" \
  '(($b.left - $a.left - 180) | fabs) <= 3 and (($b.top - $a.top - 60) | fabs) <= 3' <<<null
# Dragged into the corner: kept inside the window.
read -r hx hy < <(editor | jq -r '.titleRect | "\((.right - 60) | floor) \((.top + .height / 2) | floor)"')
drag_xy "$hx" "$hy" 1395 795
w="$(sstate | jq -c '.window')"
editor | jq -e --argjson w "$w" '.rect.right <= $w.innerWidth - 7 and .rect.top <= $w.innerHeight - 47 and .rect.left >= 8'
# Kit correction 2026-11-21 (builder P1): design C7 (F7, A-7 "fully inside"): after the drag
# the whole panel is inside the window, and stays so when the window shrinks to 900x480,
# with its OK button on screen. Added; the check above is unchanged.
inside() {
  local w; w="$(sstate | jq -c '.window')"
  editor | jq -e --argjson w "$w" '.rect.left >= 7 and .rect.top >= 7
    and .rect.right <= $w.innerWidth - 7 and .rect.bottom <= $w.innerHeight - 7'
}
inside
win_size 900 480
sstate | jq -e '.window.innerWidth <= 900 and .window.innerHeight <= 480'
wait_until 5 inside
ok_on_screen() {
  local w r; w="$(sstate | jq -c '.window')"; r="$(editor | jq -c '.rect')"
  sty '.session-editor .session-editor-actions button[type="submit"]' | jq -e --argjson w "$w" --argjson p "$r" \
    '.visible and .rect.top >= $p.top and .rect.bottom <= $p.bottom + 1
     and .rect.top >= 0 and .rect.bottom <= $w.innerHeight and .rect.right <= $w.innerWidth'
}
ok_on_screen
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R1_small_window.png" >/dev/null
win_size 1400 800
wait_until 5 inside
# Back to the right-hand side, clear of the terminal's first lines.
read -r hx hy < <(editor | jq -r '.titleRect | "\((.right - 60) | floor) \((.top + .height / 2) | floor)"')
drag_xy "$hx" "$hy" 1300 300
editor | jq -e '.open and .rect.top >= 200'

# --- R3, U4: the dialog stays open while the terminal is used -----------------------------
row="$(api GET /renderer/terminal-display | jq -c '(.terminal // .renderer).visibleRows[] | select(.trimmedText == "/srv/zb/the-path-XYZ") | .rect')"
x="$(jq -r '(.left + 40) | floor' <<<"$row")"; y="$(jq -r '(.top + .height / 2) | floor' <<<"$row")"
mouse_to "$x" "$y"; xdo click --repeat 2 --delay 80 1; sleep 0.6
state | jq -e '.modal.kind == "session-editor"'
sstate | jq -e '.terminalFocused and (.activeInModal | not)'
xdo type --delay 30 -- 'echo TYPED""-OK'; key Return
wait_until 10 term_has TYPED-OK
key Escape; sleep 0.4
state | jq -e '.modal.kind == "session-editor"'
field='.launch-step[data-plugin="shell"] input'
click_sel "$field"
key ctrl+a; key ctrl+v; sleep 0.4
cmd '{"command":"launch-state"}' | jq -e '.steps[1].config.command == "/srv/zb/the-path-XYZ"'
# Kit correction 2026-11-21 (builder P1): design C6 (F6, Q-2): a dialog with changes is kept
# when another is asked for (New), with its text, and a status line says why. Added.
click_sel '#sessionEditorName'
key End; xdo type --delay 30 -- ' EDITED'; sleep 0.3
state | jq -e '.modal.kind == "session-editor" and .modal.title == "Edit profile"'
cmd '{"command":"click","selector":"#newSession"}' >/dev/null; sleep 1.5
state | tee "$ACCEPT_LOG_DIR/R1_second_open.json" \
  | jq -e '.modal.kind == "session-editor" and .modal.title == "Edit profile"'
state | jq -e 'any(.modal.fields[]; (.name == "name") and .value == "pathy EDITED")'
sty '#status' | jq -e '.text == "Close the open profile dialog first"'
key Escape; sleep 0.4
state | jq -e '.modal == null'
# ... and one without changes is replaced by the new one.
row_action "$a" edit >/dev/null
wait_until 10 _zbui_modal_open
state | jq -e '.modal.title == "Edit profile"'
cmd '{"command":"click","selector":"#newSession"}' >/dev/null
new_open() { state | jq -e '.modal.kind == "session-editor" and .modal.title == "New profile"' >/dev/null; }
wait_until 10 new_open
key Escape; sleep 0.4
state | jq -e '.modal == null'
echo "R1 dialog float: PASS"
