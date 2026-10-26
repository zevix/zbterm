const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')
const b4a = require('b4a')

require('./helpers/zxterm-core')

const { AccountStore } = require('../engine/account-store')
const { loadOrCreateLocalDevice, verifyDeviceIdentity } = require('../engine/crypto')

test('account store creates a user and first active device', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const account = new AccountStore(path.join(dir, 'account'))
  const device = await account.createUser({ deviceName: 'laptop' })
  const profile = await account.getProfile()
  const devices = await account.listDevices()

  t.is(devices.length, 1)
  t.is(devices[0].name, 'laptop')
  t.is(devices[0].status, 'active')
  t.alike(device.publicKey, b4a.from(profile.localDeviceKey, 'hex'))
  t.ok(await verifyDeviceIdentity(device.identityProof, device.identityPublicKey, device.publicKey))
  t.ok(await account.isDeviceActive(device.publicKey))
})

test('account store rejects revoked devices even with valid proof', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const account = new AccountStore(path.join(dir, 'account'))
  const device = await account.createUser()
  const revocation = await account.revokeDevice(device.publicKey, 'lost')
  const record = await account.getDevice(device.publicKey)

  t.is(revocation.reason, 'lost')
  t.is(record.status, 'revoked')
  t.is(await account.isDeviceActive(device.publicKey), false)
})

test('account store imports existing local-device-key dev data', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const paths = { root: dir }
  const legacy = await loadOrCreateLocalDevice(paths)
  const account = new AccountStore(path.join(dir, 'account'))
  const migrated = await account.importLegacyLocalDevice(paths)

  t.alike(migrated.publicKey, legacy.publicKey)
  t.alike(migrated.identityPublicKey, legacy.identityPublicKey)
  t.ok(await account.isDeviceActive(legacy.publicKey))
})

test('account store lazily adds a device auth keypair without rotating it', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const account = new AccountStore(path.join(dir, 'account'))
  const device = await account.createUser({ deviceName: 'laptop' })
  const before = await account.getDevice(device.publicKey)
  t.absent(before.authPublicKey, 'a fresh device record has no auth key yet')

  const pair = await account.ensureAuthKeyPair()
  const record = await account.getDevice(device.publicKey)

  t.is(record.version, 2, 'the record version is untouched')
  t.is(b4a.toString(pair.publicKey, 'hex'), record.authPublicKey)
  t.is(b4a.toString(pair.secretKey, 'hex'), record.authSecretKey)
  t.is(pair.publicKey.byteLength, 32)
  t.is(pair.secretKey.byteLength, 64)

  const again = await account.ensureAuthKeyPair()
  t.alike(again.publicKey, pair.publicKey, 'a second call reuses the stored key')
  t.alike(again.secretKey, pair.secretKey)

  const local = await account.getLocalDevice()
  t.alike(local.authPublicKey, pair.publicKey, 'materializeDevice exposes the auth keys')
  t.alike(local.authSecretKey, pair.secretKey)
})

test('account records written before the auth keypair existed still load', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const account = new AccountStore(path.join(dir, 'account'))
  const device = await account.createUser({ deviceName: 'laptop' })
  const deviceKey = b4a.toString(device.publicKey, 'hex')
  // Fixture: rewrite the record exactly as the pre-change code wrote it.
  const file = path.join(dir, 'account', 'device', `${deviceKey}.json`)
  const legacy = JSON.parse(await fs.promises.readFile(file, 'utf8'))
  delete legacy.authPublicKey
  delete legacy.authSecretKey
  await fs.promises.writeFile(file, JSON.stringify(legacy, null, 2), { mode: 0o600 })

  const local = await account.getLocalDevice()
  t.is(local.authPublicKey, null, 'auth keys are absent, not corrupt')
  t.is(local.authSecretKey, null)
  t.ok(await account.isDeviceActive(device.publicKey))

  const pair = await account.ensureAuthKeyPair()
  t.is(pair.publicKey.byteLength, 32)
  t.is((await account.getDevice(deviceKey)).version, 2)
})

test('an account made by the old identity-key scheme gets a fresh identity once', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'account')
  await fs.promises.cp(path.join(__dirname, 'fixtures', 'identity', 'old-scheme-account'), root, {
    recursive: true
  })
  const account = new AccountStore(root)
  const before = await account.getProfile()
  const device = await account.getDevice(before.localDeviceKey)

  const replaced = await account.replaceOldSchemeIdentity()
  t.is(replaced, before.identityKey, 'the old identity key is reported as replaced')
  const after = await account.getProfile()
  const record = await account.getDevice(before.localDeviceKey)
  t.not(after.identityKey, before.identityKey, 'a fresh identity key')
  t.not(after.identityMnemonic, before.identityMnemonic, 'from a fresh mnemonic')
  t.is(record.identityKey, after.identityKey)
  t.is(record.envelopeSecretKey, device.envelopeSecretKey, 'the device keys are untouched')
  t.ok(
    await verifyDeviceIdentity(record.identityProof, after.identityKey, before.localDeviceKey),
    'the new proof binds this device to the new identity'
  )
  t.is(await account.replaceOldSchemeIdentity(), null, 'a second start changes nothing')
  t.alike(await account.getProfile(), after)
})

function temp() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-account-test-'))
}
