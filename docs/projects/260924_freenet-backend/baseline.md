# F0 baseline

Measured 2026-09-24 on the owner's machine (Linux 7.0.14-201.fc44.x86_64), working tree the
predecessor repository (frozen at commit `b856e15`), branch `freenet`. Every number here is
reported, not gated,
except the suite and lint counts, which the plan's gate re-measures in every phase. No product
code, dependency or `node_modules` entry was changed in F0.

## Suite and lint

| check | result |
|---|---|
| `npm test` | exit 0; `# tests = 360/360 pass`, `# asserts = 2191/2191 pass`, `# time = 83993.472388ms`. No failing test; `S-03` did not fire, so no re-run. |
| `npm run lint` | exit 0; `98 warnings` (lunte `require-await` and others; prettier clean). |

Same as the plan's conventions line (360 / 2191, 98 warnings, 2026-09-19): the "suite baseline
differs" re-planning signal did not fire.

## Tree and toolchain

`git status --porcelain` before F0 wrote anything (paths only):

```
 D docs/projects/260924_freenet-backend/status--plan.md
 M docs/projects/README.md
?? docs/projects/260924_freenet-backend/status--in-progress.md
```

It was the same after `npm test` and `npm run lint` (the `pretest` asset vendoring changed nothing
tracked).

| tool | version |
|---|---|
| `node --version` | `v24.18.0` |
| `freenet --version` | `Freenet version: 0.2.136 (7fa2c6605b99)`, build timestamp `2026-09-21T18:19:41Z` |
| `fdev --version` | `Freenet Development Tool 0.3.298` |
| `rustc --version` | `rustc 1.95.0 (59807616e 2026-04-14)` |
| `rustup target list --installed` | `riscv32imac-unknown-none-elf`, `thumbv7em-none-eabihf`, `wasm32-unknown-unknown`, `x86_64-unknown-linux-gnu` |
| Bare in `bare-sidecar` 0.4.5 (`node_modules/bare-sidecar/prebuilds/linux-x64/bare`) | **`v1.27.0`** (`uv` 1.51.0, `v8` 14.4.258.16) |

The Bare version was read by spawning a scratchpad entrypoint through
`engine/spawn-worker.js::spawnWorker` that wrote
`{"bare":"v1.27.0","versions":{"bare":"1.27.0","uv":"1.51.0","v8":"14.4.258.16"}}` on `Bare.IPC`;
the spawned pid was then stopped by pid and `ps -p` came back empty. Note for later phases: this is
the same 1.27.0 that `S-06` measured in pear-runtime and that `bare-fs` ≥ 4.8 refuses
(`requires range '>=1.28.0'`); the root tree has `bare-fs` 4.7.1 (`engines.bare >=1.16.0`).

## The owner's Freenet node

```
$ ps -eo pid,etime,args | grep '[f]reenet'
1938466  2-16:45:04 /home/zeev/.local/bin/freenet network
$ ss -ltnp | grep 7509
LISTEN 0      128                      127.0.0.1:7509       0.0.0.0:*    users:(("freenet",pid=1938466,fd=12))
LISTEN 0      128                          [::1]:7509          [::]:*    users:(("freenet",pid=1938466,fd=11))
```

Still pid 1938466 at the end of F0 (`2-16:49:25`). F0 did not connect to it.

## Packages

| package | repo root `node_modules/` | `spikes/freenet/node_modules/` |
|---|---|---|
| `@freenetorg/freenet-stdlib` | absent | 0.4.0 |
| `node-datachannel` | absent | 0.33.4 |

## P-2 against node 0.2.136

`freenet local --ws-api-port 7519 --config-dir <scratch>/node/config --data-dir <scratch>/node/data
--log-dir <scratch>/node/log --disable-auto-update` (directories in the session scratchpad, not in
the repo), then `node spikes/freenet/p2-node.js 7519`, exit 0:

```
"runtime": "node v24.18.0", "port": 7519, "wasmBytes": 181292,
"contract": "DhgeYX6fDCYg2UVkPpr4CohLLp9E7TYg6THuTPwcKUJx",
"wsOpenMs": [56.58, 3.46], "putMs": 74.83, "getStateBytes": 8,
"getMs":                  { "n": 20, "min": 0.29,  "p50": 0.38,  "p95": 0.87,  "max": 1.17 },
"subscribeMs": 0.92,
"updateAckMs":            { "n": 20, "min": 42.87, "p50": 43.15, "p95": 43.55, "max": 43.89 },
"updateToNotificationMs": { "n": 20, "min": 33.32, "p50": 38.19, "p95": 42.56, "max": 43.28 },
"finalEntries": 20
```

