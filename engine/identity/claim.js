// Canonical byte encodings and SSH signature (SSHSIG) helpers for ZBTerm
// identities. Everything here is frozen wire format: the identity claim bytes,
// the handshake challenge bytes and the SSHSIG container are all parsed and
// re-encoded by later phases (and by stock `ssh-keygen -Y verify`), so field
// order, separators and padding rules must not drift.
const b4a = require('b4a')
const sodium = require('sodium-native')

const { EngineError, CODES } = require('../errors')

const SSHSIG_MAGIC = 'SSHSIG'
const SSHSIG_VERSION = 1
const NAMESPACE = 'zbterm-identity'
const HASH_ALG = 'sha512'
// Phase 8: RSA joined ed25519 as a supported claim key type. `KEY_TYPE` stays
// the ed25519 name (it is what a freshly minted claim records by default);
// `KEY_TYPES` is the set every key-type check must consult.
const KEY_TYPE = 'ssh-ed25519'
const RSA_KEY_TYPE = 'ssh-rsa'
// SSHSIG for RSA is always the SHA-512 variant. A bare `ssh-rsa` (SHA-1)
// signature is refused by name, never accepted.
const RSA_SIG_ALG = 'rsa-sha2-512'
const KEY_TYPES = Object.freeze([KEY_TYPE, RSA_KEY_TYPE])
const SIG_ALGS = Object.freeze({ [KEY_TYPE]: KEY_TYPE, [RSA_KEY_TYPE]: RSA_SIG_ALG })
// PKCS#1 v1.5 DigestInfo prefix for SHA-512 (RFC 8017 A.2.4).
const PKCS1_SHA512_PREFIX = '3051300d060960864801650304020305000440'
// 1024 bits is the smallest modulus ssh-keygen will make; 8192 bits is the
// largest anyone ships. Anything outside that is not a key we will verify.
const RSA_MIN_MODULUS_BYTES = 128
const RSA_MAX_MODULUS_BYTES = 1024
const ARMOR_BEGIN = '-----BEGIN SSH SIGNATURE-----'
const ARMOR_END = '-----END SSH SIGNATURE-----'
const ARMOR_WIDTH = 70

const CLAIM_MAGIC = 'zbterm-identity-claim/v1'
const CHALLENGE_MAGIC = 'zbterm-identity-challenge/v1'

function writeString(value) {
  const body = b4a.isBuffer(value) ? value : b4a.from(String(value), 'utf8')
  const header = b4a.alloc(4)
  header.writeUInt32BE(body.byteLength, 0)
  return b4a.concat([header, body])
}

function readString(buffer, offset = 0) {
  if (offset + 4 > buffer.byteLength) {
    throw new EngineError(CODES.E_CORRUPT, 'Truncated SSH string')
  }
  const length = buffer.readUInt32BE(offset)
  const start = offset + 4
  const end = start + length
  if (end > buffer.byteLength) {
    throw new EngineError(CODES.E_CORRUPT, 'Truncated SSH string')
  }
  return { value: buffer.subarray(start, end), offset: end }
}

function encodeEd25519PublicKey(publicKey) {
  const raw = b4a.isBuffer(publicKey) ? publicKey : b4a.from(publicKey, 'hex')
  if (raw.byteLength !== sodium.crypto_sign_PUBLICKEYBYTES) {
    throw new EngineError(CODES.E_AUTH, 'ed25519 public key must be 32 bytes')
  }
  return b4a.concat([writeString(KEY_TYPE), writeString(raw)])
}

// ssh mpints are signed big-endian: a leading 0x00 is present when the high
// bit is set and every other leading zero is stripped. Both directions live
// here because getting either wrong changes the blob, and therefore the
// fingerprint `ssh-keygen -lf` prints.
function stripMpint(value) {
  const raw = b4a.isBuffer(value) ? value : b4a.from(value, 'hex')
  let at = 0
  while (at < raw.byteLength - 1 && raw[at] === 0) at++
  return b4a.from(raw.subarray(at))
}

function writeMpint(value) {
  const raw = stripMpint(value)
  if (raw.byteLength && (raw[0] & 0x80) !== 0) {
    return writeString(b4a.concat([b4a.alloc(1), raw]))
  }
  return writeString(raw)
}

function encodeRsaPublicKey(key = {}) {
  if (!key.e || !key.n) {
    throw new EngineError(CODES.E_AUTH, 'RSA public key needs both e and n')
  }
  return b4a.concat([writeString(RSA_KEY_TYPE), writeMpint(key.e), writeMpint(key.n)])
}

