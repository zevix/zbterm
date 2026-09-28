// Build variants (backend-abstraction R-8): ZBTERM_BUILD_BACKENDS decides
// which share backends a package carries. forge.config.js reads the variable
// when a hook runs, so each case sets it, calls the hook and restores it.
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')

const forgeConfig = require('../forge.config.js')
const rootPkg = require('../package.json')
const corePkg = require('../engine/package.json')

const { ignore } = forgeConfig.packagerConfig
const { readPackageJson, packageAfterPrune } = forgeConfig.hooks

function withVariant(t, value) {
  const before = process.env.ZBTERM_BUILD_BACKENDS
  if (value === undefined) delete process.env.ZBTERM_BUILD_BACKENDS
  else process.env.ZBTERM_BUILD_BACKENDS = value
  t.teardown(() => {
    if (before === undefined) delete process.env.ZBTERM_BUILD_BACKENDS
    else process.env.ZBTERM_BUILD_BACKENDS = before
  })
}

function freshPackageJson() {
  return JSON.parse(JSON.stringify(rootPkg))
}

function mutate(t, value) {
  withVariant(t, value)
  return readPackageJson({}, freshPackageJson())
}

test('backend-only dependencies are optional, and still installed by default', (t) => {
  for (const pkg of [rootPkg, corePkg]) {
    for (const name of ['hyperswarm', 'hyperdht']) {
      t.ok(pkg.optionalDependencies && pkg.optionalDependencies[name], `${pkg.name}: ${name}`)
      t.absent(pkg.dependencies[name], `${pkg.name}: ${name} is not a hard dependency`)
    }
  }
  // D-08: the removed updater's modules are a dependency of neither manifest.
  // The manifests are read, not resolution: the working tree's node_modules
  // may still hold them (A-6).
  for (const name of ['pear-runtime', 'pear-link', 'corestore']) {
    for (const pkg of [rootPkg, corePkg]) {
      for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
        t.absent(pkg[field] && pkg[field][name], `${pkg.name}: no ${name} in ${field}`)
      }
    }
  }
  t.ok(corePkg.files.includes('backends/'), 'the core publishes backends/')
  for (const name of ['hyperswarm', 'hyperdht', 'bare-sidecar']) {
    t.ok(require.resolve(name, { paths: [path.join(__dirname, '..')] }), `${name} resolves`)
  }
})

// The Freenet backend's own dependencies (forge.config.js BUILD_BACKENDS):
// the SDK and what it needs under Bare, and the host's WebRTC adapter.
const FREENET_DEPENDENCIES = [
  '@freenetorg/freenet-stdlib',
  'bs58',
  'bare-ws',
  'bare-encoding',
  'node-datachannel'
]

// Inverted in freenet-backend F9 (D-14): the default was `pear`, with the
// Freenet backend left out.
test('default variant is pear,freenet: both backends and their dependencies stay (D-14)', async (t) => {
  const pkg = await mutate(t, undefined)
  t.alike(pkg.zbtermBackends, ['pear', 'freenet'])
  t.ok(pkg.optionalDependencies.hyperswarm)
  t.ok(pkg.optionalDependencies.hyperdht)
  for (const name of FREENET_DEPENDENCIES) {
    t.ok(pkg.optionalDependencies[name], `the default keeps ${name}`)
  }
  t.absent(pkg.optionalDependencies['pear-runtime'], 'no build has the updater (D-08)')
  t.absent(pkg.optionalDependencies.corestore)
  t.absent(pkg.upgrade, 'nor an OTA upgrade key')
  t.absent(ignore('/engine/backends/pear'))
  t.absent(ignore('/engine/backends/pear/index.js'))
  t.absent(ignore('/engine/backends/freenet'))
  t.absent(ignore('/engine/backends/freenet/index.js'))
  t.absent(ignore('/THIRD-PARTY-NOTICES.md'), 'the third-party notices ship (D-15)')
  t.absent(ignore('/engine/backends/index.js'), 'the registry always ships')
  t.absent(ignore('/engine/backends/types.js'))
  t.absent(ignore('/engine/backends/loopback.js'))
})

