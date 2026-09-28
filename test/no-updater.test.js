// No build has the Pear OTA updater (D-08, requirements V-1..V-3). These pins
// read source and manifests, never node_modules: the working tree may still
// hold `pear-runtime` (A-6), so "it resolves" would prove nothing.
const fs = require('fs')
const path = require('path')
const test = require('brittle')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('the host has no updater worker machinery', (t) => {
  const main = read('electron/main.js')
  for (const gone of [
    'pear:applyUpdate',
    'pear:startWorker',
    'app:afterUpdate',
    'pear:worker:',
    'getWorker',
    'mainWorkerSpecifier',
    'updaterAvailable',
    'hasUpdater',
    'updater-available',
    'workers/main.js'
  ]) {
    t.absent(main.includes(gone), `electron/main.js has no ${gone}`)
  }
  t.absent(/\bupgrade\b/.test(main), 'and reads no upgrade key')
})

test('--no-updates is still accepted, and does nothing', (t) => {
  const main = read('electron/main.js')
  const entry = main.match(/\['--no-updates', '([^']+)'\]/)
  t.ok(entry, 'CLI_OPTIONS still lists --no-updates')
  t.ok(/compatibility/.test(entry[1]) && /no effect/.test(entry[1]), 'described as a no-op')
  t.absent(/cmd\.flags\.updates\b/.test(main), 'nothing reads the flag')
  t.ok(main.includes('cmd.flags.updateCheck'), '--no-update-check is still read (V-3)')
  t.ok(
    require('../package.json').scripts.start.includes('--no-updates'),
    'npm start still passes it'
  )
})

test('the manifest carries nothing of the updater', (t) => {
  const pkg = require('../package.json')
  t.absent('upgrade' in pkg, 'package.json has no upgrade')
  t.absent(pkg.files.includes('workers/'), 'files does not publish workers/')
  for (const script of ['lint', 'format']) {
    t.absent(/\bworkers\b/.test(pkg.scripts[script]), `${script} does not name workers`)
  }
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    for (const name of ['pear-runtime', 'pear-link', 'corestore']) {
      t.absent(pkg[field] && pkg[field][name], `${field} has no ${name}`)
    }
  }
  const lock = JSON.parse(read('package-lock.json'))
  for (const name of ['pear-runtime', 'pear-link', 'corestore']) {
    t.absent(lock.packages[`node_modules/${name}`], `package-lock.json installs no ${name}`)
  }
})

test('the bridge and renderer keep the npm update path only', (t) => {
  const preload = read('electron/preload.js')
  for (const gone of [
    'applyUpdate',
    'appAfterUpdate',
    'startWorker',
    'onWorkerStdout',
    'onWorkerStderr',
    'onWorkerIPC',
    'onWorkerExit',
    'writeWorkerIPC'
  ]) {
    t.absent(preload.includes(gone), `electron/preload.js has no ${gone}`)
  }
  t.ok(preload.includes('writeClipboardText'), 'the clipboard bridge the npm button uses stays')

  const app = read('renderer/app.js')
  t.ok(app.includes('function wireNpmUpdater()'), 'renderer/app.js still has wireNpmUpdater')
  t.ok(app.includes("api\n      .invoke('app.updateCheck')"), 'which still asks app.updateCheck')
  const wire = app.match(/function wireUpdater\(\) \{\n([\s\S]*?)\n {2}\}\n/)
  t.ok(wire, 'wireUpdater exists')
  t.is(
    wire[1].trim(),
    "if (state.appInfo.channel === 'npm') wireNpmUpdater()",
    'and is the npm path only: any other channel leaves #update-btn alone'
  )
  for (const gone of ['bridge.applyUpdate', 'bridge.startWorker', 'workers/main.js']) {
    t.absent(app.includes(gone), `renderer/app.js has no ${gone}`)
  }
  const html = read('renderer/index.html')
  t.ok(/id="update-btn"[^>]*\bhidden\b/.test(html), '#update-btn starts hidden')

  const main = read('electron/main.js')
  t.ok(main.includes("if (method === 'app.updateCheck')"), 'the host still answers app.updateCheck')
  for (const kept of ['detectChannel', 'checkForUpdate', 'updateCheckEnabled']) {
    t.ok(main.includes(kept), `electron/main.js keeps ${kept}`)
  }
})
