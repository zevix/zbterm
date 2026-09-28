const fs = require('fs')
const path = require('path')

const pkg = require('./package.json')
const appName = pkg.productName ?? pkg.name
const versionedAppName = `${appName}-${pkg.version}`

function getWindowsKitVersion() {
  const programFiles = process.env['PROGRAMFILES(X86)'] || process.env.PROGRAMFILES
  if (!programFiles) return undefined
  const kitsDir = path.join(programFiles, 'Windows Kits')
  try {
    for (const kit of fs.readdirSync(kitsDir).sort().reverse()) {
      const binDir = path.join(kitsDir, kit, 'bin')
      if (!fs.existsSync(binDir)) continue
      const version = fs
        .readdirSync(binDir)
        .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
        .sort()
        .pop()
      if (version) return version
    }
  } catch {
    return undefined
  }
}

// Build variants (backend-abstraction R-8). ZBTERM_BUILD_BACKENDS names the
// share backends a package carries: `pear`, `freenet`, `pear,freenet` (the
// default since freenet-backend F9, D-14) or `none`. An absent backend loses its directory under
// engine/backends/ and its own dependencies; engine/backends/index.js then
// reports it as absent (MODULE_NOT_FOUND). Both are read when a hook runs, not
// when this file loads.
//
// No build carries an OTA updater (D-08), so the Pear backend's own
// dependencies are the swarm and the DHT and it owns no file outside its
// directory.
const BUILD_BACKENDS = {
  pear: { dependencies: ['hyperswarm', 'hyperdht'], files: [] },
  // node-datachannel is the host's WebRTC adapter (electron/rtc-host.js, F4);
  // without it RtcHost.available() is false and the backend says so.
  freenet: {
    dependencies: [
      '@freenetorg/freenet-stdlib',
      'bs58',
      'bare-ws',
      'bare-encoding',
      'node-datachannel'
    ],
    // D-15: the notices cover the Freenet components only (F9).
    files: ['/THIRD-PARTY-NOTICES.md']
  }
}
const DEFAULT_BUILD_BACKENDS = 'pear,freenet'

function buildBackends(env = process.env) {
  const raw = env.ZBTERM_BUILD_BACKENDS
  const text = typeof raw === 'string' && raw.trim() ? raw : DEFAULT_BUILD_BACKENDS
  const ids = text
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  const present = []
  for (const id of ids) {
    if (id === 'none') continue
    if (!Object.prototype.hasOwnProperty.call(BUILD_BACKENDS, id)) {
      const choices = [...Object.keys(BUILD_BACKENDS), 'none'].join(', ')
      throw new Error(`ZBTERM_BUILD_BACKENDS: unknown backend '${id}' (expected ${choices})`)
    }
    if (!present.includes(id)) present.push(id)
  }
  // Registry order, whatever order the variable used.
  const ordered = Object.keys(BUILD_BACKENDS).filter((id) => present.includes(id))
  return {
    present: ordered,
    absent: Object.keys(BUILD_BACKENDS).filter((id) => !ordered.includes(id))
  }
}

// `file` is relative to the app directory and starts with '/'. A function
// here replaces both Forge's default (`/out/`) and @electron/packager's
// DEFAULT_IGNORES (copy-filter.js), which are only added to a list, so both
// are repeated to keep the default package unchanged. `/out` itself is matched
// too: ZBTERM_FORGE_OUT_DIR can move the output elsewhere, and the packager
// then no longer skips the directory on its own.
const PACKAGER_DEFAULT_IGNORES = [
  /^\/out($|\/)/,
  /\/package-lock\.json$/,
  /\/yarn\.lock$/,
  /\/pnpm-lock\.yaml$/,
  /\/\.git($|\/)/,
  /\/node_modules\/\.bin($|\/)/,
  /\.o(bj)?$/,
  /\/node_gyp_bins($|\/)/
]

// Not a packager default: `archive/` holds work that is kept in the repo but is
// not built, tested, linted or packaged (archive/README.md). The Tabby plugin
// there carries its own node_modules.
const ARCHIVE_IGNORE = /^\/archive($|\/)/
// The Rust sources of the Freenet contracts and their cargo/fdev output: the
// app ships only the raw .wasm next to them (scripts/build-contracts.sh, F5),
// and hashes.json - in every variant with `freenet`; without it the whole
// backend directory, .wasm included, is left out (ignoreFile below).
const CONTRACT_SOURCES_IGNORE = /^\/engine\/backends\/freenet\/contracts\/src($|\/)/

