# Backend abstraction spike — open issues

Written 2026-09-18 at close-out (B9). Everything here was left open **on purpose**; none of it blocks
the gate (347 tests / 2053 asserts, lint exit 0 with 98 warnings). Ledger ids point at
[`docs/register.md`](../../register.md) and [`docs/decisions.md`](../../decisions.md). Symbols are cited
as `file::symbol`.

## 1. Waiting for the owner

| # | What | Where | What is asked |
|---|---|---|---|
| 1 | **B7 named exception.** The `none` package still ships `hyperswarm` and `hyperdht`. `D-02` keeps the OTA updater in every build, `workers/main.js` requires `hyperswarm` directly and `pear-runtime` 1.1.4 depends on it, so Forge's prune keeps both after `forge.config.js`'s `readPackageJson` hook drops them from the root manifest. B7's acceptance ("a `none` package without `hyperswarm`") is therefore **not met as written**. What `none` does drop: `engine/backends/pear/`, `engine/backends/freenet/` and the two root dependencies. | `S-13`, `D-02` | Sign off the exception, or revise `D-02` so `none` also drops the updater. |
| 2 | **`D-04` is an executor decision.** `withdraw` ends discovery of a route, not reachability of the host. Taken by the plan orchestrator under the B5 re-planning signal, not by the owner. | `D-04`, `S-08`, `engine/backends/types.js` (the `withdraw` typedef) | Confirm or revise. |
| 3 | **`D-06` is an executor decision.** Freenet adapter topology: SDK half in the Bare worker, WebRTC half in the host process on node-datachannel behind `BACKEND_*` frames. Taken in B9 from the B8 measurements. | `D-06`, `S-06`, `freenet-backend-design.md` §3 | Confirm or revise before the follow-on project starts. |
| 4 | **`D-05`** (what the registry lists, what injection means) was also taken by the executor, in B6. | `D-05`, `S-11` | Confirm or revise. |
| 5 | A `Put` on the user's network-mode node (`127.0.0.1:7509`) publishes to the public Freenet network. The spike never did it. The follow-on's first phase (F0) needs it. | `S-04` | Consent, or a second network-mode node set aside for tests. |

## 2. Code left as it is

