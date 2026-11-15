#!/usr/bin/env bash
# R6 font labels — proves R6 and R7: the font-size buttons read '+ A' and '- A', the A in a serif face.
# Asserts: #fontSizeIncrease shows the fa-plus icon then 'A', #fontSizeDecrease fa-minus then 'A' (no 'Font' anywhere in them); both keep their aria-labels; the A's computed font-family is a serif list and fc-match resolves its first family to a serif font on this host.
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
need fc-match "resolves the serif face the A is drawn in"
start_app
win_size 1280 800
a="$(seed_session r6-a 'echo A""READY' AREADY)"
select_session "$a"
sleep 1
for id in fontSizeIncrease fontSizeDecrease; do
  b="$(sty "#$id")"; jq -c '{text, visible, title}' <<<"$b"
  jq -e '.visible == true and (.text | gsub("\\s"; "")) == "A"' <<<"$b"
  l="$(sty "#$id .font-size-a")"; jq -c '{text, fontFamily}' <<<"$l"
  jq -e '.text == "A" and (.fontFamily | test("serif"; "i"))' <<<"$l"
done
sty '#fontSizeIncrease .btn-icon' | jq -e '.className | test("fa-plus")'
sty '#fontSizeDecrease .btn-icon' | jq -e '.className | test("fa-minus")'
sty '#fontSizeIncrease' | jq -e '.ariaLabel == "Increase font size"'
sty '#fontSizeDecrease' | jq -e '.ariaLabel == "Decrease font size"'
fam="$(sty '#fontSizeIncrease .font-size-a' | jq -r '.fontFamily' | cut -d, -f1 | tr -d "\"'")"
fc-match "$fam" : family style spacing | tee /dev/stderr | grep -qiE "serif|times|liberation serif|dejavu serif|georgia" 
fc-match "$fam" : family | grep -viq "sans"
