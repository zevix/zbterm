# Freenet share backend — open issues

Written 2026-09-24 at close-out (F11). Everything here was left open **on purpose** or found and not
fixed; none of it blocks the gate (F11 gate 2026-09-24: 435 tests / 2 882 asserts, lint exit 0 with 98 warnings, three linux-x64 packages inspected). Ledger ids point at [`docs/register.md`](../../register.md)
and [`docs/decisions.md`](../../decisions.md). Symbols are cited as `file::symbol`. Numbers are
reported, not gated, unless a test is named.

## 1. Waiting for the owner

| # | What | Where | What is asked |
|---|---|---|---|
| 1 | **F1 named exception.** F1's acceptance "a second run of the recipe skips every step" is unattainable: ubitron's `om2` rail crashes in `ubitron/om2/ext/tasks.py::UBTask.restart` (`_NotHereType += int`), and the default rail has no persistent store. The recipe is idempotent instead: a second run keeps every step (all `kept`, ≈ 7 s). | `scripts/infra/freenet_host.py::FreenetHost`; F1 in [`CHANGELOG.md`](CHANGELOG.md) | Sign off on "idempotent" in place of "skipped", or have the `om2` rail fixed in ubitron. |
| 2 | **`D-16` was taken by the orchestrator** during F6 (revocation: one backend-neutral guarantee, a backend-defined mechanism; Freenet ends a revoked join by a backend error, not an in-band denial). | `D-16`, `S-20`, `engine/share-manager.js::revokeLink`, `test/backends/conformance.js::run` (the revoked-link case) | Confirm or overturn. |
| 3 | **The upstream licence issue is drafted, not filed** (`A-13`: the owner files it, or the executor with the owner's go-ahead). `R-11` and `D-15` say "filed"; `A-13` lets the close-out record "drafted, awaiting the owner", which is the state. The draft also asks about the `freenet-stdlib` **crate** (0.10.0, `LGPL-3.0-only`), which both contracts link statically into their WASM; `THIRD-PARTY-NOTICES.md` covers it. | [`upstream-licence-issue.md`](upstream-licence-issue.md), `THIRD-PARTY-NOTICES.md`, `forge.config.js::BUILD_BACKENDS` (`freenet.files`) | File it at <https://github.com/freenet/freenet-stdlib/issues/new> (or say go), and record the URL. |
| 4 | **The picker label reads "Freenet (experimental)".** It is a label, not a switch (`ZBTERM_FREENET_EXPERIMENTAL` is gone, `D-14`); kept as F9 left it. | `engine/backends/freenet/index.js::FreenetBackend.describe` (`label`) | Keep the word "experimental" or drop it. |

## 2. Found and not fixed

| # | What | Where | Consequence |
|---|---|---|---|
| 5 | **`S-30`.** A `Put` of the signalling contract on the owner's network-mode node (0.2.137 since its own auto-update) took 1.4 s to more than 10 s on 2026-09-24 (F0: 75 ms at 0.2.136). The request cap is 10 s; `announce` survives an over-long Put only when the 2 s `Get` after it finds the instance. | `engine/backends/freenet/node-client.js::REQUEST_TIMEOUT_MS` (10 000), `engine/backends/freenet/index.js::ANNOUNCE_GET_MS` (2 000) | A Freenet share can fail with `put failed` on a slow network day. Nothing was changed. |
| 6 | **`S-31`.** Cross-machine runs of the shipped backend (owner's node 0.2.137 here, `hetzner-deb16` at 0.2.136) connected both ways but erratically: one viewer got no connection within 5 min, one offer took ≈ 266 s; history towards this machine ran 0.03–0.58 MiB/s against 2.9–4.0 MiB/s away from it, with no back-pressure event. Version pair and this machine's path are not separated. | `test/tools/freenet-remote-pair.js`, [`measurements.md`](measurements.md) (F9) | Re-measure with both nodes on one version, and from a second NAT'd machine. |
| 7 | **`S-25`.** `bare-sidecar` 0.4.5's `Sidecar` has no `_final`, so ending the host side never ends the worker's pipe; every `EngineClient.close()` waits 5 s and then destroys the worker. Pre-existing. | `engine/client.js::EngineClient.close` | 5 s per close (tests and app quit); not a data loss. |
| 8 | **`S-19`.** A local-mode node answers a `Put` its contract refuses with nothing at all; a refusal looks like a slow node. Network mode not tried. | `engine/backends/freenet/node-client.js::REQUEST_TIMEOUT_MS` | Every Put needs its own cap (it has one). |
| 9 | **`S-05`.** The SDK 0.4.0 quirks (subscribe never resolves, a second `Put` answers `UpdateResponse`, a local `Get` miss is never answered, whole-state notifications) are worked around in the backend, not reported upstream, and are version-specific. | `engine/backends/freenet/node-client.js` | Re-probe on every SDK or node bump (item 10). |
| 10 | **Node version pins.** The owner's node auto-updates (0.2.136 → 0.2.137 during F8, now pid 4003927); the remote node is pinned at 0.2.136 with `--disable-auto-update`; the tests' local-mode nodes run whatever `~/.local/bin/freenet` is (0.2.137 now). Design §10's version pin (report `broken` outside a tested set) is not implemented: `diagnostics().node.version` is `null`. | `engine/backends/freenet/index.js::FreenetBackend.diagnostics`, `test/helpers/freenet-node.js`, `scripts/infra/freenet_host.py::FreenetHost` | A node update can change `S-05`/`S-19` behaviour unnoticed. |
| 11 | **`hostShares` entries are never deleted** (parent `open-issues.md` item 7, still true). `createLink` adds one per shared session; only `close()` clears the map, so `_busy()` stays true after the first share and the admission predicate (`hostShares.size > 0`) keeps admitting. | `engine/share-manager.js::createLink`, `::_busy`, `::close` | A backend switch is refused for the rest of the run once anything was shared. |

## 3. Not built (out of scope by decision)

| # | What | Where |
|---|---|---|
| 12 | **Offline history.** F10 showed design §8.2 option A works on `hypercore` 11.33.5 (`S-28`); it is a **follow-on project**, not built. It needs an exact `hypercore` pin with a version-bump test, a per-segment tree-index record (or power-of-two segments), a binary segment contract meeting abstract-arch §23.8's gates, handling of a failed segment, a decision on encrypting tree metadata, and the same for `metaCore`. Option B is the fallback. `historyRouteFor` stays `null` (`D-13`). | [`offline-history-probe.md`](offline-history-probe.md), `spikes/freenet/p9-virtual-peer.js`, `engine/backends/freenet/index.js::FreenetBackend.historyRouteFor` |
| 13 | **Other platforms' `@node-datachannel/*` packages.** Only `@node-datachannel/linux-x64-gnu@0.33.4` is installed; a package built elsewhere lacks its binding (`A-9`). | `package.json#optionalDependencies` (`node-datachannel`), `electron/rtc-host.js::RtcHost.loadError` |
| 14 | **macOS, Windows and arm64 packages** of the default (`pear,freenet`) build: none built or tested. | `forge.config.js::DEFAULT_BUILD_BACKENDS` |
| 15 | **TURN.** ZBTerm runs no TURN server (`D-11`); `RELAY` is claimed only with a configured `turn:` URL. No TURN path was ever exercised. | `electron/ice-servers.js`, `electron/rtc-host.js::DEFAULT_ICE_SERVERS` |
| 16 | **NAT↔NAT not measured.** Every cross-machine run had one public end (`hetzner-deb16`); two machines both behind NAT (the case STUN is for) were never tried. | [`measurements.md`](measurements.md) (F2, F9) |
| 17 | **Node lifecycle** (spawn, supervise, update, exit code 42) is out (`D-12`). | design §10 |

## 4. Tests

| # | What | Where |
|---|---|---|
| 18 | **`S-03`**, intermittent: `test/engine-extend.test.js` 'copyHistoryFrom returns before the copy…' assert 17. Recurred once in F8's first gate (422/423). | `S-03` |
| 19 | **`S-21`**, seen once (F6): `fd-lock` "File descriptor could not be locked" in `test/engine-attach.test.js` after a 5 s teardown of the previous test. | `S-21` |
| 20 | **`S-24`**, seen once (F8, before its fixes): Freenet conformance case 'two channels on one connection are independent' timed out; probably `S-26` (b), fixed since. Left open until it stays away. | `S-24`, `test/backends/conformance-freenet.test.js` |
| 21 | The Freenet conformance file takes ≈ 42 s, 31 s of it the revoked-link case waiting out `JOIN_TIMEOUT_MS` (`D-16` path b; the case's bound is `REVOKED_JOIN_BOUND_MS`, 60 s). | `test/backends/conformance.js`, `engine/share-manager.js::JOIN_TIMEOUT_MS` |

## 5. Packaging

| # | What | Where |
|---|---|---|
| 22 | **`S-14`**, open (reduced): `test/`, `docs/`, `scripts/` and `spikes/` still ship in every package; `resources/app` measured 673.6 MB (default), 648.6 MB (`pear`), 647.7 MB (`none`) in F11 (apparent size, reported, not gated). Freenet adds ≈ 25 MB. | `forge.config.js::ignoreFile`, `S-14` |

## 6. The remote test host

| # | What | Where |
|---|---|---|
| 23 | **`hetzner-deb16` is left provisioned and running** (F11 step 4): systemd unit `freenet-node.service` (`/etc/systemd/system/`) active as `zeev`, node **0.2.136** with `--disable-auto-update`, WS `127.0.0.1:7509`, UDP 31337; Node v24.21.0; the rust toolchain under `~/work/zbterm/rust`; `~/work/zbterm/{spikes,contracts,repo}` synced (last by F9's `SyncRepo`). Everything else ZBTerm put there lives under `~/work/zbterm`, plus apt packages. Checked read-only at F11 (2026-09-24): `systemctl is-active freenet-node` → `active`; `~/work/zbterm/bin/freenet --version` → `0.2.136 (7fa2c6605b99)`, build 2026-09-21T18:19:41Z. To take it down, stop and disable the unit and remove `~/work/zbterm` (not done; the owner's call). | `scripts/infra/freenet_host.py::{FreenetHost, SyncProbes, RustToolchain, SyncContracts, SyncRepo}` |

## 7. Ledger state at close

Fixed or closed by this project: `S-04` (closed, F2), `S-18` (F3), `S-20` (resolved by `D-16`, F6),
`S-22` (F9), `S-23` (F7), `S-26`, `S-27` (F8), `S-29` (F9). Open and carried: `S-03`, `S-05`, `S-14`,
`S-19`, `S-21`, `S-24`, `S-25`, `S-28` (follow-on), `S-30`, `S-31`. Decisions `D-09`…`D-15` (the
owner's), `D-16` (the orchestrator's). Next free ids: `S-32`, `D-17`.
