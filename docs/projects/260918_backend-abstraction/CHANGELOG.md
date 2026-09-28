# Backend abstraction spike — changelog

Retired phases, cut verbatim from [`plan.md`](plan.md), each with its handoff note and verification output.

---

## Phase B0: Baseline

**Goal.** `baseline.md` exists and states exactly what is green and what is installed on this
machine, before any code changes.

**Requirements & inputs.** `package.json` scripts; `test/`; `requirements.md` §2.2.

**Steps.**
1. Run `npm test`. Record total tests, asserts, and every failing test id.
2. Count tests per file for `test/share-manager.test.js`,
   `test/share-manager-network.test.js`, `test/identity-handshake.test.js`. List the tests in
   `test/share-manager.test.js` that touch `_createSwarm`, `_hostSwarm`, `_pinHost`,
   `_unpinHost`, `_relayThrough`, `_registryLookup`, `_registryDht`, `_socketPeers`,
   `_socketReplicated`, `_handleHostConnection`, `_handleViewerConnection`.
3. Record versions: `node -v`; installed `electron`, `hyperswarm`, `hyperdht`, `hypercore`,
   `protomux`, `pear-runtime`; `freenet --version`; `fdev --version`; `cargo --version`;
   `rustup target list --installed`.
4. Record whether a Freenet node answers on `127.0.0.1:7509`.
5. Run `npm run lint` and record the result.

**Acceptance.** `baseline.md` has all of the above with the commands used. No file outside the
project directory changed.

**Verification.** `git status --short` lists only `docs/` paths. `baseline.md` states a test
count and a failing-id list (which may be empty).

**Gotchas.** `pretest` runs `scripts/vendor-assets.js`, which writes `renderer/vendor/`; that
directory is expected to be ignored or unchanged.

**Re-planning signals.** `npm test` is red for reasons unrelated to sharing: record each as an
`S-nn` and carry the failing ids as the baseline. `wasm32-unknown-unknown` absent: B8 starts
by installing it and says so.

#### Handoff note

### B0
- **Decisions:** none. No ledger rows added.
- **Gotchas hit:** `~/.local/bin` and `~/.cargo/bin` are not on `PATH` in agent shells; prepend them. `npm test` takes 90–115 s. Lint prints 112 `require-await` warnings and exits 0; judge it by exit code and by that warning count not rising. Pear privates in `test/share-manager-network.test.js` and `test/identity-handshake.test.js` are reached through the helpers `useTestnet` and `viewerHarness`.
- **Measured:** 277 tests / 1533 asserts, all pass (supersedes 243 / 1268). 11 of 21 tests in `test/share-manager.test.js` touch a Pear private; both network tests and 3 identity-handshake tests do so through helpers; `_socketReplicated` is touched by no test. electron 40.10.1, hyperswarm 4.17.0, hyperdht 6.32.0, hypercore 11.33.5, protomux 3.11.0, pear-runtime 1.1.4, brittle 4.0.2; freenet 0.2.135, fdev 0.3.297, cargo 1.95.0. `wasm32-unknown-unknown` is **absent**. A Freenet node already listens on `127.0.0.1:7509` (HTTP 200); the WebSocket endpoint was not exercised.
- **Files touched:** `baseline.md` (new).
- **Next free:** `S-01`, `D-04`. **Suite:** 277 / 1533.

#### Verification output (retired 2026-09-18)

```
$ git status --short
 M docs/abstract-arch.md
?? docs/decisions.md
?? docs/projects/
?? docs/register.md

$ npm test   (re-run by the orchestrator)
1..277
# tests = 277/277 pass
# asserts = 1533/1533 pass
# time = 88294.873514ms

# ok

$ npm run lint
All matched files use Prettier code style!
112 warnings   (all require-await; exit 0)
```

---

## Phase B1: Characterisation tests and the invite codec

**Goal.** Today's externally visible share behaviour is pinned by goldens, and the invite codec
lives in `engine/invite.js` with v2 decoding.

**Requirements & inputs.** R-5, A-7. `engine/share-manager.js::encodeLink`, `::decodeLink`,
constant `LINK_PREFIX`; `engine/index.js` (uses of `decodeLink`);
`engine/identity/claim.js`; `test/share-manager.test.js` for mock patterns;
`engine/errors.js::CODES`.

**Steps.**
1. Add `test/share-manager-seam.test.js` with goldens for: `encodeLink` output for a fixed
   payload; the key set of `ShareManager::diagnostics()`; the order of host `debug` events for
   an auto-join over a real Protomux pair; the identity-challenge signed bytes for fixed keys.
2. Create `engine/invite.js` exporting `LINK_PREFIX`, `encodeLink`, `decodeLink`. `decodeLink`
   returns the normalised shape `{v, b, linkId, peer, route, claim}` **and** keeps the v1
   fields `topic` and `hostDhtKey` on the result. A v1 payload normalises to `b:'pear'`,
   `peer: hostDhtKey`, `route:{topic}`. The mandatory 32-byte-hex check on the host key stays.
3. `encodeLink` emits the v1 shape. With `ZBTERM_INVITE_V2=1` it emits v2 **plus** the v1
   fields.
4. `engine/share-manager.js` requires the codec from `engine/invite.js` and re-exports the same
   names.
5. Add `E_BACKEND_UNSUPPORTED` and `E_BACKEND_UNAVAILABLE` to `engine/errors.js::CODES`. Nothing
   raises them yet.
6. Add codec tests: v1 round trip, v2 round trip, v1→normalised, bad host key rejected.

**Acceptance.** All earlier tests pass unmodified. The new goldens pass. No other file in
`engine/` defines `LINK_PREFIX`.

**Verification.** `npm test` → baseline count plus the new tests, zero new failures.
`grep -rn "zbterm://join/" engine/` → only `engine/invite.js`.

**Gotchas.** `renderer/app.js` and `tabby-plugin/src/services/share.service.ts` carry their
own `LINK_PREFIX`; leave them. `test/core-contract.test.js` may scan error codes; if it does,
document the two new codes in `docs/CORE-CONTRACT.md`.

**Re-planning signals.** An existing test asserts the exact decoded object shape and breaks on
the extra fields: keep v1 decode output byte-identical and return the normalised view from a
second function `normaliseInvite()`; B6 uses that function.

#### Handoff note

### B1
- **Decisions:** `engine/invite.js::decodeLink` returns `{...payload, b, peer, route, claim, topic, hostDhtKey}`; `b` defaults to `'pear'`; `normaliseInvite()` was not needed. Beyond the spec, it rejects (`E_AUTH`) a link whose `hostDhtKey`/`peer` or `topic`/`route.topic` disagree. `ZBTERM_INVITE_V2` is read at call time. No `D-nn` added.
- **Gotchas hit:** today's invites already carry `v: 2` (from `engine/schema.js::VERSION`), so `v` cannot tell the shapes apart (`S-01`); never branch on `v`, branch on which fields are present. `decodeLink` still requires a `topic` for every `b`; B6 must relax that to `b === 'pear'` when it raises `E_BACKEND_UNSUPPORTED`. `async () => {}` mocks add `require-await` warnings; use `() => Promise.resolve(x)`. `test/core-contract.test.js` does not scan error codes.
- **Measured:** 286 tests / 1580 asserts (+9 / +47). Lint exit 0, 112 warnings. Golden host debug order for an auto-join without a claim: `host:socket:connection`, `host:ctl:open`, `host:ctl:message`, `host:join-request`, `host:join-confirm`, `host:bootstrap:sent`.
- **Files touched:** `engine/invite.js` (new), `engine/share-manager.js`, `engine/errors.js`, `test/share-manager-seam.test.js` (new; it drives `_handleHostConnection`, `_linkIndex` and `hostShares`, so B3 must keep a shim for it and B4 retargets it), `docs/register.md` (`S-01`).
- **Next free:** `S-02`, `D-04`. **Suite:** 286 / 1580.

