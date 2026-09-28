# Freenet probes P-1 … P-6 (phase B8, part one)

Measured 2026-09-18 on the development host. Code: [`spikes/freenet/`](../../../spikes/freenet/).
Captured output of every run: `spikes/freenet/out/`. Nothing here touches `engine/`.

Every number below was printed by the command next to it. Where a probe failed, the failure is
quoted and what was tried is listed. Nothing is estimated.

## Setup, and one deviation from the brief

| Fact | Value |
|---|---|
| Node / Bare | Node v24.18.0; standalone `bare` v1.30.3 (`/usr/local/bin/bare`); pear-runtime 1.1.4 embeds **Bare v1.27.0** |
| Freenet | `freenet` 0.2.135, `fdev` 0.3.297, crate `freenet-stdlib` 0.10.0, npm `@freenetorg/freenet-stdlib` 0.4.0 |
| Rust | rustc / cargo 1.95.0. `rustup target add wasm32-unknown-unknown` **was run by this phase** (it was absent, per B0) |
| WebRTC | `node-datachannel` 0.33.4 (libdatachannel 0.24.5), `werift` 0.24.4, `@roamhq/wrtc` 0.10.0 |
| Hypercore | `hypercore` 11.33.5, `@hyperswarm/secret-stream` 6.9.1, `streamx` 2.28.1 (pinned to the root versions) |

**The node on `127.0.0.1:7509` is `freenet network`, not `freenet local`** (`ps`: `/home/zeev/.local/bin/freenet network`,
pid 2224). A `Put` on a network-mode node publishes the contract to the public network, and the
latency probes need a node whose timing is not the public network's. So:

- The node on 7509 was used **read-only** (WebSocket open + `Get` of a key that does not exist). It was
  never stopped, restarted or reconfigured.
- Every `Put`/`Update`/`Subscribe` ran against a **separate** node started by this phase:
  `freenet local --ws-api-port 7519 --config-dir/--data-dir/--log-dir spikes/freenet/.node-data/… --disable-auto-update`
  (pid 103740). It was stopped at the end with `kill 103740`, and only that pid. `.node-data/` is git-ignored.

To re-run anything below, start that node again first:

```
S=$PWD/spikes/freenet; freenet local --ws-api-port 7519 --config-dir $S/.node-data/config --data-dir $S/.node-data/data --log-dir $S/.node-data/log --disable-auto-update
cd spikes/freenet && npm install && bash p5.sh      # p5.sh builds the WASM the other probes load
```

## Results

| Probe | Verdict | Key numbers or quoted failure |
|---|---|---|
| P-2 | **pass** | Node: WS open 38.2 ms, `Put` 104.3 ms, `Get` p50 0.30 / p95 0.63 ms, `Subscribe` 0.63 ms, update→notification p50 36.1 / p95 42.3 ms (n = 20) |
| P-1 | **pass**, with four shims | Standalone Bare 1.30.3 and pear-runtime's Bare 1.27.0 both round-trip `Put`/`Get`/`Subscribe`/`Update`: update→notification p50 38 / p95 42 ms on 1.30.3, p50 37 / p95 44 ms on 1.27.0 (n = 20 each) |
| P-5 | **pass** | `fdev verify-merge`: 117 cases, 117 held, 0 violations. Key identical across an incremental build, a build after `cargo clean`, and a build from a copy at another path |
| P-4 | **pass** (local node) | put→notification p50 / p95: 78.7 / 87.5 ms at 1 Hz, 45.1 / 87.2 ms at 5 Hz, 39.3 / 44.8 ms at 20 Hz; 200 / 200 delivered each. Offer→connected through the contract: 114 ms (node-datachannel), 185 ms (@roamhq/wrtc), 2168 ms (werift) |
| P-3 | Node **pass** ×3; Bare **fail** | Node: all three load, open a loopback channel, expose the remote fingerprint. Bare: no library's JS loads; node-datachannel's native binding does load and opens a channel, but **every binary frame arrives as zero bytes** |
| P-6 | **pass** under Node (node-datachannel, @roamhq/wrtc); werift marginal | 16 MiB log: 12.87 MiB/s (node-datachannel, 64 KiB messages), 11.59 MiB/s (@roamhq/wrtc), 1.01 MiB/s (werift, polling back-pressure). Not run under Bare (blocked by P-3) |

