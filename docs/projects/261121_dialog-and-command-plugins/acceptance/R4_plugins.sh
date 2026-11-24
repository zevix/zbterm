#!/usr/bin/env bash
# R4 plugins — proves R4–R8, U1–U3: on first start the app creates ~/.config/ZBTerm/plugins/commands/ with the sample plugins (sample_custom_command.js among them) and a commands.json choosing every built-in and only sample_custom_command.js; "+ Add" ends with a separator, "Sample custom command", a separator and "Plugins…" (puzzle icon); "Plugins…" opens a dialog with "Built-in" and "From ~/.config/ZBTerm/plugins/commands/" sections, a checkbox per plugin and per .js file, files that failed to load shown with their reason; its Save rewrites commands.json and changes what "+ Add" offers; a profile's steps fill {{name}} and {{slug}} with its name, a Clone with its own; a Shell Command runs the user's bash aliases and a PATH set in ~/.bashrc; an unticked plugin's step stays in its profile; an existing directory is never re-seeded.
# Asserts: the directory lists commands.json, python_venv.js, sample_custom_command.js, tmux_session.js; commands.json == {"commands": ["sample_custom_command.js"]}. After adding broken.js (a syntax error), thief.js (registers id "shell") and empty.js (registers nothing): the New dialog's "+ Add" menu ends ["-", "Sample custom command", "-", "Plugins…"], its first group holds "Change Directory", "Shell Command", "SSH"; the Plugins… icon is fa-puzzle-piece. A real click on Plugins…: sections ["Built-in", "From ~/.config/ZBTerm/plugins/commands/"]; built-in rows cd, shell, ssh, ssh-cd ticked; sample ticked, tmux and venv not; broken.js, empty.js ("It registered no plugin") and thief.js ("…taken by a built-in plugin") disabled with their reasons. Real clicks: tick tmux_session.js, untick SSH, Save: commands.json {"builtin": ["cd","shell","ssh-cd"], "commands": ["sample_custom_command.js","tmux_session.js"]}; the menu now has "tmux session" and no "SSH". A real click on "Sample custom command" adds its step; name "Work #2", Shell Command "zbhello; zbtool": the launch is `zbhello; zbtool && echo 'Hello from Work #2 (work-2)' && exec "$SHELL"`; OK: the session prints ALIAS-OK, TOOL-OK and "Hello from Work #2 (work-2)". Plugins: untick the sample, Save; Edit "Work #2": its steps still hold sample-custom-command and "+ Add" no longer offers it. Shift+Copy (Clone) "Work #2": "Work #3" prints "Hello from Work #3 (work-3)". Quit, delete tmux_session.js, start: it stays deleted and commands.json is byte-identical. Kit corrections 2026-11-21 (builder P1): C4 the ~/.bashrc also prints ZB-BANNER (seen, and the rest still works); C6 the New dialog is still open after the Plugins dialog's Save and after its Esc; C1 a profile named `z; touch "$HOME/PWNED"` with `echo {{name}}` prints the name and no PWNED file appears; C11 Rename "Work #2" to "Work #9" (#rename): its command says "Hello from Work #9 (work-9)" and Edit keeps the sample step; C12 a "Tmuxy" profile with the tmux sample (a stand-in tmux on the PATH), tmux_session.js moved away (not deleted) before the restart: Edit shows "sample-tmux-session is not loaded; its step is shown as a command", the step as a Shell Command, and the stored launch is unchanged.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R4_plugins
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_dp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks on the private display"
need /bin/bash "the shell whose aliases R4 uses"
set -x
# R4: an alias and a PATH entry that exist only in the user's ~/.bashrc.
mkdir -p "$ZBUI_APP_HOME/zbbin"
printf '#!/bin/sh\necho TOOL""-OK\n' >"$ZBUI_APP_HOME/zbbin/zbtool"; chmod +x "$ZBUI_APP_HOME/zbbin/zbtool"
cat >>"$ZBUI_APP_HOME/.bashrc" <<'RC'
alias zbhello='echo ALIAS""-OK'
export PATH="$HOME/zbbin:$PATH"
RC
# Kit correction 2026-11-21 (builder P1): design C4 (F4): the rc file also prints a banner,
# as many do; the alias, the PATH and the sample's line must still work. Added.
echo 'echo "ZB-BAN""NER"' >>"$ZBUI_APP_HOME/.bashrc"
# Kit correction 2026-11-21 (builder P1): design C12 needs a profile that uses the tmux
# sample; a stand-in `tmux` on the rc file's PATH prints its arguments and sleeps 20 s (the
# session stays live long enough to be read; the PTY's hang-up ends it at quit), so no tmux
# server is ever started. Added.
printf '#!/bin/sh\necho "FAKE""-TMUX $*"\nexec sleep 20\n' >"$ZBUI_APP_HOME/zbbin/tmux"; chmod +x "$ZBUI_APP_HOME/zbbin/tmux"
ZBUI_APP_ENV=("SHELL=/bin/bash")
start_app
win_size 1400 800
D="$(plugins_dir)"

