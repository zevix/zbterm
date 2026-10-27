// The Freenet backend's client side (F3 of docs/projects/260924_freenet-backend/;
// design §4, §5, §10) since K11 of zxterm-core (ZBTerm D-34): the contract
// client, BLAKE3 and the route live in the Rust `zxterm-core` sidecar
// (`zxterm_core::freenet::{node, route, contracts}`, tested in `zevix/zxterm`),
// and this file tests them through the backend, a proxy to that sidecar.
// Tests that need a node start their own `freenet local` on a free port
// (test/helpers/freenet-node.js) and skip when the binary is not on PATH
// (A-7). The owner's node on 7509 is never used.
const fs = require('fs')
const path = require('path')
const test = require('brittle')

const { testCore } = require('../helpers/zxterm-core')

const FreenetBackend = require('../../engine/backends/freenet')
const { CAP, assertBackend } = require('../../engine/backends/types')
const { transportKeyPair } = require('../../engine/crypto')
const { freenetAvailable, startLocalNode, freePort } = require('../helpers/freenet-node')

const hex = (bytes) => Buffer.from(bytes).toString('hex')

function outcome(promise) {
  return promise.then(
    () => ({ code: null, message: 'resolved' }),
    (err) => err
  )
}

// zxterm's contract pins (its contracts/hashes.json, X-16), found next to the
// sidecar package ZBTerm depends on (`zxterm-core-prebuilds`, a `file:`
// dependency on the zxterm tree); null when that tree is not there.
function zxtermPins() {
  try {
    const pkg = path.dirname(require.resolve('zxterm-core-prebuilds/package.json'))
    const file = path.join(fs.realpathSync(pkg), '..', '..', 'contracts', 'hashes.json')
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function started(t, url, keyPair = transportKeyPair()) {
  const backend = new FreenetBackend({ nodeUrl: url, core: testCore(t), iceServers: [] })
  t.teardown(() => backend.stop())
  await backend.start({ keyPair: () => keyPair })
  return { backend, keyPair }
}

// The BLAKE3 the route names: until K11 computed here (the vectors of
// engine/backends/freenet/blake3.js), now by the core, whose own BLAKE3 is
// the `blake3` crate and whose pins are checked by zxterm's
// tests/contract_pins.rs.
test('freenet: the routes the core mints name the pinned signalling contract (its BLAKE3)', async (t) => {
  if (!freenetAvailable()) {
    t.comment('SKIP:', 'freenet binary not on PATH')
    return
  }
  const pins = zxtermPins()
  if (!pins) {
    t.comment(
      'SKIP:',
      'the zxterm tree (contracts/hashes.json) is not next to zxterm-core-prebuilds'
    )
    return
  }
  const node = await startLocalNode()
  t.teardown(() => node.stop())
  const { backend } = await started(t, node.url)
  const route = await backend.routeFor('link-code', null)
  t.is(route.code, pins['signalling-v1'].blake3, 'code is BLAKE3(signalling-v1.wasm), as pinned')
  t.is(route.code.length, 64, 'a 32-byte hash, hex')
})

test('freenet: the backend has the ShareBackend shape and the capabilities of F3', async (t) => {
  const backend = assertBackend(new FreenetBackend())
  t.pass('assertBackend(new FreenetBackend()) passes')
  const descriptor = backend.describe()
  t.is(descriptor.id, 'freenet')
  t.is(descriptor.interfaceVersion, 1)
  for (const flag of ['BROKERED', 'NAT_TRAVERSAL', 'EPHEMERAL_DELIVERY', 'AUTHENTICATED_PEER']) {
    t.ok(descriptor.capabilities & CAP[flag], `declares ${flag}`)
  }
  for (const flag of [
    'HISTORY_OFFLINE_HOST',
    'HISTORY_EVENTUAL_MERGE',
    'RELAY',
    'DIRECT_DIAL',
    'PATH_MIGRATION'
  ]) {
    t.absent(descriptor.capabilities & CAP[flag], `does not declare ${flag}`)
  }
  // K11: the core has no TURN client (zxterm X-18), so a turn: URL is ignored.
  const withTurn = new FreenetBackend({
    iceServers: [{ urls: 'stun:stun.example.org' }, { urls: ['turn:turn.example.org:3478'] }]
  })
  t.absent(withTurn.describe().capabilities & CAP.RELAY, 'no RELAY, even with a turn: server')
  t.alike(
    withTurn.diagnostics().ice.servers,
    ['stun:stun.example.org', 'turn:turn.example.org:3478'],
    'the ICE URLs the core will get'
  )
  t.alike(FreenetBackend.availability(), { state: 'available', detail: null })
  t.is(backend.health().started, false)
  t.is(backend.localPeerKey(), null)
  await t.exception(backend.routeFor('link', null), /no transport key/, 'no route before a key')
})

test('freenet: start() with no node rejects E_BACKEND_UNAVAILABLE naming the address', async (t) => {
  const port = await freePort()
  const nodeUrl = `ws://127.0.0.1:${port}/v1/contract/command`
  const backend = new FreenetBackend({ nodeUrl, core: testCore(t) })
  const started = Date.now()
  const err = await outcome(backend.start({ keyPair: () => transportKeyPair() }))
  const elapsed = Date.now() - started
  t.is(err.code, 'E_BACKEND_UNAVAILABLE')
  t.is(err.details.backend, 'freenet')
  t.is(
    err.details.detail,
    `no Freenet node at ws://127.0.0.1:${port}`,
    'the address is in detail (the core names scheme, host and port)'
  )
  t.ok(elapsed < 6000, `rejected in ${elapsed} ms (< 6 s)`)
  t.is(backend.health().started, false)
  t.is(backend.health().detail, `no Freenet node at ws://127.0.0.1:${port}`, 'health() says why')
  await backend.stop()
  await backend.stop()
  t.pass('stop() is safe after a failed start, twice')
})

test('freenet: against a local node, start, route, health, diagnostics and stop', async (t) => {
  if (!freenetAvailable()) {
    t.comment('SKIP:', 'freenet binary not on PATH')
    return
  }
  const node = await startLocalNode()
  t.teardown(() => node.stop())
  t.not(node.port, 7509, `own node on port ${node.port} (pid ${node.pid})`)

  const keyPair = transportKeyPair()
  const backend = new FreenetBackend({ nodeUrl: node.url, core: testCore(t), iceServers: [] })
  const events = []
  backend.on('debug', (e) => events.push(e.event))
  t.teardown(() => backend.stop())

  await backend.start({ keyPair: () => keyPair })
  t.alike(backend.health(), { started: true, listening: false, detail: null }, 'health()')
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.ok(events.includes('node:open'), "a 'debug' event for the open socket, from the core")
  t.alike(backend.localPeerKey(), keyPair.publicKey, 'localPeerKey() is the transport key')

  const route = await backend.routeFor('link-a', null)
  t.alike(Object.keys(route).sort(), ['code', 'k', 'params', 'ptr', 'sig'], 'route shape')
  t.is(route.params.ttl_ms, 120000)
  t.is(route.params.host, hex(keyPair.publicKey), 'params.host is the transport key')
  t.is(Buffer.from(route.params.n, 'base64url').length, 32, 'n is 32 bytes, base64url')
  t.is(Buffer.from(route.k, 'base64url').length, 32, 'k is 32 bytes, base64url')
  t.ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(route.sig), 'sig is a base58 instance id')
  t.ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(route.ptr), 'and so is ptr, the pointer record (F6)')
  const other = await backend.routeFor('link-b', null)
  t.not(other.params.n, route.params.n, 'a different linkId gets a different n')
  t.not(other.sig, route.sig, 'and so a different instance')
  t.is(backend.routeFor('link-a', { route }), route, 'a stored route is returned as it is')

  const diagnostics = await backend.refreshDiagnostics()
  const text = JSON.stringify(diagnostics)
  t.alike(JSON.parse(text), diagnostics, 'diagnostics() is JSON-safe')
  t.is(diagnostics.backend, 'freenet')
  t.is(diagnostics.started, true)
  t.is(diagnostics.node.address, node.url)
  t.absent(text.includes(route.k) || text.includes(other.k), 'no route secret k')
  t.absent(/"k"\s*:/.test(text), 'and no k field')

  await backend.stop()
  t.is(backend.health().started, false, 'stopped')
  await backend.stop()
  t.pass('stop() twice')
})