test('none drops every backend directory and the pear dependencies', async (t) => {
  const pkg = await mutate(t, 'none')
  t.alike(pkg.zbtermBackends, [])
  for (const field of ['dependencies', 'optionalDependencies']) {
    t.absent(pkg[field] && pkg[field].hyperswarm, `${field}.hyperswarm`)
    t.absent(pkg[field] && pkg[field].hyperdht, `${field}.hyperdht`)
  }
  t.ok(pkg.dependencies.hypercore, 'local storage stays (D-02)')
  // D-08: no build has the updater, with or without Pear.
  for (const field of ['dependencies', 'optionalDependencies']) {
    t.absent(pkg[field] && pkg[field]['pear-runtime'], `${field}.pear-runtime`)
    t.absent(pkg[field] && pkg[field].corestore, `${field}.corestore`)
  }
  t.ok(pkg.dependencies['bare-sidecar'], 'the engine worker is still spawned (U-2)')
  t.ok(ignore('/engine/backends/pear/connection.js'))
  t.ok(ignore('/engine/backends/freenet/index.js'))
  t.absent(ignore('/engine/backends/index.js'))
  t.absent(ignore('/engine/share-manager.js'))
})

test('freenet and pear,freenet variants', async (t) => {
  const freenet = await mutate(t, 'freenet')
  t.alike(freenet.zbtermBackends, ['freenet'])
  t.absent(freenet.optionalDependencies.hyperswarm)
  t.absent(freenet.optionalDependencies.hyperdht)
  t.absent(freenet.optionalDependencies['pear-runtime'], 'no updater in any build (D-08)')
  t.absent(freenet.optionalDependencies.corestore)
  t.ok(ignore('/engine/backends/pear/index.js'))
  t.absent(ignore('/engine/backends/freenet/index.js'))

  const both = await mutate(t, ' Freenet , pear ')
  t.alike(both.zbtermBackends, ['pear', 'freenet'], 'registry order, trimmed, case-folded')
  t.ok(both.optionalDependencies.hyperswarm)
  t.ok(both.optionalDependencies.hyperdht)
  t.absent(both.optionalDependencies['pear-runtime'], 'no updater in any build (D-08)')
  t.absent(ignore('/engine/backends/pear/index.js'))
  t.absent(ignore('/engine/backends/freenet/index.js'))
})

test('pear and none drop the Freenet backend and every one of its dependencies', async (t) => {
  for (const variant of ['pear', 'none']) {
    const pkg = await mutate(t, variant)
    for (const name of FREENET_DEPENDENCIES) {
      for (const field of ['dependencies', 'optionalDependencies']) {
        t.absent(pkg[field] && pkg[field][name], `${variant}: no ${name} in ${field}`)
      }
    }
    t.ok(
      ignore('/engine/backends/freenet/index.js'),
      `${variant}: the backend directory is left out`
    )
  }
  t.ok(ignore('/THIRD-PARTY-NOTICES.md'), 'and the notices, which cover only Freenet (D-15)')
  t.ok(rootPkg.files.includes('THIRD-PARTY-NOTICES.md'), 'the npm package carries the notices')
})

test('the contract .wasm and hashes.json ship with freenet and not without (F9)', (t) => {
  withVariant(t, undefined)
  const dir = '/engine/backends/freenet/contracts'
  const shipped = ['signalling-v1.wasm', 'pointer-v1.wasm', 'hashes.json']
  for (const name of shipped) {
    t.ok(fs.existsSync(path.join(__dirname, '..', dir, name)), `${name} is in the tree`)
  }
  for (const variant of ['', 'freenet', 'pear,freenet', 'pear', 'none']) {
    if (variant) process.env.ZBTERM_BUILD_BACKENDS = variant
    else delete process.env.ZBTERM_BUILD_BACKENDS
    const label = variant || 'default'
    const carried = variant === '' || variant.includes('freenet')
    for (const name of shipped) {
      t.is(
        ignore(`${dir}/${name}`),
        !carried,
        `${label}: ${name} ${carried ? 'ships' : 'is left out'}`
      )
    }
  }
  delete process.env.ZBTERM_BUILD_BACKENDS
})

