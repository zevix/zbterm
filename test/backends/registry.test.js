// The backend registry, selection and introspection (backend-abstraction B6:
// R-5, R-6, R-7). Since B8, engine/backends/freenet/ is a stub that declares
// itself `broken` / `probe only`; the absent state is covered through the
// missing-dependency fixture.
// (2026-09-24, F3: it is a real node client now, still `broken`, with the
// detail `not yet wired` until F9; the probe-only fixture stands for any
// backend that declares itself unusable.)
// (2026-09-24, F4: a core whose host offers no WebRTC adapter - no `rtc` host
// capability - hears `host has no WebRTC adapter` first; `not yet wired` is
// the answer once the adapter is there, and to a caller with no host at all.)
// (2026-09-24, F9: `not yet wired` is gone. With the adapter - or with no host
// to ask about - the module says `available`; whether a node answers is the
// backend's probe(), which `share.backends` awaits (A-11).)
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { EventEmitter } = require('events')
const test = require('brittle')
const b4a = require('b4a')

const SessionEngine = require('../../engine')
const ShareManager = require('../../engine/share-manager')
const registry = require('../../engine/backends')
const invite = require('../../engine/invite')
const LoopbackBackend = require('../../engine/backends/loopback')
const { LoopbackHub } = require('../../engine/backends/loopback')
const PearBackend = require('../../engine/backends/pear')
const { CAP, assertBackend } = require('../../engine/backends/types')
const { loadOrCreateLocalDevice } = require('../../engine/crypto')
const { FULL_CAPS, SEND_INPUT, hasCap } = require('../../engine/caps')
const { EngineClient } = require('../../engine/client')
const { resolveBackendLimit } = require('../../electron/backend-limit')
const { iceServersFlag, resolveIceServers } = require('../../electron/ice-servers')
const { DEFAULT_ICE_SERVERS } = require('../../electron/rtc-host')
const { EngineError, CODES } = require('../../engine/errors')
const { joinTwoSessions } = require('./conformance')
const { freePort } = require('../helpers/freenet-node')

const ROOT = path.join(__dirname, '..', '..')
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'backends')
const HOST_KEY = 'ab'.repeat(32)

test('registry: Pear and Freenet are available, the loopback is never listed', (t) => {
  const list = registry.available()
  t.alike(
    list.map((entry) => entry.id),
    ['pear', 'freenet'],
    'only the backends this tree carries are listed'
  )
  const pear = list[0]
  t.is(pear.state, 'available')
  t.is(pear.detail, null)
  t.is(pear.label, new PearBackend().describe().label, 'the label comes from describe()')
  t.ok(pear.capabilities & CAP.EPHEMERAL_DELIVERY, 'the capability bitset comes from describe()')
  t.alike(Object.keys(pear), ['id', 'label', 'capabilities', 'state', 'detail'])

  t.alike(Object.keys(registry.KNOWN), ['pear', 'freenet'], 'the registry knows two backends')
  t.absent(Object.keys(registry.KNOWN).includes('loopback'), 'the test backend is not one of them')

  const freenet = list[1]
  const FreenetBackend = registry.KNOWN.freenet()
  t.is(freenet.state, 'available', 'the Freenet backend is listed, and its module is usable (F9)')
  t.is(freenet.detail, null)
  t.is(freenet.label, new FreenetBackend().describe().label)
  t.is(new FreenetBackend().describe().id, 'freenet')
  t.alike(FreenetBackend.availability(), { state: 'available', detail: null })
  t.is(typeof FreenetBackend.probe, 'function', 'whether a node answers is its probe (A-11)')
  // The hybrid of D-01: brokered through contracts, live over a data channel.
  // Never a direct dial. History that outlives the host is cleared until it
  // exists (F3; design §4 `describe`, §8.2).
  for (const flag of ['EPHEMERAL_DELIVERY', 'BROKERED', 'NAT_TRAVERSAL']) {
    t.ok(freenet.capabilities & CAP[flag], `freenet declares ${flag}`)
  }
  t.absent(freenet.capabilities & CAP.HISTORY_OFFLINE_HOST, 'and no offline history yet')
  t.absent(freenet.capabilities & CAP.DIRECT_DIAL, 'and no direct dial')
  t.absent(pear.capabilities & CAP.BROKERED, 'which tells it apart from Pear')
})