// The SSHSIG signature algorithm an SSH key of this type must use. Returns
// null for a type we neither sign nor verify (ecdsa, sk-*).
function signatureAlgorithmFor(keyType) {
  return SIG_ALGS[keyType] || null
}

function decodePublicKeyBlob(blob) {
  const buffer = b4a.isBuffer(blob) ? blob : b4a.from(blob, 'base64')
  const type = readString(buffer, 0)
  const keyType = b4a.toString(type.value, 'utf8')
  if (keyType === RSA_KEY_TYPE) {
    const e = readString(buffer, type.offset)
    const n = readString(buffer, e.offset)
    return {
      type: keyType,
      publicKey: null,
      rsa: { e: stripMpint(b4a.from(e.value)), n: stripMpint(b4a.from(n.value)) }
    }
  }
  if (keyType !== KEY_TYPE) {
    return { type: keyType, publicKey: null, rsa: null }
  }
  const key = readString(buffer, type.offset)
  if (key.value.byteLength !== sodium.crypto_sign_PUBLICKEYBYTES) {
    throw new EngineError(CODES.E_AUTH, 'ed25519 public key must be 32 bytes')
  }
  return { type: keyType, publicKey: b4a.from(key.value), rsa: null }
}

function sha256(buffer) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, buffer)
  return out
}

function sha512(buffer) {
  const out = b4a.alloc(sodium.crypto_hash_sha512_BYTES)
  sodium.crypto_hash_sha512(out, buffer)
  return out
}