| # | What | Where | Consequence |
|---|---|---|---|
| 6 | **ShareManager never calls `backend.withdraw`.** `engine/share-manager.js::revokeLink` marks the record revoked, disconnects the link's peers and rotates the epoch; it does not stop announcing. This is the behaviour at HEAD (revoking never left the topic) and B5 kept it. | `D-04` and its dated correction; `engine/share-manager.js::revokeLink` | A revoked link's route stays announced until the app exits. The join is refused at the control protocol (`host:join-deny`, `invalid-or-revoked`), which the conformance suite proves on both backends. On Freenet an un-withdrawn link keeps a subscription and keeps answering nothing; the follow-on should add the call. |
| 7 | **`hostShares` entries are never deleted.** `engine/share-manager.js::createLink` adds one per shared session and nothing removes it, so `engine/share-manager.js::_busy` stays true after the first share. | `engine/share-manager.js::_busy`, `::_backendNow` | Once anything was shared, asking for another backend always raises `E_BACKEND_UNAVAILABLE`: a backend swap needs a restart, even with every link revoked. R-6's "with none active, the old backend stops and the new one starts" holds only before the first share. |
| 8 | **Lazy activation moved Pear's relay-registry lookup** from construction to the first share, join, `listLinks` or read of `engine/share-manager.js::backend` (the getter). | `S-11`, `S-02`, `engine/backends/pear/index.js::_startRelayRegistryLookup` | The first Pear dial of a run may start before the relay key is known. **Effect on the first dial: not measured.** |
| 9 | **The experimental-flag `createLink` path leaves an empty share record.** With `ZBTERM_FREENET_EXPERIMENTAL=1` and the limit `freenet`, `createLink` passes `_ensureBackend`, records the `hostShares` entry and the `_linkIndex` entry, then `engine/backends/freenet/index.js::routeFor` throws `E_BACKEND_UNAVAILABLE`. Not exercised by any test. | `engine/share-manager.js::createLink`, `engine/backends/freenet/index.js::routeFor` | A share record with no links remains, and by item 7 it pins the backend for the run. Development flag only. Also: the stub's `start()` resolves under the flag, so `health()` says `started: true` for a backend that does nothing. |
| 10 | **The stub claims capabilities it cannot have yet**: `HISTORY_OFFLINE_HOST` and `HISTORY_EVENTUAL_MERGE` describe the design, and offline history is an unsolved problem. | `engine/backends/freenet/index.js::CAPABILITIES`, `freenet-backend-design.md` §8.2 | Harmless while the backend is `broken`; must be cleared before it is ever `available`. |
| 11 | **`S-10`.** `engine/share-manager.js::close` clears `this.joins` without settling them, so a join that never connected leaves its `JOIN_TIMEOUT_MS` (30 s) timer armed. | `S-10` | A test process stays alive for the remainder (34 s against 8 s measured). Tests settle `manager.joins` in teardown. Not fixed: outside the phase specs. |
| 12 | **`S-09`.** hyperswarm 4.17.0 bans a key the moment the firewall refuses it and never lifts the ban. On Pear an admission refusal is per key for the life of the swarm, and it also blocks the refusing side's own later dial to that key. | `S-09`, `engine/backends/pear/index.js::setAdmission` | A viewer that knocks while the host's swarm exists but hosts nothing stays refused after the host starts sharing, until the host restarts. **Not measured end to end.** `engine/backends/types.js`'s `AdmissionPolicy` reads as per connection; on Pear it is not. |
| 13 | **`S-02`.** `PearBackend.start()` still creates a standalone `hyperdht` node for the relay-registry lookup when `ZBTERM_RELAY_PUBLIC_KEY` is unset, so R-1's "`start` opens no sockets" holds for share sockets only. | `S-02`, `engine/backends/pear/index.js::start` | Pinned by an inherited test; making the lookup lazy needs a phase allowed to change that test. |
| 14 | **`S-01`.** Today's "v1" invites already carry `v: 2`. `engine/invite.js::decodeLink` tells the shapes apart by field presence. | `S-01` | Any later code that branches on `v === 2` is wrong. |
| 15 | **`S-12`.** Under Node 24 a `Module._resolveFilename` stub is bypassed by `relativeResolveCache` while the module is in `require.cache`, and `brittle-node` runs every test file in one process. | `S-12`, `test/backend-boundary.test.js`, `test/backends/registry.test.js` | Any new test that stubs resolution must evict `require.cache` entries and restore them. |
| 16 | Inherited wording, not this project's: `docs/CORE-CONTRACT.md` calls `share.createLink`'s result "a `pear://`-style share URI"; the prefix is `zbterm://join/` (`engine/invite.js::LINK_PREFIX`). Left alone. | `docs/CORE-CONTRACT.md` §5.1 | Cosmetic. |

## 3. Tests

| # | What | Where |
|---|---|---|
| 17 | **`S-03`, flaky.** `test/engine-extend.test.js` 'copyHistoryFrom returns before the copy and keeps history, resize, live output in order' failed once in B3 (assert 17: `LIVE-1` and `LIVE-2` recorded as one DATA packet). Not reproduced in 72 contended plus 75 isolated runs on the B3 tree, nor on a `git archive HEAD` export. Neither attributed to the spike nor proven to predate it. It did not appear in the B9 gate run. | `S-03` |
| 18 | **`ENOTEMPTY` race in the same file.** Under 12-way contention, `ENOTEMPTY … rmdir …/snapshots/<id>` out of `session.delete`: 13 of 72 runs on the HEAD export, 12 of 72 on the B3 tree. It predates the spike. | `S-03` |
| 19 | `npm run test:debug-server` is red on this machine and `npm run test:canary` needs a storage-dir argument. Both predate the project and are not part of the gate. | `plan.md` conventions |
| 20 | `_socketReplicated` was touched by no test at B0; the Pear adapter's equivalent is `engine/backends/pear/connection.js::_replicate`, which no test names directly (`test/engine-session.test.js` stubs it); it runs only inside the conformance history cases. | `baseline.md` |

## 4. Verified statically only

