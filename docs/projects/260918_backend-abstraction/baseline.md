# Baseline (Phase B0)

**Measured 2026-09-18**, branch `freenet`, HEAD `3e829c4`, before any code change of this
project. Repo root: the predecessor repository (frozen at commit `b856e15`). Every figure below came from the command
shown next to it, run on this machine on that date.

## 1. Suite

Command: `npm test` (runs `pretest` = `node scripts/vendor-assets.js`, then
`brittle-node test/*.test.js`).

```
1..277
# tests = 277/277 pass
# asserts = 1533/1533 pass
# time = 111928.375884ms

# ok
```

| Fact | Value |
|---|---|
| Exit code | 0 |
| Tests | **277 / 277 pass** |
| Asserts | **1533 / 1533 pass** |
| Failing test ids | **none** |
| Skipped / todo | none (`grep -ci 'skip\|todo'` on the TAP output = 0) |
| Wall time | about 112 s |

The figure inherited from an earlier handoff note (243 tests / 1268 asserts, quoted in
`requirements.md` §2.2) is stale. **277 / 1533 is the baseline for this project.**

Not run, by instruction: `npm run test:debug-server` (known red on this machine) and
`npm run test:canary` (needs a storage-dir argument). Neither is in `npm test`.

`pretest` writes `renderer/vendor/`. That directory is git-ignored
(`git status --short --ignored renderer/vendor` prints `!! renderer/vendor/`), so it does not
show up as a change.

## 2. Sharing tests

### 2.1 Tests per file

Command: `grep -c '^test(' test/<file>` (all `test(` calls in these files are top-level).

| File | `test(` calls |
|---|---|
| `test/share-manager.test.js` | 21 |
| `test/share-manager-network.test.js` | 2 |
| `test/identity-handshake.test.js` | 13 |

These match `requirements.md` §2.2.

### 2.2 Pear privates touched

Privates searched for: `_createSwarm`, `_hostSwarm`, `_pinHost`, `_unpinHost`,
`_relayThrough`, `_registryLookup`, `_registryDht`, `_socketPeers`, `_socketReplicated`,
`_handleHostConnection`, `_handleViewerConnection`.

Command: `grep -cE '<the 11 names joined by |>' test/*.js`, then a per-test map (a small Node
script that tracks the enclosing top-level `test(` for each matching line).

Lines that match, per file (every other file in `test/` has 0):

| File | Matching lines |
|---|---|
| `test/share-manager.test.js` | 30 |
| `test/share-manager-network.test.js` | 1 |
| `test/identity-handshake.test.js` | 1 |

`requirements.md` §2.2 says 26 lines for `share-manager.test.js`. That figure is correct for
the 8 names it lists; the 11-name list of this phase adds `_unpinHost` and `_registryDht`
(and `_socketReplicated`, which has no hit), giving 30.

`_socketReplicated` is referenced by **no** test file.

**`test/share-manager.test.js`: 11 of 21 tests touch a private.** Numbers in brackets are line
numbers.

| # | Test (line of `test(`) | Privates touched |
|---|---|---|
| 1 | `default share links allow input when host enables shared keyboard` (L124) | `_createSwarm` [148] (overridden with a fake swarm) |
| 2 | `an invite link carries the host identity claim, and works without one` (L162) | `_createSwarm` [194] (overridden) |
| 3 | `viewer connection is destroyed before any channel/join-request when the socket key does not match the invite hostDhtKey` (L504) | `_handleViewerConnection` [532] (called directly) |
| 4 | `viewer connection proceeds normally when the socket key matches the invite hostDhtKey` (L548) | `_handleViewerConnection` [566] (called directly) |
| 5 | `two sessions multiplexed over one socket produce independent peers, and closing that socket cleans up both without affecting a peer on a different socket` (L577) | `_handleHostConnection` [602, 617] (called directly); `_socketPeers` [609, 626, 629] (read) |
| 6 | `registry lookup prefers the shared host swarm dht once one exists` (L693) | `_registryDht` [697, 700]; `_hostSwarm` [706]; `_registryLookup` [716] |
| 7 | `_pinHost/_unpinHost refcount a host key across concurrent joins to the same host` (L722) | `_pinHost` [732, 733]; `_unpinHost` [740, 748]; `_hostSwarm` [730]; both names also in the title [722] |
| 8 | `shared swarm union firewall accepts hosting-anything or a pinned join host, rejects otherwise` (L753) | `_createSwarm` [761] (overridden to capture the firewall); `_pinHost` [777] |
| 9 | `_relayThrough offers the relay only for forced or unconnected stale joins` (L795) | `_relayThrough` [801, 805, 808, 811, 815]; name also in the title [795] |
| 10 | `join reuses an existing socket to the invited host before dialing` (L821) | `_handleViewerConnection` [830] (stubbed); `_hostSwarm` [837] (assigned) |
| 11 | `successful join settlement removes bookkeeping, leaves topic, unpins host, and closes only the channel` (L870) | `_hostSwarm` [884] (assigned) |

