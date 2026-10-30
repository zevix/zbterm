#!/usr/bin/env node
// Builds and packages the Rust `zxterm-core` sidecar from the `zxterm/` git
// submodule. The published zbterm carries it as one npm package per
// platform, `@zbterm/zxterm-core-<platform>-<arch>`, each an optional
// dependency with `os`/`cpu` set, so npm installs only the matching one.
// electron/zxterm-core-host.js finds it there, or staged in this tree.
//
//   node scripts/sidecar.js build [<rust-triple>]
//       cargo-builds the sidecar (for this machine by default) and stages it.
//   node scripts/sidecar.js stage <platform>-<arch> <binary>
//       stages an already built binary as its npm package under
//       npm/zxterm-core-<platform>-<arch>/.
//   node scripts/sidecar.js inject [<platform>-<arch>...]
//       writes the platform packages (all targets by default) into
//       package.json#optionalDependencies, pinned to this version. Only
//       publish.yml runs it, on the copy it publishes: the committed
//       manifest never lists them.
'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const host = require('../electron/zxterm-core-host')

const ROOT = path.join(__dirname, '..')
const ZXTERM = path.join(ROOT, 'zxterm')

// Every target zbterm ships. Windows is not one yet: the sidecar's
// named-pipe listener and SSH-agent client are Unix-only.
const TARGETS = [
  { triple: 'x86_64-unknown-linux-gnu', platform: 'linux', arch: 'x64' },
  { triple: 'aarch64-unknown-linux-gnu', platform: 'linux', arch: 'arm64' },
  { triple: 'x86_64-apple-darwin', platform: 'darwin', arch: 'x64' },
  { triple: 'aarch64-apple-darwin', platform: 'darwin', arch: 'arm64' }
]

function rootManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
}

function findTarget(predicate, what) {
  const target = TARGETS.find(predicate)
  if (!target) throw new Error(`unsupported target: ${what}`)
  return target
}

function hostTriple() {
  return execFileSync('rustc', ['-vV'], { cwd: ZXTERM, encoding: 'utf8' }).match(/^host: (.+)$/m)[1]
}

function manifestFor(target, version) {
  const root = rootManifest()
  const manifest = {
    name: host.packageName(target.platform, target.arch),
    version,
    description: `The zxterm-core sidecar binary of zbterm for ${target.platform}-${target.arch}.`,
    license: 'MIT',
    repository: root.repository,
    os: [target.platform],
    cpu: [target.arch],
    files: [host.executableName(target.platform), 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
    publishConfig: { access: 'public' }
  }
  if (target.platform === 'linux') manifest.libc = ['glibc']
  return manifest
}

function stage(target, binary) {
  if (!fs.existsSync(path.join(ZXTERM, 'Cargo.toml'))) {
    throw new Error('the zxterm submodule is missing: git submodule update --init')
  }
  const dir = host.stagedDir(target.platform, target.arch)
  const exe = host.executableName(target.platform)
  fs.mkdirSync(dir, { recursive: true })
  const manifest = manifestFor(target, rootManifest().version)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  // The binary's own licence and the notices for what it statically links.
  for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    fs.copyFileSync(path.join(ZXTERM, file), path.join(dir, file))
  }
  // Copied next to the destination and renamed over it, so a running
  // sidecar never makes the copy fail with "Text file busy".
  const dest = path.join(dir, exe)
  fs.copyFileSync(binary, dest + '.tmp')
  fs.chmodSync(dest + '.tmp', 0o755)
  fs.renameSync(dest + '.tmp', dest)
  return dest
}

function build(triple = hostTriple()) {
  const target = findTarget((t) => t.triple === triple, triple)
  const args = ['build', '--release', '--locked', '-p', 'zxterm-core']
  if (triple !== hostTriple()) args.push('--target', triple)
  execFileSync('cargo', args, { cwd: ZXTERM, stdio: 'inherit' })
  const out = args.includes('--target')
    ? path.join(ZXTERM, 'target', triple, 'release')
    : path.join(ZXTERM, 'target', 'release')
  return stage(target, path.join(out, host.executableName(target.platform)))
}

function inject(dirs) {
  const manifest = rootManifest()
  const deps = { ...manifest.optionalDependencies }
  const targets =
    dirs && dirs.length
      ? dirs.map((dir) => findTarget((t) => `${t.platform}-${t.arch}` === dir, dir))
      : TARGETS
  for (const target of targets) {
    deps[host.packageName(target.platform, target.arch)] = manifest.version
  }
  manifest.optionalDependencies = deps
  fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  return deps
}

function main(argv) {
  const [command, ...args] = argv
  if (command === 'build') {
    console.log(build(args[0]))
  } else if (command === 'stage' && args.length === 2) {
    const target = findTarget((t) => `${t.platform}-${t.arch}` === args[0], args[0])
    console.log(stage(target, path.resolve(args[1])))
  } else if (command === 'inject') {
    console.log(JSON.stringify(inject(args), null, 2))
  } else {
    console.error(
      'usage: node scripts/sidecar.js build [<rust-triple>]\n' +
        '       node scripts/sidecar.js stage <platform>-<arch> <binary>\n' +
        '       node scripts/sidecar.js inject [<platform>-<arch>...]'
    )
    process.exit(1)
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error('sidecar: ' + err.message)
    process.exit(1)
  }
}

module.exports = { TARGETS, manifestFor, stage, build, inject }
