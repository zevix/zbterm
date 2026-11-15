#!/usr/bin/env bash
# R13 logo text — proves R13: the logo screen no longer names pears.com/holepunch.to, and the "See … for more information" line is centred.
# Asserts: on the start-up logo screen (screen rows) and in devLogoText (dev), no row contains "pears.com", "holepunch" or "not affiliated"; the row "See https://github.com/zevix/zbterm for more information" is present once; its centre is within a column of the "Written by" row's centre; in dev text both rows start within 1 of (cols - length) / 2. (Screen rows are drawn at the grid width of that moment, so screen is checked line against line.)
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
lt() { cmd "$(jq -nc --arg s "$1" '{command: "logo-text", source: $s}')"; }
has_see() { lt screen | jq -e '[.rows[] | select(.text | startswith("See "))] | length == 1' >/dev/null; }
wait_until 30 has_see
for src in screen dev; do
  t="$(lt "$src")"
  jq -c '{source, cols, logoCols, rows: [.rows[] | select(.text != "" and (.text | test("^[ ]*$") | not))] | map({row, col, text}) | .[-4:]}' <<<"$t"
  jq -e '[.rows[].text | test("pears\\.com|holepunch|not affiliated"; "i")] | any | not' <<<"$t"
  jq -e '.rows | map(select(.text == "See https://github.com/zevix/zbterm for more information")) | length == 1' <<<"$t"
  # Centred: the See line's centre is the Written-by line's (within a column).
  # On screen the logo text is drawn at the terminal width of that moment (the
  # debug interlude's grid can be narrower than the current one), so the two
  # lines are compared with each other there; dev text is checked against cols.
  jq -e '(.rows[] | select(.text | startswith("See "))) as $s
    | (.rows[] | select(.text == "Written by Zeev Kotzer")) as $w
    | ((2 * $s.col + ($s.text | length)) - (2 * $w.col + ($w.text | length)) | fabs) <= 2' <<<"$t"
  if [ "$src" = dev ]; then
    for line in 'See https://github.com/zevix/zbterm for more information' 'Written by Zeev Kotzer'; do
      jq -e --arg l "$line" '.cols as $w | (.rows[] | select(.text == $l)) as $r
        | (($r.col - (($w - ($l | length)) / 2 | floor)) | fabs) <= 1' <<<"$t"
    done
  fi
done