// S-05 (b)/(c), worked around in the core's node client since K5/K10 (zxterm
// R-02..R-05): a local-mode node never answers a Get miss, so announcing a
// stored route this backend did not mint reads it under a short timeout
// first, then puts it; a second announce of the same route finds it.
test('freenet: node client workarounds (S-05) against a local node', async (t) => {
  if (!freenetAvailable()) {
    t.comment('SKIP:', 'freenet binary not on PATH')
    return
  }
  const node = await startLocalNode()
  t.teardown(() => node.stop())
  const keyPair = transportKeyPair()
  const minter = await started(t, node.url, keyPair)
  const route = await minter.backend.routeFor('link-s05', null)
  await minter.backend.stop()

  const first = await started(t, node.url, keyPair)
  let at = Date.now()
  await first.backend.announce('link-s05', { route })
  const missMs = Date.now() - at
  t.pass('a stored route nobody put yet is announced (the Get miss times out on its own)')
  t.ok(missMs < 10000, `in ${missMs} ms, well before the SDK's 30 s timeout`)
  await first.backend.stop()

  const second = await started(t, node.url, keyPair)
  at = Date.now()
  await second.backend.announce('link-s05', { route })
  const hitMs = Date.now() - at
  t.pass('announcing it again finds the instance the node holds (never Put twice)')
  t.comment(`announce of a stored route: miss ${missMs} ms, hit ${hitMs} ms`)
  t.is(second.backend.health().listening, true, 'and listens on it')
})
