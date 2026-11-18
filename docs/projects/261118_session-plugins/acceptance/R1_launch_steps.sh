#!/usr/bin/env bash
# R1 launch steps — proves R1-R8: the session dialog composes its launch from plugin steps. A new dialog shows "Change Directory" and "Shell Command" (no "Home Directory"/"Command"), each with a delete button, and "+ Add" lists Change Directory, Shell Command, SSH. After SSH the menu lists Shell Command and Change Remote Directory only; SSH cannot be deleted while remote steps follow it; an SSH step with no host keeps the dialog open with a message. "Change Remote Directory" browses a real (throwaway, local) sshd: its directories are listed, one is entered and taken. The created session runs its remote command in that remote directory, its catalog entry keeps the steps, the Edit dialog shows them again, and a launch changed behind the dialog's back falls back to the two default steps.
# The sshd, its keys, the ssh client's config and known_hosts all live in the state dir; `ssh` on the app's PATH is a wrapper pinned to them, so the user's ~/.ssh is never read or written (asserted on known_hosts).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R1_launch_steps
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks on the private display"
need sshd "a throwaway local SSH server for the remote steps"
need ssh-keygen "keys for that server"
set -x
real_known="$(sha256sum "$(getent passwd "$(id -un)" | cut -d: -f6)/.ssh/known_hosts" 2>/dev/null || echo none)"

# --- A throwaway sshd on 127.0.0.1, this user, key only ----------------------
D="$UBITRON_TEST_STATE_DIR/sshd"
mkdir -p "$D/remote/alpha/inner" "$D/remote/beta dir" "$D/rhome" "$D/bin"
: >"$D/remote/a-file"
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
real_ssh="$(command -v ssh)"
printf '#!/bin/sh\nexec %s -F %s "$@"\n' "$real_ssh" "$D/ssh_config" >"$D/bin/ssh"
chmod +x "$D/bin/ssh"
run_bg "$(command -v sshd)" -D -e -f "$D/sshd_config"
sshd_up() { "$D/bin/ssh" -o BatchMode=yes -p "$SSHD_PORT" 127.0.0.1 true; }
wait_until 20 sshd_up
ZBUI_APP_ENV=("PATH=$D/bin:$PATH")

start_app
win_size 1280 900
L() { cmd '{"command":"launch-state"}'; }
lset() { cmd "$(jq -nc --argjson i "$1" --arg f "$2" --arg v "$3" '{command: "launch-set", index: $i, field: $f, value: $v}')" | jq -e '.set' >/dev/null; }

# --- R1, R2: the default steps, their delete buttons, the Add menu ------------
s="$(open_dialog '{"command":"click","selector":"#newSession"}')"
jq -e '.modal.kind == "session-editor"
  and (.modal.text | contains("Change Directory:") and contains("Shell Command:"))
  and (.modal.text | contains("Home Directory") | not)
  and ([.modal.fields[] | select(.name == "cwd")][0].value == "~/")
  and ([.modal.fields[] | select(.name == "command")][0].value == "")' <<<"$s"
L | jq -e '[.steps[].plugin] == ["cd", "shell"] and (.steps | all(.removable))
  and .addable == ["cd", "shell", "ssh"] and .launch == {cwd: "~/", command: ""}'
test "$(sty '.launch-step[data-index="0"] .launch-step-remove' | jq -r '.visible')" = true
test "$(sty '.launch-step[data-index="1"] .launch-step-remove' | jq -r '.visible')" = true
click_sel '.launch-add'
L | jq -e '.menuOpen and .menu == ["Change Directory", "Shell Command", "SSH"]'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R1_add_menu.png" >/dev/null

# --- R4: after SSH, the remote directory replaces the local one ---------------
click_sel '.launch-add-item[data-plugin="ssh"]'
L | jq -e '[.steps[].plugin] == ["cd", "shell", "ssh"] and .addable == ["shell", "ssh-cd"] and (.menuOpen | not)'
set_field name '"plug remote"' | jq -e '.set' >/dev/null
# R7: SSH with no host keeps the dialog open and says why.
cmd '{"command":"dialog-submit"}' >/dev/null; sleep 0.5
L | jq -e '.error == "SSH needs a host"'
state | jq -e '.modal.kind == "session-editor"'
lset 2 ssh-host 127.0.0.1
lset 2 ssh-port "$SSHD_PORT"
L | jq -e '.error == ""'
click_sel '.launch-add'
L | jq -e '.menu == ["Shell Command", "Change Remote Directory"]'
click_sel '.launch-add-item[data-plugin="ssh-cd"]'
# R3: any step may go but SSH, which the remote step now depends on.
L | jq -e '[.steps[].plugin] == ["cd", "shell", "ssh", "ssh-cd"] and [.steps[].removable] == [true, true, false, true]'
test "$(sty '.launch-step[data-index="2"] .launch-step-remove' | jq -r '.title')" = 'Delete the steps after this one first'

