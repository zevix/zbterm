#!/usr/bin/env bash
# F9 GUI proof (A-14; docs/projects/260924_freenet-backend/plan.md, phase F9 step 8).
#
# Two isolated instances of the DEFAULT package (pear,freenet) run on private
# uisolate displays, both against the Freenet node already running on this
# machine at ws://127.0.0.1:7509 (ZBTerm never starts one, D-12). The host
# opens the share dialog, picks Freenet in the backend picker and shares; the
# viewer joins the link; both report their share diagnostics; the host types a
# line; the viewer's screen is saved as f9-join.png next to this script.
#
#   APP=<packaged ZBTerm binary> WORK=<empty scratch dir> bash f9-run.sh
#
# Each instance has its own --storage, --electron-user-data, debug-server port
# and a scratch HOME (no shell profile, no key paths in the picture), and is
# started with --no-updates. Both are stopped with `uisolate stop`, never by a
# signal to a process name. Nothing here touches the node beyond what the app
# itself does as a WebSocket client (Put/Subscribe of ZBTerm's contracts).
set -euo pipefail

APP=${APP:?set APP to the packaged ZBTerm binary (…/ZBTerm-linux-x64/ZBTerm)}
WORK=${WORK:?set WORK to an empty scratch directory}
HERE=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SHOT=${SHOT:-$HERE/f9-join.png}
HOST_PORT=${HOST_PORT:-17291}
VIEWER_PORT=${VIEWER_PORT:-17292}
MARK="F9 over Freenet: host output reached the viewer"
UI=(env PYTHONPATH=/ubitron/dev python3 -m ubitron.envs.uisolate)

