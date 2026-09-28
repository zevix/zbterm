# Backend abstraction spike — requirements

**Opened 2026-09-18.** The HOW is in [`plan.md`](plan.md). Questions and assumptions are in
[`QnA_assumptions.md`](QnA_assumptions.md). Background architecture:
[`docs/abstract-arch.md`](../../abstract-arch.md) (§11, §14, §16, §17, §23, §28).

## 1. Goal

One ZBTerm source tree that shares terminals over **either** the Pear/Holepunch network
**or** Freenet, chosen at startup. It must be packageable with the Pear backend only, the
Freenet backend only, both, or neither. With neither, the app is local-only and no share or
join UI exists. Only one backend is active in a run.

This project is the **spike**. It defines the common interface in code, moves today's
networking behind it as the Pear adapter, adds selection, build variants and UI gating, and
probes Freenet far enough to write a grounded design for the Freenet adapter. A working
Freenet share is the follow-on project (Q-3).

## 2. Today (measured 2026-09-18, branch `freenet` = `main`)

### 2.1 Where Pear is used

| Fact | Evidence |
|---|---|
| All share networking is one file, constructed unconditionally. | `engine/index.js::SessionEngine` constructor: `this.share = new ShareManager(this)` |
| The only injection seam is the PTY host. | `engine/index.js::SessionEngine`: `'SessionEngine requires a ptyHost adapter (opts.ptyHost)'` |
| One lazily created swarm per profile, keyed by the device transport key. | `engine/share-manager.js::_createSwarm`, `::_ensureSwarm` |
| Host announces a random 32-byte topic; viewer joins the topic **and** dials the host key. | `engine/share-manager.js::createLink`, `::join` |
| The remote transport key is the primary authentication pin. | `engine/share-manager.js::_handleViewerConnection` compares `socket.remotePublicKey` with the invite's `hostDhtKey` |
| Union firewall plus refcounted pins. | `engine/share-manager.js::_ensureSwarm`, `::_pinHost`, `::_unpinHost` |
| Relay fallback, found through a DHT mutable record. | `engine/share-manager.js::_relayThrough`, `::_registryLookup`, `REGISTRY_PUBLIC_KEY` |
| Control channels and Hypercore replication share one Protomux per socket. | `engine/share-manager.js::_openHostChannel` (`mux.createChannel`, `log.replicate(mux)`, `metaCore.replicate(mux)`), `::_registerViewerRemote` |
| Control protocol is JSON messages on protocol `zbterm/ctl`, channel id = `linkId`. | `engine/share-manager.js` constant `PROTOCOL = 'zbterm/ctl'` |
| Invite is `zbterm://join/<base64url JSON {v, linkId, topic, hostDhtKey, claim}>`. | `engine/share-manager.js::encodeLink`, `::decodeLink`, constant `LINK_PREFIX` |
| Incremental history uses Hypercore range downloads. | `engine/index.js::_scheduleRemoteHistoryDownload`: `remote.store.log.download({ start, end, linear: true })` |
| The device transport keypair is minted by hyperdht. | `engine/crypto.js::loadOrCreateLocalDevice` and `engine/account-store.js::AccountStore::createUser` call `HyperDHT.keyPair()` |
| `HyperDHT.keyPair()` is plain ed25519 from sodium. | `node_modules/hyperdht/index.js::keyPair` → `lib/crypto.js::createKeyPair` |
| `protomux` cannot leave any build. | `node_modules/hypercore/package.json` depends on `"protomux": "^3.5.0"` |
| No reconnection logic. A join times out after 30 s. | `engine/share-manager.js` constant `JOIN_TIMEOUT_MS = 30 * 1000` |
| Worker spawn arguments are `userData`, `profileId`, `profilePath`. | `engine/worker.js`: `Bare.argv[2]`, `[3]`, `[4]`; `engine/client.js::EngineClient._spawnWorker` |
| No `--backend` flag, env var or build-time feature flag exists. | `electron/main.js::CLI_OPTIONS`; no `DefinePlugin`, no `optionalDependencies` in any manifest |
| The interfaces in `docs/abstract-arch.md` exist only on paper. | grep for `TransportProvider`/`DiscoveryProvider` in `engine/` returns nothing |

