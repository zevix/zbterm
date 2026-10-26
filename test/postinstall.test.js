const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')

const postinstall = require('../bin/lib/postinstall')

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function prebuild(root, pkg, target, file = 'addon.node') {
  const dir = path.join(root, pkg, 'prebuilds', target)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), 'x')
  return dir
}

const exists = (p) => fs.existsSync(p)

test('postinstall: prune keeps this platform and universal, drops the rest', async (t) => {
  const root = tmpdir(t, 'zbterm-prune-')

  const keep = prebuild(root, 'sodium-native', 'linux-x64')
  const universal = prebuild(root, 'sodium-native', 'darwin-universal')
  const drop = [
    prebuild(root, 'sodium-native', 'darwin-arm64'),
    prebuild(root, 'sodium-native', 'win32-x64'),
    prebuild(root, 'sodium-native', 'android-arm'),
    prebuild(root, 'sodium-native', 'linux-arm64')
  ]

  const stats = postinstall.prunePrebuilds(root, postinstall.keeps('linux-x64'), { removed: 0 })

  t.is(stats.removed, 4)
  t.ok(exists(keep), 'linux-x64 survives')
  t.ok(exists(universal), 'darwin-universal survives')
  for (const dir of drop) t.absent(exists(dir), path.basename(dir) + ' removed')
})

test('postinstall: prune reaches nested node_modules', async (t) => {
  const root = tmpdir(t, 'zbterm-prune-nested-')

  const shallow = prebuild(root, 'rocksdb-native', 'win32-x64')
  const deep = prebuild(path.join(root, 'corestore', 'node_modules'), 'udx-native', 'win32-x64')
  const deepKeep = prebuild(path.join(root, 'corestore', 'node_modules'), 'udx-native', 'linux-x64')

  postinstall.prunePrebuilds(root, postinstall.keeps('linux-x64'), { removed: 0 })

  t.absent(exists(shallow))
  t.absent(exists(deep), 'a prebuild two levels down is pruned too')
  t.ok(exists(deepKeep))
})

test('postinstall: prune never touches loose files or non-prebuilds dirs', async (t) => {
  const root = tmpdir(t, 'zbterm-prune-safe-')

  // A file sitting directly under prebuilds/ is not a platform directory, so
  // it is left alone rather than guessed at.
  fs.mkdirSync(path.join(root, 'weird', 'prebuilds'), { recursive: true })
  const loose = path.join(root, 'weird', 'prebuilds', 'index.json')
  fs.writeFileSync(loose, '{}')

  // "build" is not "prebuilds"; a platform-shaped name under it means nothing.
  fs.mkdirSync(path.join(root, 'other', 'build', 'darwin-arm64'), { recursive: true })
  const build = path.join(root, 'other', 'build', 'darwin-arm64')

  const stats = postinstall.prunePrebuilds(root, postinstall.keeps('linux-x64'), { removed: 0 })

  t.is(stats.removed, 0)
  t.ok(exists(loose), 'a loose file under prebuilds/ is untouched')
  t.ok(exists(build), 'a platform-named dir outside prebuilds/ is untouched')
})

test('postinstall: prune is a no-op on a repo checkout, active under node_modules', async (t) => {
  const root = tmpdir(t, 'zbterm-installroot-')

  const checkout = path.join(root, 'src', 'zbterm')
  fs.mkdirSync(checkout, { recursive: true })
  t.is(postinstall.installRoot(checkout), null, 'a checkout is never pruned')

  const installed = path.join(root, 'lib', 'node_modules', 'zbterm')
  fs.mkdirSync(installed, { recursive: true })
  t.is(postinstall.installRoot(installed), path.join(root, 'lib', 'node_modules'))

  const scoped = path.join(root, 'lib', 'node_modules', '@scope', 'zbterm')
  fs.mkdirSync(scoped, { recursive: true })
  t.is(postinstall.installRoot(scoped), path.join(root, 'lib', 'node_modules'))
})

test('postinstall: the real repo checkout is not an install root', async (t) => {
  // Guards the hazard directly: pruning a checkout would strip the prebuilds
  // `electron-forge make` needs for every platform but this one.
  t.is(postinstall.installRoot(), null)
})

test('postinstall: target agrees with electron/install.js', async (t) => {
  // electron/install.js honours npm_config_platform/npm_config_arch. If the
  // prune disagreed, it would keep prebuilds for one target while Electron
  // downloaded the runtime for another.
  t.is(postinstall.target({ env: {}, platform: 'linux', arch: 'x64' }), 'linux-x64')
  t.is(
    postinstall.target({ env: { npm_config_arch: 'arm64' }, platform: 'linux', arch: 'x64' }),
    'linux-arm64'
  )
  t.is(
    postinstall.target({
      env: { npm_config_platform: 'win32', npm_config_arch: 'arm64' },
      platform: 'linux',
      arch: 'x64'
    }),
    'win32-arm64'
  )
  t.is(postinstall.target({ env: {}, platform: 'darwin', arch: 'arm64' }), 'darwin-arm64')
})

test('postinstall: every supported target keeps exactly its own prebuilds', async (t) => {
  const TARGETS = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64'
  ]
  const ALL = [...TARGETS, 'android-arm', 'android-x64', 'ios-arm64', 'linux-armv7l']

  for (const wanted of TARGETS) {
    const root = tmpdir(t, 'zbterm-matrix-')
    for (const target of ALL) prebuild(root, 'sodium-native', target)

    postinstall.prunePrebuilds(root, postinstall.keeps(wanted), { removed: 0 })

    const left = fs.readdirSync(path.join(root, 'sodium-native', 'prebuilds')).sort()
    t.alike(left, [wanted], wanted + ' keeps only itself')
  }
})
