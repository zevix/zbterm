# F2 — real-network measurements (design F0)

Measured 2026-09-24, 14:04–14:12 UTC, by `spikes/freenet/p7-network.js` (roles `host` and
`viewer`). Two **network-mode** nodes on two hosts, both WebSocket clients only. Every number here is
reported, not gated. Raw JSON lines: [`measurements/`](measurements/), one file per run (both
roles' lines, the run's nonce, placement and ICE list).

## Setup

| | this machine | `hetzner-deb16` |
|---|---|---|
| network position | behind NAT (LAN address `10.9.8.216`; also Tailscale, Docker and libvirt interfaces) | public IPv4 address, no NAT; `nft` input policy accept |
| Freenet node | the owner's `freenet network`, pid 1938466, WS `127.0.0.1:7509` | the F1 unit `freenet-node.service` (`freenet network … --network-port 31337 --disable-auto-update`), WS `127.0.0.1:7509`, active since 13:54:51 UTC |
| node version | `Freenet version: 0.2.136 (7fa2c6605b99)` | `Freenet version: 0.2.136 (7fa2c6605b99)` |
| Node.js | v24.18.0 | v24.21.0 (`~/work/zbterm/node/bin`) |
| WebRTC | node-datachannel 0.33.4 (`spikes/freenet/node_modules`) | node-datachannel 0.33.4 (the synced spike, `npm ci` by `SyncProbes`) |

- **Contract.** The probe signalling contract, raw WASM 181 292 bytes (this machine reads
  `contracts/signalling/target/…/zbterm_signalling.wasm`; the remote reads fdev's package
  `build/freenet/zbterm_signalling` minus its 40-byte header and checks the embedded BLAKE3 code
  hash). Params `{"ttl_ms":120000,"n":"f2-<16 random base64url chars>"}`: a fresh nonce per run,
  none reused (nine runs, nine nonces, listed in each raw file). Unsigned entries; nothing names the
  owner.
- **Directions.** A: host on `hetzner-deb16`, viewer here (the product's common case: a host
  anywhere, a viewer behind NAT). B: host here, viewer on `hetzner-deb16`.
- **ICE.** "default" is the `D-11` / `Q-4` list `stun:stun.l.google.com:19302`,
  `stun:stun.cloudflare.com:3478` on both ends; "host only" is `--ice ''` on both ends (no server).
- **Statistics.** Nearest-rank percentiles (`spikes/freenet/lib/fnet.js::stats`); with n = 3 the p95
  is the maximum. "Pooled" means every sample of the direction's runs in one set.
- **Clocks.** Every latency is measured on one machine. The cross-host "host put done → viewer
  readable" wall-clock difference is in the raw files (`putDoneEpochMs`, `readableEpochMs`) but is
  not used: it came out +9.3…+14.4 s in A and −3.3…−5.6 s in B, i.e. dominated by clock offset.

## 1. How long until a fresh instance is readable from the other node

The viewer starts after the orchestrator has seen the host's `{instance, putMs}` line (a 1 s poll,
then an `ssh` or local `node` start), then polls `Get` (full key, `fetchContract: true`) with a 1 s
gap after a miss and a 120 s cap. `firstGetMs` runs from the first `Get` sent to the first `Get`
answered with state.

| direction | run | host `putMs` | `firstGetMs` | misses |
|---|---|---|---|---|
| A | A-default-1 | 982.9 | 5 794.8 | 0 |
| A | A-default-2 | 2 014.3 | 779.6 | 0 |
| A | A-default-3 | 6 710.7 | 5 172.2 | 0 |
| B | B-default-1 | 1 686.1 | 1 853.8 | 0 |
| B | B-default-2 | 1 324.8 | 371.7 | 0 |
| B | B-default-3 | 1 201.6 | 359.6 | 0 |
| A (STUN step) | A-default-4 | 1 973.8 | 3 544.9 | 0 |
| A (STUN step) | A-hostonly-1 | 617.6 | 408.8 | 0 |
| A (STUN step) | A-hostonly-2 | 1 216.1 | 9 453.8 | 0 |