### Re-planning signals

| Signal (plan.md) | Fired? | Evidence |
|---|---|---|
| P-1 or P-3 fails under Bare → B9 designs the host-process adapter over `BACKEND_*` frames | **Fired, for P-3 only.** | The SDK half (P-1) runs in the worker. The WebRTC half does not: binary data-channel frames are zeroed under Bare (both 1.30.3 and 1.27.0). The brief's "a day of shimming" was not spent; about an hour was. What remains untried is listed under P-3. |
| P-4 exceeds 10 s → host pre-publishes its offer at `createLink` | Not fired. | Worst case 2.2 s (werift), on a **local-mode** node. Network-mode propagation between two real nodes was not measured; see the caveat under P-4. |
| P-5 keys unstable → pointer record mandatory, invite carries `ptr` | Not fired for rebuilds. | Same bytes, same key, three builds. But any source edit changes the key (measured: `5R9p6w…` → `DaKqHz…` after the canonical-form fix described under P-5), so a pointer record is still what makes a contract **upgrade** survivable. Cross-toolchain and cross-host reproducibility were not measured. |
| P-6 stalls → B9 designs contract-based history first | Not fired for node-datachannel. | No stall with messages ≤ the 262 144-byte cap. Two stalls were reproduced and explained (message above the cap; `bufferedamountlow` never firing on werift and @roamhq/wrtc); see P-6. |

---

## P-2 — the TypeScript SDK under Node

Run: `node spikes/freenet/p2-node.js 7519` · read-only half: `node spikes/freenet/p2-network-get.js 7509`

Output (`out/p2-node.txt`, abridged to the measured fields):

```
"runtime": "node v24.18.0", "port": 7519, "wasmBytes": 181292,
"wsOpenMs": [38.19, 2.22], "putMs": 104.31, "getStateBytes": 8,
"getMs":                  { "n": 20, "min": 0.19,  "p50": 0.3,   "p95": 0.63,  "max": 1.06 },
"subscribeMs": 0.63,
"updateAckMs":            { "n": 20, "min": 42.55, "p50": 42.93, "p95": 43.13, "max": 43.89 },
"updateToNotificationMs": { "n": 20, "min": 33.02, "p50": 36.14, "p95": 42.33, "max": 44.93 },
"finalEntries": 20
```

Against the user's network-mode node (`out/p2-network-get.txt`):

```
{ "port": 7509, "wsOpenMs": 37.37, "getMissing": "rejected: Contract not found", "getMissingMs": 4734 }
```

The WebSocket endpoint on 7509 works (B0 had not exercised it). A `Get` for a missing key costs 4.7 s
there, because the node searches the network before answering.

Findings that B9 must design around (all reproduced, all in SDK 0.4.0 against node 0.2.135):

