// The Freenet contract client (F3 of docs/projects/260924_freenet-backend/;
// design §4, §5, §10) under Node. Tests that need a node start their own
// `freenet local` on a free port (test/helpers/freenet-node.js) and skip when
// the binary is not on PATH (A-7). The owner's node on 7509 is never used.
const test = require('brittle')
const bs58 = require('bs58').default || require('bs58')

const FreenetBackend = require('../../engine/backends/freenet')
const nodeClient = require('../../engine/backends/freenet/node-client')
const contracts = require('../../engine/backends/freenet/contracts')
const { blake3 } = require('../../engine/backends/freenet/blake3')
const { CAP, assertBackend } = require('../../engine/backends/types')
const { transportKeyPair } = require('../../engine/crypto')
const { freenetAvailable, startLocalNode, freePort } = require('../helpers/freenet-node')

// The lengths spikes/freenet/lib/blake3-check.js cross-checked against
// @noble/hashes, over the BLAKE3 test-vector input (byte i is i % 251). The
// hashes were computed with @noble/hashes 1.8 (spikes/freenet/node_modules);
// 0, 1, 1023-1025, 2048, 2049, 3072, 4097, 8192 and 31744 are also in the
// official BLAKE3 test_vectors.json.
const BLAKE3_VECTORS = [
  [0, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'],
  [1, '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'],
  [63, 'e9bc37a594daad83be9470df7f7b3798297c3d834ce80ba85d6e207627b7db7b'],
  [64, '4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98'],
  [65, 'de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee'],
  [1023, '10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11'],
  [1024, '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7'],
  [1025, 'd00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444'],
  [2048, 'e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a'],
  [2049, '5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030'],
  [3072, 'b98cb0ff3623be03326b373de6b9095218513e64f1ee2edd2525c7ad1e5cffd2'],
  [4097, '9b4052b38f1c5fc8b1f9ff7ac7b27cd242487b3d890d15c96a1c25b8aa0fb995'],
  [8192, 'aae792484c8efe4f19e2ca7d371d8c467ffb10748d8a5a1ae579948f718a2a63'],
  [31744, '62b6960e1a44bcc1eb1a611a8d6235b6b4b78f32e7abc4fb4c6cdcce94895c47'],
  [181292, 'efbdcfe2fd70a96e89a64ec26bba7cbdb9c03870d7621d9310534715d8073f76'],
  [1000003, 'cd5a3272e01b1a2f47bb4565d8d202db0f95704d32550a2da61a0fd363d4c90d']
]

function vectorInput(length) {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = i % 251
  return bytes
}

const hex = (bytes) => Buffer.from(bytes).toString('hex')

// The route's contract parameters, encoded here independently of the backend:
// JSON with the keys in the order ttl_ms, host, n.
function routeParamsBytes(params) {
  return Buffer.from(
    JSON.stringify({ ttl_ms: params.ttl_ms, host: params.host, n: params.n }),
    'utf8'
  )
}

function outcome(promise) {
  return promise.then(
    () => ({ code: null, message: 'resolved' }),
    (err) => err
  )
}

test('freenet: blake3 matches the known vectors', (t) => {
  for (const [length, expected] of BLAKE3_VECTORS) {
    t.is(hex(blake3(vectorInput(length))), expected, `${length} bytes`)
  }
  t.is(
    hex(blake3(new TextEncoder().encode('abc'))),
    '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85',
    "'abc'"
  )
})

test('freenet: the backend has the ShareBackend shape and the capabilities of F3', (t) => {
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
  const withTurn = new FreenetBackend({
    iceServers: [{ urls: 'stun:stun.example.org' }, { urls: ['turn:turn.example.org:3478'] }]
  })
  t.ok(withTurn.describe().capabilities & CAP.RELAY, 'RELAY only when a turn: server is given')
  const stunOnly = new FreenetBackend({ iceServers: [{ urls: 'stun:stun.example.org' }] })
  t.absent(stunOnly.describe().capabilities & CAP.RELAY, 'a STUN server is not a relay')
  // F9: 'not yet wired' is gone; with no host to ask about, the module is usable.
  t.alike(FreenetBackend.availability(), { state: 'available', detail: null })
  t.is(backend.health().started, false)
  t.is(backend.localPeerKey(), null)
  t.exception(() => backend.routeFor('link', null), /no transport key/, 'no route before a key')
})

test('freenet: start() with no node rejects E_BACKEND_UNAVAILABLE naming the address', async (t) => {
  const port = await freePort()
  const nodeUrl = `ws://127.0.0.1:${port}/v1/contract/command`
  const backend = new FreenetBackend({ nodeUrl })
  const started = Date.now()
  const err = await outcome(backend.start({ keyPair: () => null }))
  const elapsed = Date.now() - started
  t.is(err.code, 'E_BACKEND_UNAVAILABLE')
  t.is(err.details.backend, 'freenet')
  t.is(err.details.detail, `no Freenet node at ${nodeUrl}`, 'the address is in detail')
  t.ok(elapsed < 6000, `rejected in ${elapsed} ms (< 6 s)`)
  t.is(backend.health().started, false)
  t.is(backend.health().detail, `no Freenet node at ${nodeUrl}`, 'health() says why')
  await backend.stop()
  await backend.stop()
  t.pass('stop() is safe after a failed start, twice')
})

test('freenet: against a local node, start, route, health, diagnostics and stop', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const node = await startLocalNode()
  t.teardown(() => node.stop())
  t.not(node.port, 7509, `own node on port ${node.port} (pid ${node.pid})`)

  const keyPair = transportKeyPair()
  const backend = new FreenetBackend({ nodeUrl: node.url })
  const events = []
  backend.on('debug', (e) => events.push(e.event))
  t.teardown(() => backend.stop())

  await backend.start({ keyPair: () => keyPair })
  t.alike(backend.health(), { started: true, listening: false, detail: null }, 'health()')
  t.ok(events.includes('node:open'), "a 'debug' event for the open socket")
  t.alike(backend.localPeerKey(), keyPair.publicKey, 'localPeerKey() is the transport key')

  const route = backend.routeFor('link-a', null)
  t.alike(Object.keys(route).sort(), ['code', 'k', 'params', 'ptr', 'sig'], 'route shape')
  t.alike(Object.keys(route.params), ['ttl_ms', 'host', 'n'])
  t.is(route.params.ttl_ms, 120000)
  t.is(route.params.host, hex(keyPair.publicKey), 'params.host is the transport key')
  t.is(route.code, contracts.current, 'code is the bundled contract')
  t.is(Buffer.from(route.params.n, 'base64url').length, 32, 'n is 32 bytes, base64url')
  t.is(Buffer.from(route.k, 'base64url').length, 32, 'k is 32 bytes, base64url')
  const expectedSig = bs58.encode(
    nodeClient.instanceId(Buffer.from(route.code, 'hex'), routeParamsBytes(route.params))
  )
  t.is(route.sig, expectedSig, 'sig === contractKey(code, params)')
  const wasm = contracts.known.get(route.code)
  t.is(
    nodeClient.contractKey(wasm, routeParamsBytes(route.params)).id,
    route.sig,
    'and the same from the WASM bytes'
  )
  t.is(
    route.ptr,
    nodeClient.contractKey(
      contracts.pointer.wasm,
      Buffer.from(JSON.stringify({ host: route.params.host, n: route.params.n }), 'utf8')
    ).id,
    'ptr is the pointer record instance for { host, n } (F6)'
  )
  const other = backend.routeFor('link-b', null)
  t.not(other.params.n, route.params.n, 'a different linkId gets a different n')
  t.not(other.sig, route.sig, 'and so a different instance')
  t.is(backend.routeFor('link-a', { route }), route, 'a stored route is returned as it is')

  const diagnostics = backend.diagnostics()
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

test('freenet: node client workarounds (S-05) against a local node', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const node = await startLocalNode()
  t.teardown(() => node.stop())
  const client = await nodeClient.connect(node.url)
  t.teardown(() => client.close())
  t.ok(client.openMs >= 0, `socket open in ${Math.round(client.openMs)} ms`)

  const wasm = contracts.known.get(contracts.current)
  const params = Buffer.from(JSON.stringify({ ttl_ms: 120000, n: `f3-${Date.now()}` }))
  const { key } = nodeClient.contractKey(wasm, params)
  await client.put(wasm, params, Buffer.from(JSON.stringify({ e: [] })))
  t.pass('put a fresh instance')
  const rtt = await client.rttMs(key)
  t.ok(rtt >= 0 && rtt < nodeClient.REQUEST_TIMEOUT_MS, `rttMs() of a Get: ${rtt.toFixed(2)} ms`)
  await client.subscribe(key)
  t.pass('subscribe() settles on the PutResponse ack (S-05 a)')

  const missing = nodeClient.contractKey(wasm, Buffer.from('{"n":"never-put"}')).key
  const started = Date.now()
  const err = await outcome(client.get(missing, { timeoutMs: 1000 }))
  t.ok(/no answer within 1000 ms/.test(err.message), 'a Get miss times out on its own (S-05 c)')
  t.ok(Date.now() - started < 3000, 'well before the SDK 30 s timeout')
  t.ok(nodeClient.REQUEST_TIMEOUT_MS <= 10000, 'no request waits more than 10 s')

  await client.close()
  await client.close()
  t.ok(client.closed, 'close() twice')
})
