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
  the manifest under `flatpak/` (`net.z33v.zbterm.yml`/`.metainfo.xml`); its
  download URLs/sha512 need updating by hand to a real release location before
  submission — see [README](../README.md) for where the current build lands.
- deb/rpm/AppImage makers are configured; zip is not. The prebuild plugins
  rename (not merge) darwin prebuilds and prune non-target platforms.
- `allowScripts` (`package.json`) is a convention for allow-scripts tooling —
  nothing in this repo enforces it; see README's ["Run from a clone
  (development)"](../README.md#install-dev) section for why `.npmrc`'s
  `ignore-scripts=false` is what actually matters locally.
