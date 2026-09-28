// The invite `route` of a Freenet link (design §5): minted by the host,
// checked by the viewer before a byte reaches the node (§5.1).
//
//   route = { sig, code, params: { ttl_ms, host, n }, ptr, k }
//
// `sig` is the signalling instance id, blake3(code ‖ paramsBytes(params)) in
// base58; `code` the hex BLAKE3 of the raw signalling WASM; `ptr` the pointer
// record's instance id for `{ host, n }` (§5.2: one pointer per link, F6); `k`
// the payload key, which never reaches the node. `contracts` is ./contracts.js's shape: { current, known
// (codeHex -> wasm, signalling versions only), pointer: { code, wasm } }.
//
// Synchronous and offline: every id is computed here, nothing is fetched.
const crypto = require('crypto')
const bs58 = require('bs58').default || require('bs58')

const { EngineError, CODES } = require('../../errors')
const { blake3 } = require('./blake3')

// The lifetime of a signalling entry, in the route's contract parameters.
const ROUTE_TTL_MS = 120000

function hex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

function base64url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// blake3(codeHash ‖ params): the id a contract instance is addressed by.
function instanceId(codeHex, params) {
  const code = Buffer.from(codeHex, 'hex')
  const both = new Uint8Array(code.length + params.length)
  both.set(code, 0)
  both.set(params, code.length)
  return bs58.encode(blake3(both))
}

// The signalling contract's parameters as the bytes its instance id is
// hashed over and its entries are signed over. Key order is fixed: ttl_ms,
// host, n.
function paramsBytes(params) {
  const text = JSON.stringify({ ttl_ms: params.ttl_ms, host: params.host, n: params.n })
  return Buffer.from(text, 'utf8')
}

// The pointer contract's parameters. Since F6 a route's pointer is
// `{ host, n }`, one per link, with the link's own nonce: `{ host }` alone
// (F5) named one record per host key, which every link of the host would
// overwrite (highest `ver` wins). The pointer contract reads only `host`; `n`
// only makes the instance the link's. Without `n` this is F5's `{ host }`.
function pointerParamsBytes(hostHex, n) {
  const params = n === undefined ? { host: hostHex } : { host: hostHex, n }
  return Buffer.from(JSON.stringify(params), 'utf8')
}

// `linkId` is not part of the route: the 32-byte nonce `n` alone makes the
// instance unique and unguessable (design §5).
function mint(linkId, hostKey, contracts) {
  const params = {
    ttl_ms: ROUTE_TTL_MS,
    host: hex(hostKey),
    n: base64url(crypto.randomBytes(32))
  }
  return {
    sig: instanceId(contracts.current, paramsBytes(params)),
    code: contracts.current,
    params,
    ptr: instanceId(contracts.pointer.code, pointerParamsBytes(params.host, params.n)),
    k: base64url(crypto.randomBytes(32))
  }
}

function refuse(code, message, detail) {
  return new EngineError(code, message, { backend: 'freenet', detail })
}

const isHex64 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

// The checks of design §5.1, in order: the route is well-formed, it names
// the expected host, `sig` is the instance its `code` and `params` make, and
// `code` is a signalling contract this build ships (E_BACKEND_UNSUPPORTED
// otherwise: the caller may then read `ptr`, §5.2). Returns what a dial
// needs: { code, wasm, params } with `params` as bytes.
function verify(route, expectedPeerKey, contracts) {
  const params = route && route.params
  if (
    !route ||
    typeof route.sig !== 'string' ||
    !isHex64(route.code) ||
    !params ||
    !Number.isSafeInteger(params.ttl_ms) ||
    !isHex64(params.host) ||
    typeof params.n !== 'string' ||
    (route.ptr !== undefined && typeof route.ptr !== 'string')
  ) {
    throw refuse(CODES.E_CORRUPT, 'The Freenet route is malformed', 'malformed route')
  }
  if (params.host !== hex(expectedPeerKey)) {
    throw refuse(
      CODES.E_AUTH,
      'The Freenet route names a different host than the invite',
      'route host is not the expected peer'
    )
  }
  const bytes = paramsBytes(params)
  if (route.sig !== instanceId(route.code, bytes)) {
    throw refuse(
      CODES.E_CORRUPT,
      'The Freenet route does not match its contract code and parameters',
      'sig is not the instance of code and params'
    )
  }
  if (
    route.ptr !== undefined &&
    route.ptr !== instanceId(contracts.pointer.code, pointerParamsBytes(params.host, params.n))
  ) {
    throw refuse(
      CODES.E_CORRUPT,
      "The Freenet route's pointer record is not the link's",
      'ptr is not the pointer instance of the host and nonce'
    )
  }
  const wasm = contracts.known.get(route.code)
  if (!wasm) {
    throw refuse(
      CODES.E_BACKEND_UNSUPPORTED,
      'The Freenet route uses a signalling contract this build does not ship',
      'unknown contract code'
    )
  }
  return { code: route.code, wasm, params: bytes }
}

module.exports = {
  ROUTE_TTL_MS,
  instanceId,
  paramsBytes,
  pointerParamsBytes,
  mint,
  verify
}