### 2.2 Tests that pin today's behaviour

| File | Measured | Network |
|---|---|---|
| `test/share-manager.test.js` | 21 `test(` calls; 26 lines reference Pear privates (`_createSwarm`, `_hostSwarm`, `_pinHost`, `_relayThrough`, `_registryLookup`, `_socketPeers`, `_handleHostConnection`, `_handleViewerConnection`) | Mocked sockets, real Protomux |
| `test/share-manager-network.test.js` | 2 tests | Real `ShareManager`s over a local `hyperdht/testnet` |
| `test/identity-handshake.test.js` | 13 tests | Real Protomux |
| `test/core-contract.test.js` | Drift-tests `docs/CORE-CONTRACT.md` against every `invoke` method, event and frame kind | — |
| `test/core-boundary.test.js` | `engine/` and `workers/` never import host code | — |

The last suite baseline recorded in a handoff note is 243 tests / 1268 asserts. Phase B0
re-measures it.

### 2.3 What Freenet provides (research 2026-09-18; sources in `QnA_assumptions.md` §Sources)

| Need | Freenet |
|---|---|
| App API | Only contract `Put`/`Get`/`Update`/`Subscribe` and delegate ops, over a WebSocket to a local node: `ws://127.0.0.1:7509/v1/contract/command` |
| TS SDK | `@freenetorg/freenet-stdlib` 0.4.0 (2026-08-31). CJS. Node is supported through a global `WebSocket` or the optional `ws` package. FlatBuffers encoding. Responses are correlated by contract key. 30 s request timeout. |
| Peer-to-peer duplex stream | **None.** |
| Discovery by topic | **None.** Addressing is by contract key only. |
| NAT traversal for apps | **None.** The node punches holes for its own overlay only. |
| Contracts | Rust→WASM. State merge must be associative, commutative and idempotent; `fdev verify-merge` checks it. Key = `BLAKE3(BLAKE3(wasm) ‖ params)`, so it changes on every WASM rebuild. State cap 50 MiB; the practical target is far smaller. |
| Node | v0.2.135 (2026-09-10), self-described alpha. A sidecar-spawned node exits with code 42 to request an update. `freenet`, `fdev` and `cargo` are installed on this machine (`~/.local/bin`, `~/.cargo/bin`). |
| Licence | Talking to an unmodified node over WebSocket does not trigger the node's AGPL. The npm package's licence field (`MIT+APACHE-2.0`) contradicts the repo's LGPL-3.0. |

Whether the SDK and a WebRTC library load under **Bare**, where the core runs, is unknown.

## 3. Signed decisions

- **Q-1** Freenet is a **hybrid** backend. Contracts carry invites, rendezvous, membership,
  rekey and durable encrypted history. A WebRTC data channel, signalled through a contract,
  carries live output and viewer input. Viewer input is never stored.
- **Q-2** "Pear backend" means **network sharing only**: hyperswarm, hyperdht, protomux use,
  relay lookup, and Hypercore replication to peers. Local Hypercore storage, the Bare sidecar,
  crypto and the Pear OTA updater stay in every build.
- **Q-3** Spike depth: interface in code, conformance suite, Pear adapter with every existing
  test green, selection + build variants + UI gating, and Freenet **probes**.

## 4. Requirements

### R-1 Common interface

One `ShareBackend` contract in `engine/backends/types.js`: JSDoc typedefs, the `CAP` bitset
and an `assertBackend()` shape check. It reuses `docs/abstract-arch.md` vocabulary and lists
its deviations.

