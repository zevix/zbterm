#!/usr/bin/env bash
# R4 template mark — proves R4: a template session's row shows a template icon (a stamp), not the green check, left of any pin.
# Asserts: a session made the CTRL+SHIFT+T template through its Edit dialog shows .session-default-mark with class fa-stamp and not fa-check; pinned, its marks read stamp then pin, the pin's right edge right of the stamp's (the pin at the row's right end).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/activate"
source "$ZBUI_LIB"
source "$ZBUI_LIB_UP"
source "$here/lib_lo.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
sid="$(api POST /sessions '{"name":"r4 template","cols":80,"rows":24}' | jq -r .sessionId)"
sleep 1
row_action "$sid" edit >/dev/null
set_field Advanced true | jq -e '.set' >/dev/null
set_field "$ZBUI_ADVANCED_SELECT" "$(jq -n --arg v "$ZBUI_CHOICE_CTRL_SHIFT_T" '$v')" | jq -e '.set' >/dev/null
cmd '{"command":"dialog-submit"}' >/dev/null
sleep 1
cmd '{"command":"templates"}' | jq -e --arg s "$sid" '.newSessionTemplates.ctrlShiftT.sessionId == $s'
row=".session-row[data-session-id=\"$sid\"]"
m="$(sty "$row .session-default-mark")"; jq -c '{className, title, visible}' <<<"$m"
jq -e '(.className | test("fa-stamp")) and (.className | test("fa-check") | not) and .visible == true' <<<"$m"
row_action "$sid" pin >/dev/null
sleep 1
order="$(cmd "$(jq -nc --arg s "$row .session-marks" '{command: "style-of", selector: $s}')" | jq -c .)"
echo "$order"
st="$(sty "$row .session-default-mark")"; pn="$(sty "$row .session-pin-mark")"
jq -c '.rect' <<<"$st"; jq -c '.rect' <<<"$pn"
jq -e -n --argjson a "$st" --argjson b "$pn" '$b.visible == true and $b.rect.left >= $a.rect.right - 1'