test('the hook is idempotent (Forge runs it on the source and on the copy)', async (t) => {
  withVariant(t, 'none')
  const once = await readPackageJson({}, freshPackageJson())
  const twice = await readPackageJson({}, JSON.parse(JSON.stringify(once)))
  t.alike(twice, once)
})

test('an unknown variant fails the build instead of shipping something else', async (t) => {
  withVariant(t, 'pear,carrier-pigeon')
  await t.exception(() => readPackageJson({}, freshPackageJson()), /carrier-pigeon/)
  t.exception(() => ignore('/engine/backends/pear/index.js'), /carrier-pigeon/)
})

test('the ignore function keeps the defaults a function would otherwise replace', (t) => {
  withVariant(t, undefined)
  t.ok(ignore('/out/ZBTerm-linux-x64/resources/app/package.json'), 'Forge default: /out/')
  t.ok(ignore('/out'), 'and the directory itself, when the output goes elsewhere')
  t.ok(ignore('/.git/HEAD'))
  t.ok(ignore('/package-lock.json'))
  t.ok(ignore('/node_modules/.bin/electron-forge'))
  t.ok(ignore('/node_modules/sodium-native/build/Release/obj.target/x.o'))
  t.absent(ignore('/outside/file.js'), '/out is matched as a directory, not as a prefix')
  t.absent(ignore('/electron/main.js'))
  t.absent(ignore('/node_modules/hyperswarm/index.js'), 'dependencies are pruned, not ignored')
})

test('/archive is never packaged, whatever the variant (V-5)', (t) => {
  // One teardown restores the variable; the loop then sets it directly, so
  // stacked teardowns cannot restore an intermediate value.
  withVariant(t, undefined)
  for (const variant of ['', 'pear', 'freenet', 'pear,freenet', 'none']) {
    if (variant) process.env.ZBTERM_BUILD_BACKENDS = variant
    const label = variant || 'default'
    t.ok(ignore('/archive/tabby-plugin/package.json'), `${label}: the archived plugin`)
    t.ok(ignore('/archive'), `${label}: the directory itself`)
  }
  delete process.env.ZBTERM_BUILD_BACKENDS
  t.absent(ignore('/archives/file.js'), '/archive is matched as a directory, not as a prefix')
  t.absent(ignore('/docs/archive/file.md'), 'and only at the app root')
})

test('the Freenet contract sources are never packaged, the .wasm is (F5)', (t) => {
  withVariant(t, 'freenet')
  const dir = '/engine/backends/freenet/contracts'
  t.ok(ignore(`${dir}/src`), 'the source directory')
  t.ok(ignore(`${dir}/src/signalling/src/lib.rs`), 'a crate source')
  t.ok(ignore(`${dir}/src/pointer/target/wasm32-unknown-unknown/release/x.wasm`), 'cargo output')
  t.absent(ignore(`${dir}/signalling-v1.wasm`), 'the shipped signalling contract')
  t.absent(ignore(`${dir}/pointer-v1.wasm`), 'the shipped pointer contract')
  t.absent(ignore(`${dir}/hashes.json`), 'and their hashes')
  t.absent(ignore('/engine/backends/freenet/contracts.js'), 'and their loader')
})

test('the hook no longer reads UPGRADE_KEY or validates an upgrade link (D-08)', async (t) => {
  withVariant(t, undefined)
  const before = process.env.UPGRADE_KEY
  process.env.UPGRADE_KEY = 'not-a-pear-link'
  t.teardown(() => {
    if (before === undefined) delete process.env.UPGRADE_KEY
    else process.env.UPGRADE_KEY = before
  })
  const pkg = await readPackageJson({}, freshPackageJson())
  t.absent(pkg.upgrade, 'UPGRADE_KEY is not written into the package')
  const kept = await readPackageJson({}, { ...freshPackageJson(), upgrade: 'not-a-pear-link' })
  t.is(kept.upgrade, 'not-a-pear-link', 'and an upgrade field is neither parsed nor rejected')
  const source = fs.readFileSync(path.join(__dirname, '..', 'forge.config.js'), 'utf8')
  t.absent(/pear-link|UPGRADE_KEY/.test(source), 'forge.config.js names neither')
})

