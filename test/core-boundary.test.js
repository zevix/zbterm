const fs = require('fs')
const path = require('path')
const test = require('brittle')

const { walk, specifiers } = require('./helpers/source-scan')

// The core (engine/, published as the zbterm-core package, including its
// Bare sidecar entrypoint engine/worker.js) must stay free of host-specific
// code: it owns interfaces, the host owns implementations. This test is the
// enforcement - see docs/ARCHITECTURE.md "Core boundary". workers/ held the
// app's OTA updater and was scanned too, until the updater was removed (D-08).
const ROOT = path.join(__dirname, '..')
const CORE_DIRS = ['engine']
const FORBIDDEN_DIRS = ['electron', 'renderer', 'bin']
const FORBIDDEN_PACKAGES = ['@lydell/node-pty', 'electron']
// Process spawning is a host capability with no adapter contract in the core.
const FORBIDDEN_IN_ENGINE = ['child_process', 'node:child_process']

// The one place a relative specifier may name something that is not on disk:
// the backend registry loads each backend through a guarded require, and a
// build variant (or a phase that has not landed yet) legitimately lacks a
// backend directory. Everything else must resolve.
const OPTIONAL_FROM = path.join('engine', 'backends', 'index.js')
const OPTIONAL_SPECIFIERS = ['./pear', './freenet']

test('engine/ never reaches into a host implementation', (t) => {
  const files = CORE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))
  t.ok(files.length > 10, `scanned ${files.length} core files`)

  const violations = []
  for (const file of files) {
    const rel = path.relative(ROOT, file)
    const inEngine = rel.split(path.sep)[0] === 'engine'
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (FORBIDDEN_PACKAGES.includes(spec)) {
        violations.push(`${rel}: requires host package '${spec}'`)
        continue
      }
      if (inEngine && FORBIDDEN_IN_ENGINE.includes(spec)) {
        violations.push(`${rel}: requires host capability '${spec}'`)
        continue
      }
      // Relative specifiers have to be resolved, not string-matched:
      // `require('../electron/x')` and a `require('./pty-host')` left behind by
      // a bad move are the same violation.
      if (!spec.startsWith('.')) continue
      const target = path.relative(ROOT, path.resolve(path.dirname(file), spec))
      const top = target.split(path.sep)[0]
      if (FORBIDDEN_DIRS.includes(top)) {
        violations.push(`${rel}: requires '${spec}' -> ${target}`)
      }
    }
  }

  t.alike(violations, [], 'no core file depends on electron/, renderer/ or bin/')
})

test('the core resolves every specifier it declares', (t) => {
  // A require that no longer resolves is the other half of a bad move: the
  // boundary is only meaningful if the files really load.
  const files = CORE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))
  const broken = []
  for (const file of files) {
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue
      const optional = path.relative(ROOT, file) === OPTIONAL_FROM
      if (optional && OPTIONAL_SPECIFIERS.includes(spec)) continue
      const target = path.resolve(path.dirname(file), spec)
      if (!fs.existsSync(target) && !fs.existsSync(`${target}.js`)) {
        broken.push(`${path.relative(ROOT, file)}: '${spec}' does not exist`)
      }
    }
  }
  t.alike(broken, [], 'every relative specifier under engine/ resolves')
})

test('SessionEngine refuses to construct without an injected ptyHost', (t) => {
  const SessionEngine = require('../engine')
  try {
    new SessionEngine({})
    t.fail('constructing without a ptyHost should throw')
  } catch (err) {
    t.is(err.name, 'EngineError', 'an EngineError, not a TypeError')
    t.ok(/^E_/.test(err.code), `carries an engine error code (${err.code})`)
  }
})