# --- R7: seeded on the first start ------------------------------------------------------------
test "$(ls "$D" | tr '\n' ' ')" = "commands.json python_venv.js sample_custom_command.js tmux_session.js "
jq -e '. == {"commands": ["sample_custom_command.js"]}' "$D/commands.json"
printf 'this is not ( javascript\n' >"$D/broken.js"
printf '// registers nothing\n' >"$D/empty.js"
cat >"$D/thief.js" <<'JS'
;(() => {
  const launch = window.zbtermLaunch
  class Thief extends launch.LaunchPlugin {
    static id = 'shell'
    static title = 'Thief'
  }
  launch.register(Thief)
})()
JS

# --- R5: the "+ Add" menu -----------------------------------------------------------------------
open_dialog '{"command":"click","selector":"#newSession"}' | jq -e '.modal.kind == "session-editor"'
m="$(cmd '{"command":"launch-menu","open":true}' | jq -c '.launch.menu')"; echo "$m"
jq -e '.[-4:] == ["-", "Sample custom command", "-", "Plugins…"]' <<<"$m"
jq -e '(.[0:index("-")]) as $b | ["Change Directory", "Shell Command", "SSH"] - $b == []' <<<"$m"
sty '.launch-add-plugins i' | jq -e '(.className | contains("fa-puzzle-piece")) and .visible'

# --- R6, U1: the Plugins dialog -----------------------------------------------------------------
click_sel '.launch-add-plugins'
dialog_open() { pstate | jq -e '.dialog != null' >/dev/null; }
wait_until 10 dialog_open
p="$(pstate)"; echo "$p" | jq -c '.dialog | {sections, rows: [.rows[] | {kind, key, checked, disabled, error}]}'
jq -e '.dialog.sections == ["Built-in", "From ~/.config/ZBTerm/plugins/commands/"]' <<<"$p"
row() { jq -c --arg k "$1" '.dialog.rows[] | select(.key == $k)' <<<"$p"; }
for id in cd shell ssh ssh-cd; do row "$id" | jq -e '.kind == "builtin" and .checked and (.disabled | not)'; done
row sample_custom_command.js | jq -e '.kind == "file" and .checked and .title == "Sample custom command"'
row tmux_session.js | jq -e '(.checked | not) and (.disabled | not)'
row python_venv.js | jq -e '(.checked | not) and (.disabled | not)'
row broken.js | jq -e '.disabled and (.checked | not) and (.error | length > 0)'
row empty.js | jq -e '.disabled and .error == "It registered no plugin"'
row thief.js | jq -e '.disabled and (.error | contains("taken by a built-in plugin"))'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R4_plugins_dialog.png" >/dev/null
click_rect "$(row tmux_session.js | jq -c '.rect')"
click_rect "$(row ssh | jq -c '.rect')"
pstate | jq -e '(.dialog.rows | map({(.key): .checked}) | add) as $c | $c["tmux_session.js"] and ($c.ssh | not)'
click_sel '.plugins-dialog-panel button[type="submit"]'
saved() { jq -e '. == {"builtin": ["cd", "shell", "ssh-cd"], "commands": ["sample_custom_command.js", "tmux_session.js"]}' "$D/commands.json" >/dev/null; }
wait_until 10 saved
pstate | jq -e '.dialog == null'
# Kit correction 2026-11-21 (builder P1): design C6 (F6): the profile dialog is still open
# after the Plugins dialog's Save, and after its Esc. Added.
state | jq -e '.modal.kind == "session-editor" and .modal.title == "New profile"'
m="$(cmd '{"command":"launch-menu","open":true}' | jq -c '.launch.menu')"; echo "$m"
jq -e 'index("tmux session") != null and index("SSH") == null and index("Sample custom command") != null' <<<"$m"
click_sel '.launch-add-plugins'
wait_until 10 dialog_open
key Escape
dialog_closed() { pstate | jq -e '.dialog == null' >/dev/null; }
wait_until 10 dialog_closed
state | jq -e '.modal.kind == "session-editor" and .modal.title == "New profile"'
cmd '{"command":"launch-menu","open":true}' >/dev/null

