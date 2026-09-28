# Freenet share backend — requirements

**Opened 2026-09-24.** Follow-on to [`../260918_backend-abstraction/`](../260918_backend-abstraction/)
(`D-03`: "a working Freenet backend is the follow-on project"). The HOW is [`plan.md`](plan.md); the
questions the owner answered on 2026-09-24 are [`QnA_assumptions.md`](QnA_assumptions.md) (`Q-1`…`Q-9`).
The design this project implements is
[`../260918_backend-abstraction/freenet-backend-design.md`](../260918_backend-abstraction/freenet-backend-design.md)
(cited below as *design §n*); its measurements are
[`../260918_backend-abstraction/probes.md`](../260918_backend-abstraction/probes.md).

## 1. Goal

ZBTerm shares a terminal over Freenet the way it shares one over Pear: a host creates a link, a
viewer joins it from another machine, live output and viewer input flow, and history is available
while the host is online. The Freenet backend ships in the **default** package (`Q-7`), is chosen in
the share dialog, and says truthfully why it cannot be used (no node, ICE failed). It never installs
or runs the Freenet node (`Q-5`).

## 2. Today (measured 2026-09-24)

| Fact | Evidence |
|---|---|
| The backend is a stub that shares nothing. | `engine/backends/freenet/index.js::FreenetBackend`: every network member rejects with `E_BACKEND_UNAVAILABLE` / `probe only`; `availability()` is `broken` unless `ZBTERM_FREENET_EXPERIMENTAL=1`. |
| The interface, registry, selection, invite codec, conformance suite and build variants exist. | `engine/backends/types.js::CAP`, `engine/backends/index.js::{load,available,resolve,create}`, `engine/invite.js`, `test/backends/conformance.js::run`, `forge.config.js::BUILD_BACKENDS` (`freenet: { dependencies: [], files: [] }`), `DEFAULT_BUILD_BACKENDS = 'pear'`. |
| The worker↔host seam carries 15 frame kinds, PTY only. | `engine/rpc/schema.js::FrameKind` 0–14 (`PTY_DETACH` = 14); `docs/CORE-CONTRACT.md` §3 table; drift-tested by `test/core-contract.test.js`. |
| The host injects one adapter, `ptyHost`; there is no WebRTC adapter. | `engine/client.js::EngineClient` constructor (`{ userData, profileId, profilePath, backend, workerEntrypoint, ptyHost }`); `electron/engine-lifecycle.js::_wireEngine`. |
| The worker reads four spawn arguments. | `engine/worker.js`: `Bare.argv[2..5]` = `userData, profileId, profilePath, backendLimit`. |
| Neither the Freenet SDK nor a WebRTC library is installed at the root. | `node_modules/@freenetorg/freenet-stdlib` and `node_modules/node-datachannel` do not exist; both exist only under `spikes/freenet/node_modules/` (SDK 0.4.0, node-datachannel 0.33.4 with `@node-datachannel/linux-x64-gnu`). |
| The owner's node is network-mode 0.2.136 and has auto-updated since the spike. | `ps`: `/home/zeev/.local/bin/freenet network` (pid 1938466, up 2 d 15 h); `freenet --version` → `0.2.136 (7fa2c6605b99)`, built 2026-09-21; `fdev` 0.3.298. WS on `127.0.0.1:7509` and `[::1]:7509`; UDP `33292`. The spike measured 0.2.135 (`S-05` is version-specific). |
| This machine is behind NAT; the second host is not. | Local: `10.9.8.216/24` on `enp59s0u1u2u2` (plus tailscale `100.120.239.107`). `hetzner-deb16`: `46.224.69.75/32` directly on `enp1s0`, Debian 13.7 (trixie), x86_64, 8 cores, 15 GB, user `zeev` with passwordless sudo, Python 3.13.5, no `node`, `cargo`, `freenet` or `fdev`, no `~/work`, `nft` input policy `accept` (lxc tables only), `Linger=no`. |
| Freenet publishes static musl binaries per release. | `api.github.com/repos/freenet/freenet-core/releases`: `v0.2.136` (2026-09-21) has `freenet-x86_64-unknown-linux-musl.tar.gz`, `fdev-x86_64-unknown-linux-musl.tar.gz`, `SHA256SUMS.txt`, `SHA256SUMS.txt.sig`; the local `~/.local/bin/freenet` is such a static-pie binary. |
| The probe contract authenticates nothing and its key is stable across rebuilds. | `spikes/freenet/contracts/signalling/src/lib.rs::Entry` has no signature field; P-5: one key over three builds, moved by one source edit; `build/freenet/zbterm_signalling` 181 332 bytes. Toolchain: rustc 1.95.0, `wasm32-unknown-unknown` installed, `freenet-stdlib = "=0.10.0"`. |
| The renderer already has a backend picker and a "why sharing is unavailable" notice, both for usable backends only. | `renderer/app.js::shareBackendPicker` (radio group over `usableShareBackends()`, hidden below two), `::sharingUnavailableNotice` (only when nothing is usable). A broken second backend is invisible when Pear is available. |
| Suite baseline (2026-09-19, V3). | 360 tests / 2191 asserts, `npm run lint` exit 0 with 98 warnings. `git status --porcelain` shows 1 modified file. Re-measured by F0. |

