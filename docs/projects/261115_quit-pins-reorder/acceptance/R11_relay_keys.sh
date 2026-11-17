#!/usr/bin/env bash
# R11 relay keys — proves R11–R17, R20, R21, U5 on relay/server.js with a scratch HOME and a local hyperdht testnet (never the public DHT): one program; secret and salt files made 0600 in a 0700 ~/.zbterm with info lines; the access-key line; env that differs is used with a note and the file kept; a bad file stops it and is kept; --print-key / --check write nothing; --rotate-access-key changes the key and a running relay follows (new key reaches it, old key does not); a read-only HOME still runs with an error.
# Asserts: no relay/registry-publish.js and build-relay.js names no registry-publish; first start prints "Created a new relay secret", "Created a new access salt", "ZBTerm relay access key: <64 hex>"; modes 600/700; --print-key prints the same key; a second start the same key and no "Created"; ZBTERM_RELAY_SEED different → "[note]" and the file unchanged and a different key; a bad secret file → exit != 0, "[error]" naming the file, file unchanged; --check exit 0 with "OK", and != 0 on the bad file; rotate → new key, a running relay prints "[rotate]" and the new key; a testnet client connects to the new key and not the old; read-only HOME → "[error] Could not save" and the key line.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R11_relay_keys
source "$here/activate"
need node "runs relay/server.js"
need jq "json"
set -x
repo="$UB_REPO"
test ! -e "$repo/relay/registry-publish.js"
! grep -q registry-publish "$repo/scripts/build-relay.js" || exit 1
H="$UBITRON_TEST_STATE_DIR/rh"; mkdir -p "$H"
relay() { env -u ZBTERM_RELAY_SEED -u ZBTERM_RELAY_ACCESS_SALT -u ZBTERM_REGISTRY_SEED HOME="$H" "$@"; }
keyline() { grep -o 'ZBTerm relay access key: [0-9a-f]\{64\}' | tail -n1 | awk '{print $NF}'; }
# A local testnet, kept up in the background; its bootstrap printed first.
tn_log="$ACCEPT_LOG_DIR/testnet.log"
node -e '
  const createTestnet = require(process.argv[1] + "/node_modules/hyperdht/testnet")
  createTestnet(5).then((tn) => {
    console.log("BOOT " + tn.bootstrap.map((b) => b.host + ":" + b.port).join(","))
    setInterval(() => {}, 1000)
  })' "$repo" >"$tn_log" 2>&1 &