1. **`subscribe()` never resolves.** The node encodes a `SubscribeResponse` as a `PutResponse`
   (`freenet-stdlib-0.10.0/src/client_api/client_events.rs:1454`: "SubscribeResponse FBS type not yet in
   generated code, serialize as PutResponse"). The SDK therefore fires `onContractPut` and its `subscribe()`
   promise sits until the 30 s `Request timeout`. The subscription itself **is** active. Workaround in
   `lib/fnet.js::connect().subscribe`: treat the `PutResponse` for that key as the ack.
2. **A second `Put` of an existing instance never resolves either.** The node answers it with an
   `UpdateResponse`, so `put()` waits 30 s and rejects. Every probe run therefore uses a fresh instance
   (a nonce in the parameters).
3. **On a local-mode node a `Get` for a missing key is never answered**: `rejected: Request timeout` after
   30 002 ms on 7519, where the network-mode node answers `Contract not found` in 4.7 s.
4. The node recomputes the contract key from `code + parameters`; the client must compute the same key to
   correlate the response. `instance = blake3(blake3(wasm) ‖ params)`. `lib/fnet.js::contractKey` matches
   `fdev get-contract-id` (checked: `DaKqHzqbPPZiecdNXF26rjnV9msvPghf2Cc9jEn6KbDw` both ways). The code
   hashed is the **raw** `.wasm`, not the versioned package `fdev build` writes to `build/freenet/`.
5. `updateAckMs` is a flat 42–44 ms whatever the load, which looks like a fixed batching interval in the
   node rather than work. Not investigated.

## P-1 — the same, under Bare

Run: `bare spikes/freenet/p1-bare.js 7519` · production-shaped: `node spikes/freenet/pear-run.js spikes/freenet/p1-bare.js 7519`
(`pear-run.js` starts the script with `PearRuntime.run`, as `electron/main.js` starts the core worker.)

Output (`out/p1-bare.txt`, `out/p1-pear-runtime.txt`; Bare has no `performance`, so resolution is 1 ms):

```
"runtime": "bare v1.30.3", "wsOpenMs": [15, 2], "putMs": 68,
"getMs": { "n": 20, "min": 0, "p50": 0, "p95": 1, "max": 2 }, "subscribeMs": 1,
"updateAckMs":            { "n": 20, "min": 42, "p50": 43, "p95": 43, "max": 44 },
"updateToNotificationMs": { "n": 20, "min": 33, "p50": 38, "p95": 42, "max": 44 }, "finalEntries": 20

"runtime": "bare v1.27.0", "wsOpenMs": [13, 1], "putMs": 57,
"getMs": { "n": 20, "min": 0, "p50": 0, "p95": 1, "max": 1 }, "subscribeMs": 1,
"updateAckMs":            { "n": 20, "min": 42, "p50": 43, "p95": 44, "max": 44 },
"updateToNotificationMs": { "n": 20, "min": 33, "p50": 37, "p95": 44, "max": 45 }, "finalEntries": 20
worker exit code 0
```

The SDK itself `require`s cleanly under Bare with no shim (`flatbuffers` and `bs58` are pure JS). What had
to be shimmed to *use* it (`spikes/freenet/lib/bare-shims.js`, 48 lines):

| Missing under Bare | Shim |
|---|---|
| `globalThis.WebSocket` (and the SDK's fallback `require('ws')` needs Node's `http`) | A browser-shaped class over `bare-ws`: `binaryType`, `onmessage`, `addEventListener('open'/'close')`, `send`. `bare-ws`'s `Socket` is a Duplex, not an EventTarget, and its own `bare-ws/global` export does not satisfy the SDK. |
| `TextEncoder` / `TextDecoder` | `bare-encoding` |
| `process` | `bare-process` (same line as `engine/worker.js`) |
| `performance` | none; `Date.now()` fallback |

Two further Bare findings:

- `@noble/hashes` does not load under Bare: `MODULE_NOT_FOUND: Cannot find module 'node:crypto' imported
  from '…/@noble/hashes/cryptoNode.js'`. The key derivation needs BLAKE3, so `lib/blake3.js` is a
  dependency-free implementation, cross-checked against `@noble/hashes` on 16 input sizes from 0 to 1 000 003
  bytes (`node spikes/freenet/lib/blake3-check.js`, all `ok`).
- pear-runtime's Bare is **1.27.0**. Today's `bare-fs` (4.8.1) refuses it: `UNSUPPORTED_ENGINE: Package not
  compatible with engine 'bare' 1.27.0, requires range '>=1.28.0'`. The spike pins `bare-fs` 4.7.1, the root's
  version. A Freenet adapter in the worker inherits that ceiling on every `bare-*` dependency.

## P-5 — the signalling contract

Run: `bash spikes/freenet/p5.sh` · source: `spikes/freenet/contracts/signalling/src/lib.rs` (210 lines)

Output (`out/p5.txt`):

```
build A (incremental):   wasm_bytes=181292 wasm_sha256=fe485e1240ab085f key=DaKqHzqbPPZiecdNXF26rjnV9msvPghf2Cc9jEn6KbDw
build B (after clean):   wasm_bytes=181292 wasm_sha256=fe485e1240ab085f key=DaKqHzqbPPZiecdNXF26rjnV9msvPghf2Cc9jEn6KbDw
build C (different path): wasm_bytes=181292 wasm_sha256=fe485e1240ab085f key=DaKqHzqbPPZiecdNXF26rjnV9msvPghf2Cc9jEn6KbDw
rustc: rustc 1.95.0 (59807616e 2026-04-14); fdev: Freenet Development Tool 0.3.297
merge check: 6 state(s), 0 delta(s), 0 summary/summaries in the corpus
merge check: 117 case(s) run — 117 held, 0 violation(s) (0 enforceable, 0 diagnostic-only), 0 inconclusive
no enforceable violations found.
```

Design, as built: a map keyed by `(linkId, role, seq)`; per key the later `t` wins, then a tombstone
(`d: true`, empty payload), then payload bytes, so the order is total. **The contract never reads a clock.**
The TTL is a contract *parameter* (`ttl_ms`), an entry expires at `t + ttl_ms`, and "now" is the highest `t`
in the merged state. Because expiry is monotone in `t`, the winner of a key always expires last, which is
what keeps purge-after-merge order-independent. A 512-entry cap drops the oldest first.

The first version **failed** `verify-merge`, and the failure is worth keeping (printed in the session;
`out/` holds only the passing run):

```
merge check: 85 case(s) run — 77 held, 8 violation(s) (2 enforceable, 6 diagnostic-only), 0 inconclusive
  [diagnostic] self_delta_empty (5 cases): delta against an exact summary of the same state is 8 bytes, not empty
  [violation] state_idempotence (2 cases): merge(A, A) != A: the state was rewritten 1 time(s) and then stopped changing. …
      a canonicalizing contract lands here because the install path stores raw client bytes without running update_state
```

Cause: `validate_state` accepted states that were not in canonical form (entries already past their TTL
relative to the state's own high-water mark), and a `Put` stores the client's bytes as given. Fix:
`validate_state` accepts only the canonical encoding (sorted, deduplicated, purged), and an empty delta is
zero bytes. The key before that fix was `5R9p6wCS4nUJnofqpSuVhTyG54sgoQbVvTwBEhvkjmv9`; after it,
`DaKqHz…`. **Any WASM change moves the key**, as the plan's gotcha says.

Not measured: reproducibility across rustc versions, across hosts, or with a different `Cargo.lock`. The
crate pins `freenet-stdlib = "=0.10.0"` and commits its lockfile for that reason. `fdev build` needs the
crate's `freenet-main-contract` feature to imply `contract`, or it fails with "the item is gated behind the
`contract` feature"; the `fdev new` template does not set that up.

> **2026-09-24 (`260924_freenet-backend` F5).** "Build C (different path)" moved the crate, not
> `$CARGO_HOME`: the WASM embeds the absolute source paths of its dependencies under
> `$CARGO_HOME/registry/src/`, so the key above also depended on the builder's home directory. With the
> same rustc 1.95.0 a second host (`hetzner-deb16`, `CARGO_HOME` under `~/work/zbterm/rust/cargo`)
> built different bytes until `scripts/build-contracts.sh` passed `--remap-path-prefix=$CARGO_HOME=/cargo`;
> then both hosts built identical bytes. Details in `freenet-backend-design.md` §5.2's F5 blockquote.

## P-4 — signalling latency

Run: `node spikes/freenet/p4.js 7519 1,5,20 200` (about five minutes)

Output (`out/p4.txt`, contract ids dropped):

```
{"hz":1, "sent":200,"notified":200,"lost":0,"updateErrors":0,"wallS":199.3,"notificationVariants":{"DeltaUpdate":200},"avgNotificationBytes":10817,"putToNotificationMs":{"n":200,"min":32.99,"p50":78.69,"p95":87.47,"max":92.42}}
{"hz":5, "sent":200,"notified":200,"lost":0,"updateErrors":0,"wallS":39.9, "notificationVariants":{"DeltaUpdate":200},"avgNotificationBytes":12886,"putToNotificationMs":{"n":200,"min":33.02,"p50":45.11,"p95":87.16,"max":92.77}}
{"hz":20,"sent":200,"notified":200,"lost":0,"updateErrors":0,"wallS":10,   "notificationVariants":{"DeltaUpdate":200},"avgNotificationBytes":12886,"putToNotificationMs":{"n":200,"min":33.25,"p50":39.29,"p95":44.79,"max":50.66}}
{"lib":"node-datachannel","signallingMessages":14,"offerToConnectedMs":114, "perHopMs":{"n":3, "min":29.41,"p50":46.53,"p95":69.65, "max":69.65}}
{"lib":"werift",          "signallingMessages":22,"offerToConnectedMs":2168,"perHopMs":{"n":22,"min":34.44,"p50":44.77,"p95":53.91, "max":58.77}}
{"lib":"@roamhq/wrtc",    "signallingMessages":47,"offerToConnectedMs":185, "perHopMs":{"n":3, "min":44.01,"p50":53.39,"p95":106.93,"max":106.93}}
```

Method. Publisher and subscriber are two WebSocket clients of one node. Latency is from the `update()`
call to the subscriber's `onContractUpdateNotification`, matched by `seq`. "Offer→connected" opens two
in-process peers whose every SDP and ICE message is written as a contract entry by one client and delivered
to the other peer **only** from that peer's subscription notification; `perHopMs` is that hop. `n` is the
number of hops delivered before the channel opened; later trickled candidates are counted in
`signallingMessages` only.

Findings:

- Latency is *lower* at higher rates (p50 78.7 → 39.3 ms). Not explained; it points at a timer in the node
  rather than at load.
- **Notifications are not incremental.** Every notification is a `DeltaUpdate` that carries the *whole*
  live state (10.8–12.9 kB average here, for 64-byte payloads), because the node computes the delta against
  the summary the subscriber sent at subscribe time (empty) and never advances it. Cost grows with the
  number of live entries, so the TTL and the entry cap bound bandwidth as well as storage.
- The SDK correlates `update()` responses by contract key, so the probe serialises one writer's updates.

**Caveat, stated plainly.** These are two clients on one **local-mode** node: no network hop is in the path. The
number that decides the 10 s signal in production is host-node → network → viewer-node, and that was not
measured, because it needs a `Put` on the user's network-mode node (not done, see Setup) and a second
network node. The one network-mode datum taken is the 4.7 s `Get` miss on 7509.

## P-3 — WebRTC libraries

Run: `node spikes/freenet/p3-node.js` · `bare spikes/freenet/p3-bare.js` · `bare spikes/freenet/p3-bare-ndc.js`
· `node spikes/freenet/pear-run.js spikes/freenet/p3-bare-ndc.js`

Node (`out/p3-node.txt`; fingerprints shortened):

| Library | Loads | Load ms | Loopback channel open ms | Echo | Remote DTLS fingerprint, via | API value = SDP value | Max message |
|---|---|---|---|---|---|---|---|
| node-datachannel 0.33.4 | yes | 10 | 5 | ok | `pc.remoteFingerprint()` | yes | 262 144 |
| werift 0.24.4 | yes | 229 | 263 | ok | `pc.dtlsTransports[0].remoteParameters.fingerprints` | yes | 65 536 |
| @roamhq/wrtc 0.10.0 | yes | 9 | 13 | ok | `pc.sctp.transport.getRemoteCertificates()` → SHA-256 of the DER | yes | 262 144 |

All three also expose it in `remoteDescription.sdp` (`a=fingerprint:`). Only @roamhq/wrtc's path hashes the
certificate the peer actually presented; node-datachannel's and werift's accessors were not checked to be
handshake-derived rather than SDP-derived. For R-12's "DTLS fingerprints signed by the transport key inside
the SDP" the SDP value is the one that gets signed. That each library rejects a handshake whose certificate does
not match the SDP fingerprint is their documented behaviour and was **not tested** here.

Bare, as published (`out/p3-bare.txt`) — all three fail at `require`:

```
{"lib":"node-datachannel","loaded":false,"failure":"MODULE_NOT_FOUND: Cannot find module 'fs' imported from '…/node-datachannel/dist/cjs/lib/node-datachannel.cjs'"}
{"lib":"werift","loaded":false,"failure":"MODULE_NOT_FOUND: Cannot find module 'crypto' imported from '…/werift/lib/common/src/binary.js'"}
{"lib":"@roamhq/wrtc","loaded":false,"failure":"MODULE_NOT_FOUND: Cannot find module 'util' imported from '…/@roamhq/wrtc/lib/index.js'"}
```

Bare, shimmed. Both **Node-API binaries load under Bare when required by path** (`node_datachannel.node`:
22 exports; `wrtc.node`: 20 exports). Driving node-datachannel's raw binding
(`out/p3-bare-ndc.txt`, `out/p3-pear-runtime-ndc.txt`):

```
{"lib":"node-datachannel (raw binding)","runtime":"bare v1.30.3","channelOpenMs":11,
 "seenAtB":{"textAtB":"text-ping","binaryAtB":{"type":"[object Uint8Array]","length":4,"hex":"00000000"}},
 "binaryAtA":{"type":"[object Uint8Array]","hex":"00000000","expectedHex":"706f6e67"},
 "remoteFingerprintViaApi":"sha-256 …","apiMatchesSdp":true}
{"lib":"node-datachannel (raw binding)","runtime":"bare v1.27.0","channelOpenMs":8, … same zeros … }
```

So under Bare the channel opens (8–11 ms), the fingerprint is readable and matches, and **text frames
arrive intact, but every binary frame arrives with the right length and all-zero bytes**. Tried: `Buffer`,
a fresh `Uint8Array`, and a `Uint8Array` view at a non-zero offset as the send argument, all zeros on
arrival; the same script under Node delivers `01020304`, `07070707`, `09090909`. Whether the send or the
receive marshalling is at fault was not separated (it needs a Bare peer and a Node peer in two processes).

Not tried, and what a full day would go to: base64 over text frames (works in principle, +33 % bytes,
throughput unmeasured); a Bare import map for werift's 12 Node builtins (`crypto` ×34, `dgram`, `net`,
`timers/promises`, `stream/web`, `fs/promises`, `worker_threads`, `perf_hooks`, `tls`, `dns`, `os`, `path`);
@roamhq/wrtc's raw binding beyond loading it. **Verdict: P-3 fails under Bare as things stand**; the
WebRTC half belongs in the host process (the `engine/pty-remote.js::PtyRemote` pattern), and node-datachannel
is the library to carry there.

## P-6 — Hypercore replication over a data channel

Run: `node spikes/freenet/p6.js <lib> <chunkBytes> <MiB> [blockBytes]`, e.g. `node spikes/freenet/p6.js node-datachannel 65536 16`.
`P6_POLL=1` polls `bufferedAmount` instead of waiting for the drain event.

The brief's call shape is wrong for hypercore 11.33.5: `core.replicate(isInitiator, rawDuplex)` fails
(`createProtocolStream` requires `stream.noiseStream`; with a bare streamx `Duplex` no byte was ever written:
`"writerSide":{"messages":0,"frames":0}` after 3 s). What works is what Hyperswarm does:
`core.replicate(new NoiseSecretStream(isInitiator, rawDuplex))`. The duplex writes one frame per stream
write (u32-LE length, then the bytes) cut into messages of at most `chunkBytes`, and pauses the writer
while `bufferedAmount` > 1 MiB.

16 MiB log of 1 024 × 16 KiB blocks, loopback, in-process (`out/p6.txt`):

| Library | Message size | Complete | Transfer ms | MiB/s | First block ms | Longest gap between blocks ms | Back-pressure pauses |
|---|---|---|---|---|---|---|---|
| node-datachannel | 16 384 | yes | 4 392 | 3.64 | 278 | 275 | 0 |
| node-datachannel | 65 536 | yes | 1 243 | **12.87** | 153 | 51 | 0 |
| node-datachannel | 262 144 | yes | 2 320 | 6.90 | 165 | 398 | 0 |
| node-datachannel | 1 048 576 | yes | 1 665 | 9.61 | 322 | 232 | 0 |
| @roamhq/wrtc | 16 384 | yes | 3 212 | 4.98 | 535 | 527 | 0 |
| @roamhq/wrtc | 65 536 | yes | 1 380 | 11.59 | 69 | 39 | 0 |
| werift | 16 384 | **no**: 0 / 1 024 contiguous after 120 s (63 download events) | 120 179 | 0 | 132 | 143 | 1 |
| werift, `P6_POLL=1` | 16 384 | yes | 15 801 | 1.01 | 347 | 952 | 5 |

Single runs; the spread between the node-datachannel rows is run-to-run noise as much as message size
(with 16 KiB blocks no frame exceeds 16 812 bytes, so the three larger sizes send identical messages). An
earlier 16 384-byte node-datachannel run measured 6.6 MiB/s (printed in the session, not kept in `out/`).

The SCTP message cap, tested with 32 × 512 KiB blocks so that frames really exceed it (`out/p6-cap.txt`):

| Library | Message size | Result |
|---|---|---|
| node-datachannel | 1 048 576 (> cap 262 144) | **fails**: `libdatachannel error while sending data channel message: Message size exceeds limit`; 0 / 32 blocks |
| node-datachannel | 65 536 | complete, 437 ms, **36.64 MiB/s**, largest frame 2 622 493 bytes, 10 pauses |
| @roamhq/wrtc | 1 048 576 | **fails**: `RTCDataChannel.readyState is not 'open'` (the oversized send closes the channel); 0 / 32 |
| @roamhq/wrtc | 65 536 | **stalls** at 2 / 32 blocks after the first pause: `onbufferedamountlow` never fired |
| @roamhq/wrtc, `P6_POLL=1` | 65 536 | complete, 486 ms, 32.9 MiB/s, 12 pauses |

Conclusions: replication runs over a data channel at well above the 1 MiB/s bar; an adapter must cut frames
to ≤ 65 536 bytes (werift's cap, and safe for the other two); and it must not trust `bufferedamountlow` on
werift or @roamhq/wrtc (node-datachannel's `onBufferedAmountLow` fired every time). All of this is Node only.

## What the results select (R-13, last paragraph)

Measured inputs for B9, not a decision: the Freenet **SDK** half runs in the Bare worker today with four small
shims. The **WebRTC** half does not run under Bare. The topology these numbers support is a split one, with
the contract client in the worker and the data channel in the host process behind `BACKEND_*` frames, or
both in the host process. A Rust sidecar is not called for by anything measured here.

## Files

```
spikes/freenet/package.json, package-lock.json, .gitignore
spikes/freenet/lib/{fnet,blake3,blake3-check,bare-shims,rtc}.js
spikes/freenet/{p12-core,p1-bare,p2-node,p2-network-get,p3-node,p3-bare,p3-bare-ndc,p4,p6,pear-run}.js, p5.sh
spikes/freenet/contracts/signalling/{Cargo.toml,Cargo.lock,freenet.toml,params.json,src/lib.rs,states/s0..s5.json}
spikes/freenet/out/*.txt        captured output
```
