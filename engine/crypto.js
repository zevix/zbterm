const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const c = require('compact-encoding')
const sodium = require('sodium-native')

const { EngineError, CODES } = require('./errors')
const { VERSION } = require('./schema')
const { coreFor } = require('./zxterm/core')

const KEY_BYTES = sodium.crypto_kdf_KEYBYTES
// The crypto_kdf contexts (8 bytes each) of the history, live and snapshot
// keys: zxterm contexts since K11 of zxterm-core (ZBTerm D-36, S-38), with no
// compatibility - history, snapshots and live traffic keyed under the former
// contexts no longer decrypt (the owner's decision, zxterm-core Q-14).
const HIST_CONTEXT = Buffer.from('zxt-hist')
const LIVE_CONTEXT = Buffer.from('zxt-live')
const SNAP_CONTEXT = Buffer.from('zxt-snap')
// The key a joined Freenet session's local history cache is sealed under
// (K17, D-40): per device, never on the wire, distinct from the snapshot key.
const CACHE_CONTEXT = Buffer.from('zxt-cach')

const Envelope = {
  preencode(state, env) {
    c.uint.preencode(state, env.version)
    c.string.preencode(state, env.sessionId)
    c.uint.preencode(state, env.epoch)
    c.uint.preencode(state, env.caps || 0)
    let flags = 0
    if (env.masterKey) flags |= 1
    if (env.historyKey) flags |= 2
    if (env.liveKey) flags |= 4
    c.uint.preencode(state, flags)
    if (env.masterKey) c.buffer.preencode(state, env.masterKey)
    if (env.historyKey) c.buffer.preencode(state, env.historyKey)
    if (env.liveKey) c.buffer.preencode(state, env.liveKey)
  },
  encode(state, env) {
    c.uint.encode(state, env.version)
    c.string.encode(state, env.sessionId)
    c.uint.encode(state, env.epoch)
    c.uint.encode(state, env.caps || 0)
    let flags = 0
    if (env.masterKey) flags |= 1
    if (env.historyKey) flags |= 2
    if (env.liveKey) flags |= 4
    c.uint.encode(state, flags)
    if (env.masterKey) c.buffer.encode(state, env.masterKey)
    if (env.historyKey) c.buffer.encode(state, env.historyKey)
    if (env.liveKey) c.buffer.encode(state, env.liveKey)
  },
  decode(state) {
    const version = c.uint.decode(state)
    if (version !== VERSION) throw new EngineError(CODES.E_CORRUPT, 'Unknown envelope version')
    const sessionId = c.string.decode(state)
    const epoch = c.uint.decode(state)
    const caps = c.uint.decode(state)
    const flags = c.uint.decode(state)
    return {
      version,
      sessionId,
      epoch,
      caps,
      masterKey: flags & 1 ? c.buffer.decode(state) : null,
      historyKey: flags & 2 ? c.buffer.decode(state) : null,
      liveKey: flags & 4 ? c.buffer.decode(state) : null
    }
  }
}

function generateEpochKey() {
  const key = b4a.alloc(KEY_BYTES)
  sodium.randombytes_buf(key)
  return key
}

function deriveKey(masterKey, id, context) {
  const out = b4a.alloc(KEY_BYTES)
  sodium.crypto_kdf_derive_from_key(out, id, context, masterKey)
  return out
}

function deriveHistoryKey(masterKey) {
  return deriveKey(masterKey, 1, HIST_CONTEXT)
}

function deriveLiveKey(masterKey) {
  return deriveKey(masterKey, 2, LIVE_CONTEXT)
}

function deriveSnapshotKey(localSecretKey) {
  const master = b4a.alloc(KEY_BYTES)
  sodium.crypto_generichash(master, localSecretKey)
  return deriveKey(master, 3, SNAP_CONTEXT)
}

function deriveHistoryCacheKey(localSecretKey) {
  const master = b4a.alloc(KEY_BYTES)
  sodium.crypto_generichash(master, localSecretKey)
  return deriveKey(master, 4, CACHE_CONTEXT)
}

function hash32(parts) {
  const input = Buffer.concat(parts.map(toBuffer))
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, input)
  return out
}

function nonceFor(sessionId, seq) {
  const prefix = hash32([Buffer.from(sessionId)])
  const nonce = b4a.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  prefix.copy(nonce, 0, 0, 16)
  nonce.writeBigUInt64BE(BigInt(seq), 16)
  return nonce
}