function ignoreFile(file, env = process.env) {
  const name = String(file)
  if (PACKAGER_DEFAULT_IGNORES.some((pattern) => pattern.test(name))) return true
  if (ARCHIVE_IGNORE.test(name)) return true
  if (CONTRACT_SOURCES_IGNORE.test(name)) return true
  for (const id of buildBackends(env).absent) {
    const dir = `/engine/backends/${id}`
    if (name === dir || name.startsWith(dir + '/')) return true
    if (BUILD_BACKENDS[id].files.includes(name)) return true
  }
  return false
}

// Forge writes the hook's result over the copied package.json. That does not
// prune anything by itself: @electron/packager decides what to prune while it
// copies, from the package.json of the SOURCE directory (copy-filter.js builds
// its Pruner on `opts.dir`), so pruneDroppedDependencies() below finishes the
// job once the copy is complete.
function applyBuildBackends(packageJson, env = process.env) {
  const { present, absent } = buildBackends(env)
  for (const id of absent) {
    for (const name of BUILD_BACKENDS[id].dependencies) {
      for (const field of ['dependencies', 'optionalDependencies']) {
        if (packageJson[field]) delete packageJson[field][name]
      }
    }
  }
  packageJson.zbtermBackends = present
  return packageJson
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

// Node's lookup, confined to the app: <from>/node_modules/<name>, then each
// parent's, no higher than the app's own node_modules.
function findModule(appDir, fromDir, name) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    if (dir === appDir) return null
    const parent = path.dirname(dir)
    dir = path.basename(parent) === 'node_modules' ? path.dirname(parent) : parent
    if (!dir.startsWith(appDir)) return null
  }
}

// Every module directory reachable from `names` (as seen from `fromDir`)
// through `dependencies` and `optionalDependencies` - what the packager's own
// pruner keeps.
function dependencyClosure(appDir, fromDir, names, seen = new Set()) {
  for (const name of names) {
    const dir = findModule(appDir, fromDir, name)
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    const manifest = readManifest(dir) || {}
    const next = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })
    dependencyClosure(appDir, dir, next, seen)
  }
  return seen
}

// Runs on the packaged copy (packageAfterPrune), whose package.json is already
// the mutated one. Removes each dependency an absent backend dropped, together
// with whatever only it needed; a module another shipped package still needs is
// reachable from the mutated manifest and stays. A variant that dropped nothing
// (the default, `pear,freenet`) is left exactly as the packager made it.
function pruneDroppedDependencies(buildPath, env = process.env) {
  const appDir = path.resolve(buildPath)
  const dropped = buildBackends(env).absent.flatMap((id) => BUILD_BACKENDS[id].dependencies)
  if (dropped.length === 0) return []
  const manifest = readManifest(appDir)
  if (!manifest) return []
  const wanted = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })
  const kept = dependencyClosure(appDir, appDir, wanted)
  const removed = []
  for (const dir of dependencyClosure(appDir, appDir, dropped)) {
    if (kept.has(dir) || !fs.existsSync(dir)) continue
    fs.rmSync(dir, { recursive: true, force: true })
    removed.push(path.relative(appDir, dir))
    // A scope directory (`@scope/`) left empty goes too, so a variant carries
    // no trace of the package (F9: `@freenetorg/`, `@node-datachannel/`).
    const scope = path.dirname(dir)
    if (path.basename(scope).startsWith('@') && fs.readdirSync(scope).length === 0) {
      fs.rmdirSync(scope)
    }
  }
  return removed.sort()
}

// Where `package` and `make` write: Forge's default (`out`) unless
// ZBTERM_FORGE_OUT_DIR names another directory, so a variant can be built
// without touching the packages already in `out/`.
const outDirOverride = process.env.ZBTERM_FORGE_OUT_DIR || ''
const outRoot = path.resolve(__dirname, outDirOverride || 'out')

let packagerConfig = {
  icon: 'build/icon',
  protocols: [{ name: appName, schemes: [pkg.name] }],
  derefSymlinks: true,
  ignore: (file) => ignoreFile(file)
}

