# source me after `activate` and "$ZBUI_LIB" (../../261110_ui-chrome/acceptance/lib.sh,
# reused unchanged). The 261111_buffer-search kit's own helpers:
#
#   sstate                  cmd search-state (the box, the in-session search, the list)
#   bslog                   cmd buffer-search-log (drains it: requests/answers since the last call)
#   seed_session <name> <shell text> [wait text] [select true|false]
#                           POST /sessions, types <shell text> + Enter, waits (60 s) until
#                           <wait text> (default: <shell text>) is in the session's mirror
#                           (GET /sessions/:id → opened.frame); prints the session id
#   mirror_has <sid> <text> true when that session's mirror holds <text>
#   sinput <sid> <text>     types <text> + Enter into that session
#   select_session <sid>    POST /sessions/:id/switch, waits until the renderer shows it
#   box_xy                  page coordinates of the box's centre ("x y")
#   click_box               a real click on the box
#   type_box <text>         a real click on the box, then real typing (xdotool type)
#   clear_box               a real click on the box, ctrl+a, BackSpace
#   wait_search [secs]      until the cross-session search has nothing pending (default 20 s)
#   drag_resizer <dx>       drags the side pane's resizer by <dx> CSS px with the real pointer
#   win_size <w> <h>        POST /window/bounds at 0,0 and waits for the renderer to follow
#   start_second_app / stop_second_app / on_b <cmd...>
#                           a second app with its own HOME, storage, port and uisolate
#                           session (R8); on_b runs <cmd> against it (api, cmd, key, xdo, ...)
#   JQ_BS                   jq -e -L "$BS_JQ_LIB" "$JQ_BS"'<expr>': is_cyan, contrast(a; b)
#
# Process safety (AGENTS.md): the second app is stopped by PID/session like the
# first; stop_app (the EXIT trap's) stops both.

BS_JQ_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JQ_BS='include "color_bs"; '

sstate() { cmd '{"command":"search-state"}'; }
bslog() { cmd '{"command":"buffer-search-log"}'; }

mirror_has() {
  api GET "/sessions/$1" | jq -e --arg t "$2" '(.opened.frame.data // "") | contains($t)' >/dev/null
}

sinput() {
  api POST "/sessions/$1/input" "$(jq -nc --arg t "$2" '{text: $t, enter: true}')" >/dev/null
}

seed_session() {
  local name="$1" text="$2" want="${3:-$2}" select="${4:-true}" r sid
  _zbui_quiet
  r="$(api POST /sessions "$(jq -nc --arg n "$name" --argjson s "$select" \
    '{name: $n, cols: 100, rows: 30, select: $s}')")"
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

drag_resizer() {
  local r x y
  r="$(cmd '{"command":"style-of","selector":"#sidebarResizer"}')"
  read -r x y < <(jq -r '.rect | "\((.left + .width / 2) | floor) \((.top + .height / 2) | floor)"' <<<"$r")
  mouse_to "$x" "$y"
  xdo mousedown 1
  mouse_to "$((x + $1 / 2))" "$y"
  mouse_to "$((x + $1))" "$y"
  xdo mouseup 1
  sleep 0.5
}

_bs_win_is() { sstate | jq -e --argjson w "$1" '.window.innerWidth <= $w and .window.innerWidth >= $w - 40' >/dev/null; }
win_size() {
  api POST /window/bounds "{\"x\":0,\"y\":0,\"width\":$1,\"height\":$2}" >/dev/null
  wait_until 10 _bs_win_is "$1" || true
  sleep 0.5
}

# --- A second app (R8) -------------------------------------------------------
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
