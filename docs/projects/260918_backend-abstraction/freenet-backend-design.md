# Freenet share backend — design (phase B9, R-12)

Written 2026-09-18 from the B8 measurements in [`probes.md`](probes.md). This is a design for the
follow-on project (`D-03`); nothing in it is implemented beyond the stub
`engine/backends/freenet/index.js::FreenetBackend`, the registry hook
`engine/backends/index.js::load` (which calls a backend's static `availability()`), and the probe code
under `spikes/freenet/`.

Rules this document follows: a row marked **probed** cites a number or a quoted failure from
`probes.md`; a row marked **deferred** was not probed; "not measured" means exactly that. Every design
choice below that no probe backs is labelled *design*.

## 1. What the measurements do and do not cover

Four caveats apply to every number cited here.

1. **No network hop was measured (`S-04`).** The node on `127.0.0.1:7509` is `freenet network`, so a
   `Put` there publishes to the public network. It was used read-only. Every write went to a separate
   `freenet local` on port 7519. Both P-4 clients were WebSocket clients of that one local-mode node.

   > **2026-09-24 (`260924_freenet-backend` F2).** Superseded: the network hop is now measured between
   > two `freenet network` nodes 0.2.136 (the owner's, behind NAT, WebSocket client only with `Put`
   > consent per `Q-1`; `hetzner-deb16`, public address). A fresh instance was readable from the other
   > node on the first `Get` in 9 of 9 runs; put → notification round trip p50/p95 1 148 / 1 525 ms at
   > 1 Hz with the host remote, 724 / 815 ms with the host here; offer → connected through the contract
   > with the `D-11` STUN list p50/p95 1 691 / 2 137 ms and 1 182 / 1 301 ms. `S-04` closed. Tables in
   > `../260924_freenet-backend/measurements.md`.
   **Propagation between two network-mode nodes is not measured.** The only network-mode datum is a
   `Get` of a missing key on 7509: `"getMissing": "rejected: Contract not found", "getMissingMs": 4734`.
2. **The SDK's promises cannot be awaited naively (`S-05`).** `@freenetorg/freenet-stdlib` 0.4.0 against
   node 0.2.135: `subscribe()` never resolves (the node answers with a `PutResponse`; the subscription
   is live); a second `Put` of an existing instance hangs for the 30 s request timeout; a local-mode
   node never answers a `Get` miss (`rejected: Request timeout` after 30 002 ms); every notification is
   a `DeltaUpdate` carrying the whole live state (10.8–12.9 kB average for 64-byte payloads). Workarounds
   exist in `spikes/freenet/lib/fnet.js::connect`.
3. **WebRTC does not work under Bare (`S-06`).** As published, no library loads
   (`MODULE_NOT_FOUND: Cannot find module 'fs'` / `'crypto'` / `'util'`). node-datachannel's raw binding
   loads and opens a channel in 8–11 ms, but every binary frame arrives zeroed
   (`"hex":"00000000","expectedHex":"706f6e67"`), on Bare 1.30.3 and on pear-runtime's Bare 1.27.0. Send
   side versus receive side was not separated. pear-runtime's Bare 1.27.0 also caps every `bare-*`
   dependency (`bare-fs` 4.8.1 refuses it: `requires range '>=1.28.0'`), and `@noble/hashes` does not
   load under Bare.
4. **Hypercore over a data channel has three constraints (`S-07`), all measured under Node only.**
   `core.replicate(isInitiator, rawDuplex)` writes nothing on hypercore 11.33.5; the working call is
   `core.replicate(new NoiseSecretStream(isInitiator, rawDuplex))`. A message above the SCTP cap kills
   the transfer (`Message size exceeds limit` at 262 144 bytes on node-datachannel; werift's cap is
   65 536). `bufferedamountlow` never fired on werift or @roamhq/wrtc; node-datachannel's
   `onBufferedAmountLow` fired every time. P-6 was not run under Bare.

## 2. R-12 table

| Pear feature | Freenet-side component | Status | Number or quoted failure |
|---|---|---|---|
| Topic announce and lookup | Rendezvous: the signalling contract instance itself is the rendezvous point; its instance id travels in the invite `route` (§5). A separate signed host advert is not needed for a single link. | **probed** (the contract verbs); advert **deferred** | P-2: `Put` 104.3 ms, `Get` p50 0.30 / p95 0.63 ms, `Subscribe` 0.63 ms. P-1 under pear-runtime's Bare 1.27.0: `Put` 57 ms, update→notification p50 37 / p95 44 ms (n = 20). Network mode: not measured, except the 4 734 ms `Get` miss. |
| Noise socket, hole punching | Signalling contract (SDP/ICE mailbox per link, TTL) + WebRTC data channel | **probed**, local-mode node, Node only | P-4 put→notification p50 / p95: 78.7 / 87.5 ms at 1 Hz, 45.1 / 87.2 ms at 5 Hz, 39.3 / 44.8 ms at 20 Hz, 200 / 200 delivered each. Offer→connected through the contract: 114 ms (node-datachannel, 14 signalling messages), 185 ms (@roamhq/wrtc), 2 168 ms (werift). Hole punching itself: **not measured**; both peers were in one process on loopback. |
| `remotePublicKey` authentication | DTLS fingerprint signed by the ed25519 transport key (§6) | **probed** for fingerprint access; signing and rejection **deferred** | P-3: all three libraries expose the remote fingerprint and the API value equals the SDP value (node-datachannel `pc.remoteFingerprint()`). Not tested: that a library rejects a handshake whose certificate does not match the SDP fingerprint; whether node-datachannel's accessor is handshake-derived or SDP-derived. |
| Relay + DHT registry | ICE servers (`ZBTERM_ICE_SERVERS`); TURN is operator-supplied (§9) | **deferred** | Not measured. No STUN or TURN server was in any probe. |
| Firewall and pins | `setAdmission` applied to signalling entries; per-link rate limit (§7) | **deferred** | Not measured. The probe contract authenticates nothing: `spikes/freenet/contracts/signalling/src/lib.rs::Entry` has no signature field. What bounds abuse today is measured: a 512-entry cap and a 16 KiB payload cap, with `verify-merge` 117 cases, 117 held, 0 violations. |
| Live Hypercore replication | Hypercore stream over a second data channel (§8.1) | **probed**, Node only | P-6, 16 MiB log, 65 536-byte messages: 12.87 MiB/s (node-datachannel), 11.59 MiB/s (@roamhq/wrtc), 1.01 MiB/s (werift with polling). With 512 KiB blocks: 36.64 MiB/s, largest frame 2 622 493 bytes, 10 back-pressure pauses. Across the worker↔host seam: not measured. |
| Offline history | Segment contract per abstract-arch §23.4 (§8.2) | **deferred** | Not measured. An open problem blocks it; see §8.2. |
| Stable addressing across WASM rebuilds | Pointer record (§5.2) | **probed** for the need; the record itself **deferred** | P-5: key `DaKqHzqbPPZiecdNXF26rjnV9msvPghf2Cc9jEn6KbDw` identical across an incremental build, a build after `cargo clean` and a build from another path (181 292 bytes each). One source edit moved it from `5R9p6w…` to `DaKqHz…`. Cross-toolchain, cross-host and different-`Cargo.lock` reproducibility: not measured. |
| Always-on DHT | Node lifecycle manager: locate or spawn, health, version pin, exit code 42 (§10) | **deferred** (A-5) | Locate only was exercised: WS open 38.2 ms on 7519, 37.37 ms on 7509. Spawn, supervision and exit code 42: not measured. |
| `swarmDiagnostics` | Node state, WebSocket RTT, contract keys, ICE state (§4, `diagnostics`) | **deferred** | The inputs exist and were read in the probes (WS open time, contract key, `remoteFingerprint`); no diagnostics object was built. |

## 3. Topology (`D-06`)

**Decision `D-06`, taken by the plan executor from the B8 measurements; open to the owner's revision.**
The adapter is split across the existing worker↔host seam:

| Half | Runs in | Why |
|---|---|---|
| Contract client: SDK, key derivation, signed signalling entries, admission, the whole `ShareBackend` surface | the Bare worker, in `engine/backends/freenet/` | P-1 passes under pear-runtime's Bare 1.27.0 (p50 37 / p95 44 ms) with four shims (`spikes/freenet/lib/bare-shims.js`) and a dependency-free BLAKE3 (`spikes/freenet/lib/blake3.js`). ShareManager calls a backend synchronously in places (`routeFor`, `dial` pinning, `send` returning a boolean), so the object it holds must live beside it. |
| WebRTC: peer connections, data channels, ICE | the host process, on `node-datachannel` 0.33.4 | The P-3 re-planning signal fired: binary frames are zeroed under Bare. node-datachannel is the fastest to connect (114 ms), the fastest to replicate (12.87 MiB/s) and the only library whose drain event fired. |

The two halves talk over new `BACKEND_*` frames. This is the pattern already used for the PTY:
`engine/pty-remote.js::PtyRemote` turns every call into a `FrameKind.PTY_*` frame through the `send`
function `engine/worker.js` gives it, `engine/client.js::EngineClient._onFrame` dispatches those frames
to the injected `ptyHost`, and the callback direction comes back through
`engine/pty-remote.js::PtyRemote.handleData` / `::handleExit`. Frame bodies are `compact-encoding`
codecs registered in `engine/rpc/schema.js::BODY_CODECS`.

### 3.1 Frames (*design*)

New kinds are **appended** after `engine/rpc/schema.js::FrameKind.PTY_DETACH` (14). Kinds 0–14 keep
their numbers; the plan forbade renumbering and the same rule holds for the follow-on. Each kind needs a
row in `docs/CORE-CONTRACT.md`, which `test/core-contract.test.js` drift-tests.

| Frame | Direction | Body | Meaning |
|---|---|---|---|
| `BACKEND_OPEN` | worker → host | `connId`, `iceServers` override (optional) | Create one peer connection. |
| `BACKEND_SIGNAL` | both | `connId`, `type` (`offer` / `answer` / `candidate`), `sdp` or `candidate` + `mid` | Host → worker: a local description or candidate to publish. Worker → host: a remote one, **already signature-checked** (§6). |
| `BACKEND_STATE` | host → worker | `connId`, `state`, `localFingerprint`, `remoteFingerprint`, `pathKind` | ICE / DTLS state changes; `pathKind` is the selected candidate pair's type. |
| `BACKEND_CHANNEL` | both | `connId`, `chanId`, `label`, `op` (`open` / `opened` / `closed`) | Data-channel lifecycle. |
| `BACKEND_DATA` | both | `connId`, `chanId`, `data` (buffer) | One data-channel message, ≤ 65 536 bytes. |
| `BACKEND_FLOW` | host → worker | `connId`, `chanId`, `paused` | Back-pressure: the host half sets `paused` when `bufferedAmount` passes its high-water mark (the probe used 1 MiB) and clears it on `onBufferedAmountLow`. |
| `BACKEND_CLOSE` | both | `connId`, `reason` | Tear down the peer connection. |

The host half is a small adapter injected the way `ptyHost` is: `EngineClient({rtcHost})` (*design*;
the option does not exist). Both hosts would need it: `electron/engine-lifecycle.js` and
`tabby-plugin/src/main/host.ts`. A host with no `rtcHost` must make the backend report `broken` with
a detail such as "host has no WebRTC adapter". The static `availability()` hook cannot see the host, so
that fact has to reach the worker before `share.backends` is answered; how (a further spawn argument
beside `engine/worker.js`'s `backendLimit`, or a hello frame) is left to phase F2.

> **2026-09-24 (`260924_freenet-backend` F4).** Measured with `scripts/measure-seam.js` through a real
> sidecar: 16 MiB in 65 536-byte `BACKEND_DATA` frames at 327–411 MiB/s worker → host and 60–115 MiB/s
> host → worker (reported, not gated); the pipe is not the bottleneck for the 1 MiB/s history gate.

Not measured: the cost of carrying every data-channel message across the pipe. P-6's 12.87 MiB/s had
Hypercore and the data channel in one Node process. `engine/client.js::EngineClient._sendPtyData`
already shows the pipe's own back-pressure handling (pause on a `false` write, resume on `drain`); the
`BACKEND_DATA` path needs the same in both directions.

### 3.2 Rejected

Both halves in the host process (every backend call would become asynchronous, not just channel I/O);
a Node sidecar (a third process; the host already runs Node); a Rust sidecar (nothing measured calls
for it; A-4); base64 over text frames under Bare (+33 % bytes, throughput unmeasured, built on a binding
whose binary path is known broken); a Bare import map for werift's 12 Node builtins (untried, and werift
measured 2 168 ms to connect and 1.01 MiB/s).

## 4. `ShareBackend` member by member

Members are those of `engine/backends/types.js::BACKEND_MEMBERS`. "Contract" means the per-link
signalling contract instance unless said otherwise.

| Member | Freenet realisation | State it keeps | Failure modes |
|---|---|---|---|
| `describe()` | `{id:'freenet', label, interfaceVersion:1, capabilities}`. The stub already claims `HISTORY_OFFLINE_HOST` and `HISTORY_EVENTUAL_MERGE` (`engine/backends/freenet/index.js::CAPABILITIES`); those bits must be **cleared** until §8.2 lands, because ShareManager acts on capabilities (`engine/share-manager.js::createLink` strips `SEND_INPUT` by capability). No `DIRECT_DIAL`, no `PATH_MIGRATION`. | none | none |
| `start(ctx)` | Keeps `ctx.keyPair` (read lazily, as Pear does). Opens **one** WebSocket to the local node and nothing else: no contract is put or subscribed. This is a socket, but not a share socket, the same reading `S-02` gives Pear's registry lookup. | WebSocket, node version, `started` | No node at the address → reject `E_BACKEND_UNAVAILABLE` with the address in `detail`. Host has no `rtcHost` → same code. Measured cost of success: WS open 13–38 ms. |
| `stop()` | Cancels every dial, sends `BACKEND_CLOSE` for every connection, writes tombstones for its own live entries (best effort), closes the WebSocket. Safe twice. | — | A tombstone that fails to land is harmless: entries expire at `t + ttl_ms`. |
| `health()` | `{started, listening, detail}`; `listening` is true while at least one announced contract has a live subscription. `detail` carries the node problem when there is one. | — | — |
| `localPeerKey()` | `ctx.keyPair().publicKey`, the same 32-byte ed25519 key Pear uses (`engine/crypto.js::transportKeyPair`). `null` before an identity exists. | — | — |
| `routeFor(linkId, stored)` | Synchronous. Returns `stored.route` when present; otherwise mints `{sig, code, params, ptr, k}` (§5) by computing `blake3(blake3(wasm) ‖ params)` locally, as `spikes/freenet/lib/fnet.js::contractKey` does. No network. | the bundled WASM and its code hash | WASM missing from the build → throw `E_BACKEND_UNAVAILABLE`. |
| `announce(linkId, {route, tag})` | `Put` the contract instance named by `route` with an empty canonical state, then subscribe. Both calls go through the `S-05` workarounds: take the `PutResponse` as the subscribe ack; never `Put` an instance twice (after a restart, `Get` first, and `Put` only on a miss). | per link: instance id, subscription, highest `seq` seen per viewer key | `Put` on a network-mode node publishes publicly (`S-04`); that is intended here. Timeout → reject; ShareManager already made the link record, so the link exists but is unreachable until a retry. A local-mode node never answers a `Get` miss, so the `Get`-first path needs its own short timeout. |
| `withdraw(linkId)` | Per `D-04`: ends discovery, not reachability. Unsubscribe, write tombstones over the host's own entries, stop answering offers for that link, decrement `diagnostics().announced`. The contract instance cannot be deleted; its entries age out by TTL (120 000 ms in the probe's `params.json`). Live connections survive. Because no answer is ever written again, a later dial of that route cannot connect: Freenet is a backend that **does** refuse after `withdraw`, which `D-04` allows. | — | Idempotent. Note that ShareManager does not call `withdraw` today (`engine/share-manager.js::revokeLink`); see `open-issues.md`. |
| `dial(route, expectedPeerKey, {signal, tag})` | Pins `expectedPeerKey` synchronously. Verifies `route` (§5.1), subscribes to the instance, sends `BACKEND_OPEN`, publishes the signed offer and candidates the host half returns, waits for an answer signed by `expectedPeerKey`, forwards it, and resolves `connected` once `BACKEND_STATE` reports `connected` **and** the fingerprint check of §6 passes. Returns `{connected, cancel}`; `cancel` and `signal` tombstone the offer and send `BACKEND_CLOSE` only if no connection was surfaced. A second `dial` to a peer with a live connection reuses it, as Pear reuses a warm socket. | per dial: `connId`, own `seq`, the pinned key | Route's `code` not in the build's known set → reject `E_BACKEND_UNSUPPORTED`-style "contract version" error (needs a pointer lookup first, §5.2). No valid answer → `connected` stays pending until the caller cancels (ShareManager's `JOIN_TIMEOUT_MS`, 30 s). ICE `failed` → reject with `detail:'ice-failed'` (§9). Fingerprint mismatch → close, reject `E_AUTH`. Instance missing on a network node: a 4.7 s wait was measured before `Contract not found`. |
| `'connection'` event | Host side: emitted once a viewer's connection passes §6. Dial side: emitted with the same object `connected` resolves to, as `types.js` requires. `info` carries `{linkId}` from the signalling entry. | `_conns` by remote key | — |
| `setAdmission(policy)` | Evaluated in the worker on each **verified** offer, before `BACKEND_OPEN` is sent, so a refused key costs no peer connection. A key pinned by an active `dial` is always admitted. Unlike Pear (`S-09`), a refusal is not sticky: the next offer is evaluated again. | the policy, refusal counters | See §7 for what a refusal cannot stop. |
| `PeerConnection.openChannel(protocol, id, handlers)` / `onChannel` | One RTCDataChannel per `(protocol, id)`, ordered and reliable, label `protocol + ' ' + hex(id)`; `onChannel` fires from the remote's `BACKEND_CHANNEL open`. Messages are JSON (A-10) cut into parts of ≤ 65 536 bytes and reassembled in order. `send` returns `false` while `BACKEND_FLOW paused` is set or once closed. | per channel: `chanId`, paused flag, reassembly buffer | Text versus binary framing is the host half's choice; both work under Node. Channel closes → `onclose` once. |
| `PeerConnection.path()` | From `BACKEND_STATE.pathKind`: `host`/`srflx`/`prflx` → `DIRECT`, `relay` → `RELAY`. Never `BROKER`: the contract brokers the handshake, not the data. Emits `'path'` on change. | — | Not measured: whether node-datachannel reports the selected pair reliably. |
| `serveHistory(conn, store)` / `attachHistory(conn, store, keys)` | §8.1: one extra data channel per connection, a framed duplex over `BACKEND_DATA`, wrapped as `S-07` requires, with `store.log` and `store.metaCore` replicated on it. Idempotent per connection and store (a WeakSet, as in `engine/backends/pear/connection.js::_replicate`). `attachHistory` returns `{fetch, close}` where `fetch` is `store.log.download({start, end, linear:true})`. | per connection: the history channel and its stream | Message above the cap kills the channel (`Message size exceeds limit`), so the framer must cut. |
| `historyRouteFor(store)` | `null` until §8.2 exists; afterwards the segment contract's route. | — | — |
| `diagnostics()` | `{backend:'freenet', started, announced, node:{address, version, wsRttMs}, links:[{linkId, instance, entries}], conns:[{peer, iceState, path, channels}], refused}`. JSON-safe; never the route secret `k`, never SDP (it holds addresses). | — | — |
| `'debug'`, `'error'` | Same shape as Pear's: `{event, details}` with `opts.tag` copied in. | — | — |

> **2026-09-24 (`260924_freenet-backend` F6) — `announce`, `withdraw`, `dial`, `'connection'`,
> `setAdmission` as built** (`engine/backends/freenet/index.js`, `signal.js`, `connection.js`).
> `announce` Puts a route this object minted without a `Get` first, and reads a stored route's
> instance with a `Get` under 2 000 ms first (`ANNOUNCE_GET_MS`), Putting only on a miss; the
> link's pointer record is Put beside it (§5.2). `withdraw` cannot unsubscribe (SDK 0.4.0 has no
> unsubscribe request): the backend stops reading the instance's notifications, which the node keeps
> sending. `dial` does **not** reject at once when the route names another host than
> `expectedPeerKey` (`route.verify`'s `E_AUTH`): nothing is sent to the node and `connected` stays
> pending until the caller cancels, as the conformance case 'a wrong expectedPeerKey never yields a
> connection' requires of every backend. Every other bad route rejects at once. A peer connection
> that fails before it surfaces rejects `E_HOST_UNREACHABLE` with `detail` `'ice-failed'`; a
> certificate that is not the signed SDP's rejects `E_AUTH`, `detail` `'fingerprint mismatch'`. A
> second `dial` to a peer with a live connection does **not** reuse it yet (each dial makes its own
> peer connection); that and the per-link limits of §7 layer 4 are `F7`'s. `'connection'`'s `info`
> is `{ linkId }` on the host side and `{ linkId: null }` on the dialing side. `diagnostics()`
> carries every field of the row above; `node.version` and `wsRttMs` are still `null`. Pinned by
> `test/backends/freenet-backend.test.js` and cases 1–3 of `test/backends/conformance-freenet.js`.

> **2026-09-24 (`260924_freenet-backend` F7) — `openChannel` / `onChannel`, `BACKEND_FLOW`,
> `setAdmission` as built** (`engine/backends/freenet/channel.js`, `connection.js`, `index.js`). The
> row above holds, with these specifics. Framing is binary throughout: a message is JSON → UTF-8,
> cut into parts of at most 65 536 bytes, each `[flags u8][index u32 LE][payload]` (flag bit 0 = last
> part), cut in the worker before `RtcHost.send`. Channels pair as the loopback's do: the first side
> to open `(protocol, id)` creates the data channel (worker chanIds from 1; 0 is the dial's
> `zbterm/fnet-bootstrap` channel, which carries nothing and is never surfaced); the other side
> hears it through `onChannel` and takes that same data channel with `openChannel`. If both open the
> key at once, each sends on its own and reads both. The same key opened twice on one side throws.
> Back-pressure has the loopback's advisory shape, with no `'drain'` event (the loopback has none):
> `send` never drops on an open channel and returns `false` while `BACKEND_FLOW` has the data channel
> paused **or** while the worker holds ≥ 256 KiB for it (`channel.js::QUEUE_HIGH_WATER`; parts wait
> there until the data channel opens and while it is paused). `setAdmission`'s policy is called as
> `policy(remotePeerKey, { remotePeerKey, linkId })`. The per-link limits of §7 layer 4 are in (see
> §7). `announce` and `dial` called while `start()` is still opening its socket wait for it
> (ShareManager starts a backend without awaiting it). A second `dial` to a peer with a live
> connection still does **not** reuse it; F7's steps did not include it. Measured (loopback, host
> candidates, local-mode node 0.2.136; reported, not gated): a 200 KiB message 5.5 ms send →
> `onmessage`; the conformance 10 000-message burst (828 890 bytes of JSON) 272 ms, `send()` false
> 7 009×, worker queue high-water 878 890 bytes; the same burst on an already-open data channel never
> returned `false` (it stays under `RtcHost`'s 1 MiB mark). Pinned by
> `test/backends/freenet-backend.test.js` and every non-history case of
> `test/backends/conformance-freenet.js`.

> **2026-09-24 (`260924_freenet-backend` F8) — `serveHistory` / `attachHistory` as built**
> (`engine/backends/freenet/history.js`). The row above holds, with these specifics. The history
> data channel is labelled `zbterm/history 00` (protocol `zbterm/history`, id one zero byte) and
> pairs like every other channel (§4 F7 note above): whichever side calls first opens it, the other
> takes it; it is never offered to an `onChannel` listener. Its messages are raw bytes, not the F7
> JSON parts: a `streamx` `Duplex` writes one frame per stream write, `u32 LE length ‖ bytes`, cut
> into data-channel messages of at most 65 536 bytes, and reassembles frames on read; the channel
> reuses F7's queue and `BACKEND_FLOW` back-pressure (a write completes only once the channel is
> below `QUEUE_HIGH_WATER` and not paused). One stream per connection, wrapped as
> `new NoiseSecretStream(conn.initiator === true, duplex)` (ephemeral keys; the dialing side is the
> initiator), carries `store.log` and `store.metaCore` of every session on it; replication is
> idempotent per (connection, store). `attachHistory` returns `{ fetch, close }` exactly as the
> loopback does. `historyRouteFor` stays `null` (`D-13`). The file the notes above cite as
> `test/backends/conformance-freenet.js` is now `test/backends/conformance-freenet.test.js` and runs
> in `npm test`, all 14 cases green. Pinned by that file's history case and by
> `test/backends/freenet-backend.test.js` 'freenet: history replicates 256 KiB blocks over
> zbterm/history 00, in messages of at most 65 536 bytes'.

