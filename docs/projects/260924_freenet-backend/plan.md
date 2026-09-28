# Freenet share backend — plan

**Closed 2026-09-24.** Phases `F0`–`F10` are retired (sections, handoff notes and verification
output in [`CHANGELOG.md`](CHANGELOG.md)); `F11` ran the close-out gate. ZBTerm has a working
Freenet share backend (`engine/backends/freenet/`): the contract client in the Bare worker, the WebRTC
half in the host on `node-datachannel` (`electron/rtc-host.js`) behind `FrameKind` 15–21, contracts
shipped as committed `.wasm`, the signed handshake, channels with back-pressure and admission limits,
and live history through the seam (≥ 13.95 MiB/s locally). It passes the conformance suite unchanged
(`test/backends/conformance-freenet.test.js`), shares and joins between this machine and
`hetzner-deb16` with the shipped code, and ships in the default package `pear,freenet` (`D-14`).
Suite: 360 tests / 2 191 asserts → **435 / 2 882** (pinned by `npm test`), lint exit 0 with 98
warnings. Decisions `D-09`…`D-15` were signed by the owner; **`D-16` (revocation semantics) was taken
by the orchestrator and awaits the owner's confirmation.** **Pending the owner:** F1's named exception
(the recipe is idempotent, not "second run skips every step", because ubitron's `om2` rail crashes),
and the upstream licence issue, drafted and not filed (`A-13`). Offline history by option A is the
follow-on (`S-28`). `hetzner-deb16` is left provisioned with its node running. Everything left open is
in [`open-issues.md`](open-issues.md).

**Opened 2026-09-24.** Follow-on to [`../260918_backend-abstraction/`](../260918_backend-abstraction/)
(`D-03`). The WHAT is [`requirements.md`](requirements.md) (`R-1`…`R-13`); the answers and assumptions
are [`QnA_assumptions.md`](QnA_assumptions.md) (`Q-1`…`Q-9`, `A-1`…`A-15`). The design is
[`../260918_backend-abstraction/freenet-backend-design.md`](../260918_backend-abstraction/freenet-backend-design.md),
cited as *design §n*; every phase implements a section of it and says which.

**Goal.** A Freenet share backend that shares and joins between two machines with the shipped code,
passes the conformance suite unchanged, ships in the default package, and says truthfully why it
cannot be used. Twelve phases, `F0`–`F11`.

**Decisions already signed (2026-09-24, in `docs/decisions.md`):** `D-09` = Q-2 (`D-06` confirmed),
`D-10` = Q-3 (contracts as committed bytes + pointer record), `D-11` = Q-4 (default STUN list),
`D-12` = Q-5 (no node management), `D-13` = Q-6 (offline history out, one probe), `D-14` = Q-7
(default build `pear,freenet`), `D-15` = Q-8 (licence handling). Next free at opening: `S-19`, `D-16`.

## Conventions every phase honours

- Repo root: the predecessor repository (frozen at commit `b856e15`); all paths are relative to it. Plain CommonJS, Node
  ≥ 20, no build step; `npm run lint` must pass on touched files (prettier + lunte). Match the
  surrounding style and comment density.
- The core (`engine/`) runs under Bare in production (the `bare` binary inside
  `node_modules/bare-sidecar/prebuilds/<platform>/`, spawned by `engine/spawn-worker.js::spawnWorker`)
  and under Node in tests. Inside `engine/` require `fs`, `path`, `os`, `crypto`, `events` by those
  names (`engine/package.json#imports` maps them to `bare-*`). Running that `bare` binary by hand
  hangs: it waits on its IPC pipe. Measure Bare facts through a sidecar-spawned entrypoint.
- Measured host facts (2026-09-24): Node v24.18.0; `freenet` 0.2.136 and `fdev` 0.3.298 at
  `~/.local/bin`; `cargo`/rustc 1.95.0 at `~/.cargo/bin` with `wasm32-unknown-unknown`; the owner's
  node: `freenet network`, WS `127.0.0.1:7509`, UDP 33292, pid 1938466. Agent shells need
  `PATH=$HOME/.local/bin:$HOME/.cargo/bin:$PATH`. `F0` records the rest in `baseline.md`.
- Ledgers `docs/register.md` (`S-nn`) and `docs/decisions.md` (`D-nn`) are append-only. **One
  allocator:** read the next free `S-nn` and `D-nn` from the register's tail at landing time;
  `decisions.md` records under the number the register handed out. Never reserve one.
- A number written into a ledger, README or status row is pinned by a named test or written as
  "reported, not gated". Cite symbols (`file::symbol`), never `path:line`.
- The phase that changes a fact (a frame count, a capability set, a default, a path, a version pin)
  updates every ledger row, docstring, README table and comment that claims it, in the same phase.
  Inherited documents are corrected with dated blockquotes, never rewritten. An assertion about
  behaviour a phase removes is removed with it and **named in the handoff** (the `V-7` rule).
- Suite baseline: 360 tests / 2191 asserts, lint exit 0 with 98 warnings (2026-09-19). `F0`
  re-measures; a phase must not raise the warning count. `test/engine-extend.test.js` is
  intermittent (`S-03`): on that red only, re-run once and report both runs. Runnable: `npm test`,
  `npx brittle-node test/<file>`, `npm run lint`; `test:debug-server` and `test:canary` are not part
  of any gate.
- `TEMPORARY(until Fn)` marks anything a later phase removes; the removing phase greps for the
  marker.
- **npm in this tree (Q-9).** The owner allows this project to change `node_modules` here.
  Allowed: `npm install --save-optional <pkg>@<exact version>` (root), `npm install` inside
  `engine/` is **not** needed (one root tree; `engine/package.json` is edited by hand to mirror the
  root, as the Pear deps are). Forbidden: `npm ci`, `npm prune`, `npm uninstall` at the root,
  `npm start`, `electron-forge start`. The first `npm install` will drop the 18 extraneous packages
  of `S-18`; say so in the handoff and append the `S-18` row. Every npm command run is listed in the
  phase report.
- **Process safety — the owner's live ZBTerm runs from this working tree.** Never `pkill`,
  `killall`, `kill` by pattern, `fuser -k` or `timeout`-style kills on anything named electron,
  ZBTerm, node, npm, bare, pear or freenet. Signal only an exact pid you started yourself, after
  `ps -p <pid>` shows it. Never touch port 17069, `~/.zbterm-zeev-dev` or any `~/.zbterm*`. GUI
  runs only through uisolate (`PYTHONPATH=/ubitron/dev python3 -m ubitron.envs.uisolate run --name
  <x> -- <cmd>`; the app needs `--ozone-platform=x11`) with a unique `--storage`,
  `--electron-user-data`, debug port and `--no-updates`; only `F9` launches the app. Never write
  into the repo's `out/`; package only with `ZBTERM_FORGE_OUT_DIR=<scratch dir outside the repo>`.
  List every process-launching or signalling command you ran in your report.
- **The owner's Freenet node (Q-1, A-5).** WebSocket client only. `Put` of this project's test
  contracts is allowed. Never stop, restart, reconfigure or upgrade it; never write under
  `~/.config/freenet` or `~/.local/share/freenet`; never `Put` anything that names the owner.
- **Remote machines (Q-1, Q-9).** `hetzner-deb16` (ssh alias) is the only remote host. Everything
  there lives under `~/work/zbterm`; the only other writes are the systemd unit
  `/etc/systemd/system/freenet-node.service` and distro packages (`A-4`). Provisioning goes through
  the fabric recipe `scripts/infra/freenet_host.py` as `@Task.step`s, never ad-hoc commands (the
  skill's rule); measurement runs may use plain `ssh hetzner-deb16 '<one command>'` and are listed
  in the report. No host name inside the recipe; the host is a run argument. The recipe is run with
  `PYTHONPATH=/ubitron/dev /zp/zdata/work/ubitron/dev/.venv/bin/python`.
- Do not touch git (no `add`, `commit`, `stash`, `checkout`, `mv`; read-only `git status` /
  `git diff` is fine).
- Handoff-notes contract and completion protocol: see below.

## Phase order

```
F0  baseline + S-05 re-probe on 0.2.136        first; measurement only
F1  remote host recipe (fabric)                 after F0
F2  real-network measurements (design F0)       after F1; needs the owner's node (Q-1)
F3  contract client in the worker (design F1)   after F0; may run before or beside F1/F2
F4  the BACKEND_* seam + rtc-host (design F2)   after F3
F5  contracts as committed bytes (design F3)    after F1 (cross-host build); may swap with F4
F6  announce / withdraw / dial / handshake      after F2, F4, F5
F7  channels, flow, admission (design F5)       after F6
F8  live history through the seam (design F6)   after F7
F9  product wiring + default build (design F7)  after F8
F10 offline-history probe, ≤ 2 days (design F8) after F8; may swap with F9
F11 gate, ledgers, close-out                    last
```

## Out of scope

- Do not install, spawn, supervise or update the Freenet node from ZBTerm (`D-12`).
- Do not implement offline history beyond the `F10` probe; do not touch the player or
  `engine/index.js::_scheduleRemoteHistoryDownload` for it (`D-13`).
- Do not run or configure a TURN server; do not add a relay ZBTerm operates (`D-11`).
- Do not compile a contract at install or package time; do not depend on a third-party contract
  (`D-10`).
- Do not renumber or reuse a `FrameKind`; append only (`docs/CORE-CONTRACT.md` §3).
- Do not branch on `backend.id` in `engine/share-manager.js`; do not branch on invite `v` (`S-01`).
- Do not add platform packages of `node-datachannel` for other platforms, or build macOS, Windows
  or arm64 packages (`A-9`; `open-issues.md`).
- Do not touch `archive/`, the Tabby plugin, or the npm registry update check.
- Never lower a tolerance, weaken an assertion, widen a timeout to hide a failure, or re-bless a
  count to get green. The 1 MiB/s and 10 s figures are gates, not targets to tune.

## Handoff contract and completion protocol

After each phase append 2–5 bullets under `## Handoff notes`: **Decisions** (every `D-nn` taken,
every executor choice), **Gotchas hit**, **Measured** (numbers with units and dates), **Files
touched**, **Removed assertions** (if any), **Next free** `S-nn`/`D-nn`, suite count. On green the
phase section is cut verbatim into `CHANGELOG.md` beside this plan (created by the first retirement)
with its handoff note and verification output, leaving `## Phase Fn: <title> — ✅ done (see CHANGELOG)`.

## Handoff notes

(running; permanent)

### F0 — Baseline, and the SDK against node 0.2.136 (retired 2026-09-24)

- **Decisions:** none taken; `D-16` still free.
- **Gotchas hit:** the sidecar embeds **Bare v1.27.0** (uv 1.51.0, v8 14.4.258.16) — the version `S-06` says `bare-fs` ≥ 4.8 refuses; the root pins `bare-fs` 4.7.1, so no later phase may bump `bare-fs`, and `bare-ws`/`bare-encoding` in `F3` must accept Bare 1.27.0 (check their `engines` before installing). `pretest` asset vendoring changes nothing tracked.
- **Measured (2026-09-24):** suite 360 tests / 2191 asserts (≈ 84 s), lint exit 0 with 98 warnings; Node v24.18.0, freenet 0.2.136 (7fa2c6605b99), fdev 0.3.298, rustc 1.95.0 with `wasm32-unknown-unknown`; `@freenetorg/freenet-stdlib` and `node-datachannel` absent at the root, present in `spikes/freenet/node_modules` (0.4.0, 0.33.4). P-2 on 0.2.136: Put 74.83 ms, Get p50/p95 0.38/0.87 ms, update→notification p50/p95 38.19/42.56 ms (n = 20). `S-05` (a)–(d) all **unchanged** on 0.2.136 (raw `subscribe()` rejects after 30 s while the ack arrives as `PutResponse` in 1 ms; second `Put` answers `UpdateResponse` in 110 ms but `put()` rejects after 30 s; a `Get` miss is never answered by a local-mode node; notifications carry the whole state). `F3` keeps every `fnet.js` workaround. Details in `baseline.md`.
- **Files touched:** `docs/projects/260924_freenet-backend/baseline.md` (new), `docs/register.md` (`S-05` row appended).
- **Removed assertions:** none.
- **Next free:** `S-19` / `D-16`. Suite 360 / 2191, 98 warnings.

### F3 — The contract client in the worker (retired 2026-09-24; ran beside F1)

- **Decisions (executor, no `D-nn`):** the Bare shims are installed by `engine/backends/freenet/index.js` (`require('./bare-shims').install()` before the SDK loads), not at the top of `engine/worker.js`, because the boundary test forbids anything outside the registry from reaching a backend directory and a Pear-only build has no `bare-ws`; `worker.js` carries a comment pointing there. The bundled `signalling-v0.wasm` is the **raw** 181 292-byte WASM (the 181 332-byte `build/freenet/zbterm_signalling` is fdev's package: 8 version bytes + 32-byte code hash + WASM); its BLAKE3 `617fca0e…1dc7` equals the hash in fdev's header. `engine/package.json#files` was not changed: the existing `backends/` entry already covers `backends/freenet/contracts/`. `FREENET_ONLY` in the boundary test gained `bs58`, `bare-ws`, `bare-encoding`. `routeFor` before `start` throws `E_BACKEND_UNAVAILABLE` `'no transport key'` (Pear's works before start) — `F6`/`F9` must call it after `start`. `diagnostics().node.version` and `wsRttMs` stay `null` in F3 (`rttMs()` exists and is tested); design §10's version pin is not implemented (not in F3's steps).
- **Gotchas hit:** `freenet local` exits 1 (`Configuration directory not found`) unless config/data/log dirs exist — `test/helpers/freenet-node.js` creates them. npm saved the four packages as carets in `optionalDependencies` (lockfile root lists exact versions under `dependencies`); left as npm wrote it. The SDK's 30 s request timers are cleared by `close()`, which rejects everything pending — always close the client or the process lingers.
- **Measured (2026-09-24, reported):** installed `@freenetorg/freenet-stdlib` 0.4.0, `bs58` 6.0.0, `bare-ws` 3.2.0, `bare-encoding` 1.0.3 (transitives `base-x` 5.0.1, `flatbuffers` 25.9.23, `ws` 8.21.3; `bare-fs` 4.7.1 unchanged; `bare-ws`/`bare-encoding` declare no `engines`, deps need Bare ≥ 1.20 → OK on 1.27.0). Extraneous packages 18 → 0; top-level `node_modules` 628 → 615. Bare test: worker reply 411–478 ms, whole test ≈ 0.56 s. Node smoke: WS open 42 ms, Put 125 ms, Get RTT 1.44 ms, closed-port rejection 1.7 ms.
- **Files touched:** new `engine/backends/freenet/{blake3,bare-shims,node-client,contracts}.js`, `engine/backends/freenet/contracts/{signalling-v0.wasm,hashes.json}`, `test/helpers/freenet-node.js`, `test/backends/{freenet-client,freenet-bare}.test.js`, `test/fixtures/freenet-bare-entry.js`; rewritten `engine/backends/freenet/index.js`; edited `engine/worker.js` (comment), `engine/package.json`, `forge.config.js`, `package.json`, `package-lock.json`, `test/backend-boundary.test.js`, `test/backends/registry.test.js`, `README.md` (row dropped + dated note), `docs/CORE-CONTRACT.md` (two dated blockquotes), `docs/projects/260918_backend-abstraction/open-issues.md` (dated note on rows 9, 10), `docs/register.md` (`S-18` fixed).
- **Removed assertions (V-7):** `test/backends/registry.test.js`: '…Freenet is probe only…' → '…not yet wired…' (`detail`/`availability()` expect `'not yet wired'`; "declares HISTORY_OFFLINE_HOST" became "absent"); 'the Freenet stub has the backend shape and refuses to start' **removed** (asserted `start()` rejects `'probe only'` and the require list was exactly `['events','../../errors','../types']`) and replaced by 'the Freenet backend has the backend shape and shares nothing yet'; 'acceptance: share.backends lists freenet as broken / probe only' → '/ not yet wired'. `test/backend-boundary.test.js`: `[['freenet','broken','probe only']]` → `'not yet wired'`.
- **`TEMPORARY` markers now in `engine/`:** 8 — `contracts.js` (until F5); `index.js` `availability` (F9), `announce`/`withdraw`/`dial` (F6), `setAdmission` (F7), `serveHistory`/`attachHistory` (F8).
- **npm commands run:** `npm install --save-optional @freenetorg/freenet-stdlib@0.4.0 bs58@6.0.0 bare-ws@3.2.0 bare-encoding@1.0.3` (once); `npm view`, `npm ls`, `npm test`, `npm run lint`, `npx prettier`, `npx lunte`, `npx brittle-node`.
- **Next free:** `S-19` / `D-16`. Suite **367 / 2273**, 98 warnings.

### F1 — The remote test host, by recipe (retired 2026-09-24; one named exception)

- **Decisions (executor, no `D-nn`):** `wait_peers` reads `<work_dir>/freenet/log/*.log` (files changed in the last 10 min), not `journalctl` (with `--log-dir` the journal holds only `Started…` and rate-limit lines); the unit's `User=` comes from `id -un`; work dirs gained `freenet/cache` and the unit sets `XDG_CACHE_HOME` there; a read-only `footprint` step lists what changed in `$HOME` outside the work dir; the node is restarted only when the unit file changes; `_ptask_step_wait_s = 1800` because `wait_peers` retries back off to 60 s; the sync step's `npm ci` uses `--cache ~/work/zbterm/tmp/npm-cache`. **Named exception (pending the owner's sign-off):** "second run skips every step" is unattainable — ubitron's `om2` rail crashes (`UBTask.restart`, `_NotHereType += int`), the default rail has no persistent store; the recipe is idempotent (all steps `kept`, ≈ 7 s) instead. `open-issues.md` must carry it.
- **Gotchas hit:** release tarballs hold the bare binary at top level with mode 0644 (recipe `chmod`s); `--ws-api-address 127.0.0.1` still also binds `[::1]:7509`; `npm --version` needs the new node on `PATH`; `/tmp/.ironfabric/*.log` is write-only, read with `sudo tail`; the first `wait_peers` (journal-based) hit the runtime's 600 s step wait.
- **Measured (2026-09-24):** Node **v24.21.0** (latest 24.x, 2026-09-07), npm 11.19.0; freenet 0.2.136 (7fa2c6605b99), fdev 0.3.298, checksums OK; auto-update flag **`--disable-auto-update`**; peer wording matched **`add_connection: successfully added to ring`** (`freenet::ring::connection_manager`); ring connections logged 34 at ≈ 10 min, 42 at ≈ 16 min, 59 at ≈ 35 min; install → WS listening 22 s; `p2-network-get.js` `Contract not found` in 8127 / 2652 / 8698 ms (WS open 72 / 45 / 42 ms); remote `npm ci` 136 packages in 5 s (`@roamhq/wrtc` and `werift` installed, no `remote-package.json` needed); nft: three input hooks, all `policy accept`; no Hetzner cloud firewall in the way.
- **Files touched:** `scripts/infra/__init__.py` (new), `scripts/infra/freenet_host.py` (new: `FreenetHost`, `SyncProbes`), `README.md` ("Remote test host" under "For Developers"), `baseline.md` (dated F1 section appended).
- **Removed assertions:** none.
- **Remote state:** `freenet-node.service` active as `zeev`, WS `127.0.0.1:7509`, UDP 31337, everything under `~/work/zbterm` (+ the unit, apt packages); `~/.npm` and `~/.cache/freenet` removed.
- **Next free:** `S-19` / `D-16`. Suite unchanged (367 / 2273 after F3).

### F2 — Real-network measurements (retired 2026-09-24; ran beside F4)

- **Decisions (executor, no `D-nn`):** each signalling message is its own `Update`, applied in sequence order; the host acks all new viewer entries of one notification in a single update; put→notification is a round trip on the viewer's clock (viewer put → notification of the host's ack), "own echo" recorded beside it; the remote reads the fdev package minus its 40-byte header and checks the embedded code hash (`SyncProbes` excludes `target/`). No F6 blockquote needed. Design §1 caveat 1, §9 and §3's "not measured" pipe cost got dated blockquotes (orchestrator, F2/F4 numbers).
- **Gotchas hit:** this machine has Tailscale/Docker/libvirt interfaces → 8 host candidates, none selected; cross-host wall-clock differences are clock offset (+9…+14 s / −3…−6 s), unusable; `firstGetMs` cannot resolve propagation faster than the few-second gap before the viewer starts; node-datachannel 0.33.4's call is `pc.getSelectedCandidatePair()`; one 5 Hz ack outlier of 19 056 ms (B-default-1).
- **Measured (2026-09-24, both nodes 0.2.136 7fa2c6605b99; Node v24.18.0 here, v24.21.0 remote; reported, not gated):** A = host on `hetzner-deb16`, viewer here (NAT); B = reverse. `firstGetMs` p50/p95 A 5 172 / 5 795 ms, B 372 / 1 854 ms, **0 misses in 9 of 9**. put→notification 1 Hz p50/p95 A 1 148 / 1 525 ms, B 724 / 815 ms; 5 Hz A 1 405 / 3 100 ms, B 894 / 1 094 ms (n = 90 each, 0 lost). offer→connected with the `D-11` list p50/p95 A **1 691 / 2 137 ms**, B 1 182 / 1 301 ms; 13–16 signalling messages; selected pair A viewer `srflx` → host `host`, B viewer `host` → host's NAT mapping as `prflx`, IPv4 UDP, never IPv6/Tailscale/relay; ping RTT p50 63–74 ms. Host candidates only: connected 2 of 2 (1 448, 1 570 ms) because one end is public; `D-11` stands. **NAT↔NAT not measured.**
- **Files touched:** `spikes/freenet/p7-network.js` (new), `measurements.md` (new), `measurements/*.json` (9), `docs/register.md` (`S-04` closed), design doc §1/§9 (blockquotes by the orchestrator).
- **Removed assertions:** none. **Signals:** none fired except "host-only connects" (noted, no change).
- **Next free:** `S-19` / `D-16`. Suite unchanged.

### F4 — The `BACKEND_*` seam and the host WebRTC adapter (retired 2026-09-24; ran beside F2)

- **Decisions (executor, no `D-nn`):** the worker obtains `RtcRemote` through `engine/backends/index.js::rtcRemote(send)` (guarded literal require, `null` in a build without Freenet) because only the registry may require into a backend directory; `FreenetBackend.availability(ctx)` answers `'host has no WebRTC adapter'` when `hostCaps` is a string without `rtc`, skips the check when `hostCaps` is undefined (`registry.available()`), `ShareManager` defaults `hostCaps` to `''`, `SessionEngine` derives `'rtc'` from `opts.rtcHost`; `BACKEND_STATE` fingerprints/`pathKind` and `BACKEND_CHANNEL.label` are `optional()`, `mid` is a string; `RtcRemote.handleFrame` handles all six host→worker kinds; `pathKind` = local candidate type, or `relay` if either end is a relay; remote-opened channels get `chanId ≥ 2^31` (`REMOTE_CHANNEL_BASE`), worker-chosen ids stay below; `RtcHost` also has `closeChannel`, `pause`/`resume`, `closeAll`, `static loadError()`, `static cleanup()`; `EngineClient` without `rtcHost` answers `BACKEND_OPEN` with `BACKEND_CLOSE 'host has no WebRTC adapter'` and calls `rtcHost.closeAll('worker exited')` on exit; `DEFAULT_ICE_SERVERS` = the `D-11` list; `engine/package.json` unchanged (node-datachannel is a host dependency); `RtcHost.send` throws `RangeError` above 65 536 bytes; the new kinds/codecs are added with `Object.assign` after the `FrameKind`/`BODY_CODECS` literals so lines 0–14 stay byte-identical.
- **Gotchas hit:** `node-datachannel.cleanup()` is global (run once, last test of `rtc-host.test.js`); loading the module alone does not keep Node alive; npm wrote `^0.33.4`, left as written. The executor ran one `timeout 120 npx brittle-node …` (never fired; a rule breach, noted).
- **Measured (2026-09-24, reported):** seam, 16 MiB in 65 536-byte frames through a real sidecar, 5 runs: worker→host 327–411 MiB/s, host→worker 60–115 MiB/s, echo byte-identical; platform package `@node-datachannel/linux-x64-gnu@0.33.4`; extraneous 0 → 0, top-level `node_modules` 615 → 617; `RtcHost` loopback connect ≈ 20–30 ms, 1 000 × 64 KiB echo ≈ 2.6–3.1 s, 64 MiB burst `send() === false` 990×, flow paused then resumed; `pc.remoteFingerprint()` present (`sha-256 …`) and equal to the peer's SDP fingerprint; a one-byte change of the offer's `a=fingerprint` made both sides `failed` after ≈ 1 010 ms with no channel (scratch script, not a test) — libdatachannel refuses a mismatched certificate; whether the accessor is handshake-derived is not separately proven (F6's negative (i) settles it).
- **Files touched:** new `electron/rtc-host.js`, `engine/backends/freenet/rtc-remote.js`, `test/{rtc-host,backend-seam,backend-frames}.test.js`, `test/fixtures/rtc-echo-worker.js`, `scripts/measure-seam.js`; edited `engine/rpc/schema.js`, `engine/client.js`, `engine/worker.js`, `engine/index.js`, `engine/share-manager.js`, `engine/backends/index.js`, `engine/backends/freenet/index.js`, `electron/engine-lifecycle.js`, `forge.config.js`, `package.json`, `package-lock.json`, `test/backends/registry.test.js`, `test/backend-boundary.test.js`, `docs/CORE-CONTRACT.md` (7 rows + 2 blockquotes).
- **Removed/changed assertions (V-7):** `registry.test.js` 'acceptance: … broken / not yet wired' → '… / host has no WebRTC adapter (not yet wired with one)' (detail/message now `'host has no WebRTC adapter'`; gains a check that with an `rtcHost` it still says `'not yet wired'`); 'the limit reaches the worker as the 4th spawn argument' expects 5 argv elements (trailing `''`). `backend-boundary.test.js`: `'not yet wired'` → `'host has no WebRTC adapter'`; **boundary rule change:** new test 'node-datachannel is required only under engine/backends/freenet/ or by electron/rtc-host.js' (`RTC_HOST` the one named host owner); the engine-only `FREENET_ONLY` rule unchanged.
- **npm commands:** `npm install --save-optional node-datachannel@0.33.4` (once); `npm ls`, `npm test`, `npm run lint`, `npx prettier`, `npx brittle-node`.
- **Next free:** `S-19` / `D-16`. Suite **388 / 2452**, 98 warnings. `TEMPORARY` markers in `engine/`: 8.

### F5 — The contracts, shipped as bytes (retired 2026-09-24)

- **Decisions (executor, no `D-nn`):** entries are signed over the instance's raw **parameter bytes**, not `sig` (a contract cannot know its own instance id), binary and length-prefixed: `"zbterm/fnet-signal/1" ‖ lp(params) ‖ lp(l) ‖ lp(r) ‖ u32le(s) ‖ u64le(t) ‖ u8(d) ‖ lp(p)` — supersedes "canonical JSON" in F6 step 1; `r` = `v:`/`h:` + 64 lowercase hex, `g` = 128 hex; crate `ed25519-compact =2.4.2` (`default-features = false`) compiled to wasm32 first try; freenet-stdlib 0.10.0 has no `validate_delta`, deltas are checked in `update_state`; bounds: 16 live entries per `v:` key, `v:` share 448 of 512, `h:` 64, oldest-first eviction by `(t, key)`, map keyed `(l, r, s)`; pointer state empty or `{ver, sig, code, params (text), g}`, highest `(ver, g)` wins, unknown parameter fields ignored; `route.ptr` is the pointer for `{ host }` (one per host key — F6 must decide `{ host, n }` before the first pointer `Put`, see the F6 blockquote); `route.verify` errors: malformed → `E_CORRUPT`, wrong host → `E_AUTH`, `sig` mismatch → `E_CORRUPT`, foreign `ptr` → `E_CORRUPT`, unknown code → `E_BACKEND_UNSUPPORTED`, returns `{code, wasm, params}`; `contracts.js` exports `known` (signalling versions), `current`, `pointer`; `scripts/build-contracts.sh` sets `RUSTFLAGS=--remap-path-prefix=$CARGO_HOME=/cargo`; Forge ignores `/engine/backends/freenet/contracts/src` (pinned by a build-variants test); `.gitignore`/`.prettierignore`/`.lunteignore` cover the crates; `scripts/contract-fixtures.js` writes deterministic fixtures + a JS signer (`entryBytes`, `signEntry`).
- **Gotchas hit:** the as-planned build embedded absolute `$CARGO_HOME` paths → the key depended on the builder's home (P-5 missed it); the remote build needed a C linker (`RustToolchain` now installs `gcc`, `libc6-dev`); a refused `Put` is never answered (**`S-19`**, new); the plan's bare `fdev verify-merge` errors (`--wasm is required unless --bundle is given`) — the script runs it with `--wasm … --params … --state states/*`; `lunte` parses `.json` under `engine/` (empty `p0.json` needed an ignore entry).
- **Measured (2026-09-24):** verify-merge signalling 414 cases / 350 held / **0 violations** / 64 inconclusive (= the mis-signed fixtures, "input not valid"); pointer 85 / 56 / 0 / 29. Before remap: local vs remote 241 108 vs 241 324 B (signalling), 187 504 vs 187 720 B (pointer); after remap **identical on both hosts**: `signalling-v1` 240 972 B `01c8bdcb…08d5`, `pointer-v1` 187 376 B `ff6ce19f…6fcb` (rustc 1.95.0 59807616e, cargo 1.95.0, fdev 0.3.298 on both). Signature check cost: `Put` of 64 signed entries (29 127 B) median 97.16 ms vs 43.49 ms check-less (9 runs each) = **0.84 ms per entry** (reported).
- **Files touched:** new `engine/backends/freenet/route.js`, `contracts/{.gitignore,signalling-v1.wasm,pointer-v1.wasm}`, `contracts/src/{signalling,pointer}/…`, `scripts/build-contracts.sh`, `scripts/contract-fixtures.js`, `test/backends/freenet-contracts.test.js`; rewritten `contracts.js`, `contracts/hashes.json`; edited `engine/backends/freenet/index.js`, `test/backends/freenet-client.test.js`, `test/build-variants.test.js`, `forge.config.js`, `.prettierignore`, `.lunteignore`, `scripts/infra/freenet_host.py` (`RustToolchain`, `SyncContracts`, `--task rust|contracts`), `README.md`; deleted `signalling-v0.wasm`; dated blockquotes in design §5, §5.1, §5.2, §6, §7, probes.md §P-5, parent open-issues row 40; F6 blockquote in this plan; `S-19` appended.
- **Removed assertions (V-7):** `freenet-client.test.js` 'the bundled signalling contract matches its recorded hash' **removed** (asserted the old `manifest.files` format and "181292, the B8 probe contract, byte for byte"; the pin test replaces it, raw-WASM magic check kept); 'route shape (no ptr before F5)' → 'route shape', now expects `ptr`.
- **Signals:** cross-host hash difference **fired and was removed at its cause** (path remap); `dial`-reads-`ptr`-first is left to F6. Cost > 50 ms/entry and ed25519-compact signals did not fire.
- **Next free:** `S-20` / `D-16`. Suite **392 / 2503**, 98 warnings. `TEMPORARY` markers in `engine/`: 7.

### F6 — Announce, withdraw, dial, connection, and the handshake (retired 2026-09-24; one re-dispatch)

- **Decisions:** **`D-16`** (orchestrator, `docs/decisions.md`): revocation's guarantee is backend-neutral (late join `failed`, nothing confirmed, no bootstrap/session data), its mechanism backend-defined — Pear and the loopback stay reachable by peer key after `withdraw` and deny in-band (`host:join-deny invalid-or-revoked`); Freenet becomes unreachable and the join ends in a backend error. `revokeLink` awaits `backend.withdraw(linkId)` (errors → `'debug'` `host:withdraw:error`; reads `_backend` so revoking never activates a backend). `LoopbackHub.members` keeps every announced, unstopped backend and `resolve` falls back to a started member holding the key. The revoked-link conformance case accepts path (a) in-band denial or (b) a failed join with an error code (`t.comment` records which); loopback and Pear take (a). Executor decisions: `ptr` is one pointer per link, params `{ host, n }` (`route.pointerParamsBytes(host, n)`); `dial` reads `ptr` only on `E_BACKEND_UNSUPPORTED`, verifies the record under the expected key, re-verifies the named route; negative (i): **node-datachannel refuses the tampered certificate itself during DTLS** (rejection `E_HOST_UNREACHABLE` `ice-failed`, never `connected`), our fingerprint check stays as a second check and is tested separately (`E_AUTH 'fingerprint mismatch'`); `l` is a random per-dial connection id, messages within 25 ms batch into one sealed entry `{cid, re?, m}`; `re` = BLAKE3 of the offer entry's `p`; payload key `crypto_generichash(out, 'zbterm/fnet-payload/1', key = k)`; a route naming another host stays pending sending nothing (conformance case 3); pre-up failure rejects `E_HOST_UNREACHABLE 'ice-failed'`; `'connection'` info `{ linkId }` host side, `{ linkId: null }` dial side; announce Puts a self-minted route without a `Get`, a stored route gets a 2 000 ms `Get` first; a dial opens chanId 0 `'zbterm/fnet-bootstrap'` because node-datachannel offers only once a channel exists; `conformance.js::run` gained `opts.only`; a second dial does not yet reuse a live connection (F7).
- **Gotchas hit:** SDK 0.4.0 has no unsubscribe (`withdraw` stops reading notifications); the contract refuses an `h:` entry the host didn't sign, so (ii) injects the forged answer through `_onEntries`; on Freenet path (b) currently ends only at `JOIN_TIMEOUT_MS` (ShareManager ignores a rejected dial; a dial on a withdrawn route stays pending) — F7 blockquote; **`S-21`**: one `npm test` crashed in `test/engine-attach.test.js` with `fd-lock` "File descriptor could not be locked" after a 5 s teardown of the previous test (seen once; file green alone; second full run green).
- **Measured (2026-09-24, local-mode node 0.2.136, loopback, host candidates; reported):** announce 188–191 ms (Put + pointer Put + subscribe); dial→connected 167–183 ms; offer written→answer applied 121 ms; tampered-fingerprint dial rejected in 156–170 ms.
- **Files touched:** new `engine/backends/freenet/{signal,connection}.js`, `test/backends/freenet-backend.test.js`, `test/backends/conformance-freenet.js`; edited `engine/backends/freenet/{index,node-client,route}.js`, `engine/backends/loopback.js`, `engine/share-manager.js`, `test/backends/{conformance.js,registry,freenet-contracts,freenet-client}.test.js`, `docs/CORE-CONTRACT.md`, design §4/§5/§6 blockquotes, parent `open-issues.md` row 6, `docs/register.md` (`S-20` open + resolved, `S-21`), `docs/decisions.md` (`D-16`), this plan (F7 blockquote).
- **Removed/changed assertions (V-7):** `registry.test.js` 'announce() says why' expects `'not started'` (was `'not yet wired'`); `freenet-contracts.test.js` `{ host }` → `{ host, n }` (three titles); `freenet-client.test.js` '…{ host } (F5)' → '…{ host, n } (F6)'; `conformance.js` revoked-link case: 'the host denied it because the link is revoked' now accepts in-band denial **or** a backend error (`D-16`), all other assertions unchanged.
- **Next free:** `S-22` / `D-17`. Suite **402 / 2601**, 98 warnings. `TEMPORARY` markers in `engine/`: 6 (availability F9; setAdmission, openChannel/onChannel F7; serveHistory/attachHistory F8).

### F7 — Channels, flow control and admission (retired 2026-09-24)

- **Decisions (executor, no `D-nn`):** framing `[flags u8][index u32 LE]` + ≤ 65 531 bytes per part, cut in the worker before `RtcHost.send`; channel pairing as the loopback (first opener creates the data channel, worker chanIds from 1, the other side takes it via `onChannel` + `openChannel`; simultaneous opens each send on their own and read both; opening the same key twice on one side throws); bootstrap channel chanId 0 carries nothing and is never surfaced; back-pressure advisory in the loopback's shape (no `'drain'`), `send` returns `false` while `BACKEND_FLOW` has the channel paused or the worker holds ≥ 256 KiB for it (`channel.js::QUEUE_HIGH_WATER`), never drops on an open channel; channel events before surfacing are held and replayed after `'connection'`; admission policy called as `policy(remotePeerKey, { remotePeerKey, linkId })`; `MAX_ANSWERS_PER_MINUTE` 30 over a sliding `ANSWER_WINDOW_MS` 60 s, `MAX_HALF_OPEN` 8, both checked before the policy and applied to pinned keys too; `diagnostics().links[]` gains `answeredLastMinute`, `halfOpen`, `refused`, `conns[].channels` counted; constructor `clock` option; **`S-23`** fixed: `announce`/`dial` await a running `start()` (ShareManager never awaits it); revoked-link case on Freenet ends by `D-16` path (b) at `JOIN_TIMEOUT_MS` (31.1 s), the case's bound is `REVOKED_JOIN_BOUND_MS` = 60 s in `conformance.js`, no assertion changed; `conformance.js::run` turns a thrown case into `t.fail` so later cases still run; the forged-invite fixture forges a non-topic route in the v2 spelling (Pear/loopback bytes identical); a second `dial` still does not reuse a live connection.
- **Gotchas hit:** brittle rethrows a thrown case and stops the file (hence the wrapper); a burst on an already-open channel never trips `send() === false` (≈ 830 KB stays under `RtcHost`'s 1 MiB mark) — the conformance case trips the worker queue mark because it sends before the channel opens; a Freenet link has no `topic` (forged-invite fixture); one leftover `/tmp/zbterm-freenet-node-*` dir removed after a crashed run. **`S-22` (open, security):** no half-open deadline of the backend's own — a slot frees only on cancel, withdraw or ICE failure (≈ 39.5 s), so a holder of the invite can keep all 8 slots with ≈ 12 offers/min; fix in `F9` (see its blockquote).
- **Measured (2026-09-24, local-mode node 0.2.136, loopback; reported):** 200 KiB message send→onmessage 5.0–5.5 ms in 4 parts; 10 000-message burst right after `openChannel` (828 890 B JSON) 255–272 ms = 36 773–39 222 msg/s = 2.91–3.10 MiB/s, `send()` false 7 009×, worker buffer peak **878 890 B** (< 1 MiB); same burst on an open channel 278–313 ms, never false, peak 88 B; a host peer connection given an offer and no candidate went `failed` after 39.5 s.
- **Files touched:** new `engine/backends/freenet/channel.js`; edited `engine/backends/freenet/{connection,index}.js`, `electron/rtc-host.js` (comment), `test/backends/{conformance.js,conformance-freenet.js,freenet-backend.test.js}`, `docs/register.md` (`S-22`, `S-23`; header corrected to `S-24` by the orchestrator), design §4/§7 blockquotes, `docs/CORE-CONTRACT.md` blockquote.
- **Removed/changed assertions (V-7):** `freenet-backend.test.js`: **removed** `t.exception(() => conn.openChannel(...), /channels arrive in F7/)` (behaviour gone); `diagnostics.links` check gains `answeredLastMinute: 1, halfOpen: 0, refused: 0`; `conformance.js`: throw-to-fail wrapper, revoked-link case timeout 60 s, forged-invite fixture; `conformance-freenet.js`: `only` list removed, every case runs, file still out of `npm test` (`TEMPORARY(until F8)`).
- **Next free:** `S-24` / `D-17`. Suite **407 / 2634**, 98 warnings. `TEMPORARY` markers: 3 in `engine/` (`availability` F9; `serveHistory`/`attachHistory` F8) + 1 in `test/`.

### F8 — Live history through the seam (retired 2026-09-24; one re-dispatch)

- **Decisions (executor, no `D-nn`):** `engine/backends/freenet/history.js::HistoryChannel extends FreenetChannel` carries raw bytes (parts ≤ 65 536, no F7 part header), reuses F7 pairing/queue/`BACKEND_FLOW`, adds `ondrain`; `connection.js::_openChannel(protocol, id, handlers, Channel)`; history data channel label `zbterm/history 00` (id = one zero byte; "`… 0`" is not valid hex), never surfaced to `onChannel`; `historyStream(conn)` is a streamx `Duplex` with u32-LE frames, one Noise-wrapped stream per connection (dialer = initiator, ephemeral keys) carrying every store, idempotent by a `WeakSet` per connection; `attachHistory` returns `{fetch, close}`; `historyRouteFor` stays `null` (`D-13`); `notYetWired` helper removed; `scripts/measure-history.js` drives `test/fixtures/history-measure-worker.js` through `EngineClient.workerEntrypoint` because the core has no way yet for a host to name a node URL (the real worker would hit the owner's node on 7509) — plain Hypercores in the `{log, metaCore}` shape, first run of the backend's history code under Bare. **Re-dispatch fixes (three races, load-dependent):** (S-26 a) the dialer sends its ICE candidates only after it applied the answer (`index.js::_onRtcSignal`, `ownHeld`) — before, the host reached DTLS before the viewer had the answer's fingerprint (`DTLS alert: unknown CA`, connection `failed`, join hung to `JOIN_TIMEOUT_MS`); backend `RtcHost.signal` calls go through `_signal` (throw → `rtc:signal-error` debug); (S-26 b) own data channels are created only after the bootstrap channel reports open (`connection.js::_bootstrapOpened`), messages queue until then — node-datachannel reports `connected` before pre-SCTP channels open, so an early channel went opened→closed at once; (S-27, present since F7) the opener of every data channel except bootstrap sends nothing until the other side sends one 5-byte `READY` part `[0x02][u32 0]` (`channel.js::READY_PART`) after wiring — messages reaching a remote-opened channel before the receiver's handler was set could come out of order (one 1 021 places late). **Wire change:** `READY` part on every Freenet data channel (documented in `docs/CORE-CONTRACT.md`).
- **Gotchas hit:** **`S-25`** `bare-sidecar`'s `Sidecar` has no `_final`, so a worker never sees its pipe end and every `EngineClient.close()` takes 5 s (pre-existing); **`S-24`** case 6 flaked once in the baseline run (probably S-26 b); enabling node-datachannel's debug logger hides the races; the libdatachannel internals behind S-26 b / S-27 are inferred from event order, not read; a scratch fixture under `/tmp` hangs (the worker cannot resolve modules there); the S-26 test's "host always receives the viewer's candidates" became a `t.comment` (not guaranteed; own new test). **Orchestrator note (2026-09-24 ≈ 18:13 UTC): the owner's node auto-updated itself to 0.2.137 (built 2026-09-24T13:56Z) and restarted under pid 4003927** — nothing of ours touched it; the remote stays pinned at 0.2.136, so `F9`'s cross-machine proof runs 0.2.137 ↔ 0.2.136 and must report both (F1's signal); the plan's `ps -p 1938466` lines are void from here on.
- **Measured (2026-09-24, reported; the 1 MiB/s gate is met):** seam history, 16 MiB of 16 KiB blocks through two real sidecars + a local-mode node: first runs 26.02 / 28.02 / 26.85 MiB/s; after the re-dispatch 24.06 / 23.36 / 25.24 (one run straight after `npm test` 13.95); orchestrator gate 25.68 / 26.06 / 24.46 then 22.63 / 21.86 / 20.92 MiB/s — **lowest recorded 13.95 MiB/s**; first block 47–66 ms; dial→connected 236–322 ms (+≈ 50 ms from the candidate hold); 512 KiB blocks complete at 31.68–38.46 MiB/s, longest gap ≤ 197 ms. Under load (10–12 busy loops on 8 cores) 12 of 12 conformance runs green after the fixes (≈ 1 in 4 failed before). Suite ≈ 178 s; the Freenet conformance file ≈ 42 s, 31 s of it the revoked-link case.
- **Files touched:** new `engine/backends/freenet/history.js`, `scripts/measure-history.js`, `test/fixtures/history-measure-worker.js`; renamed `test/backends/conformance-freenet.js` → `conformance-freenet.test.js`; edited `engine/backends/freenet/{index,connection,channel}.js`, `test/backends/freenet-backend.test.js` (4 new tests: 256 KiB history blocks over `zbterm/history 00`; S-26 two dials from one key both connect and attach history; S-26 channels before bootstrap open; S-27 opener waits for READY); `docs/register.md` (`S-24`…`S-27`, S-23 note, header), `docs/CORE-CONTRACT.md`, design §4/§8.1 blockquotes, `measurements.md` (F8 section + re-measurement paragraph).
- **Removed assertions (V-7):** none (the `'not yet wired'` answer of `attachHistory` had no test).
- **Next free:** `S-28` / `D-17`. Suite **426 / 2762**, 98 warnings. `TEMPORARY` markers: 1 in `engine/` (`availability`, until F9), 0 in `test/`.

### F10 — Offline history, the time-boxed probe (retired 2026-09-24; ran beside F9)

- **Decisions (executor, no `D-nn`):** one binary record per segment cut at the first block boundary ≥ 64 KiB: blocks, the signed head at the segment's end (`writer.state.signature`, 68 B manifest-v1 multisig), "ancestor" nodes crossing the segment start, the tree's full roots the segment lacks, the manifest in segment 0 (70 B); in-segment nodes recomputed by the viewer; a separate block-free tree-index record per segment for sparse fetch; the stand-in peer opens the `hypercore/alpha` protomux channel over a `NoiseSecretStream` pair and answers with `MerkleTree.proof` over a fake session, claiming `downloading: true`; step 2 reuses the P-5 probe contract (JSON, base64 in 12 KiB slices, 6 entries). **Verdict: open option A as a follow-on (`S-28`); B is the fallback.** The follow-on needs an exact `hypercore` pin + a version-bump test, the per-segment index (or power-of-two segments), a binary segment contract meeting §23.8's gates, handling of a failed segment (drop + reopen channel), a decision on encrypting tree metadata, and the same for `metaCore`.
- **Gotchas hit:** the signature is 68 B, not 64; `MerkleTree.proof` is async in 11.33.5; sparse fetch without the index verifies 0 of 168 blocks (byte-cut segments do not align with the tree), with it 168 / 168; one bad block pauses the replica's fetching from that peer (`Peer#_handleData`); the spike resolves its own `node_modules` (protomux 3.12.0 vs root 3.11.0, hypercore-storage 3.3.1 vs 3.1.2; hypercore 11.33.5 in both).
- **Measured (2026-09-24, reported):** proof bytes per 64 KiB 293 / 531 / 623 B (min/p50/max, 1 MiB; ≈ 0.8 %), index record 260 / 586 / 696 B; viewer upgrade 18–26 ms, full 1 MiB download 172–279 ms; 980 / 980 verified (1 MiB), 15 890 / 15 890 (16 MiB), progressive 980 / 980, sparse-with-index 168 / 168, tampered block refused; contract round trip of segment 0: 68 077 B record → 91 085 B state (1.34×), Put 139–225 ms, Get p50 4.2–5.7 ms, bytes identical, 59 / 59 verified, node 0.2.137 local mode. Not measured: segment put→notification latency, state size of a growing session (§23.8 gates). Box: 21:38–21:55 +03:00.
- **Files touched:** `spikes/freenet/p9-virtual-peer.js` (new), `offline-history-probe.md` (new), `docs/register.md` (`S-28`, header `S-29`); by the orchestrator: design §8.2 blockquote, parent `open-issues.md` item 41 note.
- **Removed assertions:** none. **Next free:** `S-29` / `D-17`. Suite unchanged (426 / 2762, not run here).

### F9 — Product wiring and the default build (retired 2026-09-24; ran beside F10)

- **Decisions (executor, no `D-nn`):** `share.backends` goes through `ShareManager.probedBackendsInfo()` (`registry.probe(id)`, 2 s cap), `backendsInfo()` stays synchronous; new `SessionEngine`/`ShareManager` option `backendOptions` (tests name a node address; the product passes none, 7509 stays fixed); `electron/ice-servers.js` resolves settings field (non-empty) > `--ice-servers` > `ZBTERM_ICE_SERVERS` > the `D-11` default, an empty flag/variable = no STUN, the flag read before paparam (it rejects an empty value); the host pushes the list through a new `share.setIceServers` invoke (CORE-CONTRACT row), every backend receives it, `RtcHost.iceServers` updated; preload `window.app.setIceServers`; a backend rejecting a dial with an error code fails the join at once with `{code, detail, backend, message}` (Pear/loopback reject only on cancel), the toast shows only when `backend` is present; the picker shows when ≥ 2 backends are reported and ≥ 1 is usable; **`S-22` fixed:** each offer first expires the link's half-open connections past `HALF_OPEN_TIMEOUT_MS` (backend `clock`), a per-connection timer re-arms as fallback, one viewer key ≤ 2 slots; `THIRD-PARTY-NOTICES.md` listed in `BUILD_BACKENDS.freenet.files` (pear/none do not ship it), pruning removes a scope directory left empty; renderer debug command `share-backend`, `modal-state` includes `shareBackends`; `SyncRepo` rsyncs with `--delete-excluded` protecting remote `node_modules`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, a stamp makes `npm ci` idempotent, step wait 1800 s; `test/tools/freenet-remote-pair.js` runs under Node with an in-process `RtcHost`. Licence issue **drafted, not filed** (`A-13`). The picker label reads "Freenet (experimental)" — a label, not a switch; owner's call whether to keep it (open-issues).
- **Gotchas hit:** **`S-29` fixed:** under Bare, `bare-http1` 4.5.7's global agent leaves a 5 s socket timeout armed on the upgraded WebSocket socket, so the node connection closed itself when idle (first GUI share failed) — `bare-shims.js::keepOpenWhenIdle`; the Bare test now idles 6 s and fails without the fix. The identity prompt must be dismissed only after the renderer shows it; `/health` under uisolate stays not-ok ("WebGL2 not supported", parent row 26); the first `SyncRepo` uploaded the spike's 170 MB cargo `target/` (now excluded); `~/.local/bin/freenet` is 0.2.137 now, so the tests' local nodes are 0.2.137.
- **Measured (2026-09-24, reported):** package `resources/app` / whole: default 673.4 MB / 975.8 MB, pear 648.4 / 950.9, none 647.5 / 949.9 (Freenet ≈ +25 MB). Remote pair (host 0.2.136 on hetzner, viewer here on the owner's 0.2.137 = A; reverse = B), IPv4 UDP, never relay: A-1 never connected within the 5 min cap; A-2 8.9 s, echo 2.6 s, history not done in 15 min; A-3 65.1 s, 0.03 MiB/s; A-4 14.8 s, 0.58 MiB/s (srflx → host); B-1 268.5 s (the offer took ≈ 266 s to arrive), history not done; B-2 5.0 s, 4.00 MiB/s; B-3 8.5 s, 2.93 MiB/s (host → srflx/prflx). GUI proof (both instances on the owner's node): announce 8 971 ms, join complete 1 098 ms after request, dial→connected 608 ms, offer→answer 190 ms, both diagnostics `backend.id === 'freenet'`, one connection `connected`/`DIRECT`, 2 channels, `D-11` ICE list, halfOpen/refused 0; `shots/f9-join.png` shows the host's line on the viewer, `shots/f9-picker-no-node.png` the disabled entry with the address (taken in a network namespace).
- **Open findings:** **`S-30`** Puts on the owner's node now take 1.4 s to > 10 s (F0: 75 ms), near the 10 s request timeout — a share can fail with `put failed` on a slow day; **`S-31`** signalling between 0.2.137 and 0.2.136 was erratic (one viewer never within 5 min, one offer 266 s late) and history toward this machine ran 0.03–0.58 MiB/s vs 2.9–4.0 away, no back-pressure events — version mismatch vs this machine's path not separated; the `freenet-stdlib` crate in both contracts is `LGPL-3.0-only` (covered by the notices; part of the licence question).
- **Files touched:** new `electron/ice-servers.js`, `test/tools/freenet-remote-pair.js`, `THIRD-PARTY-NOTICES.md`, `upstream-licence-issue.md`, `shots/{f9-run.sh,f9-join.png,f9-picker-no-node.sh,f9-picker-no-node.png}`, `measurements/F9-remote-pair-{A-2,A-3,A-4,B-1,B-2,B-3}.json`; edited `engine/backends/freenet/{index,bare-shims}.js`, `engine/backends/index.js`, `engine/share-manager.js`, `engine/index.js`, `electron/{main,preload,engine-lifecycle,rtc-host}.js`, `renderer/{app.js,index.html}`, `forge.config.js`, `package.json` (`files`), `scripts/infra/freenet_host.py` (`SyncRepo`), tests `build-variants`, `backends/{registry,freenet-backend,freenet-client,freenet-bare}`, `fixtures/freenet-bare-entry.js`, `renderer-static`; docs `README.md` (Freenet section, env/flag rows, dated notes), `docs/CORE-CONTRACT.md`, `docs/register.md` (`S-22` fixed, `S-29`–`S-31`), `docs/RELEASE-NPM.md`, design §9/§11 blockquotes, parent `open-issues.md` and `requirements.md` R-8 notes, `measurements.md` (F9 section).
- **Removed/changed assertions (V-7):** **inverted:** `build-variants.test.js` 'default variant is pear: freenet is left out, pear and its dependencies stay' → 'default variant is pear,freenet: both backends and their dependencies stay (D-14)' (expects `['pear','freenet']`, freenet dir not ignored); new tests 'pear and none drop the Freenet backend…' and the `.wasm`/`hashes.json` per variant; `registry.test.js`: 'Pear is available, Freenet is not yet wired…' → '…Pear and Freenet are available…' (`availability()` → `{available, null}`), F4 test `notYet` → `usable`, `withRtc` detail check → state `available`, 'a limit narrows…' broken case uses `hostCaps: ''` + freenet usable under its own limit, 'create() … raises' context `{ hostCaps: '' }`, acceptance test retitled and its "F9 next" `['broken','not yet wired']` check replaced by the probe's `broken` + address detail; `freenet-client.test.js` `availability()` `{broken,'not yet wired'}` → `{available, null}`; `renderer-static.test.js` picker test retitled, 'none for zero or one' (`usable.length < 2`) replaced.
- **npm/packaging commands:** `npm test` ×3, `npm run lint` ×4, `npx electron-forge package` (default ×6, pear ×2, none ×2, all into the scratchpad), no installs. **Next free:** `S-32` / `D-17`. Suite **435 / 2882**, 98 warnings. `TEMPORARY` markers: **0**.

### F11 — Full gate, ledgers, close-out (retired 2026-09-24)

- **Decisions:** none new. `D-09`…`D-16` present in both ledgers (16 `D-` rows in the table); next free `S-32` / `D-17`. No area `STATUS.md` exists in this repo; none created.
- **Gotchas hit:** `R-11`/`D-15` want the licence issue *filed*; it is drafted only (`A-13`), recorded as pending the owner in `plan.md`, `status--done.md`, `open-issues.md`. `S-19` stays open (nothing fixed it); `S-24` stays open ("probably S-26" is not proof). The edited `.md` files are outside lint's scope (prettier flags them; not reformatted).
- **Measured (2026-09-24, reported):** suite 435 / 2882 in ≈ 184 s, lint 98 warnings; packages `resources/app` / whole: default 673.6 / 976.1 MB, pear 648.6 / 951.1, none 647.7 / 950.1; the default package loads `node-datachannel` and the SDK, `pear`/`none` carry none of the Freenet files; remote `freenet-node` active, 0.2.136.
- **Files touched:** `plan.md` (Closed paragraph), `status--in-progress.md` → `status--done.md`, `open-issues.md` (new, 23 items), `docs/projects/README.md` (row **done**), `docs/register.md` (`S-03` recurrence row), `docs/ARCHITECTURE.md` (§3.1, §7 blockquotes), parent `plan.md` (follow-on + lesson), parent `open-issues.md` (close-out note), design §12 blockquote.
- **Removed assertions:** none. **Next free:** `S-32` / `D-17`. Suite **435 / 2882**, 98 warnings.

---

## Phase F0: Baseline, and the SDK against node 0.2.136 — ✅ done (see CHANGELOG)

---

## Phase F1: The remote test host, by recipe — ✅ done (see CHANGELOG; one named exception)

---

## Phase F2: Real-network measurements (design F0) — ✅ done (see CHANGELOG)

---

## Phase F3: The contract client in the worker (design F1) — ✅ done (see CHANGELOG)

---

## Phase F4: The `BACKEND_*` seam and the host WebRTC adapter (design F2, §3.1) — ✅ done (see CHANGELOG)

---

## Phase F5: The contracts, shipped as bytes (design F3, §5, §7) — ✅ done (see CHANGELOG)

---

## Phase F6: Announce, withdraw, dial, connection, and the handshake (design F4, §6) — ✅ done (see CHANGELOG)

---

## Phase F7: Channels, flow control and admission (design F5, §7) — ✅ done (see CHANGELOG)

---

## Phase F8: Live history through the seam (design F6, §8.1) — ✅ done (see CHANGELOG)

---

## Phase F9: Product wiring and the default build (design F7; Q-4, Q-5, Q-7, Q-8) — ✅ done (see CHANGELOG)

---

## Phase F10: Offline history — the time-boxed probe (design F8, §8.2 option A) — ✅ done (see CHANGELOG)

---

## Phase F11: Full gate, ledgers, close-out — ✅ done (see CHANGELOG)