| # | What | Why | Where |
|---|---|---|---|
| 21 | **`electron/main.js::handleDeepLink`** asks `share.backends` first and answers a join link with a toast when no backend is available. | Reachable only through macOS `open-url`; this host is Linux. Covered by static asserts in `test/renderer-static.test.js` and `node --check`. | B7 |
| 22 | **The several-backends picker** in `renderer/app.js::showShareWizard` (a radio `fieldset`, disabled once a backend is active) and the Tabby share submenu's choice (`tabby-plugin/src/providers/toolbar.provider.ts`, `tabby-plugin/src/services/share.service.ts::ZBTermShareService`). | No build has two usable backends: Freenet is `broken` / `probe only`. | B7, R-9 |
| 23 | **`electron/main.js` backend wiring in B6** was checked by static asserts; Electron was launched only in B7, through uisolate, for `--backend none` and the default. `--backend freenet` and `ZBTERM_BACKEND` in a running app were not shown. | | B6, B7 |
| 24 | **Tabby plugin**: both bundles compile; the gating in `tabby-plugin/src/providers/toolbar.provider.ts` (`buildMenu`) is not recorded as seen inside a running Tabby in any handoff note. | The handoff notes record only the two compiled bundles. | B7 |

## 5. Cosmetic

| # | What | Where |
|---|---|---|
| 25 | With no backend, `renderer/app.js::applyShareGating` hides Share, Local and Join, and the "+ New" button (`renderer/index.html`, `#newSession`) **stays half-width** beside the space they left. | B7; `shots/b7-backend-none.png` |
| 26 | Under uisolate `/health` reports "WebGL2 not supported" although the UI renders. | B7 |

## 6. Packaging

| # | What | Where |
|---|---|---|
| 27 | **`S-14`.** The packaged app is a copy of almost the whole checkout: `test/`, `docs/`, `scripts/`, `spikes/` (280 MB with `spikes/freenet/node_modules`) and `tabby-plugin/` (451 MB, with its own `hyperswarm` and `hyperdht`) ship in every package. `resources/app` measured **795 MB** in both the default and the `none` linux-x64 package. B7 kept it ("the default build is unchanged"). | `S-14`, `forge.config.js` (`packagerConfig.ignore`) |
| 28 | Consequence for checks: `find <out> -path '*backends/pear*'` is not empty for a `none` package (it matches `test/backends/pear-backend.test.js`); the valid check is `-path '*engine/backends/pear*'`. | `S-14`, `test/build-variants.test.js` |
| 29 | `forge.config.js`'s `ignore` **function** replaces Forge's and `@electron/packager`'s default ignores, so the config repeats them; with `ZBTERM_FORGE_OUT_DIR` outside the repo the function must match `/out` itself. A packager upgrade that changes its defaults will not be picked up. | `S-14` |
| 30 | Only linux-x64 packages were built (`none` and default). `freenet` and `pear,freenet` variants were covered by `test/build-variants.test.js`, not packaged. No macOS or Windows package. | B7 |

## 7. Freenet: not measured

Everything below is stated as "not measured" in [`probes.md`](probes.md); the design document carries each
one into a follow-on phase.