if (process.env.MAC_CODESIGN_IDENTITY) {
  packagerConfig = {
    ...packagerConfig,
    osxSign: {
      identity: process.env.MAC_CODESIGN_IDENTITY,
      optionsForFile: () => ({
        entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist')
      })
    },
    osxNotarize: {
      tool: 'notarytool',
      keychainProfile: process.env.KEYCHAIN_PROFILE
    }
  }
}

module.exports = {
  packagerConfig,
  ...(outDirOverride ? { outDir: outRoot } : {}),

  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {}
    },
    {
      name: '@electron-forge/maker-msix',
      platforms: ['win32'],
      config: {
        appManifest: path.join(__dirname, 'build', 'AppxManifest.xml'),
        windowsKitVersion: getWindowsKitVersion(),
        ...(process.env.WINDOWS_SIGN_HOOK
          ? {
              windowsSignOptions: {
                hookModulePath: process.env.WINDOWS_SIGN_HOOK
              }
            }
          : {})
      }
    },
    {
      name: 'pear-electron-forge-maker-appimage',
      platforms: ['linux'],
      config: {
        icons: [
          { file: 'build/icon/icon-16x16.png', size: 16 },
          { file: 'build/icon/icon-32x32.png', size: 32 },
          { file: 'build/icon/icon-64x64.png', size: 64 },
          { file: 'build/icon/icon-128x128.png', size: 128 },
          { file: 'build/icon/icon-256x256.png', size: 256 }
        ]
      }
    },
    {
      name: 'pear-electron-forge-maker-flatpak',
      platforms: ['linux'],
      config: {
        appId: 'net.z33v.zbterm',
        icon: `${packagerConfig.icon}.png`,
        comment:
          'ZBTerm is a secure local terminal recording and sharing app on the Pear/Electron stack.',
        categories: ['Development']
      }
    },
    {
      name: 'pear-electron-forge-maker-snap',
      platforms: ['linux'],
      config: {
        icon: `${packagerConfig.icon}.png`,
        snapcraft: {
          summary: 'Secure local terminal recording and peer-to-peer sharing',
          description:
            'ZBTerm is a secure local terminal recording and sharing app on the Pear/Electron stack.',
          contact: 'zbterm@1zk.net',
          license: 'Apache-2.0',
          issues: 'https://github.com/zevix/zbterm/issues',
          website: 'https://github.com/zevix/zbterm',
          app: {
            extensions: ['gnome'],
            plugs: [
              'desktop',
              'desktop-legacy',
              'home',
              'x11',
              'wayland',
              'audio-playback',
              'audio-record',
              'camera',
              'opengl',
              'network',
              'network-bind',
              'browser-support',
              'network-status'
            ],
            environment: {
              TMPDIR: '$XDG_RUNTIME_DIR'
            }
          },
          part: {
            'stage-packages': ['libatomic1']
          }
        }
      }
    }
  ],

  hooks: {
    readPackageJson: async (forgeConfig, packageJson) => {
      return applyBuildBackends(packageJson)
    },
    // Synchronous on purpose; Forge awaits whatever a hook returns.
    packageAfterPrune: (forgeConfig, buildPath) => {
      pruneDroppedDependencies(buildPath)
    },
    preMake: async () => {
      fs.rmSync(path.join(outRoot, 'make'), { recursive: true, force: true })

      const manifest = path.join(__dirname, 'build', 'AppxManifest.xml')
      const msixVersion = pkg.version.replace(/^(\d+\.\d+\.\d+)$/, '$1.0')
      const xml = fs.readFileSync(manifest, 'utf-8')
      fs.writeFileSync(manifest, xml.replace(/Version="[^"]*"/, `Version="${msixVersion}"`))
    },
    postMake: async (forgeConfig, results) => {
      for (const result of results) {
        if (result.platform !== 'win32') continue
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.msix')) continue
          const standardDir = path.join(outRoot, `${appName}-win32-${result.arch}`)
          fs.mkdirSync(standardDir, { recursive: true })
          const dest = path.join(standardDir, `${versionedAppName}.msix`)
          fs.renameSync(artifact, dest)
          fs.mkdirSync(path.dirname(artifact), { recursive: true })
          fs.copyFileSync(dest, artifact)
          result.artifacts[result.artifacts.indexOf(artifact)] = dest
        }
      }
    }
  },

  plugins: [
    {
      name: 'electron-forge-plugin-universal-prebuilds',
      config: {}
    },
    {
      name: 'electron-forge-plugin-prune-prebuilds',
      config: {}
    }
  ]
}