# --- R5: browsing the remote machine ------------------------------------------
lset 3 remote-cwd "$D/remote"
click_sel '.launch-step[data-plugin="ssh-cd"] .launch-row .session-editor-browse'
listed() { sty '.launch-remote-list' | jq -e --arg t "$1" '.found and (.text | contains($t))' >/dev/null; }
wait_until 30 listed 'beta dir'
sty '.launch-remote-list' | jq -e '.text | contains("alpha") and contains("..") and (contains("a-file") | not)'
# The shown path starts with U+200E (it keeps the path left-to-right in a box that clips its start).
test "$(sty '.launch-remote-path' | jq -r '.text | ltrimstr("\u200e")')" = "$D/remote"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R1_remote_browser.png" >/dev/null
click_sel ".launch-remote-entry[data-path=\"$D/remote/alpha\"]"
wait_until 30 listed inner
click_sel '.launch-remote-use'
L | jq -e --arg p "$D/remote/alpha" '.steps[3].config.path == $p'
test "$(sty '.launch-remote-browser' | jq -r '.visible')" = false

# --- R6: the composed session really runs there -------------------------------
cmd '{"command":"launch-add","plugin":"shell"}' | jq -e '.done'
lset 4 command 'echo RPLUG-OK:$(pwd); sleep 120'
want="ssh -t -p $SSHD_PORT 127.0.0.1 'cd $D/remote/alpha && echo RPLUG-OK:\$(pwd); sleep 120'"
L | jq -e --arg c "$want" '.launch == {cwd: "~/", command: $c}'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R1_composed.png" >/dev/null
cmd '{"command":"dialog-submit"}' >/dev/null
wait_until 30 has_session 'plug remote'
sid="$(sid_of 'plug remote')"
entry_of "$sid" | jq -e --arg c "$want" '.cwd == "~/" and .command == $c
  and [.steps[].plugin] == ["cd", "shell", "ssh", "ssh-cd", "shell"]'
wait_until 40 mirror_has "$sid" "RPLUG-OK:$D/remote/alpha"

# --- R8: the Edit dialog shows the same steps; stale steps fall back ----------
row_action "$sid" edit >/dev/null
L | jq -e --arg p "$D/remote/alpha" '[.steps[].plugin] == ["cd", "shell", "ssh", "ssh-cd", "shell"]
  and .steps[2].config.host == "127.0.0.1" and .steps[3].config.path == $p'
# The last step goes with a real click on its delete button.
click_sel '.launch-step[data-index="4"] .launch-step-remove'
L | jq -e '[.steps[].plugin] == ["cd", "shell", "ssh", "ssh-cd"]'
cmd '{"command":"dialog-cancel"}' >/dev/null
api POST /invoke "$(jq -nc --arg s "$sid" '{method: "session.update", args: {sessionId: $s, command: "htop"}}')" >/dev/null
entry_of "$sid" | jq -e '.command == "htop" and .steps == null'
row_action "$sid" edit >/dev/null
L | jq -e '[.steps[].plugin] == ["cd", "shell"] and .steps[1].config.command == "htop"'
cmd '{"command":"dialog-cancel"}' >/dev/null

# --- An old-style session (cwd and command only) opens as the two steps -------
old="$(api POST /sessions "$(jq -nc --arg d "$D/remote" '{name: "plug old", cwd: $d, command: "sleep 60", select: false}')" | jq -r '.sessionId')"
row_action "$old" edit >/dev/null
L | jq -e --arg d "$D/remote" '[.steps[] | [.plugin, (.config.path // .config.command)]] == [["cd", $d], ["shell", "sleep 60"]]'
cmd '{"command":"dialog-cancel"}' >/dev/null

# The user's own known_hosts was never touched.
test "$real_known" = "$(sha256sum "$(getent passwd "$(id -un)" | cut -d: -f6)/.ssh/known_hosts" 2>/dev/null || echo none)"
api POST /invoke "$(jq -nc --arg s "$sid" '{method: "session.close", args: {sessionId: $s}}')" >/dev/null || true
{ set +x; } 2>/dev/null
echo "PASS: R1 launch steps"