| # | Not measured | Ledger |
|---|---|---|
| 31 | **Propagation between two network-mode nodes.** Both P-4 clients were on one local-mode node; host-node → network → viewer-node latency, which decides the 10 s signal, is unknown. The only network-mode datum is a 4.7 s `Get` miss on 7509. | `S-04` |
| 32 | Contract key reproducibility across rustc versions, hosts, or a different `Cargo.lock`. Measured only: three builds on one host, one key; one source edit moved the key. | P-5 |
| 33 | P-6 (Hypercore over a data channel) under Bare: blocked by P-3. Also unmeasured: replication throughput with the worker↔host pipe in the path, which is the topology `D-06` chose. | `S-06`, `S-07` |
| 34 | Under Bare, whether node-datachannel's zeroed binary frames come from the send or the receive marshalling; base64 over text frames; a Bare import map for werift; @roamhq/wrtc's raw binding beyond loading. Not reported upstream. | `S-06` |
| 35 | That a WebRTC library refuses a DTLS certificate that mismatches the SDP fingerprint (documented, **not tested**), and whether node-datachannel's `remoteFingerprint()` and werift's accessor are handshake-derived or SDP-derived. The peer-authentication design rests on it. | P-3; design §6 |
| 36 | STUN, TURN, any NAT traversal, ICE failure rates: every probe ran on loopback with no ICE server. `ZBTERM_ICE_SERVERS` is design only; nothing reads it (a comment in `engine/backends/freenet/index.js` names it). | design §9 |
| 37 | The SDK quirks are version-specific (`@freenetorg/freenet-stdlib` 0.4.0, node 0.2.135) and were not reported upstream: `subscribe()` never resolves; a second `Put` hangs 30 s; a local-mode `Get` miss is never answered; notifications carry the whole state. Two oddities were not investigated: the flat 42–44 ms `updateAckMs`, and put→notification latency falling as the rate rises (p50 78.7 → 39.3 ms). | `S-05` |
| 38 | Hypercore-over-data-channel constraints any adapter inherits: wrap the duplex in `NoiseSecretStream`; messages ≤ 65 536 bytes; never trust `bufferedamountlow` on werift or @roamhq/wrtc. P-6 rows are single runs; the spread is partly noise. | `S-07` |
| 39 | pear-runtime 1.1.4 embeds Bare 1.27.0, which caps every `bare-*` dependency of an in-worker adapter (`bare-fs` ≥ 4.8 refuses it); `@noble/hashes` does not load under Bare. | `S-06` |
| 40 | Signature checks inside the signalling contract, per-key quotas, the pointer record, the segment contract, segment rate and summary/delta size (abstract-arch §23.8): none exists; the probe contract authenticates nothing (`spikes/freenet/contracts/signalling/src/lib.rs::Entry`). | design §5–§8 |
| 41 | **Open problem:** feeding a viewer's read-only Hypercore replica from contract bytes, which offline history needs while A-11 stands (`engine/index.js::_scheduleRemoteHistoryDownload` reads `remote.store.log`). Four options, none tried. | design §8.2 **2026-09-24 (`260924_freenet-backend` F10):** probed, option A works (980/980 blocks verified from segment records through a stand-in peer, contract round trip intact); open as a follow-on per `S-28`; see `../260924_freenet-backend/offline-history-probe.md`. |
| 42 | Node lifecycle: spawn, supervise, version pin, exit code 42. Deferred by A-5. | design §10 |
| 43 | Licence: the npm package's `MIT+APACHE-2.0` field contradicts the repository's LGPL-3.0; the `freenet-stdlib` crate's terms for a distributed WASM, and node-datachannel / libdatachannel licences, were not checked. Two research items in `QnA_assumptions.md` are marked unverified. | design §11 |
| 44 | `spikes/freenet/` is throwaway code with its own `node_modules` (280 MB) and a git-ignored `.node-data/`. It ships in packages today (item 27). `rustup target add wasm32-unknown-unknown` was run on this host by B8 and changed the machine's toolchain. | B8 |

## 8. Ledger state at close

`S-06` decided (`D-06`), `S-08` decided (`D-04`), `S-11` decided (`D-05`). Open: `S-01`, `S-02`, `S-03`,
`S-04`, `S-05`, `S-07`, `S-09`, `S-10`, `S-12`, `S-13`, `S-14`. None is fixed. Next free ids: `S-15`,
`D-07`.