#### Verification output (retired 2026-09-18)

```
$ npm test   (re-run by the orchestrator)
1..286
# tests = 286/286 pass
# asserts = 1580/1580 pass
# ok

$ grep -rn "zbterm://join/" engine/
engine/invite.js:13:const LINK_PREFIX = 'zbterm://join/'

$ git diff --stat -- test/
(empty: no existing test changed; test/share-manager-seam.test.js is new)

$ npm run lint
112 warnings   (exit 0)
```

---

## Phase B2: Transport keypair without hyperdht

**Goal.** `engine/crypto.js` and `engine/account-store.js` no longer require `hyperdht`. Stored
keys are unchanged.

**Requirements & inputs.** R-4. `engine/crypto.js::loadOrCreateLocalDevice` (two
`HyperDHT.keyPair()` calls); `engine/account-store.js::AccountStore::createUser` (one);
`node_modules/hyperdht/lib/crypto.js::createKeyPair` as the reference.

**Steps.**
1. Add `engine/crypto.js::transportKeyPair(seed?)`: `crypto_sign_seed_keypair` when a seed is
   given, else `crypto_sign_keypair`. Return `{publicKey, secretKey}` as buffers of 32 and 64
   bytes.
2. Replace the three `HyperDHT.keyPair()` calls. Remove the `hyperdht` requires from both files.
3. Add a test: for a fixed 32-byte seed, `transportKeyPair(seed)` equals
   `require('hyperdht').keyPair(seed)` in both fields.

**Acceptance.** `grep -n "hyperdht" engine/crypto.js engine/account-store.js` is empty.
Profiles created before this phase still load.

**Verification.** `npm test` green at the B1 count plus one. `npx brittle-node
test/crypto.test.js test/account-store.test.js` green.

**Gotchas.** Use the same sodium allocation pattern the files already use. Do not rename the
stored fields `dhtPublicKey` / `dhtSecretKey`.

**Re-planning signals.** The seed-equality test fails: hyperdht derives keys differently from
the reference read on 2026-09-18. Stop, record an `S-nn`, and keep `hyperdht` behind a
`engine/backends/pear/`-owned key factory; B6's boundary rule then needs an exception.

#### Handoff note

### B2
- **Decisions:** `engine/crypto.js::transportKeyPair(seed?)` added and exported; `engine/account-store.js` imports it from `./crypto` (no cycle). No ledger rows.
- **Gotchas hit:** a comment containing the word "hyperdht" trips the acceptance grep; the comment says "the Pear DHT keyPair(seed)". The equality test requires `hyperdht` inline in `test/crypto.test.js`, which is test code and outside the `engine/` boundary.
- **Measured:** seed equality with `hyperdht.keyPair(seed)` holds in both fields. 287 tests / 1587 asserts (+1 / +7). Lint exit 0, 112 warnings.
- **Files touched:** `engine/crypto.js`, `engine/account-store.js`, `test/crypto.test.js`.
- **Next free:** `S-02`, `D-04`. **Suite:** 287 / 1587.

#### Verification output (retired 2026-09-18)

```
$ grep -n "hyperdht" engine/crypto.js engine/account-store.js
(empty)

$ npx brittle-node test/crypto.test.js test/account-store.test.js   (subagent)
# tests = 11/11 pass
# asserts = 49/49 pass

$ npm test   (re-run by the orchestrator)
# tests = 287/287 pass
# asserts = 1587/1587 pass
# ok

$ npm run lint
112 warnings   (exit 0)
```

---

## Phase B3: Extract PearBackend behind the interface

**Goal.** `engine/backends/types.js` defines the interface. `engine/backends/pear/` implements
it with today's code. `ShareManager` uses it through the interface only, and every existing
test passes **unmodified**.

**Requirements & inputs.** R-1, R-2, R-3, A-3, A-10, A-11. `engine/share-manager.js` (whole
file); `engine/index.js::_scheduleRemoteHistoryDownload`; `engine/session-store.js`
(`log`, `metaCore`); `docs/abstract-arch.md` §10.1, §14, §16, §17.

> **2026-09-18 (B1).** `test/share-manager-seam.test.js` (new in B1) drives
> `_handleHostConnection`, `_linkIndex` and `hostShares`. It counts as an existing test: it
> passes unmodified in B3, so step 6 keeps a shim for it, and B4 retargets it.

**Steps.**
1. Write `engine/backends/types.js`: the `CAP` constants, JSDoc typedefs for every member in
   R-1, and `assertBackend(obj)` which throws naming the first missing member.
2. Create `engine/backends/pear/index.js::PearBackend` (an `EventEmitter`) and move into it:
   the `hyperswarm`, `hyperdht`, `protomux` requires; `_createSwarm`; `_ensureSwarm` with the
   union firewall; connection routing by remote key; `_pinHost`/`_unpinHost`; `_relayThrough`,
   `RELAY_FALLBACK_MS`, `_registryLookup`, `_ensureRegistryDht`, `REGISTRY_PUBLIC_KEY`,
   `ZBTERM_RELAY_PUBLIC_KEY` handling; topic announce and flush; the viewer dial including
   reuse of an existing socket; `_socketReplicated`; `swarmDiagnostics`; swarm teardown.
3. `PearConnection` wraps one socket and holds `Protomux.from(socket)` privately.
   `openChannel`/`onChannel` map to `mux.createChannel`/`mux.pair` with a `c.json` message.
   `serveHistory`/`attachHistory` call `store.log.replicate(mux)` and
   `store.metaCore.replicate(mux)`, idempotent per connection and session.
   `HistoryHandle.fetch` wraps `store.log.download({start, end, linear: true})`.
4. `dial` pins the expected key **synchronously, before** the swarm is ensured and before
   `joinPeer`. Keep the existing comment about the firewall blocking outbound dials.
5. In `ShareManager`, replace `peer.socket`/`peer.mux` with `peer.conn`,
   `socket.remotePublicKey` with `conn.remotePeerKey`, and `socket.destroyed` with
   `conn.closed`. Construct `new PearBackend()` unconditionally for now.
6. Keep forwarding shims on `ShareManager` for every private the tests touch (the B0 list),
   each marked `// TEMPORARY(until B4)`.
7. Feed the identity challenge from `backend.localPeerKey()` and `conn.remotePeerKey`.

**Acceptance.** `grep -n "require('hyperswarm')\|require('hyperdht')\|require('protomux')"
engine/share-manager.js` is empty. No test file changed in this phase. B1 goldens unchanged.

**Verification.** `npm test` green at the B2 count. `git diff --stat -- test/` is empty.

