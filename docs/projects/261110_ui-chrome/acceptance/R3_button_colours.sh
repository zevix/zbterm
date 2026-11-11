#!/usr/bin/env bash
# R3 button_colours — proves R3: the computed colour of the New icon is green and the Join icon blue; the button text colour is unchanged.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
s="$(state)"
jq '.colors' <<<"$s"
jq -e -L "$ZBUI_JQ_LIB" "$JQ_COLOR"'.colors.newIcon | is_green' <<<"$s"
jq -e -L "$ZBUI_JQ_LIB" "$JQ_COLOR"'.colors.joinIcon | is_blue' <<<"$s"
# The text keeps the button's own colour; only the icons change.
jq -e '.colors.newText == .colors.newButton and .colors.joinText == .colors.joinButton' <<<"$s"
jq -e -L "$ZBUI_JQ_LIB" "$JQ_COLOR"'(.colors.newText | is_green | not) and (.colors.joinText | is_blue | not)' <<<"$s"
