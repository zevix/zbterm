const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')

const { IdentityStore } = require('../engine/identity/store')
const { IdentityResolver } = require('../engine/identity/resolver')

const KEY = {
  keyType: 'ssh-ed25519',
  blobBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIB' + 'A'.repeat(42),
  fingerprint: 'SHA256:' + 'B'.repeat(43)
}

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-resolver-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, store: new IdentityStore(dir) }
}

// A resolver wired to a stub shell: `emit` records every request and, unless
// the test says otherwise, answers it inline through `handleResponse`. Inline
// is deliberate - it is exactly the race the resolver's queueMicrotask guards
// against (the answer landing before the pending entry exists).
function makeResolver(t, store, opts = {}) {
  const events = []
  const state = { reply: opts.reply || null }
  let resolver = null
  resolver = new IdentityResolver({
    store,
    timeoutMs: opts.timeoutMs === undefined ? 200 : opts.timeoutMs,
    positiveTtlMs: opts.positiveTtlMs,
    negativeTtlMs: opts.negativeTtlMs,
    now: opts.now,
    emit: (name, data) => {
      events.push({ name, data })
      if (!state.reply) return
      const answer = state.reply(data)
      if (answer) resolver.handleResponse({ requestId: data.requestId, ...answer })
    }
  })
  t.teardown(() => resolver.close())
  return { resolver, events, state }
}

