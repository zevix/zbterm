# Non-Pear builds without the OTA updater — requirements

**Opened 2026-09-19.** Follow-on to [`../260918_backend-abstraction/`](../260918_backend-abstraction/).
Implements `D-07`, which closes the named exception `S-13`.

## Today (measured 2026-09-19)

- `node_modules/pear-runtime/index.js` requires `hyperswarm`, `corestore` and
  `pear-runtime-updater` at load. Its `static run` is `lib/run/default.js`:
  `new (require('bare-sidecar'))(entrypoint, args, opts)`.
- `engine/client.js::EngineClient._spawnWorker` and `electron/main.js` (the updater worker,
  `mainWorkerSpecifier = '/workers/main.js'`) both call `PearRuntime.run`.
- `workers/main.js` is the updater worker; it requires `pear-runtime`, `hyperswarm`, `corestore`.
- `electron/main.js` already has a no-updater path: the npm channel sets `updates = false` and
  never spawns the updater worker (`getWorker`).
- The `none` package built in B7 still ships `hyperswarm` and `hyperdht` (`S-13`).

## Requirements

- **U-1** A package built with `ZBTERM_BUILD_BACKENDS` lacking `pear` contains none of
  `hyperswarm`, `hyperdht`, `pear-runtime`, `pear-runtime-updater`, `corestore`,
  `workers/main.js`, unless another shipped package needs one (report which, do not force).
  `hypercore`, `protomux`, `bare-sidecar` and everything local storage needs stay.
- **U-2** The engine worker is spawned through one helper that uses `bare-sidecar` directly.
  Behaviour in a Pear build is unchanged (same Sidecar, same arguments).
- **U-3** With the updater absent, the host behaves exactly as with `--no-updates`: no updater
  worker, no update UI, no crash, one log line. Decided at run time by whether the updater's
  modules resolve, plus `packageJson.zbtermBackends`; never by a thrown `require`.
- **U-4** A build with `pear` is unchanged: updater present and working as before.
- **U-5** Boundary test: `pear-runtime`, `corestore` and `hyperswarm` may be required only under
  `engine/backends/pear/`, `workers/main.js` and the one host module that owns the updater.
  The "neither" resolution-stub test also makes `pear-runtime` and `corestore` unresolvable and
  the engine client still loads and spawns.
- **U-6** README and `docs/CORE-CONTRACT.md` say which builds have OTA updates.

## Non-goals

A replacement update channel for non-Pear builds. Trimming `test/`, `docs/`, `spikes/`,
`tabby-plugin/` from packages (`S-14`).
