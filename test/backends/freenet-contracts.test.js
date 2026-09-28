// The Freenet contracts shipped as bytes, and the invite route built on them
// (F5 of docs/projects/260924_freenet-backend/; design §5, §5.1, §5.2, §7).
// The first test is the pin: contracts/hashes.json is what
// scripts/build-contracts.sh wrote, and every file it names must still hash
// to it. A rebuilt contract that moved is a new version (-v2), never an edit
// of these bytes.
//
// 2026-09-28 (Z3 of docs/projects/260928_zbterm-fork/, A-5): the Z3 rename
// rebuilt both contracts (DOMAIN and crate names moved to zbterm) and kept the
// file names signalling-v1.wasm/pointer-v1.wasm rather than shipping -v2 next
// to the old bytes, because no ZBTerm link was ever made under the old names —
// there is no key to keep (D-23). The assertions below are unchanged.
// The node-backed test starts its own `freenet local` on a
// free port (test/helpers/freenet-node.js) and skips when the binary is not
// on PATH (A-7).
const fs = require('fs')
const path = require('path')
const test = require('brittle')

const contracts = require('../../engine/backends/freenet/contracts')
const route = require('../../engine/backends/freenet/route')
const nodeClient = require('../../engine/backends/freenet/node-client')
const { blake3 } = require('../../engine/backends/freenet/blake3')
const { transportKeyPair } = require('../../engine/crypto')
const fixtures = require('../../scripts/contract-fixtures')
const { freenetAvailable, startLocalNode } = require('../helpers/freenet-node')

const CONTRACTS = path.join(__dirname, '..', '..', 'engine', 'backends', 'freenet', 'contracts')
const SHIPPED = ['signalling-v1', 'pointer-v1']

const hex = (bytes) => Buffer.from(bytes).toString('hex')

function outcome(fn) {
  try {
    fn()
    return { code: null, message: 'returned' }
  } catch (err) {
    return err
  }
}

test('freenet: every contract in hashes.json exists, hashes and sizes as recorded (the pin)', (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'hashes.json'), 'utf8'))
  t.alike(
    Object.keys(manifest).sort(),
    [...SHIPPED].sort(),
    'hashes.json names the shipped contracts'
  )
  for (const [name, entry] of Object.entries(manifest)) {
    const file = path.join(CONTRACTS, `${name}.wasm`)
    t.ok(fs.existsSync(file), `${name}.wasm exists`)
    const bytes = new Uint8Array(fs.readFileSync(file))
    t.is(bytes.length, entry.bytes, `${name}.wasm is ${entry.bytes} bytes`)
    t.is(hex(blake3(bytes)), entry.blake3, `${name}.wasm hashes to its recorded BLAKE3`)
    t.is(hex(bytes.subarray(0, 4)), '0061736d', `${name}.wasm is raw WASM, not an fdev package`)
  }
  const wasmFiles = fs.readdirSync(CONTRACTS).filter((file) => file.endsWith('.wasm'))
  t.alike(
    wasmFiles.sort(),
    Object.keys(manifest)
      .map((name) => `${name}.wasm`)
      .sort(),
    'no .wasm in contracts/ that hashes.json does not pin'
  )
  t.is(contracts.current, manifest['signalling-v1'].blake3, 'new links use signalling-v1')
  t.is(contracts.pointer.code, manifest['pointer-v1'].blake3, 'the pointer record is pointer-v1')
  t.ok(contracts.known.has(contracts.current), 'the current code is a known one')
  t.absent(contracts.known.has(contracts.pointer.code), 'the pointer code is not a signalling code')
})

test('freenet: route.mint and route.verify round trip', (t) => {
  const host = transportKeyPair()
  const r = route.mint('link-a', host.publicKey, contracts)
  t.alike(Object.keys(r).sort(), ['code', 'k', 'params', 'ptr', 'sig'], 'route shape')
  t.alike(Object.keys(r.params), ['ttl_ms', 'host', 'n'], 'params key order')
  t.is(r.params.ttl_ms, route.ROUTE_TTL_MS)
  t.is(r.params.host, hex(host.publicKey), 'params.host is the host key')
  t.is(r.code, contracts.current, 'code is the current signalling contract')
  t.is(Buffer.from(r.params.n, 'base64url').length, 32, 'n is 32 bytes')
  t.is(Buffer.from(r.k, 'base64url').length, 32, 'k is 32 bytes')

  const wasm = contracts.known.get(r.code)
  const params = route.paramsBytes(r.params)
  t.is(nodeClient.contractKey(wasm, params).id, r.sig, 'sig is the instance of the WASM and params')
  const ptrParams = route.pointerParamsBytes(r.params.host, r.params.n)
  t.is(
    nodeClient.contractKey(contracts.pointer.wasm, ptrParams).id,
    r.ptr,
    'ptr is the pointer instance for { host, n } (F6: one pointer per link)'
  )
  t.alike(
    JSON.parse(ptrParams.toString()),
    { host: r.params.host, n: r.params.n },
    'pointer params are { host, n }'
  )

  const checked = route.verify(r, host.publicKey, contracts)
  t.is(checked.code, r.code)
  t.is(checked.wasm, wasm, 'verify returns the shipped WASM for the code')
  t.alike(checked.params, params, 'and the parameter bytes')
  const { ptr, ...withoutPtr } = r
  t.ok(ptr)
  t.is(route.verify(withoutPtr, host.publicKey, contracts).code, r.code, 'ptr is optional')

  const other = route.mint('link-a', host.publicKey, contracts)
  t.not(other.sig, r.sig, 'a second mint is a new instance')
  t.not(other.ptr, r.ptr, 'with its own pointer (F6)')
})