// The request is emitted only after the (async) cache read, so a test that
// answers it by hand has to wait for it rather than counting microtasks.
async function waitForEvent(events, count = 1) {
  for (let i = 0; i < 100 && events.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return events
}

test('a remote answer is cached, and a fresh resolver serves it without emitting', async (t) => {
  const { dir, store } = tmpStore(t)
  await store.ready()
  const first = makeResolver(t, store, {
    reply: () => ({ ok: true, result: { status: 'ok', keys: [KEY] } })
  })

  const remote = await first.resolver.resolve('github', 'Octocat')
  t.is(remote.status, 'ok')
  t.is(remote.source, 'remote')
  t.alike(remote.keys, [KEY])
  t.is(first.events.length, 1, 'one request emitted')
  t.is(first.events[0].name, 'identity:resolve-request')
  t.is(first.events[0].data.provider, 'github')
  t.is(first.events[0].data.subject, 'octocat', 'the subject is normalised by the provider')
  t.is(typeof first.events[0].data.requestId, 'string')

  const record = JSON.parse(
    fs.readFileSync(path.join(dir, 'provider-cache', 'github', 'octocat.json'), 'utf8')
  )
  t.is(record.version, 2)
  t.is(record.provider, 'github')
  t.is(record.subject, 'octocat')
  t.is(record.status, 'ok')
  t.alike(record.keys, [KEY])
  t.is(typeof record.fetchedAt, 'number')

  const second = makeResolver(t, new IdentityStore(dir), { reply: () => null })
  const cached = await second.resolver.resolve('github', 'octocat')
  t.is(cached.source, 'cache')
  t.alike(cached.keys, [KEY])
  t.is(second.events.length, 0, 'a fresh resolver over the same dir emits nothing')
})

test('a positive entry past its TTL is re-fetched', async (t) => {
  const { store } = tmpStore(t)
  await store.ready()
  const harness = makeResolver(t, store, {
    positiveTtlMs: 20,
    reply: () => ({ ok: true, result: { status: 'ok', keys: [KEY] } })
  })
  await harness.resolver.resolve('github', 'octocat')
  t.is(harness.events.length, 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  const again = await harness.resolver.resolve('github', 'octocat')
  t.is(again.source, 'remote')
  t.is(harness.events.length, 2, 'the stale positive entry triggered a second request')
})

test('refresh ignores a fresh cache entry and rewrites it', async (t) => {
  const { store } = tmpStore(t)
  await store.ready()
  let keys = [KEY]
  const harness = makeResolver(t, store, {
    reply: () => ({ ok: true, result: { status: 'ok', keys } })
  })

  await harness.resolver.resolve('github', 'octocat')
  t.is(harness.events.length, 1)
  const cached = await harness.resolver.resolve('github', 'octocat')
  t.is(cached.source, 'cache', 'a fresh entry is served without a request')
  t.is(harness.events.length, 1)

  // The user just added a key on GitHub: without refresh the wizard would be
  // told it is unpublished for the rest of the positive TTL.
  const added = {
    keyType: 'ssh-ed25519',
    blobBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIB' + 'C'.repeat(42),
    fingerprint: 'SHA256:' + 'D'.repeat(43)
  }
  keys = [KEY, added]
  const forced = await harness.resolver.resolve('github', 'octocat', { refresh: true })
  t.is(forced.source, 'remote', 'refresh bypasses the fresh entry')
  t.is(harness.events.length, 2)
  t.alike(forced.keys, [KEY, added])

  const after = await harness.resolver.resolve('github', 'octocat')
  t.is(after.source, 'cache')
  t.alike(after.keys, [KEY, added], 'the refreshed answer replaced the cached one')
  t.is(harness.events.length, 2)
})

test('a not-found answer is negatively cached for its own TTL', async (t) => {
  const { store } = tmpStore(t)
  await store.ready()
  const harness = makeResolver(t, store, {
    reply: () => ({ ok: true, result: { status: 'not-found', keys: [] } })
  })
  const missing = await harness.resolver.resolve('github', 'ghost')
  t.is(missing.status, 'not-found')
  t.is(missing.source, 'remote')
  t.is(harness.events.length, 1)

  const cached = await harness.resolver.resolve('github', 'ghost')
  t.is(cached.status, 'not-found')
  t.is(cached.source, 'cache')
  t.is(harness.events.length, 1, 'no second request inside the negative TTL')
})

test('a negative entry past its 10 min equivalent is re-fetched', async (t) => {
  const { store } = tmpStore(t)
  await store.ready()
  const harness = makeResolver(t, store, {
    negativeTtlMs: 20,
    reply: () => ({ ok: true, result: { status: 'not-found', keys: [] } })
  })
  await harness.resolver.resolve('github', 'ghost')
  await new Promise((resolve) => setTimeout(resolve, 40))
  await harness.resolver.resolve('github', 'ghost')
  t.is(harness.events.length, 2)
})

test('concurrent resolves for the same subject share one request', async (t) => {
  const { store } = tmpStore(t)
  await store.ready()
  const harness = makeResolver(t, store, { reply: () => null })
  const a = harness.resolver.resolve('github', 'octocat')
  const b = harness.resolver.resolve('github', 'octocat')
  t.is(a, b, 'the same promise is handed to both callers')
  await waitForEvent(harness.events)
  t.is(harness.events.length, 1, 'exactly one request emitted for two concurrent resolves')
  harness.resolver.handleResponse({
    requestId: harness.events[0].data.requestId,
    ok: true,
    result: { status: 'ok', keys: [KEY] }
  })
  const [first, second] = await Promise.all([a, b])
  t.alike(first.keys, [KEY])
  t.alike(second.keys, [KEY])
  // The dedupe entry is dropped once settled, so a later resolve is free to
  // ask again (this one is served by the cache).
  t.is(harness.resolver.inflight.size, 0)
})

test('a request with no answer rejects with E_NET and leaves no pending entry', async (t) => {
  const { store } = tmpStore(t)
  await store.ready()
  const harness = makeResolver(t, store, { timeoutMs: 60, reply: () => null })
  await t.exception(harness.resolver.resolve('github', 'octocat'), /Timed out after 60ms/)
  t.is(harness.resolver.pending.size, 0, 'the pending map is empty after the timeout')
  t.is(harness.resolver.inflight.size, 0)
  try {
    await harness.resolver.resolve('github', 'octocat')
  } catch (err) {
    t.is(err.code, 'E_NET')
    t.is(err.name, 'EngineError')
  }
})

test('a shell error rejects with the shell message', async (t) => {
  const { store } = tmpStore(t)
  await store.ready()
  const harness = makeResolver(t, store, {
    reply: () => ({ ok: false, error: { message: 'github responded with HTTP 503' } })
  })
  await t.exception(harness.resolver.resolve('github', 'octocat'), /HTTP 503/)
})

test('a stale entry is served when the live lookup fails', async (t) => {
  const { dir, store } = tmpStore(t)
  await store.ready()
  const good = makeResolver(t, store, {
    positiveTtlMs: 20,
    reply: () => ({ ok: true, result: { status: 'ok', keys: [KEY] } })
  })
  await good.resolver.resolve('github', 'octocat')
  await new Promise((resolve) => setTimeout(resolve, 40))

  const broken = makeResolver(t, new IdentityStore(dir), {
    positiveTtlMs: 20,
    reply: () => ({ ok: false, error: { message: 'offline' } })
  })
  const stale = await broken.resolver.resolve('github', 'octocat')
  t.is(stale.source, 'cache-stale')
  t.is(stale.status, 'ok')
  t.alike(stale.keys, [KEY])
  t.is(broken.events.length, 1, 'it did try the network first')
})

test('fetchImpl bypasses the shell seam entirely', async (t) => {
  const { store } = tmpStore(t)
  await store.ready()
  const events = []
  const resolver = new IdentityResolver({
    store,
    emit: (name, data) => events.push({ name, data }),
    fetchImpl: (provider, subject) => {
      t.is(provider, 'github')
      t.is(subject, 'octocat')
      return Promise.resolve({ status: 'ok', keys: [KEY] })
    }
  })
  t.teardown(() => resolver.close())
  const result = await resolver.resolve('github', 'octocat')
  t.is(result.source, 'remote')
  t.alike(result.keys, [KEY])
  t.is(events.length, 0, 'no event emitted when fetchImpl is injected')
})

test('a malformed shell answer is rejected rather than cached', async (t) => {
  const { store } = tmpStore(t)
  await store.ready()
  const harness = makeResolver(t, store, {
    reply: () => ({ ok: true, result: { status: 'maybe', keys: [] } })
  })
  await t.exception(harness.resolver.resolve('github', 'octocat'), /unknown status/)
  t.is(await store.readProviderCache('github', 'octocat'), null)
})

test('close rejects everything still pending', async (t) => {
  const { store } = tmpStore(t)
  await store.ready()
  const harness = makeResolver(t, store, { timeoutMs: 60000, reply: () => null })
  const pending = harness.resolver.resolve('github', 'octocat')
  await waitForEvent(harness.events)
  t.is(harness.resolver.pending.size, 1)
  harness.resolver.close()
  await t.exception(pending, /shutting down/)
  t.is(harness.resolver.pending.size, 0)
})

test('an unknown provider or an invalid subject is refused before any request', async (t) => {
  const { store } = tmpStore(t)
  await store.ready()
  const harness = makeResolver(t, store, { reply: () => null })
  t.exception(() => harness.resolver.resolve('gitlab', 'octocat'), /Unknown identity provider/)
  t.exception(() => harness.resolver.resolve('github', '../../etc'), /Invalid github username/)
  t.is(harness.events.length, 0)
})
