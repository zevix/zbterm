#!/usr/bin/env bash
# R5 buffer_section — proves R5: while the box holds text and the side pane is shown, the name matches come first, then a 'Session buffer matches' heading with each live session whose buffer contains the text.
# Asserts: three live sessions: 'alpha' (buffer has ZQX), 'beta' (no ZQX), 'zqx-named' (name matches, buffer has ZQX too); typing ZQX in the box gives: name rows == [zqx-named]; .sessions.heading == "Session buffer matches" and comes after the name rows in DOM order; buffer rows == {alpha, zqx-named}, never beta; a fourth session 'pager' printed ZQX and then runs less on another file (alternate screen), and is listed with its count; with no name match at all (query only in buffers), the heading still follows 'No matching sessions'; with an ended session named 'zqx-old', clicking the pane's 'All' toggle (Active only) drops it from the name rows while the buffer rows stay; clearing the box removes the heading and the buffer rows.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_bs.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
names() { jq -c --arg sec "$1" '[.sessions.rows[] | select(.section == $sec) | .id]'; }
is_ended() { api GET /sessions | jq -e --arg s "$1" 'any(.[]; .sessionId == $s and (.active | not))' >/dev/null; }
# The command lines never hold ZQX itself (p=ZQ … ${p}X).
sa="$(seed_session r5-alpha 'p=ZQ; echo "${p}X here"' 'ZQX here')"
sb="$(seed_session r5-beta 'echo R5B""READY' R5BREADY)"
sn="$(seed_session zqx-named 'p=ZQ; echo "${p}X named"' 'ZQX named')"
# A pager on the alternate screen; ZQX only in its earlier normal-screen output.
sp="$(seed_session r5-pager 'p=ZQ; echo "${p}X before less"; less /etc/os-release' 'ZQX before less')"
sleep 2
type_box ZQX
wait_search
s="$(sstate)"
jq '.sessions' <<<"$s"
names name <<<"$s"
jq -e --arg n "$sn" '[.sessions.rows[] | select(.section == "name") | .id] == [$n]' <<<"$s"
jq -e '.sessions.heading == "Session buffer matches"' <<<"$s"
# Kit correction 2026-11-13 (builder fix round F2), R5/R11 as the user laid them out on
# 2026-11-13: the sections are "Current session" (r5-pager, selected), "Session name matches"
# (zqx-named), "Session buffer matches", in that order; every check below is unchanged.
jq -e '[.sessions.headings[].text] == ["Current session", "Session name matches", "Session buffer matches"]' <<<"$s"
jq -e --arg p "$sp" '[.sessions.rows[] | select(.section == "current") | .id] == [$p]' <<<"$s"
# The heading comes after every name row.
jq -e '.sessions.headingIndex > ([.sessions.rows[] | select(.section == "name") | .index] | max)' <<<"$s"
jq -e --arg a "$sa" --arg n "$sn" --arg p "$sp" '[.sessions.rows[] | select(.section == "buffer") | .id] | sort == ([$a, $n, $p] | sort)' <<<"$s"
jq -e --arg b "$sb" '[.sessions.rows[] | .id] | index($b) == null' <<<"$s"
jq -e --arg p "$sp" '.sessions.rows[] | select(.id == $p) | .sub | test("^[0-9]+ match(es)?$")' <<<"$s"
# Only buffers match: the heading follows "No matching sessions".
clear_box
xdo type --delay 30 'ZQX here'
wait_search
s="$(sstate)"
jq '.sessions' <<<"$s"
jq -e '.sessions.nameEmpty == true and .sessions.heading == "Session buffer matches"' <<<"$s"
# Kit correction 2026-11-13 (F2): no name match, so no "Session name matches" heading.
jq -e '[.sessions.headings[].text] == ["Current session", "Session buffer matches"]' <<<"$s"
jq -e '[.sessions.rows[] | select(.section == "name")] == []' <<<"$s"
jq -e --arg a "$sa" '[.sessions.rows[] | select(.section == "buffer") | .id] == [$a]' <<<"$s"
# An ended zqx-old: "All" lists it by name; Active only drops it, the buffer rows stay.
so="$(seed_session zqx-old 'echo R5O""READY' R5OREADY false)"
sinput "$so" exit
wait_until 30 is_ended "$so"
clear_box
xdo type --delay 30 ZQX
wait_search
s="$(sstate)"
jq -e --arg o "$so" '[.sessions.rows[] | select(.section == "name") | .id] | index($o) != null' <<<"$s"
buf_before="$(names buffer <<<"$s")"
r="$(cmd '{"command":"style-of","selector":"#activeOnly"}')"
click_at "$(jq '(.rect.left + .rect.width / 2) | floor' <<<"$r")" "$(jq '(.rect.top + .rect.height / 2) | floor' <<<"$r")"
wait_search
s="$(sstate)"
jq '.sessions' <<<"$s"
jq -e --arg o "$so" '[.sessions.rows[] | select(.section == "name") | .id] | index($o) == null' <<<"$s"
jq -e --argjson b "$buf_before" '([.sessions.rows[] | select(.section == "buffer") | .id] | sort) == ($b | sort)' <<<"$s"
# Clearing the box removes the heading and the buffer rows.
clear_box
sleep 1
s="$(sstate)"
jq -e '.sessions.heading == null and ([.sessions.rows[] | select(.section == "buffer")] == [])' <<<"$s"
# Kit correction 2026-11-13 (F2): and the plain list is back, no heading at all.
jq -e '.sessions.headings == [] and ([.sessions.rows[] | select(.section != "name")] == [])' <<<"$s"
