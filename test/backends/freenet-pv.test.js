// The route protocol version `pv` (K14 of zxterm-core, stage C2; ZBTerm
// D-38; zxterm `docs/projects/260928_zxterm-core/protocol.md` section 12).
// Every route the core mints for a link has `params.pv = 2`, and the core's
// verifier refuses one without it before it looks at anything else, so a
// pre-C2 invite never half-connects to a post-C2 host and a `pv: 2` invite
// is refused by pre-C2 code at its `sig` check without a change on that
// side. ZBTerm passes the route through and never reads `pv`.
//
// Both directions run here against real code:
//   - the pre-C2 side is `test/fixtures/route-v1/route.js`, ZBTerm's
//     `route.js` as it was before K11 (`bf5cdbd`), whose `mint` builds the
//     `pv`-less route by hand and whose `verify` is the check a pre-C2 viewer
//     ran;
//   - the post-C2 side is a real sidecar behind a ShareManager
//     (`share.join`), on a throwaway local node (never the owner's).
//
//   npx brittle-node test/backends/freenet-pv.test.js
const test = require('brittle')

const { testCore } = require('../helpers/zxterm-core')

const FreenetBackend = require('../../engine/backends/freenet')
const { freenetAvailable, startLocalNode } = require('../helpers/freenet-node')
const { loadOrCreateLocalDevice, transportKeyPair } = require('../../engine/crypto')
const { encodeLink } = require('../../engine/invite')
const { VERSION } = require('../../engine/schema')
const routeV1 = require('../fixtures/route-v1/route')
const { fixtures } = require('./conformance')

const JOIN_TIMEOUT_MS = 30 * 1000
const V1_MESSAGE = 'The Freenet route does not match its contract code and parameters'
const V1_DETAIL = 'sig is not the instance of code and params'

let node = null

async function nodeUrl() {
  if (!node) node = await startLocalNode()
  return node.url
}

async function startedBackend(t) {
  const core = testCore(t)
  const backend = new FreenetBackend({ nodeUrl: await nodeUrl(), core, iceServers: [] })
  t.teardown(() => backend.stop())
  return backend
}

// The contracts argument of the pinned `route.js`: only the code hashes are
// read for a refusal or a mint, never the WASM.
function contractsOf(route) {
  return {
    current: route.code,
    known: new Map([[route.code, Buffer.alloc(1)]]),
    pointer: { code: 'ab'.repeat(32) }
  }
}

function refusalOf(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  return null
}

