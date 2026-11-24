#!/usr/bin/env bash
# R8 dialog steady — proves R8: the profile dialog stays where it is while its remote-directory list is filtered (shrinks) and unfiltered (grows); it moves only as far as needed to stay inside the window, and never past its edges.
# Asserts: a throwaway local sshd (as in 261118_session-plugins R1) with a remote dir of 12 subdirectories ("d01".."d11", "zz-only"); a profile "steady" made of SSH + Change Remote Directory, its row placed fourth in the list (three newer profiles); in a 1280x800 window its row's Edit opens the dialog; Browse lists the 12; with the list shown the dialog's top is T and the whole dialog is inside the window; typing "z", "z", "-" into the remote directory box one key at a time (the list shrinks to "zz-only", its height by more than 40 px) leaves the top at T (±1 px) after each key; three BackSpaces (the list grows back) leave it at T or move it only up to keep its bottom inside the window; at every step the dialog is inside the window. The user's ~/.ssh/known_hosts is untouched.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R8_dialog_steady
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_if.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and keys on the private display"
need sshd "a throwaway local SSH server for the remote listing"
need ssh-keygen "keys for that server"
set -x
real_known="$(sha256sum "$(getent passwd "$(id -un)" | cut -d: -f6)/.ssh/known_hosts" 2>/dev/null || echo none)"

# --- A throwaway sshd on 127.0.0.1, this user, key only (261118 R1's) ----------
D="$UBITRON_TEST_STATE_DIR/sshd"
mkdir -p "$D/rhome" "$D/bin"
for i in 01 02 03 04 05 06 07 08 09 10 11; do mkdir -p "$D/remote/d$i"; done
mkdir -p "$D/remote/zz-only"
ssh-keygen -q -t ed25519 -N '' -f "$D/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$D/user_key"
SSHD_PORT="$(free_port)"
cat >"$D/sshd_config" <<CFG
Port $SSHD_PORT
ListenAddress 127.0.0.1
HostKey $D/host_key
PidFile $D/sshd.pid
AuthorizedKeysFile $D/user_key.pub
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
SetEnv HOME=$D/rhome
CFG
cat >"$D/ssh_config" <<CFG
Host *
  UserKnownHostsFile $D/known_hosts
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking accept-new
  IdentityFile $D/user_key
  IdentitiesOnly yes
CFG
printf '#!/bin/sh\nexec %s -F %s "$@"\n' "$(command -v ssh)" "$D/ssh_config" >"$D/bin/ssh"
chmod +x "$D/bin/ssh"
run_bg "$(command -v sshd)" -D -e -f "$D/sshd_config"
sshd_up() { "$D/bin/ssh" -o BatchMode=yes -p "$SSHD_PORT" 127.0.0.1 true; }
wait_until 20 sshd_up
ZBUI_APP_ENV=("PATH=$D/bin:$PATH")

start_app
win_size 1280 900
L() { cmd '{"command":"launch-state"}'; }
lset() { cmd "$(jq -nc --argjson i "$1" --arg f "$2" --arg v "$3" '{command: "launch-set", index: $i, field: $f, value: $v}')" | jq -e '.set' >/dev/null; }

# --- The profile: SSH + Change Remote Directory, through the New dialog ---------
open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
set_field name '"steady"' | jq -e '.set' >/dev/null
click_sel '.launch-add'; click_sel '.launch-add-item[data-plugin="ssh"]'
lset 2 ssh-host 127.0.0.1
lset 2 ssh-port "$SSHD_PORT"
click_sel '.launch-add'; click_sel '.launch-add-item[data-plugin="ssh-cd"]'
lset 3 remote-cwd "$D/remote"
cmd '{"command":"dialog-submit"}' >/dev/null
wait_until 30 has_session steady
sid="$(sid_of steady)"
for n in f1 f2 f3; do seed_session "$n" '' '' false >/dev/null; done
win_size 1280 800

# --- Open its Edit dialog from the row, browse, filter --------------------------
row_action "$sid" edit >/dev/null
L | jq -e '[.steps[].plugin] | index("ssh-cd") != null'
click_sel '.launch-step[data-plugin="ssh-cd"] .launch-row .session-editor-browse'
listed() { sty '.launch-remote-list' | jq -e --arg t "$1" '.found and (.text | contains($t))' >/dev/null; }
wait_until 30 listed zz-only
sleep 0.5
H="$(sstate | jq '.window.innerHeight')"
inside() { jq -e -n --argjson r "$(editor_rect)" --argjson h "$H" '$r.top >= 7.5 and $r.bottom <= $h - 7.5' >/dev/null; }
top() { editor_rect | jq '.top'; }
inside
T="$(top)"; echo "top with the full list: $T ($(editor_rect))"
LH="$(sty '.launch-remote-list' | jq '.rect.height')"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R8_full_list.png" >/dev/null
box="$(sty '.launch-step[data-plugin="ssh-cd"] .launch-row input' | jq -c '.rect')"
click_rect "$box"; key End
same_top() { jq -e -n --argjson a "$(top)" --argjson b "$T" '($a - $b) | fabs <= 1' >/dev/null; }
for k in z z minus; do
  key "$k"; sleep 0.6
  echo "after $k: $(editor_rect) list: $(sty '.launch-remote-list' | jq -c '.rect.height')"
  inside; same_top
done
listed zz-only
# Filtered entries stay in the DOM, hidden: the list itself got shorter, and so did the dialog.
jq -e -n --argjson a "$(sty '.launch-remote-list' | jq '.rect.height')" --argjson b "$LH" '$a < $b - 40'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R8_filtered.png" >/dev/null
prev="$T"
for k in BackSpace BackSpace BackSpace; do
  key "$k"; sleep 0.6
  now="$(top)"; echo "after $k: $(editor_rect)"
  inside
  # Growing: the top stays, or moves up only (to keep the bottom inside).
  jq -e -n --argjson a "$now" --argjson b "$prev" '$a <= $b + 1' >/dev/null
  prev="$now"
done
listed d01
cmd '{"command":"dialog-cancel"}' >/dev/null
test "$real_known" = "$(sha256sum "$(getent passwd "$(id -un)" | cut -d: -f6)/.ssh/known_hosts" 2>/dev/null || echo none)"
echo "R8 dialog steady: PASS"