| direction | n | p50 ms | p95 ms | misses |
|---|---|---|---|---|
| A (runs 1–3) | 3 | 5 172.2 | 5 794.8 | 0 of 3 |
| B (runs 1–3) | 3 | 371.7 | 1 853.8 | 0 of 3 |
| all nine runs | 9 | 1 853.8 | 9 453.8 | 0 of 9 |

Every first `Get` returned the instance (8-byte state `{"e":[]}`): **no `Contract not found` miss
in nine runs**, so the 120 s poll cap was never approached. The time is the one `Get` itself, which
fetched the 181 kB contract code across the network. What was not isolated: propagation faster than
the orchestration gap between the host's put answer and the viewer's first `Get` (a 1 s poll plus an
`ssh` or `node` start; not measured, clocks differ); the instance was already readable when the
first `Get` arrived in every run.

## 2. Put → notification across the network

The viewer writes one entry per round (`l: 'lat<Hz>'`), 30 rounds at 1 Hz and then 30 at 5 Hz; the
host, on its subscription, answers every new viewer entry with an ack entry (one update per
notification). Measured on the viewer's clock: viewer `Update` sent → the viewer's notification
carrying the host's ack. That is a **round trip through both nodes** (viewer node → host node →
host client → host node → viewer node), not a one-way time. "Own echo" is viewer `Update` sent →
the viewer's own notification of that entry (its local node only).

| direction | rate | n (pooled) | p50 ms | p95 ms | max ms | per-run p50 | per-run p95 | lost | own echo p50 / p95 (per run) |
|---|---|---|---|---|---|---|---|---|---|
| A | 1 Hz | 90 | 1 148.3 | 1 525.0 | 2 658.9 | 1 351.3 / 820.5 / 1 146.8 | 1 376.0 / 1 121.9 / 2 620.9 | 0 / 0 / 0 | 78.0 / 90.5, 78.0 / 89.4, 80.4 / 90.8 |
| A | 5 Hz | 90 | 1 405.3 | 3 100.1 | 3 735.8 | 1 529.9 / 933.5 / 1 494.1 | 1 933.9 / 1 382.7 / 3 209.2 | 0 / 0 / 0 | 78.0 / 101.3, 77.6 / 111.5, 78.1 / 121.2 |
| B | 1 Hz | 90 | 724.4 | 815.0 | 3 081.2 | 801.1 / 720.4 / 720.9 | 2 079.7 / 743.2 / 743.5 | 0 / 0 / 0 | 34.5 / 45.0, 34.4 / 45.8, 35.0 / 45.4 |
| B | 5 Hz | 90 | 893.5 | 1 094.2 | 19 056.2 | 911.3 / 912.8 / 803.3 | 1 114.8 / 1 124.1 / 1 000.8 | 0 / 0 / 0 | 34.0 / 45.5, 44.6 / 67.4, 44.3 / 56.0 |

- No entry lost in any run (180 / 180 acks per direction per rate). The one outlier, B-default-1's
  last 5 Hz round, took 19 056 ms; every other B sample is ≤ 3 082 ms.
- Average notification size grew with the state (`S-05`(d), whole state per notification): ≈ 2.0 kB
  over the 1 Hz phase, ≈ 6.0 kB over the 5 Hz phase (both directions).
- `Subscribe` on the viewer's node (the `fnet.js::connect` workaround, ack as a `PutResponse`)
  answered in 179.8–427.0 ms (A, runs 1–3; 2 308.2 ms in A-default-4, 4 337.9 ms in A-hostonly-2)
  and 100.7–135.9 ms (B). No `S-05` workaround failed on network mode; none was re-probed here.
