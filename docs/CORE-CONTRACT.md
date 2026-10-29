# `zbterm-core` Contract

This is the frozen, host-independent contract of ZBTerm's core. Anything in
here is what an adapter — a headless CLI, a systemd service, a terminal-app
plugin, a second GUI — is allowed to depend on. Anything not in here is an
implementation detail and may change without notice.

`test/core-contract.test.js` compares the method and event tables below against
`engine/index.js` and `engine/rpc/schema.js` at runtime (and checks that every
`FrameKind` and the supervision numbers are named here) and fails the build when
they drift, so this document cannot silently go stale.

The `D-nn`/`S-nn`/`X-nn` ids and the `F`/`K` phase names below refer to the
project's decision and security registers and to the zxterm-core project plan
(in `zevix/zxterm`); those ledgers are not part of this repository.

> **History (2026-09-19, 2026-09-28).** The one adapter besides the Electron app was a Tabby
> terminal plugin. It was archived on 2026-09-19 and was not carried into this repository (`Z1`
> of the fork); it stays readable in the predecessor repository at its final commit `b856e15`.
> The contract and every seam it used (attach mode, the spawn arguments, `ZBTERM_BACKEND`) are
> unchanged. Today the Electron shell (`electron/`) is the only in-tree host.

---

## 1. What the package is

