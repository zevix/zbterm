// IdentityResolver is a thin call-through to the `zxterm-core` sidecar (K9 of
// zxterm-core), which fetches `<base>/<user>.keys` itself and owns the cache
// files. Every case runs a sidecar of its own whose keys base is a loopback
// server that counts the requests it gets: where these cases once counted
// `identity:resolve-request` events, they now count requests at that server.
const fs = require('fs')
const path = require('path')
const test = require('brittle')

const { testCore } = require('./helpers/zxterm-core')
const { keysServer, keysBody, refusedBase } = require('./helpers/k9c-keys-server')
const { IdentityStore } = require('../engine/identity/store')
const { IdentityResolver } = require('../engine/identity/resolver')
const { fingerprint } = require('../engine/identity/claim')

const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000
const NEGATIVE_TTL_MS = 10 * 60 * 1000

const KEY = {
  keyType: 'ssh-ed25519',
  blobBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIB' + 'A'.repeat(42),
  fingerprint: 'SHA256:' + 'B'.repeat(43)
}

// The sidecar parses the served body and fingerprints each key itself, so a
// fixture key's fingerprint is the real one (asked of the core), not a
// placeholder.
async function published(key) {
  return { ...key, fingerprint: await fingerprint(Buffer.from(key.blobBase64, 'base64')) }
}

function ok(keys) {
  return () => ({ status: 200, body: keysBody(keys) })
}

// A sidecar on a fresh profile directory whose keys base is `base`, with an
// IdentityStore and an IdentityResolver on it.
async function makeResolver(t, base, dir) {
  const core = testCore(t, { env: { ZBTERM_GITHUB_KEYS_BASE: base }, dir })
  const store = new IdentityStore(path.join(core.profileDir, 'identity'), { core })
  await store.ready()
  const resolver = new IdentityResolver({ core })
  t.teardown(() => resolver.close())
  return { core, store, resolver, dir: core.profileDir }
}

function cacheFile(dir, subject) {
  return path.join(dir, 'identity', 'provider-cache', 'github', subject + '.json')
}

// Back-dates a cache entry past `ttlMs`, as if it had been written that long
// ago (the sidecar's TTLs are fixed, so time is moved on disk instead).
function backdate(dir, subject, ttlMs) {
  const file = cacheFile(dir, subject)
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  record.fetchedAt = Date.now() - ttlMs - 1000
  fs.writeFileSync(file, JSON.stringify(record))
}

test('a remote answer is cached, and a fresh resolver serves it without emitting', async (t) => {
  const key = await published(KEY)
  const server = await keysServer(t, ok([key]))
  const first = await makeResolver(t, server.base)

  const remote = await first.resolver.resolve('github', 'Octocat')
  t.is(remote.status, 'ok')
  t.is(remote.source, 'remote')
  t.alike(remote.keys, [key])
  t.is(server.requests.length, 1, 'one request reached the keys server')
  t.is(server.requests[0], '/octocat.keys', 'the subject is normalised by the provider')

  const record = JSON.parse(fs.readFileSync(cacheFile(first.dir, 'octocat'), 'utf8'))
  t.is(record.version, 2)
  t.is(record.provider, 'github')
  t.is(record.subject, 'octocat')
  t.is(record.status, 'ok')
  t.alike(record.keys, [key])
  t.is(typeof record.fetchedAt, 'number')

  // A fresh sidecar over the same profile directory: the cache is on disk.
  first.core.close()
  const second = await makeResolver(t, server.base, first.dir)
  const cached = await second.resolver.resolve('github', 'octocat')
  t.is(cached.source, 'cache')
  t.alike(cached.keys, [key])
  t.is(server.requests.length, 1, 'a fresh resolver over the same dir asks nothing')
})

test('a positive entry past its TTL is re-fetched', async (t) => {
  const key = await published(KEY)
  const server = await keysServer(t, ok([key]))
  const harness = await makeResolver(t, server.base)
  await harness.resolver.resolve('github', 'octocat')
  t.is(server.requests.length, 1)
  backdate(harness.dir, 'octocat', POSITIVE_TTL_MS)
  const again = await harness.resolver.resolve('github', 'octocat')
  t.is(again.source, 'remote')
  t.is(server.requests.length, 2, 'the stale positive entry triggered a second request')
})

test('refresh ignores a fresh cache entry and rewrites it', async (t) => {
  const key = await published(KEY)
  let keys = [key]
  const server = await keysServer(t, () => ({ status: 200, body: keysBody(keys) }))
  const harness = await makeResolver(t, server.base)

  await harness.resolver.resolve('github', 'octocat')
  t.is(server.requests.length, 1)
  const cached = await harness.resolver.resolve('github', 'octocat')
  t.is(cached.source, 'cache', 'a fresh entry is served without a request')
  t.is(server.requests.length, 1)

  // The user just added a key on GitHub: without refresh the wizard would be
  // told it is unpublished for the rest of the positive TTL.
  const added = await published({
    keyType: 'ssh-ed25519',
    blobBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIB' + 'C'.repeat(42),
    fingerprint: 'SHA256:' + 'D'.repeat(43)
  })
  keys = [key, added]
  const forced = await harness.resolver.resolve('github', 'octocat', { refresh: true })
  t.is(forced.source, 'remote', 'refresh bypasses the fresh entry')
  t.is(server.requests.length, 2)
  t.alike(forced.keys, [key, added])

  const after = await harness.resolver.resolve('github', 'octocat')
  t.is(after.source, 'cache')
  t.alike(after.keys, [key, added], 'the refreshed answer replaced the cached one')
  t.is(server.requests.length, 2)
})