**Gotchas.** Hyperswarm dedupes to one socket per remote keypair, so one `PearConnection` can
carry several links in both roles; `'connection'` fires once per socket. Protomux does not
await handlers, so the viewer message queue stays in ShareManager. Identity frames bypass that
queue today; keep that.

**Re-planning signals.** A shim cannot forward because a test mutates swarm internals in
place: move that one test to B4's file now and note it. ShareManager needs the mux for anything
other than channels and history: the interface is missing a member; add it to R-1 with a dated
blockquote before continuing.

#### Handoff note

### B3
- **Decisions:** no `D-nn`. `dial(route, expectedPeerKey, opts)` pins synchronously, reuses a warm socket and returns `{connected, cancel}`; the viewer side is driven by `dial().connected`, the host side by `'connection'` (once per socket). `announce(linkId, {route, tag})` takes a route minted earlier by `routeFor(linkId, null)`; `withdraw` exists but ShareManager does not call it yet. `setAdmission` takes a function or a boolean; the backend also admits any pinned key. `openChannel` returns one object with `send`, `close` and replaceable `onmessage`/`onclose`. `serveHistory`/`attachHistory` are idempotent per connection and store (WeakSet); `attachHistory` returns `{fetch, close}`. Added to R-1 (dated blockquote in `requirements.md`): `PeerConnection.initiator`, `opts.tag`, backend `'debug'` and `'error'` events. `path()` always returns `DIRECT`. `"backends/"` was added to `engine/package.json` `files` here, not in B7.
- **Gotchas hit:** `PearBackend.start()` still starts the relay registry DHT, because an existing test asserts it right after `new ShareManager()`; only the swarm is lazy (`S-02`); B5's "start opens nothing" case must be worded as "opens no swarm and announces nothing". Shims: `_createSwarm`, `_hostSwarm`, `_relayPublicKey` are prototype get/set accessors; `_socketPeers` is a `{get, has}` view over `_connPeers`; `_handleHostConnection`, `_handleViewerConnection`, `_openHostChannel` accept a socket or a conn through `backend._adopt`; `join()` unwraps `conn._socket`/`conn._info` for one test; `_relayThrough(force)` passes `this.joins.values()`. `PearConnection` creates its Protomux lazily. The viewer handler now runs one microtask after the connection event. The `viewer:swarm:flushed` debug event lost its `confirmed` field. ShareManager still reads `route.topic` for the link record and the v1 invite; B6 handles non-Pear routes.
- **Measured:** 287 tests / 1587 asserts; orchestrator's gate run green. One intermittent failure of `test/engine-extend.test.js` assert 17 in the subagent's first run (`S-03`): not reproduced afterwards on either tree. 16 `TEMPORARY(until B4)` markers, all in `engine/share-manager.js`. Lint exit 0, 112 warnings.
- **Files touched:** `engine/backends/types.js`, `engine/backends/pear/index.js`, `engine/backends/pear/connection.js` (new); `engine/share-manager.js`; `engine/package.json`; `docs/register.md` (`S-02`, `S-03`); `requirements.md` (blockquote under R-1).
- **Next free:** `S-08`, `D-04`. **Suite:** 287 / 1587.

### B8 (part one: probes; the phase stays open until the stub lands after B6)
- **Decisions:** no `D-nn`. The node on 7509 is `freenet network`, so a `Put` there publishes publicly (`S-04`): it was used read-only, and every write went to a separate `freenet local --ws-api-port 7519` with data under `spikes/freenet/.node-data`, stopped by pid. The signalling contract keeps its TTL as a parameter and never reads a clock; `validate_state` accepts only the canonical encoding. `rustup target add wasm32-unknown-unknown` was run.
- **Gotchas hit:** SDK 0.4.0: `subscribe()` and a second `Put` never resolve, a local-mode `Get` miss is never answered, notifications carry the whole state (`S-05`). Bare: pear-runtime embeds Bare 1.27.0, so `bare-fs` is pinned to 4.7.1; `@noble/hashes` does not load (a dependency-free BLAKE3 is in `spikes/freenet/lib/blake3.js`); binary data-channel frames arrive zeroed (`S-06`). Hypercore 11.33.5 needs `core.replicate(new NoiseSecretStream(isInitiator, rawDuplex))`, messages ≤ 65 536 bytes and polling of `bufferedAmount` (`S-07`).
- **Measured:** P-2 update→notification p50 36.1 / p95 42.3 ms. P-1 passes under Bare 1.30.3 (38 / 42 ms) and pear-runtime's Bare 1.27.0 (37 / 44 ms). P-5 `verify-merge` 117 cases, 0 violations; key identical across incremental, clean and other-path builds; any source edit moves it. P-4 p50/p95 78.7/87.5 ms at 1 Hz, 45.1/87.2 at 5 Hz, 39.3/44.8 at 20 Hz, 200/200 delivered; offer→connected 114 ms (node-datachannel), 185 ms (@roamhq/wrtc), 2168 ms (werift). P-3: all three load under Node and expose the remote fingerprint; none works under Bare. P-6 (Node, 16 MiB): 12.87 / 11.59 / 1.01 MiB/s. Not measured: network-mode propagation between two nodes, cross-toolchain key stability, P-6 under Bare.
- **Re-planning signals:** P-3 under Bare **fired**: B9 designs the host-process adapter over `BACKEND_*` frames for the WebRTC half, with node-datachannel; the SDK half can stay in the Bare worker. The P-4, P-5 and P-6 signals did not fire; a pointer record is still needed for contract upgrades.
- **Files touched:** `probes.md` (new), `spikes/freenet/**` (new), `docs/register.md` (`S-04`–`S-07`).
- **Next free:** `S-08`, `D-04`. **Suite:** not run by this part.

#### Verification output (retired 2026-09-18)

```
$ grep -n "require('hyperswarm')\|require('hyperdht')\|require('protomux')" engine/share-manager.js
(empty)

$ git diff --stat -- test/
 test/crypto.test.js | 16 ++++++++++++++++     (the B2 change; nothing from B3)
 1 file changed, 16 insertions(+)

$ npm test   (re-run by the orchestrator)
# tests = 287/287 pass
# asserts = 1587/1587 pass
# ok

$ npm test   (subagent, run 1 of 3; runs 2 and 3 were green)
# tests = 286/287 pass
not ok 62 - copyHistoryFrom returns before the copy and keeps history, resize, live output in order
    not ok 17 - then the live output        -> S-03; not reproduced since, see docs/register.md

$ npm run lint
112 warnings   (exit 0)
```

---

## Phase B4: Retarget tests and add the injection seam

**Goal.** The shims are gone. Pear-private tests target `PearBackend` directly. A backend can be
injected into `SessionEngine`.

**Requirements & inputs.** R-1, R-3. The B0 list of Pear-private tests;
`test/share-manager-network.test.js::useTestnet`; `engine/index.js::SessionEngine` constructor
and `::_scheduleRemoteHistoryDownload`; `engine/share-manager.js::_registerViewerRemote`.

> **2026-09-18 (B0).** The list in `baseline.md` §2 is the input: 11 tests in
> `test/share-manager.test.js`, both tests in `test/share-manager-network.test.js` through
> `useTestnet`, and 3 tests in `test/identity-handshake.test.js` through `viewerHarness`
> (which calls `_handleViewerConnection`). Retarget the helper `viewerHarness` as well; its
> tests stay in their file.