// F3: start() now opens a socket to a node (its default address is the
// owner's node, which no test may use), so starting is covered against a
// local-mode node in test/backends/freenet-client.test.js.
test('registry: Freenet without the host WebRTC adapter says so before anything else (F4)', (t) => {
  const FreenetBackend = registry.KNOWN.freenet()
  const noAdapter = { state: 'broken', detail: 'host has no WebRTC adapter' }
  const usable = { state: 'available', detail: null }
  t.alike(FreenetBackend.availability({ hostCaps: '' }), noAdapter, "hostCaps '' -> no adapter")
  t.alike(FreenetBackend.availability({ hostCaps: 'pty' }), noAdapter, 'a list without rtc')
  t.alike(FreenetBackend.availability({ hostCaps: 'rtc' }), usable, 'rtc -> available (F9)')
  t.alike(FreenetBackend.availability({ hostCaps: 'pty, rtc' }), usable, 'rtc in a list')
  t.alike(FreenetBackend.availability({}), usable, 'no host to ask about -> skipped')

  const bare = registry.resolve({ hostCaps: '' }).backends.find((entry) => entry.id === 'freenet')
  t.alike(
    [bare.state, bare.detail],
    ['broken', 'host has no WebRTC adapter'],
    'resolve() passes it'
  )
  const withRtc = registry.resolve({ hostCaps: 'rtc' })
  t.is(withRtc.backends.find((entry) => entry.id === 'freenet').state, 'available')
  t.is(withRtc.default, 'pear', 'Pear needs no adapter, and comes first')
  const err = outcomeSync(() => registry.create('freenet', { hostCaps: '' }))
  t.is(err && err.code, 'E_BACKEND_UNSUPPORTED')
  t.ok(err.message.includes('host has no WebRTC adapter'), 'create() says why')
})

test('share manager: hostCaps selects, and rtcHost reaches the backend constructor (F4)', (t) => {
  const calls = []
  const rtcHost = new EventEmitter()
  const fake = {
    resolve(ctx) {
      calls.push(['resolve', ctx])
      return {
        backends: [{ id: 'loopback', state: 'available', detail: null }],
        default: 'loopback',
        limitedBy: null
      }
    },
    create(id, ctx) {
      calls.push(['create', id, ctx])
      return new LoopbackBackend({ hub: new LoopbackHub() })
    }
  }
  const manager = new ShareManager(null, { registry: fake, hostCaps: 'rtc', rtcHost })
  t.ok(manager.backend, 'a backend was created')
  const create = calls.find(([kind]) => kind === 'create')
  t.alike(create[2], { limit: '', hostCaps: 'rtc', options: { rtcHost } }, 'create() ctx')
  t.ok(
    calls.filter(([kind]) => kind === 'resolve').every(([, ctx]) => ctx.hostCaps === 'rtc'),
    'every resolve() sees the host capabilities'
  )
  const plain = new ShareManager(null, { registry: fake })
  t.is(plain._hostCaps, '', 'no hostCaps -> no capabilities')
  return Promise.all([manager.close(), plain.close()])
})

test('registry: the Freenet backend has the backend shape and shares nothing yet', async (t) => {
  const FreenetBackend = registry.KNOWN.freenet()
  const backend = assertBackend(new FreenetBackend())
  t.is(backend.health().started, false)
  t.is(backend.diagnostics().announced, 0)
  const err = await outcome(backend.announce('link', {}))
  t.is(err.code, 'E_BACKEND_UNAVAILABLE')
  // Since F6 announce() is implemented; unstarted, it says so.
  t.is(err.details.detail, 'not started', 'announce() says why')
  await backend.stop()
})

test('registry: a limit narrows the set and never adds to it', (t) => {
  const open = registry.resolve({})
  t.alike(pickIds(open), ['pear', 'freenet'])
  t.is(open.default, 'pear')
  t.is(open.limitedBy, null)
  t.alike(registry.resolve({ limit: '' }), open, "'' means no limit")
  t.alike(registry.resolve({ limit: null }), open)

  const none = registry.resolve({ limit: 'none' })
  t.alike(none, { backends: [], default: null, limitedBy: 'none' })

  const pear = registry.resolve({ limit: 'pear' })
  t.alike(pickIds(pear), ['pear'])
  t.is(pear.limitedBy, 'pear')
  t.alike(pickIds(registry.resolve({ limit: ' PEAR ' })), ['pear'], 'case and space are forgiven')

  // F9: with no host to ask about Freenet is available, so the broken case
  // is a host without the WebRTC adapter.
  t.is(registry.resolve({ limit: 'freenet' }).default, 'freenet', 'usable under its own limit')
  const freenet = registry.resolve({ limit: 'freenet', hostCaps: '' })
  t.alike(pickIds(freenet), ['freenet'], 'the backend is listed under its own limit')
  t.is(freenet.backends[0].state, 'broken')
  t.is(freenet.default, null, 'a broken backend is never the default')
  t.is(freenet.limitedBy, 'freenet')
  t.alike(pickIds(registry.resolve({ limit: 'loopback' })), [], 'a limit cannot add a backend')
  t.alike(pickIds(registry.resolve({ limit: 'bogus' })), [], 'an unknown id selects nothing')
})