// Identical to `ssh-keygen -lf`: SHA256: + unpadded base64 of the digest of
// the raw wire blob.
function fingerprint(blob) {
  const buffer = b4a.isBuffer(blob) ? blob : b4a.from(blob, 'base64')
  const digest = b4a.toString(sha256(buffer), 'base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

function field(value) {
  return value === null || value === undefined ? '' : String(value)
}

function claimBytes(claim) {
  const lines = [
    CLAIM_MAGIC,
    `provider=${field(claim.provider)}`,
    `subject=${field(claim.subject)}`,
    `identityKey=${field(claim.identityKey)}`,
    `authKey=${field(claim.authKey)}`,
    `sshFingerprint=${field(claim.sshFingerprint)}`,
    `issuedAt=${field(claim.issuedAt)}`,
    `nonce=${field(claim.nonce)}`
  ]
  return b4a.from(lines.join('\n') + '\n', 'ascii')
}

function challengeBytes(challenge) {
  const lines = [
    CHALLENGE_MAGIC,
    `sessionId=${field(challenge.sessionId)}`,
    `challengeId=${field(challenge.challengeId)}`,
    `nonce=${field(challenge.nonce)}`,
    `verifierDhtKey=${field(challenge.verifierDhtKey)}`,
    `proverDhtKey=${field(challenge.proverDhtKey)}`,
    `role=${field(challenge.role)}`
  ]
  return b4a.from(lines.join('\n') + '\n', 'ascii')
}

// The blob an SSHSIG signature is actually computed over - note the message
// itself never reaches crypto_sign_detached, only its sha512 digest inside
// this envelope.
function signedDataBlob(namespace, hashAlg, message) {
  const body = b4a.isBuffer(message) ? message : b4a.from(String(message), 'utf8')
  return b4a.concat([
    b4a.from(SSHSIG_MAGIC, 'ascii'),
    writeString(namespace),
    writeString(''),
    writeString(hashAlg),
    writeString(sha512(body))
  ])
}

function armor(buffer) {
  const base64 = b4a.toString(buffer, 'base64')
  const lines = []
  for (let i = 0; i < base64.length; i += ARMOR_WIDTH) {
    lines.push(base64.slice(i, i + ARMOR_WIDTH))
  }
  return [ARMOR_BEGIN, ...lines, ARMOR_END].join('\n') + '\n'
}

function buildArmoredSignature(opts = {}) {
  const pubkeyBlob = b4a.isBuffer(opts.pubkeyBlob)
    ? opts.pubkeyBlob
    : b4a.from(opts.pubkeyBlob, 'base64')
  const rawSig = b4a.isBuffer(opts.rawSig) ? opts.rawSig : b4a.from(opts.rawSig, 'hex')
  const namespace = opts.namespace || NAMESPACE
  const hashAlg = opts.hashAlg || HASH_ALG
  // The signature algorithm is dictated by the key: ed25519 keys sign as
  // `ssh-ed25519`, RSA keys as `rsa-sha2-512` (never bare `ssh-rsa`).
  const keyType = b4a.toString(readString(pubkeyBlob, 0).value, 'utf8')
  const sigType = signatureAlgorithmFor(keyType)
  if (!sigType) {
    throw new EngineError(
      CODES.E_AUTH,
      `Unsupported SSH key type: ${keyType} (supported: ${KEY_TYPES.join(', ')})`
    )
  }
  const sigBlob = b4a.concat([writeString(sigType), writeString(rawSig)])
  const version = b4a.alloc(4)
  version.writeUInt32BE(SSHSIG_VERSION, 0)
  const container = b4a.concat([
    b4a.from(SSHSIG_MAGIC, 'ascii'),
    version,
    writeString(pubkeyBlob),
    writeString(namespace),
    writeString(''),
    writeString(hashAlg),
    writeString(sigBlob)
  ])
  return armor(container)
}

function parseArmoredSignature(armored) {
  const text = String(armored || '')
  const begin = text.indexOf(ARMOR_BEGIN)
  const end = text.indexOf(ARMOR_END)
  if (begin === -1 || end === -1 || end < begin) {
    throw new EngineError(CODES.E_AUTH, 'Malformed SSH signature: missing armor')
  }
  const base64 = text
    .slice(begin + ARMOR_BEGIN.length, end)
    .split('\n')
    .map((line) => line.trim())
    .join('')
  let container
  try {
    container = b4a.from(base64, 'base64')
  } catch {
    throw new EngineError(CODES.E_AUTH, 'Malformed SSH signature: bad base64')
  }
  if (b4a.toString(container.subarray(0, 6), 'ascii') !== SSHSIG_MAGIC) {
    throw new EngineError(CODES.E_AUTH, 'Malformed SSH signature: bad magic')
  }
  if (container.byteLength < 10) {
    throw new EngineError(CODES.E_AUTH, 'Malformed SSH signature: truncated')
  }
  const version = container.readUInt32BE(6)
  if (version !== SSHSIG_VERSION) {
    throw new EngineError(CODES.E_AUTH, `Unsupported SSH signature version: ${version}`)
  }
  const pubkey = readString(container, 10)
  const namespace = readString(container, pubkey.offset)
  const reserved = readString(container, namespace.offset)
  const hashAlg = readString(container, reserved.offset)
  const signature = readString(container, hashAlg.offset)
  const sigType = readString(signature.value, 0)
  const rawSig = readString(signature.value, sigType.offset)
  return {
    pubkeyBlob: b4a.from(pubkey.value),
    namespace: b4a.toString(namespace.value, 'utf8'),
    hashAlg: b4a.toString(hashAlg.value, 'utf8'),
    sigType: b4a.toString(sigType.value, 'utf8'),
    rawSig: b4a.from(rawSig.value)
  }
}

function bytesToBigInt(buffer) {
  const hex = b4a.toString(buffer, 'hex')
  return hex ? BigInt('0x' + hex) : 0n
}

function bigIntToBytes(value, length) {
  const hex = value.toString(16)
  if (hex.length > length * 2) return null
  return b4a.from(hex.padStart(length * 2, '0'), 'hex')
}

function modPow(base, exponent, modulus) {
  let result = 1n
  let factor = base % modulus
  let bits = exponent
  while (bits > 0n) {
    if (bits & 1n) result = (result * factor) % modulus
    factor = (factor * factor) % modulus
    bits >>= 1n
  }
  return result
}

// RSASSA-PKCS1-v1_5 verification with SHA-512, by hand: neither sodium-native
// nor Bare's `crypto` has RSA, and the worker that verifies a peer's claim
// runs under Bare. The whole encoded message is rebuilt and compared byte for
// byte - never parsed - so a short/loose DigestInfo cannot be smuggled past
// this (the Bleichenbacher low-exponent forgery).
function verifyRsaSha512(rsa, message, rawSig) {
  if (!rsa || !rsa.n || !rsa.e) return false
  const k = rsa.n.byteLength
  if (k < RSA_MIN_MODULUS_BYTES || k > RSA_MAX_MODULUS_BYTES) return false
  if (rawSig.byteLength !== k) return false
  const n = bytesToBigInt(rsa.n)
  const e = bytesToBigInt(rsa.e)
  if (e < 3n || (e & 1n) === 0n || e >= n) return false
  const s = bytesToBigInt(rawSig)
  if (s >= n) return false
  const em = bigIntToBytes(modPow(s, e, n), k)
  if (!em) return false
  const suffix = b4a.concat([b4a.from(PKCS1_SHA512_PREFIX, 'hex'), sha512(message)])
  const padding = k - suffix.byteLength - 3
  if (padding < 8) return false
  const expected = b4a.concat([
    b4a.from([0x00, 0x01]),
    b4a.alloc(padding).fill(0xff),
    b4a.from([0x00]),
    suffix
  ])
  return b4a.equals(em, expected)
}

function verifySshSignature(opts = {}) {
  const message = b4a.isBuffer(opts.message) ? opts.message : b4a.from(String(opts.message), 'utf8')
  const parsed = parseArmoredSignature(opts.armored)
  const key = decodePublicKeyBlob(parsed.pubkeyBlob)
  const sigType = signatureAlgorithmFor(key.type)
  if (!sigType) {
    throw new EngineError(
      CODES.E_AUTH,
      `Unsupported SSH key type: ${key.type} (supported: ${KEY_TYPES.join(', ')})`
    )
  }
  // An `ssh-rsa` (SHA-1) SSHSIG made with an RSA key lands here and is
  // refused: the key type is supported, the signature algorithm is not.
  if (parsed.sigType !== sigType) {
    throw new EngineError(
      CODES.E_AUTH,
      `Unsupported SSH signature algorithm: ${parsed.sigType} (${key.type} must sign with ${sigType})`
    )
  }
  const namespace = opts.namespace || NAMESPACE
  const hashAlg = opts.hashAlg || HASH_ALG
  if (parsed.namespace !== namespace) return false
  if (parsed.hashAlg !== hashAlg) return false
  if (opts.expectedPublicKeyBlob) {
    const expected = b4a.isBuffer(opts.expectedPublicKeyBlob)
      ? opts.expectedPublicKeyBlob
      : b4a.from(opts.expectedPublicKeyBlob, 'base64')
    if (!b4a.equals(expected, parsed.pubkeyBlob)) return false
  }
  const blob = signedDataBlob(parsed.namespace, parsed.hashAlg, message)
  if (key.type === RSA_KEY_TYPE) return verifyRsaSha512(key.rsa, blob, parsed.rawSig)
  if (parsed.rawSig.byteLength !== sodium.crypto_sign_BYTES) return false
  return sodium.crypto_sign_verify_detached(parsed.rawSig, blob, key.publicKey)
}

function signChallenge(secretKey, challenge) {
  const key = b4a.isBuffer(secretKey) ? secretKey : b4a.from(secretKey, 'hex')
  const signature = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, challengeBytes(challenge), key)
  return signature
}

function verifyChallenge(publicKey, challenge, signature) {
  try {
    const key = b4a.isBuffer(publicKey) ? publicKey : b4a.from(publicKey, 'hex')
    const sig = b4a.isBuffer(signature) ? signature : b4a.from(signature, 'hex')
    if (key.byteLength !== sodium.crypto_sign_PUBLICKEYBYTES) return false
    if (sig.byteLength !== sodium.crypto_sign_BYTES) return false
    return sodium.crypto_sign_verify_detached(sig, challengeBytes(challenge), key)
  } catch {
    return false
  }
}

function randomHex(bytes) {
  const buffer = b4a.alloc(bytes)
  sodium.randombytes_buf(buffer)
  return b4a.toString(buffer, 'hex')
}

module.exports = {
  NAMESPACE,
  HASH_ALG,
  KEY_TYPE,
  KEY_TYPES,
  RSA_KEY_TYPE,
  RSA_SIG_ALG,
  ARMOR_BEGIN,
  ARMOR_END,
  CLAIM_MAGIC,
  CHALLENGE_MAGIC,
  writeString,
  readString,
  encodeEd25519PublicKey,
  encodeRsaPublicKey,
  writeMpint,
  stripMpint,
  signatureAlgorithmFor,
  decodePublicKeyBlob,
  fingerprint,
  claimBytes,
  challengeBytes,
  signedDataBlob,
  buildArmoredSignature,
  parseArmoredSignature,
  verifySshSignature,
  signChallenge,
  verifyChallenge,
  randomHex
}
