#!/usr/bin/env bash
# R37 tweaks (third review) — proves R37, R38, R39, R40: editing a template profile opens its Advanced part (a plain profile's stays closed); every search section heading but "Current session" ends in a (hide)/(show) link in the match cyan (hide dimmer and underlined, show bright) that drops or restores the section's rows; "Map Ctrl+1 to Ctrl+9 to pinned profiles" sits right above "Map F2 to edit profile", on by default; Ctrl+N then selects the Nth pinned profile and each pin shows its number left of it; turned off, the numbers go, Ctrl+N selects nothing, and the choice survives a restart.
# Asserts: menu labels: "Copy on select", "Map Ctrl+1 to Ctrl+9 to pinned profiles" (checked), "Map F2 to edit profile" in a row; s1, s3 pinned: their rows' pinNumber "1" and "2", each left of its pin, s2 none; from s2, real Ctrl+1 selects s1, Ctrl+2 s3, Ctrl+3 leaves s3; unchecked: no pinNumber, Ctrl+1 leaves the selection; after a restart still unchecked (session-order pinKeys false); checked again: true. Editing a template made through the New dialog: the modal's Advanced details open; editing s1: closed. Searching "r37": headings name/buffer/other carry a toggle "(hide)" (underlined, opacity 0.6, the match-cyan colour of a "N matches" subtitle), "Current session" none; a real click on the name section's toggle: no name rows, its toggle "(show)", opacity 1, not underlined; a second click: the name rows back. Screenshots in the log dir.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R37_tweaks3
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real keys and clicks on the private display"
set -x
start_app
win_size 1280 900
s1="$(seed_session r37-1 'echo 1""READY' 1READY)"; sleep 1
s2="$(seed_session r37-2 'echo 2""READY' 2READY)"; sleep 1
s3="$(seed_session r37-3 'echo 3""READY' 3READY)"; sleep 1
# A session the search below does not match, so "Other - unmatched sessions" shows.
seed_session plain-4 'echo 4""READY' 4READY false >/dev/null
guard_wait
row() { order | jq -c --arg s "$1" '.rows[] | select(.id == $s)'; }
sel() { order | jq -r '.selectedId'; }
pick() { cmd "$(jq -nc --arg s "$1" '{command: "click", selector: (".session-row[data-session-id=\"" + $s + "\"] .session-name")}')" >/dev/null; sleep 0.8; }
focus_term() { click_sel '#terminal'; sleep 0.3; }
PK='Map Ctrl+1 to Ctrl+9 to pinned profiles'
# R39: the setting, between Copy on select and F2, on by default.
labels="$(menu)"
jq -e --arg pk "$PK" '[.[] | .label] | index("Copy on select") as $i
  | $i != null and .[$i + 1] == $pk and .[$i + 2] == "Map F2 to edit profile"' <<<"$labels"
jq -e --arg pk "$PK" '.[] | select(.label == $pk) | .checked == true' <<<"$labels"
close_menu
# R40: pins numbered in pin order, left of the pin.
row_action "$s1" pin >/dev/null; sleep 1
row_action "$s3" pin >/dev/null; sleep 1
guard_wait
row "$s1" | jq -e '.pinNumber.text == "1" and .pinNumber.leftOfPin'
row "$s3" | jq -e '.pinNumber.text == "2" and .pinNumber.leftOfPin'
row "$s2" | jq -e '.pinNumber == null'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R37_pin_numbers.png" >/dev/null
# R39: Ctrl+N from the terminal.
pick "$s2"; test "$(sel)" = "$s2"
focus_term
xdo key ctrl+1; sleep 0.8; test "$(sel)" = "$s1"
xdo key ctrl+2; sleep 0.8; test "$(sel)" = "$s3"
xdo key ctrl+3; sleep 0.8; test "$(sel)" = "$s3"
# Off: no numbers, Ctrl+1 is the terminal's.
menu >/dev/null
cmd "$(jq -nc --arg l "$PK" '{command: "settings-click", label: $l}')" | jq -e '.clicked'
close_menu; sleep 0.5
row "$s1" | jq -e '.pinNumber == null'
focus_term
xdo key ctrl+1; sleep 0.8; test "$(sel)" = "$s3"
restart_app
guard_wait
order | jq -e '.pinKeys == false'
menu | jq -e --arg pk "$PK" '.[] | select(.label == $pk) | .checked == false'
cmd "$(jq -nc --arg l "$PK" '{command: "settings-click", label: $l}')" | jq -e '.clicked'
menu | jq -e --arg pk "$PK" '.[] | select(.label == $pk) | .checked == true'
close_menu
# R37: a template's edit dialog opens Advanced; a plain profile's does not.
new_profile r37-tpl /tmp '' false "$ZBUI_CHOICE_CTRL_SHIFT_T" false
guard_wait
tpl="$(sid_of r37-tpl)"
row_action "$tpl" edit | jq -e '.modal.details | any(.summary == "Advanced" and .open)'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R37_template_edit.png" >/dev/null
xdo key Escape; sleep 0.5
row_action "$s1" edit | jq -e '.modal.details | any(.summary == "Advanced" and (.open | not))'
xdo key Escape; sleep 0.5
# R38: the section toggles.
pick "$s2"
type_box r37
wait_search
guard_wait
ss() { cmd '{"command":"search-state"}' | jq -c '.sessions'; }
s="$(ss)"; jq -c '.headingStyles' <<<"$s"
jq -e '[.headingStyles[] | select(.text == "Current session") | .toggle] == [null]
  and ([.headingStyles[] | select(.text != "Current session") | .toggle.section] | sort) == ["buffer", "name", "other"]
  and ([.headingStyles[] | .toggle | select(.) | .text == "(hide)" and .underline and (.opacity | tonumber) == 0.6] | all)' <<<"$s"
# The link is the match cyan (a buffer-match row's "N matches" subtitle).
mc="$(sty '.session-sub.match-count' | jq -r '.color')"
if [ "$mc" != null ] && [ -n "$mc" ]; then
  jq -e --arg c "$mc" '[.headingStyles[] | .toggle | select(.) | .color == $c] | all' <<<"$s"
fi
jq -e '[.rows[] | select(.section == "name")] | length >= 1' <<<"$s"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R37_sections_shown.png" >/dev/null
click_sel '.session-section-toggle[data-section="name"]'; sleep 0.5; guard_wait
s="$(ss)"
jq -e '([.rows[] | select(.section == "name")] | length) == 0
  and (.headingStyles[] | select(.toggle.section == "name") | .toggle.text == "(show)" and (.toggle.underline | not) and (.toggle.opacity | tonumber) == 1)' <<<"$s"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R37_sections_hidden.png" >/dev/null
click_sel '.session-section-toggle[data-section="name"]'; sleep 0.5; guard_wait
ss | jq -e '([.rows[] | select(.section == "name")] | length) >= 1'
clear_box
