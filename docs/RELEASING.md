# Releasing `zbterm` to npm

ZBTerm has two independent distribution channels:

| Channel    | Artifact                                           | Release path                                    |
| ---------- | -------------------------------------------------- | ----------------------------------------------- |
| npm        | `zbterm` and `@zbterm/zxterm-core-*` on npmjs.org  | `scripts/release-npm.sh --tag`, `publish.yml`   |
| Installers | deb / rpm / AppImage / flatpak / snap / dmg / msix | `Build Release` workflow, `./build_all.sh`      |

Cutting an npm release does not cut an installer release, and vice versa. Both share
`package.json#version`.

Publishing always runs in CI. `scripts/release-npm.sh --tag` checks everything, then creates the
version commit and the `v<version>` tag; pushing the tag runs `.github/workflows/publish.yml`.

## The zxterm-core sidecar

ZBTerm runs the Rust `zxterm-core` sidecar, whose source is the `zxterm/` git submodule
([zevix/zxterm](https://github.com/zevix/zxterm)). zxterm publishes nothing itself. On a tag,
`publish.yml`:

1. builds the sidecar for every target in `scripts/sidecar.js#TARGETS` (Linux x64/arm64, macOS
   x64/arm64), each on its own runner;
2. publishes one package per target, `@zbterm/zxterm-core-<platform>-<arch>`, at zbterm's version,
   each with `os`/`cpu` (and `libc` on Linux) set and the binary at its root;
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
then configure this repository's `publish.yml` as a trusted publisher of `zbterm` and of each
`@zbterm/zxterm-core-*` package, or set an `NPM_TOKEN` secret in the `npm` environment. Packages
that do not exist yet can only be published with a token; switch to trusted publishing after.

## Commands

```sh
npm run build:sidecar                    # build and stage this machine's sidecar first
npm run pack:check                       # lint + test + pack + tarball audit
npm run smoke:install -- <tarball>       # install into a throwaway prefix and boot it
npm run release:npm -- patch             # dry run: plan + BLOCKERS, changes nothing
npm run release:npm -- patch --tag       # version commit + tag; push it to publish
```

`release:npm` runs the pack check and the smoke install for you. Without `--tag` it evaluates every guard, prints a
`BLOCKERS:` section and changes nothing:

| Guard               | What it means                                                                 |
| ------------------- | ----------------------------------------------------------------------------- |
| `clean-tree`        | `git status --porcelain` is empty.                                            |
| `branch-confirmed`  | You confirmed the branch you are releasing from (or passed `--yes`).          |
| `version-available` | The target version is not on the registry yet (`E404` = unpublished, fine).   |
| `pack-check`        | `scripts/npm-pack-check.sh` passed.                                           |
| `smoke-install`     | `scripts/npm-smoke-install.sh` passed on the packed tarball and the staged sidecar. |

With `--tag` the script runs `npm version <target>` (bump commit and `vX.Y.Z` tag), then prints
the `git push --follow-tags` command instead of running it. If `publish.yml` fails after some
platform packages are up, re-run it: it skips the versions that are already published.

## Version policy

- **patch**: bug fixes, packaging fixes, doc changes.
- **minor**: new user-visible features, CLI subcommands or flags.
- **major**: breaking changes to the CLI, the on-disk data layout, or the share-link/wire format.

Add an entry to [`CHANGELOG.md`](../CHANGELOG.md) before releasing.

## Manual platform checks

`scripts/npm-smoke-install.sh` is Unix-only and covers only the machine it runs on. On each
platform, from a machine that never had ZBTerm installed:

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
