#!/usr/bin/env bash
# R32 ui tweaks — proves R32, R33: the size-lock button is as tall as the font-size buttons beside it, in a wide and a narrow window; the profile editor's Advanced part shows the stamp left of the "default for new sessions" dropdown, in one row.
# Asserts: wide (1280) and narrow (700) window with a live session selected: #sizeLock shown, its rect's top and height within 1 px of #fontSizeIncrease's; a screenshot of each in the log dir. The New dialog with Advanced open: .session-editor-trigger-row .fa-stamp found and visible, its right edge left of #sessionEditorTrigger's left, their vertical centres within 4 px, the dropdown wider than 100 px; a screenshot in the log dir.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R32_ui_tweaks
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks on the private display"
set -x
start_app
win_size 1280 800
seed_session r32 'echo R32""READY' R32READY >/dev/null
sleep 1
same_height() { # label
  local lock font
  lock="$(sty '#sizeLock')"; font="$(sty '#fontSizeIncrease')"
  jq -c '.rect' <<<"$lock"; jq -c '.rect' <<<"$font"
  uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R32_$1.png" >/dev/null
  jq -e -n --argjson l "$lock" --argjson f "$font" '$l.found and $f.found and $l.rect.height > 0
    and (($l.rect.height - $f.rect.height) | fabs) <= 1 and (($l.rect.top - $f.rect.top) | fabs) <= 1'
}
same_height wide
win_size 700 800; sleep 1
same_height narrow
win_size 1280 800; sleep 1
# R33: the stamp left of the dropdown.
open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
set_field Advanced true | jq -e '.set'
sleep 0.5
st="$(sty '.session-editor-trigger-row .fa-stamp')"
se="$(sty '#sessionEditorTrigger')"
jq -c '.rect' <<<"$st"; jq -c '.rect' <<<"$se"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R32_stamp.png" >/dev/null
jq -e -n --argjson s "$st" --argjson d "$se" '$s.found and $s.rect.width > 0 and $s.rect.height > 0
  and $s.rect.right <= $d.rect.left
  and ((($s.rect.top + $s.rect.bottom) / 2 - ($d.rect.top + $d.rect.bottom) / 2) | fabs) <= 4
  and $d.rect.width > 100'