|                      |                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| npm package          | `zbterm-core`                                                                                                                             |
| repository directory | `engine/` (its `package.json` is the core's, the repo root's is the app's)                                                                  |
| main entry           | `zbterm-core` → `index.js` → the `SessionEngine` class, exported **directly** (`module.exports = SessionEngine`, not `{ SessionEngine }`) |
| sidecar entry        | `zbterm-core/worker.js` — the Bare entrypoint (see §3)                                                                                    |
| client entry         | `zbterm-core/client.js` → `{ EngineClient }` — the host-side supervisor (see §3, §5)                                                      |
| RPC codec            | `zbterm-core/rpc/schema.js` → `{ FrameKind, FrameKindName, LOW_RATE_EVENTS, EVENT_DATA_NAMES, encodeFrame, decodeFrame }`                 |
| errors               | `zbterm-core/errors.js` → `{ EngineError, CODES }`                                                                                        |

The `imports` map that aliases `fs`/`path`/`os`/`crypto`/`events` to their
`bare-*` equivalents under Bare lives in **the core's** `package.json`, not the
app's. It has to travel with the core: without it the sidecar silently loads
Node builtins under Bare and fails in ways that look like storage corruption.

There are two ways to embed the core:

- **In-process.** `new SessionEngine({ userData, profileId, profilePath, ptyHost })`
  in your own process (plus `backendLimit` and `backendOptions`, which is what
  the worker passes for the 4th and 5th spawn arguments). Identity calls need a
  `zxterm-core` host installed first (`require('zbterm-core/zxterm/core.js')
  .setCoreHost(host)`, see §3).
- **As a sidecar.** `new EngineClient({ userData, profileId, profilePath, ptyHost,
  backend?, freenetNode?, coreHost?, workerEntrypoint? })`, which launches
  `worker.js` under Bare and speaks the frame protocol to it. Same
  `invoke()`/`on()`/`close()` surface, plus `ready()`, `respawn()` and `pid`.
  The host keeps owning the terminals; only the core moves.

### Versioning

`zbterm-core` versions **independently of the `zbterm` app** — the app is
at 1.0.x and the core starts at 1.0.0 by coincidence, not by coupling. Semver
applies to everything in this document:

- **major** — a method or event removed or renamed, an argument or result field
  removed, a `FrameKind` number reused, argv order changed, PTY-host method
  signature changed.
- **minor** — a method, event, optional argument or result field added; a new
  `FrameKind` appended.
- **patch** — behaviour fixes that keep every shape above.

Adapters declare a range (`"zbterm-core": "^1"`), never an exact pin, and must
tolerate unknown event names and unknown result fields.

---

## 2. Error shape

Every rejection is an `EngineError`, and it survives the sidecar seam:
`{ name: 'EngineError', code, message, details }`, JSON-safe by construction.
`code` is one of `errors.js`'s `CODES` and is the only part an adapter should
branch on; `E_INTERNAL` is the catch-all.

Two codes belong to share-backend selection (section 5.1, "Share backends"):

- `E_BACKEND_UNSUPPORTED` — the backend a call named (`share.createLink`'s
  `backend`, or the `b` of the invite given to `share.join`) is not usable in
  this run: the build does not carry it, it is broken, or the launch limit
  excludes it. The message names the backend and `details.backend` is its id. It
  is also what every share call answers when no backend is available at all.
- `E_BACKEND_UNAVAILABLE` — `share.createLink` named a backend for a session
  that is already shared over another one. A session is shared over one
  backend at a time; the message says to stop sharing it first. `details` is
  `{ backend, active }`, `active` being the backend the session is shared over.
  A backend may also answer with this code itself when it is present but
  cannot work right now: `details` is then `{ backend, detail }` (the Freenet
  backend's `detail` values are listed under "Share backends", section 5.1).
  Every `identity.*` method answers it too when the `zxterm-core` sidecar
  cannot be reached (no core host, binary missing, sidecar exited; §3).

---

## 3. Sidecar launch

Exactly what `EngineClient._spawnWorker()` does (`engine/client.js`, through
`engine/spawn-worker.js::spawnWorker`):

```js
const Sidecar = require('bare-sidecar')
const args = [
  userData, // Bare.argv[2]: absolute path, required
  profileId || '', // Bare.argv[3]: '' means "none"
  profilePath || '', // Bare.argv[4]: '' means "none"
  backend || '', // Bare.argv[5]: share-backend limit, '' means "no limit"
  freenetNode || '' // Bare.argv[6]: Freenet node URL, '' means the default
]
if (coreHost) args.push(coreHost) // Bare.argv[7]: zxterm-core host module, only when given
new Sidecar(require.resolve('zbterm-core/worker.js'), args)
```

Observed process line on Linux:

```
<node_modules>/bare-sidecar/prebuilds/<platform>-<arch>/bare \
  <…>/zbterm-core/worker.js <userData> <profileId> <profilePath> <backend> <freenetNode> [<coreHost>]
```

so inside the worker `Bare.argv[2] = userData`, `Bare.argv[3] = profileId`,
`Bare.argv[4] = profilePath`, `Bare.argv[5] = backend`,
`Bare.argv[6] = freenetNode` and, when present, `Bare.argv[7] = coreHost`.
The argv is `[userData, profileId, profilePath, backend, freenetNode, coreHost?]`,
with empty strings (never `undefined`) for the four optional ones in between.
**Argv order is contract.** An empty string is coerced to `null` (or "no
value") by the worker. The order is pinned by `test/backends/registry.test.js`
('host: the limit reaches the worker as the 4th spawn argument').

The 4th argument, `backend`, is the **share-backend limit**: `pear`, `freenet`,
`none`, or `''` for no limit (`EngineClient`'s `backend` option). It only ever
narrows the set of backends the build carries and never adds one; `none` makes
the core local-only. It is a spawn argument rather than an invoke so that
nothing can race it, and rather than an environment variable because the
worker's environment was not reliably inherited under the Pear runtime the
sidecar launch descends from. A host that passes three arguments gets no limit.
Resolving the value is the host's job — ZBTerm's Electron shell takes
`--backend`, then `ZBTERM_BACKEND`.

The 5th argument, `freenetNode`, is the WebSocket URL of the Freenet node the
Freenet backend talks to, `''` for its default
(`ws://127.0.0.1:7509/v1/contract/command`). `EngineClient` takes it as its
`freenetNode` option (ZBTerm's shell resolves `--freenet-node`, then
`ZBTERM_FREENET_NODE`); the worker hands it to `SessionEngine` as
`backendOptions: { nodeUrl }`.

The optional 6th argument, `coreHost`, is the absolute path of a host module
exporting `{ spawn(bin, args), bin() }` (ZBTerm's is
`electron/zxterm-core-host.js`). The worker requires it and installs it with
`engine/zxterm/core.js::setCoreHost`. `EngineClient` passes it only when given
its `coreHost` option (ZBTerm's shell always gives it). **A host that passes
none means no Rust sidecar**: every `identity.*` method then fails at once with
`E_BACKEND_UNAVAILABLE` naming the reason.

> **History.** Until 2026-09-19 (`D-07`, `D-08`) the launch went through
> `pear-runtime`'s `PearRuntime.run`, which is the same `new Sidecar(entrypoint, args)` outside
> Bare; the OTA updater that needed `pear-runtime` was removed, and `zbterm-core` now depends on
> `bare-sidecar` directly. From 2026-09-24 (`F4`) to 2026-09-29 (`K11`, `D-34`) the 5th argument
> was `hostCaps` (`'rtc'` when the host offered a WebRTC adapter, `electron/rtc-host.js`); WebRTC
> moved into the `zxterm-core` sidecar and the slot became `freenetNode`. `EngineClient`'s
> `rtcHost` option is gone. Host and core ship together, so no host passes `'rtc'` there.

### The `zxterm-core` sidecar

Identity and the Freenet backend cross a **second seam**, distinct from the Bare
`worker.js` seam this section describes. The Rust `zxterm-core` sidecar (a separate binary built
from `zevix/zxterm`, the `zxterm/` submodule; not this npm package, `zbterm-core`, whose worker it
serves) owns every identity path: SSH-key discovery and signing (files and agent), the identity
claim, verification, provider key lookups (`<user>.keys` over HTTPS, base URL
`ZBTERM_GITHUB_KEYS_BASE`), and the identity key (`X-01`). Since K11 (2026-09-29, `D-34`) it also
runs the Freenet backend's contract client, WebRTC peer connections and session protocol: the
worker's `engine/backends/freenet/index.js` is a proxy to it (`freenet.*` and `share.*` requests,
seam events, and `Chan` frames for data-channel bytes). No Freenet traffic crosses the worker pipe.

- **Who spawns it.** The Bare worker, one sidecar per profile, on first use:
  `engine/zxterm/core.js::Core` asks the host module named by `Bare.argv[7]` for the binary
  (`bin()`) and spawns it with that module's `spawn()` - process spawning stays a host capability
  (`test/core-boundary.test.js`). The command is
  `zxterm-core sidecar --profile <profile>/account --exit-on-stdin-eof`; its identity store is
  `<profile>/account/identity`, the files `IdentityStore` always used.
- **Where the binary is.** `node_modules/@zbterm/zxterm-core-<platform>-<arch>/zxterm-core[.exe]`
  (the platform's optional dependency), then `npm/zxterm-core-<platform>-<arch>/` in the app
  directory (staged by `scripts/sidecar.js`); `ZXTERM_CORE_BIN` overrides both. A missing
  binary is a named `E_BACKEND_UNAVAILABLE` ("zxterm-core sidecar binary not found ... looked in
  ..."), never a hang.
- **The seam.** A local socket, `<profile>/account/zxterm-core.sock` (a named pipe on Windows,
  not implemented yet), carrying length-prefixed `postcard` frames with JSON payloads
  (`engine/zxterm/{codec,client}.js`; `zxterm_core::seam`, `X-11`).

Storage root resolution, in order: `profilePath` if given; else
`<userData>/zbterm-profiles/<profileId>` if `profileId` is given; else
`<userData>/zbterm`. A `profileId` must already exist in the profile registry
(`ready()` takes its lock and throws `Profile does not exist` otherwise) — a
host with no profile concept should pass `profilePath` and no `profileId`.

### Pipe framing

The sidecar's IPC pipe is wrapped in `FramedStream` on both ends — `new
FramedStream(Bare.IPC)` in the worker, `new FramedStream(worker)` in the client
— with the default 32-bit setting. On the wire:

```
[ uint32 LE payload length ][ payload ]
```

and every payload is one frame:

```
[ uint8 kind ][ uint32 id ][ compact-encoding body, per kind ]
```

`id` is 0 for events and fire-and-forget frames, and the invoke id otherwise.
A body that truncates, over-runs, or names an unknown kind raises
`EngineError(E_CORRUPT)`; the wire is treated as untrusted.

`FrameKind` numbers are **wire-compatible state and are never renumbered**:

| #   | kind              | direction   | body                                                                                  |
| --- | ----------------- | ----------- | ------------------------------------------------------------------------------------- |
| 0   | `INVOKE`          | host → core | `{ method: string, args: json }`                                                      |
| 1   | `REPLY_OK`        | core → host | `{ result: json }`                                                                    |
| 2   | `REPLY_ERR`       | core → host | `{ error: json }` (EngineError.toJSON())                                              |
| 3   | `EVENT_JSON`      | core → host | `{ name: string, data: json }`                                                        |
| 4   | `EVENT_DATA`      | core → host | the binary event body of §5                                                           |
| 5   | `PTY_SPAWN`       | core → host | `{ sessionId, cols, rows, shell?, cwd? }`                                             |
| 6   | `PTY_WRITE`       | core → host | `{ sessionId, data: buffer }`                                                         |
| 7   | `PTY_RESIZE`      | core → host | `{ sessionId, cols, rows }`                                                           |
| 8   | `PTY_KILL`        | core → host | `{ sessionId }`                                                                       |
| 9   | `PTY_PAUSE`       | core → host | `{ sessionId }`                                                                       |
| 10  | `PTY_RESUME`      | core → host | `{ sessionId }`                                                                       |
| 11  | `PTY_DATA`        | host → core | `{ sessionId, data: buffer }`                                                         |
| 12  | `PTY_EXIT`        | host → core | `{ sessionId, code?: uint, signal?: uint }`                                           |
| 13  | `PTY_ATTACH`      | core → host | `{ sessionId, cols, rows }`                                                           |
| 14  | `PTY_DETACH`      | both ways   | `{ sessionId }`                                                                       |
| 15  | `BACKEND_OPEN`    | removed     | removed 2026-09-29 (K11 of zxterm-core, `D-34`); the number is never reused          |
| 16  | `BACKEND_SIGNAL`  | removed     | removed 2026-09-29 (K11 of zxterm-core, `D-34`); the number is never reused          |
| 17  | `BACKEND_STATE`   | removed     | removed 2026-09-29 (K11 of zxterm-core, `D-34`); the number is never reused          |
| 18  | `BACKEND_CHANNEL` | removed     | removed 2026-09-29 (K11 of zxterm-core, `D-34`); the number is never reused          |
| 19  | `BACKEND_DATA`    | removed     | removed 2026-09-29 (K11 of zxterm-core, `D-34`); the number is never reused          |
| 20  | `BACKEND_FLOW`    | removed     | removed 2026-09-29 (K11 of zxterm-core, `D-34`); the number is never reused          |
| 21  | `BACKEND_CLOSE`   | removed     | removed 2026-09-29 (K11 of zxterm-core, `D-34`); the number is never reused          |

`PTY_ATTACH` and `PTY_DETACH` were appended in the attach-over-the-seam change
(§6); 0–12 are untouched and `PTY_EXIT`'s body is byte-identical to what it has
always been. `PTY_DETACH` is the one kind that travels in both directions:
core → host it means _let go of this terminal_ (the host's `kill()` on a session
it registered through `attach()` detaches rather than terminates), host → core
it means _the terminal is gone_, and the core turns that signal-less frame into
`DETACH_SIGNAL` on its own side.

Kinds 15–21 (`BACKEND_*`) are **removed and reserved**. From 2026-09-24 (`F4`, `D-06`/`D-09`)
to 2026-09-29 (`K11`, `D-34`) they carried the Freenet backend's WebRTC peer connections between
the core and a host-side adapter (`electron/rtc-host.js`); WebRTC now runs inside the
`zxterm-core` sidecar, and that adapter, `engine/backends/freenet/rtc-remote.js` and their tests
are gone. A frame of kind 15–21 decodes as an unknown kind (`E_CORRUPT`); the numbers are never
reused, and a new kind is appended after 21.

There is exactly **one** pipe, on purpose: a single ordered stream keeps
terminal data, replies and lifecycle events in their true relative order.

### Handshake

The worker's first frame after a successful boot is `EVENT_JSON`
`engine:worker-ready` with `{ sessionIds: string[] }` — the sessions the core
still has open, which is also the reattach payload (§4). A failed boot sends
`engine:worker-ready-error` with a serialized `EngineError` instead. Both are
consumed by `EngineClient` and never re-emitted under those names: they resolve
or reject `ready()`/`respawn()` and surface as `worker:ready`.

### Shutdown

`client.close()` ends the pipe, waits for exit, escalates to `destroy()` at 5 s
and `SIGKILL` at 7 s. The worker's own teardown closes the engine with a 7 s
hard-exit guard. `PTY_EXIT.signal` is an **optional uint** (node-pty reports
numeric signals), so a string signal cannot cross this seam — which is why a
detach is its own frame kind (`PTY_DETACH`) rather than a `PTY_EXIT` variant.
See §6.

---

## 4. Supervision semantics

Provided by `EngineClient` (core) plus the restart-window policy the host
applies on top (`electron/engine-lifecycle.js` is the reference implementation;
`RESTART_LIMIT = 3` restarts per `RESTART_WINDOW_MS = 60000`).

- **Crash.** The worker process exiting without a `close()` emits
  `worker:exit` `{ code, status, unexpected: true }`. Every in-flight invoke
  rejects with `E_INTERNAL`; further invokes reject with
  `Engine worker is restarting` until a respawn reports ready.
- **Hang.** An invoke with no reply within `INVOKE_TIMEOUT_MS` (60 s) rejects,
  then `_signalWorkerFailure()` emits the same `worker:exit`
  (`code: null`, `unexpected: true`) and destroys the worker, so a wedged
  sidecar is treated exactly like a crashed one. Emitted at most once per
  worker generation.
- **Restart.** `respawn()` replaces only the dead process and pipe. The
  `EngineClient` instance, its listeners and `ptyHost` — i.e. every live
  terminal — survive; a fresh client per restart would orphan them. It resolves
  with `{ sessionIds }` or rejects (typically because the dead worker's profile
  lock has not been released yet).
- **Restart window.** The host counts restarts; past its limit it stops
  respawning, surfaces a fatal `engine:error` and tears the client down rather
  than crash-looping a process that holds DHT announces.
- **Reattach.** On every `engine:worker-ready`, the client diffs
  `{ sessionIds }` against `ptyHost.sessions`: terminals the new worker does
  **not** know are killed and their buffers dropped; terminals it does know get
  their buffered output replayed as ordinary `PTY_DATA`/`PTY_EXIT` frames.
- **Buffering while down.** Output from surviving terminals is buffered per
  session up to `SessionEngine.FLOW_LIMIT` (1 MiB), past which the PTY is
  paused. Nothing is unbounded.

The Rust `zxterm-core` sidecar (§3) is supervised by the worker that spawned it,
like a share backend:

- **Health** is `core.health`, in the backend `HealthReport` shape
  (`engine/backends/types.js`): `{ started, listening, detail }`, `detail` the
  last failure.
- **It dies with its worker.** It runs with `--exit-on-stdin-eof` on a stdin
  pipe nobody writes to, so a worker that exits, crashes or is killed takes it
  along; `SessionEngine.close()` stops it too.
- **Restart.** A sidecar that exited is started again by the next identity (or
  Freenet) call, with none of the old one's state. A start that finds the
  profile still held by a sidecar that is exiting (a worker restart) is retried
  up to five attempts, 100 ms apart; every attempt is bounded by the seam's
  connect timeout, so it never hangs.

---

## 5. Method and event surface

### 5.1 Methods

Every method reachable through `SessionEngine.invoke(method, args)` — in
process, or as `INVOKE` frames over the sidecar seam. `args` is always a plain
JSON object; results are always JSON.

<!-- contract:methods:begin -->

| method                   | args                                                               | result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping`                   | —                                                                  | `{ ok: true, pong: true }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `session.create`         | `{ name?, cols?, rows?, mode?, cwd?, command?, copyHistoryFrom? }` | catalog entry + `{ restoring, info, timeline, availability }`; `copyHistoryFrom: sessionId` copies that local (not joined) recording's packets and snapshots into the new one (re-sealed, same seqs/timestamps) **in the background**: live at once, `timeline` already lists the copied seqs, `availability` counts the copied part, `session:availability-changed` reports progress, `startedAt` is the copied history's start and `restoring` lasts until the copy and screen rebuild end (see §7) |
| `session.extend`         | `{ sessionId }`                                                    | live at once, `restoring` until history is rebuilt (**spawns**, see §7); revived at the last recorded grid, result carries `cols`, `rows` and the last reported `fontSize` (or `null`)                                                                                                                                                                                                                                                                                                                |
| `session.open`           | `{ sessionId }`                                                    | session state: `{ sessionId, info, active, timeline, length, availability, frame, hd, … }`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `session.close`          | `{ sessionId }`                                                    | ends the recording; the PTY is killed (detached in attach mode)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `session.delete`         | `{ sessionId }`                                                    | removes the recording and its storage                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `session.rename`         | `{ sessionId, name }`                                              | updated catalog entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `session.update`         | `{ sessionId, name?, cwd?, command? }`                             | updated catalog entry; `cwd`/`command` apply on the next extend                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `session.defaultName`    | —                                                                  | `{ name }`: the auto-name `session.create` would pick without a `name`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `session.list`           | `{ … }`                                                            | **a bare `[catalog entry]` ARRAY** (not `{ sessions }`); ended entries have no `length` — use `sizeBytes`                                                                                                                                                                                                                                                                                                                                                                                             |
| `session.input`          | `{ sessionId, data }`                                              | writes to the terminal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `session.resize`         | `{ sessionId, cols, rows, fontSize? }`                             | records geometry; rejects non-positive integers; a valid `fontSize` (CSS px) is kept in the catalog entry, anything else is ignored                                                                                                                                                                                                                                                                                                                                                                   |
| `session.ack`            | `{ sessionId, bytes }`                                             | viewer flow-control ack; resumes a paused PTY                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `session.diagnostics`    | `{ sessionId? }`                                                   | `{ sessions: [ … ] }`, see §6                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `session.setHd`          | `{ sessionId, enabled }`                                           | toggles HD capture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session.removeHd`       | `{ sessionId }`                                                    | drops the HD track                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session.clearCaches`    | `{ sessionId }`                                                    | clears snapshot/mirror caches                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `player.open`            | `{ sessionId }`                                                    | playback state for a recording                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `player.seek`            | `{ sessionId, tsMs }`                                              | seeks playback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `player.play`            | `{ sessionId, speed, collapse }`                                   | starts playback; emits `player:data`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `player.pause`           | `{ sessionId }`                                                    | pauses playback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `player.step`            | `{ sessionId, delta }`                                             | steps by packets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `player.view`            | `{ sessionId, cols?, rows?, tsMs? }`                               | fit-to-window playback: re-renders history at `cols`x`rows` (omit both for true-to-recording), optionally landing at `tsMs`; **pauses**, like seek/step                                                                                                                                                                                                                                                                                                                                               |
| `identity.get`           | —                                                                  | device/DHT identity + `{ provider, displayId }`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `identity.self`          | —                                                                  | the signed self claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `identity.beginClaim`    | `{ … }`                                                            | starts a provider identity claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `identity.setSelf`       | `{ … }`                                                            | stores a completed claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `identity.clear`         | —                                                                  | clears the local identity                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `identity.peers`         | —                                                                  | known peer identities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `identity.annotatePeer`  | `{ … }`                                                            | annotates a peer record                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `identity.lookup`        | `{ … }`                                                            | looks a provider identity up                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `identity.inspectInvite` | `{ uri }` or `{ claim }`                                           | checks the identity an invite carries, before connecting                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `identity.sshCandidates` | —                                                                  | signable SSH keys the core finds (`~/.ssh`, config, agent)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `identity.sshInspect`    | `{ keyPath }`                                                      | one SSH key file, as a candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `identity.sshSign`       | `{ messageBase64, keyPath, publicKeyBlobBase64 }`                  | an SSHSIG over the claim bytes (file or agent)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `core.health`            | —                                                                  | the `zxterm-core` sidecar's `{ started, listening, detail }`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `account.profile`        | —                                                                  | account profile record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `account.devices`        | —                                                                  | devices on the account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `account.localDevice`    | —                                                                  | this device's record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `device.revoke`          | `{ deviceKey, reason }`                                            | revokes a device                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `profile.list`           | —                                                                  | `{ profiles: [ … ] }` including lock state                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `profile.create`         | `{ … }`                                                            | creates a profile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `profile.rename`         | `{ profileId, name }`                                              | renames a profile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `profile.deleteEmpty`    | `{ profileId }`                                                    | deletes an empty profile                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `debug.currentSelection` | —                                                                  | **always `null`** — a vestigial stub, see §7                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `preference.get`         | `{ key }`                                                          | stored string or `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `preference.set`         | `{ key, value }`                                                   | `{ key, value }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `share.backends`         | —                                                                  | `{ backends: [{ id, label, capabilities, state, detail }], default, active, limitedBy }` — see "Share backends" below                                                                                                                                                                                                                                                                                                                                                                                 |
| `share.createLink`       | `{ sessionId, backend?, … }`                                       | the stored link record plus `uri`, its `zbterm://join/…` invite. `backend` names the share backend (an `id` from `share.backends`); omitted means the default. `E_BACKEND_UNSUPPORTED` when this build lacks it, `E_BACKEND_UNAVAILABLE` when another backend is in use                                                                                                                                                                                                                                                                   |
| `share.listLinks`        | `{ sessionId }`                                                    | issued links                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `share.revokeLink`       | `{ sessionId, linkId }`                                            | revokes one link                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `share.revokeMember`     | `{ sessionId, identityKey }`                                       | revokes one member                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `share.join`             | `{ uri }`                                                          | joins someone else's session                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `share.diagnostics`      | —                                                                  | swarm/relay diagnostics (distinct from `session.diagnostics`). `backend` is the active backend's own report (`{ id, … }`, `null` while none is active); the older top-level keys `relayPublicKey`, `relayFallbackMs`, `hostSwarm` stay as aliases of it                                                                                                                                                                                                                                               |
| `share.approveJoin`      | `{ sessionId, requestId }`                                         | approves a pending join                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `share.denyJoin`         | `{ sessionId, requestId }`                                         | denies a pending join                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `share.setInputMode`     | `{ sessionId, mode }`                                              | host/viewer input mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `share.setIceServers`    | `{ iceServers }`                                                   | `{ iceServers }` — the host's ICE servers (an array of ICE URLs; `[]` means host candidates only, `null` the zxterm-core sidecar's own list, K11), used for every peer connection a backend opens from now on (freenet-backend F9, `D-11`)                                                                                                                                                                                                                                                                           |

<!-- contract:methods:end -->

An unknown method rejects with `EngineError(E_INTERNAL, "Unknown method: …")`.

**Playback geometry.** `player.open`, `player.seek`, `player.step` and
`player.play` all render at the geometry the recording was made at; that is the
default and it never changes. `player.view` is the opt-in second mode: it
re-renders history through the core's headless terminal at a geometry the
caller supplies, ignoring the recording's own RESIZE packets, so line-oriented
output re-wraps to a narrow panel. Both `player.open` and `player.view` also
return

```js
altScreen: { used: boolean, ranges: [{ fromSeq, fromTsMs, toSeq, toTsMs }], scanned: boolean }
```

— every stretch of the recording that was painted on the **alternate screen**
(DEC private modes 47/1047/1049). Nothing is stored for this: it is scanned out
of the packet stream on playback and cached on the open player, so recordings
made before it existed answer too. `toSeq === null` means the recording ends
inside the alternate screen; `scanned: false` means the scan could not run (a
remote store still downloading) and the answer is unknown, not "safe".
Re-rendering alternate-screen output at another width is wrong by construction
— absolute cursor positioning is baked into the bytes — so a caller offering
fit-to-window must refuse it for those ranges.

**Share backends.** Network sharing is provided by a _share backend_, and a
build may carry several, one, or none. `share.backends` reports what this run
can use and activates nothing:

```js
{
  backends: [{ id, label, capabilities, state, detail }],
  default, // id `share.createLink` uses when no `backend` is given, or null
  active, // id of the backend in use, or null: none is created until the first share or join
  limitedBy // the launch limit in force ('pear', 'freenet', 'none'), or null
}
```

`state` is `'available'` or `'broken'`; a broken backend is listed with a
human-readable `detail` so a host can say why sharing is missing, and is never
the `default`. A backend the build does not carry, or that the launch limit
(section 3, 4th spawn argument) excludes, is not listed at all. `capabilities`
is a bitset; adapters should treat it as opaque unless they ship with the core.
An empty `backends` means the core is local-only: a host should hide its share
and join UI, and every share call rejects with `E_BACKEND_UNSUPPORTED`.

Backends can run side by side. Each one starts on the first `share.createLink`
that names it (its `backend` argument, else `default`) or the first `share.join`
of an invite for it, and stays running until the core closes. A session is
shared over one backend at a time: `share.createLink` naming another backend for
an already shared session rejects with `E_BACKEND_UNAVAILABLE`. `share.backends`
lists the running ones in `running`; `active` is the default one when it is
running, else the first started.

**The Freenet backend** (`freenet`) is a proxy, in the worker, to the profile's
`zxterm-core` sidecar (§3), which runs the Freenet contract client, the WebRTC
peer connections and the Freenet session protocol (zxterm's
`docs/projects/260928_zxterm-core/protocol.md`, "Freenet session protocol v2").
What a caller of the `share.*` methods sees is the same as for the other
backends, except:

- **Listing.** `freenet` is `available` whenever the build carries it, and
  `share.backends` then awaits its static `probe(ctx)` (at most 2 s,
  `engine/backends/index.js::probe`), which asks the sidecar to open a WebSocket
  to the node. With no node answering, the entry is `broken` with `detail`
  `'no Freenet node at <scheme://host:port> — see README "Freenet"'`, and it is
  then not the `default`.
- **Errors.** The backend answers `E_BACKEND_UNAVAILABLE` with
  `details: { backend: 'freenet', detail }`: `'no Freenet node at
  <scheme://host:port>'` when `start()` finds no node, `'not started'` when no
  `start()` is under way or it failed (calls made while `start()` is still
  running wait for it), `'no transport key'` when a route is asked for before
  an identity exists, and `'core exited'` when the sidecar went away under a
  dial. A peer whose DTLS certificate is not the one in the SDP the host signed
  is rejected with **`E_AUTH`** / `'fingerprint mismatch'` before any connection
  is surfaced; a peer connection that fails before it is up is
  `E_HOST_UNREACHABLE` / `'ice-failed'`. A join whose dial is rejected ends at
  once with `share:join-changed` `{ status: 'failed', code, detail, backend,
  message }` rather than at the join timeout.
- **Admission.** The half-open peer connections of a Freenet link expire after
  15 s, and one viewer key holds at most 2 of the 8 a link allows (`S-22`).
- **ICE.** `share.setIceServers` sets the ICE list for new peer connections
  (`[]`: host candidates only; `null`: the sidecar's own list). The sidecar has
  no TURN client (`X-18`), so `describe()` never claims `RELAY`, and the
  backend's `share.diagnostics` report carries `ice: { servers,
  hostCandidatesOnly, relay: false }` (servers without credentials).
- **Routes.** An invite's Freenet `route` is minted by the sidecar and carries
  `params.pv = 2`; ZBTerm passes it through untouched. A route without it is
  refused by the joiner, offline, with `share:join-changed` `{ status:
  'failed', code: 'E_BACKEND_UNSUPPORTED', reason: 'unreachable' }`. A link
  stored before this protocol has a route the sidecar refuses, so
  `share.listLinks` mints, stores and announces a new one for it, and that
  link's `uri` changes. The first epoch of a Freenet share is minted when the
  share opens, so its numbers run one higher than a Pear share's.
- **History.** The sidecar serves a session's history: `serveHistory()` does
  nothing on Freenet, `attachHistory()` returns a `CoreHistoryHandle`
  (`engine/zxterm/history.js`), and `historyRouteFor(store)` is
  `{ kind: 'segment-v1', host, session }` once the store knows the host's
  history signing key.
- **Trace.** A Freenet share's `share:debug` trace also carries the sidecar's
  own events (with a `joinId` in their details) and adds `host:core:error`,
  `host:push:error`, `host:epoch:timeout`, `host:join-revoked-late`,
  `host:link:route-refreshed` and `host:link:route-check-failed`.

> **History.** The Freenet backend landed in phases `F3`–`F9` (2026-09-24) with its WebRTC half in
> the host process (`BACKEND_*` frames, `'host has no WebRTC adapter'`, a raw `zbterm/history 00`
> channel); `K11` (2026-09-29, `D-34`), `K14` (`D-38`) and `K17` (`D-40`, 2026-09-30) moved
> WebRTC, the session protocol and history into the `zxterm-core` sidecar, as described above.

### 5.2 Low-rate events (`EVENT_JSON`)

`LOW_RATE_EVENTS` from `rpc/schema.js`. JSON payloads, emitted by the core
without a pending request. A host subscribes with `engine.on(name, cb)` and
must ignore names it does not know.

<!-- contract:low-rate-events:begin -->

| event                          | payload                                             |
| ------------------------------ | --------------------------------------------------- |
| `session:exit`                 | a session's terminal ended                          |
| `session:hd-changed`           | HD capture toggled                                  |
| `session:restored`             | an extended or history-copying session is caught up |
| `session:availability-changed` | how much of a joined or copied recording is present |
| `session:list-changed`         | the full catalog list, after any change             |
| `share:changed`                | sharing status for a session                        |
| `share:join-changed`           | join status for a joined session                    |
| `share:approval-pending`       | a peer is waiting for approval                      |
| `share:approval-cancelled`     | that peer left before the approval was decided      |
| `share:peer-identity`          | a peer's verified identity                          |
| `share:debug`                  | swarm/relay debug trace                             |
| `player:frame`                 | a rendered playback frame                           |
| `player:end`                   | playback reached the end                            |
| `engine:error`                 | a non-fatal `EngineError.toJSON()`                  |
| `identity:changed`             | the local identity changed                          |

<!-- contract:low-rate-events:end -->

Payload details a host commonly needs:

- `share:join-changed` `{ status: 'failed' }` carries `reason`, one of
  `engine/share-manager.js::JOIN_REASONS`: `denied`, `revoked`, `consumed`,
  `full`, `ended`, `bad-identity-proof`, `device-revoked`, `identity`,
  `unreachable`, `no-answer`, `closed`, `host-mismatch` (`S-32`–`S-34`).
  `joined` is emitted once per join; later host bootstraps arrive as
  `session:restored`.
- `session:exit` carries `uptimeMs` and `command` next to `exit`.
- `share:approval-cancelled` `{ requestId, sessionId }` says the requester of a
  pending `share:approval-pending` left before it was decided.

The PTY host (§6) is the only host adapter the core needs. Provider key lookups
are made by the `zxterm-core` sidecar (§3), which has its own HTTP client; the
`identity:resolve-request` event and `identity.resolveResult` method that once
asked the host to make them were removed on 2026-09-29 (K9).

Two more names reach a host from `EngineClient` itself and are **not** core
events: `worker:ready` `{ sessionIds }` and `worker:exit`
`{ code, status, unexpected }`. `engine:worker-ready` /
`engine:worker-ready-error` are consumed by the client and never re-emitted.

### 5.3 Hot binary events (`EVENT_DATA`)

`EVENT_DATA_NAMES` from `rpc/schema.js`. These two carry terminal bytes and are
never JSON- or base64-wrapped — that is the whole reason the frame kind exists.

<!-- contract:event-data-names:begin -->

| event          | fields                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `session:data` | `{ sessionId: string, source: string\|null, hd: boolean, data: Buffer }`                                      |
| `player:data`  | `{ sessionId: string, seq: uint, tsMs: uint, kind: uint, cols: uint, rows: uint, hd: boolean, data: Buffer }` |

<!-- contract:event-data-names:end -->

On the wire both share one body — a name tag, `sessionId`, `hd`, then
`source`/`seq`/`tsMs`/`kind`/`cols`/`rows`/`data` each optional — so absent
fields decode as `null`. `session:data` fires for live host output **before**
`session.create`'s own reply returns, so a consumer that needs the first bytes
must subscribe before it invokes.

---

## 6. PTY host interface

The core owns the interface; the host owns the implementation. It is a
constructor option, never a require: `new SessionEngine({ ptyHost })` and
`new EngineClient({ ptyHost })` both throw `EngineError(E_INTERNAL)` without
one. The core cannot tell implementations apart, which is the point.

```js
// The host object: an EventEmitter with a `sessions` Map keyed by sessionId.
spawn(sessionId, { cols, rows, shell, cwd }) -> { write, resize, pause, resume, kill }
write(sessionId, data)          // data: Buffer
resize(sessionId, cols, rows)
pause(sessionId) / resume(sessionId)
kill(sessionId)

events: 'data' -> { sessionId, data: Buffer }
        'exit' -> { sessionId, exit: { code, signal } }
```

Attach mode, added in Phase 3, is the optional half — for hosts that _already
own_ a terminal (a tab in another terminal app, an SSH session someone else launched):

```js
createSession({
  name?: string,              // unchanged
  cols?: number,              // unchanged, default 100
  rows?: number,              // unchanged, default 30
  mode?: 'spawn' | 'attach'   // NEW in Phase 3; anything not === 'attach' means 'spawn'
})
// mode:'attach' throws EngineError E_INTERNAL if typeof ptyHost.attach !== 'function'.
// The catalog entry shape is deliberately UNCHANGED (no `mode` field) so attach and spawn
// recordings stay indistinguishable to replay.

attach(sessionId, { cols, rows }) -> { write, resize, pause, resume, kill }
// same data/exit events as spawn; kill() DETACHES, resize() is never called by the core,
// pause() is advisory (the core buffers to ATTACH_BUFFER_LIMIT = 4 MiB, replays on ack(),
// then drops and counts).

diagnostics(sessionId?) -> { sessions: [{ sessionId, mode, active, cols, rows,
  pendingBytes, flowPaused, bufferLimit, bufferedBytes, bufferedChunks,
  droppedBytes, droppedChunks }] }
// NEW in Phase 3, routed over the seam as `session.diagnostics`. Distinct from
// share.diagnostics(). electron/debug-server.js has no dedicated route for it
// (POST /invoke reaches it).
```

Three semantics differ from spawn mode:

- `kill()` **detaches** — the core lets go, the host's terminal keeps running.
  `session.close`, `session.delete` and `close()` all go through it, so none of
  them can ever kill a terminal the core did not launch. If the host reports no
  signal on the resulting `exit`, the core records `signal: 'detached'`
  (`DETACH_SIGNAL`) so the catalog says why the session ended.
- `resize()` is never called by the core; `session.resize` only _records_ what
  the host reports, and rejects non-positive-integer geometry rather than
  writing it into the timeline where it would corrupt playback permanently.
- `pause()` is advisory. Output that keeps arriving after a pause is held in a
  per-session buffer capped at `ATTACH_BUFFER_LIMIT` (4 MiB), replayed when
  `session.ack` resumes the flow, and past the cap dropped and counted —
  `session.diagnostics` reports both numbers and the core warns once on
  `engine:error`.

**Attach mode works in-process and across the sidecar seam.** It was
in-process-only until the protocol was extended additively with two appended
frame kinds (§3):

- `createSession({ mode: 'attach' })` in the sidecar makes `engine/pty-remote.js`
  send `PTY_ATTACH` `{ sessionId, cols, rows }`. `EngineClient` answers it by
  calling `ptyHost.attach(sessionId, { cols, rows })`, under the same one-credit-
  per-`session.create`/`session.extend` admission control `PTY_SPAWN` uses. A
  host whose `ptyHost` has no `attach()` gets a `PTY_ATTACH` it cannot serve;
  `EngineClient` replies `PTY_DETACH` so the session ends as a detach instead of
  hanging with a terminal that never produces a byte.
- The attached handle's `kill()` sends `PTY_DETACH`, never `PTY_KILL`. On the
  host side that becomes `ptyHost.kill(sessionId)`, which for a session the host
  registered through `attach()` detaches it — so `session.close`,
  `session.delete` and `close()` cannot kill a host terminal over the seam
  either.
- When the host's own terminal goes away, `EngineClient` sends `PTY_DETACH` (not
  `PTY_EXIT`) for any session it registered through `attach()`. The worker turns
  it into a signal-less `exit`, and the core's attach branch records
  `DETACH_SIGNAL`. **The string `'detached'` never touches the wire**, so
  `PTY_EXIT`'s `signal` stays an optional uint.
- Geometry is validated **before** encoding: `PtyAttach` uses `c.uint`, which
  cannot represent the null / NaN / negative / fractional values the core
  rejects, so `pty-remote.attach()` throws `E_INTERNAL` on bad `cols`/`rows`
  rather than letting compact-encoding fail inside the frame writer.
- The backpressure fallback stays **entirely in `engine/index.js`**. `pause()`
  and `resume()` already cross as `PTY_PAUSE`/`PTY_RESUME`; the 4 MiB buffer,
  the replay on `ack()` and the drop counters live on the core side only. A
  second buffer in the proxy would double-buffer and break the
  `buffered + dropped == pushed` accounting.

`electron/pty-host.js` still implements only the spawn half — the Electron app
has no host-owned terminals to register. A host that wants attach mode supplies
an `attach()` on the PTY host it injects (in-process or into `EngineClient`).

Any further host capability the core needs gets its own named adapter contract
in this shape, never a direct require.

---

## 7. Known gaps

Recorded here rather than papered over:

- **`session.open` on a restoring session has `frame: null`.** Extend spawns
  before the archive screen is rebuilt; hosts repaint on `session:restored`.
  Output in that window is held in memory and appended once the rebuild ends.
- **`copyHistoryFrom` copies after `session.create` returns.** The source's
  length is fixed at create; its store lock is taken per slice (≤250 ms, less
  when someone waits), so the source stays playable, extendable and deletable.
  Until the copy ends, `availability` is `{ availableLength: copied, logLength:
total }` as for a joined download (the `session:availability-changed`
  payload also carries both), the new shell's output is held in memory, and
  `session.removeHd` on the copy is refused. The recording is always: copied
  history, the first resize (stamped with the create time), then live output
  (stamped when produced). A copy cut short - source deleted or rewritten,
  the copy closed, deleted or cleared, the engine shutting down - keeps what
  it copied and writes the rest after it; only real read/write errors surface
  as `engine:error`. A source that is itself still copying cannot be copied.
- **`session.extend` always spawns.** `_createRuntime` defaults `mode` to
  `'spawn'`, so extending an ended attach-mode recording would ask the host to
  launch a terminal. No option expresses "re-attach to _this_ terminal".
- **`debug.currentSelection` is not really a core method.** The core's
  implementation is `return null`; the real value is produced by the host's own
  debug invoke handler (`electron/main.js`), and the renderer even has a
  fallback for `Unknown method: debug.currentSelection`. It is listed above
  because it _is_ reachable through `invoke()`, but adapters should not depend
  on it; it is the first candidate for a deprecation pass.
- **`session.diagnostics` has no dedicated debug-server route**, unlike
  `share.diagnostics` (`GET /share/diagnostics`); it is reachable only through
  the generic `POST /invoke`.
- **The catalog entry shape carries no `mode`**, deliberately — attach and
  spawn recordings are indistinguishable to playback, and that is contract.