// The packager prunes from the SOURCE package.json, so the dependencies the
// hook dropped are still in the copy; packageAfterPrune removes them (U-1).
function fakeApp(t, manifest) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-build-variants-'))
  t.teardown(() => fs.rmSync(app, { recursive: true, force: true }))
  const write = (dir, json) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json))
  }
  const nm = path.join(app, 'node_modules')
  write(app, manifest)
  write(path.join(nm, 'hyperswarm'), {
    dependencies: {
      hyperdht: '*',
      '@hyperswarm/secret-stream': '*',
      'bare-sidecar': '*',
      'swarm-only': '*'
    }
  })
  write(path.join(nm, 'hyperswarm', 'node_modules', 'nested-only'), {})
  write(path.join(nm, 'hyperdht'), { dependencies: { b4a: '*' } })
  write(path.join(nm, 'swarm-only'), {})
  write(path.join(nm, 'bare-sidecar'), {})
  write(path.join(nm, 'hypercore'), {
    dependencies: { '@hyperswarm/secret-stream': '*', b4a: '*' }
  })
  write(path.join(nm, '@hyperswarm', 'secret-stream'), {})
  write(path.join(nm, 'b4a'), {})
  write(path.join(app, 'tabby-plugin', 'node_modules', 'hyperswarm'), {})
  write(path.join(nm, '@freenetorg', 'freenet-stdlib'), {})
  return { app, has: (...parts) => fs.existsSync(path.join(app, ...parts)) }
}

test('packageAfterPrune removes what an absent backend dropped, and only that', async (t) => {
  const none = await mutate(t, 'none')
  const { app, has } = fakeApp(t, {
    dependencies: { hypercore: '*', 'bare-sidecar': '*' },
    optionalDependencies: {},
    zbtermBackends: none.zbtermBackends
  })
  await packageAfterPrune({}, app)
  for (const name of ['hyperswarm', 'hyperdht', 'swarm-only']) {
    t.absent(has('node_modules', name), `${name} is removed`)
  }
  for (const name of ['hypercore', 'bare-sidecar', 'b4a', '@hyperswarm/secret-stream']) {
    t.ok(has('node_modules', name), `${name} stays: something that ships needs it`)
  }
  t.ok(has('tabby-plugin', 'node_modules', 'hyperswarm'), 'other trees are not touched (S-14)')
  t.absent(
    has('node_modules', '@freenetorg'),
    'a dropped scoped package leaves no empty scope (F9)'
  )
  t.ok(has('node_modules', '@hyperswarm'), 'a scope that still holds a kept package stays')
})

test('packageAfterPrune keeps a dropped dependency another shipped package needs', async (t) => {
  await mutate(t, 'none')
  const { app, has } = fakeApp(t, {
    dependencies: { hypercore: '*', 'needs-dht': '*' },
    zbtermBackends: []
  })
  fs.mkdirSync(path.join(app, 'node_modules', 'needs-dht'))
  fs.writeFileSync(
    path.join(app, 'node_modules', 'needs-dht', 'package.json'),
    JSON.stringify({ dependencies: { hyperdht: '*' } })
  )
  await packageAfterPrune({}, app)
  t.ok(has('node_modules', 'hyperdht'), 'hyperdht stays (U-1: report, do not force)')
  t.absent(has('node_modules', 'hyperswarm'))
  t.absent(has('node_modules', 'swarm-only'))
})

test('packageAfterPrune leaves a Pear build exactly as the packager made it', async (t) => {
  await mutate(t, undefined)
  const { app, has } = fakeApp(t, {
    dependencies: { hypercore: '*' },
    optionalDependencies: { hyperswarm: '*', hyperdht: '*' },
    zbtermBackends: ['pear']
  })
  await packageAfterPrune({}, app)
  for (const name of ['hyperswarm', 'hyperdht', 'swarm-only']) {
    t.ok(has('node_modules', name), `${name} stays`)
  }
  t.ok(has('node_modules', 'hyperswarm', 'node_modules', 'nested-only'))
})
