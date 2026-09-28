# CI & releases (`.github/`, distributables, npm)

> Read before touching `.github/`, or when preparing a release or debugging why
> a build never reaches installs. Only non-obvious, code-verified facts — the
> code is the reference for everything else. Index: [AGENTS.md](../AGENTS.md).

There is no Pear OTA/staging release path any more (`D-08`, `D-25`): ZBTerm has
three independent release channels, none of them Pear stage/provision/multisig
(see `docs/RELEASE-NPM.md`'s table for the two that remain plus the retired
third).

- **`integrate.yml`**: lint, **plus** a full cross-platform `npm install -g`
  matrix (Linux under Xvfb — the only one that also boots the Bare engine
  headless and polls `/health`; macOS arm64/x64 and Windows — `doctor` only,
  no display). Runs on every push/PR to `main`, and is also called by
  `publish.yml` so a tag cannot publish without it passing on that exact
  commit. `build-release.yml` (distributables) is separate and manual.
- **`build-release.yml`**: manual dispatch (`workflow_dispatch`, also callable),
  per-platform jobs (prebuild, then Linux x64, Linux arm64, macOS arm64,
  macOS x64, Windows) gated on the GitHub `release` environment — signing
  secrets live there. Produces `electron-forge make` distributables only;
  nothing here touches npm.
- **`publish.yml`**: npm-publishes on any `v*` tag (what `npm version` creates)
  after `integrate.yml` passes for that tag. Don't tag unless releasing — see
  `docs/RELEASE-NPM.md` for the actual npm release checklist
  (`npm run pack:check` / `smoke:install` / `release:npm`).
- Rebrand trap: CI lowercases `productName` with `tr` only, but the Snap/
  Flatpak makers also replace non-`[a-z0-9-]` characters (`agent_docs/
  packaging.md`) — a `productName` with spaces or punctuation breaks the
  Linux jobs' artifact lookup.
- `package.json#version` is shared by all three channels (npm, installers, and
  the retired OTA one) — bumping it for npm also changes what the installers
  report.

## Signing secrets (`build-release.yml`, GitHub environment `release`)

| Secret | Platform | Notes |
| ------ | -------- | ----- |
| `CERTIFICATE_P12` | `darwin` | Base64 export of Developer ID Application `.p12`. |
| `CERTIFICATE_PASSWORD` | `darwin` | Password used to export the `.p12`. |
| `MAC_CODESIGN_IDENTITY` | `darwin` | e.g. `Developer ID Application: Name (TEAMID)`. |
| `APPLE_ID` | `darwin` | Apple Developer account email. |
| `APPLE_PASSWORD` | `darwin` | App-specific password (not the account password). |
| `APPLE_TEAM_ID` | `darwin` | From the Apple Developer account. |
| `WINDOWS_CERT_PFX_BASE64` | `win32` | Base64 export of the Windows `.pfx`. |
| `WINDOWS_CERT_PASSWORD` | `win32` | Password for the Windows `.pfx`. |

macOS signing needs an Apple Developer Program membership. The Windows
certificate's subject must match `Publisher` in
[`build/AppxManifest.xml`](../build/AppxManifest.xml). Linux builds are not
signed. Locally, the same variables (`MAC_CODESIGN_IDENTITY`,
`KEYCHAIN_PROFILE`) activate `forge.config.js`'s macOS `osxSign` block
directly (`agent_docs/packaging.md`); the CI secrets above only get them into
the environment.