> **2026-09-24 (`260924_freenet-backend` F8, re-dispatch) — two corrections to `dial` and
> `openChannel` as built** (`S-26`). (1) The dialing side no longer trickles its candidates with
> its offer: it sends them only after it has applied the host's answer. A host that had them
> reached ICE `connected` and began DTLS while its answer was still travelling through the
> contract, and a viewer applying the answer late then failed the certificate check inside
> node-datachannel. The host now sends no check before the viewer's own arrive. (2) A connection
> creates the data channels it opens in the host half only once the dial's bootstrap channel
> (`zbterm/fnet-bootstrap`) reports open; until then they queue like any channel that is not open
> yet. node-datachannel reports `connected` before it has opened the channels made before SCTP was
> up, and a channel created in that window vanished. Pinned by the two `(S-26)` tests in
> `test/backends/freenet-backend.test.js`. (3) The side that opens a data channel sends nothing on it
> until the other side, once it has wired the channel, sends one `READY` part (`[0x02][u32 0]`, no
> payload, `engine/backends/freenet/channel.js::READY_PART`); node-datachannel delivered messages that
> arrived before the receiver's handler was set out of order (`S-27`). Messages sent meanwhile queue
> in the worker. Pinned by 'freenet: the opener of a channel sends nothing until the other side is
> ready (S-27)'.

