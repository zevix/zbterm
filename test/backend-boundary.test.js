const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { EventEmitter } = require('events')
const test = require('brittle')

const { walk, specifiers } = require('./helpers/source-scan')

// Network sharing is a removable part of the core (backend-abstraction R-10):
// a build can carry the Pear backend, the Freenet one, both or neither. That
// only holds while each backend's dependencies are required from inside its
// own directory and nothing but the registry reaches into one. This test is
// the enforcement. `protomux` stays installed in every build (hypercore
// depends on it); the rule is about `require` sites, not presence.
const ROOT = path.join(__dirname, '..')
const ENGINE = path.join(ROOT, 'engine')
const BACKENDS = path.join(ENGINE, 'backends')
const REGISTRY = path.join(BACKENDS, 'index.js')
// Host and core code that ships. The OTA updater (workers/main.js) is gone
// from every build (D-08), so rules 1 and 2 are about engine/ and rule 3
// covers both.
const SHIPPED_DIRS = ['engine', 'electron']

const PEAR_ONLY = ['hyperswarm', 'hyperdht', 'protomux']
// What the removed OTA updater required (D-08). No shipped file may require
// any of it again; `hyperswarm` remains, for sharing, under the Pear backend.
const UPDATER_STACK = ['pear-runtime', 'pear-link', 'corestore']
// Shipped code outside engine/ and electron/ that a require could hide in.
const SHIPPED_EXTRA = ['renderer', 'bin', 'scripts']
const SHIPPED_EXTRA_FILES = ['forge.config.js']
const REMOVED_UPDATER_FILES = ['workers/main.js', 'electron/updater-available.js', 'pear.json']
// The Freenet backend's WebRTC half runs in the host (D-06, D-09), so
// node-datachannel has one named owner outside the backend directory (F4).
const RTC_HOST = path.join(ROOT, 'electron', 'rtc-host.js')
const FREENET_ONLY = [
  '@freenetorg/freenet-stdlib',
  'bs58',
  'bare-ws',
  'bare-encoding',
  'ws',
  'node-datachannel',
  '@roamhq/wrtc',
  'wrtc',
  'werift'
]

// 'hyperdht/testnet' belongs to 'hyperdht'; '@scope/name/sub' to '@scope/name'.
function packageOf(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function under(dir, file) {
  const rel = path.relative(dir, file)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function requireSites(files, packages) {
  const sites = []
  for (const file of files) {
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) continue
      if (packages.includes(packageOf(spec))) sites.push({ file, spec })
    }
  }
  return sites
}

test('hyperswarm, hyperdht and protomux are required only under engine/backends/pear/', (t) => {
  const files = walk(ENGINE)
  t.ok(files.length > 10, `scanned ${files.length} engine files`)
  const sites = requireSites(files, PEAR_ONLY)
  t.ok(sites.length >= 3, `found ${sites.length} require sites of the Pear set`)
  const outside = sites
    .filter((site) => !under(path.join(BACKENDS, 'pear'), site.file))
    .map((site) => `${path.relative(ROOT, site.file)}: requires '${site.spec}'`)
  t.alike(outside, [], 'no engine file outside the Pear backend requires the Pear set')
})

