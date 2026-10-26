# Architecture notes (`electron/`, `renderer/`, `engine/`)

> Read before editing `electron/`, `renderer/`, or `engine/`, or when debugging
> sidecar spawn, IPC, or startup crashes. Only non-obvious, code-verified facts —
> the code (and `docs/CORE-CONTRACT.md`/`docs/ARCHITECTURE.md`) is the reference
> for everything else. Index: [AGENTS.md](../AGENTS.md).

Renderer (sandboxed) ↔ `window.bridge` (Electron IPC) ↔ main (broker: `electron/
engine-client.js`, `electron/engine-lifecycle.js`) ↔ fd-3 `FramedStream` pipe
(`engine/rpc/pipe.js`) ↔ Bare worker (`engine/`: session recording, sharing,
playback, identity). There is no separate worker package and no updater — the
worker *is* `engine/`, published on its own as `zbterm-core`
(`engine/package.json`) so it also runs outside Electron. The code is small —
read it for the wiring; below are only the non-obvious facts.

- The paparam parse at the top of `electron/main.js` throws on **any** unknown
  flag or positional → packaged app crashes at startup. Declare a new CLI flag
  there before using it anywhere else.
- The sidecar is spawned by `engine/client.js::_spawnWorker` through
  `engine/spawn-worker.js::spawnWorker` (`bare-sidecar`'s `Sidecar`, required
  lazily so a test can stub it). Argv is positional and frozen:
  `[userData, profileId, profilePath, backend, hostCaps]` — the three optional
  ones are empty strings, never `undefined` (`docs/CORE-CONTRACT.md`). A wrong
  but parseable order fails silently, same risk as any positional contract.
  > 2026-09-29 (K11 of zxterm-core, `D-34`): the 5th slot is `freenetNode` now
  > (the Freenet node's WebSocket URL, `''` for the default), not `hostCaps`;
  > a 6th, `coreHost`, may follow.
- Identity runs in a second process: the Rust `zxterm-core` sidecar (from
  `zevix/zxterm`; unrelated to this repo's JS `zbterm-core` package), one per
  profile, spawned by the Bare worker on first use through the host module named
  by the worker's optional 6th argument (`electron/zxterm-core-host.js`;
  `engine/zxterm/core.js`). `engine/identity/*.js`, `engine/crypto.js`'s and
  `engine/account-store.js`'s identity-key calls are thin call-throughs to it over
  `<profile>/account/zxterm-core.sock`. A test that reaches identity code must
  `require('./helpers/zxterm-core')` first (it installs the host), and a test that
  spawns a real worker must pass `coreHost` to `EngineClient`, or every identity
  call fails with `E_BACKEND_UNAVAILABLE`. The sidecar exits when its spawner's
  end of its stdin pipe closes (`--exit-on-stdin-eof`).
- The pipe is **not** plain strings: it is the framed binary protocol of
  `engine/rpc/schema.js` (`INVOKE`, `EVENT_JSON`/`EVENT_DATA`, `PTY_*`,
  `BACKEND_*` frame kinds) over `engine/rpc/pipe.js`'s `FramedStream`. Adding a
  message means adding a frame kind and its `compact-encoding` codec there, on
  both sides of the pipe at once.
- `BACKEND_*` frames (`OPEN`/`SIGNAL`/`STATE`/`CHANNEL`/`DATA`/`FLOW`/`CLOSE`)
  are the seam the split Freenet adapter crosses: its Freenet-SDK contract
  client runs in the Bare worker (`engine/backends/freenet/`), its WebRTC half
  runs in the host process on `node-datachannel` (`electron/rtc-host.js`),
  `D-06`/`D-09` in `docs/decisions.md`. The Pear backend
  (`engine/backends/pear/`) needs no such split — it runs entirely in the
  worker over `hyperswarm`/`hyperdht`.
  > 2026-09-29 (K11 of zxterm-core, `D-34`): superseded. The `BACKEND_*` frames
  > and `electron/rtc-host.js` are gone; the Freenet backend in the worker is a
  > proxy to the Rust `zxterm-core` sidecar, which runs the contract client and
  > WebRTC, over the sidecar's own seam (`freenet.*` requests and events, `Chan`
  > frames). No Freenet work crosses the worker pipe.
- `engine/package.json#imports` (not the root `package.json`) maps Node
  builtins Bare lacks (`fs`, `path`, `os`, `crypto`, `events`) to their
  `bare-*` shims. A build's Node builtin used under `engine/` without an entry
  there resolves against a hoisted npm shim in dev and dies with
  `MODULE_NOT_FOUND` in a packaged build, where pruning removes it — the UI
  then shows nothing but a dead sidecar. `engine/package.json`'s own dependency
  *ranges* must also track the root's; a targeted `npm install` inside
  `engine/` can leave one behind a floor the root already bumped past.
- `ZBTERM_BUILD_BACKENDS` (`forge.config.js`) decides which `engine/backends/
  <id>/` directories and their dependencies ship in a package; an absent
  backend's directory is gone, and `engine/backends/index.js` reports it
  `MODULE_NOT_FOUND` at runtime, not a build error. `ZBTERM_BACKEND` (app CLI
  `--backend` / env) only narrows further, at runtime, within what the build
  carries.
- **A stall is usually the network, not the code, and the two look identical.**
  Exercise real replication against a local `hyperdht/testnet`
  (`test/backends/conformance-pear.test.js`'s pattern) or a throwaway local-mode
  Freenet node (`test/helpers/freenet-node.js`) rather than the public
  network before debugging app logic.