test('registry: create() makes an unstarted backend, or raises E_BACKEND_UNSUPPORTED naming it', (t) => {
  const backend = registry.create('pear')
  t.ok(backend instanceof PearBackend)
  t.is(backend.health().started, false, 'create() does not start it')

  for (const [id, ctx] of [
    ['freenet', { hostCaps: '' }],
    ['loopback', {}],
    ['pear', { limit: 'none' }]
  ]) {
    try {
      registry.create(id, ctx)
      t.fail(`create('${id}') should throw`)
    } catch (err) {
      t.is(err.code, 'E_BACKEND_UNSUPPORTED', `${id}: unsupported`)
      t.ok(err.message.includes(`'${id}'`), `${id}: the message names the backend`)
      t.is(err.details.backend, id)
    }
  }
})

test('registry: a load error is broken with a detail; a missing dependency is absent', (t) => {
  const asFreenet = (fixture) => {
    // Since B8 the real stub is loaded and cached, and Node then resolves
    // './freenet' from its per-directory cache without asking
    // _resolveFilename (S-12). Forget it first; the next plain require loads
    // it again.
    delete require.cache[path.join(ROOT, 'engine', 'backends', 'freenet', 'index.js')]
    const original = Module._resolveFilename
    Module._resolveFilename = function (request, parent, ...rest) {
      if (request === './freenet' && parent && /backends[\\/]index\.js$/.test(parent.filename)) {
        return path.join(FIXTURES, fixture)
      }
      return original.call(this, request, parent, ...rest)
    }
    return () => {
      Module._resolveFilename = original
      // Node remembers "./freenet from this directory" for as long as the
      // module it resolved to stays cached, without asking _resolveFilename
      // again. Dropping the fixture forgets it, for this file and every other.
      delete require.cache[path.join(FIXTURES, fixture)]
    }
  }

  let restore = asFreenet('broken.js')
  try {
    const entry = registry.available().find((item) => item.id === 'freenet')
    t.is(entry.state, 'broken', 'a backend that throws while loading is listed as broken')
    t.is(entry.detail, 'fixture backend failed to load')
    t.is(registry.resolve({}).default, 'pear', 'a broken backend is never the default')
    t.is(registry.resolve({ limit: 'freenet' }).default, null)
    try {
      registry.create('freenet')
      t.fail('a broken backend cannot be created')
    } catch (err) {
      t.is(err.code, 'E_BACKEND_UNSUPPORTED')
      t.ok(err.message.includes('fixture backend failed to load'), 'the error says why')
    }
  } finally {
    restore()
  }

  restore = asFreenet('probe-only.js')
  try {
    const entry = registry.available().find((item) => item.id === 'freenet')
    t.is(entry.state, 'broken', 'a backend may declare itself unusable')
    t.is(entry.detail, 'probe only')
    t.is(entry.label, 'Fixture (probe only)')
  } finally {
    restore()
  }

  restore = asFreenet('missing-dependency.js')
  try {
    t.alike(
      registry.available().map((item) => item.id),
      ['pear'],
      'MODULE_NOT_FOUND from a dependency means absent'
    )
  } finally {
    restore()
  }
})

test('invite: a non-Pear invite decodes without a topic; a Pear one still needs it', (t) => {
  const uri = invite.encodeLink({
    v: 2,
    b: 'freenet',
    linkId: 'link-1',
    peer: HOST_KEY,
    route: { contract: 'abc' },
    claim: null
  })
  const raw = rawPayload(uri)
  t.alike(
    Object.keys(raw),
    ['v', 'b', 'linkId', 'peer', 'route', 'claim'],
    'v2 shape, no v1 fields'
  )
  const decoded = invite.decodeLink(uri)
  t.is(decoded.b, 'freenet')
  t.is(decoded.peer, HOST_KEY)
  t.is(decoded.hostDhtKey, HOST_KEY, 'the pin is still mandatory and present')
  t.alike(decoded.route, { contract: 'abc' }, 'the route is opaque and untouched')
  t.is(decoded.topic, undefined)

  const pearNeutral = invite.encodeLink({
    v: 2,
    b: 'pear',
    linkId: 'link-1',
    peer: HOST_KEY,
    route: { topic: 'cd'.repeat(32) },
    claim: null
  })
  const pearV1 = invite.encodeLink({
    v: 2,
    linkId: 'link-1',
    topic: 'cd'.repeat(32),
    hostDhtKey: HOST_KEY,
    claim: null
  })
  t.is(pearNeutral, pearV1, 'a Pear link built from neutral fields is the v1 invite, byte for byte')

  t.exception.all(
    () => invite.decodeLink(encodeRaw({ v: 2, b: 'pear', linkId: 'x', peer: HOST_KEY, route: {} })),
    /Invalid ZBTerm invite/,
    'a Pear invite without a topic is still invalid'
  )
  t.exception.all(
    () => invite.decodeLink(encodeRaw({ v: 2, b: 'freenet', linkId: 'x', route: {} })),
    /Invalid ZBTerm invite/,
    'no backend may omit the host key'
  )
})