Against 0.2.135 (`260918_backend-abstraction/probes.md` §P-2): same shape, update→notification
p50 38.2 ms against 36.1 ms, p95 42.6 against 42.3 (n = 20). `subscribeMs` is the `fnet.js`
workaround's ack, not the SDK promise.

## `S-05` re-probed on 0.2.136

SDK `@freenetorg/freenet-stdlib` 0.4.0 (its request timeout is `REQUEST_TIMEOUT_MS = 30000`),
local-mode node above, fresh contract instance per run. Two throwaway scripts: one awaits each
SDK promise with a cap, one taps the SDK's response handler to see which response type arrives.

| item | 0.2.135 (B8) | 0.2.136 (F0) | verdict |
|---|---|---|---|
| (a) raw `api.subscribe()` | never resolves; ack arrives as a `PutResponse` | rejected `Request timeout` after 30 001 ms; the ack arrives as a `PutResponse` for the key 1 ms after the request; the subscription is live (notifications arrive, row d) | **unchanged** |
| (b) second `Put` of the same instance | answered with an `UpdateResponse`; `put()` hangs 30 s | answered with an `UpdateResponse` after 110 ms; `put()` rejected `Request timeout` after 30 000 ms | **unchanged** |
| (c) `Get` of a missing key, local-mode node | never answered; 30 s SDK timeout | no `NotFound`, no host error; rejected `Request timeout` after 30 004 ms (40 s cap not reached) | **unchanged** |
| (d) notification payload | every notification a `DeltaUpdate` with the whole state | three one-entry delta updates, 1 s apart, gave three `DeltaUpdate` notifications carrying entries `[0]`, `[0,1]`, `[0,1,2]`: the whole state | **unchanged** |

First `Put` of the fresh instance resolved in 18 ms with a `PutResponse`; each delta `Update`
resolved in 47–49 ms. Every `S-05` workaround in `spikes/freenet/lib/fnet.js` is still needed; the
"an `S-05` item changed" re-planning signal did not fire. The SDK 0.4.0 does talk to 0.2.136.

The local-mode node (pid 3726351) was stopped with `SIGTERM` by pid; `ps -p 3726351` came back
empty and nothing listened on 7519 afterwards.

## F1 — the remote test host (2026-09-24)

Provisioned by [`scripts/infra/freenet_host.py`](../../../scripts/infra/freenet_host.py)
(`FreenetHost`, then `SyncProbes`). Reported, not gated.

| fact | value |
|---|---|
| OS, user | Debian (`ID=debian`), login user `zeev`, work dir `/home/zeev/work/zbterm` |
| `freenet` / `fdev` | 0.2.136 (7fa2c6605b99) / 0.3.298, `x86_64-unknown-linux-musl`, both tarballs `OK` against the release `SHA256SUMS.txt`; each tarball holds the bare binary at top level, mode 0644 (the recipe `chmod`s it) |
| Node.js | v24.21.0 (the newest 24.x on nodejs.org/dist, released 2026-09-07), `OK` against `SHASUMS256.txt`; its npm 11.19.0 |
| unit | `/etc/systemd/system/freenet-node.service`: `freenet network`, `--ws-api-address 127.0.0.1 --ws-api-port 7509 --network-port 31337 --disable-auto-update`, `XDG_CACHE_HOME` under the work dir; `active` |
| WS API | listens on `127.0.0.1:7509` and `[::1]:7509` (the explicit IPv4 address still gets the IPv6 loopback companion) |
| peers | the node log under `freenet/log` held 34 `add_connection: successfully added to ring` lines when first read, about 10 min after first start, and 39 at 15 min; time to the first peer not measured (the first run looked in the journal, see the note below) |
| firewall | `nft` input hooks: three, all `policy accept`; no Hetzner Cloud firewall blocked peering |
| `p2-network-get.js 7509` | `"getMissing": "rejected: Contract not found"`: 8 127 ms about 13 min after first start, 2 652 ms 46 s after a unit restart; WS open 72.23 / 45.42 ms |
| spike on the host | `npm ci` added 136 packages in 5 s (`@roamhq/wrtc` and `werift` included, no `remote-package.json` needed) |
| recipe run, fully provisioned host | 6.8–6.9 s wall for all 11 steps |

With `--log-dir` the node writes its tracing log only to hourly files in that directory; the
journal holds just `Started …` and `[RATE LIMIT per-callsite]` notices, so `wait_peers` reads the
log directory, not `journalctl`.
