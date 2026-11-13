#!/usr/bin/env bash
# R8 menu — proves R8 and R9: in the settings menu 'STUN/TURN servers…' is the last item before the version, with separators above and below it, and the two '… with CTRL -/+' items have separators above and below them.
# Asserts: the menu read through ui-state (separators as '-'): with the side pane shown it is exactly [Developer Mode, Copy on select, -, Change font size with CTRL -/+, Zoom whole app with CTRL -/+, -, Edit new profile defaults, … for CTRL+SHIFT+t, … for Shift + "+ New" button, -, STUN/TURN servers…, -, ZBTerm v<version>]; with the pane hidden the identity and theme items sit between the templates and STUN/TURN, in a group of their own (a separator before and after), STUN/TURN still menu[-3] between separators; in both, no separator is first, last or next to another.
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
seq_of() { jq -c '[.[] | if .kind == "separator" then "-" else .label end]'; }
rules() {
  jq -e 'length > 2 and .[0].kind != "separator" and .[-1].kind != "separator"
    and ([range(1; length) as $i | select(.[$i].kind == "separator" and .[$i - 1].kind == "separator")] == [])' <<<"$1"
  jq -e '.[-1].kind == "info" and (.[-1].label | test("^ZBTerm v")) and .[-2].kind == "separator"
    and .[-3].label == "STUN/TURN servers…" and .[-4].kind == "separator"' <<<"$1"
  jq -e '(map(.label) | index("Change font size with CTRL -/+")) as $i
    | .[$i - 1].kind == "separator" and .[$i + 1].label == "Zoom whole app with CTRL -/+" and .[$i + 2].kind == "separator"' <<<"$1"
}
m="$(menu)"
seq_of <<<"$m"
rules "$m"
jq -e '[.[] | if .kind == "separator" then "-" else .label end][0:12] == ["Developer Mode", "Copy on select", "-",
  "Change font size with CTRL -/+", "Zoom whole app with CTRL -/+", "-",
  "Edit new profile defaults", "Edit new profile defaults for CTRL+SHIFT+t", "Edit new profile defaults for Shift + \"+ New\" button", "-",
  "STUN/TURN servers…", "-"] and length == 13' <<<"$m"
close_menu
# Pane hidden: identity and theme in their own group, STUN/TURN still last before the version.
collapse_pane
m="$(menu)"
seq_of <<<"$m"
rules "$m"
jq -e '(map(.label) | index("Edit new profile defaults for Shift + \"+ New\" button")) as $t
  | .[$t + 1].kind == "separator" and (.[$t + 2].label | test("identity"; "i")) and (.[$t + 3].label | test("theme"; "i"))
    and .[$t + 4].kind == "separator" and .[$t + 5].label == "STUN/TURN servers…" and length == $t + 8' <<<"$m"
close_menu
