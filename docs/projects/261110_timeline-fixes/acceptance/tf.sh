# source me after activate and ../../261110_ui-chrome/acceptance/lib.sh. The
# timeline-fixes kit's own helpers: its debug reads, terminal cells as page
# coordinates, real drags, right-clicks and Alt+wheel, and the recording fixtures.
#
#   pstate / sel / menu_state / labels / sel_log   the renderer reads (design.md *Interface*)
#   style_of <selector>       computed style of an element (the play button's blink)
#   row_of <regex>            the first visible terminal row matching <regex> (0-based)
#   cell_xy <row> <col>       page coordinates inside that cell
#   drag_cells <row> <c1> <c2>   a real left-button drag along one row
#   right_click_cell <row> <col> a real right-click
#   alt_wheel <back|forward>  one real Alt+wheel notch over the terminal
#   click_el <selector>       a real click in the middle of an element
#   set_copy_on_select <true|false>, set_collapse <true|false>
#   seed_gap_session <name> [gap s]   lines tf-a1..5, an idle gap (20 s), lines tf-b1..5
#   seed_ended_session <name> <script body>  a session whose command is that sh script

pstate() { cmd '{"command":"playback-state"}'; }
sel() { cmd '{"command":"selection-state"}'; }
menu_state() { cmd '{"command":"terminal-menu-state"}'; }
labels() { cmd '{"command":"time-labels"}'; }
sel_log() { cmd '{"command":"selection-log"}'; }
style_of() { cmd "$(jq -nc --arg s "$1" '{command: "style-of", selector: $s}')"; }

row_of() {
  term_text | grep -n -m1 -E -- "$1" | cut -d: -f1 | awk '{ print $1 - 1 }'
}

cell_xy() {
  api GET /renderer/terminal-display | jq -r --argjson r "$1" --argjson c "$2" '
    .terminal as $t
    | "\(($t.rects.screen.left + ($c + 0.3) * $t.renderCell.width) | floor) \(($t.rects.screen.top + ($r + 0.5) * $t.renderCell.height) | floor)"'
}

drag_cells() {
  local x1 y1 x2 y2 xm
  read -r x1 y1 < <(cell_xy "$1" "$2")
  read -r x2 y2 < <(cell_xy "$1" "$3")
  xm=$(((x1 + x2) / 2))
  mouse_to "$x1" "$y1"
  xdo mousedown 1
  mouse_to "$xm" "$y1"
  mouse_to "$x2" "$y2"
  xdo mouseup 1
  sleep 0.3
}

right_click_cell() {
  local x y
  read -r x y < <(cell_xy "$1" "$2")
  mouse_to "$x" "$y"
  xdo click 3
  sleep 0.5
}

alt_wheel() {
  local x y b=4
  [ "$1" = forward ] && b=5
  read -r x y < <(cell_xy 5 20)
  mouse_to "$x" "$y"
  xdo keydown alt
  xdo click "$b"
  xdo keyup alt
  sleep 0.8
}

click_el() {
  local x y
  read -r x y < <(style_of "$1" | jq -r '.rect // empty | "\((.left + .width / 2) | floor) \((.top + .height / 2) | floor)"')
  [ -n "${x:-}" ] || { echo "click_el: no element $1" >&2; return 1; }
  click_at "$x" "$y"
}

set_copy_on_select() {
  local now
  now="$(cmd '{"command":"settings-open"}' | jq -r '.menu[] | select(.label == "Copy on select") | .checked')"
  if [ "$now" != "$1" ]; then cmd '{"command":"settings-click","label":"Copy on select"}' >/dev/null; fi
  # settings-click leaves the menu open over the terminal; the toggle closes it.
  if state | jq -e '.menuOpen' >/dev/null; then cmd '{"command":"click","selector":"#settingsToggle"}' >/dev/null; fi
  cmd '{"command":"settings-open"}' | jq -e --argjson v "$1" '.menu[] | select(.label == "Copy on select") | .checked == $v' >/dev/null
  cmd '{"command":"click","selector":"#settingsToggle"}' >/dev/null
  state | jq -e '.menuOpen | not' >/dev/null
}

set_collapse() {
  if [ "$(labels | jq -r .collapse)" != "$1" ]; then
    cmd '{"command":"click","selector":"#collapseGaps"}' >/dev/null
    sleep 0.3
  fi
  labels | jq -e --argjson v "$1" '.collapse == $v' >/dev/null
}

_tf_lines_out() { term_text | grep -cE '^tf-b5 *$' >/dev/null; }

# A running session: five lines, an idle gap of $2 s (20), five more lines. Typed
# into the shell with a real wait, so the recording holds the gap.
seed_gap_session() {
  local gap="${2:-20}"
  api POST /sessions "$(jq -nc --arg n "$1" '{name: $n, cols: 80, rows: 24}')" | jq -r .sessionId
  sleep 2
  api POST /sessions/current/input "$(jq -nc --arg g "$gap" \
    '{text: ("clear; for i in 1 2 3 4 5; do echo tf-a$i; done; sleep " + $g + "; for i in 1 2 3 4 5; do echo tf-b$i; done"), enter: true}')" >/dev/null
  wait_until $((gap + 15)) _tf_lines_out
  sleep 1
}

# A session whose command is a sh script (written to the app's scratch HOME); it
# ends when the script does, and the app shows its playback.
seed_ended_session() {
  printf '%s\n' "$2" >"$ZBUI_APP_HOME/$1.sh"
  api POST /sessions "$(jq -nc --arg n "$1" --arg h "$ZBUI_APP_HOME" \
    '{name: $n, cols: 80, rows: 24, cwd: $h, command: ("sh " + $h + "/" + $n + ".sh")}')" | jq -r .sessionId
}