**Steps.**
1. Move each Pear-private test to `test/backends/pear-backend.test.js`, constructing
   `PearBackend` directly. Tests that called `_handleHostConnection(socket)` or
   `_handleViewerConnection(state, socket)` now emit a `PearConnection` wrapping the mock
   socket.
2. Point `useTestnet` at the manager's backend.
3. Delete every `TEMPORARY(until B4)` shim.
4. `new ShareManager(engine, {backend})`; `SessionEngine` accepts `opts.shareBackend` (an
   instance or a factory) and defaults to Pear.
5. `_registerViewerRemote` stores `remote.history`; `_scheduleRemoteHistoryDownload` calls
   `remote.history.fetch({start, end})`.

**Acceptance.** Test count ≥ the B3 count. No `TEMPORARY(until B4)` remains. `engine/index.js`
no longer calls `.log.download(` for a remote.

**Verification.** `npm test` green. `grep -rn "TEMPORARY(until B4)" engine/` empty.
`grep -n "log.download" engine/index.js` empty.

**Gotchas.** `test/*.test.js` is the npm glob; `test/backends/` is not matched. Change the
`test` script to `brittle-node test/*.test.js test/backends/*.test.js` and check
`npm run lint` still covers the directory.

**Re-planning signals.** The count drops: a test was lost in the move; find it before
continuing.

#### Handoff note

### B4
- **Decisions:** no `D-nn`. `new ShareManager(engine, {backend})` defaults to `new PearBackend()`; `SessionEngine` accepts `opts.shareBackend` as an instance or a factory `(engine) => backend`. `_handleViewerConnection(state, conn)` lost its `info` parameter and takes debug `client`/`server` from `conn.initiator`. `_handleHostConnection(conn, info)` and `_openHostChannel(share, runtime, conn, id)` take a `PeerConnection` only. `remote.history` is `null` until `_registerViewerRemote` sets it; `_scheduleRemoteHistoryDownload` returns early without it.
- **Gotchas hit:** B0's list was incomplete for the B3 shims: `test/share-manager.test.js` 'host channel close cleans up one peer…', `test/identity-handshake.test.js::hostHarness` and `test/share-manager-seam.test.js::hostHarness` were also retargeted; two `test/engine-session.test.js` tests now attach a real `PearBackend#attachHistory` handle. A pure-backend test calls `backend.start({})` and sets `_relayPublicKey = null` first. Host-side backend tests drive `backend._handleConnection(socket, info)` and read `backend._conns`; the seam test emits `'connection'` on `manager.backend`. `t.exception.all` is needed for native errors. `attachHistory` starts two full-range downloads, so a test that records downloads clears its list after attaching.
- **Measured:** 288 tests / 1595 asserts (+1 / +8); every test name present at HEAD is still present. `test/backends/pear-backend.test.js` holds 12 tests / 72 asserts. Lint exit 0, 112 warnings. `S-03` not seen.
- **Files touched:** `engine/share-manager.js`, `engine/index.js`, `package.json` (`test` script glob), `test/backends/pear-backend.test.js` (new), `test/share-manager.test.js`, `test/share-manager-seam.test.js`, `test/share-manager-network.test.js`, `test/identity-handshake.test.js`, `test/engine-session.test.js`.
- **Next free:** `S-08`, `D-04`. **Suite:** 288 / 1595.

#### Verification output (retired 2026-09-18)

```
$ npm test   (re-run by the orchestrator)
# tests = 288/288 pass
# asserts = 1595/1595 pass
# ok

$ grep -rn "TEMPORARY(until B4)" engine/
(empty)
$ grep -n "log.download" engine/index.js
(empty)
$ comm -23 <test names at HEAD> <test names now>
(empty: no test lost in the move)
$ npm run lint
112 warnings   (exit 0)
```

---

## Phase B5: Loopback backend and the conformance suite

**Goal.** A second, non-Pear implementation passes the same suite as Pear, which proves the
interface is not Pear-shaped.

**Requirements & inputs.** R-11. `engine/backends/types.js`; `engine/backends/pear/index.js`;
`test/share-manager-network.test.js`; `docs/abstract-arch.md` §28.

> **2026-09-18 (B3).** The case "`start` opens nothing" reads "`start` opens no swarm and
> announces nothing": `PearBackend.start()` keeps today's relay-registry DHT lookup (`S-02`).
> `dial` returns `{connected, cancel}`; the suite uses that shape.

**Steps.**
1. `engine/backends/loopback.js`: an in-process hub keyed by route id; channels are paired
   microtask queues; history uses `store.log.replicate(isInitiator, duplexPair)`; one connection
   per dial; no mux, no socket dedupe. It requires only `events`, `b4a` and the stream pair it
   needs.
2. `test/backends/conformance.js` exports `run(name, makePair)` where `makePair` returns
   `{host, viewer, teardown}`. Cases: `start` opens nothing and double `stop` is safe;
   announce→dial connects and each `remotePeerKey` equals the other side's `localPeerKey()`; a
   wrong `expectedPeerKey` never yields a connection; after `withdraw` a new dial fails while an
   existing connection survives; `setAdmission(false)` blocks inbound while a dial-pinned key
   still connects outbound; two channels on one connection are independent; per-channel order
   holds for a 10 000-message burst and `send` returns `false` under backpressure;
   `conn.close` fires each channel's `onclose` once; `serveHistory`/`attachHistory` reach the
   target length and a second `serveHistory` is a no-op; diagnostics are JSON-safe without
   secrets; a full ShareManager auto-join (bootstrap, data, rekey, sealed input).
3. `test/backends/conformance-loopback.test.js` and `conformance-pear.test.js` (Pear over
   `hyperdht/testnet`). Move the two cases from `test/share-manager-network.test.js` into the
   suite and leave that file re-exporting nothing, or delete it if the count is preserved.

**Acceptance.** Both runs pass every case. ShareManager has no `backend.id` comparison.

**Verification.** `npm test` green, count ≥ B4. `grep -n "backend.id\|describe().id"
engine/share-manager.js` empty.

**Gotchas.** Testnet tests need teardown of every swarm or the process hangs. The burst case
must not depend on wall-clock time.

**Re-planning signals.** Loopback needs a mux-like escape hatch, or ShareManager needs to know
which backend it has: stop and redesign the channel or history members before B6, recording a
`D-nn`.

#### Handoff note

