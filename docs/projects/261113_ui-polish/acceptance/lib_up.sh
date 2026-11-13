# source me after `activate` and "$ZBUI_LIB" (../../261110_ui-chrome/acceptance/lib.sh,
# reused unchanged). The 261113_ui-polish kit's helpers. The first part is a copy of
# ../../261111_buffer-search/acceptance/lib_bs.sh (2026-11-13; copied, not sourced, so a change
# there selects only its own kit's topics):
#
#   sstate                  cmd search-state (the box, the list, its sections, the R13 guard)
#   seed_session <name> <shell text> [wait text] [select true|false] [cols]
#                           POST /sessions, types <shell text> + Enter, waits until <wait text>
#                           is in the session's mirror; prints the session id
#   mirror_has <sid> <text> / sinput <sid> <text> / select_session <sid>
#   box_xy / click_box / type_box <text> / clear_box / wait_search [secs]
#   win_size <w> <h>        POST /window/bounds at 0,0 and waits for the renderer to follow
#   start_second_app / stop_second_app / on_b <cmd...>   a second app (U2's joined viewer)
#
# This kit's own:
#   sty <selector>          cmd style-of (rect, visible, text, title, cursor, opacity, ...)
#   lstate                  cmd size-lock-state (the lock button, its menu, the grid, the font)
#   menu                    opens the settings menu, prints its items (ui-state .menu)
#   close_menu              closes the settings menu with its toggle
#   click_rect <json rect>  a real click at the centre of a {left, top, width, height}
#   click_sel <selector>    a real click at the centre of that element
#   guard_off               true when the R13 reorder guard is off
#   stty_size <sid>         the session's own `stty size` ("rows cols"), read from its terminal
#   collapse_pane / expand_pane   the side pane, by the logo (a real click)

sstate() { cmd '{"command":"search-state"}'; }

mirror_has() {
  api GET "/sessions/$1" | jq -e --arg t "$2" '(.opened.frame.data // "") | contains($t)' >/dev/null
}

sinput() {
  api POST "/sessions/$1/input" "$(jq -nc --arg t "$2" '{text: $t, enter: true}')" >/dev/null
}

seed_session() {
  local name="$1" text="$2" want="${3:-$2}" select="${4:-true}" cols="${5:-100}" r sid
  _zbui_quiet
  r="$(api POST /sessions "$(jq -nc --arg n "$name" --argjson s "$select" --argjson c "$cols" \
    '{name: $n, cols: $c, rows: 30, select: $s}')")"
  sid="$(jq -r '.sessionId // empty' <<<"$r")"
  [ -n "$sid" ] || sid="$(sid_of "$name")"
  if [ -z "$sid" ]; then
    echo "seed_session: no session for $name: $r" >&2
    _zbui_loud; return 1
  fi
  # The shell's first prompt (bash, a scratch HOME: "bash-5.x$ "), then the text.
  wait_until 20 mirror_has "$sid" '$ ' || true
  if [ -n "$text" ]; then
    sinput "$sid" "$text"
    if ! wait_until 60 mirror_has "$sid" "$want"; then
      echo "seed_session: '$want' never reached $name ($sid)" >&2
      _zbui_loud; return 1
    fi
  fi
  _zbui_loud
  echo "$sid"
}

_bs_shows() { sstate | jq -e --arg s "$1" '.selectedId == $s' >/dev/null; }
select_session() {
  api POST "/sessions/$1/switch" >/dev/null
  wait_until 15 _bs_shows "$1"
}

box_xy() {
  sstate | jq -r '.box.rect | "\((.left + .width / 2) | floor) \((.top + .height / 2) | floor)"'
}
click_box() {
  local x y
  read -r x y < <(box_xy)
  click_at "$x" "$y"
}
type_box() { click_box; xdo type --delay 30 -- "$1"; sleep 0.3; }
clear_box() { click_box; key ctrl+a; key BackSpace; }

_bs_settled() { sstate | jq -e '.sessions.pending == 0 and (.sessions.searching | not)' >/dev/null; }
wait_search() { sleep 0.5; wait_until "${1:-20}" _bs_settled || true; }

_bs_win_is() { sstate | jq -e --argjson w "$1" '.window.innerWidth <= $w and .window.innerWidth >= $w - 40' >/dev/null; }
win_size() {
  api POST /window/bounds "{\"x\":0,\"y\":0,\"width\":$1,\"height\":$2}" >/dev/null
  wait_until 10 _bs_win_is "$1" || true
  sleep 0.5
}