test('share manager: holds no backend until the first createLink, then reports it active', async (t) => {
  const device = await loadOrCreateLocalDevice({ root: await temp(t) })
  const hub = new LoopbackHub()
  const made = []
  const manager = new ShareManager(hostEngine(device), {
    registry: fakeRegistry({ alpha: () => track(made, new Named('alpha', { hub })) })
  })
  t.teardown(() => manager.close())

  t.is(manager._backend, null, 'construction activates nothing')
  t.is(made.length, 0)
  t.is(manager.backendsInfo().active, null)
  t.is(manager.diagnostics().backend, null, 'diagnostics do not activate one either')
  t.is(manager.diagnostics().hostSwarm, null, 'and keep their top-level keys')
  t.is(made.length, 0)

  const link = await manager.createLink('session-a', { type: 'group' })
  t.is(made.length, 1, 'the first createLink creates the default backend')
  t.is(made[0].health().started, true, 'and starts it')
  t.is(manager.backendsInfo().active, 'alpha')
  t.is(manager.diagnostics().backend.id, 'alpha')
  t.is(manager.diagnostics().backend.announced, 1, 'the backend report is the backend diagnostics')
  t.is(invite.decodeLink(link.uri).b, 'alpha', "the invite carries the backend's id")

  await manager.createLink('session-a', { type: 'group', backend: 'alpha' })
  t.is(made.length, 1, 'naming the active backend reuses it')
})

test('share manager: a second backend is refused while busy, swapped in when idle', async (t) => {
  const device = await loadOrCreateLocalDevice({ root: await temp(t) })
  const hub = new LoopbackHub()
  const made = []
  const fake = fakeRegistry({
    alpha: () => track(made, new Named('alpha', { hub })),
    beta: () => track(made, new Named('beta', { hub }))
  })

  const busy = new ShareManager(hostEngine(device), { registry: fake })
  t.teardown(() => busy.close())
  await busy.createLink('session-a', { type: 'group' })
  const refused = await outcome(busy.createLink('session-a', { type: 'group', backend: 'beta' }))
  t.is(refused.code, 'E_BACKEND_UNAVAILABLE', 'a share exists: no swap')
  t.ok(/restart/i.test(refused.message), 'the message carries the restart hint')
  t.is(busy.backendsInfo().active, 'alpha', 'the active backend is untouched')
  const betaInvite = encodeRaw({ v: 2, b: 'beta', linkId: 'l', peer: HOST_KEY, route: { r: 1 } })
  t.is((await outcome(busy.join(betaInvite))).code, 'E_BACKEND_UNAVAILABLE', 'joins obey it too')
  t.is(busy.joins.size, 0, 'a refused join leaves no join state')
  const gamma = await outcome(busy.createLink('session-a', { backend: 'gamma' }))
  t.is(gamma.code, 'E_BACKEND_UNSUPPORTED', 'an unknown backend is unsupported even while busy')
  t.ok(gamma.message.includes("'gamma'"))

  made.length = 0
  const idle = new ShareManager(hostEngine(device), { registry: fake })
  t.teardown(() => idle.close())
  const first = await idle._ensureBackend('alpha')
  t.is(first.health().started, true)
  const second = await idle._ensureBackend('beta')
  t.is(first.health().started, false, 'with nothing shared or joined, the old backend is stopped')
  t.is(second.health().started, true, 'and the new one started')
  t.is(idle.backendsInfo().active, 'beta')
  t.is(first.listenerCount('connection'), 0, 'the old backend is fully detached')
  const link = await idle.createLink('session-a', { type: 'group', backend: 'beta' })
  t.is(invite.decodeLink(link.uri).b, 'beta')
})

test('share manager: an invite for a backend this build lacks raises E_BACKEND_UNSUPPORTED', async (t) => {
  const manager = new ShareManager({ sessions: new Map() })
  t.teardown(() => manager.close())
  const uri = invite.encodeLink({
    v: 2,
    b: 'freenet',
    linkId: 'link-1',
    peer: HOST_KEY,
    route: { contract: 'abc' }
  })
  const err = await outcome(manager.join(uri))
  t.is(err.code, 'E_BACKEND_UNSUPPORTED', 'not E_AUTH: the invite is valid, the backend is missing')
  t.ok(err.message.includes("'freenet'"), 'the error names the backend')
  t.is(manager._backend, null, 'nothing was activated')
  t.is(manager.joins.size, 0)
})

