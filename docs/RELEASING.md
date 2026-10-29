# Releasing ZBTerm

ZBTerm has two independent distribution channels (there is no OTA/Pear release path; the updater
was removed, `D-08`):

| Channel    | Artifact                                           | Release path                                    |
| ---------- | -------------------------------------------------- | ----------------------------------------------- |
| npm        | `zbterm` and `@zbterm/zxterm-core-*` on npmjs.org  | `scripts/release-npm.sh --tag`, `publish.yml`   |
| Installers | AppImage / flatpak / snap / dmg / msix              | `Build Release` workflow (manual), `./build_all.sh` |

Cutting an npm release does not cut an installer release, and vice versa. Both share
`package.json#version`.

Publishing always runs in CI. `scripts/release-npm.sh --tag` checks everything, then creates the
version commit and the `v<version>` tag; pushing the tag runs `.github/workflows/publish.yml`.
That workflow first runs `integrate.yml` (lint plus the cross-platform `npm install -g` smoke
matrix) and `packages.yml` (the sidecar builds) against the tag, refuses a tag that does not equal
`v` + `package.json#version`, and only then publishes. The script itself never runs
`npm publish` (its old `--publish` flag now exits with an error).

> **macOS builds are paused** until sharing works on Linux: the macOS entries in `integrate.yml`
> and `packages.yml` are commented out and the two macOS jobs in `build-release.yml` are
> `if: false`. `publish.yml` checks every target's sidecar binary (Linux x64/arm64, macOS
> x64/arm64) before publishing anything, so while macOS is paused a tag publishes nothing,
> rather than only the Linux packages. Nothing has been published to npm yet.

## The zxterm-core sidecar