tn_pid=$!
cleanup_bg() { for p in "$tn_pid" ${rl_pid:-}; do
  if tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -qE 'hyperdht/testnet|relay/server.js'; then kill "$p" 2>/dev/null || true; fi
done; }
# activate's EXIT handler calls stop_app when one is defined: here it ends this script's own
# background processes (checked by command line), also on a failed assert.
stop_app() { cleanup_bg; }
boot_ready() { grep -q '^BOOT ' "$tn_log"; }
for _ in $(seq 1 40); do boot_ready && break; sleep 0.5; done
boot="$(grep '^BOOT ' "$tn_log" | awk '{print $2}')"; test -n "$boot"
export ZBTERM_RELAY_BOOTSTRAP="$boot" ZBTERM_RELAY_PORT=0
start_relay() { # log → starts the relay in the background, waits for its key line
  # Not through the relay() function: a backgrounded function is a subshell, not the relay's PID.
  env -u ZBTERM_RELAY_SEED -u ZBTERM_RELAY_ACCESS_SALT -u ZBTERM_REGISTRY_SEED HOME="$H" \
    node "$repo/relay/server.js" >"$1" 2>&1 &
  rl_pid=$!
  for _ in $(seq 1 60); do grep -q 'ZBTerm relay access key:' "$1" && return 0; sleep 0.5; done
  cat "$1"; return 1
}
stop_relay() {
  if tr '\0' ' ' <"/proc/$rl_pid/cmdline" 2>/dev/null | grep -qF relay/server.js; then kill "$rl_pid"; fi
  timeout 15 tail --pid="$rl_pid" -f /dev/null 2>/dev/null || true
}
can_reach() { # key → exit 0 when a testnet client connects to it within 10 s
  timeout 20 node -e '
    const DHT = require(process.argv[1] + "/node_modules/hyperdht")
    const boot = process.argv[3].split(",").map((s) => { const [host, port] = s.split(":"); return { host, port: Number(port) } })
    const dht = new DHT({ bootstrap: boot })
    const s = dht.connect(Buffer.from(process.argv[2], "hex"))
    const done = (c) => { dht.destroy().finally(() => process.exit(c)) }
    s.on("open", () => done(0)); s.on("error", () => done(1)); setTimeout(() => done(1), 10000)
  ' "$repo" "$1" "$boot"
}
# R12, R13, R16: first start makes both files.
L1="$ACCEPT_LOG_DIR/r1.log"; start_relay "$L1"
grep -F 'Created a new relay secret' "$L1"; grep -F 'Created a new access salt' "$L1"
k1="$(keyline <"$L1")"; test ${#k1} = 64
test "$(stat -c %a "$H/.zbterm")" = 700
test "$(stat -c %a "$H/.zbterm/relay-secret")" = 600
test "$(stat -c %a "$H/.zbterm/relay-access")" = 600
can_reach "$k1"
# R17: rotate while running; the relay follows.
secret_before="$(cat "$H/.zbterm/relay-secret")"
R="$(relay node "$repo/relay/server.js" --rotate-access-key 2>&1)"; echo "$R"
k2="$(keyline <<<"$R")"; test ${#k2} = 64; [ "$k2" != "$k1" ]
test "$(cat "$H/.zbterm/relay-secret")" = "$secret_before"
for _ in $(seq 1 30); do grep -q '\[rotate\]' "$L1" && break; sleep 0.5; done
grep -F '[rotate]' "$L1"
test "$(keyline <"$L1")" = "$k2"
can_reach "$k2"
! can_reach "$k1" || exit 1
stop_relay
# R15 + R16: the same files give the same key, no "Created".
L2="$ACCEPT_LOG_DIR/r2.log"; start_relay "$L2"
test "$(keyline <"$L2")" = "$k2"
! grep -F 'Created' "$L2" || exit 1
stop_relay
# R20: --print-key and --check write nothing.
sum0="$(cat "$H/.zbterm/"* | sha256sum)"
test "$(relay node "$repo/relay/server.js" --print-key | keyline)" = "$k2"
relay node "$repo/relay/server.js" --check | grep -F 'OK'
test "$(cat "$H/.zbterm/"* | sha256sum)" = "$sum0"
# R14: a different ZBTERM_RELAY_SEED is used for the run, the file kept, a note.
other="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
N="$(HOME="$H" ZBTERM_RELAY_SEED="$other" node "$repo/relay/server.js" --print-key 2>&1 || true)"
L3="$ACCEPT_LOG_DIR/r3.log"
HOME="$H" ZBTERM_RELAY_SEED="$other" node "$repo/relay/server.js" >"$L3" 2>&1 & rl_pid=$!
for _ in $(seq 1 60); do grep -q 'ZBTerm relay access key:' "$L3" && break; sleep 0.5; done
grep -F '[note] ZBTERM_RELAY_SEED differs' "$L3"
[ "$(keyline <"$L3")" != "$k2" ]
stop_relay
test "$(cat "$H/.zbterm/relay-secret")" = "$secret_before"
# R15: a bad secret file stops it, named, never overwritten.
cp "$H/.zbterm/relay-secret" "$H/secret.keep"
echo 'not-hex' >"$H/.zbterm/relay-secret"
set +e; B="$(relay timeout 20 node "$repo/relay/server.js" 2>&1)"; rc=$?; set -e
echo "$B"; [ "$rc" != 0 ] && [ "$rc" != 124 ]
grep -F "[error] $H/.zbterm/relay-secret" <<<"$B"
test "$(cat "$H/.zbterm/relay-secret")" = 'not-hex'
set +e; relay node "$repo/relay/server.js" --check; rc=$?; set -e; [ "$rc" != 0 ]
cp "$H/secret.keep" "$H/.zbterm/relay-secret"
# U5: a read-only HOME still runs, says the key was not saved.
RO="$UBITRON_TEST_STATE_DIR/ro"; mkdir -p "$RO"; chmod 555 "$RO"
L4="$ACCEPT_LOG_DIR/r4.log"
HOME="$RO" node "$repo/relay/server.js" >"$L4" 2>&1 & rl_pid=$!
for _ in $(seq 1 60); do grep -q 'ZBTerm relay access key:' "$L4" && break; sleep 0.5; done
grep -F '[error] Could not save' "$L4"
keyline <"$L4" | grep -E '^[0-9a-f]{64}$'
stop_relay
chmod 755 "$RO"
cleanup_bg
