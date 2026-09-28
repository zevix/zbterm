// The signalling entries of a Freenet link (design §6; F6 of
// docs/projects/260924_freenet-backend/): signing, verifying and the payload
// cipher. One serialiser for both ends and for the contract.
//
// The signed bytes are exactly what signalling-v1 checks (source of truth:
// contracts/src/signalling/src/lib.rs, module comment), binary and
// length-prefixed, over the instance's raw parameter bytes:
//
//   "zbterm/fnet-signal/1" ‖ lp(params) ‖ lp(l) ‖ lp(r) ‖ u32le(s) ‖ u64le(t) ‖ u8(d) ‖ lp(p)
//
// with lp(x) = u32le(len(x)) ‖ x. scripts/contract-fixtures.js::entryBytes is
// a second copy the contract's verify-merge corpus is signed with;
// test/backends/freenet-backend.test.js pins the two to each other.
//
// `p` is the payload sealed with crypto_secretbox under a key derived from the
// route's `k`, which never reaches the node: contract state is readable by
// every node that holds it, and SDP carries addresses (design §5). It is
// base64url(nonce ‖ box); the signature covers these bytes, so the contract
// checks it without `k`.
const sodium = require('sodium-native')

const { blake3 } = require('./blake3')

const SIGNAL_DOMAIN = 'zbterm/fnet-signal/1'
const POINTER_DOMAIN = 'zbterm/fnet-pointer/1'
const PAYLOAD_CONTEXT = 'zbterm/fnet-payload/1'

function lp(bytes) {
  const len = Buffer.alloc(4)
  len.writeUInt32LE(bytes.length)
  return Buffer.concat([len, bytes])
}

function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function u64(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

function utf8(text) {
  return Buffer.from(String(text), 'utf8')
}

function base64url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64url(text) {
  return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

const isHex = (value, length) =>
  typeof value === 'string' && value.length === length && /^[0-9a-f]*$/.test(value)

// The bytes `g` signs. `params` are the instance's parameter bytes.
function entryBytes(params, e) {
  return Buffer.concat([
    utf8(SIGNAL_DOMAIN),
    lp(Buffer.from(params)),
    lp(utf8(e.l)),
    lp(utf8(e.r)),
    u32(e.s),
    u64(e.t),
    Buffer.from([e.d ? 1 : 0]),
    lp(utf8(e.p))
  ])
}

function sign(secretKey, message) {
  const signature = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, message, Buffer.from(secretKey))
  return signature.toString('hex')
}

function verify(publicKey, message, g) {
  if (!isHex(g, sodium.crypto_sign_BYTES * 2)) return false
  const key = Buffer.from(publicKey)
  if (key.length !== sodium.crypto_sign_PUBLICKEYBYTES) return false
  try {
    return sodium.crypto_sign_verify_detached(Buffer.from(g, 'hex'), message, key)
  } catch {
    return false
  }
}

// The entry in the contract's field order, `g` set.
function signEntry(secretKey, params, { l, r, s, t, d = false, p = '' }) {
  const e = { l, r, s, t, d, p }
  return { ...e, g: sign(secretKey, entryBytes(params, e)) }
}

// Whether `e` is well formed and `g` verifies under `publicKey`. The caller
// picks the key: the one `r` names for a `v:` entry, the expected host for
// an `h:` entry.
function verifyEntry(publicKey, params, e) {
  if (
    !e ||
    typeof e.l !== 'string' ||
    typeof e.r !== 'string' ||
    !Number.isInteger(e.s) ||
    e.s < 0 ||
    e.s > 0xffffffff ||
    !Number.isSafeInteger(e.t) ||
    e.t < 0 ||
    typeof e.p !== 'string'
  ) {
    return false
  }
  return verify(publicKey, entryBytes(params, e), e.g)
}

// `r` is `v:` or `h:` plus the viewer's key in lowercase hex.
function roleOf(r) {
  if (typeof r !== 'string' || !isHex(r.slice(2), 64)) return null
  const kind = r.slice(0, 2)
  return kind === 'v:' || kind === 'h:' ? { kind, viewer: r.slice(2) } : null
}

// crypto_generichash(PAYLOAD_CONTEXT, key = k): the payload key of a route.
function payloadKey(k) {
  const key = fromBase64url(k)
  const out = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES)
  sodium.crypto_generichash(out, utf8(PAYLOAD_CONTEXT), key)
  return out
}

function seal(key, message) {
  const plain = utf8(JSON.stringify(message))
  const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)
  const box = Buffer.alloc(plain.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(box, plain, nonce, key)
  return base64url(Buffer.concat([nonce, box]))
}

// The message, or null when `p` was not sealed under `key` or is not JSON.
function open(key, p) {
  const bytes = fromBase64url(p)
  const nonceBytes = sodium.crypto_secretbox_NONCEBYTES
  if (bytes.length < nonceBytes + sodium.crypto_secretbox_MACBYTES) return null
  const box = bytes.subarray(nonceBytes)
  const plain = Buffer.alloc(box.length - sodium.crypto_secretbox_MACBYTES)
  let ok = false
  try {
    ok = sodium.crypto_secretbox_open_easy(plain, box, bytes.subarray(0, nonceBytes), key)
  } catch {
    ok = false
  }
  if (!ok) return null
  try {
    return JSON.parse(plain.toString('utf8'))
  } catch {
    return null
  }
}

// `re`: the hex BLAKE3 of the sealed payload carrying an offer. An answer
// names the offer it answers with it, so an old signed answer cannot be
// replayed against a new offer.
function offerRef(p) {
  return Buffer.from(blake3(utf8(p))).toString('hex')
}

// 'sha-256 AB:CD:…' from an SDP's a=fingerprint line, in the shape
// electron/rtc-host.js reports remoteFingerprint in; null when absent.
function sdpFingerprint(sdp) {
  const match = /a=fingerprint:(\S+) (\S+)/i.exec(sdp || '')
  return match ? `${match[1].toLowerCase()} ${match[2].toUpperCase()}` : null
}

// "zbterm/fnet-pointer/1" ‖ lp(own params) ‖ u64le(ver) ‖ lp(sig) ‖ lp(code) ‖ lp(params)
// (contracts/src/pointer/src/lib.rs).
function recordBytes(ownParams, rec) {
  return Buffer.concat([
    utf8(POINTER_DOMAIN),
    lp(Buffer.from(ownParams)),
    u64(rec.ver),
    lp(utf8(rec.sig)),
    lp(utf8(rec.code)),
    lp(utf8(rec.params))
  ])
}

// The record in the contract's field order, `g` set.
function signRecord(secretKey, ownParams, { ver, sig, code, params }) {
  const rec = { ver, sig, code, params }
  return { ...rec, g: sign(secretKey, recordBytes(ownParams, rec)) }
}

function verifyRecord(publicKey, ownParams, rec) {
  if (
    !rec ||
    !Number.isSafeInteger(rec.ver) ||
    typeof rec.sig !== 'string' ||
    typeof rec.code !== 'string' ||
    typeof rec.params !== 'string'
  ) {
    return false
  }
  return verify(publicKey, recordBytes(ownParams, rec), rec.g)
}

module.exports = {
  SIGNAL_DOMAIN,
  entryBytes,
  signEntry,
  verifyEntry,
  roleOf,
  payloadKey,
  seal,
  open,
  offerRef,
  sdpFingerprint,
  recordBytes,
  signRecord,
  verifyRecord
}
