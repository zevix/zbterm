#!/usr/bin/env bash
# R10 items — proves R10: with the side pane hidden, the menu's identity and theme items read '<toolbar icon> <its tooltip>', the identity dot on the icon.
# Asserts: pane hidden by a real click on the logo; in the settings menu the identity item's icon is #identitySetup's (fa-id-badge) and its label is that button's title ('Choose your identity'); the theme item's icon and label are #themeToggle's (fa-moon/fa-sun, 'Switch to … theme'); no tick shows on either; the identity dot is on the icon (.dot.on == 'icon'), its centre within 8 px of the icon's box and more than 40 px left of the row's right end, orange (no identity); after a click on the theme item the theme flips and, reopened, the item shows the button's new icon and title (different from before); with the pane shown again neither item is in the menu.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_up.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
collapse_pane
tb() { sty "$1" | jq -c '{title, icon: (.iconClass | split(" ") | map(select(startswith("fa-") and . != "fa-solid"))[0])}'; }
item() { jq -c --arg l "$2" '[.[] | select(.label == $l)][0]' <<<"$1"; }
idb="$(tb '#identitySetup')"; thb="$(tb '#themeToggle')"
echo "toolbar: $idb $thb"
m="$(menu)"
jq -c '.[] | {label, icon, checkMark, dot}' <<<"$m"
i="$(item "$m" "$(jq -r .title <<<"$idb")")"
t="$(item "$m" "$(jq -r .title <<<"$thb")")"
jq -e --argjson b "$idb" '. != null and .icon == $b.icon and .icon == "fa-id-badge" and .label == "Choose your identity" and .checkMark == false' <<<"$i"
jq -e --argjson b "$thb" '. != null and .icon == $b.icon and (.icon | test("^fa-(moon|sun)$")) and (.label | test("^Switch to (light|dark) theme$")) and .checkMark == false' <<<"$t"
jq -e '.dot.on == "icon"' <<<"$i"
jq -e '((.dot.rect.left + .dot.rect.width / 2) >= .iconRect.left - 8) and ((.dot.rect.left + .dot.rect.width / 2) <= .iconRect.right + 8)
  and ((.dot.rect.top + .dot.rect.height / 2) >= .iconRect.top - 8) and ((.dot.rect.top + .dot.rect.height / 2) <= .iconRect.bottom + 8)
  and (.dot.rect.right < .rect.right - 40)' <<<"$i"
jq -e -L "$ZBUI_JQ_LIB" "$JQ_COLOR"'.dot.color | is_orange' <<<"$i"
# The theme item follows the button's state.
cmd "$(jq -nc --arg l "$(jq -r .label <<<"$t")" '{command: "settings-click", label: $l}')" | jq -e '.clicked'
close_menu
thb2="$(tb '#themeToggle')"
echo "toolbar after: $thb2"
[ "$thb2" != "$thb" ]
m="$(menu)"
t2="$(item "$m" "$(jq -r .title <<<"$thb2")")"
jq -e --argjson b "$thb2" '. != null and .icon == $b.icon and .label == $b.title' <<<"$t2"
close_menu
expand_pane
m="$(menu)"
jq -e '[.[].label] | (index("Choose your identity") == null) and (map(test("^Switch to")) | any | not)' <<<"$m"
close_menu
