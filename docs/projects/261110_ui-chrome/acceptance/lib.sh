# source me after `activate`. The kit harness for 261110_ui-chrome and
# 261110_session-templates: start the packaged app on a private display, drive it
# through the debug server and real keys, stop only what this script started.
#
#   start_app            start (or restart) this script's app; waits until it is ready
#   stop_app             stop this script's app and its uisolate session (idempotent)
#   quit_app             quits this script's app (SIGTERM; the display stays)
#   restart_app          quit_app, then start_app on the same HOME and storage
#   cmd '<json>'         POST /renderer/command; prints the JSON answer (an error too)
#   state                cmd '{"command":"ui-state"}'
#   api METHOD PATH [json]  any debug-server route; prints the JSON answer
#   key <chord>          a real key press (xdotool) on the app's private display
#   xdo <args...>        any xdotool command on that display
#   mouse_to <x> <y>     moves the real pointer to page coordinates (CSS px)
#   click_at <x> <y>     moves there and clicks button 1
#   focus_terminal       a real click in the middle of the terminal
#   term_text            the terminal's visible rows, one per line
#   wait_until <secs> <cmd...>   retries <cmd> every 0.5 s until it succeeds
#   run_bg <cmd...>      a helper process inside this script's session (ended by stop_app)
#   free_port            a free TCP port on 127.0.0.1
#   JQ_COLOR, ZBUI_JQ_LIB  jq -e -L "$ZBUI_JQ_LIB" "$JQ_COLOR"'<expr>': is_green, is_blue, is_orange
#
# Every app gets its own HOME, storage, Electron user data, XDG dirs and TMPDIR
# under the state dir that `activate` made, and no SSH agent: nothing reaches the
# user's own stores. Modelled on test/debug-server-e2e.js (profile picker first,
# then the startup identity wizard).

ZBUI_ID="${ZBUI_ID:-$(basename "$0" .sh)}"
# Dirs are named by the requirement id only (R1, U2): the sidecar's socket lives
# under the storage dir and Unix socket paths stop at 108 bytes.
ZBUI_KEY="${ZBUI_ID%%_*}"
ZBUI_SESSION="zbui-$ZBUI_KEY-$$"
ZBUI_APP_HOME="$ZBUI_HOME/$ZBUI_KEY"
ZBUI_APP_STORAGE="$ZBUI_STORAGE/$ZBUI_KEY"
# Short on purpose: the SSH-agent socket path limit (AGENTS.md).
ZBUI_APP_TMP="$ZBUI_TMP/$$"
ZBUI_PORT=""
ZBUI_RUN_PID=""
ZBUI_SESSION_UP=""
ZBUI_PROFILE="${ZBUI_PROFILE:-zbui}"
ZBUI_APP_LOG="$ACCEPT_LOG_DIR/$ZBUI_ID.app.log"
# Extra NAME=value pairs for the app's environment (e.g. ZBTERM_GITHUB_KEYS_BASE).
ZBUI_APP_ENV=()
# PIDs of this script's background `uisolate run`s started by run_bg.
ZBUI_BG_PIDS=()

# Under run_all.sh the state dir is the runner's, so `activate` set no EXIT trap
# here and nothing would stop this script's app. Only then does lib.sh stop it.
# When activate did set one, its cleanup runs untraced, so a FAIL log ends on the
# failing assertion (plus activate's "kept state dir" line).
if [ -z "$(trap -p EXIT)" ]; then
  trap '{ set +x; } 2>/dev/null; stop_app' EXIT
elif declare -F _ub_state_cleanup >/dev/null; then
  trap '{ _zbui_rc=$?; set +x +e; } 2>/dev/null; (exit "$_zbui_rc"); _ub_state_cleanup' EXIT
fi

_zbui_quiet() { case $- in *x*) set +x; _zbui_x=1 ;; *) _zbui_x="" ;; esac; }
_zbui_loud() { [ -n "$_zbui_x" ] && set -x; return 0; }

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS --max-time 60 -X "$method" "http://127.0.0.1:$ZBUI_PORT$path" \
      -H 'content-type: application/json' -d "$body"
  else
    curl -sS --max-time 60 -X "$method" "http://127.0.0.1:$ZBUI_PORT$path"
  fi
}

cmd() { api POST /renderer/command "$1"; }
state() { cmd '{"command":"ui-state"}'; }

wait_until() {
  local secs="$1"; shift
  local end=$((SECONDS + secs))
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 0.5
  done
}

xdo() { uisolate run --name "$ZBUI_SESSION" -t 30 -- xdotool "$@"; }

# The app's top-level window: the one with the debug server's window bounds.
_zbui_window() {
  xdo search --onlyvisible --class ZBTerm 2>/dev/null | tail -n1
}