if (!freenetAvailable()) {
  test('freenet pv: skipped', (t) => t.comment('SKIP:', 'freenet binary not on PATH'))
} else {
  test('freenet pv: a pv 2 route is refused by the pre-C2 verifier at its sig check', async (t) => {
    const keys = transportKeyPair()
    const backend = await startedBackend(t)
    await backend.start({ keyPair: () => keys })
    const route = await backend.routeFor('link-pv', null)
    t.is(route.params.pv, 2, 'the core mints pv 2')

    // The pinned encoder and hash are exactly the ones the core's `sig` is
    // made with: the v2 parameter bytes, `pv` last.
    const v2Bytes = Buffer.from(
      JSON.stringify({
        ttl_ms: route.params.ttl_ms,
        host: route.params.host,
        n: route.params.n,
        pv: 2
      })
    )
    t.is(
      routeV1.instanceId(route.code, v2Bytes),
      route.sig,
      "the pinned route.js reproduces the core's sig"
    )

    const contracts = contractsOf(route)
    const refused = refusalOf(() => routeV1.verify(route, keys.publicKey, contracts))
    t.ok(refused, 'the pre-C2 verifier refuses a pv 2 route')
    t.is(refused.code, 'E_CORRUPT', 'with E_CORRUPT')
    t.is(refused.message, V1_MESSAGE, "and route.js::verify's message")
    t.is(refused.details.detail, V1_DETAIL, 'naming the sig check')

    // The control: what the pinned route.js mints, it accepts.
    const minted = routeV1.mint('link-pv', keys.publicKey, contracts)
    t.absent('pv' in minted.params, 'a route the pinned mint builds has no pv')
    t.execution(
      () => routeV1.verify(minted, keys.publicKey, contracts),
      'and its own verify takes it'
    )
  })

  test('freenet pv: a pre-C2 route is refused by a post-C2 join, naming the upgrade', async (t) => {
    const hostKeys = transportKeyPair()
    const hostBackend = await startedBackend(t)
    await hostBackend.start({ keyPair: () => hostKeys })
    const real = await hostBackend.routeFor('link-pv', null)

    // A pv-less route built the way the pre-C2 mint builds it, for the host
    // that is really there.
    const v1 = routeV1.mint('link-pv', hostKeys.publicKey, contractsOf(real))
    t.absent('pv' in v1.params, 'the route has no pv')

    const viewerDevice = await loadOrCreateLocalDevice({ root: await fixtures.temp(t) })
    const debug = []
    const viewer = fixtures.recordingViewer(viewerDevice, await startedBackend(t))
    viewer.manager.on('debug', (event) => debug.push(event.event))
    t.teardown(() => viewer.close())

    const uri = encodeLink({
      v: VERSION,
      b: 'freenet',
      linkId: 'ab'.repeat(16),
      peer: Buffer.from(hostKeys.publicKey).toString('hex'),
      route: v1,
      claim: null
    })
    const started = Date.now()
    const failed = fixtures.waitForJoinChange(viewer.manager, 'ab'.repeat(16))
    await viewer.manager.join(uri)
    const status = await failed
    const elapsed = Date.now() - started
    t.comment(`refused after ${elapsed} ms`)
    t.is(status.status, 'failed', 'the join ends failed')
    t.is(status.code, 'E_BACKEND_UNSUPPORTED', 'with E_BACKEND_UNSUPPORTED')
    t.ok(
      /older Freenet session protocol/.test(status.message),
      `naming the protocol: ${status.message}`
    )
    t.ok(/upgrade/.test(status.message), 'and the upgrade')
    t.ok(elapsed < JOIN_TIMEOUT_MS, `within JOIN_TIMEOUT_MS (${JOIN_TIMEOUT_MS} ms)`)
    t.absent(debug.includes('viewer:join-request:sent'), 'no join request left the viewer')
    t.is(viewer.registered.length, 0, 'no remote session was registered')
    t.alike(viewer.errors, [], 'and nothing was raised as an error')
  })

  test('freenet pv: a route from a newer protocol is refused, naming the version', async (t) => {
    const hostKeys = transportKeyPair()
    const hostBackend = await startedBackend(t)
    await hostBackend.start({ keyPair: () => hostKeys })
    const real = await hostBackend.routeFor('link-pv', null)
    const newer = { ...real, params: { ...real.params, pv: 3 } }

    const viewerDevice = await loadOrCreateLocalDevice({ root: await fixtures.temp(t) })
    const viewer = fixtures.recordingViewer(viewerDevice, await startedBackend(t))
    t.teardown(() => viewer.close())
    const uri = encodeLink({
      v: VERSION,
      b: 'freenet',
      linkId: 'cd'.repeat(16),
      peer: Buffer.from(hostKeys.publicKey).toString('hex'),
      route: newer,
      claim: null
    })
    const failed = fixtures.waitForJoinChange(viewer.manager, 'cd'.repeat(16))
    await viewer.manager.join(uri)
    const status = await failed
    t.is(status.status, 'failed')
    t.is(status.code, 'E_BACKEND_UNSUPPORTED')
    t.ok(/newer Freenet session protocol \(version 3\)/.test(status.message), status.message)
  })

  // Last: the node this file started.
  test('freenet pv: teardown', async (t) => {
    if (node) await node.stop()
    t.pass(node ? `stopped the local node (pid ${node.pid})` : 'no node was started')
  })
}