ZBTerm runs the Rust `zxterm-core` sidecar, whose source is the `zxterm/` git submodule
([zevix/zxterm](https://github.com/zevix/zxterm)). zxterm publishes nothing itself. On a tag,
`publish.yml`:

1. builds the sidecar for every target in `scripts/sidecar.js#TARGETS` (Linux x64/arm64, macOS
   x64/arm64), each on its own native runner, through `packages.yml` (`node scripts/sidecar.js
   build <triple>`, then a `zxterm-core --version` smoke test). Windows is not a target yet: the
   sidecar's named-pipe listener is not implemented, so the npm package's `os` field is
   `darwin`/`linux` only;
2. stages each binary (`node scripts/sidecar.js stage <platform>-<arch> <binary>`) and publishes
   one package per target, `@zbterm/zxterm-core-<platform>-<arch>`, at zbterm's version, each with
   `os`/`cpu` (and `libc: glibc` on Linux) set and the binary, `LICENSE` and
   `THIRD-PARTY-NOTICES.md` at its root;
3. writes those packages into `optionalDependencies`, pinned to the same version
   (`node scripts/sidecar.js inject`), and publishes `zbterm`. npm then installs only the package
   for the user's machine.

The committed `package.json` and lockfile never list the platform packages, so a checkout installs
without them; `npm run build:sidecar` builds and stages the sidecar locally instead.

To get installable builds without publishing, run the **Packages** workflow by hand (Actions >
Packages > Run workflow). Its `zbterm-packages` artifact holds the zbterm tarball and every platform
package; install the zbterm tarball together with the one for your machine:

```sh
npm install -g zbterm-<version>.tgz zbterm-zxterm-core-<platform>-<arch>-<version>.tgz
```

To ship a sidecar change, land it in zxterm, then bump the submodule here:

```sh
git -C zxterm fetch && git -C zxterm checkout <commit>
git commit -am "Bump zxterm to <commit>"
```

First release only: create the `zbterm` organization on npmjs.com (it owns the `@zbterm` scope),
then configure this repository's `publish.yml` as a trusted publisher (npm OIDC, `--provenance`)
of `zbterm` and of each `@zbterm/zxterm-core-*` package, or set an `NPM_TOKEN` secret in the GitHub
`npm` environment. Packages that do not exist yet can only be published with a token; switch to
trusted publishing after.

## Commands

```sh
npm run build:sidecar                    # build and stage this machine's sidecar first
npm run pack:check                       # lockfile freshness + lint + test + pack + tarball audit
npm run smoke:install -- <tarball>       # install it + the staged sidecar into a throwaway prefix and boot it
npm run release:npm -- patch             # dry run: plan + BLOCKERS, changes nothing
npm run release:npm -- patch --tag       # version commit + tag; push it to publish
```

`pack:check` (`scripts/npm-pack-check.sh`) regenerates `package-lock.json` and fails if it was
stale, runs `npm run lint` and `npm test`, packs into the repo root, and checks the tarball: the
`bin/`, `electron/main.js`, `renderer/vendor/`, `build/icon/icon-*.png` and `renderer/logo-ascii.js`
entries are present; `out/`, `node_modules/`, `test/`, `docs/`, `assets/`, `relay/`, `npm/`,
`zxterm/` and `forge.config.js` are absent; no dependency is a `file:`/`link:` path; and the
tarball is at most 5 MB. Its last line of output is the tarball path. `smoke:install` needs the
sidecar staged under `npm/` first (`npm run build:sidecar`).

`release:npm` runs the pack check and the smoke install for you. Without `--tag` it evaluates every
guard, prints the release plan and a `BLOCKERS:` section, and changes nothing (exit 0 with no
blockers, 3 with some):

| Guard               | What it means                                                                 |
| ------------------- | ----------------------------------------------------------------------------- |
| `clean-tree`        | `git status --porcelain` is empty.                                            |
| `branch-confirmed`  | You confirmed the branch you are releasing from (or passed `--yes`).          |
| `version-available` | The target version is not on the registry yet (`E404` = unpublished, fine).   |
| `pack-check`        | `scripts/npm-pack-check.sh` passed.                                           |
| `smoke-install`     | `scripts/npm-smoke-install.sh` passed on the packed tarball and the staged sidecar. |

With `--tag` any failed guard aborts (exit 2) before anything is changed; the cheap guards run
first, so a dirty tree never reaches the pack check. Once all are green the script runs
`npm version <target>` (bump commit and `vX.Y.Z` tag), then prints the `git push --follow-tags`
command instead of running it. `--yes` skips the interactive branch prompt (required when stdin is
not a terminal); the target is `patch`, `minor`, `major` or an explicit `x.y.z`. If `publish.yml` fails after some
platform packages are up, re-run it: it skips the versions that are already published.

## Installer releases

The **Build Release** workflow (`.github/workflows/build-release.yml`) is started by hand (Actions >
Build Release > Run workflow; it can also be called by another workflow) and only runs
`electron-forge make`; nothing in it touches npm. Its jobs (prebuild, Linux x64, Linux arm64,
macOS arm64, macOS x64, Windows; the macOS jobs are paused and the Windows job is disabled, see
below) run in the GitHub `release` environment, which holds the signing
secrets (listed in [`agent_docs/releases.md`](../agent_docs/releases.md)). Each platform job checks out the
`zxterm/` submodule and runs `node scripts/sidecar.js build`, because a desktop build ships the
sidecar staged under `npm/`.

Locally, `./build_all.sh` builds the relay executables, this machine's sidecar, and the GUI
packages for every platform whose sidecar is staged (installers via `make` for the host only).

Windows has no sidecar target (`scripts/sidecar.js#TARGETS`), so the Windows job is disabled
(`if: false`; a Windows package would start without its core) and `build_all.sh` skips win32,
until the sidecar gains a Windows build.

## Version policy

- **patch**: bug fixes, packaging fixes, doc changes.
- **minor**: new user-visible features, CLI subcommands or flags.
- **major**: breaking changes to the CLI, the on-disk data layout, or the share-link/wire format.

Add an entry to [`CHANGELOG.md`](../CHANGELOG.md) before releasing.

## Manual platform checks

`scripts/npm-smoke-install.sh` is Unix-only and covers only the machine it runs on. The npm
package installs on Linux and macOS only (x64 and arm64). On each platform, from a machine that
never had ZBTerm installed:

```sh
npm install -g zbterm
zbterm --version
zbterm doctor
zbterm            # a window opens, a terminal session starts
```

| Platform          | Extra checks                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Linux x64         | `zbterm install-desktop`; the launcher entry and a `zbterm://join/…` link work; `uninstall-desktop` removes them. |
| Linux arm64       | Same, plus `zbterm doctor` reports a `bare-sidecar` prebuild for `linux-arm64`.                 |
| macOS arm64 / x64 | The npm build is unsigned; confirm the Gatekeeper workaround in the README still applies.        |

## Generated files

`renderer/logo.svg` and `build/icon.*` are generated by `npm run icons` from
`renderer/logo-ascii.js` and committed; they are never regenerated during pack or publish.
`renderer/vendor/` is gitignored and regenerated by `scripts/vendor-assets.js` from
`prepack` / `pretest` / `prestart`; `pack:check` fails if it is missing from the tarball.

## Deprecating a bad release

Prefer deprecation: existing installs keep working and everyone else is warned.

```sh
npm dist-tag add zbterm@1.2.2 latest     # first, if the bad version is `latest`
npm deprecate zbterm@1.2.3 "Broken Electron download on Linux; use 1.2.4"
npm deprecate zbterm@1.2.3 ""            # un-deprecate
```

`npm unpublish` is only allowed within 72 hours and only if nothing depends on the version, and a
version number can never be reused. The fix for a bad release is always the next patch.

If a release fails after `npm version` but before the tag is pushed, undo it locally:

```sh
git tag -d v1.2.3
git reset --hard HEAD~1     # only if the bump commit was not pushed
```