test('freenet: route.verify rejects a changed sig, a foreign host, an unknown code', (t) => {
  const host = transportKeyPair()
  const stranger = transportKeyPair()
  const r = route.mint('link-a', host.publicKey, contracts)

  const changedSig = outcome(() => route.verify({ ...r, sig: r.ptr }, host.publicKey, contracts))
  t.is(changedSig.code, 'E_CORRUPT', 'a changed sig: E_CORRUPT')

  const wrongPeer = outcome(() => route.verify(r, stranger.publicKey, contracts))
  t.is(wrongPeer.code, 'E_AUTH', 'a route for another host than expected: E_AUTH')

  // A foreign host swapped into the route: the expected peer matches, the sig does not.
  const swapped = { ...r, params: { ...r.params, host: hex(stranger.publicKey) } }
  const foreignHost = outcome(() => route.verify(swapped, stranger.publicKey, contracts))
  t.is(foreignHost.code, 'E_CORRUPT', 'a foreign params.host under the old sig: E_CORRUPT')
  const foreignPtr = outcome(() =>
    route.verify(
      { ...r, ptr: route.mint('x', stranger.publicKey, contracts).ptr },
      host.publicKey,
      contracts
    )
  )
  t.is(foreignPtr.code, 'E_CORRUPT', "another host's ptr: E_CORRUPT")

  // An unknown code with a consistent sig: only the code check can refuse it.
  const code = 'ab'.repeat(32)
  const unknown = { ...r, code, sig: route.instanceId(code, route.paramsBytes(r.params)) }
  const unknownCode = outcome(() => route.verify(unknown, host.publicKey, contracts))
  t.is(unknownCode.code, 'E_BACKEND_UNSUPPORTED', 'an unknown code: E_BACKEND_UNSUPPORTED')
  t.is(unknownCode.details.detail, 'unknown contract code')
  const pointerAsCode = {
    ...r,
    code: contracts.pointer.code,
    sig: route.instanceId(contracts.pointer.code, route.paramsBytes(r.params))
  }
  t.is(
    outcome(() => route.verify(pointerAsCode, host.publicKey, contracts)).code,
    'E_BACKEND_UNSUPPORTED',
    'the pointer code is not a signalling code'
  )

  for (const bad of [null, {}, { ...r, code: 'xyz' }, { ...r, params: { ...r.params, n: 1 } }]) {
    t.is(outcome(() => route.verify(bad, host.publicKey, contracts)).code, 'E_CORRUPT', 'malformed')
  }
})

test('freenet: a local node runs the shipped contracts and refuses mis-signed state', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  const node = await startLocalNode()
  t.teardown(() => node.stop())
  const client = await nodeClient.connect(node.url)
  t.teardown(() => client.close())

  const host = fixtures.keyPair(1)
  const viewer = fixtures.keyPair(2)
  const wasm = contracts.known.get(contracts.current)
  const paramsFor = (n) =>
    route.paramsBytes({ ttl_ms: route.ROUTE_TTL_MS, host: host.hex, n: `f5-${n}-${Date.now()}` })

  const params = paramsFor('valid')
  const entries = []
  for (let s = 0; s < 16; s++) {
    entries.push(
      fixtures.signEntry(viewer.secretKey, params, {
        l: 'link',
        r: `v:${viewer.hex}`,
        s,
        t: 1000 + s,
        p: `offer-${s}`
      })
    )
  }
  entries.push(
    fixtures.signEntry(host.secretKey, params, {
      l: 'link',
      r: `h:${viewer.hex}`,
      s: 0,
      t: 1020,
      p: 'a'
    })
  )
  const state = Buffer.from(fixtures.wire(entries))
  const { key } = nodeClient.contractKey(wasm, params)
  await client.put(wasm, params, state)
  t.pass('a Put of 16 viewer entries and a host answer, all signed, is accepted')
  const got = await client.get(key)
  t.alike(Buffer.from(got.state), state, 'and stored byte for byte')

  // S-05(c)-like: the node answers a refused Put with nothing at all.
  const misParams = paramsFor('mis-signed')
  const forged = fixtures.signEntry(viewer.secretKey, misParams, {
    l: 'link',
    r: `v:${viewer.hex}`,
    s: 0,
    t: 1,
    p: 'x'
  })
  forged.p = 'tampered'
  const refused = await client
    .put(wasm, misParams, Buffer.from(fixtures.wire([forged])), { timeoutMs: 3000 })
    .then(
      () => 'accepted',
      (err) => err.message
    )
  t.ok(/no answer within 3000 ms/.test(refused), `a mis-signed entry is not accepted (${refused})`)
  const missing = await client
    .get(nodeClient.contractKey(wasm, misParams).key, { timeoutMs: 1000 })
    .then(
      () => 'found',
      (err) => err.message
    )
  t.ok(/no answer within 1000 ms/.test(missing), 'and the instance was not stored')

  const ptrParams = route.pointerParamsBytes(host.hex)
  const record = fixtures.signRecord(host.secretKey, ptrParams, {
    ver: 1,
    sig: 'instance',
    code: contracts.current,
    params: params.toString()
  })
  const ptrKey = nodeClient.contractKey(contracts.pointer.wasm, ptrParams).key
  await client.put(contracts.pointer.wasm, ptrParams, Buffer.from(JSON.stringify(record)))
  const ptrState = await client.get(ptrKey)
  t.alike(
    JSON.parse(Buffer.from(ptrState.state).toString()),
    record,
    'a signed pointer record is stored'
  )
})
