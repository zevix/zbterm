#!/usr/bin/env bash
# R4 pins kept — proves R4: pins and their order survive a quit through the R1 popup and SIGTERM, a start whose session list is empty (the catalog moved away, as a first start of another version can look), a pin made during that start, and the next start with the catalog back.
# Asserts: after pinning c then a: pinned [c, a] and rows start c, a; the same after popup Quit + start and after SIGTERM + start; with the catalog moved away the app starts with no rows, its pins still [c, a] (nothing pruned) and preferences.json still lists them; pinning a new session d then gives [c, a, d], not [d]; with the catalog back, rows start c, a again.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R4_pins_kept
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display"
set -x
start_app
a="$(seed_session r4-a 'echo A""READY' AREADY)"
b="$(seed_session r4-b 'echo B""READY' BREADY)"
c="$(seed_session r4-c 'echo C""READY' CREADY)"
row_action "$c" pin >/dev/null; sleep 1
row_action "$a" pin >/dev/null; sleep 1
want="$(jq -nc --arg c "$c" --arg a "$a" '[$c, $a]')"
check_pins() {
  order | jq -e --argjson w "$want" '.pinned[0:2] == $w and ([.rows[].id][0:2] == $w)'
}
check_pins
saved() { jq -r '."zbterm.pinnedSessions"' "$(prefs_file)"; }
# Quit through the popup, start again.
click_box; key ctrl+q; sleep 0.5
click_button Quit
wait_gone 30
_zbui_stop_run_pid
start_app
check_pins
# SIGTERM, start again.
quit_app
start_app
check_pins
# A start with an empty list: the catalog moved away.
quit_app
cat_dir="$(find "$ZBUI_APP_STORAGE" -type d -name catalog -print -quit)"; test -n "$cat_dir"
mv "$cat_dir" "$cat_dir.away"
start_app
sleep 3
order | jq -e --argjson w "$want" '.pinned == $w and .pinnedLoaded == true'
saved | jq -e --argjson w "$want" '. == $w'
d="$(seed_session r4-d 'echo D""READY' DREADY)"
row_action "$d" pin >/dev/null; sleep 1
saved | jq -e --argjson w "$want" --arg d "$d" '. == ($w + [$d])'
quit_app
rm -rf "$cat_dir"; mv "$cat_dir.away" "$cat_dir"
start_app
sleep 2
check_pins
