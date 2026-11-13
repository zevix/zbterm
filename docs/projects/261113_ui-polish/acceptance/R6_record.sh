#!/usr/bin/env bash
# R6 record — proves R6: every 'Edit new profile defaults…' editor lets 'Record session' be changed, also when the template is a session that exists.
# Asserts: three profiles made through the New dialog, each the template of one trigger (+ New, CTRL+SHIFT+T, Shift + '+ New'), all recorded; for each of the three settings-menu items: the editor's 'Record session' box is enabled and ticked, the dialog says 'Applies to new sessions'; unticked and saved (OK), the item's editor opens again with the box unticked; ticked again and saved, it opens ticked; finally the '+ New' template is left unticked and the New dialog (a real '+ New' click) opens with 'Record session' unticked.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_up.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
l1='Edit new profile defaults'
l2='Edit new profile defaults for CTRL+SHIFT+t'
l3='Edit new profile defaults for Shift + "+ New" button'
d="$ZBUI_APP_HOME"
new_profile 'r6 new' "$d" 'bash' true "$ZBUI_CHOICE_NEW" false
new_profile 'r6 ctrl' "$d" 'sh' true "$ZBUI_CHOICE_CTRL_SHIFT_T" false
new_profile 'r6 shift' "$d" 'bash --norc' true "$ZBUI_CHOICE_SHIFT_NEW" false
open_editor() {
  menu >/dev/null
  open_dialog "$(jq -nc --arg l "$1" '{command: "settings-click", label: $l}')" | jq -c '.modal'
}
record_box() { jq -c '[.modal.fields[] | select(.label == "Record session")][0]'; }
for label in "$l1" "$l2" "$l3"; do
  s="$(open_editor "$label")"
  jq '{text, fields}' <<<"$s"
  jq -e '.kind == "session-editor" and (.text | contains("Applies to new sessions"))' <<<"$s"
  jq -e '[.fields[] | select(.label == "Record session")][0] | .disabled == false and .checked == true' <<<"$s"
  set_field 'Record session' false | jq -e '.set'
  cmd '{"command":"dialog-submit"}' | jq -e '.done'
  sleep 1
  s="$(open_editor "$label")"
  jq -e '[.fields[] | select(.label == "Record session")][0] | .disabled == false and .checked == false' <<<"$s"
  set_field 'Record session' true | jq -e '.set'
  cmd '{"command":"dialog-submit"}' | jq -e '.done'
  sleep 1
  s="$(open_editor "$label")"
  jq -e '[.fields[] | select(.label == "Record session")][0] | .checked == true' <<<"$s"
  cmd '{"command":"dialog-cancel"}' >/dev/null
  sleep 0.5
done
# The + New template unticked: the New dialog opens unticked.
open_editor "$l1" >/dev/null
set_field 'Record session' false | jq -e '.set'
cmd '{"command":"dialog-submit"}' | jq -e '.done'
sleep 1
click_sel '#newSession'
wait_until 15 _zbui_modal_open
s="$(state)"
jq '.modal.fields' <<<"$s"
jq -e '[.modal.fields[] | select(.label == "Record session")][0] | .checked == false and .disabled == false' <<<"$s"