### 2.1 What the spike measured and did not (design §1)

- No network hop: every latency came from two clients on one local-mode node (`S-04`).
- SDK 0.4.0 quirks against node 0.2.135 (`S-05`): `subscribe()` never resolves; a second `Put` hangs
  30 s; a local-mode `Get` miss is never answered; notifications carry the whole state.
- WebRTC is broken under Bare (`S-06`) → `D-06` split topology, confirmed by the owner (`Q-2`).
- Hypercore over a data channel needs `NoiseSecretStream` wrapping and ≤ 65 536-byte messages
  (`S-07`); 12.87 MiB/s in one Node process.
- Never measured: STUN, any NAT, contract-key reproducibility across hosts, signature checks in a
  contract, throughput across the worker↔host pipe, anything under Bare beyond the SDK.

## 3. Requirements

**R-1 Real-network numbers before code.** Two network-mode nodes on two hosts. Measured: `Get` of a
freshly put instance from the other node (propagation), put→notification p50/p95 in both directions,
offer→connected through the contract with the default STUN list, selected candidate-pair type. Written
to `measurements.md` before F3 starts. (design F0, `Q-1`)

**R-2 Remote test host by recipe.** A ubitron fabric recipe (`scripts/infra/freenet_host.py`) provisions
a test host: pinned Freenet release binaries verified by `SHA256SUMS.txt`, Node.js, a systemd unit
running `freenet network`, everything under `~/work/zbterm`. Written for Debian and Fedora, tested on
Debian. No host name inside the recipe. (`Q-1`, `Q-9`)

**R-3 Contract client in the worker.** `engine/backends/freenet/` talks to the node over one WebSocket
from the Bare worker and under Node, with the `S-05` workarounds re-verified against 0.2.136. `start`,
`stop`, `health`, `localPeerKey`, `routeFor`, `describe`, `diagnostics` per design §4. No node →
`E_BACKEND_UNAVAILABLE` with the address in `detail`. (design F1, `Q-2`, `Q-5`)

**R-4 The seam.** `FrameKind.BACKEND_OPEN/SIGNAL/STATE/CHANNEL/DATA/FLOW/CLOSE` appended after 14, never
renumbered; codecs in `engine/rpc/schema.js`; rows in `docs/CORE-CONTRACT.md`; a host adapter
`electron/rtc-host.js` on `node-datachannel` injected as `EngineClient({ rtcHost })`; a host without it
makes the backend report `broken` with "host has no WebRTC adapter". Back-pressure in both directions.
(design §3.1, F2, `Q-2`)

**R-5 Contracts shipped as bytes.** A production signalling contract (signed entries, per-key quota,
reserved host share, canonical form, TTL) and a pointer-record contract, both Rust, both passing
`fdev verify-merge` with 0 violations. The raw `.wasm` files and their BLAKE3 hashes are committed
under `engine/backends/freenet/contracts/`; a test pins the hashes; the invite carries `ptr`. Nothing
is compiled at install or package time. (design §5, F3, `Q-3`)