### B5
- **Decisions:** `D-04` (orchestrator, against `S-08`): `withdraw` ends discovery, not reachability; the refusal of a join on a revoked link is asserted at ShareManager level on every backend. `makePair()` returns `{host, viewer, create, teardown}` with unstarted backends; `create()` adds a third peer. `LoopbackBackend({hub})` with `LoopbackHub`; its routes are spelled `{topic}` (`TEMPORARY(until B6)`); `CHANNEL_HIGH_WATER = 1024`; `path()` returns `LOCAL`. In the contract now: `'connection'` fires on both the dialing and the accepting side, and `diagnostics().announced` counts announced links. Pear's socket-dedupe assertion lives only in `conformance-pear.test.js`.
- **Gotchas hit:** first dispatch was red on "after withdraw a new dial fails" (Pear still connects by key); re-dispatched once with `D-04`. ShareManager never calls `backend.withdraw`, and at HEAD `revokeLink` never left the topic; left as is, for `open-issues.md`. `S-09`: hyperswarm permanently bans a key its firewall refused, so refused halves use a third peer. `S-10`: `ShareManager#close` leaves pending join timers armed; tests settle `manager.joins` in teardown. Pear's dial resolves before the host's `'connection'`. A Pear re-dial reuses the warm socket. Pear `makePair` stubs `_startRelayRegistryLookup` to stay off the public DHT. Loopback history pipes `core.replicate(isInitiator, {keepAlive:false})` streams; no extra dependency.
- **Measured:** loopback 14/14 cases (104 asserts), Pear 15/15 (107). Both return `false` from `send` during the 10 000-message burst and deliver in order. 315 tests / 1800 asserts. Lint exit 0, **99** warnings (the deleted network test carried 13); 99 is the new ceiling.
- **Files touched:** `engine/backends/loopback.js`, `test/backends/conformance.js`, `test/backends/conformance-loopback.test.js`, `test/backends/conformance-pear.test.js` (new); `engine/backends/pear/index.js`, `engine/backends/types.js`; `test/share-manager-network.test.js` (deleted; both cases live in the suite); `docs/register.md` (`S-08`–`S-10`); `docs/decisions.md` (`D-04` and its correction); `requirements.md` (blockquotes under R-1, R-11).
- **Next free:** `S-11`, `D-05`. **Suite:** 315 / 1800.

#### Verification output (retired 2026-09-18)

```
First dispatch (red, re-dispatched once):
# tests = 312/313 pass
not ok 291 - pear backend conformance: after withdraw a new dial fails while an existing connection survives

After D-04, re-run by the orchestrator:
$ npm test
# tests = 315/315 pass
# asserts = 1800/1800 pass
# ok
$ grep -n "backend.id\|describe().id" engine/share-manager.js
(empty)
$ npm run lint
99 warnings   (exit 0)
```

---

## Phase B6: Registry, selection and introspection

**Goal.** Backends are discovered through a registry. The flag and env var limit them. The
worker receives the limit. `share.backends` reports the result. The "neither" configuration
boots.

**Requirements & inputs.** R-5, R-6, R-7, R-10. `engine/index.js::SessionEngine::invoke`;
`engine/client.js::EngineClient._spawnWorker`; `engine/worker.js`;
`electron/main.js::CLI_OPTIONS`; `electron/engine-client.js`;
`tabby-plugin/src/main/host.ts`; `docs/CORE-CONTRACT.md`; `test/core-contract.test.js`;
`test/core-boundary.test.js`; `engine/invite.js`; `README.md` flag and env tables.

> **2026-09-18 (B1).** `engine/invite.js::decodeLink` requires a `topic` for every invite.
> Step 2 also relaxes that check to `b === 'pear'`, so a non-Pear invite reaches
> `E_BACKEND_UNSUPPORTED` and not `E_AUTH`. Invite `v` is already 2 on today's links (`S-01`):
> branch on the fields present, never on `v`.

**Steps.**
1. `engine/backends/index.js`: `KNOWN = {pear: () => require('./pear'), freenet: () =>
   require('./freenet')}` with literal specifiers; `available()`; `resolve({limit})`;
   `create(id, ctx)`. `MODULE_NOT_FOUND` for the backend or one of its dependencies means
   absent. Any other error means `state:'broken'` with `detail`.
2. ShareManager holds no backend until `_ensureBackend(id)`. `createLink` uses `args.backend`
   or the default. `join` uses the invite's `b`. A different id with shares or joins present
   raises `E_BACKEND_UNAVAILABLE`; with none, stop and swap. An id that is not available raises
   `E_BACKEND_UNSUPPORTED` naming it.
3. `_spawnWorker` appends `this._spawnArgs.backend || ''`. `engine/worker.js` reads
   `Bare.argv[5]` and passes it to `SessionEngine` as the limit.
4. `electron/main.js`: add `--backend <pear|freenet|none>` to `CLI_OPTIONS`; resolve flag, then
   `ZBTERM_BACKEND`, and pass the value to the engine client. The Tabby host reads
   `ZBTERM_BACKEND` only.
5. `invoke`: add `share.backends`; `share.createLink` accepts `backend`; `share.diagnostics`
   gains `backend:{…}` and keeps its top-level keys.
6. Document the method, the argument, the 4th spawn argument and the two error codes in
   `docs/CORE-CONTRACT.md`. Add the flag and env var to `README.md`.
7. Extract the file walker from `test/core-boundary.test.js` to `test/helpers/source-scan.js`.
   Add `test/backend-boundary.test.js` with the four rules in R-10, including the run with
   `Module._resolveFilename` stubbed to fail for `hyperswarm`, `hyperdht` and
   `./pear`.

**Acceptance.** With `ZBTERM_BACKEND=none`, `share.backends` returns an empty list and
`share.createLink` raises `E_BACKEND_UNSUPPORTED`. With no limit, behaviour matches B5.
`core-contract` and both boundary tests are green.

**Verification.** `npm test` green. `npx brittle-node test/backend-boundary.test.js
test/core-contract.test.js` green.

**Gotchas.** The limit must reach the worker as a spawn argument, not an invoke, so nothing can
race it; the worker's environment is not reliably inherited under PearRuntime.
`test/doctor.test.js` may read `share.diagnostics` keys. `protomux` stays installed because
hypercore depends on it; the rule is about `require` sites, not presence.

**Re-planning signals.** `core-contract.test.js` derives its method list in a way the new
method does not satisfy: read the test and follow its marker format exactly.

#### Handoff note

### B6
- **Decisions:** `D-05` (against `S-11`): the registry lists `pear` and `freenet` only; the loopback is never listed and cannot be selected by flag or env. An injected `opts.shareBackend` bypasses the registry and the limit and is active from construction. `LoopbackBackend({routeKey})` makes its route opaque; ShareManager then stores `link.route` and emits a v2 invite. `engine/invite.js` picks the shape from `b`: Pear stays v1, byte-identical; any other `b` is v2. `limitedBy` is the limit value or `null`. Options: `SessionEngine({backendLimit})`, `EngineClient({backend})`, `ShareManager` `opts.registry` / `opts.limit`. A backend module may export a static `availability()` returning `{state, detail}`; the B8 stub uses it for "probe only". Host resolution is `electron/backend-limit.js::resolveBackendLimit`; an unknown value selects nothing and is logged.
- **Gotchas hit:** `S-11`: about twenty inherited call sites read `manager.backend` before any share, so `backend` is a getter that activates the default on first read and `_backend` is the real field; `close`, `diagnostics`, `backendsInfo` read `_backend` and activate nothing. Lazy activation moves Pear's relay-registry lookup from construction to the first share, join, `listLinks` or `backend` read; the effect on the first dial was not measured. `S-12`: under Node 24 a `Module._resolveFilename` stub needs `require.cache` eviction, and all test files share one process. `hostShares` entries are never deleted, so after any share a backend swap needs a restart. `listLinks` returns `uri: null` with no usable backend. Two inherited tests changed because the phase changes what they pin: the `diagnostics()` golden gained the appended `backend` key, and `test/core-boundary.test.js` exempts `./pear` and `./freenet` only when required from `engine/backends/index.js`. R-2's `SEND_INPUT` strip is not implemented; it moves to B8 part two.
- **Measured:** 334 tests / 1938 asserts (+19 / +138). Boundary + contract 8/8. Lint exit 0, **98** warnings (new ceiling). `tabby-plugin` `npm run build` compiled. No `TEMPORARY` marker remains. Electron was not launched; `electron/main.js` was checked by static asserts and `node --check`.
- **Files touched:** new `engine/backends/index.js`, `electron/backend-limit.js`, `test/backend-boundary.test.js`, `test/backends/registry.test.js`, `test/helpers/source-scan.js`, `test/fixtures/backends/*`; edited `engine/share-manager.js`, `engine/invite.js`, `engine/index.js`, `engine/worker.js`, `engine/client.js`, `engine/backends/loopback.js`, `electron/main.js`, `electron/engine-lifecycle.js`, `tabby-plugin/src/main/host.ts`, `test/core-boundary.test.js`, `test/share-manager-seam.test.js`, `docs/CORE-CONTRACT.md`, `README.md`, ledgers (`S-11`, `S-12`, `D-05`), `requirements.md` (blockquote under R-7).
- **Next free:** `S-13`, `D-06`. **Suite:** 334 / 1938.

