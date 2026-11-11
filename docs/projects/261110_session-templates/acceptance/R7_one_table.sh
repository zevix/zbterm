#!/usr/bin/env bash
# R7 one_table — proves R7: NEW_SESSION_TRIGGERS in renderer/app.js is the only place trigger ids, labels and key matches are listed (grep -c per trigger id outside the table is 0), and a test build that appends a fourth entry (Ctrl+Shift + "+ New", via the debug command triggers-add) shows it in the Advanced dropdown and the settings menu with no other change.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/../../261110_ui-chrome/acceptance/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# The table in the build under test is the only place the triggers are listed.
src="$(dirname "$ZBUI_APP")/resources/app/renderer/app.js"
test -f "$src"
table='NEW_SESSION_TRIGGERS *= *(Object\.freeze\()?\['
grep -E "$table" "$src"
outside="$(t="$table" awk '$0 ~ ENVIRON["t"] { skip = 1 } !skip { print } skip && /^  \]/ { skip = 0 }' "$src")"
for word in ctrlShiftT shiftNew "$ZBUI_CHOICE_NEW" "$ZBUI_CHOICE_CTRL_SHIFT_T" "$ZBUI_CHOICE_SHIFT_NEW" \
  'Edit new profile defaults for CTRL+SHIFT+t' 'Edit new profile defaults for Shift + "+ New" button'; do
  n="$(grep -cF -- "$word" <<<"$outside" || true)"
  echo "outside the table: $n x $word"
  jq -e -n --argjson n "$n" '$n == 0'
done
# A fourth entry, appended as one table entry by a test build (debug command triggers-add).
start_app
choice='The "+ New" button is clicked while holding "Ctrl+Shift"'
menu='Edit new profile defaults for Ctrl+Shift + "+ New" button'
r="$(cmd "$(jq -nc --arg c "$choice" --arg m "$menu" '{command: "triggers-add", entry: {
  id: "ctrlShiftNew", choice: $c, menuLabel: $m, verb: "click + New while holding Ctrl+Shift",
  source: "click", mods: {ctrl: true, shift: true, alt: false, meta: false}}}')")"
jq '.' <<<"$r"
jq -e '.error == null' <<<"$r"
# It is in the Advanced dropdown ...
open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
s="$(set_field Advanced true)"
jq -e --arg c "$choice" --arg f "${ZBUI_ADVANCED_SELECT%:}" \
  '[.modal.fields[] | select(.label | rtrimstr(":") == $f)][0] | [.options[].text] | index($c) != null' <<<"$s"
cmd '{"command":"dialog-cancel"}' >/dev/null
# ... and in the settings menu.
jq -e --arg m "$menu" 'any(.menu[]; .label == $m)' <<<"$(cmd '{"command":"settings-open"}')"
cmd '{"command":"click","selector":"#settingsToggle"}' >/dev/null
# Most specific first: Ctrl+Shift+click uses the new entry, Shift+click still its own trigger.
new_profile 'r7 shift' "$ZBUI_APP_HOME" 'sh' true "$ZBUI_CHOICE_SHIFT_NEW" true
new_profile 'r7 ctrlshift' "$ZBUI_APP_HOME" 'bash' true "$choice" true
cmd '{"command":"click","selector":"#newSession","shift":true}' >/dev/null
wait_until 30 has_session 'r7 shift #2' || true
jq -e 'any(.[]; .name == "r7 shift #2")' <<<"$(api GET /sessions)"
cmd '{"command":"click","selector":"#newSession","shift":true,"ctrl":true}' >/dev/null
wait_until 30 has_session 'r7 ctrlshift #2' || true
jq -e 'any(.[]; .name == "r7 ctrlshift #2") and (any(.[]; .name == "r7 shift #3") | not)' <<<"$(api GET /sessions)"