# --- A second app (U2) -------------------------------------------------------
# lib.sh keeps one app in globals; the second one is the same code run with its
# own set, swapped in around each call.
_BS_VARS=(ZBUI_KEY ZBUI_SESSION ZBUI_APP_HOME ZBUI_APP_STORAGE ZBUI_APP_TMP ZBUI_PORT
  ZBUI_RUN_PID ZBUI_SESSION_UP ZBUI_APP_LOG)
_BS_B_UP=""
_bs_swap() {
  local v t
  for v in "${_BS_VARS[@]}"; do
    t="_BS_B_$v"
    local a="${!v-}" b="${!t-}"
    printf -v "$v" '%s' "$b"
    printf -v "$t" '%s' "$a"
  done
}
_bs_init_b() {
  _BS_B_ZBUI_KEY="${ZBUI_KEY}b"
  _BS_B_ZBUI_SESSION="zbui-${ZBUI_KEY}b-$$"
  _BS_B_ZBUI_APP_HOME="$ZBUI_HOME/${ZBUI_KEY}b"
  _BS_B_ZBUI_APP_STORAGE="$ZBUI_STORAGE/${ZBUI_KEY}b"
  _BS_B_ZBUI_APP_TMP="$ZBUI_TMP/${$}b"
  _BS_B_ZBUI_PORT=""
  _BS_B_ZBUI_RUN_PID=""
  _BS_B_ZBUI_SESSION_UP=""
  _BS_B_ZBUI_APP_LOG="$ACCEPT_LOG_DIR/${ZBUI_ID}.b.app.log"
}
on_b() {
  local rc=0
  _bs_swap
  "$@" || rc=$?
  _bs_swap
  return "$rc"
}
start_second_app() {
  [ -n "$_BS_B_UP" ] || _bs_init_b
  _BS_B_UP=1
  on_b start_app
}
# lib.sh's stop_app, kept under another name: stop_app (called by the EXIT
# trap) now stops the second app first.
eval "$(declare -f stop_app | sed '1s/^stop_app/_bs_stop_app_one/')"
stop_second_app() {
  [ -n "$_BS_B_UP" ] || return 0
  on_b _bs_stop_app_one
  _BS_B_UP=""
}
stop_app() {
  stop_second_app
  _bs_stop_app_one
}

# --- This kit's own -----------------------------------------------------------
sty() { cmd "$(jq -nc --arg s "$1" '{command: "style-of", selector: $s}')"; }
lstate() { cmd '{"command":"size-lock-state"}'; }
menu() { cmd '{"command":"settings-open"}' | jq -c '.menu'; }
close_menu() {
  if state | jq -e '.menuOpen' >/dev/null; then
    cmd '{"command":"click","selector":"#settingsToggle"}' >/dev/null
  fi
}
click_rect() {
  click_at "$(jq '(.left + .width / 2) | floor' <<<"$1")" "$(jq '(.top + .height / 2) | floor' <<<"$1")"
}
click_sel() { click_rect "$(sty "$1" | jq -c '.rect')"; }
guard_off() { sstate | jq -e '.sessions.guard.on == false' >/dev/null; }
_up_stty_n=0
_up_stty_read() {
  api GET "/sessions/$1" | jq -er --arg t "$2" \
    '(.opened.frame.data // "") | [scan($t + "=([0-9]+ [0-9]+)=" + $t)] | last | .[0]'
}
stty_size() {
  _up_stty_n=$((_up_stty_n + 1))
  local tag="UPSZ$_up_stty_n"
  sinput "$1" "echo $tag=\$(stty size)=$tag"
  wait_until 15 _up_stty_read "$1" "$tag" || true
  _up_stty_read "$1" "$tag" || true
}
_up_collapsed() { state | jq -e --argjson c "$1" '.sideCollapsed == $c' >/dev/null; }
collapse_pane() {
  _up_collapsed true && return 0
  click_rect "$(state | jq -c '.brandMark.rect')"
  wait_until 10 _up_collapsed true
}
expand_pane() {
  _up_collapsed false && return 0
  click_rect "$(state | jq -c '.brandMark.rect')"
  wait_until 10 _up_collapsed false
}