#### Verification output (retired 2026-09-18)

```
$ npm test   (re-run by the orchestrator)
# tests = 334/334 pass
# asserts = 1938/1938 pass
# ok
$ npx brittle-node test/backend-boundary.test.js test/core-contract.test.js
# tests = 8/8 pass
# asserts = 41/41 pass
# ok
$ npm run lint
98 warnings   (exit 0)
$ grep -rn "TEMPORARY" engine electron test
(empty)
```

---

## Phase B8: Freenet probes

**Goal.** `probes.md` holds measured answers to P-1…P-6, and `engine/backends/freenet/` exists
as a stub that the registry can list.

**Requirements & inputs.** R-13, A-4, A-5, A-6, `D-01`. `spikes/` for existing probe style;
`engine/worker.js` for the Bare shims; `baseline.md` for toolchain facts. A local node started
by hand with `freenet local`.

> **2026-09-18 (B0).** `wasm32-unknown-unknown` is not installed. P-5 starts with
> `rustup target add wasm32-unknown-unknown` and says so in its handoff note. A Freenet node
> already listens on `127.0.0.1:7509`; use it, and neither stop nor restart it.

> **2026-09-18 (orchestrator).** B8 runs in two parts. Steps 1–5 (the probes, which touch only
> `spikes/freenet/` and `probes.md`) run in parallel with B3–B6. Step 6 (the stub) and the
> `npm test` / boundary verification run after B6, because the registry and
> `test/backend-boundary.test.js` do not exist before it. B8 retires after the second part.

> **2026-09-18 (B8 part one).** Steps 1–5 are done; see `probes.md` and the handoff note.
> Inherited facts that proved wrong: the node on 7509 is network-mode, not local (`S-04`), and
> step 5's call is `core.replicate(new NoiseSecretStream(isInitiator, rawDuplex))` (`S-07`).
> Only step 6 and the verification remain.

> **2026-09-18 (B6 gate).** Part two also lands the R-2 rule no earlier phase carried: when the
> chosen backend's `describe().capabilities` lacks `CAP.EPHEMERAL_DELIVERY`, `createLink`
> strips `SEND_INPUT` from the link's caps. Test it with a loopback constructed without that
> capability; no `backend.id` comparison. The stub reports "probe only" through the static
> `availability()` hook that B6 added to the registry contract.

**Steps.**
1. P-2, then P-1: load `@freenetorg/freenet-stdlib` under Node, then under Bare with the
   `engine/worker.js` shims. `Put`, `Get`, `Subscribe` against the local node. Record what had
   to be shimmed.
2. P-5: a Rust signalling contract in `spikes/freenet/contracts/signalling/`: a last-writer-wins
   map keyed by `(linkId, role, seq)` with TTL tombstones. Build to
   `wasm32-unknown-unknown`, run `fdev verify-merge`, build twice and compare contract keys.
3. P-4: put→notification latency p50 and p95 over 200 updates at 1, 5 and 20 Hz; then the full
   offer→answer→connected time.
4. P-3: try `node-datachannel`, `werift`, `@roamhq/wrtc` under Node and under Bare. Record
   which load, and whether the remote DTLS fingerprint is readable.
5. P-6: `hypercore.replicate(isInitiator, stream)` over a data channel wrapped as a duplex with
   length framing. Record throughput for a 16 MiB log.
6. Add `engine/backends/freenet/index.js`: `describe()` with the hybrid capability set from
   R-12, and `start()` rejecting with "probe only" unless `ZBTERM_FREENET_EXPERIMENTAL=1`.

**Acceptance.** Every probe row in `probes.md` has a number or a quoted failure. The stub makes
`share.backends` list `freenet` as `broken`/`probe only` when it is present.

**Verification.** `npm test` green. `npx brittle-node test/backend-boundary.test.js` green.
Each probe has a one-line run command in `probes.md` and its captured output.

**Gotchas.** The SDK correlates responses by contract key: two concurrent `get`s on one key
resolve together. The contract key changes with any WASM change. The WebSocket API on 7509 is
fully privileged; keep it on loopback. Probe dependencies go in `spikes/freenet/package.json`,
never the root manifest.

**Re-planning signals.** P-1 or P-3 fails under Bare after a day of shimming: B9 designs the
host-process adapter over `BACKEND_*` frames. P-4 exceeds 10 s: B9 has the host pre-publish its
offer at `createLink`. P-5 keys are unstable: the pointer record is mandatory and the invite
carries `ptr`. P-6 stalls: B9 designs contract-based history first.

#### Handoff note

### B8 (part two: stub; the phase is complete)
- **Decisions:** no ledger rows. `engine/backends/freenet/index.js` is a stub with the full `assertBackend` shape that requires only `events`, `../../errors` and `../types`. Capabilities: `AUTHENTICATED_PEER`, `MULTIPLEXED_STREAMS`, `ORDERED_STREAM`, `EPHEMERAL_DELIVERY`, `NAT_TRAVERSAL`, `RELAY`, `BROKERED`, `HISTORY_SPARSE_READ`, `HISTORY_HEAD_WATCH`, `HISTORY_EVENTUAL_MERGE`, `HISTORY_OFFLINE_HOST`; no `DIRECT_DIAL`, no `PATH_MIGRATION`. Static `availability()` is `broken` / `probe only` unless `ZBTERM_FREENET_EXPERIMENTAL=1`, read at call time; where the Bare worker does not inherit env it stays probe only. `start()` rejects with `E_BACKEND_UNAVAILABLE`. R-2 landed: `createLink` clears `SEND_INPUT` when `describe().capabilities` lacks `CAP.EPHEMERAL_DELIVERY`, by capability only.
- **Gotchas hit:** Freenet is now listed (as broken) in every tree that carries the stub, so B7's gating must treat "no **available** backend" as the empty case, not "empty list". Assertions that pinned Freenet's absence were updated in `test/backends/registry.test.js` (three id lists, test 1) and `test/backend-boundary.test.js` (the Pear-unresolvable run now sees `[freenet, broken, probe only]`). `S-12` again: evict the real `./freenet` before a fixture stub. `engine/share-manager.js::_backendIdOf` read `backend.describe().id` for reporting and the invite's `b`, which tripped the acceptance grep; it was respelled with a destructure. It is a read, not a comparison: no behaviour branches on it. The engine does read `process.env` in several places; only the backend limit travels by argv. With the experimental flag and limit `freenet`, `createLink` would throw at `routeFor` after the `hostShares` entry is made; not exercised, left for `open-issues.md`.
- **Measured:** 337 tests / 1975 asserts (+3 / +37). Boundary 5/5. Lint exit 0, 98 warnings.
- **Files touched:** `engine/backends/freenet/index.js` (new), `engine/share-manager.js`, `test/backends/registry.test.js`, `test/backend-boundary.test.js`.
- **Next free:** `S-13`, `D-06`. **Suite:** 337 / 1975.

