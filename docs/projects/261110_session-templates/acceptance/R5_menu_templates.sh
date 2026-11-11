#!/usr/bin/env bash
# R5 menu_templates — proves R5: the settings menu has the three 'Edit new profile defaults…' items, a separator above and below, and each opens its own trigger's template in the dialog.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/../../261110_ui-chrome/acceptance/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
l1='Edit new profile defaults'
l2='Edit new profile defaults for CTRL+SHIFT+t'
l3='Edit new profile defaults for Shift + "+ New" button'
s="$(cmd '{"command":"settings-open"}')"
jq '.menu' <<<"$s"
# The three items, in a section of their own: a separator above and below.
jq -e --arg a "$l1" --arg b "$l2" --arg c "$l3" '.menu as $m | ($m | map(.label) | index($a)) as $i
  | $i != null and $i > 0 and $m[$i - 1].kind == "separator"
  and $m[$i].label == $a and $m[$i + 1].label == $b and $m[$i + 2].label == $c
  and $m[$i + 3].kind == "separator"' <<<"$s"
cmd '{"command":"click","selector":"#settingsToggle"}' >/dev/null
# Each opens its own trigger's template in the dialog.
d="$ZBUI_APP_HOME"
new_profile 'r5 new' "$d" 'bash' true "$ZBUI_CHOICE_NEW" false
new_profile 'r5 ctrl' "$d" 'sh' true "$ZBUI_CHOICE_CTRL_SHIFT_T" true
new_profile 'r5 shift' "$d" 'bash --norc' true "$ZBUI_CHOICE_SHIFT_NEW" true
for pair in "$l1|r5 new|bash" "$l2|r5 ctrl|sh" "$l3|r5 shift|bash --norc"; do
  IFS='|' read -r label name command <<<"$pair"
  cmd '{"command":"settings-open"}' >/dev/null
  s="$(open_dialog "$(jq -nc --arg l "$label" '{command: "settings-click", label: $l}')")"
  jq '.modal' <<<"$s"
  jq -e --arg n "$name" --arg c "$command" '.modal.kind == "session-editor"
    and ([.modal.fields[] | select(.name == "name")][0].value == $n)
    and ([.modal.fields[] | select(.name == "command")][0].value == $c)' <<<"$s"
  cmd '{"command":"dialog-cancel"}' >/dev/null
done
