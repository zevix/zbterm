# Releasing `zbterm` to npm

This is the checklist for the **npm distribution channel only**. It is one of
three independent channels:

| Channel | Artifact | Release path | Touched by this doc |
| ------- | -------- | ------------ | ------------------- |
| npm | `zbterm-<version>.tgz` on registry.npmjs.org | `scripts/release-npm.sh` | yes |
| Installers | deb / rpm / AppImage / flatpak / snap / dmg / msix | `./build_all.sh`, `forge.config.js` makers | no |
| Pear OTA | `pear://…` from `package.json#upgrade` | Pear stage/release | no |

The installer and OTA paths are **unchanged and separate**. Nothing in
`scripts/release-npm.sh`, `scripts/npm-pack-check.sh` or
`scripts/npm-smoke-install.sh` reads or writes `forge.config.js`, the makers,
`pear.json`, `flatpak/`, `build/AppxManifest.xml` or `build_all.sh`. Cutting an
npm release does not cut an installer release, and vice versa.

> **2026-09-19 (`D-08`).** There are two channels now, not three: the Pear OTA row is gone. The
> Pear OTA updater was removed from every build, together with `package.json#upgrade` and
> `pear.json`.

There is no CI for this. Publishing is always an explicit, opt-in command run
by a maintainer.

## The three commands

```sh
npm run pack:check                       # lint + test + pack + tarball audit
npm run smoke:install -- <tarball>       # install into a throwaway prefix and boot it
npm run release:npm -- patch             # dry run: plan + BLOCKERS, changes nothing
npm run release:npm -- patch --publish   # the real thing
```

`release:npm` runs the other two for you. Run them individually while you are
still fixing things — they are much faster to iterate on.

## Version policy

`package.json#version` is shared by all three channels, so bumping it for npm
also bumps what the installers and the OTA build report. Keep that in mind:

- **patch** — bug fixes, packaging fixes, doc changes. The normal npm release.
- **minor** — new user-visible features, new CLI subcommands, new flags.
- **major** — breaking changes to the CLI surface, the on-disk data layout, or
  the share-link/protocol wire format.

`package.json#upgrade` (the `pear://…` key) is **not** a version and must not
be touched by an npm release. It identifies the Pear OTA application, not a
release of it. `scripts/release-npm.sh` never writes it; `npm version` never
writes it either. If you change it, you are changing which Pear app OTA users
are following — that is a separate, deliberate act.

> **2026-09-19 (`D-08`).** `package.json#upgrade` no longer exists
> (`test/no-updater.test.js` pins its absence), so the paragraph above has nothing to protect.
> `package.json#version` is shared by the npm and installer channels only.

`npm version` creates both the version-bump commit and the `vX.Y.Z` tag. The
release script deliberately does **not** push. It prints
`git push --follow-tags` and leaves it to you, so a failed publish never leaves
a pushed tag pointing at a version that does not exist on the registry.

## Before you publish

`npm run release:npm -- <target>` (without `--publish`) evaluates every guard
and prints a `BLOCKERS:` section. Fix each one:

| Guard | What it means |
| ----- | ------------- |
| `clean-tree` | `git status --porcelain` must be empty. `npm version` refuses to run on a dirty tree. |
| `branch-confirmed` | You confirmed the branch you are releasing from (or passed `--yes`). |
| `npm-whoami` | You are logged in (`npm login`). |
| `version-available` | The target version is not already on the registry. An `E404` from `npm view zbterm version` just means the package is not published yet — that is fine. |
| `pack-check` | `scripts/npm-pack-check.sh` passed. |
| `smoke-install` | `scripts/npm-smoke-install.sh` passed on the packed tarball. |

Being logged in is **not** the same as having publish rights on the name
`zbterm`. The first successful publish claims it. The scripts never try to
claim, transfer or force a name.