test('share manager: an injected backend bypasses the registry and the limit', async (t) => {
  const device = await loadOrCreateLocalDevice({ root: await temp(t) })
  const injected = new LoopbackBackend({ hub: new LoopbackHub() })
  const manager = new ShareManager(hostEngine(device), { backend: injected, limit: 'none' })
  t.teardown(() => manager.close())
  t.is(manager.backend, injected)
  t.is(injected.health().started, true, 'an injected backend is active from construction')
  const info = manager.backendsInfo()
  t.alike(
    info.backends.map((entry) => entry.id),
    ['loopback']
  )
  t.is(info.default, 'loopback')
  t.is(info.active, 'loopback')
  const link = await manager.createLink('session-a', { type: 'group' })
  t.is(typeof link.topic, 'string', 'the loopback keeps its topic-spelled route by default')
})

test('share manager: an opaque route is stored whole and joins through a v2 invite', async (t) => {
  const { statusA, statusB, hostManager } = await joinTwoSessions(t, () => {
    const hub = new LoopbackHub()
    const made = []
    const create = () => track(made, new LoopbackBackend({ hub, routeKey: 'loop' }))
    return Promise.resolve({
      host: create(),
      viewer: create(),
      create,
      teardown: async () => {
        for (const backend of made) await backend.stop()
      }
    })
  })
  t.is(statusA.status, 'joined')
  t.is(statusB.status, 'joined')
  const links = Array.from(hostManager.hostShares.get('session-a').links.values())
  t.is(links.length, 1)
  t.absent('topic' in links[0], 'no topic is invented for a route that has none')
  t.ok(/^[0-9a-f]{64}$/.test(links[0].route.loop), 'the route is stored as the backend minted it')
  t.is(hostManager.diagnostics().hostShares[0].links[0].linkId, links[0].linkId)
})

test('acceptance: with the limit none, share.backends is empty and createLink is unsupported', async (t) => {
  const engine = new SessionEngine({
    userData: await temp(t),
    ptyHost: new EventEmitter(),
    backendLimit: resolveBackendLimit({ env: { ZBTERM_BACKEND: 'none' } }).value
  })
  t.teardown(() => engine.close())
  await engine.ready()

  t.alike(await engine.invoke('share.backends'), {
    backends: [],
    default: null,
    active: null,
    limitedBy: 'none'
  })
  const err = await outcome(engine.invoke('share.createLink', { sessionId: 'any' }))
  t.is(err.code, 'E_BACKEND_UNSUPPORTED')
  const pearUri = invite.encodeLink({
    v: 2,
    linkId: 'link-1',
    topic: 'cd'.repeat(32),
    hostDhtKey: HOST_KEY
  })
  const joinErr = await outcome(engine.invoke('share.join', { uri: pearUri }))
  t.is(joinErr.code, 'E_BACKEND_UNSUPPORTED', 'a Pear invite is refused too')
  t.ok(joinErr.message.includes("'pear'"), 'naming the backend the invite asked for')
  t.is(engine.share.backend, null, 'the local-only core holds no backend')
  t.is((await engine.invoke('share.diagnostics')).backend, null)
})

test('acceptance: with no limit, share.backends offers Pear and nothing is active yet', async (t) => {
  const engine = new SessionEngine({ userData: await temp(t), ptyHost: new EventEmitter() })
  t.teardown(() => engine.close())
  await engine.ready()
  const info = await engine.invoke('share.backends')
  t.alike(pickIds(info), ['pear', 'freenet'])
  t.is(info.default, 'pear')
  t.is(info.active, null, 'lazy: asking what exists activates nothing')
  t.is(info.limitedBy, null)
  t.is(engine.share._backend, null)
})

