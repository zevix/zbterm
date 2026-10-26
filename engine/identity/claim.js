// Identity claim, challenge and SSH signature (SSHSIG) helpers - thin
// call-throughs to the Rust `zxterm-core` sidecar (K9 of zxterm-core, in
// `zevix/zxterm`; not this directory's own JS package, `zbterm-core`). The
// encodings are computed by `zxterm_core::identity::claim` and
// `zxterm_core::ssh::sshsig` over the seam (`../zxterm/core.js`); nothing is
// computed here any more, so every function is async. `core` is a `Core`, a
// profile directory, or nothing for this process's default sidecar.
//
// The constants stay: they name frozen wire format the core also uses, and
// callers (and `test/former-name.test.js`) read them.
const b4a = require('b4a')

const { coreFor } = require('../zxterm/core')

const NAMESPACE = 'zbterm-identity'
const HASH_ALG = 'sha512'
const KEY_TYPE = 'ssh-ed25519'
const RSA_KEY_TYPE = 'ssh-rsa'
const RSA_SIG_ALG = 'rsa-sha2-512'
const KEY_TYPES = Object.freeze([KEY_TYPE, RSA_KEY_TYPE])
const ARMOR_BEGIN = '-----BEGIN SSH SIGNATURE-----'
const ARMOR_END = '-----END SSH SIGNATURE-----'
const CLAIM_MAGIC = 'zbterm-identity-claim/v1'
const CHALLENGE_MAGIC = 'zbterm-identity-challenge/v1'

function toBase64(value, encoding) {
  if (value === null || value === undefined) return value
  if (b4a.isBuffer(value) || value instanceof Uint8Array) return b4a.toString(value, 'base64')
  if (encoding === 'utf8') return b4a.toString(b4a.from(String(value), 'utf8'), 'base64')
  if (encoding === 'hex') return b4a.toString(b4a.from(String(value), 'hex'), 'base64')
  return String(value)
}

function toHex(value) {
  if (value === null || value === undefined) return ''
  if (b4a.isBuffer(value) || value instanceof Uint8Array) return b4a.toString(value, 'hex')
  return String(value)
}

// Claims and challenges cross the seam as JSON; the core reads each field
// as `claim.js::field()` did (null/undefined -> empty), so numbers are sent
// as numbers only where the core expects one (`issuedAt`).
function claimJson(claim = {}) {
  const out = {}
  for (const key of [
    'provider',
    'subject',
    'identityKey',
    'authKey',
    'sshFingerprint',
    'nonce',
    'signature',
    'sshPublicKey'
  ]) {
    if (claim[key] !== null && claim[key] !== undefined) out[key] = String(claim[key])
  }
  if (claim.issuedAt !== null && claim.issuedAt !== undefined) {
    out.issuedAt = Number(claim.issuedAt)
  }
  return out
}

function challengeJson(challenge = {}) {
  const out = {}
  for (const key of [
    'sessionId',
    'challengeId',
    'nonce',
    'verifierDhtKey',
    'proverDhtKey',
    'role'
  ]) {
    if (challenge[key] !== null && challenge[key] !== undefined) out[key] = String(challenge[key])
  }
  return out
}

async function fingerprint(blob, core) {
  const answer = await coreFor(core).request('identity.fingerprint', {
    blobBase64: toBase64(blob)
  })
  return answer.fingerprint
}

async function claimBytes(claim, core) {
  const answer = await coreFor(core).request('identity.claimBytes', { claim: claimJson(claim) })
  return b4a.from(answer.bytesBase64, 'base64')
}

async function challengeBytes(challenge, core) {
  const answer = await coreFor(core).request('identity.challengeBytes', {
    challenge: challengeJson(challenge)
  })
  return b4a.from(answer.bytesBase64, 'base64')
}

async function signedDataBlob(namespace, hashAlg, message, core) {
  const answer = await coreFor(core).request('identity.signedDataBlob', {
    namespace,
    hashAlg,
    messageBase64: toBase64(message, 'utf8')
  })
  return b4a.from(answer.bytesBase64, 'base64')
}

async function encodeEd25519PublicKey(publicKey, core) {
  const answer = await coreFor(core).request('identity.encodePublicKey', {
    ed25519PublicKeyHex: toHex(publicKey)
  })
  return b4a.from(answer.blobBase64, 'base64')
}

async function encodeRsaPublicKey(key = {}, core) {
  const answer = await coreFor(core).request('identity.encodePublicKey', {
    eHex: key.e ? toHex(key.e) : undefined,
    nHex: key.n ? toHex(key.n) : undefined
  })
  return b4a.from(answer.blobBase64, 'base64')
}

async function buildArmoredSignature(opts = {}, core) {
  const answer = await coreFor(core).request('identity.armorSignature', {
    publicKeyBlobBase64: toBase64(opts.pubkeyBlob),
    rawSigBase64: toBase64(opts.rawSig, 'hex'),
    namespace: opts.namespace || NAMESPACE,
    hashAlg: opts.hashAlg || HASH_ALG
  })
  return answer.armored
}

async function parseArmoredSignature(armored, core) {
  const answer = await coreFor(core).request('identity.parseSignature', {
    armored: String(armored || '')
  })
  return {
    pubkeyBlob: b4a.from(answer.pubkeyBlobBase64, 'base64'),
    namespace: answer.namespace,
    hashAlg: answer.hashAlg,
    sigType: answer.sigType,
    rawSig: b4a.from(answer.rawSigBase64, 'base64')
  }
}

// Resolves `false` for every refusal; rejects (E_AUTH) only for an
// unsupported key type or signature algorithm, as before.
async function verifySshSignature(opts = {}, core) {
  const answer = await coreFor(core).request('identity.verifySshSignature', {
    armored: String(opts.armored || ''),
    messageBase64: toBase64(opts.message, 'utf8'),
    namespace: opts.namespace || undefined,
    hashAlg: opts.hashAlg || undefined,
    expectedPublicKeyBlobBase64: opts.expectedPublicKeyBlob
      ? toBase64(opts.expectedPublicKeyBlob)
      : undefined
  })
  return !!answer.valid
}

async function signChallenge(secretKey, challenge, core) {
  const answer = await coreFor(core).request('identity.signChallenge', {
    authSecretKeyHex: toHex(secretKey),
    challenge: challengeJson(challenge)
  })
  return b4a.from(answer.signatureHex, 'hex')
}

async function verifyChallenge(publicKey, challenge, signature, core) {
  const answer = await coreFor(core).request('identity.verifyChallenge', {
    authKeyHex: toHex(publicKey),
    challenge: challengeJson(challenge),
    signatureHex: toHex(signature)
  })
  return !!answer.valid
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
  claimJson,
  challengeJson,
  fingerprint,
  claimBytes,
  challengeBytes,
  signedDataBlob,
  encodeEd25519PublicKey,
  encodeRsaPublicKey,
  buildArmoredSignature,
  parseArmoredSignature,
  verifySshSignature,
  signChallenge,
  verifyChallenge
}
