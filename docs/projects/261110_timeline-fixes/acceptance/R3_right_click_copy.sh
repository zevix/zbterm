#!/usr/bin/env bash
# R3 right_click_copy — proves R3: in live, drag-select echoed text then right-click it, in a plain shell and in less --mouse, with output arriving in between: Copy is enabled, the highlight is back, and Copy clicked after 2 s puts the exact text on the clipboard
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/../../261110_ui-chrome/acceptance/lib.sh"
need uisolate "the app runs only on a private display"
need xdotool "real mouse and keys on the private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
source "$(cd "$(dirname "$0")" && pwd)/tf.sh"
start_app
api POST /window/bounds '{"x":0,"y":0,"width":1280,"height":800}' >/dev/null
clip_get() { uisolate run --name "$ZBUI_SESSION" -t 10 -- xclip -o -selection clipboard 2>/dev/null; }
clip_set() { uisolate run --name "$ZBUI_SESSION" -t 10 -- sh -c 'printf %s "$1" | xclip -i -selection clipboard -loops 1 & sleep 0.3' sh "$1"; }
# case <plain|less> <copy on select true|false>: a fresh live session; select a
# line, let output arrive, right-click the selection, click Copy 2 s later.
check_case() {
  local kind="$1" copy="$2" want row m s
  set_copy_on_select "$copy"
  api POST /sessions "$(jq -nc --arg n "r3 $kind $copy" '{name: $n, cols: 80, rows: 24}')" | jq -e '.sessionId'
  sleep 2
  if [ "$kind" = plain ]; then
    want="r3-plain-$copy"
    api POST /sessions/current/input "$(jq -nc --arg w "$want" '{text: ("clear; echo " + $w + "; sleep 2.5; echo r3-late-output"), enter: true}')" >/dev/null
  else
    want="r3-less-3"
    # less in follow mode with the mouse on; a line is appended to its file 2.5 s later.
    api POST /sessions/current/input '{"text":"clear; seq -f \"r3-less-%g\" 1 10 > ~/r3.txt; (sleep 4; echo r3-less-late >> ~/r3.txt) & less --mouse +F ~/r3.txt","enter":true}' >/dev/null
  fi
  wait_until 10 term_has "$want"
  sleep 0.5
  row="$(row_of "^$want *$")"
  test -n "$row"
  [ "$kind" = plain ] || jq -e '.mouseTracking != "none"' < <(sel)
  sel_log >/dev/null
  drag_cells "$row" 0 "${#want}"
  sel | jq -c .
  jq -e --arg w "$want" '.has and .text == $w' < <(sel)
  # Output arrives while the selection stands.
  if [ "$kind" = plain ]; then wait_until 10 term_has r3-late-output; else wait_until 10 term_has r3-less-late; fi
  right_click_cell "$row" 2
  m="$(menu_state)"; s="$(sel)"
  sel_log | jq -c '.events[]'
  jq -c . <<<"$m"; jq -c . <<<"$s"
  jq -e '.open' <<<"$m"
  jq -e '.copyEnabled' <<<"$m"
  jq -e --arg w "$want" '.has and .text == $w' <<<"$s"
  # Copy, clicked with the real pointer after the menu has been open for 2 s.
  clip_set r3-sentinel
  sleep 2
  read -r cx cy < <(jq -r '.items[] | select(.label == "Copy") | .rect | "\((.left + .width / 2) | floor) \((.top + .height / 2) | floor)"' <<<"$m")
  click_at "$cx" "$cy"
  sleep 0.5
  got="$(clip_get)"
  echo "clipboard: '$got' (want '$want')"
  test "$got" = "$want"
  if [ "$kind" = less ]; then
    api POST /sessions/current/input '{"data":"\u0003"}' >/dev/null; sleep 0.3
    api POST /sessions/current/input '{"data":"q"}' >/dev/null
  fi
  sleep 0.5
}
check_case plain true
check_case plain false
check_case less true
check_case less false
