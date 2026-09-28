#!/usr/bin/env bash
# Probe P-5: build the signalling contract, run `fdev verify-merge`, then build again after
# `cargo clean` and once more from a copy at a different path, and compare contract keys.
# Run: bash spikes/freenet/p5.sh    (needs `rustup target add wasm32-unknown-unknown`)
set -euo pipefail
export PATH=$HOME/.local/bin:$HOME/.cargo/bin:$PATH
here=$(cd "$(dirname "$0")" && pwd)
c=$here/contracts/signalling
ident() { # <dir>
  local w=$1/target/wasm32-unknown-unknown/release/zbterm_signalling.wasm
  echo "wasm_bytes=$(stat -c %s "$w") wasm_sha256=$(sha256sum "$w" | cut -c1-16) key=$(cd "$1" && fdev get-contract-id --code build/freenet/zbterm_signalling --parameters params.json 2>&1 | tail -1)"
}
cd "$c"
fdev build >/dev/null 2>&1; echo "build A (incremental):   $(ident "$c")"
cargo clean >/dev/null 2>&1; fdev build >/dev/null 2>&1; echo "build B (after clean):   $(ident "$c")"
other=$(mktemp -d)/elsewhere/sig; mkdir -p "$other"
cp -r Cargo.toml Cargo.lock freenet.toml params.json src "$other"/
(cd "$other" && fdev build >/dev/null 2>&1); echo "build C (different path): $(ident "$other")"
rm -rf "$(dirname "$(dirname "$other")")"
echo "rustc: $(rustc --version); fdev: $(fdev --version)"
args=(); for f in states/s*.json; do args+=(--state "$f"); done
fdev verify-merge --wasm target/wasm32-unknown-unknown/release/zbterm_signalling.wasm --params params.json "${args[@]}" 2>&1 | grep -E "^merge check|violation|^\s+\[|^Error" || true