test('pear-runtime, pear-link and corestore are required by no shipped file, and hyperswarm only under engine/backends/pear/', (t) => {
  const files = [
    ...[...SHIPPED_DIRS, ...SHIPPED_EXTRA].flatMap((dir) => walk(path.join(ROOT, dir))),
    ...SHIPPED_EXTRA_FILES.map((file) => path.join(ROOT, file))
  ]
  t.ok(files.length > 30, `scanned ${files.length} shipped files`)
  t.alike(
    requireSites(files, UPDATER_STACK).map(
      (site) => `${path.relative(ROOT, site.file)}: requires '${site.spec}'`
    ),
    [],
    'no shipped file requires pear-runtime, pear-link or corestore'
  )

  const swarmSites = requireSites(files, ['hyperswarm'])
  t.ok(swarmSites.length >= 1, `found ${swarmSites.length} require sites of hyperswarm`)
  t.alike(
    swarmSites
      .filter((site) => !under(path.join(BACKENDS, 'pear'), site.file))
      .map((site) => `${path.relative(ROOT, site.file)}: requires '${site.spec}'`),
    [],
    'hyperswarm is required only under engine/backends/pear/'
  )

  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8')
  t.absent(/pear-runtime['"]\s*\)/.test(main), 'electron/main.js names pear-runtime in no require')
  t.alike(
    requireSites(
      [path.join(ENGINE, 'client.js'), path.join(ENGINE, 'spawn-worker.js')],
      [...UPDATER_STACK, 'hyperswarm', 'bare-sidecar']
    ).map((site) => `${path.relative(ROOT, site.file)}: ${site.spec}`),
    ['engine/spawn-worker.js: bare-sidecar'],
    'the engine client spawns through the helper, and the helper through bare-sidecar'
  )
})

test('workers/main.js, electron/updater-available.js and pear.json do not exist', (t) => {
  for (const file of REMOVED_UPDATER_FILES) {
    t.absent(fs.existsSync(path.join(ROOT, file)), `${file} is gone`)
  }
  t.absent(fs.existsSync(path.join(ROOT, 'workers')), 'and so is workers/')
})

test('the Freenet SDK, ws and WebRTC libraries are required only under engine/backends/freenet/', (t) => {
  const inside = requireSites(walk(path.join(BACKENDS, 'freenet')), FREENET_ONLY)
  t.ok(
    ['@freenetorg/freenet-stdlib', 'bare-ws'].every((name) =>
      inside.some((site) => packageOf(site.spec) === name)
    ),
    'the Freenet backend does require the SDK and bare-ws'
  )
  const outside = requireSites(walk(ENGINE), FREENET_ONLY)
    .filter((site) => !under(path.join(BACKENDS, 'freenet'), site.file))
    .map((site) => `${path.relative(ROOT, site.file)}: requires '${site.spec}'`)
  t.alike(outside, [], 'no engine file outside the Freenet backend requires the Freenet set')
})

// F4 amended the rule above for one package: node-datachannel may also be
// required by electron/rtc-host.js, the host's WebRTC adapter, and by no other
// shipped file. Every other package of the Freenet set keeps the rule above.
test('node-datachannel is required only under engine/backends/freenet/ or by electron/rtc-host.js', (t) => {
  const files = [
    ...[...SHIPPED_DIRS, ...SHIPPED_EXTRA].flatMap((dir) => walk(path.join(ROOT, dir))),
    ...SHIPPED_EXTRA_FILES.map((file) => path.join(ROOT, file))
  ]
  const sites = requireSites(files, ['node-datachannel'])
  t.ok(
    sites.some((site) => site.file === RTC_HOST),
    'electron/rtc-host.js requires node-datachannel'
  )
  t.alike(
    sites
      .filter((site) => site.file !== RTC_HOST && !under(path.join(BACKENDS, 'freenet'), site.file))
      .map((site) => `${path.relative(ROOT, site.file)}: requires '${site.spec}'`),
    [],
    'no other shipped file requires it'
  )
})

test('only engine/backends/index.js reaches into a backend directory from outside it', (t) => {
  const files = SHIPPED_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))
  const violations = []
  let registryReaches = 0
  for (const file of files) {
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue
      const target = path.resolve(path.dirname(file), spec)
      if (!under(BACKENDS, target)) continue
      // A backend directory is the first path segment below engine/backends/
      // that is not one of its own files (index.js, types.js, loopback.js).
      // The target may be absent from this build, so it is judged by name.
      const segment = path.relative(BACKENDS, target).split(path.sep)[0]
      const isFile = /\.js$/.test(segment) || fs.existsSync(path.join(BACKENDS, `${segment}.js`))
      if (isFile) continue
      const backendDir = path.join(BACKENDS, segment)
      if (file === REGISTRY) {
        registryReaches++
        continue
      }
      if (under(backendDir, file)) continue
      violations.push(`${path.relative(ROOT, file)}: requires '${spec}'`)
    }
  }
  t.ok(registryReaches >= 2, `the registry names ${registryReaches} backend directories`)
  t.alike(violations, [], 'nothing but the registry requires a file inside a backend directory')
})

test('the registry names every backend with a literal specifier', (t) => {
  const found = specifiers(fs.readFileSync(REGISTRY, 'utf8'))
  t.ok(found.includes('./pear'), "require('./pear') is literal")
  t.ok(found.includes('./freenet'), "require('./freenet') is literal")
})