| Group | Members |
|---|---|
| Lifecycle | `describe()`, `start(ctx)`, `stop()`, `health()`. `start` opens no sockets. |
| Identity | `localPeerKey()` → 32-byte transport key |
| Rendezvous | `announce(linkId, opts)` → `{route, linkId}`; `withdraw(linkId)`; `routeFor(linkId, stored)` |
| Connect | `dial(route, expectedPeerKey, {signal})` → `{connected, cancel}`; event `'connection'`; `setAdmission(fn)` |
| `PeerConnection` | `remotePeerKey`, `closed`, `path()` (`DIRECT`/`RELAY`/`BROKER`/`LOCAL`), `openChannel(protocol, id, handlers)`, `onChannel(protocol, cb)`, `close(reason)`; events `close`, `error`, `path` |
| `MessageChannel` | `send(obj)` → `false` under backpressure; `close()`. Reliable and ordered per channel. `onmessage` is not awaited. |
| History | `serveHistory(conn, store)`, `attachHistory(conn, store, keys)` → `HistoryHandle {fetch({start,end}), close()}`; `historyRouteFor(store)` |
| Diagnostics | `diagnostics()` → JSON-safe, no secrets |

`dial` MUST reject a connection whose `remotePeerKey` differs from `expectedPeerKey` before
surfacing it. The interface MUST NOT expose a mux, socket or swarm.

> **2026-09-18 (B3).** As landed in `engine/backends/types.js`: `start(ctx)` takes
> `{keyPair}` (a function, read lazily); `announce` accepts `opts.route` so the caller can
> store the route before announcing, and `routeFor(linkId, null)` mints a fresh route;
> `dial().connected` resolves to the `PeerConnection` and rejects on `cancel()`;
> `setAdmission` takes a function or a boolean; `PeerConnection` gains a read-only
> `initiator` (`true`/`false`/`null`), used for debug output only; `announce` and `dial`
> accept `opts.tag`, copied into debug events; the backend also emits `'debug'` and
> `'error'`. "`start` opens no sockets" holds for share sockets only: see `S-02`.