test('acceptance: share.backends lists freenet as broken / host has no WebRTC adapter, or with one / no Freenet node at the address, and it cannot be shared over', async (t) => {
  const engine = new SessionEngine({ userData: await temp(t), ptyHost: new EventEmitter() })
  t.teardown(() => engine.close())
  await engine.ready()
  const info = await engine.invoke('share.backends')
  const freenet = info.backends.find((entry) => entry.id === 'freenet')
  t.is(info.backends.find((entry) => entry.id === 'pear').state, 'available', 'next to Pear')
  t.is(freenet.state, 'broken')
  t.is(freenet.detail, 'host has no WebRTC adapter', 'a core with no rtcHost says so')
  t.is(info.default, 'pear', 'it is never the default')

  const err = await outcome(
    engine.invoke('share.createLink', { sessionId: 'any', backend: 'freenet' })
  )
  t.is(err.code, 'E_BACKEND_UNSUPPORTED', 'a listed-but-broken backend is unsupported (B6)')
  t.ok(err.message.includes("'freenet'"), 'the error names the backend')
  t.ok(err.message.includes('host has no WebRTC adapter'), 'and says why')
  t.is(engine.share._backend, null, 'nothing was activated')
  t.is(engine.share.hostShares.size, 0, 'and no half-made share is left behind')

  // F9 (A-11): with the adapter, share.backends probes the node address. A
  // closed port stands for "no node"; a live one is covered in
  // test/backends/freenet-backend.test.js against a local-mode node.
  const port = await freePort()
  const adapted = new SessionEngine({
    userData: await temp(t),
    ptyHost: new EventEmitter(),
    rtcHost: new EventEmitter(),
    backendOptions: { nodeUrl: `ws://127.0.0.1:${port}/v1/contract/command` }
  })
  t.teardown(() => adapted.close())
  await adapted.ready()
  const probed = await adapted.invoke('share.backends')
  const withRtc = probed.backends.find((entry) => entry.id === 'freenet')
  t.is(withRtc.state, 'broken', 'with an rtcHost and no node: broken')
  t.is(
    withRtc.detail,
    `no Freenet node at ws://127.0.0.1:${port} — see README "Freenet"`,
    'the detail names the address it tried'
  )
  t.is(probed.default, 'pear', 'and it is not the default')
  t.is(adapted.share._backend, null, 'probing activated nothing')

  const limited = new SessionEngine({
    userData: await temp(t),
    ptyHost: new EventEmitter(),
    backendLimit: 'freenet'
  })
  t.teardown(() => limited.close())
  await limited.ready()
  const only = await limited.invoke('share.backends')
  t.alike(pickIds(only), ['freenet'])
  t.is(only.default, null, 'limited to the stub, the core is local-only')
  const limitedErr = await outcome(limited.invoke('share.createLink', { sessionId: 'any' }))
  t.is(limitedErr.code, 'E_BACKEND_UNSUPPORTED')
})

test('share manager: createLink strips SEND_INPUT on a backend without EPHEMERAL_DELIVERY', async (t) => {
  // Same backend, same id: only the capability differs.
  class StoredDelivery extends LoopbackBackend {
    describe() {
      const descriptor = super.describe()
      return { ...descriptor, capabilities: descriptor.capabilities & ~CAP.EPHEMERAL_DELIVERY }
    }
  }
  const device = await loadOrCreateLocalDevice({ root: await temp(t) })
  const make = (Backend) => {
    const manager = new ShareManager(hostEngine(device), {
      backend: new Backend({ hub: new LoopbackHub() })
    })
    t.teardown(() => manager.close())
    return manager
  }

  const plain = make(LoopbackBackend)
  t.is(plain.backendsInfo().backends[0].id, make(StoredDelivery).backendsInfo().backends[0].id)
  const kept = await plain.createLink('session-a', { type: 'group' })
  t.ok(
    hasCap(kept.caps, SEND_INPUT),
    'with ephemeral delivery a link carries SEND_INPUT by default'
  )

  const manager = make(StoredDelivery)
  const byDefault = await manager.createLink('session-a', { type: 'group' })
  t.absent(hasCap(byDefault.caps, SEND_INPUT), 'without it the default link has no SEND_INPUT')
  t.is(byDefault.caps, kept.caps & ~SEND_INPUT, 'and every other cap is untouched')
  const asked = await manager.createLink('session-a', { type: 'group', sendInput: true })
  t.absent(hasCap(asked.caps, SEND_INPUT), 'asking for input does not bring it back')
  const explicit = await manager.createLink('session-a', { type: 'group', caps: FULL_CAPS })
  t.is(explicit.caps, FULL_CAPS & ~SEND_INPUT, 'nor does an explicit caps bitset')
  const stored = Array.from(manager.hostShares.get('session-a').links.values())
  t.ok(
    stored.every((link) => !hasCap(link.caps, SEND_INPUT)),
    'the stored link records carry the stripped caps'
  )
})

test('host: the flag wins over ZBTERM_BACKEND, and an empty value means no limit', (t) => {
  t.alike(resolveBackendLimit({}), { value: '', source: null, known: true })
  t.alike(resolveBackendLimit({ env: {} }), { value: '', source: null, known: true })
  t.alike(resolveBackendLimit({ env: { ZBTERM_BACKEND: 'freenet' } }), {
    value: 'freenet',
    source: 'env',
    known: true
  })
  t.alike(resolveBackendLimit({ flag: 'none', env: { ZBTERM_BACKEND: 'pear' } }), {
    value: 'none',
    source: 'flag',
    known: true
  })
  t.alike(resolveBackendLimit({ flag: ' Pear ' }), { value: 'pear', source: 'flag', known: true })
  t.is(resolveBackendLimit({ flag: 'paer' }).known, false, 'a typo is flagged, and still limits')
  t.is(resolveBackendLimit({ flag: 'paer' }).value, 'paer')
})

