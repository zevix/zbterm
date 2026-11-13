#!/usr/bin/env bash
# verifier probe: does selecting a live session while it prints duplicate output in the renderer?
# Compares the renderer's in-session match count with the engine mirror's for one trial's tag.
set -uo pipefail
K=/zp/zdata/zeev/github/zbterm/docs/projects/261111_buffer-search/acceptance
export ZBUI_ID=DLV_dup ZBUI_APP=/tmp/claude-1000/zbdeliv/out/ZBTerm-linux-x64/ZBTerm ZBUI_OUT=/tmp/claude-1000/zbdeliv/out
source $K/activate
source "$ZBUI_LIB"; ZBUI_APP_ENV=(ELECTRON_ENABLE_LOGGING=1)
source $K/lib_bs.sh
start_app
win_size 1280 800
a="$(seed_session v-a 'echo A""READY' AREADY)"
b="$(seed_session v-b 'echo B""READY' BREADY)"
echo "app $ZBUI_APP a=$a b=$b"
ntr="${1:-8}"
for k in $(seq 1 "$ntr"); do
  select_session "$b" >/dev/null
  sinput "$a" "t=Z$k; for i in \$(seq 1 1200); do echo \"L \${t}Z \$i\"; sleep 0.002; done; echo DU\"\"P$k"
  sleep "0.$((RANDOM % 9 + 3))"
  select_session "$a" >/dev/null
  wait_until 60 mirror_has "$a" "DUP$k" >/dev/null || echo "trial $k: no end marker"
  sleep 0.5
  eng="$(api POST /invoke "$(jq -nc --arg s "$a" --arg q "Z${k}Z" '{method:"session.searchBuffer",args:{sessionId:$s,query:$q}}')" | jq '.count')"
  type_box "Z${k}Z"; sleep 1
  ren="$(sstate | jq '.inSession.total')"
  key Escape
  echo "trial $k: $(grep -a DELIVPROBE "$ZBUI_APP_LOG" | tail -n1 | sed "s/.*DELIVPROBE //")"; echo "trial $k: engine $eng renderer $ren $([ "$ren" != "$eng" ] && echo MISMATCH)"
done