## 5. The invite `route`

Freenet invites are always v2 (`engine/invite.js::toV2`; any `b` other than `pear` is v2, `D-05`).
`b` is `'freenet'`, `peer` is the host's transport key in hex, and `route` is opaque to everything but
this backend:

```
route = {
  sig:    "<base58 instance id of the signalling contract>",
  code:   "<hex BLAKE3 of the raw signalling .wasm>",
  params: { ttl_ms: 120000, host: "<hex transport key>", n: "<32 random bytes, base64url>" },
  ptr:    "<base58 instance id of the pointer record>",      // optional until §5.2 lands
  k:      "<32 random bytes, base64url>"                     // payload key; never sent to the node
}
```

All of it is *design*; the probe's parameters were `{"ttl_ms":120000}` plus a nonce.

- **One contract instance per link.** The nonce `n` makes the instance id unguessable and unique. This
  also sidesteps `S-05`(b): an instance is never `Put` twice in normal operation.
- **`sig` is redundant on purpose.** The viewer recomputes `blake3(code ‖ params)` and refuses a route
  whose `sig` differs, then refuses a `code` it does not know (§5.2). The hash input is the **raw**
  `.wasm`, not the package `fdev build` writes (probes.md, P-2 finding 4).
- **`k` keeps SDP private.** Contract state is readable by every node that hosts it, and SDP carries IP
  addresses. Payloads are therefore encrypted under a key derived from `k`, and signatures are made
  over the ciphertext so the contract can check them without `k`.
