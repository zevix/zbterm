const test = require('brittle')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const { detectChannel, checkForUpdate, compareVersions } = require('../electron/update-channel')

// A stand-in for registry.npmjs.org: `handler` decides what the single
// `/zbterm/latest` route answers, so every failure mode is reproducible
// offline.
async function startRegistry(t, handler) {
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/zbterm/latest`,
    get requests() {
      return requests
    }
  }
}

function jsonRegistry(version) {
  return (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: 'zbterm', version }))
  }
}

function memoryCache(initial = null) {
  let value = initial
  return {
    get: () => value,
    set: (next) => {
      value = next
    }
  }
}

test('detectChannel: env override wins, then node_modules/zbterm, then isPackaged', async (t) => {
  const npmRoot = path.join('/usr', 'lib', 'node_modules', 'zbterm')

  t.is(detectChannel({ appPath: '/home/x/src/zbterm', isPackaged: true, env: {} }), 'packaged')
  t.is(detectChannel({ appPath: '/home/x/src/zbterm', isPackaged: false, env: {} }), 'dev')
  t.is(detectChannel({ appPath: npmRoot, isPackaged: false, env: {} }), 'npm')
  t.is(detectChannel({ appPath: npmRoot, isPackaged: true, env: {} }), 'npm')
  t.is(
    detectChannel({ appPath: npmRoot, isPackaged: false, env: { ZBTERM_CHANNEL: 'packaged' } }),
    'packaged'
  )
  t.is(
    detectChannel({
      appPath: '/home/x/src/zbterm',
      isPackaged: false,
      env: { ZBTERM_CHANNEL: 'npm' }
    }),
    'npm'
  )
  // A typo must not put the app on a fourth, undefined channel.
  t.is(
    detectChannel({
      appPath: '/home/x/src/zbterm',
      isPackaged: true,
      env: { ZBTERM_CHANNEL: 'nmp' }
    }),
    'packaged'
  )
  // A path that merely mentions zbterm is not an npm install.
  t.is(
    detectChannel({ appPath: '/home/x/node_modules/zbterm-tools', isPackaged: false, env: {} }),
    'dev'
  )
})

test('compareVersions handles MAJOR.MINOR.PATCH and rejects garbage', async (t) => {
  t.is(compareVersions('1.0.45', '1.0.44'), 1)
  t.is(compareVersions('1.0.44', '1.0.44'), 0)
  t.is(compareVersions('1.0.43', '1.0.44'), -1)
  t.is(compareVersions('1.10.0', '1.9.9'), 1)
  t.is(compareVersions('2.0.0', '1.99.99'), 1)
  t.is(compareVersions('v1.0.45', '1.0.44'), 1)
  t.is(compareVersions('1.0.44-beta.1', '1.0.44'), 0)
  t.is(compareVersions('banana', '1.0.44'), null)
  t.is(compareVersions('1.0', '1.0.44'), null)
})

test('checkForUpdate: newer registry version is available', async (t) => {
  const registry = await startRegistry(t, jsonRegistry('1.1.0'))
  const result = await checkForUpdate({ currentVersion: '1.0.44', registryUrl: registry.url })
  t.is(result.available, true)
  t.is(result.latest, '1.1.0')
  t.is(result.current, '1.0.44')
  t.ok(Number.isFinite(result.checkedAt))
  t.absent(result.error)
})

test('checkForUpdate: equal and older registry versions are not available', async (t) => {
  const same = await startRegistry(t, jsonRegistry('1.0.44'))
  const equal = await checkForUpdate({ currentVersion: '1.0.44', registryUrl: same.url })
  t.is(equal.available, false)
  t.is(equal.latest, '1.0.44')

  const behind = await startRegistry(t, jsonRegistry('1.0.1'))
  const older = await checkForUpdate({ currentVersion: '1.0.44', registryUrl: behind.url })
  t.is(older.available, false)
  t.is(older.latest, '1.0.1')
})

test('checkForUpdate: a 404 (never published) is a quiet no-update, not an error', async (t) => {
  const registry = await startRegistry(t, (req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"Not found"}')
  })
  const result = await checkForUpdate({ currentVersion: '1.0.44', registryUrl: registry.url })
  t.is(result.available, false)
  t.absent(result.error)
  t.is(result.reason, 'not-published')
})

test('checkForUpdate: malformed bodies resolve to available:false', async (t) => {
  const garbage = await startRegistry(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('<!doctype html><h1>proxy login</h1>')
  })
  const notJson = await checkForUpdate({ currentVersion: '1.0.44', registryUrl: garbage.url })
  t.is(notJson.available, false)
  t.ok(notJson.error)

  const noVersion = await startRegistry(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"name":"zbterm","version":"banana"}')
  })
  const unparseable = await checkForUpdate({ currentVersion: '1.0.44', registryUrl: noVersion.url })
  t.is(unparseable.available, false)
  t.ok(unparseable.error)

  const serverError = await startRegistry(t, (req, res) => {
    res.writeHead(503)
    res.end('down')
  })
  const failed = await checkForUpdate({ currentVersion: '1.0.44', registryUrl: serverError.url })
  t.is(failed.available, false)
  t.ok(failed.error)

  const unreachable = await checkForUpdate({
    currentVersion: '1.0.44',
    // Reserved TEST-NET-1 address on a closed port: connect fails immediately
    // or is cut off by the timeout - either way it must not throw.
    registryUrl: 'http://192.0.2.1:9/zbterm/latest',
    timeoutMs: 300
  })
  t.is(unreachable.available, false)
  t.ok(unreachable.error)

  const bogusUrl = await checkForUpdate({ currentVersion: '1.0.44', registryUrl: 'not a url' })
  t.is(bogusUrl.available, false)
  t.ok(bogusUrl.error)
})

test('checkForUpdate: a hung registry gives up after timeoutMs', async (t) => {
  const sockets = []
  const registry = await startRegistry(t, (req, res) => {
    sockets.push(res.socket)
    // Never respond.
  })
  t.teardown(() => {
    for (const socket of sockets) socket.destroy()
  })

  const startedAt = Date.now()
  const result = await checkForUpdate({
    currentVersion: '1.0.44',
    registryUrl: registry.url,
    timeoutMs: 400
  })
  const elapsed = Date.now() - startedAt
  t.is(result.available, false)
  t.ok(result.error)
  t.ok(result.error.includes('timed out'), 'reports the timeout: ' + result.error)
  t.ok(elapsed < 2000, 'returned promptly (' + elapsed + 'ms)')
})

test('checkForUpdate: a fresh cached result suppresses the network call', async (t) => {
  const registry = await startRegistry(t, jsonRegistry('1.1.0'))
  const cache = memoryCache()

  const first = await checkForUpdate({
    currentVersion: '1.0.44',
    registryUrl: registry.url,
    cache
  })
  t.is(first.available, true)
  t.is(registry.requests, 1)
  t.absent(first.fromCache)

  const second = await checkForUpdate({
    currentVersion: '1.0.44',
    registryUrl: registry.url,
    cache
  })
  t.is(second.available, true)
  t.is(second.latest, '1.1.0')
  t.is(second.fromCache, true)
  t.is(registry.requests, 1, 'no second registry request within the TTL')

  // 24h later the cache is stale again.
  const third = await checkForUpdate({
    currentVersion: '1.0.44',
    registryUrl: registry.url,
    cache,
    now: Date.now() + 25 * 60 * 60 * 1000
  })
  t.absent(third.fromCache)
  t.is(registry.requests, 2)

  // A cached answer for a different installed version is never reused.
  const upgraded = await checkForUpdate({
    currentVersion: '1.1.0',
    registryUrl: registry.url,
    cache
  })
  t.is(upgraded.available, false)
  t.is(registry.requests, 3)
})

test('checkForUpdate: transient failures are not cached', async (t) => {
  let fail = true
  const registry = await startRegistry(t, (req, res) => {
    if (fail) {
      res.writeHead(503)
      res.end('down')
      return
    }
    jsonRegistry('1.2.0')(req, res)
  })
  const cache = memoryCache()

  const failed = await checkForUpdate({
    currentVersion: '1.0.44',
    registryUrl: registry.url,
    cache
  })
  t.is(failed.available, false)
  t.is(cache.get(), null, 'the failure was not written to the cache')

  fail = false
  const ok = await checkForUpdate({ currentVersion: '1.0.44', registryUrl: registry.url, cache })
  t.is(ok.available, true)
  t.is(registry.requests, 2)
})

// The stub below is a /bin/sh script, so this asserts the POSIX branch only.
test(
  'zbterm update runs `npm install -g zbterm@latest`',
  { skip: process.platform === 'win32' },
  async (t) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-update-'))
    t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

    const argsFile = path.join(dir, 'args.txt')
    const stub = path.join(dir, 'npm')
    await fs.promises.writeFile(
      stub,
      ['#!/bin/sh', 'printf "%s\\n" "$@" > ' + JSON.stringify(argsFile), 'exit 7', ''].join('\n')
    )
    await fs.promises.chmod(stub, 0o755)

    const bin = path.join(__dirname, '..', 'bin', 'zbterm.js')
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, 'update'], {
        stdio: 'ignore',
        env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH }
      })
      child.on('error', reject)
      child.on('exit', resolve)
    })

    const args = (await fs.promises.readFile(argsFile, 'utf8')).trim().split('\n')
    t.alike(args, ['install', '-g', 'zbterm@latest'])
    t.is(code, 7, 'exits with npm exit code')
  }
)