# --- R8 (and R4): placeholders, the alias and the PATH --------------------------------------------
click_sel '.launch-add-item[data-plugin="sample-custom-command"]'
set_field name '"Work #2"' | jq -e '.set'
cmd "$(jq -nc '{command: "launch-set", index: 1, field: "command", value: "zbhello; zbtool"}')" | jq -e '.set'
L="$(cmd '{"command":"launch-state"}')"; echo "$L"
jq -e '[.steps[].plugin] == ["cd", "shell", "sample-custom-command"]' <<<"$L"
jq -e '.steps[2].config.message == "Hello from {{name}} ({{slug}})"' <<<"$L"
jq -e --arg c "zbhello; zbtool && echo 'Hello from Work #2 (work-2)' && exec \"\$SHELL\"" '.launch.command == $c' <<<"$L"
cmd '{"command":"dialog-submit"}' | jq -e '.done'
wait_until 30 has_session 'Work #2'
w="$(sid_of 'Work #2')"
select_session "$w"
wait_until 20 term_has 'Hello from Work #2 (work-2)'
term_has ALIAS-OK
term_has TOOL-OK
term_has ZB-BANNER
! term_has 'command not found' || { echo "a command was not found" >&2; exit 1; }

# Kit correction 2026-11-21 (builder P1): design C1 (F1, A-12): a name that is shell syntax,
# used as {{name}} in a Shell Command, is one quoted word: printed, never run. Added.
evil='z; touch "$HOME/PWNED"'
open_dialog '{"command":"click","selector":"#newSession"}' | jq -e '.modal.kind == "session-editor"'
set_field name "$(jq -nc --arg v "$evil" '$v')" | jq -e '.set'
c1='echo {{name}}; echo C1""-DONE; sleep 20'
cmd "$(jq -nc --arg v "$c1" '{command: "launch-set", index: 1, field: "command", value: $v}')" | jq -e '.set'
L="$(cmd '{"command":"launch-state"}')"; echo "$L"
jq -e --arg c "echo 'z; touch \"\$HOME/PWNED\"'; echo C1\"\"-DONE; sleep 20" '.launch.command == $c' <<<"$L"
cmd '{"command":"dialog-submit"}' | jq -e '.done'
wait_until 30 has_session "$evil"
select_session "$(sid_of "$evil")"
wait_until 20 term_has C1-DONE
term_has "$evil"
test ! -e "$ZBUI_APP_HOME/PWNED"
select_session "$w"

# --- U3: an unticked plugin's step stays ---------------------------------------------------------
open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
cmd '{"command":"launch-menu","open":true}' >/dev/null
click_sel '.launch-add-plugins'
wait_until 10 dialog_open
p="$(pstate)"
click_rect "$(row sample_custom_command.js | jq -c '.rect')"
click_sel '.plugins-dialog-panel button[type="submit"]'
unticked() { jq -e '.commands == ["tmux_session.js"]' "$D/commands.json" >/dev/null; }
wait_until 10 unticked
cmd '{"command":"dialog-cancel"}' >/dev/null
no_modal() { state | jq -e '.modal == null' >/dev/null; }
wait_until 10 no_modal
row_action "$w" edit >/dev/null
L="$(cmd '{"command":"launch-state"}')"; echo "$L"
jq -e '[.steps[].plugin] == ["cd", "shell", "sample-custom-command"] and (.addable | index("sample-custom-command") == null)' <<<"$L"
cmd '{"command":"dialog-cancel"}' >/dev/null
wait_until 10 no_modal

# --- R8: a Clone gets its own name ------------------------------------------------------------------
row_action "$w" copy true >/dev/null
wait_until 30 has_session 'Work #3'
entry_of "$(sid_of 'Work #3')" | jq -e '.command | contains("Hello from Work #3 (work-3)")'
select_session "$(sid_of 'Work #3')"
wait_until 20 term_has 'Hello from Work #3 (work-3)'