- A viewer behind NAT (A) sees a slower own echo (≈ 78 ms) than the public one (B, ≈ 34 ms), and a
  slower round trip. Why was not separated (node placement in the ring, the owner's node load).

## 3. Offer → connected through the contract

The viewer (offerer) creates a node-datachannel `PeerConnection` with the ICE list and a data
channel; every local description and candidate is one contract entry (`l: 'rtc'`), each sent as its
own `Update` at once; each side applies the other's entries in sequence order. `offerToConnectedMs`
runs from `createDataChannel` to the channel's `open` on the viewer. Trickle ICE, no end-of-candidates.

| direction | ICE | run | offer → connected ms | signalling messages (sent / received by the viewer before open) |
|---|---|---|---|---|
| A | default | A-default-1 | 2 137.1 | 16 (10 / 6) |
| A | default | A-default-2 | 1 385.1 | 16 (10 / 6) |
| A | default | A-default-3 | 1 691.4 | 13 (10 / 3) |
| B | default | B-default-1 | 1 300.9 | 16 (6 / 10) |
| B | default | B-default-2 | 1 181.8 | 16 (6 / 10) |
| B | default | B-default-3 | 1 176.9 | 16 (6 / 10) |
| A | default | A-default-4 | 1 626.1 | 16 (10 / 6) |
| A | host only | A-hostonly-1 | 1 447.6 | 14 (9 / 5) |
| A | host only | A-hostonly-2 | 1 570.4 | 14 (9 / 5) |

| direction | ICE | n | p50 ms | p95 ms |
|---|---|---|---|---|
| A (runs 1–3) | default | 3 | 1 691.4 | 2 137.1 |
| A (runs 1–4) | default | 4 | 1 626.1 | 2 137.1 |
| B (runs 1–3) | default | 3 | 1 181.8 | 1 300.9 |
| A | host only | 2 | 1 447.6 | 1 570.4 |

**offer → connected p95 with the default STUN list: 2 137.1 ms (A), 1 300.9 ms (B)**, far under the
10 s threshold of design §12 F0. Every run connected; no run needed the 30 s cap.

## 4. Which candidate pair carried the connection

From `PeerConnection.getSelectedCandidatePair()` (node-datachannel 0.33.4) on each side after
`open`; addresses are classified, never recorded.

| direction | ICE | viewer local → remote | host local → remote | transport |
|---|---|---|---|---|
| A (4 runs) | default | `srflx` v4-public → `host` v4-public (4 of 4) | `host` v4-public → `srflx` v4-public (3 of 4), `prflx` v4-public (A-default-2) | UDP |
| B (3 runs) | default | `host` v4-public → `prflx` v4-public (3 of 3) | `srflx` v4-public → `host` v4-public (3 of 3) | UDP |
| A (2 runs) | host only | `prflx` v4-public → `host` v4-public (2 of 2) | `host` v4-public → `prflx` v4-public (2 of 2) | UDP |

Gathered candidates. This machine: `host` ×8 (4 v4-private, 1 v4 CGNAT/Tailscale range, 1 v6
Tailscale, 2 v6 ULA) plus 1 `srflx` v4-public with STUN. `hetzner-deb16`: `host` ×4 (1 v4-public,
2 v4-private, 1 v6 ULA) plus 1 `srflx` v4-public with STUN. Every selected pair is IPv4 UDP between
this machine's NAT mapping and the remote's public address; no pair ran over Tailscale, IPv6 or a
relay.

## 5. Round trip over the channel

20 sequential pings (`ping <i>`, echoed by the host, 100 ms apart) after `open`.

| direction | ICE | per-run ping p50 ms | per-run ping p95 ms | pongs | `pc.rtt()` ms |
|---|---|---|---|---|---|
| A | default | 74.4 / 73.3 / 72.8 / 63.0 | 74.9 / 84.6 / 73.3 / 63.7 | 20 / 20 / 20 / 20 | 74 / 74 / 72 / 63 |
| B | default | 63.1 / 64.6 / 62.7 | 63.6 / 64.8 / 63.4 | 20 / 20 / 20 | 63 / 64 / 62 |
| A | host only | 73.2 / 72.9 | 73.9 / 73.3 | 20 / 20 | 73 / 72 |

## 6. STUN: host candidates only, then the default list

| run | ICE | connected | offer → connected ms | selected pair (viewer side) |
|---|---|---|---|---|
| A-hostonly-1 | none | **yes** | 1 447.6 | `prflx` → `host` v4-public |
| A-hostonly-2 | none | **yes** | 1 570.4 | `prflx` → `host` v4-public |
| A-default-4 | default | yes | 1 626.1 | `srflx` → `host` v4-public |

**Host candidates only connects across the internet with this pair**, because one end has a public
address: the NATed viewer's checks reach the host's public `host` candidate, and the host learns the
viewer's mapping as a peer-reflexive candidate. This says nothing about two NATed ends, where host
candidates alone cannot work. The `D-11` default stands.

**NAT↔NAT is not available with this pair: `hetzner-deb16` has a public address.** The optional
network-namespace-behind-masquerade case on the remote was **not measured** (it needs root-owned
`ip netns`/`nft` state on the remote outside the recipe, more than modest effort for this phase).
Two NATed peers remain unmeasured.

## Re-planning signals (plan F2)

| signal | measured | fired |
|---|---|---|
| offer → connected p95 > 10 s | 2 137.1 ms (A), 1 300.9 ms (B) | no |
| `firstGetMs` p95 > 30 s, or misses to the 120 s cap | p95 9 453.8 ms over nine runs, 0 misses | no |
| host candidates only connects across the internet | yes, 2 of 2 (A) | **yes — noted here; `D-11` stands** |
| default-list runs never connect from the NAT side | 7 of 7 default runs connected | no |

## Raw files

`measurements/A-default-1.json` … `A-default-4.json`, `B-default-1.json` … `B-default-3.json`,
`A-hostonly-1.json`, `A-hostonly-2.json`. Each is one JSON object: `run`, `direction`, `host`,
`viewer`, `ice`, `nonce`, `hostLines` and `viewerLines` (every JSON line each role printed, in
order: `host`, `hostDone`; `viewer`, `firstGet`, `subscribe`, `latency` ×2 with every sample,
`rtc`, `exit`) and `stray` (non-JSON output; empty in all nine).

# F8 — live history through the seam (design §8.1, `R-7`)

Measured 2026-09-24 by `scripts/measure-history.js` on this machine (Node v24.18.0, the sidecar's
Bare v1.27.0, node-datachannel 0.33.4, a throwaway local-mode node 0.2.136 the script starts on a
free port — never the owner's). Two `EngineClient`s in one Node process, each with its own Bare
sidecar worker (`test/fixtures/history-measure-worker.js`, spawned through
`engine/spawn-worker.js::spawnWorker`), its own `userData`, a stub `ptyHost` and its own `RtcHost`
(no ICE servers: host candidates, loopback). Worker A holds a 16 MiB store `{ log, metaCore }` and
serves it; worker B dials, `attachHistory`s and `fetch`es `[0, length)`. Every history byte crosses
A's pipe, A's `RtcHost`, a WebRTC data channel, B's `RtcHost` and B's pipe, in data-channel messages
of at most 65 536 bytes. `MiBps` = log bytes / (attachHistory → fetch done); `firstBlockMs` =
attachHistory → first block. **The 1 MiB/s figure is `R-7`'s gate, checked by running the script,
not by `npm test`; every other number here is reported, not gated.**

| run | block | MiB/s | first block | transfer | longest gap | dial → connected |
|---|---|---|---|---|---|---|
| 1 | 16 KiB | **26.02** | 48 ms | 615 ms | 31 ms | 270 ms |
| 2 | 16 KiB | 28.02 | 47 ms | 571 ms | 26 ms | 266 ms |
| 3 | 16 KiB | 26.85 | 48 ms | 596 ms | 31 ms | 236 ms |
| `--block 524288` | 512 KiB | 37.56 | 63 ms | 426 ms | 188 ms | 258 ms |

- **Gate:** the lowest of the three, **26.02 MiB/s**, is ≥ 1 MiB/s. Every run complete (1 024 of
  1 024 blocks, last block index checked, meta core replicated).
- The 512 KiB-block run completes (32 of 32 blocks): each block's frame is cut into ≥ 8 messages at
  the 65 536-byte cap with no stall beyond the 188 ms between two blocks.
- For comparison, design §8.1's in-process P-6 figure was 12.87 MiB/s (16 KiB data-channel
  messages); the seam run is faster, not slower, so the pipe is not the bottleneck at this rate.

**Re-measured after the gate's re-dispatch (`S-26`, `S-27` fixes; same setup, 2026-09-24).**
Three runs: 16 KiB blocks at 24.06 / 23.36 / 25.24 MiB/s, first block 55–59 ms after attachHistory,
dial → connected 312–322 ms. The 512 KiB-block run completed at 31.68 MiB/s. An earlier run right
after `npm test` gave 13.95 MiB/s, with load average 4.25 when the three runs started. The gate still
holds: the lowest of all these runs is 13.95 MiB/s. Dial → connected is about 50 ms slower, because
the dialing side now sends its candidates only after the answer.

# F9 — the default package, the remote pair and the GUI proof (reported, not gated)

All on 2026-09-24. This machine: Node v24.18.0, the owner's network-mode node **freenet 0.2.137**
(10e859e256a6, built 2026-09-24T13:56Z; it auto-updated itself during F8), used as a WebSocket
client only. `hetzner-deb16`: Node v24.21.0, **freenet 0.2.136** (7fa2c6605b99) under its systemd
unit, never restarted or upgraded. So every cross-machine number below is **0.2.137 ↔ 0.2.136**.

## Packages (step 6)

`npx electron-forge package` into `$SCRATCH/f9-{default,pear,none}` (`ZBTERM_FORGE_OUT_DIR`),
linux-x64, each ≈ 15 s. `resources/app` apparent size (`du -sb`), whole package in brackets:

| variant | `resources/app` | package | `@freenetorg` | `node-datachannel` | `@node-datachannel` | contract `.wasm` | `THIRD-PARTY-NOTICES.md` |
|---|---|---|---|---|---|---|---|
| default (`pear,freenet`) | 673 400 942 B | 975 845 609 B | yes | yes | `linux-x64-gnu` | 2 | yes |
| `pear` | 648 416 202 B | 950 860 869 B | no | no | no | 0 | no |
| `none` | 647 467 436 B | 949 912 103 B | no | no | no | 0 | no |

Freenet adds ≈ 25 MB to `resources/app` (≈ 9 MB of it the native `node_datachannel.node`). In the
default package `require('<app>/node_modules/node-datachannel')` resolves
`@node-datachannel/linux-x64-gnu` (a `PeerConnection` opens and closes) and the SDK, `bs58`,
`bare-ws`, `bare-encoding` load. In Electron's main process node-datachannel loads too: the GUI run
below reports `freenet` `available`, which needs the `rtc` host capability, and connects over it.
The prune-prebuilds plugin leaves the platform package alone.

## Remote pair (step 7, `test/tools/freenet-remote-pair.js`)

A `FreenetBackend` + in-process `RtcHost` per side (no SessionEngine), the default ICE list
(`D-11`), each against its own machine's node; the viewer dials, echoes 1 000 JSON messages sent at
once (≈ 100 B each), then attaches a 4 MiB Hypercore log (256 × 16 KiB) as history. The tree reached
the remote by `scripts/infra/freenet_host.py HOST --task repo` (`SyncRepo`). **A** = host on
`hetzner-deb16`, viewer here; **B** = host here, viewer on `hetzner-deb16`. Raw files:
`measurements/F9-remote-pair-*.json`.

| run | dial → connected | subscribe (Get) | offer → answer | echo 1 000 | echo RTT p50 / p95 | history 4 MiB | pair (viewer local → remote) |
|---|---|---|---|---|---|---|---|
| A-1 | never (viewer cap 5 min) | — | — | — | — | — | — |
| A-2 | 8 861 ms | 7 726 ms | 753 ms | 2 580 ms | 1 454 / 2 446 ms | not done in 15 min | `srflx` → `host`, UDP |
| A-3 | 65 099 ms | 62 367 ms | 964 ms | 2 930 ms | 1 523 / 2 727 ms | 124 607 ms, **0.03 MiB/s** | `srflx` → `host`, UDP |
| A-4 | 14 849 ms | 13 706 ms | 761 ms | 401 ms | 330 / 394 ms | 6 882 ms, **0.58 MiB/s** | `srflx` → `host`, UDP |
| B-1 | 268 517 ms | 980 ms | 266 446 ms | 5 240 ms | 910 / 4 168 ms | not done (cap) | `host` → `srflx`, UDP |
| B-2 | 5 048 ms | 2 862 ms | 1 376 ms | 393 ms | 325 / 386 ms | 999 ms, **4.00 MiB/s** | `host` → `prflx`, UDP |
| B-3 | 8 457 ms | 7 152 ms | 599 ms | 462 ms | 381 / 456 ms | 1 367 ms, **2.93 MiB/s** | `host` → `srflx`, UDP |

- **Both directions connected** with the shipped code (A-2…A-4, B-1…B-3), every echo in order, every
  completed history byte-checked (last block index). The host side saw its peer as `prflx`/`host`
  and itself as `host`/`srflx`; never a relay, never IPv6. The `remote-pair` signal ("connects in one
  direction only") did not fire.
- **Cross-version signalling is erratic.** A-1: the viewer here never got as far as a connection in 5
  minutes (that run's log did not yet record Get misses, so the stage is unknown). A-3: the fresh
  instance took 62 s to become readable here. B-1: the viewer's offer took ≈ 266 s to reach the host
  here, and the host answered 1.2 s after it arrived. F2 (both nodes 0.2.136) measured first Get p95
  5.8 s and put → notification p95 3.1 s with 0 misses. Whether 0.2.137 ↔ 0.2.136 or the network
  of the day is the cause is not separated (`S-31`).
- **History across the internet varies by two orders of magnitude**, and by direction: remote → here
  (A) 0.03–0.58 MiB/s and once not finished in 15 min; here → remote (B) 2.9–4.0 MiB/s. The echo
  shows the same split. No `BACKEND_FLOW`/`flow` event fired in the slow run (A-3 logged every
  RtcHost `flow` and channel event), so neither worker queue nor RtcHost back-pressure was the brake;
  the data channel itself was slow. F8's local 13.95 MiB/s floor does not describe a real path
  (`S-31`).
- **Announce** (the signalling + pointer Puts): here 11 040, 10 269, 2 766 ms (B-1…B-3), on the
  remote 10 273, 1 629, 1 387, 2 106 ms (A-1…A-4). Around 10 s the Put itself times out and the
  following Get saves it (`S-30`).
- `SyncRepo`: first full run 52 s (rsync + `npm ci` ≈ 40 s on the remote), later runs 8 s with `npm
  ci` kept; the first attempt timed out uploading the spike's 170 MB cargo `target/`, now excluded.

## GUI proof (step 8, `shots/f9-run.sh`)

Two instances of the default package, each on its own uisolate display with its own `--storage`,
`--electron-user-data`, debug port (17291, 17292), `--no-updates` and a scratch `HOME`, both against
the owner's node. Before `S-29` was fixed the host's first Freenet share failed after 5.2 s
(`could not put the link's contract: Connection closed: 1006`); after it (run of 19:21 UTC):

- `share.backends` on both: `pear` `available`, `freenet` `available`; the host's picker listed both
  as radios, Freenet was picked, the share key came back (announce 8 971 ms).
- The viewer's `POST /join`: `share:join-changed` `joined` 1 098 ms after the request; viewer
  subscribe 309 ms, offer → answer 190 ms, dial → connected 608 ms; host `host:connected` 194 ms after
  the offer.
- `GET /share/diagnostics` on both: `backend.id === 'freenet'`, one connection each, `iceState`
  `connected`, `path` `DIRECT`, 2 channels; `ice.servers` the `D-11` list (pushed by the host through
  `share.setIceServers`), `hostCandidatesOnly: false`, `relay: false`; `links[0]`: `halfOpen` 0,
  `refused` 0.
- The host typed one line; the viewer's `/renderer/terminal-display` contained it, and
  `shots/f9-join.png` is the viewer's screen. Both sessions were stopped with `uisolate stop`.
- `shots/f9-picker-no-node.sh` ran one more instance in its own network namespace (`unshare -rn`, so
  nothing answers at 127.0.0.1:7509): `share.backends` gave `freenet` `broken` / `no Freenet node at
  ws://127.0.0.1:7509 — see README "Freenet"`, and the picker showed Pear as the only radio with
  Freenet disabled beside that text (`shots/f9-picker-no-node.png`).