- `engine/share-manager.js::createLink` stores `link.route` for a backend whose route is not a Pear
  topic (the `LoopbackBackend({routeKey})` path, `D-05`), so nothing in ShareManager changes.

> **2026-09-24 (`260924_freenet-backend` F5).** Landed as `engine/backends/freenet/route.js::{mint,
> verify}`; `FreenetBackend.routeFor` calls `mint`. `ptr` is always minted now: the pointer instance for
> the parameters `{"host":"<hex>"}`, so there is **one pointer record per host key, not per link**
> (the plan's F5 step 7 says "for `{ host }`"); the pointer contract ignores unknown parameter fields,
> so a per-link pointer (`{ host, n }`) needs no new pointer code, only a different `mint`. `F6` puts
> the pointer's state and must settle which. `linkId` is not an input of the route. Pinned by
> `test/backends/freenet-contracts.test.js` 'freenet: route.mint and route.verify round trip'.

> **2026-09-24 (F6) — one pointer per link.** Settled before the first pointer `Put`: `ptr` is the
> pointer instance for `{"host":"<hex>","n":"<the route's n>"}` (`route.js::pointerParamsBytes(host,
> n)`), so each link has its own record and no link overwrites another's. `announce` Puts version 1,
> which names the link's own signalling instance. `dial` does **not** read `ptr` first: it reads it only
> when `route.code` is not a signalling version this build ships (§5.1's `E_BACKEND_UNSUPPORTED`),
> checks the record's signature under the expected host key and re-checks the route it names without
> `ptr`. F5 removed the cause of reading it first (the builder-dependent contract key). Pinned by
> `test/backends/freenet-contracts.test.js` 'freenet: route.mint and route.verify round trip' and
> `test/backends/freenet-backend.test.js` 'freenet: a route whose code this build lacks is looked up
> through its pointer record'.

### 5.1 What a viewer checks before dialing

`sig === contractKey(code, params)`; `params.host === invite.peer === expectedPeerKey`; `code` is one of
the code hashes this build ships. Any failure rejects the dial before a byte reaches the node.

> **2026-09-24 (F5).** `verify` runs the checks in this order: a well-formed route (else `E_CORRUPT`),
> `params.host === expectedPeerKey` (else `E_AUTH`), `sig` recomputed from `code` and `params` (else
> `E_CORRUPT`), `ptr` (when present) the host's pointer instance (else `E_CORRUPT`), and `code` one of
> the signalling versions this build ships (else `E_BACKEND_UNSUPPORTED`, the cue to read `ptr`).
> Pinned by `test/backends/freenet-contracts.test.js` 'freenet: route.verify rejects a changed sig, a
> foreign host, an unknown code'.

### 5.2 Pointer record (upgrades)

P-5's signal did not fire for rebuilds: three builds, one key. But **any source edit moves the key**
(`5R9p6w…` → `DaKqHz…` after one fix), and toolchain changes were not measured. So:

- Each build ships the WASM bytes of the signalling contract versions it supports, and their hashes.
  The WASM is committed or fetched as a build artefact, never rebuilt at package time.
- A link minted by version A is served by version A's contract for its whole life. A newer host keeps
  the old WASM and keeps serving the link. This needs no pointer.
- The pointer record is for the case where a viewer's build lacks the `code` in the invite, or a host
  must move a long-lived link to a fixed contract. It is a second, deliberately tiny contract whose code
  is meant never to change: state `{ver, sig, code, params}` signed by `params.host`, highest `ver`
  wins. The invite's `ptr` names it; a viewer that cannot use `route.sig` reads `ptr` and re-checks §5.1
  against what it finds.
- Open: the pointer contract's own key has the same fragility, which is why it must be frozen and
  reproducibly built; cross-toolchain reproducibility is **not measured**.

> **2026-09-24 (F5) — reproducibility measured.** The contracts are `engine/backends/freenet/contracts/
> src/{signalling,pointer}/`, built by `scripts/build-contracts.sh`, shipped as `signalling-v1.wasm`
> (240 972 bytes) and `pointer-v1.wasm` (187 376 bytes), BLAKE3-pinned in `contracts/hashes.json`
> (`test/backends/freenet-contracts.test.js`, the first test). Cross-host: the same rustc 1.95.0
> (59807616e 2026-04-14), cargo 1.95.0 and fdev 0.3.298 on this machine and on `hetzner-deb16` first
> built **different** bytes (241 108 against 241 324 for the signalling contract): panic locations
> embed the absolute path of every dependency's source under `$CARGO_HOME`
> (`/home/zeev/.cargo/registry/…` against `/home/zeev/work/zbterm/rust/cargo/registry/…`). So P-5's
> key also depended on the builder's home directory. With `--remap-path-prefix=$CARGO_HOME=/cargo`
> (in the build script) both hosts build identical `hashes.json`, both contracts. Other rustc versions:
> still not measured.

## 6. Peer authentication

`dial` must reject a connection whose `remotePeerKey` differs from `expectedPeerKey` before surfacing
it (R-1). There is no Noise handshake here; the DTLS certificate is self-signed and ephemeral. The
binding is a signature by the ed25519 transport key over the SDP, which contains `a=fingerprint:`.

Signalling entry (*design*; extends `spikes/freenet/contracts/signalling/src/lib.rs::Entry`):

```
{ l: linkId, r: "v:<viewerKeyHex>" | "h:<viewerKeyHex>", s: seq, t: ms, d: bool,
  p: <ciphertext of {type, sdp | candidate, cid, re}>, g: <ed25519 signature> }
g = sign(transportSecretKey, "zbterm/fnet-signal/1" ‖ sig ‖ l ‖ r ‖ s ‖ t ‖ d ‖ p)
```

`r` names the viewer on both sides, so several viewers share one link's mailbox without key collisions.
`cid` is a random connection id chosen by the viewer; `re` in an answer is the hash of the offer it
answers, so an old signed answer cannot be replayed against a new offer.

> **2026-09-24 (F5) — the signed bytes as built.** A contract never learns its own instance id (it
> sees its parameters, not its code hash), so `signalling-v1` cannot check a signature over `sig`. It
> checks one over the instance's raw **parameter bytes** instead, which carry the per-link nonce `n`
> and bind an entry to one instance just as well. The concatenation is length-prefixed, binary:
> `"zbterm/fnet-signal/1" ‖ lp(params) ‖ lp(l) ‖ lp(r) ‖ u32le(s) ‖ u64le(t) ‖ u8(d) ‖ lp(p)` with
> `lp(x) = u32le(len(x)) ‖ x`; `g` is 128 hex characters. `r` is `v:<64 hex>` (signed by that key) or
> `h:<64 hex>` (signed by `params.host`). Source of truth: `engine/backends/freenet/contracts/src/
> signalling/src/lib.rs` (module comment); a JS signer that produces the same bytes is
> `scripts/contract-fixtures.js::{entryBytes, signEntry}`. The pointer record signs
> `"zbterm/fnet-pointer/1" ‖ lp(own params) ‖ u64le(ver) ‖ lp(sig) ‖ lp(code) ‖ lp(params)`.

Sequence:

1. Viewer: `BACKEND_OPEN`; the host half returns the local offer; the worker signs and publishes it
   under `v:<own key>`.
2. Host worker: a notification arrives (whole state each time, `S-05`(d), so the worker de-duplicates by
   `(r, s)`). It verifies `g` against the key named in `r`, runs `setAdmission` on that key, checks the
   per-link limits of §7, and only then sends `BACKEND_OPEN` + `BACKEND_SIGNAL` to its host half.
3. Host: publishes the signed answer under `h:<viewer key>`, with `re`.
4. Viewer worker: accepts an `h:` entry only if `g` verifies under **`expectedPeerKey`** and `re`
   matches its offer. Anything else in the host role is ignored and counted; it never reaches the host
   half, so an attacker's SDP is never applied.
5. Both: on `BACKEND_STATE connected`, compare `remoteFingerprint` with the fingerprint inside the SDP
   that was verified. A mismatch closes the connection and rejects `connected` with `E_AUTH`. Only after
   this does `'connection'` fire with `remotePeerKey` set to the signing key.

Why step 5 exists: P-3 found that all three libraries expose the fingerprint and that the API value
equals the SDP value, but it did **not** test that a library refuses a certificate that mismatches the
SDP, and did not establish whether node-datachannel's `remoteFingerprint()` is handshake-derived. Phase
F4 must prove both with a negative test (a tampered fingerprint must fail) before `AUTHENTICATED_PEER`
may be claimed. If the accessor turns out to be SDP-derived, step 5 proves nothing and the binding rests
on the library's documented DTLS check alone; the fallback is an in-band challenge on the first channel
(each side signs the other's nonce plus both fingerprints with its transport key).

> **2026-09-24 (F6) — the handshake as built, and what the negative test showed.** `l` is not the
> link id (a viewer does not know it; the route has no `linkId`): it is the random connection id
> `cid` a viewer picks per dial, so a host's entries for one dial can never be read as another's.
> A payload is `{cid, re?, m: [message…]}` sealed with `crypto_secretbox` under
> `crypto_generichash("zbterm/fnet-payload/1", key = k)`: the messages one peer connection produces
> within 25 ms share an entry, because a machine with many interfaces trickles more candidates than
> the contract's 16 live entries per viewer key (one offer entry and one answer entry on this machine,
> host candidates only). `re` is the hex BLAKE3 of the offer entry's `p` and is on every host entry.
> Negative (i) of F6 (a relay flips one hex digit of `a=fingerprint:` in the verified answer before
> the viewer's host half applies it): node-datachannel 0.33.4 never reports `connected`, the DTLS
> handshake fails and the dial rejects as a failed connection (`E_HOST_UNREACHABLE`, `ice-failed`) in
> under a second. **The library enforces the fingerprint**; step 5 is kept as a second check, and a
> host half that reports a `remoteFingerprint` other than the signed SDP's is refused `E_AUTH` on
> either side. The in-band fallback of the paragraph above is not needed and not built. Pinned by
> `test/backends/freenet-backend.test.js` negatives (i)–(iv).

This sits **under** ShareManager's own identity challenge, which is unchanged: its wire-frozen
`verifierDhtKey` / `proverDhtKey` take their values from `localPeerKey()` and `conn.remotePeerKey`.

## 7. Admission and anti-spam

Anyone who knows an instance id can write to a contract. What limits that, in order:

| Layer | Mechanism | Status |
|---|---|---|
| Knowing where to write | The instance id is derived from a 32-byte nonce carried only in the invite. A party without the invite cannot find the mailbox. | *design* |
| Writing a valid entry | The contract verifies `g`: an `h:` entry must verify under `params.host`; a `v:<key>` entry must verify under `<key>`. Unsigned and mis-signed entries never enter state. | *design*; ed25519 verification cost in WASM is **not measured**, and the change moves the contract key |
| Flooding with valid entries | Per-viewer-key quota inside the contract (for example 16 live entries per `v:` key); host entries in a reserved share of the 512-entry cap, so viewer spam cannot evict an answer. An invite holder can still mint keys; the cap and the TTL bound what that costs: 512 entries × 16 KiB, expiring after `ttl_ms`. | *design*; the 512 / 16 KiB / TTL bounds are what the probe contract enforces today |
| Spending host resources | `setAdmission` runs on the verified key before any peer connection exists. Per link: at most N answered offers per minute and M concurrent half-open connections (numbers to be set by F5). | *design* |
| Joining | Unchanged and backend-neutral: link caps, approval, the identity challenge and revocation are ShareManager's (`D-04`). | landed |

A refused viewer learns nothing: no answer is written. Bandwidth is the remaining exposure: every
notification carries the whole state (10.8–12.9 kB measured at the probe's load), so a full mailbox costs
each subscriber up to the state size per update. The TTL and the caps are therefore bandwidth limits as
well as storage limits.

> **2026-09-24 (F5) — layers 2 and 3 are in the contract.** `signalling-v1` refuses unsigned and
> mis-signed entries in `validate_state` and in every merge (freenet-stdlib 0.10.0 has no
> `validate_delta`; a delta is checked where `update_state` merges it), keeps at most 16 live entries
> per `v:` key, gives `v:` entries 448 of the 512-entry cap and `h:` entries the other 64, drops the
> oldest first when a bound is exceeded, caps a payload at 16 KiB and keeps the clock-free TTL.
> `fdev verify-merge` 0.3.298: 414 cases, 350 held, **0 violations**, 64 inconclusive (the
> deliberately mis-signed fixture, "input not valid") for the signalling contract; 85 cases, 56 held,
> 0 violations, 29 inconclusive for the pointer. **Verification cost, measured** against a local-mode
> node 0.2.136 on this machine: a `Put` of 64 signed entries (29 127 bytes) took a median 97.16 ms
> against 43.49 ms for the same state on a scratch build with the signature check removed (9 runs
> each), **0.84 ms per entry** (reported, not gated); the 512-entry cap stays. A node answers a `Put`
> whose state fails `validate_state` with nothing at all (`S-19`). The admission numbers of layer 4
> are `A-12` / `F7`'s.

> **2026-09-24 (F7) — layer 4 is in the worker.** Per link, at most **30** offers answered in any
> 60 s (`engine/backends/freenet/index.js::MAX_ANSWERS_PER_MINUTE`, `ANSWER_WINDOW_MS`, a sliding
> window) and at most **8** answered peer connections not yet surfaced
> (`MAX_HALF_OPEN`); `A-12`. Both are checked on every verified offer before the admission policy,
> and apply to pinned keys too; an offer past either writes nothing, opens no peer connection and
> counts in `refused`. `diagnostics().links[]` carries `answeredLastMinute`, `halfOpen` and
> `refused` per link. A half-open connection ends when the viewer tombstones its offer, the link is
> withdrawn, or the peer connection fails (≈ 39.5 s after an offer that never gets candidates,
> measured once); the backend has no half-open timeout of its own, so an invite holder re-offering
> about every 40 s can keep a link's 8 slots (`S-22`). Pinned by `test/backends/freenet-backend.test.js` 'an offer
> above MAX_HALF_OPEN on one link gets no answer' and 'a link above MAX_ANSWERS_PER_MINUTE answers
> nothing until the window passes (fake clock)'.

## 8. History

### 8.1 Live history (A-11 kept)

History calls operate on a `SessionStore`'s Hypercores (A-11). Over Freenet that means replicating
`store.log` and `store.metaCore` over a dedicated data channel:

- The raw duplex lives in the worker. It writes one frame per stream write (u32-LE length, then bytes),
  cut into `BACKEND_DATA` messages of ≤ 65 536 bytes, as `spikes/freenet/p6.js` does.
- It is wrapped as `S-07` found necessary: `core.replicate(new NoiseSecretStream(isInitiator, rawDuplex))`.
  `@hyperswarm/secret-stream` is already a dependency of `hypercore`, so no build variant loses it.
  `engine/backends/loopback.js` takes another route to the same end (it pipes two
  `core.replicate(isInitiator, {keepAlive:false})` streams); that form was not measured over a data
  channel.
- Back-pressure comes from `BACKEND_FLOW`, driven by node-datachannel's `onBufferedAmountLow`, the only
  drain event that fired in P-6. A port to another library must poll `bufferedAmount`.
- Measured, Node, in-process: 12.87 MiB/s for 16 MiB of 16 KiB blocks; first block after 153 ms. Not
  measured: the same with the worker↔host pipe in the path, and anything under Bare.

This gives `HISTORY_SPARSE_READ` and `HISTORY_HEAD_WATCH` while the host is online, exactly as on Pear.

> **2026-09-24 (`260924_freenet-backend` F8) — measured with the worker↔host pipe in the path.**
> `scripts/measure-history.js` (two real Bare sidecar workers, each with its own `RtcHost`, one
> local-mode node, loopback, host candidates): 16 MiB of 16 KiB blocks at 26.02 / 28.02 /
> 26.85 MiB/s, first block 47–48 ms after `attachHistory`; 16 MiB of 512 KiB blocks completes at
> 37.56 MiB/s. `R-7`'s ≥ 1 MiB/s gate holds (lowest run 26.02). Details in
> `docs/projects/260924_freenet-backend/measurements.md` "F8". Still not measured: the same across
> the internet (F9 step 7).

### 8.2 Offline history — the open problem

R-12 maps offline history to a segment contract (abstract-arch §23.4): a set of owner-signed encrypted
segments, merged by union. The contract side is ordinary. The reader side is not, and it is **unsolved**:

`engine/index.js::_scheduleRemoteHistoryDownload` and the player read a viewer's **read-only Hypercore
replica** (`remote.store.log`). A replica cannot `append`. It accepts a block only with a Merkle proof
that chains to a tree head signed by the writer's key, and it accepts those only through Hypercore's
replication protocol. Bytes fetched from a contract are not a replication peer. Options, none tried:

> **2026-09-24 (`260924_freenet-backend` F10).** Option A was tried and **works** on hypercore 11.33.5:
> `spikes/freenet/p9-virtual-peer.js` fills a key-only read-only replica from per-segment records
> (blocks + ancestor/root Merkle nodes + the 68-byte signed head; ≈ 0.8 % proof overhead, p50 531 B per
> 64 KiB) through an in-process stand-in peer speaking `hypercore/alpha` over a Noise pair — 980 / 980
> and 15 890 / 15 890 blocks verified, a tampered block refused, one segment survives a contract round
> trip (91 085 B state, Put ≈ 160 ms, Get p50 ≈ 5 ms). Sparse fetch needs a per-segment tree index.
> Verdict: open A as a follow-on (`S-28`); B stays the fallback. Note:
> `../260924_freenet-backend/offline-history-probe.md`.

| Option | What it needs | Risk |
|---|---|---|
| A. Virtual peer | The host stores, per segment, the blocks **plus** the Merkle nodes and the signed tree head. The viewer runs an in-process object that speaks the replication protocol to its own replica and answers requests from contract bytes. | Depends on Hypercore 11 internals and on proof formats that are not a public storage format; version-fragile. |
| B. Neutral segments | Drop A-11 on the viewer: `HistoryHandle.fetch` returns decrypted packets from segments, and playback reads a segment store, not a Hypercore. | Touches `engine/index.js` and the player, which the spike kept out of scope (Q-2, `D-02`). It is the abstract-arch §4.3 model. |
| C. Always-on mirror | A machine the host controls holds a replica and serves §8.1. | Not Freenet; an operator burden the product does not have today. |
| D. No offline history | Clear `HISTORY_OFFLINE_HOST` and `HISTORY_EVENTUAL_MERGE` for good. | Freenet then offers nothing over Pear for history. |

Recommendation: ship F1–F7 with option D's capability set, and open option A as a time-boxed probe (F8)
whose failure selects B as its own project. Also not measured and needed by any option: segment
put→notification latency and state size for a long session (abstract-arch §23.8's first two gates).

## 9. ICE servers

`ZBTERM_ICE_SERVERS` is **design only; nothing reads it today** (the stub's comment at
`engine/backends/freenet/index.js::CAPABILITIES` mentions it, no code does).

- Format (*design*): a comma-separated list of ICE URLs, `stun:host:port` and
  `turn:user:secret@host:port`. Read by the **host process**, which owns the peer connections; the Bare
  worker does not reliably inherit the environment (see the comment on
  `engine/backends/freenet/index.js::experimental`). A settings field should mirror it.
- Default: to be decided by the owner. No server at all means host candidates only, which connects on
  one machine or one LAN and nowhere else. A public STUN default makes most NAT pairs work and discloses
  the user's address to that server.
- **No TURN**: ZBTerm operates none (a requirements non-goal) and the design does not assume one.
  Peers behind symmetric NATs, or two peers behind the same carrier-grade NAT without hairpinning, will
  not connect. ICE reaches `failed`; `dial().connected` rejects with `detail:'ice-failed'`;
  `path()` never reports `RELAY`; the `RELAY` capability bit should be set only when a `turn:` URL is
  configured. There is no fallback to contract-carried live output in the follow-on project (abstract-arch
  §23.6's degraded read-only mode is deferred).
- Not measured: anything. Every probe ran on loopback with no ICE server.

  > **2026-09-24 (`260924_freenet-backend` F2).** Measured across the internet with the `D-11` list
  > (Google + Cloudflare STUN): offer → connected p95 2 137 ms (host remote) and 1 301 ms (host here);
  > selected pair IPv4 UDP `srflx`/`prflx` ↔ public `host`, never IPv6, Tailscale or relay; channel ping
  > RTT p50 63–74 ms. Host candidates only also connected (2 of 2) because one end is public. NAT↔NAT not
  > measured. See `../260924_freenet-backend/measurements.md` §6.

  > **2026-09-24 (`260924_freenet-backend` F9).** Correction to "design only; nothing reads it today":
  > the host process reads it now (`electron/ice-servers.js`): a non-empty "STUN/TURN servers" setting
  > (renderer settings menu, pushed through the preload's `app.setIceServers`) wins over
  > `--ice-servers`, which wins over `ZBTERM_ICE_SERVERS`, which wins over the `D-11` default; an empty
  > flag or variable means no server (host candidates only). The main process applies the list to its
  > `RtcHost` and sends it to the core (`share.setIceServers`), so every new peer connection gets it;
  > `describe()` claims `RELAY` only with a `turn:` URL and `diagnostics().ice` lists the servers
  > without credentials. The README states the disclosure to the STUN provider.

## 10. Node lifecycle (A-5)

The spike assumed a node that is already running and deferred spawning, bundling and supervising it
(A-5; also a requirements non-goal). The design keeps that for the first release:

| Concern | Design |
|---|---|
| Locate | `ws://127.0.0.1:7509/v1/contract/command` by default, overridable by a setting. Measured: WS open 37–38 ms under Node, 13–15 ms under Bare. |
| Mode | Production needs a **network-mode** node: a local-mode node reaches no other machine. Tests need a **local-mode** node on its own port with its own data directory, stopped by pid, exactly as B8 did (`S-04`). The adapter cannot tell the modes apart through the SDK; a `Get`-miss that never answers is a local-mode symptom (`S-05`(c)). |
| Health | WS open, a version query if the node offers one, and the RTT of a `Get` on an announced instance. Surfaced by `health()` and `diagnostics().node`. |
| Version pin | The adapter records the node versions it was tested against (today: 0.2.135 with SDK 0.4.0, where `S-05` holds) and reports `broken` with a detail outside that set. The `S-05` workarounds are version-specific and must be re-probed on every bump. |
| Exit code 42 | A spawned node exits with 42 to request an update. It matters only once ZBTerm spawns the node: the supervisor must treat 42 as "re-exec the updated binary", not as a crash, and must not count it toward a crash-loop limit. Not measured; deferred with the rest of supervision. |
| No node | `start()` rejects `E_BACKEND_UNAVAILABLE`; `share.backends` keeps listing `freenet` so the UI can say why (R-8's "does not silently hide sharing"). |

## 11. Licence

From `requirements.md` §2.3 and the sources in `QnA_assumptions.md`: talking to an **unmodified** node
over its WebSocket does not trigger the node's AGPL. The npm package `@freenetorg/freenet-stdlib`
declares `MIT+APACHE-2.0` in its licence field, which contradicts the repository's LGPL-3.0. That
contradiction must be resolved with upstream before the SDK ships inside a ZBTerm package. The
signalling contract links the `freenet-stdlib` crate (0.10.0); its licence terms for a distributed WASM
binary were not checked. `node-datachannel` and libdatachannel licences were not checked either.
`QnA_assumptions.md` also records two unverified research items (the repair-window numbers, and that no
third-party Node.js use of the SDK was found).

> **2026-09-24 (`260924_freenet-backend` F9, `D-15`).** Checked and written down in
> `THIRD-PARTY-NOTICES.md` (repo root, shipped in every package with the Freenet backend): the npm SDK is
> listed under both declarations and distributed under LGPL-3.0, unmodified in its own folder;
> `node-datachannel` 0.33.4 and libdatachannel v0.24.5 are MPL-2.0, and the binary also carries
> libjuice (MPL-2.0), usrsctp (BSD-3-Clause) and OpenSSL 1.1.1w (identified from its build strings).
> The `freenet-stdlib` crate 0.10.0 linked into both contracts declares **`LGPL-3.0-only`** (static
> linking into the WASM; the contracts' source and build script are in the repository);
> `ed25519-compact` 2.4.2 is MIT; the rest of the crate graph is permissive (`cargo tree`). The
> upstream issue is drafted in `../260924_freenet-backend/upstream-licence-issue.md`, not filed
> (`A-13`: the owner files it).

## 12. Phases for the follow-on project

> **2026-09-24.** This table became the executable plan
> [`../260924_freenet-backend/plan.md`](../260924_freenet-backend/plan.md) after the owner's answers
> (`D-09`…`D-15`). Mapping: F0 → `F2` (with `F1` building the second node by recipe), F1 → `F3`,
> F2 → `F4` (the `tabby-plugin` host is archived and dropped), F3 → `F5`, F4 → `F6`, F5 → `F7`,
> F6 → `F8`, F7 → `F9` (plus the default build `pear,freenet` and the licence notices), F8 → `F10`,
> F9 → **out** (`D-12`). §9's default is decided: `D-11`. §8.2's recommendation is taken: `D-13`.

Starting point, already in the tree: the stub `engine/backends/freenet/index.js::FreenetBackend` with
the full member set; the registry's `availability()` hook (`engine/backends/index.js::load`) and the
`ZBTERM_FREENET_EXPERIMENTAL=1` switch; build variants that include or drop
`engine/backends/freenet/` (`forge.config.js`, `ZBTERM_BUILD_BACKENDS`); the conformance suite
`test/backends/conformance.js::run`; and the spikes (`spikes/freenet/lib/fnet.js`, `lib/blake3.js`,
`lib/bare-shims.js`, `lib/rtc.js`, `p6.js`, `contracts/signalling/`).

| Phase | Goal | Acceptance |
|---|---|---|
| F0 | Close the measurement gaps that can overturn this design: two **network-mode** nodes on two hosts; put→notification and offer→connected between them; the same through one STUN server across two NATs. Needs the owner's consent to `Put` on the public network (`S-04`). | p50 / p95 recorded; offer→connected under 10 s, or the P-4 signal fires and the host pre-publishes its offer at `createLink`. |
| F1 | Contract client in the worker: move `fnet.js`, the BLAKE3 and the Bare shims into `engine/backends/freenet/` with the `S-05` workarounds; `start`, `stop`, `health`, `localPeerKey`, `routeFor`, the node-version pin. | Runs under pear-runtime's Bare and under Node against a local-mode node; `test/backend-boundary.test.js` still passes; `start` with no node rejects `E_BACKEND_UNAVAILABLE`. |
| F2 | The seam: `BACKEND_*` frame kinds and codecs appended in `engine/rpc/schema.js`; an `rtcHost` adapter on node-datachannel for `electron/engine-lifecycle.js` and `tabby-plugin/src/main/host.ts`; host-capability reporting. | `docs/CORE-CONTRACT.md` rows added and `test/core-contract.test.js` green; kinds 0–14 unchanged; a loopback channel echoes binary frames worker→host→host→worker; pipe throughput measured. |
| F3 | Production signalling contract: signed entries, per-key quota, reserved host share, canonical form; frozen WASM artefact and hash list; pointer-record contract. | `fdev verify-merge` with 0 violations for both contracts; key reproducible on a second host and toolchain, or the failure recorded; signature-verification cost measured. |
| F4 | `announce`, `withdraw`, `dial`, `'connection'`, the §6 handshake. | Negative tests: a tampered fingerprint, a wrong-key answer and a replayed answer all fail to surface a connection. `AUTHENTICATED_PEER` claimed only if they do. |
| F5 | Channels and admission: `openChannel` / `onChannel`, fragmentation, `BACKEND_FLOW`, `setAdmission`, per-link limits. | The conformance suite's channel, back-pressure (10 000-message burst) and admission cases pass on Freenet. |
| F6 | Live history per §8.1. | Conformance history cases pass; ≥ 1 MiB/s measured through the seam, with no stall at the message cap. |
| F7 | Full conformance and product wiring: `test/backends/conformance-freenet.test.js`; a ShareManager join end to end; `availability()` reports the truth without the experimental flag; ICE-server setting; diagnostics; UI strings for "no node" and "ice-failed". | All conformance cases green on a local-mode node; a share between two machines shown once through uisolate; `README.md` documents `ZBTERM_ICE_SERVERS` only now. |
| F8 | Time-boxed probe of §8.2 option A (virtual peer feeding a read-only replica). | A replica filled from stored bytes verifies and plays back, or the failure is recorded and option B is opened as its own project. |
| F9 | Node lifecycle beyond "locate": spawn, supervise, exit code 42, update. Optional; reverses A-5. | Decided by the owner before it starts. |

F0 comes first because its result can change F4 (pre-published offers) and because it is the only phase
that needs a decision the executor cannot take: writing to the public network.

> **2026-09-24 (`260924_freenet-backend` F11, close-out) — which phases landed.** Design F0–F8 landed
> as that project's `F2`–`F10`; design F9 (node lifecycle) stayed out (`D-12`). F0 → `F2`: two
> network-mode nodes measured (`S-04` closed); offer→connected p50/p95 1 691 / 2 137 ms, so the P-4
> signal did not fire and offers are not pre-published; NAT↔NAT was not measured. F1 → `F3`: the
> contract client runs in the worker under Bare and Node; the §10 version pin was **not** built
> (`diagnostics().node.version` is `null`). F2 → `F4`: kinds 15–21 appended, `electron/rtc-host.js`
> is the only host adapter (the Tabby host was dropped with the archived plugin). F3 → `F5`,
> F4 → `F6`, F5 → `F7`, F6 → `F8` (≥ 1 MiB/s through the seam; lowest recorded 13.95 MiB/s), F7 →
> `F9` (plus the default build `pear,freenet`, `D-14`, and the notices, `D-15`), F8 → `F10` (option
> A works, `S-28`, a follow-on). Rows of this design that changed while building, each with its own
> dated blockquote above: §1 caveat 1 (network hop measured); §3.1 (pipe cost measured); §4 (`announce`
> / `withdraw` / `dial` / `'connection'` as built, channels and flow, live history as built, the
> dialer's candidate hold and the bootstrap-channel gate of `S-26`); §5 (route shape as built), §5.1
> (verify order and error codes), §5.2 (one pointer per link, params `{ host, n }`, reproducible keys
> after the path remap); §6 (entries signed over the instance's parameter bytes, not canonical JSON;
> the handshake as built, node-datachannel refusing a tampered certificate itself); §7 (layers 2–3 in
> the contract, layer 4 in the worker with `MAX_ANSWERS_PER_MINUTE` 30, `MAX_HALF_OPEN` 8 and, since
> `S-22`, `HALF_OPEN_TIMEOUT_MS` 15 000 and 2 slots per viewer key); §8.1 (measured through the pipe);
> §8.2 (option A works); §9 (the ICE list measured and wired, `D-11`); §11 (notices written, upstream
> issue drafted, not filed). Revocation got its own decision, `D-16`. What stays open is in
> [`../260924_freenet-backend/open-issues.md`](../260924_freenet-backend/open-issues.md).
