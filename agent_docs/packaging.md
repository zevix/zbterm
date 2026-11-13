# Packaging gotchas (`forge.config.js`, `build/`, `flatpak/`)

> Read before touching `forge.config.js`, `build/`, or `flatpak/`, or when
> rebranding or changing signing. Only non-obvious, code-verified facts — the
> code is the reference for everything else. Index: [AGENTS.md](../AGENTS.md).

- **asar must stay off** (and is: `forge.config.js` sets no `asar` key, so
  Forge's off-by-default applies): the Bare sidecar is spawned from real file
  paths; asar would break every spawn. Never add `asar: true`.
- `readPackageJson` only applies `ZBTERM_BUILD_BACKENDS` (`applyBuildBackends`,
  which build backends' directories/dependencies the package carries) — it no
  longer validates any upgrade key; there is none (`D-08`).
- `preMake` rewrites the `AppxManifest.xml` Version **in place** (dirties git;
  handles plain `x.y.z` only — prereleases produce an invalid MSIX version).
- `AppxManifest.xml`: Publisher CN must equal the signing cert's CN and stay
  stable across builds, or Windows refuses to install/upgrade the MSIX.
  Rebrand fields appear in several places; only Version is auto-synced.
- macOS signing activates only when `MAC_CODESIGN_IDENTITY` is set
  (+ `KEYCHAIN_PROFILE` for notarization). The CI secrets in
  `agent_docs/releases.md` are consumed by the CI action, **not** directly by
  `forge.config.js`.
- The Snap maker (`pear-electron-forge-maker-snap`) force-sets `base: core24`,
  strict confinement, and the app command to `<productName> --no-sandbox`
  **after** merging config — overriding those in the `snapcraft` block is
  silently ignored. `productName` (`package.json`) must therefore stay a valid
  Snap command name (no spaces/punctuation — see `agent_docs/releases.md`'s
  rebrand trap).
- The Flatpak maker (`pear-electron-forge-maker-flatpak`) emits a package for
  the manifest under `flatpak/` (`net.z33v.zbterm.yml`/`.metainfo.xml`).
  `build_all.sh` runs it only with `--flatpak` (it needs only `tar`, not
  `flatpak-builder`), gated by `scripts/flatpak-release.js`: it needs
  `flatpak/releases/<version>.md` and refuses a version whose Flatpak was built
  from other sources (source-tree fingerprint stamps under `out/`). It then writes
  the tarball's file name + sha512 into the manifest and a `<release>` with the
  notes into the metainfo. The download URLs still need a real release location
  by hand before submission — see [README](../README.md).
- deb/rpm/AppImage makers are configured; zip is not. The prebuild plugins
  rename (not merge) darwin prebuilds and prune non-target platforms.
- The Rust `zxterm-core` sidecar is built from the `zxterm/` git submodule by
  `scripts/sidecar.js`. The npm release publishes it as one package per
  platform, `@zbterm/zxterm-core-<platform>-<arch>`, which `publish.yml`
  injects into `optionalDependencies` at publish time only (the committed
  manifest and lockfile never list them). A desktop build ships the binary
  that `npm run build:sidecar` staged under `npm/zxterm-core-<platform>-<arch>/`;
  run it before packaging. Forge ignores the submodule itself. A packaged app keeps production
  dependencies only: `bare-subprocess`, which the worker uses to spawn the
  sidecar, is a dev dependency at the root (it is declared in
  `engine/package.json`, D-31), so `electron/zxterm-core-host.js` falls back to
  `bare-sidecar`'s own copy (S-39).
- `allowScripts` (`package.json`) is a convention for allow-scripts tooling —
  nothing in this repo enforces it; see README's ["Run from a clone
  (development)"](../README.md#install-dev) section for why `.npmrc`'s
  `ignore-scripts=false` is what actually matters locally.