`prepack` (renderer asset vendoring) runs during `npm publish` as well as
during `npm pack`. If it fails during publish, the publish aborts with the git
tag already created. That is precisely why `pack:check` — which exercises the
same `prepack` — always runs first.

## What to verify on each platform

`scripts/npm-smoke-install.sh` is **Unix-only** and only ever covers the
machine it runs on. It cannot substitute for the matrix below. Everything here
is manual.

For each platform, from a machine that has never had ZBTerm installed:

```sh
npm install -g zbterm
zbterm --version
zbterm doctor
zbterm            # a window opens, a terminal session starts
```

| Platform | Extra checks |
| -------- | ------------ |
| Linux x64 | `zbterm install-desktop`, then the launcher entry and a `zbterm://join/…` link both work; `zbterm uninstall-desktop` removes them. Check on both a glibc distro and one where `node-pty` has to compile (python3 + make + g++ present). |
| Linux arm64 | Same, plus: a `bare-sidecar` prebuild for `linux-arm64` exists (`zbterm doctor` reports it). |
| macOS arm64 / x64 | The app is unsigned when installed from npm — Gatekeeper will complain on first launch. Confirm the documented workaround still applies. |
| Windows x64 | `npm install -g zbterm` puts the shim on `PATH`; `zbterm --version` works from `cmd.exe` and PowerShell. The smoke script refuses to run here on purpose (`npm install -g --prefix DIR` installs into `DIR`, not `DIR/bin`), so this one is entirely by hand. |

Also confirm on at least one platform that the app runs with **no repo
checkout present** — that is the whole point of vendoring the renderer assets.

> **2026-09-24 (freenet-backend F9, `D-15`).** `package.json#files` now includes
> `THIRD-PARTY-NOTICES.md` (the Freenet components' licences), so the npm tarball carries it; the
> Freenet backend's dependencies stay `optionalDependencies`, as Pear's are. `pack-check` does not
> require the file; check it is in the tarball when the notices change.

## Generated files

`renderer/logo.svg` and the `build/icon.*` files are generated by `npm run
icons` (which needs the `sharp` devDependency) from `renderer/logo-ascii.js`,
and are **committed to git**. They are regenerated manually, only when the logo
changes, and never as part of packing or publishing — `icons` is deliberately
not a `prepack` step, so a machine without `sharp` can still pack and publish.
`renderer/logo-ascii.js` itself is a hand-edited source file that has to ship
because the startup splash loads it; `scripts/npm-pack-check.sh` only asserts
that it shipped and is not empty.

`renderer/vendor/` is the opposite: gitignored, and regenerated by
`scripts/vendor-assets.js` from `prepack` / `pretest` / `prestart`. It must be
in the tarball; `pack:check` fails if it is not.

## Yanking or deprecating a bad release

Deprecation is the right tool almost always. It leaves existing installs
working and warns everyone else:

```sh
npm deprecate zbterm@1.2.3 "Broken Electron download on Linux; use 1.2.4"
npm deprecate zbterm@"<1.2.4" "Please upgrade to 1.2.4 or later"
```

Un-deprecate by setting an empty message:

```sh
npm deprecate zbterm@1.2.3 ""
```

Unpublishing is the nuclear option and is heavily restricted — npm only allows
it within **72 hours** of publishing, and only if nothing depends on the
version. It breaks anyone who pinned it.

```sh
npm unpublish zbterm@1.2.3      # <72h only; prefer deprecate
```

A published version number can never be reused, even after unpublishing. The
fix for a bad release is always **publish the next patch**, then deprecate the
bad one.

If a bad version was tagged `latest`, move the tag off it as the very first
step, before you even start deprecating:

```sh
npm dist-tag add zbterm@1.2.2 latest
```

Finally, remember that the git tag is local until you push it. If a release
fails after `npm version` but before or during `npm publish`, undo it locally:

```sh
git tag -d v1.2.3
git reset --hard HEAD~1     # only if the bump commit was not pushed
```
