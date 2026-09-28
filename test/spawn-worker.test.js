// engine/spawn-worker.js is the one place a Bare worker is spawned
// (nonpear-no-updater U-2). It has to stay what `PearRuntime.run` was: the
// same Sidecar, the same arguments.
const fs = require('fs')
const path = require('path')
const Module = require('module')
const test = require('brittle')

const ROOT = path.join(__dirname, '..')
const HELPER = path.join(ROOT, 'engine', 'spawn-worker.js')

function withStubbedSidecar(t) {
  const calls = []
  class StubSidecar {
    constructor(...args) {
      calls.push(args)
    }
  }
  // Stand the stub in for the real module in the require cache: Node answers
  // a repeated require from a per-directory cache without asking
  // Module._resolveFilename, so a resolution stub alone would not bite.
  const realPath = require.resolve('bare-sidecar')
  const savedReal = require.cache[realPath]
  const savedHelper = require.cache[HELPER]
  const stubModule = new Module(realPath)
  stubModule.filename = realPath
  stubModule.loaded = true
  stubModule.exports = StubSidecar
  require.cache[realPath] = stubModule
  delete require.cache[HELPER]
  t.teardown(() => {
    delete require.cache[realPath]
    if (savedReal) require.cache[realPath] = savedReal
    delete require.cache[HELPER]
    if (savedHelper) require.cache[HELPER] = savedHelper
  })
  return { calls, StubSidecar }
}

test('spawnWorker constructs a bare-sidecar Sidecar with the arguments it was given', (t) => {
  const { calls, StubSidecar } = withStubbedSidecar(t)
  const { spawnWorker } = require('../engine/spawn-worker')

  const opts = { cwd: '/somewhere' }
  const args = ['/data', '', '/profile', 'none']
  const worker = spawnWorker('/entry.js', args, opts)
  t.ok(worker instanceof StubSidecar, 'the return value is the Sidecar')
  t.is(calls.length, 1, 'one Sidecar per call')
  t.is(calls[0][0], '/entry.js', 'entrypoint first')
  t.is(calls[0][1], args, 'the argument array is passed through, not copied')
  t.is(calls[0][2], opts, 'and so are the options')

  spawnWorker('/other.js')
  t.alike(calls[1], ['/other.js', [], {}], "defaults match pear-runtime's run: [] and {}")
})

// `pear-runtime` is a dependency of no build any more (D-08), so nothing here
// reads it from node_modules: a clean install does not have it. What stays
// pinned is the helper's own source and the range both manifests install.
test('spawnWorker goes to bare-sidecar directly, and needs no pear-runtime', (t) => {
  const source = fs.readFileSync(HELPER, 'utf8')
  t.ok(source.includes("require('bare-sidecar')"), 'it requires bare-sidecar')
  t.absent(/require\(\s*['"]pear-runtime['"]\s*\)/.test(source), 'and never pear-runtime')
  t.ok(
    source.includes('return new Sidecar(entrypoint, args, opts)'),
    'it is still only `new Sidecar(entrypoint, args, opts)`'
  )

  const wanted = require(path.join(ROOT, 'package.json')).dependencies['bare-sidecar']
  t.ok(wanted, 'the app depends on bare-sidecar itself')
  for (const manifest of ['package.json', 'engine/package.json']) {
    const pkg = require(path.join(ROOT, manifest))
    t.is(pkg.dependencies['bare-sidecar'], wanted, `${manifest} pins the same range`)
  }
})