key() {
  local win
  win="$(_zbui_window)"
  [ -n "$win" ] && xdo windowfocus --sync "$win" >/dev/null 2>&1 || true
  xdo key --clearmodifiers "$@"
  sleep 0.3
}

# Page (CSS px) to screen coordinates: content bounds plus the zoom factor.
_zbui_screen_xy() {
  local x="$1" y="$2" b
  b="$(api GET /renderer/layout)"
  jq -r --argjson x "$x" --argjson y "$y" '
    (.zoomFactor // 1) as $z
    | "\((.contentBounds.x + $x * $z) | floor) \((.contentBounds.y + $y * $z) | floor)"' <<<"$b"
}

mouse_to() {
  local xy
  xy="$(_zbui_screen_xy "$1" "$2")"
  # shellcheck disable=SC2086
  xdo mousemove --sync $xy
  sleep 0.3
}

click_at() { mouse_to "$1" "$2"; xdo click 1; sleep 0.3; }

focus_terminal() {
  local r
  r="$(api GET /renderer/terminal-display | jq -c '.terminal.rects.screen // .renderer.rects.screen')"
  click_at "$(jq '(.left + .width / 2) | floor' <<<"$r")" "$(jq '(.top + .height / 2) | floor' <<<"$r")"
}

term_text() {
  api GET /renderer/terminal-display \
    | jq -r '(.terminal // .renderer).visibleRows[]?.text'
}

# jq colour helpers (color.jq here): jq -e -L "$ZBUI_JQ_LIB" "$JQ_COLOR"'.x | is_green'
ZBUI_JQ_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JQ_COLOR='include "color"; '

_zbui_health() { api GET /health 2>/dev/null; }

_zbui_answer_profile_picker() {
  local popups id
  popups="$(api GET /popups)"
  jq -e 'any(.[]; .type == "profile-picker")' >/dev/null <<<"$popups" || return 0
  id="$(jq -r --arg n "$ZBUI_PROFILE" \
    '.[] | select(.type == "profile-picker") | .data.profiles[]? | select(.name == $n) | .id' \
    <<<"$popups" | head -n1)"
  if [ -n "$id" ]; then
    api POST /popups/profile-picker/actions/select "{\"profileId\":\"$id\"}" >/dev/null
  else
    api POST /popups/profile-picker/actions/fill-name "{\"name\":\"$ZBUI_PROFILE\"}" >/dev/null
    sleep 1
    api POST /popups/profile-picker/actions/create-and-select "{\"name\":\"$ZBUI_PROFILE\"}" >/dev/null
  fi
}

_zbui_ready() {
  _zbui_health | jq -e '.ok == true and (.renderer.phase // "") != "profile-picker"
    and (any(.popups[]?; .type == "profile-picker") | not)' >/dev/null
}

# The startup identity wizard opens on every profile without an identity. "Not
# now" closes it and leaves the identity as it is (unset), which R6 needs.
_zbui_dismiss_identity_wizard() {
  local end=$((SECONDS + 12)) m
  while [ "$SECONDS" -lt "$end" ]; do
    m="$(cmd '{"command":"modal-state"}')"
    if jq -e '(.title // "") == "Choose your identity"' >/dev/null 2>&1 <<<"$m"; then
      cmd '{"command":"click","text":"Not now"}' >/dev/null
      sleep 0.5
      break
    fi
    sleep 0.5
  done
  if api GET /popups | jq -e 'any(.[]; .type == "identity-setup")' >/dev/null 2>&1; then
    api POST /popups/identity-setup/actions/dismiss '{}' >/dev/null 2>&1 || true
  fi
  return 0
}

start_app() {
  _zbui_quiet
  local args=()
  mkdir -p "$ZBUI_APP_HOME/.ssh" "$ZBUI_APP_STORAGE" "$ZBUI_APP_TMP" "$ZBUI_APP_HOME/electron"
  chmod 700 "$ZBUI_APP_HOME/.ssh"
  ZBUI_PORT="$(free_port)"
  if [ -z "$ZBUI_SESSION_UP" ]; then
    uisolate start --name "$ZBUI_SESSION" >/dev/null
    ZBUI_SESSION_UP=1
  fi
  args=(--storage "$ZBUI_APP_STORAGE" --electron-user-data "$ZBUI_APP_HOME/electron"
    --debug-server --debug-server-port "$ZBUI_PORT")
  # An unpacked chrome-sandbox is not setuid root (run.sh's no_sandbox_fallback).
  local sandbox
  sandbox="$(dirname "$ZBUI_APP")/chrome-sandbox"
  if ! { [ -u "$sandbox" ] && [ "$(stat -c %u "$sandbox")" = 0 ]; }; then args+=(--no-sandbox); fi
  echo "start_app: $ZBUI_SESSION port $ZBUI_PORT home $ZBUI_APP_HOME log $ZBUI_APP_LOG" >&2
  # uisolate keeps its sessions under the real HOME, so the scratch environment is
  # set inside the session, around the app only.
  # Kit correction 2026-11-11 (builder P2): `uisolate run` does not hand the
  # caller's environment to the app, so R2's `export TZ=Europe/Berlin` never
  # reached it (the app formatted in the host's Asia/Jerusalem). A TZ the script
  # set is now passed through explicitly.
  local tz_env=()
  if [ -n "${TZ:-}" ]; then tz_env=("TZ=$TZ"); fi
  uisolate run --name "$ZBUI_SESSION" -t 3600 -- \
    env -u SSH_AUTH_SOCK -u WAYLAND_DISPLAY -u ZBTERM_DEBUG_SERVER -u ZBTERM_DEBUG_SERVER_PORT \
    ${tz_env[@]+"${tz_env[@]}"} \
    HOME="$ZBUI_APP_HOME" TMPDIR="$ZBUI_APP_TMP" \
    XDG_CONFIG_HOME="$ZBUI_APP_HOME/.config" XDG_DATA_HOME="$ZBUI_APP_HOME/.local/share" \
    XDG_CACHE_HOME="$ZBUI_APP_HOME/.cache" XDG_STATE_HOME="$ZBUI_APP_HOME/.local/state" \
    XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 ELECTRON_OZONE_PLATFORM_HINT=x11 \
    ZBTERM_ELECTRON_USER_DATA="$ZBUI_APP_HOME/electron" ZXTERM_CORE_BIN="$ZXTERM_CORE_BIN" \
    ${ZBUI_APP_ENV[@]+"${ZBUI_APP_ENV[@]}"} \
    sh -c 'log="$1"; shift; exec "$@" >>"$log" 2>&1' zbui-app "$ZBUI_APP_LOG" "$ZBUI_APP" "${args[@]}" \
    >>"$ZBUI_APP_LOG.uisolate" 2>&1 &
  ZBUI_RUN_PID=$!
  if ! wait_until 90 _zbui_health; then
    echo "start_app: no debug server on $ZBUI_PORT (see $ZBUI_APP_LOG)" >&2
    _zbui_loud; return 1
  fi
  local end=$((SECONDS + 120))
  until _zbui_ready; do
    _zbui_answer_profile_picker
    if [ "$SECONDS" -ge "$end" ]; then
      echo "start_app: not ready: $(_zbui_health)" >&2
      _zbui_loud; return 1
    fi
    sleep 1
  done
  _zbui_dismiss_identity_wizard
  _zbui_loud
}

# The app's own PID: a child of a process group uisolate recorded for this
# session, whose command line is this app with this script's storage. Found by
# parentage and checked by its command line (AGENTS.md process safety).
_zbui_app_pid() {
  local f="$HOME/.local/state/ubitron/uisolate/$ZBUI_SESSION/session.json" g p
  [ -f "$f" ] || return 0
  for g in $(jq -r '.groups[]?' "$f"); do
    for p in $(ps -o pid= --ppid "$g" 2>/dev/null) $g; do
      if { tr '\0' '\n' <"/proc/$p/cmdline"; } 2>/dev/null | head -n1 | grep -qxF -- "$ZBUI_APP" \
        && { tr '\0' ' ' <"/proc/$p/cmdline"; } 2>/dev/null | grep -qF -- "$ZBUI_APP_STORAGE"; then
        echo "$p"; return 0
      fi
    done
  done
}

# run_bg <cmd...>: a helper process (e.g. a stand-in server) inside this script's
# uisolate session, so stop_app ends it with the session.
run_bg() {
  if [ -z "$ZBUI_SESSION_UP" ]; then uisolate start --name "$ZBUI_SESSION" >/dev/null; ZBUI_SESSION_UP=1; fi
  uisolate run --name "$ZBUI_SESSION" -t 3600 -- "$@" >/dev/null 2>&1 &
  ZBUI_BG_PIDS+=("$!")
}

# This script's own background `uisolate run` (it lingers after the app exits).
_zbui_stop_run_pid() {
  [ -n "$ZBUI_RUN_PID" ] || return 0
  if { tr '\0' ' ' <"/proc/$ZBUI_RUN_PID/cmdline"; } 2>/dev/null | grep -qF -- "$ZBUI_SESSION"; then
    kill "$ZBUI_RUN_PID" 2>/dev/null || true
  fi
  ZBUI_RUN_PID=""
}

# Quits the app the way a user's window close would (SIGTERM: Electron quits and
# saves); the display stays, so start_app can start it again.
quit_app() {
  _zbui_quiet
  local pid end
  pid="$(_zbui_app_pid)"
  if [ -n "$pid" ]; then
    kill -TERM "$pid" 2>/dev/null || true
    end=$((SECONDS + 30))
    while kill -0 "$pid" 2>/dev/null && [ "$SECONDS" -lt "$end" ]; do sleep 0.5; done
  else
    echo "restart_app: app PID not found; stopping the session instead" >&2
    uisolate stop "$ZBUI_SESSION" >/dev/null 2>&1 || true
    ZBUI_SESSION_UP=""
  fi
  _zbui_stop_run_pid
  _zbui_loud
}

restart_app() { quit_app; start_app; }

stop_app() {
  _zbui_quiet
  if [ -n "$ZBUI_SESSION_UP" ]; then
    uisolate stop "$ZBUI_SESSION" >/dev/null 2>&1 || true
    ZBUI_SESSION_UP=""
  fi
  _zbui_stop_run_pid
  local p
  for p in ${ZBUI_BG_PIDS[@]+"${ZBUI_BG_PIDS[@]}"}; do
    if { tr '\0' ' ' <"/proc/$p/cmdline"; } 2>/dev/null | grep -qF -- "$ZBUI_SESSION"; then kill "$p" 2>/dev/null || true; fi
  done
  ZBUI_BG_PIDS=()
  _zbui_loud
  return 0
}

# --- Sessions and dialogs (used by ../../261110_session-templates/acceptance) ---

#   sid_of <name>          the newest session with that name ("" when none)
#   entry_of <sessionId>   its catalog entry (cwd, command, record, ...)
#   has_session <name>     true when a session has that name (for wait_until)
#   row_action <sid> <edit|copy|delete|pin> [shift]   clicks that row's action, waits for
#                          the dialog it opens (if any) and prints ui-state
#   open_dialog '<json>'   cmd <json> (a click), waits for its dialog, prints ui-state
#   set_field <field> <json value>   dialog-set on the open dialog
#   term_has <text>        true when the terminal's visible rows contain <text>
sid_of() {
  api GET /sessions | jq -r --arg n "$1" '[.[] | select(.name == $n)] | last | .sessionId // empty'
}
entry_of() { api GET "/sessions/$1" | jq -c '.entry'; }
has_session() { [ -n "$(sid_of "$1")" ]; }
row_action() {
  cmd "$(jq -nc --arg s "$1" --arg a "$2" --argjson sh "${3:-false}" \
    '{command: "click", shift: $sh,
      selector: (".session-row[data-session-id=\"" + $s + "\"] .session-action[data-action=\"" + $a + "\"]")}')" >/dev/null
  _zbui_wait_modal
}
# open_dialog '<click json>': clicks, waits (up to 15 s) for the dialog the click
# opens (New and Copy ask the engine first), then prints ui-state.
open_dialog() { cmd "$1" >/dev/null; _zbui_wait_modal; }
_zbui_modal_open() { state | jq -e '.modal != null' >/dev/null; }
_zbui_wait_modal() { wait_until 15 _zbui_modal_open || true; state; }
set_field() {
  cmd "$(jq -nc --arg f "$1" --argjson v "$2" '{command: "dialog-set", field: $f, value: $v}')"
}
term_has() { term_text | grep -qF -- "$1"; }

