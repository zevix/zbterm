# Freenet share backend — CHANGELOG

Retired phases of [`plan.md`](plan.md), cut verbatim with their handoff note and verification output. Newest last.

---

## Phase F0: Baseline, and the SDK against node 0.2.136

**Goal.** `baseline.md` holds every number a later phase inherits, measured today on this machine,
and `S-05`'s four quirks are re-checked against the node version that now runs here (0.2.136; the
spike measured 0.2.135). No product code is touched.

**Requirements & inputs.** `R-1` (its preconditions), `S-04`, `S-05`, `A-5`, `A-7`. Inputs:
`spikes/freenet/p2-node.js` (P-2: Put/Get/Subscribe/Update round trip against a local-mode node, prints
JSON), `spikes/freenet/lib/fnet.js::connect` (the `S-05` workarounds), `spikes/freenet/package.json`
(its `node_modules` is present), `docs/projects/260918_backend-abstraction/probes.md` §P-2 (the run
line: `freenet local --ws-api-port 7519 --config-dir … --data-dir … --log-dir … --disable-auto-update`),
`engine/spawn-worker.js::spawnWorker`, `docs/register.md`, `docs/decisions.md`.

**Steps.**
1. Run `npm test` and `npm run lint`; record test/assert counts, exit codes, the warning count, any
   failing test id. On an `S-03` red re-run once and record both.
2. Record `git status --porcelain` (paths only), `node --version`, `freenet --version`,
   `fdev --version`, `rustc --version`, `rustup target list --installed`, the owner's node line from
   `ps -eo pid,etime,args | grep '[f]reenet'`, and `ss -ltnp | grep 7509`.
3. Measure the Bare version the sidecar embeds: write a throwaway entrypoint under the scratchpad
   that sends one JSON line `{ bare: Bare.version, versions: Bare.versions }` over `Bare.IPC` (see
   how `engine/worker.js` opens `new FramedStream(Bare.IPC)`; a raw `write` of a line is enough for a
   probe), spawn it with `spawnWorker`, read the line, close, kill that pid. Record the version.
4. Start a local-mode node on port 7519 with directories under the scratchpad (the probes.md run
   line), note its pid. Run `node spikes/freenet/p2-node.js 7519`; record the JSON. Then check each
   `S-05` item explicitly with a 15-line script in the scratchpad using `fnet.js`: (a) does a raw
   `api.subscribe()` promise settle now? (b) does a second `Put` of the same instance return, and
   with what? (c) is a `Get` miss answered on the local-mode node, and after how long? (d) is a
   notification still the whole state? Stop the node by its pid; confirm with `ps -p`.
5. Confirm the two new packages are absent at the root (`node_modules/@freenetorg/freenet-stdlib`,
   `node_modules/node-datachannel`) and present under `spikes/freenet/node_modules` with versions.
6. Write `baseline.md` with all of it, dated. Append to `docs/register.md` a dated `S-05` row
   ("re-probed on 0.2.136: …") — fixed, changed or unchanged per item.

**Acceptance criteria.** `baseline.md` exists with every item above; the `S-05` row is appended;
no file outside `docs/` and the scratchpad changed; the local-mode node is gone (`ps -p <pid>`
empty); the owner's node pid is unchanged.

**Verification.**
```
npm test 2>&1 | tail -3            # "# tests N", "# pass N", exit 0 (or S-03 twice)
npm run lint 2>&1 | tail -2        # exit 0; warning count
ls docs/projects/260924_freenet-backend/baseline.md
tail -3 docs/register.md           # the appended S-05 row
ps -p 1938466 -o pid,etime,args    # the owner's node, still up
```

**Gotchas.** The spike's `.node-data/` directory is git-ignored but lives in the repo; put F0's node
directories in the scratchpad instead. A local-mode node never answers a `Get` miss on 0.2.135; give
(c) a 40 s cap. `p2-node.js` puts the probe contract once per instance nonce; re-running it against
the same data dir triggers `S-05`(b).

**Re-planning signals.** Any `S-05` item changed → `F3`'s client drops or keeps the corresponding
workaround (edit `F3` step 3 and note it). The SDK 0.4.0 cannot talk to 0.2.136 at all → stop: the
SDK must be bumped first; report before `F3`. Suite baseline differs from 360 / 2191 → update this
plan's conventions line with a dated blockquote.

### F0 — Baseline, and the SDK against node 0.2.136 (retired 2026-09-24)

- **Decisions:** none taken; `D-16` still free.
- **Gotchas hit:** the sidecar embeds **Bare v1.27.0** (uv 1.51.0, v8 14.4.258.16) — the version `S-06` says `bare-fs` ≥ 4.8 refuses; the root pins `bare-fs` 4.7.1, so no later phase may bump `bare-fs`, and `bare-ws`/`bare-encoding` in `F3` must accept Bare 1.27.0 (check their `engines` before installing). `pretest` asset vendoring changes nothing tracked.
- **Measured (2026-09-24):** suite 360 tests / 2191 asserts (≈ 84 s), lint exit 0 with 98 warnings; Node v24.18.0, freenet 0.2.136 (7fa2c6605b99), fdev 0.3.298, rustc 1.95.0 with `wasm32-unknown-unknown`; `@freenetorg/freenet-stdlib` and `node-datachannel` absent at the root, present in `spikes/freenet/node_modules` (0.4.0, 0.33.4). P-2 on 0.2.136: Put 74.83 ms, Get p50/p95 0.38/0.87 ms, update→notification p50/p95 38.19/42.56 ms (n = 20). `S-05` (a)–(d) all **unchanged** on 0.2.136 (raw `subscribe()` rejects after 30 s while the ack arrives as `PutResponse` in 1 ms; second `Put` answers `UpdateResponse` in 110 ms but `put()` rejects after 30 s; a `Get` miss is never answered by a local-mode node; notifications carry the whole state). `F3` keeps every `fnet.js` workaround. Details in `baseline.md`.
- **Files touched:** `docs/projects/260924_freenet-backend/baseline.md` (new), `docs/register.md` (`S-05` row appended).
- **Removed assertions:** none.
- **Next free:** `S-19` / `D-16`. Suite 360 / 2191, 98 warnings.

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
$ npm test            → exit 0; # tests = 360/360 pass; # asserts = 2191/2191 pass; # ok
$ npm run lint        → exit 0; 98 warnings
$ ls docs/projects/260924_freenet-backend/baseline.md   → present
$ tail -1 docs/register.md   → | S-05 | open, re-probed 2026-09-24 (F0) | … all four items **unchanged** …
$ ps -p 1938466 -o pid,etime,args   → 1938466  2-16:54:17 /home/zeev/.local/bin/freenet network
$ ss -ltn | grep 7519   → (empty; the local-mode node is gone)
```
Processes the phase started and stopped by exact pid: Bare sidecar pid 3721880 (via `spawnWorker`, SIGTERM), `freenet local` pid 3726351 (SIGTERM); no pattern kills.

---

## Phase F3: The contract client in the worker (design F1)

**Goal.** `engine/backends/freenet/` holds a real client: it opens one WebSocket to the node, mints
routes, reports health and diagnostics, runs under the sidecar's Bare and under Node, and rejects
cleanly when there is no node. It still shares nothing: `announce`, `dial`, channels and history
arrive in `F6`–`F8`, and the registry keeps reporting it `broken` until `F9`.

**Requirements & inputs.** `R-3`, `Q-2`/`D-09`, `Q-5`/`D-12`, `A-6`, `A-7`, `S-05` (as re-probed by
`F0`; read `baseline.md`), design §4 rows `describe`, `start`, `stop`, `health`, `localPeerKey`,
`routeFor`, `diagnostics`, design §5 (route shape, §5.1 checks), §10 (locate, version pin). Code:
`engine/backends/freenet/index.js` (the stub; keep the file, replace the body),
`engine/backends/types.js::{CAP, assertBackend, BACKEND_MEMBERS}`, `engine/backends/pear/index.js`
(`start(ctx)` reading `ctx.keyPair` lazily; `'debug'` event shape), `engine/errors.js::CODES`,
`engine/crypto.js::transportKeyPair`, `spikes/freenet/lib/{fnet,blake3,bare-shims}.js` (the source
to port, not to require), `engine/worker.js` (the three `globalThis` shims at its top — the client's
Bare shims go in the same place, guarded so Node is untouched), `test/helpers/` (new
`freenet-node.js`), `test/backend-boundary.test.js::FREENET_ONLY`, `forge.config.js::BUILD_BACKENDS`.

**Steps.**
1. `npm install --save-optional @freenetorg/freenet-stdlib@0.4.0 bs58@<current> bare-ws@<current>
   bare-encoding@<current>` at the root (record versions; `bare-process` is already a dependency).
   Mirror them into `engine/package.json#optionalDependencies` and into
   `forge.config.js::BUILD_BACKENDS.freenet.dependencies` (`@freenetorg/freenet-stdlib`, `bs58`,
   `bare-ws`, `bare-encoding`; `node-datachannel` joins in `F4`). Update `package-lock.json` by that
   same install. Append the `S-18` row (the extraneous packages are gone now, or not — measure with
   `npm ls --depth=0 2>&1 | grep -c extraneous`).
2. Port the probe helpers into `engine/backends/freenet/`: `blake3.js` (dependency-free, as is, with
   the `blake3-check.js` vectors turned into a test), `node-client.js` (from `fnet.js::connect`,
   `contractKey`, `putRequest`: one WebSocket, the `S-05` workarounds that `F0` confirmed still
   needed, a `close()`, a `rttMs()` that times a `Get` on a known instance, request timeouts that
   never exceed 10 s), `bare-shims.js` (installs `TextEncoder`/`TextDecoder` from `bare-encoding` and
   a browser-shaped `WebSocket` over `bare-ws`, only when `typeof Bare !== 'undefined'` and the
   globals are missing; under Node ≥ 22 the global `WebSocket` is used, `A-6`).
3. Rewrite `index.js::FreenetBackend` per design §4: constructor `({ nodeUrl = 'ws://127.0.0.1:7509/v1/contract/command',
   iceServers, rtcHost, wasm } = {})`; `describe()` with `CAPABILITIES` **cleared** of
   `HISTORY_OFFLINE_HOST`, `HISTORY_EVENTUAL_MERGE` and `RELAY` (`RELAY` is added by `describe()` only
   when `iceServers` holds a `turn:` URL, `F9` wires that); `start(ctx)` opens the socket and nothing
   else, rejects `E_BACKEND_UNAVAILABLE` with `detail: 'no Freenet node at <nodeUrl>'` when the
   socket fails or does not open in 5 s; `stop()` safe twice; `health()`; `localPeerKey()` from
   `ctx.keyPair().publicKey`; `routeFor(linkId, stored)` synchronous, minting `{ sig, code, params:
   { ttl_ms, host, n }, k }` from the bundled WASM (`ptr` is added in `F5`); `diagnostics()` per the
   design row, JSON-safe, never `k`. Keep `static availability()` returning `broken` /
   `'not yet wired'` **`TEMPORARY(until F9)`**, and delete the `ZBTERM_FREENET_EXPERIMENTAL` read
   here (its README row and the registry test that names `probe only` change in the same phase:
   `test/backends/registry.test.js` 'registry: Pear is available, Freenet is probe only…' and
   `test/backend-boundary.test.js`'s `[['freenet', 'broken', 'probe only']]` expectation become
   `'not yet wired'`; name them in the handoff).
4. Bundle the WASM for `routeFor` **`TEMPORARY(until F5)`**: copy the probe's raw
   `spikes/freenet/contracts/signalling/build/freenet/zbterm_signalling` bytes to
   `engine/backends/freenet/contracts/signalling-v0.wasm` and its BLAKE3 hex to
   `engine/backends/freenet/contracts/hashes.json`; `engine/backends/freenet/contracts.js` loads
   them with `fs` and exposes `{ known: Map<codeHex, bytes>, current }`. Add `contracts/` to
   `engine/package.json#files`.
5. `test/helpers/freenet-node.js`: `startLocalNode({ port })` → spawns `freenet local
   --ws-api-port <port> --config-dir <tmp>/config --data-dir <tmp>/data --log-dir <tmp>/log
   --disable-auto-update` with `child_process.spawn`, waits for the port, returns `{ port, pid,
   stop() }` where `stop()` kills **that pid** and removes the tmp dir; `freenetAvailable()` returns
   false when the binary is not on `PATH`. Tests call `t.skip('freenet binary not on PATH')` when it
   is absent (`A-7`).
6. Tests: `test/backends/freenet-client.test.js` (Node): blake3 vectors; `routeFor` shape, `sig ===
   contractKey(code, params)`, a different `linkId` gives a different `n`; `start` against
   `startLocalNode` resolves, `health()` `started:true`, `diagnostics()` JSON-safe without `k`,
   `stop` twice; `start` against a closed port rejects `E_BACKEND_UNAVAILABLE` with the address in
   `detail` within 6 s; `assertBackend(new FreenetBackend())` passes.
   `test/backends/freenet-bare.test.js`: spawns the sidecar (`engine/spawn-worker.js::spawnWorker`)
   on a fixture entrypoint `test/fixtures/freenet-bare-entry.js` that requires
   `engine/backends/freenet/index.js`, starts it against the local node, and writes `{ ok, health }`
   over IPC; the test asserts `ok`. This proves the client under the Bare the product ships.
7. `docs/CORE-CONTRACT.md` "Share backends" section: `freenet`'s `detail` values (`'not yet wired'`
   now). `README.md`: drop the `ZBTERM_FREENET_EXPERIMENTAL` row (dated note under the table).

**Acceptance criteria.** All of `npm test` green with the new tests **run, not skipped** (their
names appear in the output); `test/backend-boundary.test.js` green (the SDK and `bare-ws` are
required only under `engine/backends/freenet/`); the Bare test passes under the sidecar; no
`ZBTERM_FREENET_EXPERIMENTAL` anywhere (`grep -rn` over `engine electron renderer test README.md
docs/CORE-CONTRACT.md` empty); `npm run lint` exit 0, warnings ≤ baseline; every `TEMPORARY(until
F5|F9)` marker present.

**Verification.**
```
npm test 2>&1 | grep -E 'freenet|# (tests|pass|fail)'      # the freenet tests listed, fail 0
npx brittle-node test/backends/freenet-bare.test.js         # ok
npm run lint 2>&1 | tail -2
grep -rn ZBTERM_FREENET_EXPERIMENTAL engine electron renderer test README.md docs/CORE-CONTRACT.md ; echo "exit $?"   # exit 1
grep -rn 'TEMPORARY(until F' engine | wc -l                 # ≥ 2
npm ls --depth=0 2>&1 | grep -c extraneous                  # reported, not gated
```

**Gotchas.** The SDK's promises: whatever `F0` found, never `await` a raw `subscribe()` (design §1
item 2). `@noble/hashes` does not load under Bare (`S-06`): the BLAKE3 stays dependency-free. Bare
caps `bare-*` versions to what its runtime supports — check the sidecar's Bare version in
`baseline.md` against `bare-ws`' `engines` before installing. `brittle-node` runs every test file in
one process: the Bare shims must never install under Node, and `require.cache` tricks need the `S-12`
eviction. The worker's environment is not reliably inherited (`engine/worker.js` comment): the node
URL is a constructor option, never read from `process.env` inside `engine/`.

**Re-planning signals.** The SDK does not load under the sidecar's Bare (a newer Bare than 1.27.0
may reject a shim) → try the shims first; if it is the SDK itself, `F3` stops and reports; `D-09`
would need revisiting. `bare-ws` refuses the sidecar's Bare → a WebSocket over `bare-tcp` is the
fallback; note the cost.

### F3 — The contract client in the worker (retired 2026-09-24; ran beside F1)