test('a not-found answer is negatively cached for its own TTL', async (t) => {
  const server = await keysServer(t, () => ({ status: 404 }))
  const harness = await makeResolver(t, server.base)
  const missing = await harness.resolver.resolve('github', 'ghost')
  t.is(missing.status, 'not-found')
  t.is(missing.source, 'remote')
  t.is(server.requests.length, 1)

  const cached = await harness.resolver.resolve('github', 'ghost')
  t.is(cached.status, 'not-found')
  t.is(cached.source, 'cache')
  t.is(server.requests.length, 1, 'no second request inside the negative TTL')
})

test('a negative entry past its 10 min equivalent is re-fetched', async (t) => {
  const server = await keysServer(t, () => ({ status: 404 }))
  const harness = await makeResolver(t, server.base)
  await harness.resolver.resolve('github', 'ghost')
  backdate(harness.dir, 'ghost', NEGATIVE_TTL_MS)
  await harness.resolver.resolve('github', 'ghost')
  t.is(server.requests.length, 2)
})

// Retargeted: the dedupe lives in the sidecar now, so two concurrent resolves
// are two seam requests that the keys server must see as one.
test('concurrent resolves for the same subject share one request', async (t) => {
  const key = await published(KEY)
  const server = await keysServer(t, () => ({
    status: 200,
    body: keysBody([key]),
    delayMs: 300
  }))
  const harness = await makeResolver(t, server.base)
  const a = harness.resolver.resolve('github', 'octocat')
  const b = harness.resolver.resolve('github', 'octocat')
  const [first, second] = await Promise.all([a, b])
  t.is(server.requests.length, 1, 'exactly one request reached the server for two resolves')
  t.alike(first.keys, [key])
  t.alike(second.keys, [key])
  // Both callers got the one in-flight answer, not a cache read after it.
  t.is(first.source, 'remote')
  t.is(second.source, 'remote')
})

// Retargeted: the sidecar's own fetch fails (a refused loopback port) instead
// of a shell that never answers; no cache entry is left to fall back on.
test('a request with no answer rejects with E_NET and leaves no pending entry', async (t) => {
  const harness = await makeResolver(t, await refusedBase())
  await t.exception(harness.resolver.resolve('github', 'octocat'))
  t.absent(fs.existsSync(cacheFile(harness.dir, 'octocat')), 'nothing is cached')
  try {
    await harness.resolver.resolve('github', 'octocat')
    t.fail('the lookup should have rejected')
  } catch (err) {
    t.is(err.code, 'E_NET')
    t.is(err.name, 'EngineError')
  }
})

// Retargeted: the provider itself answers HTTP 503 (was: the shell's error).
test('a shell error rejects with the shell message', async (t) => {
  const server = await keysServer(t, () => ({ status: 503 }))
  const harness = await makeResolver(t, server.base)
  await t.exception(harness.resolver.resolve('github', 'octocat'), /HTTP 503/)
})

test('a stale entry is served when the live lookup fails', async (t) => {
  const key = await published(KEY)
  let fail = false
  const server = await keysServer(t, () =>
    fail ? { status: 503 } : { status: 200, body: keysBody([key]) }
  )
  const good = await makeResolver(t, server.base)
  await good.resolver.resolve('github', 'octocat')
  backdate(good.dir, 'octocat', POSITIVE_TTL_MS)

  fail = true
  const stale = await good.resolver.resolve('github', 'octocat')
  t.is(stale.source, 'cache-stale')
  t.is(stale.status, 'ok')
  t.alike(stale.keys, [key])
  t.is(server.requests.length, 2, 'it did try the network first')
})

// Retargeted: there is no shell seam any more; the sidecar fetches by itself.
test('fetchImpl bypasses the shell seam entirely', async (t) => {
  const key = await published(KEY)
  const server = await keysServer(t, ok([key]))
  const harness = await makeResolver(t, server.base)
  const result = await harness.resolver.resolve('github', 'octocat')
  t.is(result.source, 'remote')
  t.alike(result.keys, [key])
  t.alike(server.requests, ['/octocat.keys'], 'the sidecar asked the provider itself, once')
  t.absent('emit' in harness.resolver, 'the resolver has no shell event to emit')
})

// Retargeted: the nearest malformed provider answer the core refuses is a
// body over its 64 KiB cap.
test('a malformed shell answer is rejected rather than cached', async (t) => {
  const server = await keysServer(t, () => ({ status: 200, body: 'x'.repeat(65536 + 1024) }))
  const harness = await makeResolver(t, server.base)
  await t.exception(harness.resolver.resolve('github', 'octocat'), /exceeded 65536 bytes/)
  t.absent(fs.existsSync(cacheFile(harness.dir, 'octocat')), 'nothing is cached')
})

// Retargeted: a sidecar lookup cannot be preempted, so close() makes every
// later resolve reject instead.
test('close rejects everything still pending', async (t) => {
  const server = await keysServer(t, ok([]))
  const harness = await makeResolver(t, server.base)
  harness.resolver.close()
  await t.exception(harness.resolver.resolve('github', 'octocat'), /closed/)
  t.is(server.requests.length, 0, 'nothing was asked after close')
})

test('an unknown provider or an invalid subject is refused before any request', async (t) => {
  const server = await keysServer(t, ok([]))
  const harness = await makeResolver(t, server.base)
  t.exception(() => harness.resolver.resolve('gitlab', 'octocat'), /Unknown identity provider/)
  t.exception(() => harness.resolver.resolve('github', '../../etc'), /Invalid github username/)
  t.is(server.requests.length, 0)
})