test('host: the limit reaches the worker as the 4th spawn argument', (t) => {
  const spawned = []
  const stub = {
    _spawnArgs: null,
    _workerEntrypoint: '/worker.js'
  }
  // engine/client.js spawns through the one helper (nonpear-no-updater U-2).
  const spawner = require('../../engine/spawn-worker')
  const originalSpawn = spawner.spawnWorker
  spawner.spawnWorker = (entry, args) => {
    spawned.push(args)
    throw new Error('stop after recording the spawn arguments')
  }
  t.teardown(() => {
    spawner.spawnWorker = originalSpawn
  })
  for (const backend of ['none', undefined]) {
    stub._spawnArgs = { userData: '/data', profileId: null, profilePath: '/p', backend }
    try {
      EngineClient.prototype._spawnWorker.call(stub)
    } catch {}
  }
  // F4: a 5th argument, hostCaps, follows; '' here (no rtcHost).
  t.alike(spawned[0], ['/data', '', '/p', 'none', ''])
  t.alike(
    spawned[1],
    ['/data', '', '/p', '', ''],
    "no limit is spelled '' so argv order never shifts"
  )

  const worker = read('engine/worker.js')
  t.ok(/const backendLimit = Bare\.argv\[5\] \|\| ''/.test(worker), 'the worker reads Bare.argv[5]')
  t.ok(/\n {2}backendLimit,\n/.test(worker), 'and hands it to SessionEngine')
  const main = read('electron/main.js')
  t.ok(main.includes("'--backend <pear|freenet|none>'"), 'the flag is a CLI option')
  t.ok(
    main.includes('resolveBackendLimit({ flag: cmd.flags.backend, env: process.env })'),
    'main.js resolves the flag, then the env var'
  )
  t.ok(main.includes('backendLimit: backendLimit.value'), 'and passes it to the engine lifecycle')
  t.ok(
    read('electron/engine-lifecycle.js').includes('backend: this.backendLimit'),
    'which passes it to the engine client'
  )
})