#### Verification output (retired 2026-09-18)

```
Part one: every probe's run command and captured output are in probes.md and spikes/freenet/out/*.txt.

Part two, re-run by the orchestrator:
$ npm test
# tests = 337/337 pass
# asserts = 1975/1975 pass
# ok
$ npx brittle-node test/backend-boundary.test.js   (subagent)
# tests = 5/5 pass
# asserts = 16/16 pass
$ npm run lint
98 warnings   (exit 0)
$ grep -n "backend.id\|describe().id" engine/share-manager.js
(empty; see the note on _backendIdOf)
```

---

## Phase B7: Build variants and UI gating

**Goal.** One env var produces a package with the chosen backends. The UI hides sharing when
there are none and offers a picker when there are several.

**Requirements & inputs.** R-8, R-9, A-6, A-8, A-9. `forge.config.js` (`packagerConfig`, hook
`readPackageJson`); `package.json`; `engine/package.json` (`files`); `renderer/app.js`
(`els`, `shareSession`, `joinSharedSession`, `showShareWizard`, `shareOptionsForm`, the
session-editor share box, the expression that sets `els.shareSession.hidden`);
`renderer/index.html` (`#shareSession`, `#joinLink`, `#inputMode`);
`electron/main.js::handleDeepLink`;
`tabby-plugin/src/services/share.service.ts::ZBTermShareService`;
`tabby-plugin/src/providers/toolbar.provider.ts::ZBTermToolbarButtonProvider`;
`test/renderer-static.test.js`.

> **2026-09-18 (B3).** `"backends/"` is already in `engine/package.json` `files` (B3 added it
> when the code moved). Step 2 only checks it.

> **2026-09-18 (B8).** The Freenet stub is listed as `broken` / `probe only` in every tree that
> carries it. "Empty list" in steps 3–5 therefore reads "no backend with `state: 'available'`".
> The "Sharing unavailable: <detail>" message is shown only when `zbtermBackends` names a
> broken backend **and** no backend is available. The picker counts available backends only.
> The default build variant stays `pear` (A-6), which excludes `engine/backends/freenet/`.

**Steps.**
1. `forge.config.js`: read `ZBTERM_BUILD_BACKENDS` (default `pear`). `packagerConfig.ignore`
   becomes a function that also excludes `engine/backends/<absent>/`. `readPackageJson` removes
   the absent variant's dependencies and sets `packageJson.zbtermBackends`.
2. Move `hyperswarm` and `hyperdht` to `optionalDependencies` in `package.json` and
   `engine/package.json`. Add `"backends/"` to `engine/package.json` `files`.
3. Renderer: call `share.backends` once after the engine is ready and cache it. With an empty
   list hide `els.shareSession`, `els.joinLink`, `els.inputMode` and the session-editor share
   box. With more than one, add a backend radio group at the top of `showShareWizard`, disabled
   when `active` is set. If `zbtermBackends` names a backend whose `state` is `broken`, show
   "Sharing unavailable: <detail>".
4. `handleDeepLink`: with no backend, show a toast and do not invoke `share.join`.
5. Tabby: `ZBTermShareService.backends()`; the toolbar provider omits the share items and
   "Join a shared session…" when the list is empty, and offers the choice when it has several.
6. Add the build variable to `README.md`.

**Acceptance.** `ZBTERM_BUILD_BACKENDS=none npx electron-forge package` yields an app
directory without `engine/backends/pear/` and without `hyperswarm`. Launched under uisolate
with `--backend none`, a screenshot shows no Share and no Join control. The default build is
unchanged.

> **2026-09-18 (B7 gate).** "and without `hyperswarm`" contradicts `D-02`, which the project
> owner signed: the OTA updater stays in every build, `workers/main.js` requires `hyperswarm`
> directly and `pear-runtime` depends on it (`S-13`). The criterion as written cannot be met
> without breaking the updater, so it is **not met and is carried as a named exception for the
> owner's sign-off** in `open-issues.md`. What holds instead, and was verified: the `none`
> package has no `engine/backends/pear/`, no `hyperswarm`/`hyperdht` entry in its
> `package.json`, no `require` site for them outside the updater, and answers `share.backends`
> with an empty list. The `find` glob is `-path '*engine/backends/pear*'` (`S-14`: `test/`
> ships). Packages were written to a scratch `outDir`, never to the repo's `out/`.

**Verification.** `npm test` green. `npm run lint` green. In `tabby-plugin/`,
`npm run build` succeeds. `find out -path '*backends/pear*'` is empty for the `none` build.
A uisolate screenshot for each of `--backend none` and the default.

**Gotchas.** CI's install job forbids `--omit=optional`; the default install must still bring
in hyperswarm. `electron-forge-plugin-prune-prebuilds` runs after the hook. Toolbar buttons in
Tabby snapshot `icon` and `title` once; the menu is rebuilt per click, so gate inside the menu
builder.

**Re-planning signals.** Forge resolves dependencies before `readPackageJson` runs, so removed
deps still ship: switch to pruning in a `packageAfterPrune` hook and record a `D-nn`.

#### Handoff note

### B7
- **Decisions:** no `D-nn`. `forge.config.js` reads `ZBTERM_BUILD_BACKENDS` when a hook runs; an unknown id fails the build; `zbtermBackends` is written in registry order. New `ZBTERM_FORGE_OUT_DIR` sets Forge's `outDir` (default `out`). Renderer: `share.backends` is fetched once after `ping` into `state.shareBackends`; a `null` answer (old core) gates nothing; gating uses `body.sharing-unavailable` plus `hidden`; the picker is a radio `fieldset` in `showShareWizard`'s choose step; new `app:toast` event and `showToast`. `handleDeepLink` asks `share.backends` first. Tabby: `ZBTermShareService.backends()` cached on sidecar `ready`; getters `usableBackends`, `sharingAvailable`, `activeBackend`, `sharingUnavailableDetail`; all gating inside `buildMenu`.
- **Gotchas hit:** **named exception, awaiting the owner's sign-off:** the `none` package still ships `hyperswarm` and `hyperdht`, because `D-02` keeps the OTA updater and `workers/main.js` and `pear-runtime` need them (`S-13`). `S-14`: `test/`, `docs/`, `spikes/` (280 MB) and `tabby-plugin/` (451 MB) ship in every package, so the `none` check uses `-path '*engine/backends/pear*'`. An `ignore` function replaces Forge's and the packager's default ignores, so the config repeats them. Not exercised in a running app, static tests only: `handleDeepLink` (reachable only through macOS `open-url`) and the several-backends picker (no build has two usable backends). uisolate: pass `--ozone-platform=x11` in the `=` form; `/health` says "WebGL2 not supported" though the UI renders. Cosmetic: with no backend, "+ New" stays half-width.
- **Measured:** 347 tests / 2053 asserts (+10 / +78). Lint exit 0, 98 warnings. Both Tabby bundles compiled. `npm ls` still shows hyperswarm 4.17.0 and hyperdht 6.32.0 after the move to `optionalDependencies`. The `none` and default packages differ by exactly `engine/backends/pear/{index,connection}.js` and `package.json`. Screenshots seen by the orchestrator: `--backend none` shows no Share, no Local, no Join; the default shows all three. The repo's `out/` is untouched (newest entry 2026-07-18).
- **Files touched:** `forge.config.js`, `package.json`, `engine/package.json`, `package-lock.json`, `renderer/app.js`, `renderer/index.html`, `electron/main.js`, `tabby-plugin/src/services/share.service.ts`, `tabby-plugin/src/providers/toolbar.provider.ts`, `test/build-variants.test.js` (new), `test/renderer-static.test.js`, `README.md`, `docs/register.md` (`S-13`, `S-14`), `requirements.md` (blockquote under R-8), `shots/b7-backend-{none,default}.png`.
- **Next free:** `S-15`, `D-06`. **Suite:** 347 / 2053.

