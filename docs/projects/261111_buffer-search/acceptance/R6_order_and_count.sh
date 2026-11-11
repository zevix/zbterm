#!/usr/bin/env bash
# R6 order_and_count — proves R6: buffer-match rows are ordered by match count, most first, and show 'N matches' in cyan instead of 'live · …'.
# Asserts: sessions with 2, 9 and 5 occurrences of the query: rows in order 9, 5, 2; each .sub == "<n> matches" ("1 match" for one, checked with a fourth session); .subColor is_cyan (jq colour helper; hue 170–200°, saturation > 0.4) in both the dark and the light theme, and its contrast ratio against .rowBg is >= 4.5; the same session's row in the name section (if any) still reads 'live · …'.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_bs.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
# n occurrences of QRSIX, never on the command line (p=QRS … ${p}IX).
seed_n() { seed_session "$1" "p=QRS; for i in \$(seq $2); do echo \"\${p}IX \$i\"; done" "QRSIX $2"; }
s2="$(seed_n r6-two 2)"
s9="$(seed_n r6-nine 9)"
s5="$(seed_n r6-five 5)"
s1="$(seed_n r6-one 1)"
sq="$(seed_n qrsix-named 3)"
check_rows() {
  local s="$1"
  jq '.sessions' <<<"$s"
  jq -e --arg a "$s9" --arg b "$s5" --arg c "$sq" --arg d "$s2" --arg e "$s1" \
    '[.sessions.rows[] | select(.section == "buffer") | .id] == [$a, $b, $c, $d, $e]' <<<"$s"
  jq -e '[.sessions.rows[] | select(.section == "buffer") | .sub] == ["9 matches", "5 matches", "3 matches", "2 matches", "1 match"]' <<<"$s"
  jq -e -L "$BS_JQ_LIB" "$JQ_BS"'all(.sessions.rows[] | select(.section == "buffer"); .subColor | is_cyan)' <<<"$s"
  jq -e -L "$BS_JQ_LIB" "$JQ_BS"'all(.sessions.rows[] | select(.section == "buffer"); contrast(.subColor; .rowBg) >= 4.5)' <<<"$s"
  # The same session's name row still reads "live · …".
  jq -e --arg c "$sq" '[.sessions.rows[] | select(.section == "name" and .id == $c) | .sub | startswith("live")] == [true]' <<<"$s"
}
type_box QRSIX
wait_search
check_rows "$(sstate)"
# The other theme.
cmd '{"command":"click","selector":"#themeToggle"}' >/dev/null
sleep 1
check_rows "$(sstate)"