function associatedData(sessionId, epoch, seq, deviceKey) {
  const epochBuf = b4a.alloc(4)
  const seqBuf = b4a.alloc(8)
  epochBuf.writeUInt32BE(epoch)
  seqBuf.writeBigUInt64BE(BigInt(seq))
  return Buffer.concat([Buffer.from(sessionId), epochBuf, seqBuf, toBuffer(deviceKey)])
}

function encryptAead(key, nonce, plain, ad) {
  const out = b4a.alloc(plain.byteLength + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(out, plain, ad, null, nonce, key)
  return out
}

function decryptAead(key, nonce, ciphertext, ad) {
  const out = b4a.alloc(ciphertext.byteLength - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
  // sodium-native throws on auth failure rather than returning falsy, so both
  // outcomes have to collapse to the same EngineError - relying on the return
  // value alone leaves this branch dead and lets the raw sodium Error escape
  // unclassified (surfaces upstream as a generic E_INTERNAL, losing seq/epoch
  // context needed to diagnose it).
  let ok
  try {
    ok = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, null, ciphertext, ad, nonce, key)
  } catch (err) {
    ok = false
  }
  if (!ok) {
    throw new EngineError(CODES.E_CORRUPT, 'Encrypted data failed authentication')
  }
  return out
}

function encryptPacket(key, sessionId, epoch, seq, deviceKey, plainRecord) {
  return encryptAead(
    key,
    nonceFor(sessionId, seq),
    plainRecord,
    associatedData(sessionId, epoch, seq, deviceKey)
  )
}

function decryptPacket(key, sessionId, epoch, seq, deviceKey, ciphertext) {
  try {
    return decryptAead(
      key,
      nonceFor(sessionId, seq),
      ciphertext,
      associatedData(sessionId, epoch, seq, deviceKey)
    )
  } catch (err) {
    if (err instanceof EngineError) err.details = { ...(err.details || {}), epoch, seq }
    throw err
  }
}

function sealEnvelope(publicKey, envelope) {
  const plain = c.encode(Envelope, envelope)
  return sealBytes(publicKey, plain)
}

function sealBytes(publicKey, plain) {
  const out = b4a.alloc(plain.byteLength + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(out, plain, publicKey)
  return out
}

function openEnvelope(publicKey, secretKey, sealed) {
  return c.decode(Envelope, openSealedBytes(publicKey, secretKey, sealed))
}

function openSealedBytes(publicKey, secretKey, sealed) {
  const plain = b4a.alloc(sealed.byteLength - sodium.crypto_box_SEALBYTES)
  if (!sodium.crypto_box_seal_open(plain, sealed, publicKey, secretKey)) {
    throw new EngineError(CODES.E_NOKEY, 'Could not open local key envelope')
  }
  return plain
}

// The identity key (X-01) is the Rust `zxterm-core` sidecar's
// (`idkey.create`, `idkey.verify`), reached over the seam
// (`./zxterm/core.js`). `core` is a `Core`, a profile directory, or nothing
// for this process's default sidecar.
async function createIdentity(mnemonic, devicePublicKey, core) {
  const made = await coreFor(core).request('idkey.create', {
    mnemonic: mnemonic || undefined,
    devicePublicKeyHex: hexOf(devicePublicKey)
  })
  return {
    mnemonic: made.mnemonic,
    identityPublicKey: b4a.from(made.identityPublicKey, 'hex'),
    identityProof: b4a.from(made.identityProof, 'hex'),
    profileDiscoveryPublicKey: b4a.from(made.profileDiscoveryPublicKey, 'hex'),
    profileDiscoveryEncryptionKey: b4a.from(made.profileDiscoveryEncryptionKey, 'hex')
  }
}

// Proofs this process has already seen verify, so a hot path that must stay
// synchronous (a sealed input frame, `share-manager.js`) can re-check a
// proof it verified at join time without a round trip.
const VERIFIED_LIMIT = 4096
const verifiedProofs = new Set()

function proofKey(identityProof, identityPublicKey, devicePublicKey) {
  return `${hexOf(identityProof)}:${hexOf(identityPublicKey)}:${hexOf(devicePublicKey)}`
}

async function verifyDeviceIdentity(identityProof, identityPublicKey, devicePublicKey, core) {
  let key
  try {
    key = proofKey(identityProof, identityPublicKey, devicePublicKey)
  } catch {
    return false
  }
  if (verifiedProofs.has(key)) return true
  let valid = false
  try {
    const answer = await coreFor(core).request('idkey.verify', {
      proofHex: hexOf(identityProof),
      identityPublicKeyHex: hexOf(identityPublicKey),
      devicePublicKeyHex: hexOf(devicePublicKey)
    })
    valid = !!(answer && answer.valid)
  } catch (err) {
    // A core that cannot answer is not a verdict on the proof.
    if (err && err.code === CODES.E_BACKEND_UNAVAILABLE) throw err
    valid = false
  }
  if (valid) {
    if (verifiedProofs.size >= VERIFIED_LIMIT) verifiedProofs.clear()
    verifiedProofs.add(key)
  }
  return valid
}

// Synchronous: true only for a proof `verifyDeviceIdentity` already
// accepted in this process.
function isVerifiedDeviceIdentity(identityProof, identityPublicKey, devicePublicKey) {
  try {
    return verifiedProofs.has(proofKey(identityProof, identityPublicKey, devicePublicKey))
  } catch {
    return false
  }
}

// Ed25519 keypair used as the transport (swarm/DHT) identity. Byte-compatible
// with the Pear DHT keyPair(seed), so stored dhtPublicKey / dhtSecretKey stay valid.
function transportKeyPair(seed) {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  if (seed) sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  else sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

async function loadOrCreateLocalDevice(paths, opts = {}) {
  await fs.promises.mkdir(paths.root, { recursive: true })
  const file = path.join(paths.root, 'local-device-key.json')
  try {
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    let changed = false
    if (!raw.dhtPublicKey || !raw.dhtSecretKey) {
      const dht = transportKeyPair()
      raw.dhtPublicKey = b4a.toString(dht.publicKey, 'hex')
      raw.dhtSecretKey = b4a.toString(dht.secretKey, 'hex')
      changed = true
    }
    if (!raw.identityMnemonic || !raw.identityPublicKey || !raw.identityProof) {
      const identity = await createIdentity(raw.identityMnemonic, raw.publicKey, opts.core)
      raw.identityMnemonic = identity.mnemonic
      raw.identityPublicKey = b4a.toString(identity.identityPublicKey, 'hex')
      raw.identityProof = b4a.toString(identity.identityProof, 'hex')
      changed = true
    }
    if (changed) {
      const tmp = file + '.tmp'
      await fs.promises.writeFile(tmp, JSON.stringify(raw), { mode: 0o600 })
      await fs.promises.rename(tmp, file)
      await fs.promises.chmod(file, 0o600)
    }
    return {
      publicKey: b4a.from(raw.publicKey, 'hex'),
      secretKey: b4a.from(raw.secretKey, 'hex'),
      dhtPublicKey: b4a.from(raw.dhtPublicKey, 'hex'),
      dhtSecretKey: b4a.from(raw.dhtSecretKey, 'hex'),
      identityPublicKey: b4a.from(raw.identityPublicKey, 'hex'),
      identityProof: b4a.from(raw.identityProof, 'hex')
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_keypair(publicKey, secretKey)
  const dht = transportKeyPair()
  const identity = await createIdentity(null, publicKey, opts.core)
  const identityProof = identity.identityProof
  const tmp = file + '.tmp'
  await fs.promises.writeFile(
    tmp,
    JSON.stringify({
      publicKey: b4a.toString(publicKey, 'hex'),
      secretKey: b4a.toString(secretKey, 'hex'),
      dhtPublicKey: b4a.toString(dht.publicKey, 'hex'),
      dhtSecretKey: b4a.toString(dht.secretKey, 'hex'),
      identityMnemonic: identity.mnemonic,
      identityPublicKey: b4a.toString(identity.identityPublicKey, 'hex'),
      identityProof: b4a.toString(identityProof, 'hex')
    }),
    { mode: 0o600 }
  )
  await fs.promises.rename(tmp, file)
  await fs.promises.chmod(file, 0o600)
  return {
    publicKey,
    secretKey,
    dhtPublicKey: dht.publicKey,
    dhtSecretKey: dht.secretKey,
    identityPublicKey: identity.identityPublicKey,
    identityProof
  }
}

function toBuffer(value) {
  return b4a.isBuffer(value) ? value : Buffer.from(value)
}

function hexOf(value) {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) return b4a.toString(value, 'hex')
  return String(value)
}

module.exports = {
  Envelope,
  generateEpochKey,
  deriveHistoryKey,
  deriveLiveKey,
  deriveSnapshotKey,
  deriveHistoryCacheKey,
  nonceFor,
  encryptPacket,
  decryptPacket,
  sealEnvelope,
  openEnvelope,
  sealBytes,
  openSealedBytes,
  createIdentity,
  verifyDeviceIdentity,
  isVerifiedDeviceIdentity,
  transportKeyPair,
  loadOrCreateLocalDevice
}