> **2026-09-18 (B5).** The `withdraw` row, per `D-04` (against `S-08`): `withdraw(linkId)` stops
> announcing the route and nothing more. It is idempotent and a live connection survives it. A
> backend MAY refuse a later dial of that route (loopback does); it need not (Pear still
> connects a peer that holds the host key). Refusing a join on a withdrawn or revoked link is
> ShareManager's job on every backend. `diagnostics()` always carries `announced`, the number
> of links currently announced. `'connection'` fires on both the dialing and the accepting
> side. ShareManager does not call `withdraw` today: at HEAD `revokeLink` never left the topic
> (the only `swarm.leave` was the viewer's join settle, now `dial().cancel()`), so B5 added no
> call.

Capability flags, from abstract-arch §16.2 and §14.2: `AUTHENTICATED_PEER`,
`MULTIPLEXED_STREAMS`, `ORDERED_STREAM`, `EPHEMERAL_DELIVERY`, `DIRECT_DIAL`, `NAT_TRAVERSAL`,
`RELAY`, `BROKERED`, `PATH_MIGRATION`, `HISTORY_SPARSE_READ`, `HISTORY_HEAD_WATCH`,
`HISTORY_EVENTUAL_MERGE`, `HISTORY_OFFLINE_HOST`.

### R-2 Backend-neutral ShareManager

These stay in `engine/share-manager.js`: link records, caps, approval, the `zbterm/ctl`
message set, the identity challenge, live encryption, rekey, sealed input and its replay
guard, the viewer message queue, flow control, and fan-out.

- ShareManager MUST NOT branch on `backend.id`.
- When a backend lacks `CAP.EPHEMERAL_DELIVERY`, `createLink` strips `SEND_INPUT`.

### R-3 Pear adapter

`engine/backends/pear/` owns everything in §2.1 that names hyperswarm, hyperdht or protomux,
plus Hypercore replication on its private mux and the swarm diagnostics. Wire behaviour is
byte-identical: a build from this project interoperates with today's release in both roles.

### R-4 Identity without hyperdht

`engine/crypto.js` and `engine/account-store.js` mint the transport keypair with
sodium-native. The stored `dhtPublicKey`/`dhtSecretKey` format does not change. A test proves
equality with `HyperDHT.keyPair(seed)` for a fixed seed.

### R-5 Invite v2

`engine/invite.js` owns the codec. Shape: `{v:2, b, linkId, peer, route, claim}`.

- A v1 link decodes as `{b:'pear', peer: hostDhtKey, route:{topic}}`.
- Pear links keep the v1 fields, so released builds can still join them.
- A `b` that the running build lacks raises `E_BACKEND_UNSUPPORTED` naming the backend.
- The identity challenge keeps the wire-frozen field names `verifierDhtKey` and
  `proverDhtKey`. Their values come from `localPeerKey()` and `conn.remotePeerKey`.

### R-6 Selection

- `--backend <pear|freenet|none>` and `ZBTERM_BACKEND` **limit** the available set. They
  never add to it. The flag wins over the env var.
- The host resolves the value and passes it to the worker as a 4th spawn argument
  (`Bare.argv[5]`). An empty value means "no limit", so older hosts stay valid.
- One backend is active per run. It is created lazily on the first `createLink({backend})` or
  `join(uri)`; for a join the invite's `b` decides.
- Asking for a different backend while shares or joins exist raises `E_BACKEND_UNAVAILABLE`
  with a restart hint. With none active, the old backend stops and the new one starts.

### R-7 Introspection

- New invoke `share.backends` →
  `{backends:[{id,label,capabilities,state,detail}], default, active, limitedBy}`.
- `share.createLink` takes an optional `backend`.
- `share.diagnostics` gains `backend:{id,…}` and keeps today's top-level keys as aliases.
- `docs/CORE-CONTRACT.md` documents all of it; `test/core-contract.test.js` stays green.

> **2026-09-18 (B6).** As landed. `limitedBy` is the limit value in force (`'none'`, `'pear'`,
> `'freenet'`) or `null`; the flag-versus-env source stays in the host. `backends` lists broken
> backends too (`state:'broken'` with a `detail`); `default` is the first `available` one.
> `share.diagnostics` appends `backend` (the active backend's `diagnostics()` plus `id` and
> `health`, or `null`) after the five older keys, which keep their order. R-6's "created
> lazily" holds for `createLink` and `join`; in addition, reading `ShareManager#backend`
> activates the default backend, because inherited tests rely on it (`S-11`). An injected
> backend bypasses the registry and the limit (`D-05`). The engine option is
> `SessionEngine({backendLimit})`; the client option is `EngineClient({backend})`.

### R-8 Build variants

`ZBTERM_BUILD_BACKENDS=pear|freenet|pear,freenet|none`, default `pear`.

> **2026-09-24 (`260924_freenet-backend` F9, `D-14`).** The default is now `pear,freenet`
> (`forge.config.js::DEFAULT_BUILD_BACKENDS`); `pear` and `none` drop the Freenet backend, its five
> dependencies, its contract `.wasm` files and `THIRD-PARTY-NOTICES.md`.

- `forge.config.js`: a `packagerConfig.ignore` function drops `engine/backends/<absent>/`. The
  `readPackageJson` hook drops that variant's dependencies and writes `zbtermBackends`.
- Backend-only dependencies move to `optionalDependencies`.
- `engine/backends/index.js` loads each backend through a guarded, literal `require`.
  `MODULE_NOT_FOUND` means absent. Any other error means `state:'broken'` with a `detail`.
- If `zbtermBackends` says a backend was expected and it is broken, the UI says why. It does
  not silently hide sharing.

> **2026-09-18 (B7).** `hyperswarm` and `hyperdht` are not backend-only: the OTA updater
> (`workers/main.js`, `pear-runtime`) needs them, and `D-02` keeps the updater in every build.
> The hook drops them from the root manifest, but they still ship in a `none` package (`S-13`).
> The output directory can be moved with `ZBTERM_FORGE_OUT_DIR` (default `out`). An unknown
> value in `ZBTERM_BUILD_BACKENDS` fails the build.

### R-9 UI gating

| Backends available | Electron renderer | Tabby plugin |
|---|---|---|
| 0 | Hide `els.shareSession`, `els.joinLink`, `els.inputMode` and the session-editor share box. `electron/main.js::handleDeepLink` answers a join link with a toast. | `ZBTermToolbarButtonProvider` omits the share and join items. Recording and playback stay. |
| 1 | Unchanged | Unchanged |
| >1 | `showShareWizard` shows a backend picker, disabled once a backend is active. Join needs none. | `ZBTermShareService.createLink` accepts a backend; the share submenu offers the choice. |

### R-10 Boundary tests

`test/backend-boundary.test.js`:

- `hyperswarm`, `hyperdht`, `protomux` are required only under `engine/backends/pear/`.
- The Freenet SDK, `ws` and any WebRTC library are required only under
  `engine/backends/freenet/`.
- Only `engine/backends/index.js` reaches into a backend directory from outside it.
- With module resolution stubbed to fail for the Pear set, `new SessionEngine({ptyHost})`
  boots and `share.backends` returns an empty list.

### R-11 Conformance suite

`test/backends/conformance.js::run(name, makePair)` runs against Pear on `hyperdht/testnet`
and against an in-memory `engine/backends/loopback.js`. The loopback has no mux and no socket
dedupe, which proves the interface is not Pear-shaped. The suite absorbs the two cases in
`test/share-manager-network.test.js` and includes a full ShareManager join parametrised over
backends.

> **2026-09-18 (B5).** Per `D-04` (against `S-08`) the suite does not assert that a dial fails
> after `withdraw`. Its withdraw case asserts that `diagnostics().announced` goes 1 → 0, that a
> second `withdraw` is safe and that the existing connection still carries messages both ways.
> The security guarantee is a ShareManager-level case run on both backends: after
> `revokeLink`, a fresh third peer joining with the same invite is refused and receives no
> bootstrap and no session data. `makePair()` also returns `create()`, which makes that third
> peer. Pear's socket-dedupe assertion (`hostSwarm.connections === 1`) lives in
> `test/backends/conformance-pear.test.js`, because loopback has no dedupe by design.

### R-12 Freenet translation and missing components

The spike writes `freenet-backend-design.md`. For each Pear feature it names the Freenet-side
component and marks it **probed** or **deferred**.

| Pear feature | Freenet-side component |
|---|---|
| Topic announce and lookup | Rendezvous contract holding the signed host advert |
| Noise socket, hole punching | Signalling contract (SDP/ICE mailbox per link, TTL) + WebRTC data channel |
| `remotePublicKey` authentication | DTLS fingerprints signed by the transport key inside the SDP |
| Relay + DHT registry | ICE servers (`ZBTERM_ICE_SERVERS`); TURN is operator-supplied |
| Firewall and pins | `setAdmission` applied to signalling entries; per-link rate limit |
| Live Hypercore replication | Hypercore stream over a second data channel |
| Offline history | Segment contract per abstract-arch §23.4 |
| Stable addressing across WASM rebuilds | Pointer record |
| Always-on DHT | Node lifecycle manager: locate or spawn, health, version pin, exit code 42 |
| `swarmDiagnostics` | Node state, WebSocket RTT, contract keys, ICE state |

### R-13 Probes

Under `spikes/freenet/`, outside `engine/` and outside packaging. Each writes measured numbers
to `probes.md`.

| Probe | Question | Pass |
|---|---|---|
| P-1 | Does the SDK load and round-trip under Bare? | `Get` + `Subscribe` against a local node |
| P-2 | Same under Node | Reference latencies |
| P-3 | Which WebRTC library loads under Bare and under Node, and exposes the remote DTLS fingerprint? | A data channel opens on loopback |
| P-4 | Contract put→notification p50/p95; offer→connected time | Signalling under 10 s |
| P-5 | Does the Rust signalling contract pass `fdev verify-merge`? Is its key stable across rebuilds? | Reproducible key, or a pointer record is required |
| P-6 | Does `hypercore.replicate` run over a data channel? | ≥1 MiB/s, no stall at the SCTP message cap |

The results select the Freenet adapter topology: in-worker, a host-process adapter over new
`BACKEND_*` frames (the `engine/pty-remote.js::PtyRemote` pattern), a Node sidecar, or a Rust
sidecar.

## 5. Non-goals

- A working Freenet share or join.
- Abstracting local storage, the process model or OTA updates (Q-2).
- Two backends active at once.
- Variant npm packages of `zbterm-core`.
- Operating a TURN service.
- Bundling or supervising the Freenet node.
