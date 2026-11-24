#!/usr/bin/env bash
# R5 settings menu — proves R5, R6, R7: each "Edit new profile defaults…" item of the settings menu has the stamp icon at its left; choosing one opens the profile dialog with Advanced already open (its trigger chosen); "STUN/TURN servers…" and "ZBTerm relay access key…" have icons; an ordinary profile's Edit (not a template) still opens with Advanced closed.
# Asserts: settings-menu items whose label starts "Edit new profile defaults": three, each icon fa-stamp, iconVisible, icon left of the label; STUN/TURN icon fa-tower-broadcast, relay icon fa-server, both visible; for each template item (a real click): a session-editor dialog whose trigger select (#sessionEditorTrigger) lies inside the open Advanced box and holds a trigger, then Cancel; the row Edit of a plain profile: #sessionEditorTrigger outside the (closed) Advanced box.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R5_settings_menu
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_if.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks on the private display"
set -x
start_app
win_size 1280 800
p="$(seed_session plain 'echo P""READY' PREADY)"

m="$(menu)"; echo "$m"
jq -e '[.[] | select(.label | startswith("Edit new profile defaults"))] as $t
  | ($t | length) == 3
  and ($t | all(.icon == "fa-stamp" and .iconVisible and .iconRect.right <= .rect.left + 40))' <<<"$m"
jq -e '[.[] | select(.label == "STUN/TURN servers…")][0] | .icon == "fa-tower-broadcast" and .iconVisible' <<<"$m"
jq -e '[.[] | select(.label == "ZBTerm relay access key…")][0] | .icon == "fa-server" and .iconVisible' <<<"$m"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R5_menu.png" >/dev/null
close_menu

editor_open() { state | jq -e '.modal.kind == "session-editor"' >/dev/null; }
# Advanced is open when the trigger select lies inside its box (a closed <details>
# still gives its content a rect, below the summary).
advanced_open() {
  local d t
  d="$(sty '.session-editor-advanced' | jq -c '.rect')"; t="$(sty '#sessionEditorTrigger' | jq -c '.rect')"
  echo "advanced $d trigger $t"
  jq -e -n --argjson d "$d" --argjson t "$t" '$t.height > 0 and $t.bottom <= $d.bottom + 0.5 and $t.top >= $d.top'
}
editor_gone() { state | jq -e '.modal == null' >/dev/null; }
for i in 0 1 2; do
  m="$(menu)"
  label="$(jq -r --argjson i "$i" '[.[] | select(.label | startswith("Edit new profile defaults"))][$i].label' <<<"$m")"
  click_rect "$(jq -c --arg l "$label" '[.[] | select(.label == $l)][0].rect' <<<"$m")"
  wait_until 15 editor_open
  advanced_open
  state | jq -e '[.modal.fields[] | select(.name == "trigger")][0].value != ""'
  [ "$i" = 0 ] && uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R6_advanced_open.png" >/dev/null
  cmd '{"command":"dialog-cancel"}' >/dev/null
  wait_until 10 editor_gone
done

# Not a template: Edit opens with Advanced closed, as before.
row_action "$p" edit >/dev/null
wait_until 15 editor_open
! advanced_open
cmd '{"command":"dialog-cancel"}' >/dev/null
echo "R5 settings menu: PASS"
