#!/usr/bin/env bash
# R2 search keys — proves R2, R3, R4, U2: in search, the name rows of "Session name matches" show the matched text in cyan; the match position N/M is in the status line with the stepping hint, never beside the box's x; Esc ends a search while the terminal has the focus and does not reach the shell; with no search Esc reaches the shell.
# Asserts: profiles "alpha-tmp", "beta-TMP-x" and the current "gamma" (whose buffer holds "tmp" three times); after typing "tmp": alpha's and beta's name rows carry a mark with text "tmp" / "TMP" in the theme's match cyan (rgb 77,217,230) on no background; the status line reads "1 / 3 (In terminal Enter/Shift+Enter, in profiles ⬆️/⬇️ )" and the box's own count is empty; Enter, Enter, Shift+Enter make it 2 / 3, 3 / 3, 2 / 3; a real click on alpha's row selects it with the box still holding "tmp" and the terminal focused; a real Esc then empties the box and the shell, waiting in `read -rsn1`, gets the next key "x" (not an ESC); with the box empty, Esc in the terminal reaches the shell (printf %q shows $'\E').
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R2_search_keys
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_if.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and keys on the private display"
set -x
start_app
win_size 1280 800
a="$(seed_session alpha-tmp 'echo A""READY' AREADY)"
b="$(seed_session beta-TMP-x 'echo B""READY' BREADY)"
# The command line spells "t""mp", so only the three output lines match.
g="$(seed_session gamma 'echo "x t""mp y"; echo "t""mp"; echo "a T""MP"; echo G""READY' GREADY)"
select_session "$g"
HINT='(In terminal Enter/Shift+Enter, in profiles ⬆️/⬇️ )'

# --- R2: the matched part of each name, cyan --------------------------------------
type_box tmp; wait_search
sstate | jq -e '[.sessions.headings[].text] | index("Session name matches") != null'
for pair in "$a:tmp" "$b:TMP"; do
  m="$(sty ".session-row[data-session-id=\"${pair%%:*}\"] .session-name mark.name-match")"; echo "$m"
  jq -e --arg t "${pair#*:}" '.found and .visible and .text == $t
    and .color == "rgb(77, 217, 230)" and .backgroundColor == "rgba(0, 0, 0, 0)"' <<<"$m"
done
# The rest of the name is not marked.
sty ".session-row[data-session-id=\"$b\"] .session-name" | jq -e '.text == "beta-TMP-x"'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R2_name_matches.png" >/dev/null

# --- R4: N/M in the status line, with the hint -------------------------------------
# Kit correction 2026-11-21 (R14, the user): the position reads "M / N", spaced.
count_is() { [ "$(status_text)" = "$1 $HINT" ]; }
wait_until 10 count_is '1 / 3'
sstate | jq -e '.box.countText == ""'
sty '#searchCount' | jq -e '.visible | not'
key Return
wait_until 10 count_is '2 / 3'
key Return
wait_until 10 count_is '3 / 3'
key shift+Return
wait_until 10 count_is '2 / 3'

# --- R3: Esc ends the search from the terminal ---------------------------------------
sinput "$a" 'read -rsn1 k; printf "GOT%q\n" "$k"'
sleep 0.5
r="$(row_rect "$a")"
click_at "$(jq -r '(.left + 40) | floor' <<<"$r")" "$(jq -r '(.top + .height / 2) | floor' <<<"$r")"
wait_until 15 _bs_shows "$a"
term_focused() { sstate | jq -e '.terminalFocused' >/dev/null; }
wait_until 10 term_focused
sstate | jq -e '.box.value == "tmp"'
key Escape
box_empty() { sstate | jq -e '.box.value == ""' >/dev/null; }
wait_until 10 box_empty
sstate | jq -e '[.sessions.headings[].text] | index("Session name matches") == null'
key x
wait_until 15 mirror_has "$a" 'GOTx'
api GET "/sessions/$a" | jq -e '(.opened.frame.data // "") | contains("GOT$'"'"'\\E'"'"'") | not'
# The status line no longer holds the search count.
test "$(status_text)" != "2/3 $HINT"

# --- U2: with no search, Esc is the shell's --------------------------------------------
sinput "$a" 'read -rsn1 k; printf "GOT%q\n" "$k"'
sleep 0.5
term_focused
key Escape
wait_until 15 mirror_has "$a" 'GOT$'"'"'\E'"'"''
echo "R2 search keys: PASS"