> **2026-09-18 (close-out, orchestrator) — `S-03` is not proven to predate this project.**
> `test/engine-extend.test.js` 'copyHistoryFrom returns before the copy…' (assert "then the live
> output") was red in 2 of about 13 full `npm test` runs at the spike tree, and never in isolated
> runs of the file. The full suite on a `git archive HEAD` export was green 8 of 8. No code on
> the test's path changed, but every test file shares one process, and this project added 70
> tests. Treat it as a regression in suite stability until shown otherwise. First things to try:
> settle pending join timers in `engine/share-manager.js::close` (`S-10`), and make the test
> wait on the recorder's flush, not on timing.

> **2026-09-19 — the `S-13` exception is resolved.** The owner chose to give up the OTA updater
> in builds without the Pear backend (`D-07`, revising `D-02`).
> [`../260919_nonpear-no-updater/`](../260919_nonpear-no-updater/) implemented it: the `none`
> package now has no `hyperswarm`, `hyperdht`, `pear-runtime` or `corestore` in the app's
> `node_modules`. No sign-off is pending.

> **2026-09-24 (freenet-backend F3) — rows 9 and 10.** The development switch row 9 depends on was
> removed: nothing reads it, and `engine/backends/freenet/index.js::FreenetBackend.availability`
> always answers `broken` / `not yet wired` until that project's F9, so the `createLink` path of
> row 9 can no longer be reached. Row 10 is fixed: `describe()` no longer claims
> `HISTORY_OFFLINE_HOST` or `HISTORY_EVENTUAL_MERGE` (nor `RELAY`, which it adds only when a
> `turn:` ICE server is configured); pinned by `test/backends/freenet-client.test.js` 'freenet:
> the backend has the ShareBackend shape and the capabilities of F3'.

> **2026-09-24 (freenet-backend F5) — row 40, in part.** Signature checks, the per-key quota, the
> reserved host share and the pointer record now exist: `engine/backends/freenet/contracts/src/
> {signalling,pointer}/`, shipped as `signalling-v1.wasm` / `pointer-v1.wasm` and pinned by
> `test/backends/freenet-contracts.test.js`; `fdev verify-merge` finds 0 violations in both. The
> segment contract, segment rate and summary/delta size remain open (that project's F8/F10).

> **2026-09-24 (freenet-backend F6) — row 6, still open.** F6's step 6 (`revokeLink` awaits
> `backend.withdraw`) was written and held back: with it the conformance case 'a join on a revoked
> link is refused and receives no bootstrap or session data' hangs on the loopback backend (the late
> peer's dial never connects once the route is withdrawn, so the host never denies it and the join
> waits out `JOIN_TIMEOUT_MS`, 30 s, which is brittle's test timeout). The Freenet backend refuses
> after `withdraw` by design, so it would fail that case the same way. Pear passes (`S-08`). Recorded
> as `S-20`; the call waits for a decision on that case.

> **2026-09-24 (freenet-backend F6, later the same day) — row 6 fixed under `D-16`.**
> `engine/share-manager.js::revokeLink` now awaits `backend.withdraw(linkId)`. The loopback stays
> reachable by peer key after `withdraw`, as Pear does, and the revoked-link conformance case accepts
> either an in-band `host:join-deny` or a backend error, with the rest of its guarantee unchanged
> (`S-20` row "resolved").

> **2026-09-24 (freenet-backend F9) — rows 9, 22, 36, 43; and the first cross-machine runs.** Row 9:
> Freenet is `available` in `share.backends` whenever the host has its WebRTC adapter and a node
> answers (`FreenetBackend.probe`, 2 s), `broken` with "no Freenet node at …" otherwise, and the
> default package carries it (`D-14`). Row 22: the picker now lists every backend the core reports,
> a broken one as a disabled radio with its reason, and was seen in a running app (the F9 GUI proof,
> `../260924_freenet-backend/shots/`), with a node and without one. Row 36: `ZBTERM_ICE_SERVERS`,
> `--ice-servers` and a settings field are read by the host process (design §9 blockquote). Row 43:
> the notices exist and the upstream issue is drafted, not filed (design §11 blockquote). New and
> open from F9: a Bare node connection died after 5 s idle (`S-29`, fixed); network-mode Puts took
> 1.4 to more than 10 s, against a 10 s request timeout (`S-30`); across the internet, with the owner's
> node at 0.2.137 and the remote at 0.2.136, both directions connected, but signalling took up to
> ≈ 4.5 minutes once and history ran at 0.03–0.58 MiB/s towards this machine versus 2.9–4.0 MiB/s
> away from it (`S-31`).

> **2026-09-24 (freenet-backend F11, close-out).** That project is closed. Rows it settled: 6 (`D-16`),
> 9, 10, 22, 36 (above), 31 (`S-04` closed: two network-mode nodes measured; NAT↔NAT still not), 32
> (contract keys identical on two hosts after the path remap, design §5.2), 33 (history through the
> worker↔host pipe measured, ≥ 13.95 MiB/s locally), 35 (node-datachannel refuses a tampered
> certificate itself; tested in `test/backends/freenet-backend.test.js`), 40 (the segment contract
> stays open with offline history), 41 (option A works, `S-28`, a follow-on). Still open here and
> carried into [`../260924_freenet-backend/open-issues.md`](../260924_freenet-backend/open-issues.md):
> row 7 (`hostShares` never emptied), row 27 (`S-14`), row 30 (no macOS / Windows / arm64 package),
> row 37 (`S-05`, not reported upstream), row 42 (node lifecycle out by `D-12`; the version pin not
> built), row 43 (the upstream issue drafted, awaiting the owner).
