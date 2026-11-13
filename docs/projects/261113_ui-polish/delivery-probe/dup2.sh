#!/usr/bin/env bash
# dup2.sh <variant as-is|clear> [trials]: the verifier's dup.sh probe (/tmp/claude-1000/zbv4/probe/dup.sh)
# against an instrumented scratch copy of the package: each trial also says whether a live write was
# in flight in the renderer when session.open's frame was painted (renderLiveFrame).
set -uo pipefail
export ZBUI_OUT=/tmp/claude-1000/zbui-polish/probe-out
export ZBUI_APP=$ZBUI_OUT/ZBTerm-linux-x64/ZBTerm
export ZBUI_TMP=/tmp/zbup-p UB_ACCEPT_TMP=/tmp/claude-1000/zbui-polish/accept
K=/zp/zdata/zeev/github/zbterm/docs/projects/261111_buffer-search/acceptance
export ZBUI_ID=V4_dup
source $K/activate
source "$ZBUI_LIB"
source $K/lib_bs.sh
start_app
win_size 1280 800
cmd "{\"command\":\"dup-variant\",\"variant\":\"$1\"}"
a="$(seed_session v-a 'echo A""READY' AREADY)"
b="$(seed_session v-b 'echo B""READY' BREADY)"
echo "app $ZBUI_APP variant $1 a=$a b=$b"
ntr="${2:-12}"
for k in $(seq 1 "$ntr"); do
  select_session "$b" >/dev/null
  sinput "$a" "t=Z$k; for i in \$(seq 1 1200); do echo \"L \${t}Z \$i\"; sleep 0.002; done; echo DU\"\"P$k"
  sleep "0.$((RANDOM % 9 + 3))"
  select_session "$a" >/dev/null
  wait_until 60 mirror_has "$a" "DUP$k" >/dev/null || echo "trial $k: no end marker"
  sleep 0.5
  fr="$(sstate | jq -c '.dupProbe | map(select(.variant)) | last')"
  eng="$(api POST /invoke "$(jq -nc --arg s "$a" --arg q "Z${k}Z" '{method:"session.searchBuffer",args:{sessionId:$s,query:$q}}')" | jq '.count')"
  type_box "Z${k}Z"; sleep 1
  ren="$(sstate | jq '.inSession.total')"
  key Escape
  echo "trial $k: engine $eng renderer $ren frame $fr $([ "$ren" != "$eng" ] && echo MISMATCH)"
done