test('host: --ice-servers wins over ZBTERM_ICE_SERVERS, a non-empty setting over both, and empty means no STUN (D-11)', (t) => {
  t.alike(iceServersFlag(['--storage', 'x']), { value: undefined, strip: ['--storage', 'x'] })
  t.alike(
    iceServersFlag(['--ice-servers', '', '--debug']),
    { value: '', strip: ['--debug'] },
    "--ice-servers '' is read here and kept from paparam, which refuses it"
  )
  t.is(iceServersFlag(['--ice-servers=']).value, '')
  t.is(iceServersFlag(['--ice-servers=stun:a.test:1']).value, 'stun:a.test:1')

  const env = { ZBTERM_ICE_SERVERS: 'stun:env.test:3478' }
  t.alike(resolveIceServers({}), { servers: DEFAULT_ICE_SERVERS, source: 'default' })
  t.alike(DEFAULT_ICE_SERVERS, ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'])
  t.alike(resolveIceServers({ env }), { servers: ['stun:env.test:3478'], source: 'env' })
  t.alike(
    resolveIceServers({ flag: ' stun:a.test:1 , turn:u:s@t.test:3478 ', env }),
    { servers: ['stun:a.test:1', 'turn:u:s@t.test:3478'], source: 'flag' },
    'the flag wins, comma-separated and trimmed'
  )
  t.alike(resolveIceServers({ flag: '', env }), { servers: [], source: 'flag' }, "'' disables")
  t.alike(resolveIceServers({ env: { ZBTERM_ICE_SERVERS: '' } }).servers, [], 'in env too')
  t.alike(
    resolveIceServers({ setting: 'stun:set.test:9', flag: '', env }),
    { servers: ['stun:set.test:9'], source: 'setting' },
    'a non-empty setting wins over both'
  )
  t.is(resolveIceServers({ setting: '  ', flag: '', env }).source, 'flag', 'an empty one does not')
})

test("freenet: --ice-servers '' yields host candidates only in diagnostics().ice, and RELAY needs a turn: URL (D-11)", (t) => {
  const FreenetBackend = registry.KNOWN.freenet()
  const hostDefault = new FreenetBackend()
  t.alike(
    hostDefault.diagnostics().ice,
    { servers: null, hostCandidatesOnly: false, relay: false },
    "untold, the host half's own list applies"
  )
  const none = new FreenetBackend({
    iceServers: resolveIceServers({ flag: iceServersFlag(['--ice-servers', '']).value, env: {} })
      .servers
  })
  t.alike(none.diagnostics().ice, { servers: [], hostCandidatesOnly: true, relay: false })
  t.absent(none.describe().capabilities & CAP.RELAY)

  none.setIceServers(['stun:a.test:1', 'turn:user:secret@turn.test:3478'])
  const ice = none.diagnostics().ice
  t.alike(ice.servers, ['stun:a.test:1', 'turn:turn.test:3478'], 'listed without credentials')
  t.absent(JSON.stringify(none.diagnostics()).includes('secret'), 'no credential anywhere')
  t.is(ice.relay, true)
  t.ok(none.describe().capabilities & CAP.RELAY, 'RELAY with a turn: URL')

  // ShareManager hands the host's list to the backend it creates and to the
  // active one.
  const created = []
  const fake = {
    resolve: () => ({
      backends: [{ id: 'freenet', state: 'available', detail: null }],
      default: 'freenet',
      limitedBy: null
    }),
    create: (id, ctx) => {
      created.push(ctx.options)
      const backend = new FreenetBackend(ctx.options)
      backend.start = () => Promise.resolve()
      return backend
    }
  }
  const manager = new ShareManager(null, { registry: fake, hostCaps: 'rtc' })
  t.teardown(() => manager.close())
  t.alike(manager.setIceServers([]), { iceServers: [] })
  const backend = manager.backend
  t.alike(created[0].iceServers, [], 'the list reaches the constructor')
  manager.setIceServers(['stun:b.test:2'])
  t.alike(backend.diagnostics().ice.servers, ['stun:b.test:2'], 'and the active backend')
  manager.setIceServers(null)
  t.is(backend.diagnostics().ice.servers, null, 'null hands the choice back to the host half')
})

test('share manager: a dial the backend rejects with a code fails the join at once, with its detail (F9)', async (t) => {
  const device = await loadOrCreateLocalDevice({ root: await temp(t) })
  const hub = new LoopbackHub()
  const host = new ShareManager(hostEngine(device), {
    backend: new LoopbackBackend({ hub, routeKey: 'loop' })
  })
  t.teardown(() => host.close())
  const link = await host.createLink('session-a', { type: 'group' })

  class Failing extends LoopbackBackend {
    dial() {
      const connected = Promise.reject(
        new EngineError(CODES.E_HOST_UNREACHABLE, 'The Freenet peer connection failed', {
          backend: 'freenet',
          detail: 'ice-failed'
        })
      )
      connected.catch(() => {})
      return { connected, cancel() {} }
    }
  }
  const viewer = new ShareManager(
    { sessions: new Map(), localDevice: device },
    { backend: new Failing({ hub, routeKey: 'loop' }) }
  )
  t.teardown(() => viewer.close())
  const changes = []
  viewer.on('join:changed', (status) => changes.push(status))
  const started = Date.now()
  await viewer.join(link.uri)
  for (let i = 0; i < 100 && !changes.some((c) => c.status === 'failed'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const failed = changes.find((c) => c.status === 'failed')
  t.ok(failed, 'the join failed')
  t.ok(Date.now() - started < 5000, 'at once, not at the join timeout')
  t.alike(
    [failed.code, failed.detail, failed.backend],
    ['E_HOST_UNREACHABLE', 'ice-failed', 'freenet'],
    'with the code, detail and backend the renderer turns into a toast'
  )
  t.is(viewer.joins.size, 0, 'and no join state is left')
})

class Named extends LoopbackBackend {
  constructor(id, opts) {
    super(opts)
    this._id = id
  }

  describe() {
    return { ...super.describe(), id: this._id, label: `Fixture ${this._id}` }
  }
}

// A registry with the real one's surface, over backends a test supplies.
function fakeRegistry(factories) {
  const entries = Object.keys(factories).map((id) => ({
    id,
    label: id,
    capabilities: 0,
    state: 'available',
    detail: null
  }))
  return {
    resolve: () => ({ backends: entries, default: entries[0].id, limitedBy: null }),
    create: (id) => factories[id]()
  }
}

function hostEngine(device) {
  const stored = new Map()
  return {
    localDevice: device,
    selfIdentityClaim: null,
    sessions: new Map([
      [
        'session-a',
        {
          store: {
            timeline: [],
            meta: {
              put: (key, value) => Promise.resolve(stored.set(key, value)),
              createReadStream: ({ gt, lt }) =>
                [...stored.entries()]
                  .filter(([key]) => key > gt && key < lt)
                  .map(([key, value]) => ({ key, value }))
            }
          }
        }
      ]
    ])
  }
}

function track(list, backend) {
  list.push(backend)
  return backend
}

function pickIds(info) {
  return info.backends.map((entry) => entry.id)
}

function outcomeSync(fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err
  }
}

function outcome(promise) {
  return promise.then(
    () => ({ code: null, message: 'resolved' }),
    (err) => err
  )
}

function rawPayload(uri) {
  return JSON.parse(b4a.toString(b4a.from(uri.slice(invite.LINK_PREFIX.length), 'base64url')))
}

function encodeRaw(payload) {
  return invite.LINK_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

async function temp(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-registry-'))
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  return dir
}
