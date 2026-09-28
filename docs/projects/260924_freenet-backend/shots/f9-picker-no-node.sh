#!/usr/bin/env bash
# F9: the share dialog's backend picker when no Freenet node answers (A-11, D-14).
#
# One instance of the DEFAULT package runs on a private uisolate display inside
# its own network namespace (`unshare -rn`, loopback only), so nothing answers
# at ws://127.0.0.1:7509 and share.backends reports freenet `broken`. The node
# on this machine is not touched. The debug server is reachable only inside the
# namespace, so the driver runs there too; the picture is taken from outside.
#
#   APP=<packaged ZBTerm binary> WORK=<empty scratch dir> bash f9-picker-no-node.sh
set -euo pipefail
APP=${APP:?set APP to the packaged ZBTerm binary}
WORK=${WORK:?set WORK to an empty scratch directory}
HERE=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SHOT=${SHOT:-$HERE/f9-picker-no-node.png}
PORT=${PORT:-17294}
UI=(env PYTHONPATH=/ubitron/dev python3 -m ubitron.envs.uisolate)
mkdir -p "$WORK/home" "$WORK/storage" "$WORK/electron"

# Runs inside the namespace: the app in the background, then the driver.
cat >"$WORK/inside.sh" <<INNER
set -u
ip link set lo up
env HOME="$WORK/home" "$APP" --ozone-platform=x11 --no-sandbox --disable-gpu \\
  --storage "$WORK/storage" --electron-user-data "$WORK/electron" \\
  --debug-server --debug-server-port $PORT --no-updates >"$WORK/app.log" 2>&1 &
api() { curl -fsS -X "\$1" -H 'content-type: application/json' \${3:+--data "\$3"} "http://127.0.0.1:$PORT\$2"; }
for _ in \$(seq 1 90); do
  api GET /popups 2>/dev/null | grep -q '"visible":true' && break
  sleep 1
done
api POST /popups/identity-setup/actions/dismiss >/dev/null
sleep 2
api POST /invoke '{"method":"share.backends"}' >"$WORK/backends.json"
SID=\$(api POST /sessions '{"name":"no-node"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionId"])')
api POST "/sessions/\$SID/switch" >/dev/null
sleep 3
api POST /renderer/command '{"command":"share-open"}' >"$WORK/picker.json"
touch "$WORK/ready"
sleep 120
INNER

"${UI[@]}" run --name f9-no-node --new -t 300 -- unshare -rn bash "$WORK/inside.sh" >"$WORK/uisolate.log" 2>&1 &
trap '"${UI[@]}" stop f9-no-node >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 150); do [ -e "$WORK/ready" ] && break; sleep 1; done
[ -e "$WORK/ready" ] || { echo "the instance never showed the share dialog" >&2; exit 1; }
sleep 1
echo "share.backends: $(cat "$WORK/backends.json")"
echo "picker: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["shareBackends"])' "$WORK/picker.json")"
"${UI[@]}" screenshot f9-no-node "$SHOT"