# The session-templates dialog words (its notes--context.md R3, R5).
ZBUI_ADVANCED_SELECT='Set this profile as default for new sessions when:'
ZBUI_SKIP='Skip new/edit profile dialog and open directly'
ZBUI_CHOICE_NEW='The "+ New" button is clicked'
ZBUI_CHOICE_CTRL_SHIFT_T='CTRL+SHIFT+T is pressed'
ZBUI_CHOICE_SHIFT_NEW='The "+ New" button is clicked while holding "Shift"'

# new_profile <name> <cwd> <command> <record true|false> <choice text|""> <skip true|false> [share true|false]
# Creates a profile through the real New dialog, Advanced section included.
new_profile() {
  local r
  open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
  set_field name "$(jq -n --arg v "$1" '$v')" | jq -e '.set' >/dev/null
  set_field cwd "$(jq -n --arg v "$2" '$v')" | jq -e '.set' >/dev/null
  set_field command "$(jq -n --arg v "$3" '$v')" | jq -e '.set' >/dev/null
  set_field 'Record session' "$4" | jq -e '.set' >/dev/null
  if [ -n "$5" ]; then
    set_field Advanced true | jq -e '.set' >/dev/null
    set_field "$ZBUI_ADVANCED_SELECT" "$(jq -n --arg v "$5" '$v')" | jq -e '.set' >/dev/null
    set_field "$ZBUI_SKIP" "$6" | jq -e '.set' >/dev/null
  fi
  if [ "${7:-false}" = true ]; then set_field 'Share session now' true | jq -e '.set' >/dev/null; fi
  r="$(cmd '{"command":"dialog-submit"}')"
  jq -e '.done' >/dev/null <<<"$r"
  wait_until 30 has_session "$1"
}