log() { printf '[f9-run %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

api() { # api METHOD PORT PATH [JSON]
  local method=$1 port=$2 path=$3 body=${4:-}
  if [ -n "$body" ]; then
    curl -fsS -X "$method" -H 'content-type: application/json' --data "$body" \
      "http://127.0.0.1:$port$path"
  else
    curl -fsS -X "$method" "http://127.0.0.1:$port$path"
  fi
}

json() { # json EXPR < body   (EXPR over `d`, printed as JSON unless a string)
  python3 -c 'import json,sys
d=json.load(sys.stdin)
v=eval(sys.argv[1])
print(v if isinstance(v,str) else json.dumps(v))' "$1"
}

launch() { # launch ROLE PORT
  local role=$1 port=$2 dir=$WORK/$1
  mkdir -p "$dir/home" "$dir/storage" "$dir/electron"
  log "starting $role on uisolate session f9-$role, debug port $port"
  "${UI[@]}" run --name "f9-$role" --new -t 900 -- \
    env HOME="$dir/home" "$APP" --ozone-platform=x11 --no-sandbox --disable-gpu \
    --storage "$dir/storage" --electron-user-data "$dir/electron" \
    --debug-server --debug-server-port "$port" --no-updates \
    >"$dir/app.log" 2>&1 &
  echo $! >"$dir/uisolate-run.pid"
}

# Not /health's `ok`: under uisolate the renderer reports "WebGL2 not supported"
# although the UI renders (backend-abstraction open-issues row 26). Ready is
# the engine up and the renderer's first-run identity prompt on screen, which
# is then dismissed ("Not now").
identity_prompt() { # identity_prompt PORT -> "yes" while the prompt is on screen
  api GET "$1" /popups 2>/dev/null | json '"yes" if any(p.get("id")=="identity-setup" and (p.get("renderer") or {}).get("visible") for p in d) else "no"' 2>/dev/null || echo "none"
}

wait_ready() { # wait_ready PORT
  for _ in $(seq 1 120); do
    if [ "$(identity_prompt "$1")" = yes ]; then
      api POST "$1" /popups/identity-setup/actions/dismiss >/dev/null
      for _ in $(seq 1 20); do
        [ "$(identity_prompt "$1")" = no ] && return 0
        sleep 0.5
      done
    fi
    sleep 1
  done
  log "instance on port $1 never became ready"
  return 1
}

stop_all() {
  for role in host viewer; do "${UI[@]}" stop "f9-$role" >/dev/null 2>&1 || true; done
}
trap stop_all EXIT

launch host "$HOST_PORT"
launch viewer "$VIEWER_PORT"
wait_ready "$HOST_PORT"
wait_ready "$VIEWER_PORT"

for role in host viewer; do
  port=$HOST_PORT; [ $role = viewer ] && port=$VIEWER_PORT
  api POST "$port" /invoke '{"method":"share.backends"}' >"$WORK/$role-backends.json"
  log "$role share.backends: $(json '[(b["id"], b["state"], b["detail"]) for b in d["backends"]]' <"$WORK/$role-backends.json")"
done

SID=$(api POST "$HOST_PORT" /sessions '{"name":"f9-freenet","cols":100,"rows":30}' | json 'd["sessionId"]')
log "host session $SID"
api POST "$HOST_PORT" "/sessions/$SID/switch" >/dev/null
for _ in $(seq 1 30); do
  SEL=$(api GET "$HOST_PORT" /renderer/layout | json '((d.get("renderer") or {}).get("app") or {}).get("selectedId") or ""')
  [ "$SEL" = "$SID" ] && break
  sleep 1
done
sleep 1

# The share dialog, the backend picker, Freenet, Share.
api POST "$HOST_PORT" /renderer/command '{"command":"share-open"}' >"$WORK/host-picker.json"
log "picker: $(json 'd["shareBackends"]' <"$WORK/host-picker.json")"
api POST "$HOST_PORT" /renderer/command '{"command":"share-backend","backend":"freenet"}' >/dev/null
api POST "$HOST_PORT" /renderer/command '{"command":"share-submit"}' >"$WORK/host-shared.json"
URI=""
for _ in $(seq 1 60); do
  URI=$(api POST "$HOST_PORT" /renderer/command '{"command":"modal-state"}' | json '(d or {}).get("shareKey") or ""')
  [ -n "$URI" ] && break
  sleep 1
done
[ -n "$URI" ] || { log "no share key"; exit 1; }
api POST "$HOST_PORT" /renderer/command '{"command":"share-done"}' >/dev/null || true
log "invite: ${URI:0:48}…"

T0=$(date +%s%N)
api POST "$VIEWER_PORT" /join "{\"uri\":\"$URI\"}" >"$WORK/viewer-join.json"
JOINED=""
for _ in $(seq 1 90); do
  JOINED=$(api GET "$VIEWER_PORT" /events | json '[e for e in d if e.get("name")=="share:join-changed" and (e.get("data") or {}).get("status") in ("joined","failed")][-1:]' || true)
  case "$JOINED" in *joined*|*failed*) break ;; esac
  sleep 1
done
T1=$(date +%s%N)
log "join: $JOINED ($(( (T1 - T0) / 1000000 )) ms)"

api POST "$HOST_PORT" "/sessions/$SID/input" "{\"data\":\"clear; echo '$MARK'\\r\"}" >/dev/null
sleep 5

for role in host viewer; do
  port=$HOST_PORT; [ $role = viewer ] && port=$VIEWER_PORT
  api GET "$port" /share/diagnostics >"$WORK/$role-diagnostics.json"
  api GET "$port" /events >"$WORK/$role-events.json"
  log "$role diagnostics: $(json '{"backend": (d.get("backend") or {}).get("id"), "conns": [(c["peer"][:8], c["iceState"], c["path"]) for c in (d.get("backend") or {}).get("conns", [])], "ice": (d.get("backend") or {}).get("ice")}' <"$WORK/$role-diagnostics.json")"
done
api GET "$VIEWER_PORT" /renderer/terminal-display >"$WORK/viewer-display.json"
if grep -q "$MARK" "$WORK/viewer-display.json"; then log "the viewer's terminal shows the host's line"; else log "the viewer's terminal does NOT show the host's line"; fi

"${UI[@]}" screenshot f9-viewer "$SHOT"
log "screenshot: $SHOT"
