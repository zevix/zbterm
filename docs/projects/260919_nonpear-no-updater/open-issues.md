# Open issues — non-Pear builds without the OTA updater

- **`S-16` / `S-14`.** `tabby-plugin/node_modules` ships inside every package and still holds
  `hyperswarm`, `hyperdht`, `pear-runtime`, `corestore`. Nothing in a non-Pear app loads them,
  but the bytes ship. Fix belongs with trimming package contents (`forge.config.js` `ignore`).
- **No update channel for non-Pear builds** (A-2). They never learn of a new version through
  the app; `electron/updater-available.js::updaterAvailable` is where another channel would hook in.
- **`--no-updates` still spawns the updater worker** with `updates=false` in a Pear build
  (`electron/main.js::getWorker`); only an updater-less build spawns none. Inherited, unchanged.
- **Executor-level scope in `D-07`:** the updater is dropped only from builds without Pear. The
  owner may still want it gone everywhere.
- **GUI acceptance** rests on one uisolate run per variant (`shots/u0-none.png`,
  `shots/u0-default.png`); the OTA update flow itself (finding and applying an update in a
  Pear build) was not exercised.
- The U0 launch script omitted `--electron-user-data` and `--no-updates`; later GUI runs must
  pass both, plus a unique `--storage` and debug port.

> **2026-09-19.** Resolved or changed by [`../260919_no-updater-archive-tabby/`](../260919_no-updater-archive-tabby/):
> no build has an updater now (`D-08`), so the items about the Pear build's updater and
> `--no-updates` spawning a worker are moot; `S-16` is fixed (the plugin is archived and
> `/archive` is not packaged). See that project's `open-issues.md`.