- **Decisions (executor, no `D-nn`):** the Bare shims are installed by `engine/backends/freenet/index.js` (`require('./bare-shims').install()` before the SDK loads), not at the top of `engine/worker.js`, because the boundary test forbids anything outside the registry from reaching a backend directory and a Pear-only build has no `bare-ws`; `worker.js` carries a comment pointing there. The bundled `signalling-v0.wasm` is the **raw** 181 292-byte WASM (the 181 332-byte `build/freenet/zbterm_signalling` is fdev's package: 8 version bytes + 32-byte code hash + WASM); its BLAKE3 `617fca0e…1dc7` equals the hash in fdev's header. `engine/package.json#files` was not changed: the existing `backends/` entry already covers `backends/freenet/contracts/`. `FREENET_ONLY` in the boundary test gained `bs58`, `bare-ws`, `bare-encoding`. `routeFor` before `start` throws `E_BACKEND_UNAVAILABLE` `'no transport key'` (Pear's works before start) — `F6`/`F9` must call it after `start`. `diagnostics().node.version` and `wsRttMs` stay `null` in F3 (`rttMs()` exists and is tested); design §10's version pin is not implemented (not in F3's steps).
- **Gotchas hit:** `freenet local` exits 1 (`Configuration directory not found`) unless config/data/log dirs exist — `test/helpers/freenet-node.js` creates them. npm saved the four packages as carets in `optionalDependencies` (lockfile root lists exact versions under `dependencies`); left as npm wrote it. The SDK's 30 s request timers are cleared by `close()`, which rejects everything pending — always close the client or the process lingers.
- **Measured (2026-09-24, reported):** installed `@freenetorg/freenet-stdlib` 0.4.0, `bs58` 6.0.0, `bare-ws` 3.2.0, `bare-encoding` 1.0.3 (transitives `base-x` 5.0.1, `flatbuffers` 25.9.23, `ws` 8.21.3; `bare-fs` 4.7.1 unchanged; `bare-ws`/`bare-encoding` declare no `engines`, deps need Bare ≥ 1.20 → OK on 1.27.0). Extraneous packages 18 → 0; top-level `node_modules` 628 → 615. Bare test: worker reply 411–478 ms, whole test ≈ 0.56 s. Node smoke: WS open 42 ms, Put 125 ms, Get RTT 1.44 ms, closed-port rejection 1.7 ms.
- **Files touched:** new `engine/backends/freenet/{blake3,bare-shims,node-client,contracts}.js`, `engine/backends/freenet/contracts/{signalling-v0.wasm,hashes.json}`, `test/helpers/freenet-node.js`, `test/backends/{freenet-client,freenet-bare}.test.js`, `test/fixtures/freenet-bare-entry.js`; rewritten `engine/backends/freenet/index.js`; edited `engine/worker.js` (comment), `engine/package.json`, `forge.config.js`, `package.json`, `package-lock.json`, `test/backend-boundary.test.js`, `test/backends/registry.test.js`, `README.md` (row dropped + dated note), `docs/CORE-CONTRACT.md` (two dated blockquotes), `docs/projects/260918_backend-abstraction/open-issues.md` (dated note on rows 9, 10), `docs/register.md` (`S-18` fixed).
- **Removed assertions (V-7):** `test/backends/registry.test.js`: '…Freenet is probe only…' → '…not yet wired…' (`detail`/`availability()` expect `'not yet wired'`; "declares HISTORY_OFFLINE_HOST" became "absent"); 'the Freenet stub has the backend shape and refuses to start' **removed** (asserted `start()` rejects `'probe only'` and the require list was exactly `['events','../../errors','../types']`) and replaced by 'the Freenet backend has the backend shape and shares nothing yet'; 'acceptance: share.backends lists freenet as broken / probe only' → '/ not yet wired'. `test/backend-boundary.test.js`: `[['freenet','broken','probe only']]` → `'not yet wired'`.
- **`TEMPORARY` markers now in `engine/`:** 8 — `contracts.js` (until F5); `index.js` `availability` (F9), `announce`/`withdraw`/`dial` (F6), `setAdmission` (F7), `serveHistory`/`attachHistory` (F8).
- **npm commands run:** `npm install --save-optional @freenetorg/freenet-stdlib@0.4.0 bs58@6.0.0 bare-ws@3.2.0 bare-encoding@1.0.3` (once); `npm view`, `npm ls`, `npm test`, `npm run lint`, `npx prettier`, `npx lunte`, `npx brittle-node`.
- **Next free:** `S-19` / `D-16`. Suite **367 / 2273**, 98 warnings.

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
$ npm test    → exit 0; # tests = 367/367 pass; # asserts = 2273/2273 pass; # ok; 8 "ok N - freenet…" lines, none skipped
$ npx brittle-node test/backends/freenet-bare.test.js   → # asserts = 4/4 pass; # ok (≈ 457 ms)
$ npm run lint   → exit 0; 98 warnings
$ grep -rn ZBTERM_FREENET_EXPERIMENTAL engine electron renderer test README.md docs/CORE-CONTRACT.md → exit 1
$ grep -rn 'TEMPORARY(until F' engine | wc -l   → 8
$ npm ls --depth=0 2>&1 | grep -c extraneous     → 0
$ tail -1 docs/register.md   → | S-18 | fixed 2026-09-24 (F3) | …
$ ps -p 1938466   → up (2-17:13:32)
```
Processes: Bare workers only via `spawnWorker` (pids 3741640, 3757199, destroyed by `worker.destroy()`); `freenet local` only via `test/helpers/freenet-node.js` on free ports, stopped by exact child pid; one diagnostic `freenet local` (pid 3741480) exited by itself; no pattern kills.

---

## Phase F1: The remote test host, by recipe

**Goal.** `scripts/infra/freenet_host.py` provisions a network-mode Freenet node and Node.js on a
remote machine, idempotently, everything under `~/work/zbterm`; run once against `hetzner-deb16`,
it leaves a node that has peers and answers its WebSocket API. Written for Debian and Fedora, tested
on Debian.

**Requirements & inputs.** `R-2`, `Q-1`, `Q-9`, `A-2`, `A-3`, `A-4`, `A-15`. Read
`/ubitron/dev/ubitron/envs/doc/ubitron_fabric_skill.md` first, whole: one command per `self.bash()` /
`self.sudo()`, branching in Python, no host name in the file, argparse `__main__` with a required
positional `host`, steps return JSON values, completed steps are skipped on re-run, detectors for
output. Host facts (2026-09-24): Debian 13.7, user `zeev`, passwordless sudo, no `node`/`cargo`/
`freenet`, `nft` input policy accept, `Linger=no`, public IPv4 directly on `enp1s0`. Release assets:
`https://github.com/freenet/freenet-core/releases/download/v<ver>/{freenet,fdev}-x86_64-unknown-linux-musl.tar.gz`
and `SHA256SUMS.txt` (v0.2.136 verified 2026-09-24). Node: `https://nodejs.org/dist/v24.<x>/node-v24.<x>-linux-x64.tar.xz`
and `SHASUMS256.txt` (pick the latest 24.x; record it). Probe code to sync: `spikes/freenet/`
without `node_modules` and `.node-data`.

**Steps.**
1. Create `scripts/infra/__init__.py` (empty) and `scripts/infra/freenet_host.py` with two tasks:
   - `FreenetHost(Task)`, typed fields with argparse flags: `version` (default `"0.2.136"`),
     `node_version` (default the 24.x you picked), `work_dir` (default `~/work/zbterm`),
     `ws_port` (7509), `network_port` (31337). Steps, in this order: `detect_os` (read-only;
     `/etc/os-release` `ID` → `debian`|`fedora`, anything else raises), `base_packages`
     (`apt-get install -y curl tar xz-utils rsync ca-certificates` or `dnf install -y curl tar xz
     rsync ca-certificates`), `make_dirs` (`bin freenet/config freenet/data freenet/log node tmp
     spikes repo` under `work_dir`), `fetch_release` (download `SHA256SUMS.txt` and the two
     tarballs into `tmp`, `sha256sum -c --ignore-missing`, extract into `bin`, `bin/freenet
     --version` must contain `version`), `install_node` (tarball + `SHASUMS256.txt` check, extract
     into `node`, `node/bin/node --version`), `write_unit` (`sudo tee` of
     `/etc/systemd/system/freenet-node.service`: `User=zeev`, `WorkingDirectory=<work_dir>/freenet`,
     `ExecStart=<work_dir>/bin/freenet network --config-dir … --data-dir … --log-dir …
     --ws-api-port <ws_port> --network-port <network_port>` plus the flag that disables auto-update
     (read `bin/freenet network --help`; record the exact flag), `Restart=on-failure`,
     `RestartSec=5`, `Environment=PATH=…`), `enable_start` (`daemon-reload`, `enable --now`),
     `wait_ws` (`@Task.step(retries=12, retry_delay=5)`: `ss -ltn` shows `:<ws_port>`),
     `wait_peers` (`retries=24, retry_delay=5`: `journalctl -u freenet-node --since -10min` contains
     a line proving a connection to a gateway or peer — find the exact wording from the owner's
     node log under `~/.local/state/freenet/` and match it with a detector), `firewall_facts`
     (read-only: `nft list ruleset` has no `drop` policy on input; record).
   - `SyncProbes(Task)`, run against `local`, field `target` (an ssh alias, required flag), steps:
     `rsync` of `spikes/freenet/` to `<target>:~/work/zbterm/spikes/freenet/` excluding
     `node_modules`, `.node-data`, `out`, `contracts/*/target`; then `ssh <target>` one command:
     `cd ~/work/zbterm/spikes/freenet && PATH=~/work/zbterm/node/bin:$PATH npm ci` (a single
     command string is one `self.bash`).
   `__main__`: argparse with positional `host`, `--task {host,sync}` (default `host`), one flag per
   typed field; `SyncProbes` uses `host` as `target` and runs locally.
2. Run `FreenetHost` against `hetzner-deb16`; on a failing step fix the step and re-run (the runtime
   resumes). Then run `SyncProbes`.
3. Prove the node is on the network: `ssh hetzner-deb16 'cd ~/work/zbterm/spikes/freenet &&
   PATH=~/work/zbterm/node/bin:$PATH node p2-network-get.js 7509'` must print the JSON with
   `"getMissing": "rejected: Contract not found"` within 60 s (on 0.2.135 it took 4.7 s; a
   local-mode or peerless node never answers).
4. Document the recipe at the top of the file (usage with `HOST`, what it writes where, Debian
   tested / Fedora untested) and add a short "Remote test host" section to `README.md`'s
   development notes pointing at it.

**Acceptance criteria.** Two consecutive runs of `FreenetHost` succeed, the second skipping every
step; `freenet-node.service` is `active`, `bin/freenet --version` = 0.2.136; `p2-network-get.js`
prints `Contract not found`; nothing outside `~/work/zbterm`, the unit file and the packages
changed on the remote; the recipe contains no host name (`grep -n hetzner scripts/infra/` empty);
`npm run lint` unaffected (Python is outside its globs).

**Verification.**
```
PYTHONPATH=/ubitron/dev /zp/zdata/work/ubitron/dev/.venv/bin/python scripts/infra/freenet_host.py hetzner-deb16            # all steps ok
PYTHONPATH=/ubitron/dev /zp/zdata/work/ubitron/dev/.venv/bin/python scripts/infra/freenet_host.py hetzner-deb16            # every step skipped
PYTHONPATH=/ubitron/dev /zp/zdata/work/ubitron/dev/.venv/bin/python scripts/infra/freenet_host.py hetzner-deb16 --task sync
ssh hetzner-deb16 'systemctl is-active freenet-node; ~/work/zbterm/bin/freenet --version'          # active / 0.2.136
ssh hetzner-deb16 'cd ~/work/zbterm/spikes/freenet && PATH=~/work/zbterm/node/bin:$PATH node p2-network-get.js 7509'   # Contract not found
grep -rn hetzner scripts/infra/ ; echo "exit $?"                                                     # exit 1
```

**Gotchas.** The tarball may nest the binary in a directory: list it before extracting. Without
`--ws-api-address`, `freenet network` binds the API to all interfaces on a public host: pass
`--ws-api-address 127.0.0.1` explicitly (the help text says so). UDP `network_port` must be reachable
from the internet; the host's `nft` is open but a Hetzner Cloud firewall (outside the VM) may not be —
if `wait_peers` never fires while the log shows outbound attempts, that is an owner action, not a
recipe bug; report it. `npm ci` of the spike on the remote pulls `@roamhq/wrtc` and `werift` too; if
either fails to install, write `spikes/freenet/remote-package.json` with only what `p2-*`/`p7-*` need
(SDK, `bs58`, `node-datachannel`, `hypercore`, `@hyperswarm/secret-stream`, `streamx`) and use it
there, and say so. The fabric run store is under `$XDG_STATE_HOME/ubitron`; `--runs` lists runs. Do
not run one-off `ssh` commands to explore the host: write the step, run it.

**Re-planning signals.** No release tarball for the pinned version → pin to the newest and note that
the two nodes differ in version (`F2` must then report both). The node cannot get peers from
`hetzner-deb16` at all → `F2` cannot run; stop and report.

> **2026-09-24 (F1 gate, orchestrator).** The acceptance criterion "the second run skipping every step" cannot hold with the ubitron runtime as installed: the default `om` rail keeps the run store in memory, and the persistent `om2` rail (`UBITRON_OM_TYPE=om2`) crashes before the first step with `TypeError: unsupported operand type(s) for +=: '_NotHereType' and 'int'` in `ubitron/om2/ext/tasks.py::UBTask.restart` (`n_restarts`), reproduced on a one-step local task. The recipe is idempotent instead: a second run executes every step read-only and reports `kept: True` / `changed: False` in ≈ 7 s. Recorded as a **named exception pending the owner's sign-off**; nothing in this project depends on step skipping. The two directories the first runs leaked outside `~/work/zbterm` (`~/.npm` from `npm ci`, `~/.cache/freenet` from the node) had their causes fixed in the recipe (`--cache` under `tmp`, `XDG_CACHE_HOME` in the unit) and were removed by the orchestrator with one `ssh hetzner-deb16 'rm -rf ~/.npm ~/.cache/freenet'` after inspecting them; `~/.cache` itself pre-existed (KDE) and stays.

### F1 — The remote test host, by recipe (retired 2026-09-24; one named exception)

- **Decisions (executor, no `D-nn`):** `wait_peers` reads `<work_dir>/freenet/log/*.log` (files changed in the last 10 min), not `journalctl` (with `--log-dir` the journal holds only `Started…` and rate-limit lines); the unit's `User=` comes from `id -un`; work dirs gained `freenet/cache` and the unit sets `XDG_CACHE_HOME` there; a read-only `footprint` step lists what changed in `$HOME` outside the work dir; the node is restarted only when the unit file changes; `_ptask_step_wait_s = 1800` because `wait_peers` retries back off to 60 s; the sync step's `npm ci` uses `--cache ~/work/zbterm/tmp/npm-cache`. **Named exception (pending the owner's sign-off):** "second run skips every step" is unattainable — ubitron's `om2` rail crashes (`UBTask.restart`, `_NotHereType += int`), the default rail has no persistent store; the recipe is idempotent (all steps `kept`, ≈ 7 s) instead. `open-issues.md` must carry it.
- **Gotchas hit:** release tarballs hold the bare binary at top level with mode 0644 (recipe `chmod`s); `--ws-api-address 127.0.0.1` still also binds `[::1]:7509`; `npm --version` needs the new node on `PATH`; `/tmp/.ironfabric/*.log` is write-only, read with `sudo tail`; the first `wait_peers` (journal-based) hit the runtime's 600 s step wait.
- **Measured (2026-09-24):** Node **v24.21.0** (latest 24.x, 2026-09-07), npm 11.19.0; freenet 0.2.136 (7fa2c6605b99), fdev 0.3.298, checksums OK; auto-update flag **`--disable-auto-update`**; peer wording matched **`add_connection: successfully added to ring`** (`freenet::ring::connection_manager`); ring connections logged 34 at ≈ 10 min, 42 at ≈ 16 min, 59 at ≈ 35 min; install → WS listening 22 s; `p2-network-get.js` `Contract not found` in 8127 / 2652 / 8698 ms (WS open 72 / 45 / 42 ms); remote `npm ci` 136 packages in 5 s (`@roamhq/wrtc` and `werift` installed, no `remote-package.json` needed); nft: three input hooks, all `policy accept`; no Hetzner cloud firewall in the way.
- **Files touched:** `scripts/infra/__init__.py` (new), `scripts/infra/freenet_host.py` (new: `FreenetHost`, `SyncProbes`), `README.md` ("Remote test host" under "For Developers"), `baseline.md` (dated F1 section appended).
- **Removed assertions:** none.
- **Remote state:** `freenet-node.service` active as `zeev`, WS `127.0.0.1:7509`, UDP 31337, everything under `~/work/zbterm` (+ the unit, apt packages); `~/.npm` and `~/.cache/freenet` removed.
- **Next free:** `S-19` / `D-16`. Suite unchanged (367 / 2273 after F3).

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
$ …/python scripts/infra/freenet_host.py hetzner-deb16   → exit 0; every step "kept"/"changed: False"; wait_peers ring_connections_logged 59; footprint outside_work_dir ['/home/zeev/.cache'] (pre-existing dir, mtime touched by the cleanup)
$ ssh hetzner-deb16 'systemctl is-active freenet-node; ~/work/zbterm/bin/freenet --version'   → active / Freenet version: 0.2.136 (7fa2c6605b99)
$ ssh hetzner-deb16 '… node p2-network-get.js 7509'   → {"port":7509,"wsOpenMs":42.11,"getMissing":"rejected: Contract not found","getMissingMs":8698}
$ grep -rn hetzner scripts/infra/   → exit 1
$ ssh hetzner-deb16 'ls -d ~/.npm ~/.cache/freenet'   → both "No such file or directory"
$ UBITRON_OM_TYPE=om2 … t_om2.py local   → TypeError in ubitron/om2/ext/tasks.py::restart (the named exception)
```
Commands the orchestrator ran on the remote: the recipe run above, the two verification `ssh` lines, one inspection `ssh … 'ls -la ~/.npm ~/.cache; du -sh …'`, one cleanup `ssh … 'rm -rf ~/.npm ~/.cache/freenet'`. No signals sent anywhere.

---

## Phase F2: Real-network measurements (design F0)

**Goal.** `measurements.md` answers, with p50/p95 from two network-mode nodes on two hosts, the
questions that can overturn the design: how long until a freshly put instance is readable from the
other node, put→notification latency across the network in both directions, offer→connected time
through the contract with the default STUN list, and which candidate type carried the connection.

**Requirements & inputs.** `R-1`, `Q-1` (consent to `Put` through `127.0.0.1:7509`), `Q-4` (the STUN
list), `A-5`, `S-04`, design §1, §2, §9 and the F0 row of §12. Code to build on:
`spikes/freenet/p4.js` (put→notification and offer→connected on one node),
`spikes/freenet/lib/fnet.js` (`connect`, `contractKey`, `putRequest`), `spikes/freenet/lib/rtc.js`
(`libs`, `sdpFingerprint`), `spikes/freenet/contracts/signalling/build/freenet/zbterm_signalling`
(the probe contract; unsigned entries are fine for a measurement). Hosts: this machine (NAT,
`10.9.8.216`) with the owner's node on 7509; `hetzner-deb16` (public address) with the F1 node on 7509
and the synced spike under `~/work/zbterm/spikes/freenet`.

**Steps.**
1. Write `spikes/freenet/p7-network.js` with two roles. `host <port> <nonceB64> [rounds]`: puts a
   fresh instance of the probe contract (nonce in `params`), subscribes, prints `{ instance, putMs }`,
   then answers every viewer entry with an update and, when an `offer` arrives, runs the
   node-datachannel answerer with ICE servers from `--ice` (default the `Q-4` list). `viewer <port>
   <instanceId>`: polls `Get` on the instance until it exists, printing `firstGetMs` and the number of
   misses; subscribes; sends `rounds` updates at 1 Hz and 5 Hz recording put→notification (its own
   put to the host's ack update) p50/p95; then runs the offerer through the contract and prints
   `offerToConnectedMs`, `signallingMessages`, `selectedPair` (local/remote candidate types from
   `pc.getSelectedCandidatePair()` or the equivalent), and 20 ping RTTs over the channel. Both roles
   print one JSON object per measurement and exit 0. Every timer uses `performance.now()`.
2. Sync it (`SyncProbes`), then run direction A: host on `hetzner-deb16`, viewer here (this is the
   product's common case: a host anywhere, a viewer behind NAT). Run direction B: host here, viewer
   on `hetzner-deb16`. Three runs per direction, fresh nonce each; keep every JSON line under
   `measurements/` beside this plan.
3. STUN: run direction A again with `--ice ''` (host candidates only) and record whether it connects
   at all; then with the default list. NAT↔NAT is **not** available with this pair (the remote has a
   public address); write that sentence in `measurements.md`. If time allows, put the viewer on the
   remote inside a network namespace behind a masquerade (`ip netns`, veth, `nft masquerade`) and
   record that as the NAT↔NAT case; otherwise "not measured".
4. Write `measurements.md`: a table per question with p50/p95/n, host/viewer placement, node
   versions on both ends, ICE list used, candidate pair, and the raw file names. Append to
   `docs/register.md` a dated `S-04` row with the numbers ("network hop measured: …").
5. Record each decision the numbers force as a dated blockquote in the later phase it changes (see
   signals).

**Acceptance criteria.** `measurements.md` has every table filled from ≥ 3 runs per direction;
offer→connected p95 with the default STUN list is recorded; `firstGetMs` is recorded with the miss
count; the raw JSON files exist; the `S-04` row is appended; the owner's node was used through its
WebSocket only (no restart, `ps -p 1938466` unchanged); no entry names the owner.

**Verification.**
```
ls docs/projects/260924_freenet-backend/measurements/*.json | wc -l      # ≥ 6
grep -c '^| ' docs/projects/260924_freenet-backend/measurements.md         # tables present
tail -2 docs/register.md                                                   # the S-04 row
ps -p 1938466 -o pid,etime                                                 # unchanged
```

**Gotchas.** `Get` of an instance the network has not propagated yet: on 0.2.135 a network node
answered `Contract not found` after 4.7 s; poll with a 1 s gap and a 120 s cap, count the misses.
Entries expire after `ttl_ms` (120 000 in `params.json`); a slow round can lose them. Both nodes'
clocks matter only for relative timings: measure each latency on one machine (viewer put → viewer
notified of the host's ack) so no clock skew enters. node-datachannel's selected-pair API name differs
by version: read `spikes/freenet/node_modules/node-datachannel/API.md`. Never `Put` with the same nonce
twice (`S-05`(b)).

**Re-planning signals.** offer→connected p95 > 10 s → `F6` pre-publishes the host's offer at
`announce` (design §12 F0) — add the dated blockquote to `F6` before retiring `F2`. `firstGetMs` p95
> 30 s or misses until the 120 s cap → `F6`'s `dial` needs a poll-with-cap on the instance, and
`announce` must resolve only after a read-back from a second node is impossible to require, so
`health()` reports "announced, propagation unverified"; write it into `F6`. Host-candidates-only
connects across the internet → note it; the STUN default still stands (`D-11`). Default-list runs
never connect from the NAT side → stop and report: the design's premise fails.

### F2 — Real-network measurements (retired 2026-09-24; ran beside F4)

- **Decisions (executor, no `D-nn`):** each signalling message is its own `Update`, applied in sequence order; the host acks all new viewer entries of one notification in a single update; put→notification is a round trip on the viewer's clock (viewer put → notification of the host's ack), "own echo" recorded beside it; the remote reads the fdev package minus its 40-byte header and checks the embedded code hash (`SyncProbes` excludes `target/`). No F6 blockquote needed. Design §1 caveat 1, §9 and §3's "not measured" pipe cost got dated blockquotes (orchestrator, F2/F4 numbers).
- **Gotchas hit:** this machine has Tailscale/Docker/libvirt interfaces → 8 host candidates, none selected; cross-host wall-clock differences are clock offset (+9…+14 s / −3…−6 s), unusable; `firstGetMs` cannot resolve propagation faster than the few-second gap before the viewer starts; node-datachannel 0.33.4's call is `pc.getSelectedCandidatePair()`; one 5 Hz ack outlier of 19 056 ms (B-default-1).
- **Measured (2026-09-24, both nodes 0.2.136 7fa2c6605b99; Node v24.18.0 here, v24.21.0 remote; reported, not gated):** A = host on `hetzner-deb16`, viewer here (NAT); B = reverse. `firstGetMs` p50/p95 A 5 172 / 5 795 ms, B 372 / 1 854 ms, **0 misses in 9 of 9**. put→notification 1 Hz p50/p95 A 1 148 / 1 525 ms, B 724 / 815 ms; 5 Hz A 1 405 / 3 100 ms, B 894 / 1 094 ms (n = 90 each, 0 lost). offer→connected with the `D-11` list p50/p95 A **1 691 / 2 137 ms**, B 1 182 / 1 301 ms; 13–16 signalling messages; selected pair A viewer `srflx` → host `host`, B viewer `host` → host's NAT mapping as `prflx`, IPv4 UDP, never IPv6/Tailscale/relay; ping RTT p50 63–74 ms. Host candidates only: connected 2 of 2 (1 448, 1 570 ms) because one end is public; `D-11` stands. **NAT↔NAT not measured.**
- **Files touched:** `spikes/freenet/p7-network.js` (new), `measurements.md` (new), `measurements/*.json` (9), `docs/register.md` (`S-04` closed), design doc §1/§9 (blockquotes by the orchestrator).
- **Removed assertions:** none. **Signals:** none fired except "host-only connects" (noted, no change).
- **Next free:** `S-19` / `D-16`. Suite unchanged.

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
$ ls docs/projects/260924_freenet-backend/measurements/*.json | wc -l   → 9
$ grep -c '^| ' docs/projects/260924_freenet-backend/measurements.md     → 57
$ tail -1 docs/register.md   → | S-04 | closed 2026-09-24 (F2) | …
$ ps -p 1938466 -o pid,etime   → 1938466  2-17:34:58
$ grep -rn -i 'owner|zeev' measurements/ measurements.md   → only "the owner's node" descriptions, no identity in any entry
```
Processes: one scratch `freenet local` on 7531 (pid 3772952, SIGTERM by pid after `ps -p`); local role processes and six/three remote `ssh hetzner-deb16 '… p7-network.js host|viewer …'` runs, all exited 0 by themselves; `SyncProbes` once; no pattern kills, no netns/nft.

---

## Phase F4: The `BACKEND_*` seam and the host WebRTC adapter (design F2, §3.1)

**Goal.** Seven new frame kinds carry peer connections between the worker and the host; the host
owns them in `electron/rtc-host.js` on `node-datachannel`; the worker drives them through
`engine/backends/freenet/rtc-remote.js`; a host without the adapter makes the backend report why.
Binary frames survive the round trip, and the pipe's throughput on this path is measured.

**Requirements & inputs.** `R-4`, `D-06`/`D-09`, `A-8`, `A-9`, design §3.1 (the frame table), §3
(the "host has no WebRTC adapter" rule, the back-pressure note), `S-06`, `S-07`. Code:
`engine/rpc/schema.js` (`FrameKind` 0–14, `BODY_CODECS`, `optional()`, the `SessionData` codec as
the model for a buffer body), `docs/CORE-CONTRACT.md` §3 table and `test/core-contract.test.js`
(every `FrameKind` name must appear in the doc), `engine/client.js::EngineClient` (`constructor`,
`_spawnWorker` argv, `_onFrame` switch, `_sendPtyData`'s pause/`drain` handling),
`engine/worker.js` (argv reads, the `pipe.on('data')` dispatch), `engine/index.js::SessionEngine`
constructor (`opts.backendLimit`, `opts.ptyHost` → the new `opts.rtcHost` and `opts.hostCaps`),
`engine/share-manager.js::_ensureBackend` → `registry.create(id, { limit, options })`,
`engine/backends/index.js::{load, resolve, create}`, `electron/engine-lifecycle.js::_wireEngine`,
`electron/pty-host.js` (the shape of a host adapter), `spikes/freenet/lib/rtc.js::pairNodeDatachannel`
(how the probe drove node-datachannel), `test/backend-boundary.test.js::FREENET_ONLY`.

**Steps.**
1. `npm install --save-optional node-datachannel@0.33.4` at the root; add it to
   `forge.config.js::BUILD_BACKENDS.freenet.dependencies`; note the platform package npm chose
   (`@node-datachannel/linux-x64-gnu`, `A-9`).
2. `engine/rpc/schema.js`: append `BACKEND_OPEN: 15, BACKEND_SIGNAL: 16, BACKEND_STATE: 17,
   BACKEND_CHANNEL: 18, BACKEND_DATA: 19, BACKEND_FLOW: 20, BACKEND_CLOSE: 21` with codecs exactly
   per design §3.1 (`connId` and `chanId` as `c.uint`; strings for `type`, `sdp`, `candidate`,
   `mid`, `state`, `localFingerprint`, `remoteFingerprint`, `pathKind`, `label`, `op`, `reason`,
   with `optional()` where the table says optional; `data` as `c.buffer`; `paused` as `c.bool`;
   `iceServers` as `optional(c.json)`). `docs/CORE-CONTRACT.md` §3: seven rows with direction and
   body, plus a paragraph naming this project. `test/core-contract.test.js` stays green;
   add codec round-trip tests for the seven kinds in `test/backend-frames.test.js`.
3. `electron/rtc-host.js::RtcHost extends EventEmitter`: `open(connId, { iceServers })` creates a
   `PeerConnection` (node-datachannel) and emits `signal` for the local description and each
   candidate, `state` on ICE/DTLS changes with `localFingerprint`, `remoteFingerprint`
   (`pc.remoteFingerprint()`) and `pathKind` from the selected pair; `signal(connId, msg)` applies a
   remote description or candidate; `openChannel(connId, chanId, label)`, `send(connId, chanId,
   buffer)` (returns `false` above the 1 MiB high-water mark and emits `flow` paused/resumed on
   `onBufferedAmountLow`), `close(connId, reason)`; incoming channels emit `channel` `opened`;
   messages emit `data`. Maximum message size 65 536 (`S-07`). `DEFAULT_ICE_SERVERS` lives here
   (`F9` wires the setting). `RtcHost.available()` returns `true` when `node-datachannel` loads,
   else `false` with the error (the Electron host constructs it only if available).
4. `engine/client.js`: accept `rtcHost` (optional); spawn argv gains a 5th element `hostCaps`
   (`'rtc'` when `rtcHost` is present, else `''`) after `backend`; `_onFrame` dispatches
   `BACKEND_OPEN/SIGNAL/CHANNEL/DATA/CLOSE` to `rtcHost` and forwards its `signal/state/channel/
   data/flow/close` events as frames; `BACKEND_DATA` toward the worker honours the pipe's `false`
   write by emitting a `flow` pause to the host adapter and resuming on `drain` (mirror
   `_sendPtyData`). `docs/CORE-CONTRACT.md` §3 "Sidecar launch": the 5th argv, "an older host that
   passes none means no capabilities".
5. `engine/worker.js`: read `Bare.argv[6]` as `hostCaps`; when it lists `rtc`, construct
   `engine/backends/freenet/rtc-remote.js::RtcRemote(send)` (the `PtyRemote` pattern: the same event
   API as `RtcHost`, every call a frame, `handleFrame(frame)` for the five inbound kinds) and pass
   `{ rtcHost: rtcRemote, hostCaps }` into `SessionEngine`; dispatch the inbound kinds to it.
   `SessionEngine` hands `rtcHost` to `ShareManager`, which passes it in `options` to
   `registry.create` (`_ensureBackend`), so `FreenetBackend` receives it in its constructor (`F3`'s
   option).
6. Registry: `engine/backends/index.js::load(id, ctx)` calls `Backend.availability(ctx)`; `resolve`
   and `create` take `ctx.hostCaps`; `ShareManager` passes `hostCaps` through. `FreenetBackend
   .availability({ hostCaps })` returns `{ state: 'broken', detail: 'host has no WebRTC adapter' }`
   when `rtc` is missing (this replaces nothing: the `TEMPORARY(until F9)` `'not yet wired'` stays
   as the outer answer until `F9` — order: no adapter first, then not-yet-wired).
7. `electron/engine-lifecycle.js::_wireEngine`: construct `RtcHost` when `RtcHost.available()` and
   pass it as `rtcHost`. `test/backend-boundary.test.js`: `node-datachannel` may be required under
   `engine/backends/freenet/` **or** by `electron/rtc-host.js` (one named host file, the way the
   removed updater-stack rule named its owner); every other `FREENET_ONLY` package keeps the old
   rule. Name the rule change in the handoff.
8. Tests: `test/rtc-host.test.js` (Node): two `RtcHost` instances wired by an in-process signalling
   relay connect on loopback with `iceServers: []`, open a channel, echo 1 000 binary messages of
   65 536 bytes intact (compare hashes), `flow` fires at least once under a 64 MiB burst, `state`
   reports fingerprints and `pathKind: 'host'`, `close` ends cleanly.
   `test/backend-seam.test.js`: `EngineClient` with a fake pipe (no worker) receives a `BACKEND_OPEN`
   frame and calls `rtcHost.open`; an `rtcHost` `data` event becomes a `BACKEND_DATA` frame with the
   bytes intact; without `rtcHost` the spawn argv's 5th element is `''`, with it `'rtc'`.
   `test/backends/registry.test.js`: `availability({ hostCaps: '' })` → `'host has no WebRTC
   adapter'`.
9. Measure the pipe: a fixture worker `test/fixtures/rtc-echo-worker.js` (spawned by
   `spawnWorker`, a real sidecar) that sends `BACKEND_DATA` frames of 65 536 bytes as fast as the pipe
   allows for 16 MiB and echoes what it receives; a script `scripts/measure-seam.js` (not a test)
   prints MiB/s worker→host and host→worker. Record both in the handoff (reported, not gated).

**Acceptance criteria.** `FrameKind` 0–14 unchanged (the `core-contract` test and a `git diff` of
those lines); 15–21 documented; all new tests green; the boundary test green with the amended rule;
`npm run lint` exit 0; seam throughput recorded in MiB/s in both directions.

**Verification.**
```
npm test 2>&1 | grep -E 'rtc|seam|frames|# (tests|pass|fail)'
npx brittle-node test/core-contract.test.js
node scripts/measure-seam.js            # prints {"workerToHostMiBps":…, "hostToWorkerMiBps":…}
git diff -U0 engine/rpc/schema.js | grep -E '^[-+].*(PTY_|INVOKE|REPLY|EVENT_)' ; echo "exit $?"   # exit 1: kinds 0–14 untouched
```

**Gotchas.** node-datachannel must be `initLogger`/`cleanup`-ed per its API or the test process
never exits; call `nodeDataChannel.cleanup()` in teardown. The 65 536 cap is per message
(`S-07`); the framer in `F8` cuts, `RtcHost.send` only refuses. `bufferedAmountLow` needs
`setBufferedAmountLowThreshold` set before the burst. Under Node 24 `Module._resolveFilename` stubs
need `require.cache` eviction (`S-12`) if a test simulates a missing `node-datachannel`. Electron's
main process loads N-API 8 addons; nothing to rebuild, but `F9` must prove the packaged app resolves
`@node-datachannel/linux-x64-gnu`.

**Re-planning signals.** Seam throughput < 2 MiB/s in either direction → `F8`'s 1 MiB/s gate is at
risk; profile the framing (`FramedStream` + `compact-encoding` copies) before `F8` and note it there.
`pc.remoteFingerprint()` is unavailable or empty → `F6`'s step 5 falls back to the SDP fingerprint
and the in-band challenge (design §6 last paragraph); write it into `F6` now.

### F4 — The `BACKEND_*` seam and the host WebRTC adapter (retired 2026-09-24; ran beside F2)

- **Decisions (executor, no `D-nn`):** the worker obtains `RtcRemote` through `engine/backends/index.js::rtcRemote(send)` (guarded literal require, `null` in a build without Freenet) because only the registry may require into a backend directory; `FreenetBackend.availability(ctx)` answers `'host has no WebRTC adapter'` when `hostCaps` is a string without `rtc`, skips the check when `hostCaps` is undefined (`registry.available()`), `ShareManager` defaults `hostCaps` to `''`, `SessionEngine` derives `'rtc'` from `opts.rtcHost`; `BACKEND_STATE` fingerprints/`pathKind` and `BACKEND_CHANNEL.label` are `optional()`, `mid` is a string; `RtcRemote.handleFrame` handles all six host→worker kinds; `pathKind` = local candidate type, or `relay` if either end is a relay; remote-opened channels get `chanId ≥ 2^31` (`REMOTE_CHANNEL_BASE`), worker-chosen ids stay below; `RtcHost` also has `closeChannel`, `pause`/`resume`, `closeAll`, `static loadError()`, `static cleanup()`; `EngineClient` without `rtcHost` answers `BACKEND_OPEN` with `BACKEND_CLOSE 'host has no WebRTC adapter'` and calls `rtcHost.closeAll('worker exited')` on exit; `DEFAULT_ICE_SERVERS` = the `D-11` list; `engine/package.json` unchanged (node-datachannel is a host dependency); `RtcHost.send` throws `RangeError` above 65 536 bytes; the new kinds/codecs are added with `Object.assign` after the `FrameKind`/`BODY_CODECS` literals so lines 0–14 stay byte-identical.
- **Gotchas hit:** `node-datachannel.cleanup()` is global (run once, last test of `rtc-host.test.js`); loading the module alone does not keep Node alive; npm wrote `^0.33.4`, left as written. The executor ran one `timeout 120 npx brittle-node …` (never fired; a rule breach, noted).
- **Measured (2026-09-24, reported):** seam, 16 MiB in 65 536-byte frames through a real sidecar, 5 runs: worker→host 327–411 MiB/s, host→worker 60–115 MiB/s, echo byte-identical; platform package `@node-datachannel/linux-x64-gnu@0.33.4`; extraneous 0 → 0, top-level `node_modules` 615 → 617; `RtcHost` loopback connect ≈ 20–30 ms, 1 000 × 64 KiB echo ≈ 2.6–3.1 s, 64 MiB burst `send() === false` 990×, flow paused then resumed; `pc.remoteFingerprint()` present (`sha-256 …`) and equal to the peer's SDP fingerprint; a one-byte change of the offer's `a=fingerprint` made both sides `failed` after ≈ 1 010 ms with no channel (scratch script, not a test) — libdatachannel refuses a mismatched certificate; whether the accessor is handshake-derived is not separately proven (F6's negative (i) settles it).
- **Files touched:** new `electron/rtc-host.js`, `engine/backends/freenet/rtc-remote.js`, `test/{rtc-host,backend-seam,backend-frames}.test.js`, `test/fixtures/rtc-echo-worker.js`, `scripts/measure-seam.js`; edited `engine/rpc/schema.js`, `engine/client.js`, `engine/worker.js`, `engine/index.js`, `engine/share-manager.js`, `engine/backends/index.js`, `engine/backends/freenet/index.js`, `electron/engine-lifecycle.js`, `forge.config.js`, `package.json`, `package-lock.json`, `test/backends/registry.test.js`, `test/backend-boundary.test.js`, `docs/CORE-CONTRACT.md` (7 rows + 2 blockquotes).
- **Removed/changed assertions (V-7):** `registry.test.js` 'acceptance: … broken / not yet wired' → '… / host has no WebRTC adapter (not yet wired with one)' (detail/message now `'host has no WebRTC adapter'`; gains a check that with an `rtcHost` it still says `'not yet wired'`); 'the limit reaches the worker as the 4th spawn argument' expects 5 argv elements (trailing `''`). `backend-boundary.test.js`: `'not yet wired'` → `'host has no WebRTC adapter'`; **boundary rule change:** new test 'node-datachannel is required only under engine/backends/freenet/ or by electron/rtc-host.js' (`RTC_HOST` the one named host owner); the engine-only `FREENET_ONLY` rule unchanged.
- **npm commands:** `npm install --save-optional node-datachannel@0.33.4` (once); `npm ls`, `npm test`, `npm run lint`, `npx prettier`, `npx brittle-node`.
- **Next free:** `S-19` / `D-16`. Suite **388 / 2452**, 98 warnings. `TEMPORARY` markers in `engine/`: 8.

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
$ npm test   → exit 0; # tests = 388/388 pass; # asserts = 2452/2452 pass; # ok; 18 "ok N - rtc-host|backend seam|backend frames" lines
$ npx brittle-node test/core-contract.test.js   → # tests = 3/3 pass; # asserts = 32/32 pass; # ok
$ node scripts/measure-seam.js   → {"workerToHostMiBps":411.37,"hostToWorkerMiBps":115.18,"bytesEachWay":16777216,…,"echoIntact":true,"messageBytes":65536,"workerPid":3799702}
$ git diff -U0 engine/rpc/schema.js | grep -E '^[-+].*(PTY_|INVOKE|REPLY|EVENT_)'   → exit 1
$ npm run lint   → exit 0; 98 warnings
$ npm ls --depth=0 | grep -c extraneous   → 0;  grep -c BACKEND_ docs/CORE-CONTRACT.md → 19;  TEMPORARY markers in engine → 8
```
Processes: Bare workers only through `spawnWorker` (measure-seam pids 3780981, 3781179, 3781213, 3791527, 3799702 — all exited on pipe end); no signals sent; no Electron launched.

---

## Phase F5: The contracts, shipped as bytes (design F3, §5, §7)

**Goal.** Two Rust contracts exist in the repo with their compiled `.wasm` committed and hash-pinned:
the production signalling contract (signed entries, per-key quota, reserved host share, canonical
form, TTL) and the pointer record. Both pass `fdev verify-merge` with 0 violations; the key is shown
reproducible, or not, on a second host and toolchain; `routeFor` mints `ptr`.

**Requirements & inputs.** `R-5`, `Q-3`/`D-10`, `A-12`, design §5 (route, §5.1 checks, §5.2 pointer),
§6 (the `Entry` shape `{ l, r, s, t, d, p, g }` and the signed bytes), §7 (the layers). Code:
`spikes/freenet/contracts/signalling/` (`Cargo.toml` pinning `freenet-stdlib = "=0.10.0"`, `src/lib.rs::
{Entry, Wire, Params, Signalling}`, `params.json`, `freenet.toml`, the `states/` fixtures P-5 used),
`docs/projects/260918_backend-abstraction/probes.md` §P-5 (`fdev build` needs the `contract`
feature; the hashed code is the **raw** `.wasm`, not `build/freenet/`'s versioned package;
`fdev get-contract-id` cross-check), `engine/backends/freenet/contracts.js` and `contracts/` from
`F3`, `engine/backends/freenet/blake3.js`, `scripts/infra/freenet_host.py` (add a `RustToolchain`
task), `test/backends/freenet-client.test.js`.

**Steps.**
1. Move the contract sources into the product tree: `engine/backends/freenet/contracts/src/signalling/`
   (from the spike; keep `Cargo.lock`) and a new `…/src/pointer/`. One `Cargo.toml` per crate, no
   workspace file above them. Leave the spike copy in place (it is the P-5 artefact; `S-14` covers
   its shipping).
2. Signalling v1 (`src/signalling/src/lib.rs`): `Entry { l, r, s, t, d, p, g }` per design §6; the
   contract verifies `g` as an ed25519 signature over `"zbterm/fnet-signal/1" ‖ sig ‖ l ‖ r ‖ s ‖ t
   ‖ d ‖ p` under the key named in `r` (`v:<hex>`) or under `params.host` (`h:<hex>`), using the
   `ed25519-compact` crate (no_std-capable, small; record the crate and version); rejects unsigned or
   mis-signed entries in `validate_state`, `validate_delta` and the merge; per-`v:` key quota 16 live
   entries; `h:` entries in a reserved 64 of the 512 cap; canonical form (sorted by `(r, s)`, expired
   entries dropped by `t + ttl_ms` against the newest `t` seen, never wall-clock); payload cap 16 KiB.
   `Params { ttl_ms, host, n }`.
3. Pointer v1 (`src/pointer/src/lib.rs`): state `{ ver, sig, code, params, g }` signed by
   `params.host` (same crate); highest valid `ver` wins; `Params { host }`. Deliberately tiny; a
   comment says its code is meant never to change.
4. `scripts/build-contracts.sh`: for each crate `fdev build --features contract` (or the flag P-5
   used), copy the **raw** `.wasm` from `target/wasm32-unknown-unknown/release/` to
   `engine/backends/freenet/contracts/<name>-v1.wasm`, write `hashes.json` `{ "<name>-v1": { "blake3":
   hex, "bytes": n } }` with `node -e` over `blake3.js`, and cross-check each id with `fdev
   get-contract-id`. Run it. Delete `signalling-v0.wasm` and its `TEMPORARY(until F5)` markers;
   `contracts.js` loads `signalling-v1` as `current` and `pointer-v1`.
5. `fdev verify-merge` on both crates with the spike's `states/` fixtures extended by: a mis-signed
   entry, a replayed `(r, s)`, a 17th entry for one key, a 65th `h:` entry. Record cases/held/
   violations.
6. Reproducibility: add `RustToolchain(Task)` to `scripts/infra/freenet_host.py` (rustup via the
   official script into `~/.cargo`, `rustup target add wasm32-unknown-unknown`, pin the toolchain to
   the local `rustc --version`; `fdev` is already in `bin/`), run it on `hetzner-deb16`, rsync the
   two crates to `~/work/zbterm/contracts/`, build there with the same script, and compare
   `hashes.json`. Record "identical" or the two hashes. Measure signature verification cost: time a
   `Put` of 64 signed entries against a local-mode node, before and after the signature check (build
   a check-less variant only in the scratchpad), report ms per entry.
7. `engine/backends/freenet/route.js`: `mint(linkId, hostKey, contracts)` → `{ sig, code, params,
   ptr, k }` (design §5; `ptr` is the pointer instance id for `{ host }`), `verify(route,
   expectedPeerKey, contracts)` → the §5.1 checks, throwing `E_BACKEND_UNSUPPORTED` for an unknown
   `code`; `routeFor` uses `mint`. `F6` puts the pointer's state at `announce`.
8. Tests: `test/backends/freenet-contracts.test.js` — every file in `hashes.json` exists, its BLAKE3
   matches, its size matches (this is the pin); `route.mint`/`verify` round trip; `verify` rejects a
   changed `sig`, a foreign `host`, an unknown `code`. Update `test/backends/freenet-client.test.js`
   for `ptr`.

**Acceptance criteria.** `fdev verify-merge`: 0 violations on both crates, cases counted; the pin
test green; `grep -rn 'TEMPORARY(until F5)'` empty; `hashes.json` built on `hetzner-deb16` recorded
(equal or not, with both toolchain versions); verification cost recorded in ms per entry; `npm test`
green; `npm run lint` exit 0.

**Verification.**
```
bash scripts/build-contracts.sh                  # rebuild; then
git status --porcelain engine/backends/freenet/contracts/   # only intended changes (bytes identical on a rebuild)
(cd engine/backends/freenet/contracts/src/signalling && fdev verify-merge 2>&1 | tail -2)
(cd engine/backends/freenet/contracts/src/pointer && fdev verify-merge 2>&1 | tail -2)
npx brittle-node test/backends/freenet-contracts.test.js
grep -rn 'TEMPORARY(until F5)' engine ; echo "exit $?"     # exit 1
```

**Gotchas.** Any source edit moves the key (P-5): finish the source, then build, then pin; a later
"tiny fix" is a new version (`-v2`) that keeps `-v1` bytes in the tree. `fdev build` writes a
versioned package under `build/freenet/`; the node hashes the raw `.wasm`. `opt-level = "z"`, `lto`,
`codegen-units = 1`, `panic = "abort"`, `strip` are what made P-5 reproducible; keep the profile
byte for byte. ed25519 verification inside `validate_state` runs on every merge; keep the entry cap.
`rustup` on the remote changes only `~/.cargo` and `~/.rustup` — outside `~/work/zbterm`; set
`CARGO_HOME` and `RUSTUP_HOME` under `~/work/zbterm/rust` in the task instead (`A-4`).

**Re-planning signals.** Hashes differ across hosts with the same pinned toolchain → the pointer
record becomes the *only* address a viewer trusts: `F6`'s `dial` always reads `ptr` first; add the
blockquote there. Verification cost > 50 ms per entry → lower the entry cap to 128 and say so in
`A-12`'s blockquote. `ed25519-compact` will not compile to the contract target → `ed25519-dalek`
with `default-features = false`; record.

### F5 — The contracts, shipped as bytes (retired 2026-09-24)

- **Decisions (executor, no `D-nn`):** entries are signed over the instance's raw **parameter bytes**, not `sig` (a contract cannot know its own instance id), binary and length-prefixed: `"zbterm/fnet-signal/1" ‖ lp(params) ‖ lp(l) ‖ lp(r) ‖ u32le(s) ‖ u64le(t) ‖ u8(d) ‖ lp(p)` — supersedes "canonical JSON" in F6 step 1; `r` = `v:`/`h:` + 64 lowercase hex, `g` = 128 hex; crate `ed25519-compact =2.4.2` (`default-features = false`) compiled to wasm32 first try; freenet-stdlib 0.10.0 has no `validate_delta`, deltas are checked in `update_state`; bounds: 16 live entries per `v:` key, `v:` share 448 of 512, `h:` 64, oldest-first eviction by `(t, key)`, map keyed `(l, r, s)`; pointer state empty or `{ver, sig, code, params (text), g}`, highest `(ver, g)` wins, unknown parameter fields ignored; `route.ptr` is the pointer for `{ host }` (one per host key — F6 must decide `{ host, n }` before the first pointer `Put`, see the F6 blockquote); `route.verify` errors: malformed → `E_CORRUPT`, wrong host → `E_AUTH`, `sig` mismatch → `E_CORRUPT`, foreign `ptr` → `E_CORRUPT`, unknown code → `E_BACKEND_UNSUPPORTED`, returns `{code, wasm, params}`; `contracts.js` exports `known` (signalling versions), `current`, `pointer`; `scripts/build-contracts.sh` sets `RUSTFLAGS=--remap-path-prefix=$CARGO_HOME=/cargo`; Forge ignores `/engine/backends/freenet/contracts/src` (pinned by a build-variants test); `.gitignore`/`.prettierignore`/`.lunteignore` cover the crates; `scripts/contract-fixtures.js` writes deterministic fixtures + a JS signer (`entryBytes`, `signEntry`).
- **Gotchas hit:** the as-planned build embedded absolute `$CARGO_HOME` paths → the key depended on the builder's home (P-5 missed it); the remote build needed a C linker (`RustToolchain` now installs `gcc`, `libc6-dev`); a refused `Put` is never answered (**`S-19`**, new); the plan's bare `fdev verify-merge` errors (`--wasm is required unless --bundle is given`) — the script runs it with `--wasm … --params … --state states/*`; `lunte` parses `.json` under `engine/` (empty `p0.json` needed an ignore entry).
- **Measured (2026-09-24):** verify-merge signalling 414 cases / 350 held / **0 violations** / 64 inconclusive (= the mis-signed fixtures, "input not valid"); pointer 85 / 56 / 0 / 29. Before remap: local vs remote 241 108 vs 241 324 B (signalling), 187 504 vs 187 720 B (pointer); after remap **identical on both hosts**: `signalling-v1` 240 972 B `01c8bdcb…08d5`, `pointer-v1` 187 376 B `ff6ce19f…6fcb` (rustc 1.95.0 59807616e, cargo 1.95.0, fdev 0.3.298 on both). Signature check cost: `Put` of 64 signed entries (29 127 B) median 97.16 ms vs 43.49 ms check-less (9 runs each) = **0.84 ms per entry** (reported).
- **Files touched:** new `engine/backends/freenet/route.js`, `contracts/{.gitignore,signalling-v1.wasm,pointer-v1.wasm}`, `contracts/src/{signalling,pointer}/…`, `scripts/build-contracts.sh`, `scripts/contract-fixtures.js`, `test/backends/freenet-contracts.test.js`; rewritten `contracts.js`, `contracts/hashes.json`; edited `engine/backends/freenet/index.js`, `test/backends/freenet-client.test.js`, `test/build-variants.test.js`, `forge.config.js`, `.prettierignore`, `.lunteignore`, `scripts/infra/freenet_host.py` (`RustToolchain`, `SyncContracts`, `--task rust|contracts`), `README.md`; deleted `signalling-v0.wasm`; dated blockquotes in design §5, §5.1, §5.2, §6, §7, probes.md §P-5, parent open-issues row 40; F6 blockquote in this plan; `S-19` appended.
- **Removed assertions (V-7):** `freenet-client.test.js` 'the bundled signalling contract matches its recorded hash' **removed** (asserted the old `manifest.files` format and "181292, the B8 probe contract, byte for byte"; the pin test replaces it, raw-WASM magic check kept); 'route shape (no ptr before F5)' → 'route shape', now expects `ptr`.
- **Signals:** cross-host hash difference **fired and was removed at its cause** (path remap); `dial`-reads-`ptr`-first is left to F6. Cost > 50 ms/entry and ed25519-compact signals did not fire.
- **Next free:** `S-20` / `D-16`. Suite **392 / 2503**, 98 warnings. `TEMPORARY` markers in `engine/`: 7.

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
$ bash scripts/build-contracts.sh   → exit 0; signalling-v1: 240972 bytes, id 8wwAiLJ46cw14WznXjjQarTbTxezLpjAkrLghY5Ld3Dz (fdev agrees); 414 cases, 350 held, 0 violations; pointer-v1: 187376 bytes, id 3UrEasgoRG5HdP2Y8v44qiJCbGcjj8cdNnDPMsEW7fHb (fdev agrees); 85 cases, 56 held, 0 violations
$ diff hashes.json (before/after rebuild)   → identical
$ git status --porcelain --untracked-files=all engine/backends/freenet/contracts/   → only .gitignore, hashes.json, the two -v1.wasm and the crate sources/fixtures (untracked; F3 never committed the dir)
$ (cd …/src/signalling && fdev verify-merge)   → "Error: --wasm is required unless --bundle is given" — the plan's line cannot run on fdev 0.3.298; the script's invocation above is the gate
$ npx brittle-node test/backends/freenet-contracts.test.js   → 4/4 tests, 47/47 asserts
$ grep -rn 'TEMPORARY(until F5)' engine   → exit 1;  markers left: 7
$ ssh hetzner-deb16 'cat …/hashes.json'   → byte-identical to the local file
$ npm test   → exit 0; # tests = 392/392 pass; # asserts = 2503/2503 pass
$ npm run lint   → exit 0; 98 warnings;  ps -p 1938466 → up
```
Processes: `cargo`/`fdev` builds locally and on the remote (`ssh hetzner-deb16 '… bash scripts/build-contracts.sh'` ×3, `--task rust` ×4, `--task contracts` ×2); `freenet local` only via `test/helpers/freenet-node.js` (pids 3816853, 3823278, stopped by the helper's child handle); no signals by pattern; the remote node never restarted; nothing written outside `~/work/zbterm` on the remote (checked with `find -newer`).

---

## Phase F6: Announce, withdraw, dial, connection, and the handshake (design F4, §6)

**Goal.** A viewer's `dial` reaches a host's `announce` through the contract and comes up as an
authenticated peer connection, or fails for the right reason. Tampered, wrong-key and replayed
answers never surface a connection. `revokeLink` withdraws.

**Requirements & inputs.** `R-6`, `R-8` (the withdraw part), `A-10`, `A-11` is `F9`'s, `S-05`,
`S-08`/`D-04`, `S-09` (Freenet refusals are not sticky), design §4 rows `announce`, `withdraw`,
`dial`, `'connection'`, `setAdmission` (its placement only; limits are `F7`), §6 (sequence 1–5 and
the fallback), §7 layer 2, the `F2` blockquotes below this section if any. Code: `F3`'s
`node-client.js`, `F4`'s `rtc-remote.js`/`RtcHost`, `F5`'s `route.js` and `contracts.js`,
`engine/backends/pear/index.js` (`dial` returning `{ connected, cancel }`, the `'connection'` event
object, the `'debug'` shape), `engine/backends/types.js` (the `PeerConnection` typedef:
`remotePeerKey`, `path()`, `openChannel`, `onChannel`, `close`, `'path'`), `engine/crypto.js`
(`transportKeyPair`, sodium helpers), `engine/share-manager.js::revokeLink`, `test/backends/
conformance.js` cases 1–3 ('start opens no swarm…', 'announce then dial connects…', 'a wrong
expectedPeerKey never yields a connection'), `test/helpers/freenet-node.js`.

**Steps.**
1. `engine/backends/freenet/signal.js`: sign/verify entries per design §6 with `sodium-native`
   (`crypto_sign_detached` over the concatenation; a fixed domain string); encrypt/decrypt `p` with
   `crypto_secretbox` under a key derived from `k` (`crypto_generichash(k, 'zbterm/fnet-payload/1')`);
   `re = blake3(offer ciphertext)`; canonical JSON for the signed bytes.
2. `announce(linkId, { route, tag })`: `Get` the instance first (short cap), `Put` only on a miss
   with an empty canonical state, subscribe via the `S-05` workaround; put the pointer record's state
   for `route.ptr` the same way; keep `{ instance, subscription, seqSeen: Map<r, s> }`; resolve.
   `withdraw(linkId)`: unsubscribe, write tombstones (`d: true`) over own `h:` entries, decrement
   `announced`, idempotent. Live connections survive.
3. `dial(route, expectedPeerKey, { signal, tag })`: pin the key synchronously; `route.verify`; if the
   `code` is unknown read `ptr` and re-verify (§5.2); subscribe to the instance (poll-with-cap if `F2`
   said so); `rtcHost.open(connId, { iceServers })`; on the local offer, sign, encrypt and put it
   under `v:<own key>`; accept an `h:` entry only if `g` verifies under `expectedPeerKey` and `re`
   matches; apply it; on `state connected` compare `remoteFingerprint` with the fingerprint inside the
   verified SDP; mismatch → close, reject `E_AUTH`; match → resolve `connected` with a
   `PeerConnection` whose `remotePeerKey` is the signing key and emit `'connection'` with the same
   object. `cancel()` and `signal` tombstone the offer and `close` only if nothing was surfaced.
   Pre-publish the host's offer at `announce` only if `F2`'s blockquote demands it.
4. Host side: on each notification de-duplicate by `(r, s)`, verify `g` under the key in `r`, run
   the admission policy on that key (a key pinned by an active `dial` is always admitted), then
   `rtcHost.open` + apply the offer, sign and put the answer under `h:<viewer key>` with `re`; on
   `connected` run the same fingerprint check; emit `'connection'` with `info: { linkId }`.
5. `PeerConnection` object: `remotePeerKey`, `path()` from the last `pathKind` (`host/srflx/prflx` →
   `DIRECT`, `relay` → `RELAY`), `'path'` on change, `close()`, `openChannel`/`onChannel` stubs that
   throw `E_INTERNAL('channels arrive in F7')` **`TEMPORARY(until F7)`**.
6. `engine/share-manager.js::revokeLink`: after the record is marked revoked, `await
   backend.withdraw(linkId)` (errors → `'debug'`, never thrown). `A-10`.
7. Tests, `test/backends/freenet-backend.test.js`, each with a local-mode node and two in-process
   `RtcHost` instances (`A-8`): announce → dial → `'connection'` on both sides with the right keys and
   `path()`; `diagnostics().announced` 1 → 0 across `withdraw`, idempotent; after `withdraw` a fresh
   dial never connects within 5 s while the existing connection still passes a `state` check;
   **negatives**: (i) a relay in the test that flips one hex digit of `a=fingerprint:` in the answer
   before it is applied → `connected` rejects `E_AUTH` and no `'connection'` fires; (ii) an answer
   signed by a third key → ignored, counted in `diagnostics().refused`, no connection within 5 s;
   (iii) the previous run's signed answer re-put for a new offer → ignored (wrong `re`); (iv)
   `setAdmission(() => false)` on the host → no `rtcHost.open` on the host side, no answer written;
   then `setAdmission(() => true)` and the *same* viewer key connects (not sticky, unlike `S-09`).
   Conformance cases 1–3 pass when run through a local `run()` harness limited to them (a file under
   `test/backends/` that is **not** `*.test.js` until `F8`: `conformance-freenet.js`,
   `TEMPORARY(until F8)`).
8. `docs/CORE-CONTRACT.md`: `E_AUTH` for a fingerprint mismatch on a Freenet join; the `'connection'`
   info shape.

**Acceptance criteria.** Every test in step 7 green and run (not skipped); `AUTHENTICATED_PEER` in
`CAPABILITIES` only after (i)–(iii) pass, with a comment citing this phase; `npx brittle-node
test/backends/conformance-freenet.js` shows cases 1–3 passing; `npm test` green; lint exit 0;
`node-datachannel`'s `remoteFingerprint()` shown handshake-derived (test (i) fails the connection)
or the fallback in place and named.

**Verification.**
```
npx brittle-node test/backends/freenet-backend.test.js      # all ok, negatives included
npx brittle-node test/backends/conformance-freenet.js 2>&1 | grep -E 'conformance|# (pass|fail)'
npm test 2>&1 | tail -3
grep -n AUTHENTICATED_PEER engine/backends/freenet/index.js  # with the F6 citation
```

**Gotchas.** Every notification is the whole state (`S-05`(d)): de-duplicate before verifying, or a
busy mailbox costs one signature check per entry per update. Signature bytes must be identical on
both ends: one canonical serialiser, tested against a fixture. `JOIN_TIMEOUT_MS` in ShareManager is
30 s; a local-mode node never answers a `Get` miss, so the announce-side `Get`-first path needs its
own cap (`F0`'s (c) figure). Tests that assert "never connects" must first prove a permitted dial
connects on the same node (the conformance suite's `GRACE_MS` rule). Close every `RtcHost` and call
`cleanup()` or brittle hangs.

**Re-planning signals.** (i) passes without any fingerprint check of ours (the library already
refuses) → keep step 5 anyway (belt and braces) and record that the library enforces it. (i) still
connects with our check bypassed and `remoteFingerprint()` equals the tampered SDP → the accessor is
SDP-derived: implement the in-band challenge (design §6 last paragraph) in this phase before claiming
`AUTHENTICATED_PEER`. Offer→answer through a local-mode node > 5 s → the test caps move up, never
the product's.

> **2026-09-24 (F5 executor) — for F6.** (1) **Re-planning signal fired, then removed at its cause.**
> F5's first cross-host build gave different hashes with the same pinned toolchain (rustc 1.95.0
> 59807616e, cargo 1.95.0, fdev 0.3.298 on both): signalling 241 108 vs 241 324 bytes, pointer
> 187 504 vs 187 720, because the WASM embeds `$CARGO_HOME` source paths. `scripts/build-contracts.sh`
> now remaps them (`--remap-path-prefix=$CARGO_HOME=/cargo`) and the two hosts build identical
> `hashes.json` (`signalling-v1` `01c8bdcb…08d5`, `pointer-v1` `ff6ce19f…6fcb`). The plan's consequence
> ("`dial` always reads `ptr` first") is therefore not forced by the evidence for a builder that uses
> the script; it still holds for any build that bypasses it or uses another rustc (not measured).
> Whether `dial` reads `ptr` first anyway is F6's call. (2) The entry signature is **not** over `sig`
> (a contract cannot know its instance id) but over the instance's raw parameter bytes, length-prefixed
> and binary, not canonical JSON: step 1's "canonical JSON for the signed bytes" is superseded by
> `engine/backends/freenet/contracts/src/signalling/src/lib.rs`'s module comment;
> `scripts/contract-fixtures.js::{entryBytes, signEntry}` is a JS signer the contract accepts. `r` is
> `v:`/`h:` plus 64 lowercase hex characters; `g` is 128 hex characters. (3) `route.ptr` is the pointer
> instance for `{ host }`: one pointer per host key, so step 2's "put the pointer record's state for
> `route.ptr`" at every `announce` would make every link of a host overwrite one record (highest
> `ver` wins). The pointer contract ignores unknown parameter fields, so `mint` can move to
> `{ host, n }` without new pointer code; decide before the first pointer `Put`. (4) A `Put` whose state
> the contract refuses is never answered (`S-19`): a mis-signed or over-quota write looks like a slow
> node. Cap every `Put`; do not wait for an error. (5) Quota per `v:` key is 16 live entries and the
> `v:` share 448: a viewer that writes more loses its oldest entries, silently.

### F6 — Announce, withdraw, dial, connection, and the handshake (retired 2026-09-24; one re-dispatch)

- **Decisions:** **`D-16`** (orchestrator, `docs/decisions.md`): revocation's guarantee is backend-neutral (late join `failed`, nothing confirmed, no bootstrap/session data), its mechanism backend-defined — Pear and the loopback stay reachable by peer key after `withdraw` and deny in-band (`host:join-deny invalid-or-revoked`); Freenet becomes unreachable and the join ends in a backend error. `revokeLink` awaits `backend.withdraw(linkId)` (errors → `'debug'` `host:withdraw:error`; reads `_backend` so revoking never activates a backend). `LoopbackHub.members` keeps every announced, unstopped backend and `resolve` falls back to a started member holding the key. The revoked-link conformance case accepts path (a) in-band denial or (b) a failed join with an error code (`t.comment` records which); loopback and Pear take (a). Executor decisions: `ptr` is one pointer per link, params `{ host, n }` (`route.pointerParamsBytes(host, n)`); `dial` reads `ptr` only on `E_BACKEND_UNSUPPORTED`, verifies the record under the expected key, re-verifies the named route; negative (i): **node-datachannel refuses the tampered certificate itself during DTLS** (rejection `E_HOST_UNREACHABLE` `ice-failed`, never `connected`), our fingerprint check stays as a second check and is tested separately (`E_AUTH 'fingerprint mismatch'`); `l` is a random per-dial connection id, messages within 25 ms batch into one sealed entry `{cid, re?, m}`; `re` = BLAKE3 of the offer entry's `p`; payload key `crypto_generichash(out, 'zbterm/fnet-payload/1', key = k)`; a route naming another host stays pending sending nothing (conformance case 3); pre-up failure rejects `E_HOST_UNREACHABLE 'ice-failed'`; `'connection'` info `{ linkId }` host side, `{ linkId: null }` dial side; announce Puts a self-minted route without a `Get`, a stored route gets a 2 000 ms `Get` first; a dial opens chanId 0 `'zbterm/fnet-bootstrap'` because node-datachannel offers only once a channel exists; `conformance.js::run` gained `opts.only`; a second dial does not yet reuse a live connection (F7).
- **Gotchas hit:** SDK 0.4.0 has no unsubscribe (`withdraw` stops reading notifications); the contract refuses an `h:` entry the host didn't sign, so (ii) injects the forged answer through `_onEntries`; on Freenet path (b) currently ends only at `JOIN_TIMEOUT_MS` (ShareManager ignores a rejected dial; a dial on a withdrawn route stays pending) — F7 blockquote; **`S-21`**: one `npm test` crashed in `test/engine-attach.test.js` with `fd-lock` "File descriptor could not be locked" after a 5 s teardown of the previous test (seen once; file green alone; second full run green).
- **Measured (2026-09-24, local-mode node 0.2.136, loopback, host candidates; reported):** announce 188–191 ms (Put + pointer Put + subscribe); dial→connected 167–183 ms; offer written→answer applied 121 ms; tampered-fingerprint dial rejected in 156–170 ms.
- **Files touched:** new `engine/backends/freenet/{signal,connection}.js`, `test/backends/freenet-backend.test.js`, `test/backends/conformance-freenet.js`; edited `engine/backends/freenet/{index,node-client,route}.js`, `engine/backends/loopback.js`, `engine/share-manager.js`, `test/backends/{conformance.js,registry,freenet-contracts,freenet-client}.test.js`, `docs/CORE-CONTRACT.md`, design §4/§5/§6 blockquotes, parent `open-issues.md` row 6, `docs/register.md` (`S-20` open + resolved, `S-21`), `docs/decisions.md` (`D-16`), this plan (F7 blockquote).
- **Removed/changed assertions (V-7):** `registry.test.js` 'announce() says why' expects `'not started'` (was `'not yet wired'`); `freenet-contracts.test.js` `{ host }` → `{ host, n }` (three titles); `freenet-client.test.js` '…{ host } (F5)' → '…{ host, n } (F6)'; `conformance.js` revoked-link case: 'the host denied it because the link is revoked' now accepts in-band denial **or** a backend error (`D-16`), all other assertions unchanged.
- **Next free:** `S-22` / `D-17`. Suite **402 / 2601**, 98 warnings. `TEMPORARY` markers in `engine/`: 6 (availability F9; setAdmission, openChannel/onChannel F7; serveHistory/attachHistory F8).

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
$ npx brittle-node test/backends/freenet-backend.test.js   → 10/10 tests, 98/98 asserts (negatives (i)×2, (ii), (iii), (iv), pointer lookup all ok)
$ npx brittle-node test/backends/conformance-freenet.js    → cases 1–3 ok, 4/4 tests
$ npx brittle-node test/backends/conformance-loopback.test.js   → "# D-16 path (a): host:join-deny invalid-or-revoked"; 14/14 tests, 104/104 asserts
$ npm test   → exit 0; # tests = 402/402 pass; # asserts = 2601/2601 pass (no fd-lock crash in the gate run)
$ npm run lint   → exit 0; 98 warnings
$ grep -n AUTHENTICATED_PEER engine/backends/freenet/index.js   → 79 (F6 citation comment), 85
$ grep -n withdraw engine/share-manager.js   → revokeLink awaits backend.withdraw (D-16 comment)
$ TEMPORARY markers in engine → 6;  Next free S-22 / D-17;  ps -p 1938466 → up;  no `freenet local` left
```
Processes: `freenet local` only via `test/helpers/freenet-node.js` (pids 3842246, 3844104, 3844998, 3845697, 3848262, 3851695, 3851970, 3851982, 3854420, 3854580, 3858532, 3858675, all stopped by the helper); no signals by pattern; no Electron.

---

## Phase F7: Channels, flow control and admission (design F5, §7)

> **2026-09-24 (F6 executor) — for F7, `D-16`.** `revokeLink` now withdraws (`A-10`), and the conformance
> case 'a join on a revoked link is refused and receives no bootstrap or session data' accepts two ways
> to fail (`D-16`): (a) `host:join-deny` `invalid-or-revoked`, which loopback and Pear take, or (b) a
> failed join carrying a backend error. On Freenet the host is unreachable after `withdraw`, so the case
> must end within its bound by path (b). Today the only way the join ends is `JOIN_TIMEOUT_MS` (30 s):
> ShareManager ignores a rejected `dial`, and Freenet's dial on a withdrawn route stays pending.
> F7 may set that case's brittle timeout above `JOIN_TIMEOUT_MS` if needed. Never weaken its
> assertions.

**Goal.** `openChannel`/`onChannel` give ShareManager ordered JSON channels over data channels,
large messages are fragmented and reassembled, back-pressure reaches `send()`, admission and
per-link limits hold, and the conformance suite's channel, back-pressure and admission cases pass on
Freenet.

**Requirements & inputs.** `R-7` (channels, admission), `A-12`, design §4 rows `openChannel`/
`onChannel`, `setAdmission`, §7 layers 3–4, `S-07`, parent `A-10` (JSON channels). Code: `F4`'s
`rtc-remote.js` / `RtcHost` (`openChannel`, `send`, `flow`, `channel`, `data`), `F6`'s
`PeerConnection`, `engine/backends/loopback.js` (its channel object: `send` returning a boolean,
`onmessage`, `onclose`, the `zbterm/ctl` protocol name) and `engine/backends/pear/connection.js`
(protomux channel wrapping) as the two shapes to match, `test/backends/conformance.js` cases 'two
channels on one connection are independent', the back-pressure case (`BURST` = 10 000), "conn.close
fires each channel's onclose once", the admission case (a third peer for the refused half),
`test/backends/conformance-freenet.js` from `F6`.

**Steps.**
1. `engine/backends/freenet/channel.js`: one data channel per `(protocol, id)`, label `protocol + '
   ' + hex(id)`; `send(obj)` → JSON → UTF-8 → parts of ≤ 65 536 bytes with a 5-byte header
   `[flags u8][index u32]` (`flags` bit 0 = last part), returns `false` while paused or closed;
   reassembly in order per channel; `onmessage(obj)`, `onclose()` once; `close()`. Remove the
   `TEMPORARY(until F7)` stubs from `F6`'s `PeerConnection`.
2. `onChannel(handler)` fires from the remote's `BACKEND_CHANNEL opened`, parsing the label back to
   `(protocol, id)`.
3. Flow: `BACKEND_FLOW paused` sets the channel paused; `send` returns `false`; resume emits
   `'drain'` on the channel object if the loopback's shape has one (match it exactly).
4. Admission and limits: `setAdmission(policy)` evaluated on each verified offer (`F6` step 4) with
   `{ remotePeerKey, linkId }`; per-link `MAX_ANSWERS_PER_MINUTE = 30`,
   `MAX_HALF_OPEN = 8` (`A-12`), counters in `diagnostics().links[]`; a refused or over-limit offer
   writes nothing and counts in `refused`.
5. Run `test/backends/conformance-freenet.js` in full; make every non-history case pass. The
   history cases are expected red until `F8` — leave them red, do not skip them; the file stays out
   of `npm test` (`TEMPORARY(until F8)`).
6. Unit tests in `test/backends/freenet-backend.test.js`: a 200 KiB JSON message crosses intact; 10
   000 small messages in a burst arrive in order with at least one `send() === false`; a peer above
   `MAX_HALF_OPEN` gets no answer; a link above `MAX_ANSWERS_PER_MINUTE` gets no answer until the
   window passes (fake the clock, do not sleep 60 s).

**Acceptance criteria.** `conformance-freenet.js`: every case except the history cases passes, the
history cases are the only reds and are listed by name in the handoff; the unit tests green; `npm
test` green; lint exit 0; no `TEMPORARY(until F7)` left.

**Verification.**
```
npx brittle-node test/backends/conformance-freenet.js 2>&1 | grep -E '^(ok|not ok)' 
npx brittle-node test/backends/freenet-backend.test.js
npm test 2>&1 | tail -3
grep -rn 'TEMPORARY(until F7)' engine ; echo "exit $?"      # exit 1
```

**Gotchas.** The conformance burst case waits on the channel's back-pressure semantics as the
loopback defines them; read the case before designing `drain`. A message above 65 536 bytes kills
the channel (`S-07`): the framer cuts *before* `RtcHost.send`. Text vs binary: use binary frames
throughout so the 5-byte header is cheap. Two channels with the same `(protocol, id)` on one
connection is an error, not a reuse.

**Re-planning signals.** The burst case cannot pass without buffering more than 1 MiB in the
worker → raise nothing; report the measured buffer and stop; the pipe's flow design (`F4`) needs a
revisit before `F8`.

### F7 — Channels, flow control and admission (retired 2026-09-24)

- **Decisions (executor, no `D-nn`):** framing `[flags u8][index u32 LE]` + ≤ 65 531 bytes per part, cut in the worker before `RtcHost.send`; channel pairing as the loopback (first opener creates the data channel, worker chanIds from 1, the other side takes it via `onChannel` + `openChannel`; simultaneous opens each send on their own and read both; opening the same key twice on one side throws); bootstrap channel chanId 0 carries nothing and is never surfaced; back-pressure advisory in the loopback's shape (no `'drain'`), `send` returns `false` while `BACKEND_FLOW` has the channel paused or the worker holds ≥ 256 KiB for it (`channel.js::QUEUE_HIGH_WATER`), never drops on an open channel; channel events before surfacing are held and replayed after `'connection'`; admission policy called as `policy(remotePeerKey, { remotePeerKey, linkId })`; `MAX_ANSWERS_PER_MINUTE` 30 over a sliding `ANSWER_WINDOW_MS` 60 s, `MAX_HALF_OPEN` 8, both checked before the policy and applied to pinned keys too; `diagnostics().links[]` gains `answeredLastMinute`, `halfOpen`, `refused`, `conns[].channels` counted; constructor `clock` option; **`S-23`** fixed: `announce`/`dial` await a running `start()` (ShareManager never awaits it); revoked-link case on Freenet ends by `D-16` path (b) at `JOIN_TIMEOUT_MS` (31.1 s), the case's bound is `REVOKED_JOIN_BOUND_MS` = 60 s in `conformance.js`, no assertion changed; `conformance.js::run` turns a thrown case into `t.fail` so later cases still run; the forged-invite fixture forges a non-topic route in the v2 spelling (Pear/loopback bytes identical); a second `dial` still does not reuse a live connection.
- **Gotchas hit:** brittle rethrows a thrown case and stops the file (hence the wrapper); a burst on an already-open channel never trips `send() === false` (≈ 830 KB stays under `RtcHost`'s 1 MiB mark) — the conformance case trips the worker queue mark because it sends before the channel opens; a Freenet link has no `topic` (forged-invite fixture); one leftover `/tmp/zbterm-freenet-node-*` dir removed after a crashed run. **`S-22` (open, security):** no half-open deadline of the backend's own — a slot frees only on cancel, withdraw or ICE failure (≈ 39.5 s), so a holder of the invite can keep all 8 slots with ≈ 12 offers/min; fix in `F9` (see its blockquote).
- **Measured (2026-09-24, local-mode node 0.2.136, loopback; reported):** 200 KiB message send→onmessage 5.0–5.5 ms in 4 parts; 10 000-message burst right after `openChannel` (828 890 B JSON) 255–272 ms = 36 773–39 222 msg/s = 2.91–3.10 MiB/s, `send()` false 7 009×, worker buffer peak **878 890 B** (< 1 MiB); same burst on an open channel 278–313 ms, never false, peak 88 B; a host peer connection given an offer and no candidate went `failed` after 39.5 s.
- **Files touched:** new `engine/backends/freenet/channel.js`; edited `engine/backends/freenet/{connection,index}.js`, `electron/rtc-host.js` (comment), `test/backends/{conformance.js,conformance-freenet.js,freenet-backend.test.js}`, `docs/register.md` (`S-22`, `S-23`; header corrected to `S-24` by the orchestrator), design §4/§7 blockquotes, `docs/CORE-CONTRACT.md` blockquote.
- **Removed/changed assertions (V-7):** `freenet-backend.test.js`: **removed** `t.exception(() => conn.openChannel(...), /channels arrive in F7/)` (behaviour gone); `diagnostics.links` check gains `answeredLastMinute: 1, halfOpen: 0, refused: 0`; `conformance.js`: throw-to-fail wrapper, revoked-link case timeout 60 s, forged-invite fixture; `conformance-freenet.js`: `only` list removed, every case runs, file still out of `npm test` (`TEMPORARY(until F8)`).
- **Next free:** `S-24` / `D-17`. Suite **407 / 2634**, 98 warnings. `TEMPORARY` markers: 3 in `engine/` (`availability` F9; `serveHistory`/`attachHistory` F8) + 1 in `test/`.

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
$ npx brittle-node test/backends/conformance-freenet.js | grep -E '^(ok|not ok)'   → ok 1–8, 10, 13, 15; not ok 9 (serveHistory/attachHistory), 11 (full auto-join), 12 (revoked link), 14 (one viewer, two sessions) — the four history-dependent cases, the only reds
$ npx brittle-node test/backends/freenet-backend.test.js   → 15/15 tests, 131/131 asserts
$ npm test   → exit 0; # tests = 407/407 pass; # asserts = 2634/2634 pass
$ npm run lint   → exit 0; 98 warnings
$ grep -rn 'TEMPORARY(until F7)' engine   → exit 1;  markers left engine+test → 4
$ ps -p 1938466 → up;  leftover /tmp/zbterm-freenet-node-* → 0
```
Processes: `freenet local` only via `test/helpers/freenet-node.js` (e.g. pid 3865333; one SIGKILL by the helper's exit hook of its own child on a crashed run); a scratch `halfopen.js` (bash pid 3871055) exited by itself; no pattern kills; no Electron.

---

## Phase F8: Live history through the seam (design F6, §8.1)

**Goal.** A viewer's session store fills from the host over a dedicated data channel while the host
is online, at ≥ 1 MiB/s measured with the real worker↔host pipe in the path, and the whole
conformance suite passes on Freenet and joins `npm test`.

**Requirements & inputs.** `R-7` (history), `S-07`, parent `A-11`, design §8.1, §4 rows
`serveHistory`/`attachHistory`/`historyRouteFor`. Code: `engine/backends/pear/connection.js::_replicate`
(idempotence by WeakSet; what is replicated: `store.log`, `store.metaCore`), `engine/backends/
loopback.js` (its `attachHistory` returning `{ fetch, close }`, `fetch` =
`store.log.download({ start, end, linear: true })`), `spikes/freenet/p6.js` (the u32-LE framed
streamx `Duplex` over a data channel, cut into ≤ `chunk` messages, wrapped in `NoiseSecretStream`),
`@hyperswarm/secret-stream` (a dependency of `hypercore`; require it by name inside
`engine/backends/freenet/` — check `test/backend-boundary.test.js` does not forbid it),
`test/backends/conformance.js` history cases, `engine/client.js` + `engine/spawn-worker.js` for the
measurement, `F4`'s `scripts/measure-seam.js`.

**Steps.**
1. `engine/backends/freenet/history.js`: `historyStream(conn)` → a streamx `Duplex` over one extra
   data channel `zbterm/history 0`, u32-LE length framing, writes cut at 65 536 − header, reads
   reassembled; `serveHistory(conn, store)` and `attachHistory(conn, store, keys)`:
   `core.replicate(new NoiseSecretStream(isInitiator, duplex))` for `store.log` and `store.metaCore`,
   idempotent per `(conn, store)`; `attachHistory` returns `{ fetch, close }` as the loopback does.
   `historyRouteFor` stays `null` (`D-13`).
2. Rename `test/backends/conformance-freenet.js` → `conformance-freenet.test.js`; remove the
   `TEMPORARY(until F8)` markers. All cases must pass.
3. Measurement through the seam: `scripts/measure-history.js` — two `EngineClient`s in one Node
   process, each with a real sidecar worker (`spawnWorker`), a stub `ptyHost`, and a real `RtcHost`;
   worker A hosts a 16 MiB session store, worker B attaches and `fetch`es it; print MiB/s and
   first-block latency. Run three times; record all three. This is the gate for `R-7`'s 1 MiB/s.
4. Under load, no stall at the message cap: the 512 KiB-block variant (`p6.js`'s `blockBytes`
   argument) also completes.

**Acceptance criteria.** `npm test` includes `conformance-freenet.test.js` and is green with every
case run; the three measurements are all ≥ 1 MiB/s (the lowest is the number recorded); the 512 KiB
variant completes; lint exit 0; no `TEMPORARY(until F8)`.

**Verification.**
```
npm test 2>&1 | grep -E 'freenet backend conformance|# (tests|pass|fail)'
for i in 1 2 3; do node scripts/measure-history.js; done      # three JSON lines, MiBps ≥ 1 each
node scripts/measure-history.js --block 524288                 # completes
grep -rn 'TEMPORARY(until F8)' engine test ; echo "exit $?"    # exit 1
```

**Gotchas.** `core.replicate(isInitiator, rawDuplex)` writes nothing on hypercore 11 (`S-07`): the
`NoiseSecretStream` wrap is mandatory. Back-pressure: honour `BACKEND_FLOW` on the history channel or
the Noise stream buffers without bound. Two sidecar workers in one test process each need their own
`userData` directory and must be closed by `client.close()`, never signalled. `brittle` and long
downloads: set the test's timeout explicitly.

**Re-planning signals.** < 1 MiB/s with the seam but ≥ 10 MiB/s in-process → the pipe is the
bottleneck: measure `FramedStream` copies and the 65 536 message size; try 262 144-byte `BACKEND_DATA`
frames (node-datachannel's cap) before touching anything else; report both numbers; do not lower the
gate.

### F8 — Live history through the seam (retired 2026-09-24; one re-dispatch)

- **Decisions (executor, no `D-nn`):** `engine/backends/freenet/history.js::HistoryChannel extends FreenetChannel` carries raw bytes (parts ≤ 65 536, no F7 part header), reuses F7 pairing/queue/`BACKEND_FLOW`, adds `ondrain`; `connection.js::_openChannel(protocol, id, handlers, Channel)`; history data channel label `zbterm/history 00` (id = one zero byte; "`… 0`" is not valid hex), never surfaced to `onChannel`; `historyStream(conn)` is a streamx `Duplex` with u32-LE frames, one Noise-wrapped stream per connection (dialer = initiator, ephemeral keys) carrying every store, idempotent by a `WeakSet` per connection; `attachHistory` returns `{fetch, close}`; `historyRouteFor` stays `null` (`D-13`); `notYetWired` helper removed; `scripts/measure-history.js` drives `test/fixtures/history-measure-worker.js` through `EngineClient.workerEntrypoint` because the core has no way yet for a host to name a node URL (the real worker would hit the owner's node on 7509) — plain Hypercores in the `{log, metaCore}` shape, first run of the backend's history code under Bare. **Re-dispatch fixes (three races, load-dependent):** (S-26 a) the dialer sends its ICE candidates only after it applied the answer (`index.js::_onRtcSignal`, `ownHeld`) — before, the host reached DTLS before the viewer had the answer's fingerprint (`DTLS alert: unknown CA`, connection `failed`, join hung to `JOIN_TIMEOUT_MS`); backend `RtcHost.signal` calls go through `_signal` (throw → `rtc:signal-error` debug); (S-26 b) own data channels are created only after the bootstrap channel reports open (`connection.js::_bootstrapOpened`), messages queue until then — node-datachannel reports `connected` before pre-SCTP channels open, so an early channel went opened→closed at once; (S-27, present since F7) the opener of every data channel except bootstrap sends nothing until the other side sends one 5-byte `READY` part `[0x02][u32 0]` (`channel.js::READY_PART`) after wiring — messages reaching a remote-opened channel before the receiver's handler was set could come out of order (one 1 021 places late). **Wire change:** `READY` part on every Freenet data channel (documented in `docs/CORE-CONTRACT.md`).
- **Gotchas hit:** **`S-25`** `bare-sidecar`'s `Sidecar` has no `_final`, so a worker never sees its pipe end and every `EngineClient.close()` takes 5 s (pre-existing); **`S-24`** case 6 flaked once in the baseline run (probably S-26 b); enabling node-datachannel's debug logger hides the races; the libdatachannel internals behind S-26 b / S-27 are inferred from event order, not read; a scratch fixture under `/tmp` hangs (the worker cannot resolve modules there); the S-26 test's "host always receives the viewer's candidates" became a `t.comment` (not guaranteed; own new test). **Orchestrator note (2026-09-24 ≈ 18:13 UTC): the owner's node auto-updated itself to 0.2.137 (built 2026-09-24T13:56Z) and restarted under pid 4003927** — nothing of ours touched it; the remote stays pinned at 0.2.136, so `F9`'s cross-machine proof runs 0.2.137 ↔ 0.2.136 and must report both (F1's signal); the plan's `ps -p 1938466` lines are void from here on.
- **Measured (2026-09-24, reported; the 1 MiB/s gate is met):** seam history, 16 MiB of 16 KiB blocks through two real sidecars + a local-mode node: first runs 26.02 / 28.02 / 26.85 MiB/s; after the re-dispatch 24.06 / 23.36 / 25.24 (one run straight after `npm test` 13.95); orchestrator gate 25.68 / 26.06 / 24.46 then 22.63 / 21.86 / 20.92 MiB/s — **lowest recorded 13.95 MiB/s**; first block 47–66 ms; dial→connected 236–322 ms (+≈ 50 ms from the candidate hold); 512 KiB blocks complete at 31.68–38.46 MiB/s, longest gap ≤ 197 ms. Under load (10–12 busy loops on 8 cores) 12 of 12 conformance runs green after the fixes (≈ 1 in 4 failed before). Suite ≈ 178 s; the Freenet conformance file ≈ 42 s, 31 s of it the revoked-link case.
- **Files touched:** new `engine/backends/freenet/history.js`, `scripts/measure-history.js`, `test/fixtures/history-measure-worker.js`; renamed `test/backends/conformance-freenet.js` → `conformance-freenet.test.js`; edited `engine/backends/freenet/{index,connection,channel}.js`, `test/backends/freenet-backend.test.js` (4 new tests: 256 KiB history blocks over `zbterm/history 00`; S-26 two dials from one key both connect and attach history; S-26 channels before bootstrap open; S-27 opener waits for READY); `docs/register.md` (`S-24`…`S-27`, S-23 note, header), `docs/CORE-CONTRACT.md`, design §4/§8.1 blockquotes, `measurements.md` (F8 section + re-measurement paragraph).
- **Removed assertions (V-7):** none (the `'not yet wired'` answer of `attachHistory` had no test).
- **Next free:** `S-28` / `D-17`. Suite **426 / 2762**, 98 warnings. `TEMPORARY` markers: 1 in `engine/` (`availability`, until F9), 0 in `test/`.

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
First gate (before the re-dispatch):
$ npm test run 1   → 422/423: the only red S-03 (`test/engine-extend.test.js` 'copyHistoryFrom returns before the copy…', assert 17), the known intermittent
$ npm test run 2   → crashed: Freenet conformance case 'a single viewer identity can join two sessions…' timed out after 30 000 ms (brittle kills the process)
$ conformance-freenet.test.js alone ×3   → 15/15 each  → RED for the phase, re-dispatched once
Second gate (after the re-dispatch):
$ npm test run 3   → exit 0; # tests = 426/426 pass; # asserts = 2762/2762 pass
$ npm test run 4   → exit 0; # tests = 426/426 pass; # asserts = 2762/2762 pass
$ conformance-freenet.test.js alone ×3   → 15/15 each
$ for i in 1 2 3; do node scripts/measure-history.js; done   → MiBps 22.63 / 21.86 / 20.92 (all ≥ 1), complete:true, metaOk:true
$ node scripts/measure-history.js --block 524288   → complete, 38.46 MiB/s (executor's re-run 31.68)
$ grep -rn 'TEMPORARY(until F8)' engine test   → exit 1;  markers left → 1
$ npm run lint   → exit 0; 98 warnings;  Next free S-28 / D-17;  leftover /tmp/zbterm-freenet-node-* → 0;  no stray `freenet local`/bare processes
$ ps -p 1938466   → gone: the owner's node auto-updated to 0.2.137 and restarted as pid 4003927 (WS 127.0.0.1:7509 listening; `freenet --version` = 0.2.137, build 2026-09-24T13:56Z)
```
Processes: local-mode nodes only via `test/helpers/freenet-node.js` (e.g. 3895563, 3895727, 3895817, 3895934, 3902458, 3902590, 3902768, 3903034); sidecar workers only via `EngineClient` (destroyed by `worker.destroy()` after the 5 s S-25 wait); executor's busy-loop generators (≈ 80 `node load.js`, timed exits); two exact-pid SIGTERMs by the executor on its own hung scratch run (3888257 `freenet local`, 3888245 `node`); 22 leftover temp dirs removed; no pattern kills; no Electron.

---

## Phase F10: Offline history — the time-boxed probe (design F8, §8.2 option A)

**Goal.** Within two working days, either a read-only Hypercore replica has been filled from bytes
that could live in a contract and plays back, or the failure is written down precisely enough that
option B can be planned. Nothing here ships.

**Requirements & inputs.** `R-12`, `D-13`, design §8.2 (options A–D, the abstract-arch §23.8 gates),
parent `open-issues.md` item 41. Code: `hypercore` 11.33.x in `node_modules` (its replication
protocol, `core.replicate`, the storage of tree nodes and the signed tree head — read
`node_modules/hypercore/lib/` before designing), `engine/index.js::_scheduleRemoteHistoryDownload`
(what the viewer reads: `remote.store.log`), `spikes/freenet/p6.js` (the framed duplex and
`NoiseSecretStream` wrap), `test/helpers/freenet-node.js`.

**Steps.**
1. `spikes/freenet/p9-virtual-peer.js`: the host side writes a 1 MiB log and exports, per 64 KiB
   segment, the blocks **plus** the Merkle nodes and the signed tree head needed to verify them
   (find the API: `core.tree`, `core.core.tree`, proof generation used by replication). The viewer
   side creates a read-only replica by key and runs an in-process object that speaks the
   replication protocol to it (`core.replicate(true, duplex)` with the other end driven by our
   code), answering block and proof requests from the exported bytes. Success = the replica's
   `length` reaches the host's, `core.get(i)` verifies for every `i`, and a `download({ start, end
   })` completes without a live host.
2. Put one segment's bytes into a contract instance on a local-mode node and read them back through
   the same path (proves the bytes survive a contract round trip; latency and state size recorded).
3. Write `offline-history-probe.md`: what worked, what did not, the Hypercore internals touched (file
   and symbol), the version fragility, sizes (bytes of proofs per 64 KiB), and the recommendation:
   open A as a follow-on, or open B.

**Acceptance criteria.** `offline-history-probe.md` exists with a verdict and numbers; the probe
code runs to its recorded outcome; no file under `engine/` changed; the box was respected (start and
end dates in the note).

**Verification.**
```
node spikes/freenet/p9-virtual-peer.js            # prints {"verified": n, "length": n, …} or the recorded failure
ls docs/projects/260924_freenet-backend/offline-history-probe.md
git status --porcelain engine/ | wc -l            # 0 new changes from this phase
```

**Gotchas.** Hypercore's proof format is not a public storage format; pin the exact version in the
note. The replication protocol is protomux-based (`protomux` is a dependency of `hypercore`, in every
build); the virtual peer can reuse it. Two days means two days: at the box's end, write the note with
whatever exists.

**Re-planning signals.** None for this project; the verdict feeds `open-issues.md` and the next
project.

### F10 — Offline history, the time-boxed probe (retired 2026-09-24; ran beside F9)

- **Decisions (executor, no `D-nn`):** one binary record per segment cut at the first block boundary ≥ 64 KiB: blocks, the signed head at the segment's end (`writer.state.signature`, 68 B manifest-v1 multisig), "ancestor" nodes crossing the segment start, the tree's full roots the segment lacks, the manifest in segment 0 (70 B); in-segment nodes recomputed by the viewer; a separate block-free tree-index record per segment for sparse fetch; the stand-in peer opens the `hypercore/alpha` protomux channel over a `NoiseSecretStream` pair and answers with `MerkleTree.proof` over a fake session, claiming `downloading: true`; step 2 reuses the P-5 probe contract (JSON, base64 in 12 KiB slices, 6 entries). **Verdict: open option A as a follow-on (`S-28`); B is the fallback.** The follow-on needs an exact `hypercore` pin + a version-bump test, the per-segment index (or power-of-two segments), a binary segment contract meeting §23.8's gates, handling of a failed segment (drop + reopen channel), a decision on encrypting tree metadata, and the same for `metaCore`.
- **Gotchas hit:** the signature is 68 B, not 64; `MerkleTree.proof` is async in 11.33.5; sparse fetch without the index verifies 0 of 168 blocks (byte-cut segments do not align with the tree), with it 168 / 168; one bad block pauses the replica's fetching from that peer (`Peer#_handleData`); the spike resolves its own `node_modules` (protomux 3.12.0 vs root 3.11.0, hypercore-storage 3.3.1 vs 3.1.2; hypercore 11.33.5 in both).
- **Measured (2026-09-24, reported):** proof bytes per 64 KiB 293 / 531 / 623 B (min/p50/max, 1 MiB; ≈ 0.8 %), index record 260 / 586 / 696 B; viewer upgrade 18–26 ms, full 1 MiB download 172–279 ms; 980 / 980 verified (1 MiB), 15 890 / 15 890 (16 MiB), progressive 980 / 980, sparse-with-index 168 / 168, tampered block refused; contract round trip of segment 0: 68 077 B record → 91 085 B state (1.34×), Put 139–225 ms, Get p50 4.2–5.7 ms, bytes identical, 59 / 59 verified, node 0.2.137 local mode. Not measured: segment put→notification latency, state size of a growing session (§23.8 gates). Box: 21:38–21:55 +03:00.
- **Files touched:** `spikes/freenet/p9-virtual-peer.js` (new), `offline-history-probe.md` (new), `docs/register.md` (`S-28`, header `S-29`); by the orchestrator: design §8.2 blockquote, parent `open-issues.md` item 41 note.
- **Removed assertions:** none. **Next free:** `S-29` / `D-17`. Suite unchanged (426 / 2762, not run here).

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
$ node spikes/freenet/p9-virtual-peer.js   → exit 0; {"hypercore":"11.33.5","verified":980,"length":980,"outcome":"A works","contract":{"putMs":225.23,"bytesIdentical":true,"verified":59},"proofP50":530.74}
$ ls docs/projects/260924_freenet-backend/offline-history-probe.md   → present (box 21:38–21:55 +03:00, verdict "open A as a follow-on")
$ git status --porcelain engine/   → only entries left by earlier phases / the concurrent F9; F10 wrote nothing under engine/
$ register: | S-28 | open |; Next free S-29;  leftover /tmp/zbterm-p9-* and node dirs → 0
```
Processes: 13 `node p9-virtual-peer.js` runs (two hung early runs stopped by exact pid after `ps -p`: 4064862, 4066402); `freenet local` only via `test/helpers/freenet-node.js` (4070661, 4071680, 4080174 + the gate's), all stopped by the helper; never port 7509 or 17069.

---

## Phase F9: Product wiring and the default build (design F7; Q-4, Q-5, Q-7, Q-8)

> **2026-09-24 (F8 gate, orchestrator).** The owner's node auto-updated to **0.2.137** and restarted as
> pid **4003927** during F8 (nothing of ours touched it). The remote node stays pinned at 0.2.136. The
> step-7 cross-machine proof therefore runs 0.2.137 ↔ 0.2.136 and `measurements.md` must name both
> versions; if the pair fails to interoperate, that is the finding — do not upgrade the remote or
> touch the owner's node. Every `ps -p 1938466` in this plan now reads `ps -p 4003927`.

> **2026-09-24 (F7 → F9, orchestrator).** Before the default build ships Freenet, close **`S-22`**: the
> backend has no half-open deadline of its own, so a holder of the invite can keep all `MAX_HALF_OPEN`
> = 8 slots of a link with ≈ 12 offers a minute (a slot frees only on cancel, withdraw or ICE failure
> after ≈ 39.5 s). Add to `F9` step 1: a per-link half-open deadline `HALF_OPEN_TIMEOUT_MS` (a named
> constant, 15 000 — `F2` measured offer → connected p95 2.1 s across the internet; `RtcHost.close`
> the connection on expiry and count it in `links[].refused`), plus a per-viewer-key share of the
> half-open slots (2 of 8). A unit test in `test/backends/freenet-backend.test.js` proves a viewer
> holding 2 stale offers cannot block a third viewer, using the `clock` option. Append the `S-22` row
> as fixed in `F9`.

**Goal.** A user of the default package can pick Freenet in the share dialog and share with another
machine; when there is no node or ICE fails they read why; the ICE list is configurable; the package
carries the two new dependencies, the WASM files and the third-party notices; the experimental
switch is gone; a share and join between this machine and `hetzner-deb16` is shown with the shipped
code, and once between two isolated GUI instances.

**Requirements & inputs.** `R-8`, `R-9`, `R-10`, `R-11`, `R-13`, `D-11`, `D-12`, `D-14`, `D-15`,
`A-9`, `A-11`, `A-13`, `A-14`, `A-15`, `S-14`, `S-15` (the packager prunes from the **source**
manifest). Code: `engine/backends/freenet/index.js::availability` (`TEMPORARY(until F9)`),
`engine/backends/index.js::{load, resolve}`, `engine/share-manager.js` (the `share.backends`
handler; find it by the invoke name), `renderer/app.js::{shareBackendPicker, usableShareBackends,
sharingUnavailableNotice, applyShareGating, showShareWizard}`, the settings menu in `renderer/app.js`
(search `settings`), `electron/main.js::CLI_OPTIONS` (`--backend` as the model), `electron/preload.js`,
`electron/rtc-host.js::DEFAULT_ICE_SERVERS`, `electron/engine-lifecycle.js`, `forge.config.js`
(`BUILD_BACKENDS`, `DEFAULT_BUILD_BACKENDS`, `ignoreFile`, `pruneDroppedDependencies`),
`test/build-variants.test.js` ('default variant is pear: freenet is left out…', 'freenet and
pear,freenet variants', the loop over variants), `test/backends/registry.test.js`,
`test/renderer-static.test.js`, `README.md` (env table, flags table, the Freenet paragraph),
`docs/CORE-CONTRACT.md` "Share backends", `package.json#files`, `docs/RELEASE-NPM.md`,
`scripts/infra/freenet_host.py` (a `SyncRepo` task, `A-15`), uisolate (`PYTHONPATH=/ubitron/dev
python3 -m ubitron.envs.uisolate`; verbs `run [--name X] [--new] [--screen WxHxD] -- CMD`,
`screenshot NAME path`, `stop`), the debug-server REST API (`POST /sessions`, `POST
/sessions/:id/share`, `POST /join {"uri"}`, `POST /invoke {"method"}`, `GET /share/diagnostics`,
`GET /renderer/terminal-display`), the previous project's `v4-run.sh` pattern (scratchpad of
2026-09-19; two instances with unique `--storage`, `--electron-user-data`, debug port).

**Steps.**
1. Truthful availability: `availability({ hostCaps })` → `available` when the SDK loads and `rtc`
   is present, else the adapter message; delete the `TEMPORARY(until F9)` branch. `A-11`: the
   `share.backends` handler awaits an optional static `Backend.probe(ctx)` (2 s cap) and overrides
   `state`/`detail` with its answer; `FreenetBackend.probe` opens and closes a WebSocket to
   `nodeUrl` → `{ state: 'broken', detail: 'no Freenet node at ws://127.0.0.1:7509 — see README
   "Freenet"' }` on failure. `create` refuses a broken backend as today.
2. Renderer: `shareBackendPicker` lists **every** backend the core reports, usable ones as radios,
   broken ones as a disabled radio with the `detail` as its text; `usableShareBackends` unchanged;
   `sharingUnavailableNotice` unchanged. A join failing with `detail: 'ice-failed'` or `E_AUTH`
   shows a toast with a plain sentence ("Could not connect directly to the host (ICE failed)";
   "The host's identity did not match the invite"). Strings live beside the existing toast strings.
3. ICE: `electron/main.js::CLI_OPTIONS` gains `--ice-servers <list>` (env `ZBTERM_ICE_SERVERS`;
   the flag wins; format per design §9; `''` disables); a settings field "STUN/TURN servers" in the
   renderer's settings menu, stored with the existing localStorage helper, pushed to the main process
   through a preload method `app.setIceServers(list)` and applied to `RtcHost` for new connections;
   the setting wins over env and flag when non-empty. `describe().capabilities` adds `RELAY` only
   when a `turn:` URL is configured; `diagnostics().ice` lists the servers without credentials.
   README: env row, flag row, one sentence on disclosure to the STUN provider.
4. Default build: `DEFAULT_BUILD_BACKENDS = 'pear,freenet'`; `BUILD_BACKENDS.freenet.dependencies`
   complete (SDK, `bs58`, `bare-ws`, `bare-encoding`, `node-datachannel`); `ignoreFile` keeps
   `engine/backends/freenet/contracts/*.wasm` and `hashes.json` in every variant that has `freenet`;
   `package.json#files` gains `THIRD-PARTY-NOTICES.md`. Update `test/build-variants.test.js`: the
   default is now both (invert 'default variant is pear…' and name it in the handoff), `pear` and
   `none` drop the Freenet set, and a new test proves the `.wasm` files ship with `freenet` and not
   without. `README.md`'s `ZBTERM_BUILD_BACKENDS` row: default `pear,freenet` (dated note).
5. Licences (`D-15`): `THIRD-PARTY-NOTICES.md` at the root — `@freenetorg/freenet-stdlib` 0.4.0
   (npm field `MIT+APACHE-2.0`; repository LGPL-3.0; full LGPL-3.0 text; source URL; "shipped
   unmodified under `node_modules/@freenetorg/freenet-stdlib`"), `node-datachannel` 0.33.4 and
   libdatachannel (MPL-2.0 text and URLs), `freenet-stdlib` crate 0.10.0 and `ed25519-compact` as
   linked into the WASM (their licences, read from their `Cargo.toml`). Draft
   `docs/projects/260924_freenet-backend/upstream-licence-issue.md` (title, body, the two
   contradicting sources quoted). `A-13`: file it only with the owner's go-ahead; otherwise leave
   "drafted" in the report.
6. Package and inspect: `ZBTERM_FORGE_OUT_DIR=<scratch>/f9-default npx electron-forge package`
   (default), then `ZBTERM_BUILD_BACKENDS=pear` and `none` into their own dirs. In each
   `resources/app`: `find` for `node_modules/@freenetorg`, `node_modules/node-datachannel`,
   `node_modules/@node-datachannel`, `engine/backends/freenet/contracts/*.wasm`; in the default,
   `node -e "require('<app>/node_modules/node-datachannel')"` resolves the platform package and the
   SDK loads; sizes of `resources/app` per variant (reported, not gated). Never write to the repo's
   `out/`.
7. Cross-machine proof (`R-13`, `A-15`): add `SyncRepo(Task)` to the recipe (rsync of the tree per
   `A-15`, then `npm ci` on the remote with the bundled Node) and run it. `test/tools/freenet-remote-pair.js
   <role> <nodeUrl> [invite]`: `host` builds a `SessionEngine`-free pair of `FreenetBackend` +
   in-process `RtcHost`, announces a route, prints the invite fields; `viewer` dials it, opens a
   channel, echoes 1 000 messages, attaches a 4 MiB history store and reports MiB/s and the
   candidate pair. Run host on `hetzner-deb16` / viewer here, and the reverse; append the numbers
   to `measurements.md`.
8. GUI proof (`A-14`): two isolated instances of the **default package** from step 6 through
   uisolate, both against the owner's node (WebSocket only), host shares over Freenet (the picker),
   viewer joins the link; `GET /share/diagnostics` on both shows `backend.id === 'freenet'` and one
   connection; a screenshot of the viewer showing the host's output saved as `shots/f9-join.png`,
   with `shots/f9-run.sh` beside it that reproduces the run (unique `--storage`,
   `--electron-user-data`, debug ports, `--no-updates`, a clean `HOME` so no key path shows). Stop
   the instances through uisolate `stop`, never by signal to a pattern.

**Acceptance criteria.** With no node reachable (point `nodeUrl` at a closed port in a test),
`share.backends` lists `freenet` as `broken` with a detail naming the address; with a node,
`available`; the picker shows both states (static asserts in `test/renderer-static.test.js` plus the
GUI run); `--ice-servers ''` yields host candidates only in `diagnostics().ice`; the three packages
inspected as in step 6, the default resolving both dependencies; `THIRD-PARTY-NOTICES.md` in the
default package; the issue drafted (URL if filed); both directions of step 7 connected with numbers;
`shots/f9-join.png` + `shots/f9-run.sh` present; `grep -rn 'TEMPORARY(until F9)'` empty; `npm test`
green; lint exit 0; the invert-ed build-variant assertion named in the handoff.

**Verification.**
```
npm test 2>&1 | tail -3
npx brittle-node test/build-variants.test.js
ZBTERM_FORGE_OUT_DIR=$SCRATCH/f9-default npx electron-forge package 2>&1 | tail -2
find $SCRATCH/f9-default -path '*resources/app/node_modules/@freenetorg*' -maxdepth 6 | head -1     # present
find $SCRATCH/f9-default -path '*resources/app/engine/backends/freenet/contracts/*.wasm'            # two files
find $SCRATCH/f9-pear -path '*resources/app/node_modules/node-datachannel*' | wc -l                  # 0
ls docs/projects/260924_freenet-backend/shots/f9-join.png docs/projects/260924_freenet-backend/shots/f9-run.sh
grep -c 'remote-pair' docs/projects/260924_freenet-backend/measurements.md                            # ≥ 2
grep -rn 'TEMPORARY(until F9)' engine ; echo "exit $?"                                                # exit 1
```

**Gotchas.** The packager prunes from the **source** manifest (`S-15`): a dependency dropped by the
`readPackageJson` hook still ships unless `pruneDroppedDependencies` removes it; check with `find`,
not by reading hooks. `@node-datachannel/linux-x64-gnu` is an optional dependency of
`node-datachannel`; `electron-forge-plugin-prune-prebuilds` prunes `prebuilds/` directories, not
platform packages — verify it survives. The renderer must not assume two usable backends: with the
owner's node down, Pear is the only radio and Freenet is disabled with text. The uisolate app needs
`--ozone-platform=x11` in the `=` form. Screenshots from the previous project showed `~/.ssh` paths;
use a scratch `HOME`. The `hostShares` entry is never removed (parent `open-issues.md` item 7): a
GUI instance that shared over Pear cannot switch to Freenet without a restart — start the host
instance fresh.

**Re-planning signals.** The packaged app cannot load `node-datachannel` in Electron's main process
(ABI) → do not rebuild; report the exact error and stop: the platform-package strategy needs a
decision. The remote pair connects in one direction only → record which, with the ICE candidate
types; `open-issues.md` carries it; it does not block close-out if the GUI and one direction pass,
but say so plainly in the status.

### F9 — Product wiring and the default build (retired 2026-09-24; ran beside F10)

- **Decisions (executor, no `D-nn`):** `share.backends` goes through `ShareManager.probedBackendsInfo()` (`registry.probe(id)`, 2 s cap), `backendsInfo()` stays synchronous; new `SessionEngine`/`ShareManager` option `backendOptions` (tests name a node address; the product passes none, 7509 stays fixed); `electron/ice-servers.js` resolves settings field (non-empty) > `--ice-servers` > `ZBTERM_ICE_SERVERS` > the `D-11` default, an empty flag/variable = no STUN, the flag read before paparam (it rejects an empty value); the host pushes the list through a new `share.setIceServers` invoke (CORE-CONTRACT row), every backend receives it, `RtcHost.iceServers` updated; preload `window.app.setIceServers`; a backend rejecting a dial with an error code fails the join at once with `{code, detail, backend, message}` (Pear/loopback reject only on cancel), the toast shows only when `backend` is present; the picker shows when ≥ 2 backends are reported and ≥ 1 is usable; **`S-22` fixed:** each offer first expires the link's half-open connections past `HALF_OPEN_TIMEOUT_MS` (backend `clock`), a per-connection timer re-arms as fallback, one viewer key ≤ 2 slots; `THIRD-PARTY-NOTICES.md` listed in `BUILD_BACKENDS.freenet.files` (pear/none do not ship it), pruning removes a scope directory left empty; renderer debug command `share-backend`, `modal-state` includes `shareBackends`; `SyncRepo` rsyncs with `--delete-excluded` protecting remote `node_modules`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, a stamp makes `npm ci` idempotent, step wait 1800 s; `test/tools/freenet-remote-pair.js` runs under Node with an in-process `RtcHost`. Licence issue **drafted, not filed** (`A-13`). The picker label reads "Freenet (experimental)" — a label, not a switch; owner's call whether to keep it (open-issues).
- **Gotchas hit:** **`S-29` fixed:** under Bare, `bare-http1` 4.5.7's global agent leaves a 5 s socket timeout armed on the upgraded WebSocket socket, so the node connection closed itself when idle (first GUI share failed) — `bare-shims.js::keepOpenWhenIdle`; the Bare test now idles 6 s and fails without the fix. The identity prompt must be dismissed only after the renderer shows it; `/health` under uisolate stays not-ok ("WebGL2 not supported", parent row 26); the first `SyncRepo` uploaded the spike's 170 MB cargo `target/` (now excluded); `~/.local/bin/freenet` is 0.2.137 now, so the tests' local nodes are 0.2.137.
- **Measured (2026-09-24, reported):** package `resources/app` / whole: default 673.4 MB / 975.8 MB, pear 648.4 / 950.9, none 647.5 / 949.9 (Freenet ≈ +25 MB). Remote pair (host 0.2.136 on hetzner, viewer here on the owner's 0.2.137 = A; reverse = B), IPv4 UDP, never relay: A-1 never connected within the 5 min cap; A-2 8.9 s, echo 2.6 s, history not done in 15 min; A-3 65.1 s, 0.03 MiB/s; A-4 14.8 s, 0.58 MiB/s (srflx → host); B-1 268.5 s (the offer took ≈ 266 s to arrive), history not done; B-2 5.0 s, 4.00 MiB/s; B-3 8.5 s, 2.93 MiB/s (host → srflx/prflx). GUI proof (both instances on the owner's node): announce 8 971 ms, join complete 1 098 ms after request, dial→connected 608 ms, offer→answer 190 ms, both diagnostics `backend.id === 'freenet'`, one connection `connected`/`DIRECT`, 2 channels, `D-11` ICE list, halfOpen/refused 0; `shots/f9-join.png` shows the host's line on the viewer, `shots/f9-picker-no-node.png` the disabled entry with the address (taken in a network namespace).
- **Open findings:** **`S-30`** Puts on the owner's node now take 1.4 s to > 10 s (F0: 75 ms), near the 10 s request timeout — a share can fail with `put failed` on a slow day; **`S-31`** signalling between 0.2.137 and 0.2.136 was erratic (one viewer never within 5 min, one offer 266 s late) and history toward this machine ran 0.03–0.58 MiB/s vs 2.9–4.0 away, no back-pressure events — version mismatch vs this machine's path not separated; the `freenet-stdlib` crate in both contracts is `LGPL-3.0-only` (covered by the notices; part of the licence question).
- **Files touched:** new `electron/ice-servers.js`, `test/tools/freenet-remote-pair.js`, `THIRD-PARTY-NOTICES.md`, `upstream-licence-issue.md`, `shots/{f9-run.sh,f9-join.png,f9-picker-no-node.sh,f9-picker-no-node.png}`, `measurements/F9-remote-pair-{A-2,A-3,A-4,B-1,B-2,B-3}.json`; edited `engine/backends/freenet/{index,bare-shims}.js`, `engine/backends/index.js`, `engine/share-manager.js`, `engine/index.js`, `electron/{main,preload,engine-lifecycle,rtc-host}.js`, `renderer/{app.js,index.html}`, `forge.config.js`, `package.json` (`files`), `scripts/infra/freenet_host.py` (`SyncRepo`), tests `build-variants`, `backends/{registry,freenet-backend,freenet-client,freenet-bare}`, `fixtures/freenet-bare-entry.js`, `renderer-static`; docs `README.md` (Freenet section, env/flag rows, dated notes), `docs/CORE-CONTRACT.md`, `docs/register.md` (`S-22` fixed, `S-29`–`S-31`), `docs/RELEASE-NPM.md`, design §9/§11 blockquotes, parent `open-issues.md` and `requirements.md` R-8 notes, `measurements.md` (F9 section).
- **Removed/changed assertions (V-7):** **inverted:** `build-variants.test.js` 'default variant is pear: freenet is left out, pear and its dependencies stay' → 'default variant is pear,freenet: both backends and their dependencies stay (D-14)' (expects `['pear','freenet']`, freenet dir not ignored); new tests 'pear and none drop the Freenet backend…' and the `.wasm`/`hashes.json` per variant; `registry.test.js`: 'Pear is available, Freenet is not yet wired…' → '…Pear and Freenet are available…' (`availability()` → `{available, null}`), F4 test `notYet` → `usable`, `withRtc` detail check → state `available`, 'a limit narrows…' broken case uses `hostCaps: ''` + freenet usable under its own limit, 'create() … raises' context `{ hostCaps: '' }`, acceptance test retitled and its "F9 next" `['broken','not yet wired']` check replaced by the probe's `broken` + address detail; `freenet-client.test.js` `availability()` `{broken,'not yet wired'}` → `{available, null}`; `renderer-static.test.js` picker test retitled, 'none for zero or one' (`usable.length < 2`) replaced.
- **npm/packaging commands:** `npm test` ×3, `npm run lint` ×4, `npx electron-forge package` (default ×6, pear ×2, none ×2, all into the scratchpad), no installs. **Next free:** `S-32` / `D-17`. Suite **435 / 2882**, 98 warnings. `TEMPORARY` markers: **0**.

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
$ npm test   → exit 0; # tests = 435/435 pass; # asserts = 2882/2882 pass
$ npx brittle-node test/build-variants.test.js   → 15/15 tests, 170/170 asserts
$ npm run lint   → exit 0; 98 warnings
$ ZBTERM_FORGE_OUT_DIR=$SCRATCH/f9-default-gate npx electron-forge package   → exit 0 ("✔ Running postPackage hook"); repo out/ untouched (dated 2026-07-18)
$ find … @freenetorg   → present;  … contracts/*.wasm → signalling-v1.wasm, pointer-v1.wasm;  … THIRD-PARTY-NOTICES.md → present;  … @node-datachannel/linux-x64-gnu → present
$ find $SCRATCH/f9-pear … node-datachannel | wc -l → 0;  find $SCRATCH/f9-none … @freenetorg | wc -l → 0
$ node -e "require('<app>/node_modules/node-datachannel'); require('<app>/node_modules/@freenetorg/freenet-stdlib')"   → both load from the packaged app
$ ls shots/   → f9-join.png, f9-run.sh, f9-picker-no-node.png, f9-picker-no-node.sh (both PNGs inspected: host line visible on the viewer; Freenet disabled with "no Freenet node at ws://127.0.0.1:7509 — see README"; no private paths)
$ grep -c remote-pair measurements.md → 3;  grep -rn 'TEMPORARY(' engine electron renderer test scripts → exit 1
$ register: S-22 fixed (F9), S-29 fixed, S-30 open, S-31 open; Next free S-32;  ps -p 4003927 → up;  uisolate ls → no sessions
```
Processes: ten `electron-forge package` runs into the scratchpad; uisolate sessions `f9-host`, `f9-viewer` (five runs of `f9-run.sh`, EXIT trap stops them), `f9-dbg` (stopped by `uisolate stop`), `f9-no-node` (inside `unshare -rn`, trap-stopped) — all gone; exact-pid SIGTERMs by the executor on its own rsync (4152268), its scratch `freenet local` (4162683) and an already-exited driver (4162669); local nodes via the helper (4143961, 4144943, 4145756, 4146429); `SyncRepo` ×7; remote-pair roles via single `ssh hetzner-deb16` commands, all exited on their own; one `ssh` carried two commands (minor breach, noted); the remote node never touched; the owner's node pid 4003927 unchanged.

---

## Phase F11: Full gate, ledgers, close-out

**Goal.** Every gate is green on this machine, every ledger and document says what the code does,
and the project is closed per the exec template.

**Requirements & inputs.** The exec template's step 7; `docs/register.md`, `docs/decisions.md`,
`docs/projects/README.md`, `../260918_backend-abstraction/{plan,open-issues}.md` and its
`freenet-backend-design.md` §12 (dated blockquotes: phases done, what changed), `README.md`,
`docs/ARCHITECTURE.md`, `docs/CORE-CONTRACT.md`, `docs/RELEASE-NPM.md`, this project's files.

**Steps.**
1. `npm test` (twice if `S-03`), `npm run lint`; package the default, `pear` and `none` variants into
   the scratchpad and repeat the `F9` step-6 inspection.
2. Reconcile: every `S-nn` this project appended has its final state; every `D-nn` (`D-09`…`D-15`
   plus any taken) is in both ledgers' tables; `docs/register.md`'s and `docs/decisions.md`'s "Next
   free id" lines are right; every `TEMPORARY(` marker is gone (`grep -rn 'TEMPORARY(' engine
   electron renderer test scripts`); no `ZBTERM_FREENET_EXPERIMENTAL`; `docs/CORE-CONTRACT.md` names
   `FrameKind` 0–21; `README.md` documents `ZBTERM_ICE_SERVERS`, `--ice-servers`, the default build
   and the Freenet install pointer; `docs/ARCHITECTURE.md` has a dated paragraph on the Freenet
   backend and the seam.
3. Close out: "Closed <date>" paragraph at the top of this plan; `status--plan.md` →
   `status--done.md` with a summary; the row in `docs/projects/README.md`; a follow-on pointer and a
   lesson in the parent's `plan.md`; dated blockquotes under design §12 (which phases landed, which
   design rows changed); `open-issues.md` listing what was left open on purpose, citing symbols
   (at least: other platforms' `@node-datachannel/*`, macOS/Windows/arm64 packages, the upstream
   licence issue's state, offline history per `F10`, the `hostShares` never emptied, `S-14`, TURN,
   NAT↔NAT if not measured, anything the remote pair showed).
4. Remote: leave `hetzner-deb16` provisioned (the node running) unless the owner says otherwise;
   record its state in `open-issues.md`.

**Acceptance criteria.** Suite green; lint exit 0 with warnings ≤ baseline; three packages
inspected; all reconciliation greps empty or matching; every close-out file present.

**Verification.**
```
npm test 2>&1 | tail -3 ; npm run lint 2>&1 | tail -1
grep -rn 'TEMPORARY(' engine electron renderer test scripts ; echo "exit $?"     # exit 1
grep -n 'Next free' docs/register.md docs/decisions.md
ls docs/projects/260924_freenet-backend/                                          # status--done.md, open-issues.md, CHANGELOG.md, measurements.md, …
```

**Gotchas.** Do not re-verify retired phases; the handoff notes carry the numbers. `brittle`'s glob
walker can die on a vanishing `.git/index.lock` (previous project): a run that ends before any test
is not a red; re-run.

**Re-planning signals.** None; a red here is a blocker to report.

### F11 — Full gate, ledgers, close-out (retired 2026-09-24)

- **Decisions:** none new. `D-09`…`D-16` present in both ledgers (16 `D-` rows in the table); next free `S-32` / `D-17`. No area `STATUS.md` exists in this repo; none created.
- **Gotchas hit:** `R-11`/`D-15` want the licence issue *filed*; it is drafted only (`A-13`), recorded as pending the owner in `plan.md`, `status--done.md`, `open-issues.md`. `S-19` stays open (nothing fixed it); `S-24` stays open ("probably S-26" is not proof). The edited `.md` files are outside lint's scope (prettier flags them; not reformatted).
- **Measured (2026-09-24, reported):** suite 435 / 2882 in ≈ 184 s, lint 98 warnings; packages `resources/app` / whole: default 673.6 / 976.1 MB, pear 648.6 / 951.1, none 647.7 / 950.1; the default package loads `node-datachannel` and the SDK, `pear`/`none` carry none of the Freenet files; remote `freenet-node` active, 0.2.136.
- **Files touched:** `plan.md` (Closed paragraph), `status--in-progress.md` → `status--done.md`, `open-issues.md` (new, 23 items), `docs/projects/README.md` (row **done**), `docs/register.md` (`S-03` recurrence row), `docs/ARCHITECTURE.md` (§3.1, §7 blockquotes), parent `plan.md` (follow-on + lesson), parent `open-issues.md` (close-out note), design §12 blockquote.
- **Removed assertions:** none. **Next free:** `S-32` / `D-17`. Suite **435 / 2882**, 98 warnings.

**Verification output (gate re-run by the orchestrator, 2026-09-24):**
```
$ npm test   → exit 0; # tests = 435/435 pass; # asserts = 2882/2882 pass
$ npm run lint   → exit 0; 98 warnings
$ grep -rn 'TEMPORARY(' engine electron renderer test scripts   → exit 1
$ grep -rn ZBTERM_FREENET_EXPERIMENTAL engine electron renderer test scripts README.md docs/CORE-CONTRACT.md   → exit 1
$ grep -n 'Next free' docs/register.md docs/decisions.md   → S-32 / D-17;  D- rows in decisions table → 16
$ ls docs/projects/260924_freenet-backend/   → CHANGELOG.md QnA_assumptions.md baseline.md measurements measurements.md offline-history-probe.md open-issues.md plan.md requirements.md shots status--done.md upstream-licence-issue.md
$ three packages in the scratchpad (pkg-default 522M, pkg-pear 505M, pkg-none 504M on disk); repo out/ untouched (2026-07-18);  ps -p 4003927 → up
```
Processes: `npm test`, `npm run lint`, three `electron-forge package` runs into the scratchpad, one read-only `ssh hetzner-deb16`; no signals; no GUI.
