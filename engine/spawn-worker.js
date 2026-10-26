// The one place a Bare worker is spawned (nonpear-no-updater U-2, D-07).
//
// This is exactly what `PearRuntime.run` did outside Bare
// (pear-runtime/lib/run/default.js): `new Sidecar(entrypoint, args, opts)`.
// `pear-runtime` is no longer a dependency of any build (D-08: the OTA updater,
// its only other user, was removed), so `bare-sidecar` is used directly. It is
// required on each call, not at load, so a test can stand a stub in for it.
function spawnWorker(entrypoint, args = [], opts = {}) {
  const Sidecar = require('bare-sidecar')
  return new Sidecar(entrypoint, args, opts)
}

module.exports = { spawnWorker }
