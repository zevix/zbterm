#!/usr/bin/env bash
# R1 close confirm — proves R1, U1: a close from outside the app (a window manager's WM_DELETE_WINDOW, as a title-bar close, Alt+F4 or a taskbar "Close" sends) while a host session is live is held and asks "Close ZBTerm?" with Cancel, Close and "Don't ask again"; Cancel (Esc) keeps the app; Close with "Don't ask again" ticked quits and turns the question off, so the next outside close quits at once; the settings menu's "Ask before closing with running sessions" turns it back on; no question when no session is live, on SIGTERM, or when the quit comes from the app's own Ctrl+Q popup.
# Asserts (the app log's [EXIT] lines, the app PID, preferences.json, real keys on the dialog): 1) live session, outside close: a window named "Close ZBTerm?" exists, the app lives, the log has window:close-held; Esc: the dialog goes, the app lives, window:close-confirm close=false. 2) outside close, space (tick), Tab, Tab, Return (Close): the app exits, window:close-confirm close=true dontAskAgain=true, preferences.json zbterm.confirmClose == "0". 3) restarted, live session: the settings check reads unchecked; outside close: the app exits with no window:close-held. 4) restarted, the check ticked (a real click): preferences "1"; the shell ended (no live session): outside close exits with no window:close-confirm (no question; external-close-confirmed liveSessions 0). 5) restarted, live session: Ctrl+Q popup → Quit exits with no close-held. 6) restarted, live session: SIGTERM exits with no close-held.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R1_close_confirm
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_if.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real keys on the private display"
need python3 "wm_close.py sends the window manager's close message"
set -x
LOG="$ACCEPT_LOG_DIR/$ZBUI_ID.app.log"
exits() { grep -h '\[EXIT\]' "$LOG" 2>/dev/null | sed 's/^.*\[EXIT\] //' || true; }
held_count() { exits | jq -s '[.[] | select(.event == "window:close-held")] | length'; }
confirm_count() { exits | jq -s '[.[] | select(.event == "window:close-confirm")] | length'; }
outside_close() { uisolate run --name "$ZBUI_SESSION" -t 10 -- python3 "$here/wm_close.py" "$(_zbui_window)"; }
dlg() { xdo search --name '^Close ZBTerm\?$' 2>/dev/null | head -n1; }
dlg_up() { [ -n "$(dlg)" ]; }
dlg_gone() { [ -z "$(dlg)" ]; }
dkey() { local w; w="$(dlg)"; xdo windowfocus --sync "$w"; xdo key --clearmodifiers "$@"; sleep 0.3; }
# The main process keeps its preferences in the app's stable userData (electron/main.js::preferencesPath).
pref() { local f; f="$(find "$ZBUI_APP_HOME" -name preferences.json -path "*ZBTerm*" -print -quit)"; jq -r --arg k zbterm.confirmClose '.[$k] // "unset"' "$f"; }
live_session() { seed_session "$1" 'echo C""READY' CREADY; }
check_item() { menu | jq -c '[.[] | select(.label == "Ask before closing with running sessions")][0]'; }

# --- 1) held, then Cancel (Esc) --------------------------------------------------------
start_app
win_size 1280 800
s="$(live_session c1)"
pid="$(_zbui_app_pid)"; test -n "$pid"
check_item | jq -e '.checked == true'; close_menu
outside_close
wait_until 10 dlg_up
sleep 0.5
kill -0 "$pid"
test "$(held_count)" -ge 1
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R1_dialog.png" >/dev/null
dkey Escape
wait_until 10 dlg_gone
sleep 1; kill -0 "$pid"
exits | jq -s -e '[.[] | select(.event == "window:close-confirm")] | last | .close == false and .count == 1'

# --- 2) Close with "Don't ask again" --------------------------------------------------
outside_close
wait_until 10 dlg_up
sleep 0.5
dkey space
dkey Tab
dkey Tab
dkey Return
wait_gone 40
exits | jq -s -e '[.[] | select(.event == "window:close-confirm")] | last | .close == true and .dontAskAgain == true'
test "$(pref)" = 0

# --- 3) asked no more ---------------------------------------------------------------
start_app
s="$(live_session c3)"
check_item | jq -e '.checked == false'; close_menu
h0="$(held_count)"
outside_close
wait_gone 40
test "$(held_count)" = "$h0"

# --- 4) back on from the settings menu; no live session: no question ---------------------
start_app
m="$(menu)"
click_rect "$(jq -c '[.[] | select(.label == "Ask before closing with running sessions")][0].rect' <<<"$m")"
sleep 0.5
check_item | jq -e '.checked == true'; close_menu
pref_on() { [ "$(pref)" = 1 ]; }
wait_until 10 pref_on
s="$(live_session c4)"
sinput "$s" exit
ended() { inv session.list | jq -e '[.[] | select(.active)] | length == 0' >/dev/null; }
wait_until 20 ended
c0="$(confirm_count)"
outside_close
# Held only to count the live sessions (none): it quits without asking.
wait_gone 40
test "$(confirm_count)" = "$c0"
exits | jq -s -e '[.[] | select(.event == "window:external-close-confirmed")] | last | .liveSessions == 0'

# --- 5) the app's own quit (Ctrl+Q popup) ------------------------------------------------
start_app
s="$(live_session c5)"
h0="$(held_count)"
click_box
key ctrl+q; sleep 0.5
modal | jq -e '.title == "Quit ZBTerm?"'
click_button Quit
wait_gone 40
test "$(held_count)" = "$h0"
dlg_gone

# --- 6) SIGTERM ------------------------------------------------------------------------
start_app
s="$(live_session c6)"
h0="$(held_count)"
quit_app
test "$(held_count)" = "$h0"
echo "R1 close confirm: PASS"