#### Verification output (retired 2026-09-18)

```
$ npm test   (re-run by the orchestrator)
# tests = 347/347 pass
# asserts = 2053/2053 pass
# ok
$ npm run lint
98 warnings   (exit 0)
$ (tabby-plugin) npm run build   (subagent)
tabby-plugin (webpack 5.109.2) compiled successfully in 5212 ms
tabby-plugin-main (webpack 5.109.2) compiled successfully in 5188 ms
$ find <scratch>/b7-out/none -path '*engine/backends/pear*'
(empty)
$ ls <scratch>/b7-out/none/ZBTerm-linux-x64/resources/app/engine/backends/
index.js  loopback.js  types.js
$ npm ls hyperswarm hyperdht
├── hyperdht@6.32.0
├─┬ hyperswarm@4.17.0
└─┬ pear-runtime@1.1.4
  └── hyperswarm@4.17.0 deduped
NOT MET: "without hyperswarm" in the none package -> named exception (S-13, D-02).
Screenshots: shots/b7-backend-none.png, shots/b7-backend-default.png
```

---

## Phase B9: Freenet adapter design, full gate, close-out

**Goal.** `freenet-backend-design.md` is grounded in the B8 numbers, the ledgers are reconciled
and the project is closed.

**Requirements & inputs.** R-12. `probes.md`; every handoff note; `docs/register.md`;
`docs/decisions.md`; `docs/abstract-arch.md` §23; `docs/projects/README.md`.

**Steps.**
1. Write `freenet-backend-design.md`: the R-12 table with each row marked probed or deferred
   and its number; the chosen topology with the reason, recorded as a `D-nn`; the invite
   `route` shape for Freenet; the peer-authentication handshake; the open problem of feeding a
   read-only Hypercore replica from contract bytes; the phase list for the follow-on project.
2. Add a dated blockquote to `docs/abstract-arch.md` §23 pointing at the design and listing the
   deviations (A-3, A-10, A-11).
3. Run the full gate: `npm test`, `npm run lint`, `tabby-plugin` `npm run build`.
4. Reconcile: every `S-nn` raised is open or fixed with a date; every `D-nn` cited exists;
   `docs/CORE-CONTRACT.md` and `README.md` match the code; no `TEMPORARY(` marker names a
   passed phase.
5. Close out: a "Closed <date>" paragraph at the top of this file, `status--done.md`,
   `open-issues.md`, and the row in `docs/projects/README.md`.

**Acceptance.** The gate is green at a count ≥ B0's. The design document cites a measured
number for every probed row.

**Verification.** `npm test` and `npm run lint` output pasted into `CHANGELOG.md`.
`grep -rn "TEMPORARY(until B" engine/ electron/ renderer/ tabby-plugin/src/` empty.

**Gotchas.** Do not re-read `CHANGELOG.md` to reconstruct state; use the handoff notes.

**Re-planning signals.** None; this is the last phase. Anything unresolved goes to
`open-issues.md`.

#### Handoff note

### B9
- **Decisions:** `D-06` (executor, against `S-06`, open to the owner's revision): the Freenet adapter is split; the SDK and contract half runs in the Bare worker, the WebRTC half in the host process on node-datachannel behind `BACKEND_*` frames appended after `engine/rpc/schema.js::FrameKind.PTY_DETACH`. Design-only choices are labelled *design* in `freenet-backend-design.md`: one signalling contract instance per link; invite route `{sig, code, params, ptr, k}`; entries signed by the ed25519 transport key; post-connect fingerprint comparison; Freenet refuses dials after `withdraw` (allowed by `D-04`); offline history deferred behind a time-boxed probe. Follow-on phases F0–F9; F0 needs the owner's consent to `Put` on the public network.
- **Gotchas hit:** the orchestrator's first gate run hit `S-03` (346/347, `test/engine-extend.test.js` assert "then the live output"); two further full runs were green. The static `availability()` hook cannot see the host, so "host has no WebRTC adapter" must reach the worker another way (F2). `engine/backends/freenet/index.js::CAPABILITIES` over-claims `HISTORY_OFFLINE_HOST` and `HISTORY_EVENTUAL_MERGE`. The probe contract authenticates nothing (`spikes/freenet/contracts/signalling/src/lib.rs::Entry` has no signature field). R-6's swap is defeated after the first share because `hostShares` is never emptied (`engine/share-manager.js::_busy`).
- **Measured:** gate 347 tests / 2053 asserts; green in 4 of 5 full runs today at the final tree (subagent 2, orchestrator 3), the fifth red by `S-03` only. Lint exit 0, 98 warnings. Both Tabby bundles compiled. `TEMPORARY(until B` grep empty. Register: `S-06`, `S-08`, `S-11` decided; the rest open; none fixed.
- **Files touched:** `freenet-backend-design.md`, `open-issues.md` (new); `docs/decisions.md` (`D-06`), `docs/register.md` (states), `docs/abstract-arch.md` (§23 blockquote), `README.md` (two env rows), `docs/CORE-CONTRACT.md` (one sentence). No code.
- **Next free:** `S-15`, `D-07`. **Suite:** 347 / 2053.

#### Verification output (retired 2026-09-18)

```
$ npm test   (subagent, twice)
# tests = 347/347 pass
# asserts = 2053/2053 pass
# ok

$ npm test   (orchestrator, run 1)
not ok 74 - copyHistoryFrom returns before the copy and keeps history, resize, live output in order
# tests = 346/347 pass
# asserts = 2052/2053 pass
# not ok                       -> S-03, a file this project never touched
$ npm test   (orchestrator, runs 2 and 3)
# tests = 347/347 pass
# asserts = 2053/2053 pass
# ok

$ npm run lint
98 warnings   (exit 0)
$ (tabby-plugin) npm run build   (subagent)
tabby-plugin-main (webpack 5.109.2) compiled successfully in 7264 ms
$ grep -rn "TEMPORARY(until B" engine/ electron/ renderer/ tabby-plugin/src/
(empty)
```