**R-6 Peer authentication.** Design §6 exactly: signed signalling entries, encrypted payloads under
the route key `k`, `re` binding an answer to its offer, and the fingerprint check on `connected`.
Negative tests: a tampered fingerprint, a wrong-key answer and a replayed answer never surface a
connection. `AUTHENTICATED_PEER` is claimed only if they pass. (design F4)

**R-7 Channels, admission, live history.** JSON channels cut at 65 536 bytes, `BACKEND_FLOW`
back-pressure, `setAdmission` before any peer connection, per-link limits; live history over a dedicated
channel at ≥ 1 MiB/s **through the seam**. The conformance suite passes on Freenet, unchanged.
(design F5, F6)

**R-8 Truthful product wiring.** `ZBTERM_FREENET_EXPERIMENTAL` is gone. `share.backends` lists
`freenet` as `available`, or `broken` with a reason a user can act on ("no Freenet node at
ws://127.0.0.1:7509"). The share dialog shows a broken backend disabled with that reason. ICE failure
reaches the UI as "could not connect" with `detail:'ice-failed'`. `revokeLink` withdraws the route.
(design F7, `Q-5`)

**R-9 ICE servers.** Default `stun:stun.l.google.com:19302` and `stun:stun.cloudflare.com:3478`, read
by the host process; `ZBTERM_ICE_SERVERS` / `--ice-servers` / a settings field replace the list;
the empty string disables STUN; `RELAY` is claimed only when a `turn:` URL is configured; the README
states the disclosure. No TURN is run. (design §9, `Q-4`)

**R-10 Default build.** `forge.config.js::DEFAULT_BUILD_BACKENDS` becomes `'pear,freenet'`;
`BUILD_BACKENDS.freenet.dependencies` names the SDK and `node-datachannel`; a `pear` or `none` package
has neither; the default package resolves both and carries the `.wasm` files. Variant tests are
updated, and every inverted assertion is named in the handoff. (`Q-7`)

**R-11 Licences.** `THIRD-PARTY-NOTICES.md` ships in the package: `@freenetorg/freenet-stdlib` with
both declared licences (npm `MIT+APACHE-2.0`, repository LGPL-3.0, the LGPL text, a source link),
`node-datachannel` / libdatachannel (MPL-2.0), the `freenet-stdlib` crate linked into the WASM. The SDK
ships unmodified in its own `node_modules` folder. An upstream issue asking Freenet to reconcile the
metadata is drafted and filed; the project closes on "filed", not on an answer. (design §11, `Q-8`)

**R-12 Offline history stays out, probed once.** `HISTORY_OFFLINE_HOST` and `HISTORY_EVENTUAL_MERGE`
are cleared; `historyRouteFor` returns `null`. One time-boxed phase (≤ 2 working days) tries design
§8.2 option A and records the result either way. (`Q-6`)

**R-13 Two-machine proof.** A share and join between this machine and `hetzner-deb16` over their own
nodes, at the backend level with the shipped code, with numbers; plus one GUI share/join between two
isolated instances through uisolate, screenshot kept beside a script that reproduces it. (design F7)

## 4. Non-goals

- Installing, spawning, supervising or updating the Freenet node; exit code 42 (`Q-5`; design §10).
- Offline history beyond the F10 probe; neutral segments; an always-on mirror (`Q-6`).
- A TURN service, or any relay ZBTerm operates (`Q-4`).
- macOS, Windows or arm64 packages of the Freenet variant; `@node-datachannel/<platform>` packages for
  platforms other than the build host (recorded in `open-issues.md`).
- Building the contracts at install time; a third-party generic contract (`Q-3`).
- The Tabby plugin (archived 2026-09-19; design F2's `tabby-plugin/src/main/host.ts` is dropped).
- Two backends active in one run; variant npm packages (unchanged from the parent).