# Kit correction 2026-11-21 (builder P1): design C11 (F11, Q-1): a rename recompiles the
# placeholders under the new name; Edit then still shows the plugin step. Added. The design
# says "from the right-click menu", which has no Rename: renameSession is reached by the
# (hidden) #rename button, clicked here; a rename in the Edit dialog compiles with the
# typed name already (steps-editor named()).
select_session "$w"
cmd '{"command":"click","selector":"#rename"}' >/dev/null
wait_until 10 _zbui_modal_open
state | jq -e '.modal.title == "Rename session"'
click_sel '.modal-panel .modal-input'
key ctrl+a; xdo type --delay 30 -- 'Work #9'; key Return
wait_until 30 has_session 'Work #9'
renamed() { entry_of "$w" | jq -e '.command | contains("Hello from Work #9 (work-9)")' >/dev/null; }
wait_until 10 renamed
entry_of "$w" | jq -e '(.steps | map(.plugin)) == ["cd", "shell", "sample-custom-command"]'
row_action "$w" edit >/dev/null
wait_until 10 _zbui_modal_open
L="$(cmd '{"command":"launch-state"}')"; echo "$L"
jq -e '[.steps[].plugin] == ["cd", "shell", "sample-custom-command"] and .steps[2].config.message == "Hello from {{name}} ({{slug}})"' <<<"$L"
jq -e '.launch.command | contains("Hello from Work #9 (work-9)")' <<<"$L"
cmd '{"command":"dialog-cancel"}' >/dev/null
wait_until 10 no_modal

# Kit correction 2026-11-21 (builder P1): design C12 (F12): a profile that uses the tmux
# sample (the stand-in tmux above), for after the restart below. Added.
open_dialog '{"command":"click","selector":"#newSession"}' | jq -e '.modal.kind == "session-editor"'
set_field name '"Tmuxy"' | jq -e '.set'
cmd '{"command":"launch-menu","open":true}' >/dev/null
click_sel '.launch-add-item[data-plugin="sample-tmux-session"]'
L="$(cmd '{"command":"launch-state"}')"; echo "$L"
jq -e '[.steps[].plugin] == ["cd", "shell", "sample-tmux-session"] and (.launch.command | contains("tmux new-session -A -s tmuxy"))' <<<"$L"
cmd '{"command":"dialog-submit"}' | jq -e '.done'
wait_until 30 has_session 'Tmuxy'
t="$(sid_of 'Tmuxy')"
select_session "$t"
wait_until 20 term_has 'FAKE-TMUX new-session -A -s tmuxy'
before="$(entry_of "$t" | jq -c '{cwd, command}')"

# --- U2: never re-seeded -----------------------------------------------------------------------------
cp "$D/commands.json" "$ACCEPT_LOG_DIR/R4_commands.json"
quit_app
# Kit correction 2026-11-21 (builder P1): design C12 names "tmux_session.js renamed away";
# the file is moved to a name that is not .js instead of deleted, so U2's checks below
# (it stays gone, commands.json byte-identical) are the same. Changed from `rm`.
mv "$D/tmux_session.js" "$D/tmux_session.js.off"
start_app
pstate | jq -e '[.files[].file] | index("tmux_session.js") == null'
test ! -e "$D/tmux_session.js"
cmp "$D/commands.json" "$ACCEPT_LOG_DIR/R4_commands.json"
# C12: Edit opens with the notice, the step shown as its command, and the launch unchanged.
row_action "$t" edit >/dev/null
wait_until 10 _zbui_modal_open
sty '.session-editor-missing' | jq -e '.visible and .text == "sample-tmux-session is not loaded; its step is shown as a command"'
L="$(cmd '{"command":"launch-state"}')"; echo "$L"
jq -e '[.steps[].plugin] == ["cd", "shell"] and (.steps[1].config.command | contains("tmux new-session -A -s tmuxy"))' <<<"$L"
cmd '{"command":"dialog-cancel"}' >/dev/null
wait_until 10 no_modal
test "$(entry_of "$t" | jq -c '{cwd, command}')" = "$before"
echo "R4 plugins: PASS"
