# Q&A and assumptions

- **Q-1** (asked 2026-09-19, in the previous project's report: "I assumed the updater should
  stay in builds that include Pear. Tell me if you want it removed from every build.") Answer:
  "feel free to remove all the pears update and archive the Tabby work - it did not go well".
- **A-1** "Archive" means move `tabby-plugin/` whole to `archive/tabby-plugin/` (a rename;
  nothing deleted, `node_modules` and `dist` included). Other option: delete it and rely on git.
- **A-2** The core seams built for the plugin stay; only the plugin goes. Other option: revert
  the core/host split. Not asked for, and the npm package uses it.
- **A-3** `--no-updates` stays as an accepted no-op. Other option: remove it and break
  `npm start`, the smoke script and the owner's launcher.
- **A-4** The npm registry check is not "Pear update" and stays.
- **A-5** `pear.json`, `workers/main.js` and `electron/updater-available.js` are deleted, not
  archived: git has them.
- **A-6** The working tree's `node_modules` is not pruned (the owner's live ZBTerm runs from
  it). The lockfile is updated with `npm install --package-lock-only`.
- **A-7** `.github/workflows/build-release.yml` keeps its `upgrade-key` input if it is required
  by the reused action; otherwise it is removed. Decided in V1 by reading the file.
