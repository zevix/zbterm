# No Pear updater anywhere, Tabby plugin archived — requirements

Opened 2026-09-19. Follow-on to [`../260919_nonpear-no-updater/`](../260919_nonpear-no-updater/).
Owner's words, 2026-09-19: "feel free to remove all the pears update and archive the Tabby
work - it did not go well".

## Today (measured 2026-09-19)

- The Pear OTA updater is `workers/main.js` (requires `pear-runtime`, `hyperswarm`, `corestore`).
  The host owns it in `electron/main.js` (`getWorker`, `mainWorkerSpecifier`, the `pear:applyUpdate`,
  `pear:startWorker` and `app:afterUpdate` handlers, `updaterAvailable`/`hasUpdater`/`updates`),
  `electron/updater-available.js`, `electron/preload.js` (`applyUpdate`, `appAfterUpdate`,
  `startWorker`, `onWorker*`, `writeWorkerIPC`) and `renderer/app.js::wireUpdater`.
- `D-07` dropped it only from builds without the Pear backend
  (`forge.config.js::BUILD_BACKENDS.pear` lists `pear-runtime`, `corestore`, `/workers/main.js`).
- `--no-updates` still spawns the updater worker with `updates=false` in a Pear build.
  `package.json::scripts.start`, `scripts/npm-smoke-install.sh` and the owner's launcher pass it.
- `package.json` has `upgrade: "pear://…"`, `files: [… "workers/" …]`, `workers` in `lint`/`format`,
  and `pear-runtime` + `corestore` under `optionalDependencies`. `forge.config.js` requires
  `pear-link` (installed only as a dependency of `pear-runtime`) to validate `upgrade`.
  `pear.json` holds the OTA multisig. `.github/workflows/build-release.yml` passes `upgrade-key`.
- The npm-channel registry check (`electron/update-channel.js`, `renderer/app.js::wireNpmUpdater`,
  `app.updateCheck`) does not use Pear.
- `tabby-plugin/` is 451 MB with its `node_modules` and ships inside every package (`S-14`,
  `S-16`). Root code that names it: `test/backends/registry.test.js` (reads
  `tabby-plugin/src/main/host.ts`), `test/build-variants.test.js` (a fixture path only).
  Its documents are `docs/tabby-plugin_plan.md` and `docs/tabby-plugin_CHANGELOG.md`.

## Requirements

- **V-1** No build has the Pear OTA updater. `workers/main.js`, `electron/updater-available.js`,
  `pear.json`, `package.json#upgrade`, the `pear-runtime` and `corestore` dependencies, the
  `pear-link` use in `forge.config.js`, and all updater code in the host, preload and renderer
  are gone. No source file outside `docs/`, `spikes/` and `archive/` requires `pear-runtime`,
  `pear-link` or (outside `engine/backends/pear/`) `hyperswarm`.
- **V-2** `--no-updates` is still accepted and does nothing, so existing launchers keep working.
- **V-3** The npm-channel registry check and its Update button are unchanged.
- **V-4** `hyperswarm` and `hyperdht` still leave a package without the Pear backend; the
  `pruneDroppedDependencies` step stays.
- **V-5** The Tabby plugin moves, whole, to `archive/tabby-plugin/`, with its two documents
  under `archive/tabby-plugin/docs/`. `archive/README.md` says what it is and that it is not
  built, tested, linted or packaged. Packages ignore `/archive`.
- **V-6** The core seams the plugin used (`engine/` attach, `docs/CORE-CONTRACT.md`) stay.
  Documents that describe the plugin as live get a dated blockquote.
- **V-7** The suite stays green. A test that only asserted something about the plugin's source
  is removed with the plugin and the drop is named in the handoff, assertion by assertion.

## Non-goals

A replacement update channel for installers. Trimming the rest of the package (`S-14`).
Pruning the working tree's `node_modules`. Git.