The other 10 tests in that file touch none of the 11 names.

**`test/share-manager-network.test.js`.** One matching line, in the file-scope helper
`useTestnet(manager, testnet)` [L253-254], which overrides `manager._createSwarm` to build a
real `Hyperswarm` bootstrapped on the local testnet. Both tests in the file call it (L42, L54,
L59 and L134, L160), so **both tests depend on `_createSwarm` being an overridable seam**:

- `a join whose invite hostDhtKey is forged to a different live peer never lets either party process a join-request` (L25)
- `a single viewer identity can join two sessions hosted by the same host over one shared swarm (…)` (L106)

**`test/identity-handshake.test.js`.** One matching line, in the helper `viewerHarness(t, opts)`
[L484], which calls `manager._handleViewerConnection(state, socket, null)` [L544]. Three tests
use that helper:

- `viewer verifies the host claim on confirm and only then registers the remote session` (L279)
- `viewer aborts the join and destroys the socket when the host claim fails` (L305)
- `viewer treats a host that presents no claim as unknown and joins anyway` (L325)

**No other file in `test/`** references any of the 11 names.

## 3. Versions

| What | Command | Result |
|---|---|---|
| Node | `node -v` | `v24.18.0` |
| npm | `npm -v` | `11.16.0` |
| electron | `node -p "require('./node_modules/electron/package.json').version"` | `40.10.1` |
| hyperswarm | same, per package | `4.17.0` |
| hyperdht | | `6.32.0` |
| hypercore | | `11.33.5` |
| protomux | | `3.11.0` |
| pear-runtime | | `1.1.4` |
| brittle | | `4.0.2` |
| freenet | `freenet --version` (`~/.local/bin/freenet`) | `Freenet version: 0.2.135 (ea1ff5f169bc)`, `Build timestamp: 2026-09-10T17:17:44Z` |
| fdev | `fdev --version` (`~/.local/bin/fdev`) | `Freenet Development Tool 0.3.297` |
| cargo | `cargo --version` (`~/.cargo/bin/cargo`) | `cargo 1.95.0 (f2d3ce0bd 2026-03-21)` |
| rustc | `rustc --version` | `rustc 1.95.0 (59807616e 2026-04-14)` |
| rustup targets | `rustup target list --installed` | `riscv32imac-unknown-none-elf`, `thumbv7em-none-eabihf`, `x86_64-unknown-linux-gnu` |

**`wasm32-unknown-unknown` is NOT installed.** Freenet contracts compile to that target. This is
a re-planning signal of B0: **B8 must start with `rustup target add wasm32-unknown-unknown`**
and say so in its handoff note. B0 did not install it.

`~/.local/bin` and `~/.cargo/bin` had to be prepended to `PATH` for the commands above.

## 4. Freenet node on `127.0.0.1:7509`

**A node answers.**

| Command | Result |
|---|---|
| `ss -ltnp \| grep -E ':7509\b'` | `LISTEN 127.0.0.1:7509 users:(("freenet",pid=2224,…))` and `LISTEN [::1]:7509 users:(("freenet",pid=2224,…))` |
| `curl -sS -m 5 -o /dev/null -w 'http=%{http_code}\n' http://127.0.0.1:7509/` | `http=200`, curl exit 0 |

Only the HTTP root was probed. The WebSocket endpoint
`ws://127.0.0.1:7509/v1/contract/command` was not exercised; that belongs to the Freenet probe
phases. The node was already running (pid 2224); B0 did not start or stop it. Its version is
presumed to be the installed binary's 0.2.135 but was not read from the running process.

## 5. Lint

Command: `npm run lint` (`prettier --check …` then `lunte …`).

```
Checking formatting...
All matched files use Prettier code style!
…
112 warnings
```

| Fact | Value |
|---|---|
| Exit code | **0 (pass)** |
| Prettier | all matched files pass |
| lunte errors | 0 |
| lunte warnings | 112, every one `WARNING (require-await)` |

A later phase fails lint only if the exit code becomes non-zero. 112 is the warning count to
compare against.

## 6. Working tree

Command: `git status --short`, after all of the above.

```
 M docs/abstract-arch.md
?? docs/decisions.md
?? docs/projects/
?? docs/register.md
```

Identical to the status before B0 started. Only `docs/` paths; B0 added
`docs/projects/260918_backend-abstraction/baseline.md` and changed nothing else.

## 7. Ledgers

The suite is green, so no `S-nn` was raised. No decision was taken. Next free ids are
unchanged: **`S-01`**, **`D-04`**.
