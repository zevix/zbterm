const test = require('brittle')
const b4a = require('b4a')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  generateEpochKey,
  deriveHistoryKey,
  deriveLiveKey,
  loadOrCreateLocalDevice,
  nonceFor,
  encryptPacket,
  decryptPacket,
  transportKeyPair,
  verifyDeviceIdentity
} = require('../engine/crypto')

test('crypto packet round trip and tamper rejection', (t) => {
  const master = generateEpochKey()
  const hist = deriveHistoryKey(master)
  const live = deriveLiveKey(master)
  const device = b4a.alloc(32, 7)
  const plain = b4a.from('secret packet')
  const ciphertext = encryptPacket(hist, 'session-a', 1, 42, device, plain)

  t.unlike(hist, live)
  t.alike(decryptPacket(hist, 'session-a', 1, 42, device, ciphertext), plain)

  const tampered = b4a.from(ciphertext)
  tampered[0] ^= 1
  t.exception(() => decryptPacket(hist, 'session-a', 1, 42, device, tampered))
})

test('crypto associated data binding', (t) => {
  const hist = deriveHistoryKey(generateEpochKey())
  const device = b4a.alloc(32, 7)
  const ciphertext = encryptPacket(hist, 'session-a', 1, 42, device, b4a.from('secret'))

  t.exception(() => decryptPacket(hist, 'session-b', 1, 42, device, ciphertext))
  t.exception(() => decryptPacket(hist, 'session-a', 2, 42, device, ciphertext))
  t.exception(() => decryptPacket(hist, 'session-a', 1, 43, device, ciphertext))
  t.exception(() => decryptPacket(hist, 'session-a', 1, 42, b4a.alloc(32, 8), ciphertext))
})

test('nonce derivation is deterministic and unique per seq', (t) => {
  t.alike(nonceFor('abc', 1), nonceFor('abc', 1))
  t.unlike(nonceFor('abc', 1), nonceFor('abc', 2))
  t.unlike(nonceFor('abc', 1), nonceFor('def', 1))
})

test('live packets reject the wrong live key', (t) => {
  const liveA = deriveLiveKey(generateEpochKey())
  const liveB = deriveLiveKey(generateEpochKey())
  const device = b4a.alloc(32, 7)
  const ciphertext = encryptPacket(liveA, 'session-a', 1, 1, device, b4a.from('live output'))

  t.alike(decryptPacket(liveA, 'session-a', 1, 1, device, ciphertext), b4a.from('live output'))
  t.exception(() => decryptPacket(liveB, 'session-a', 1, 1, device, ciphertext))
})

test('local device has real identity attestation', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-identity-test-'))
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }))

  const device = await loadOrCreateLocalDevice({ root })
  t.ok(!b4a.equals(device.identityPublicKey, device.publicKey))
  t.ok(verifyDeviceIdentity(device.identityProof, device.identityPublicKey, device.publicKey))
  t.is(
    verifyDeviceIdentity(device.identityProof, device.identityPublicKey, b4a.alloc(32, 9)),
    false
  )
})

test('transportKeyPair matches hyperdht keyPair for a fixed seed', (t) => {
  const seed = b4a.alloc(32, 0x5a)
  const ours = transportKeyPair(seed)
  const theirs = require('hyperdht').keyPair(seed)
  t.is(ours.publicKey.byteLength, 32)
  t.is(ours.secretKey.byteLength, 64)
  t.alike(ours.publicKey, theirs.publicKey)
  t.alike(ours.secretKey, theirs.secretKey)

  const random = transportKeyPair()
  t.is(random.publicKey.byteLength, 32)
  t.is(random.secretKey.byteLength, 64)
  t.unlike(random.publicKey, ours.publicKey)
})