test('with the Pear set unresolvable, SessionEngine boots and share.backends offers nothing usable', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-backend-boundary-'))
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  // Fail resolution exactly as a build without the Pear backend would: the
  // packages are gone, and so is engine/backends/pear/.
  // `pear-runtime` and `corestore` are in no build at all (D-08).
  const BLOCKED = ['hyperswarm', 'hyperdht', 'pear-runtime', 'corestore', './pear']
  const blockedRequests = []
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, ...rest) {
    if (BLOCKED.includes(request) || BLOCKED.includes(packageOf(request))) {
      blockedRequests.push(request)
      const err = new Error(`Cannot find module '${request}'`)
      err.code = 'MODULE_NOT_FOUND'
      throw err
    }
    return original.call(this, request, ...rest)
  }
  // Load the core afresh, so its own top-level requires run under the stub
  // too - then put the module cache back, because every test file shares it.
  // (It is also what makes the stub bite: Node resolves './pear' from a
  // per-directory cache, without _resolveFilename, while the module it found
  // earlier is still cached.)
  const saved = new Map()
  for (const key of Object.keys(require.cache)) {
    if (under(ENGINE, key)) {
      saved.set(key, require.cache[key])
      delete require.cache[key]
    }
  }
  t.teardown(() => {
    Module._resolveFilename = original
    for (const key of Object.keys(require.cache)) if (under(ENGINE, key)) delete require.cache[key]
    for (const [key, mod] of saved) require.cache[key] = mod
  })

  const SessionEngine = require('../engine')
  const engine = new SessionEngine({ userData: dir, ptyHost: new EventEmitter() })
  t.teardown(() => engine.close())
  await engine.ready()
  t.pass('the core loads and boots without the Pear set')

  const info = await engine.invoke('share.backends')
  // B8: the Freenet stub is carried by every tree, so it is still listed -
  // as broken (F3: `not yet wired` until F9; F4: a core with no rtcHost hears
  // `host has no WebRTC adapter` first). Nothing usable is, and Pear is not
  // listed at all.
  t.alike(
    info.backends.map((entry) => [entry.id, entry.state, entry.detail]),
    [['freenet', 'broken', 'host has no WebRTC adapter']],
    'share.backends lists no Pear backend and nothing usable'
  )
  t.is(info.default, null, 'there is no default backend')
  t.is(info.active, null, 'and none is active')
  t.ok(blockedRequests.includes('./pear'), 'the registry did try to load the Pear backend')

  const err = await engine.invoke('share.createLink', { sessionId: 'nope' }).then(
    () => null,
    (e) => e
  )
  t.is(err && err.code, 'E_BACKEND_UNSUPPORTED', 'sharing is refused, by code')
  const diag = await engine.invoke('share.diagnostics')
  t.is(diag.backend, null, 'diagnostics work with no backend')
  t.is(engine.share.backend, null, 'and the share manager holds none')

  // U-5: the host half of the core loads and spawns a real sidecar without
  // `pear-runtime` - engine/spawn-worker.js goes to bare-sidecar directly.
  const { EngineClient } = require('../engine/client')
  const clientDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-backend-boundary-'))
  t.teardown(() => fs.promises.rm(clientDir, { recursive: true, force: true }))
  class QuietClient extends EngineClient {
    _attachWorkerOutput(worker) {
      worker.stdout?.on('data', () => {})
      worker.stderr?.on('data', (chunk) => process.stderr.write(chunk))
    }
  }
  const ptyHost = new EventEmitter()
  ptyHost.sessions = new Map()
  const client = new QuietClient({ userData: clientDir, backend: 'none', ptyHost })
  t.teardown(() => client.close())
  await client.ready()
  t.ok(client.pid, `the engine client spawned a worker (pid ${client.pid})`)
  const viaClient = await client.invoke('share.backends')
  t.alike(viaClient.backends, [], 'limited to none, the worker offers no backend')
  t.absent(
    blockedRequests.some((request) => ['pear-runtime', 'corestore'].includes(packageOf(request))),
    'and nothing on the host side asked for pear-runtime or corestore'
  )
})
