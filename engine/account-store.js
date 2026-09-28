const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const sodium = require('sodium-native')
const IdentityKey = require('keet-identity-key')

const { VERSION } = require('./schema')
const { EngineError, CODES } = require('./errors')
const { transportKeyPair } = require('./crypto')

const ACTIVE = 'active'
const REVOKED = 'revoked'

class AccountStore {
  constructor(root) {
    this.root = root
  }

  async ready() {
    await fs.promises.mkdir(this.root, { recursive: true })
  }

  async getProfile() {
    const profile = await this._readJson('profile/self')
    if (!profile) return null
    assertVersion(profile)
    return profile
  }

  async getLocalDevice() {
    const profile = await this.getProfile()
    if (!profile || !profile.localDeviceKey) return null
    const device = await this.getDevice(profile.localDeviceKey)
    if (!device) return null
    return materializeDevice(profile, device)
  }

  async listDevices() {
    const dir = this._path('device')
    let names = []
    try {
      names = await fs.promises.readdir(dir)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    const devices = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const key = name.slice(0, -5)
      const record = await this._readJson(`device/${key}`)
      if (record) {
        assertVersion(record)
        devices.push(record)
      }
    }
    devices.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
    return devices
  }

  async getDevice(deviceKey) {
    const record = await this._readJson(`device/${hex(deviceKey)}`)
    if (!record) return null
    assertVersion(record)
    return record
  }

  async isDeviceActive(deviceKey) {
    const device = await this.getDevice(deviceKey)
    if (!device || device.status !== ACTIVE) return false
    return !(await this.getRevocation(deviceKey))
  }

  async getRevocation(deviceKey) {
    const record = await this._readJson(`device-revocation/${hex(deviceKey)}`)
    if (!record) return null
    assertVersion(record)
    return record
  }

  async revokeDevice(deviceKey, reason = null) {
    const key = hex(deviceKey)
    const device = await this.getDevice(key)
    if (!device) throw new EngineError(CODES.E_AUTH, 'Device is not part of this account')
    const now = Date.now()
    const nextDevice = {
      ...device,
      status: REVOKED,
      revokedAt: device.revokedAt || now,
      updatedAt: now
    }
    const revocation = {
      version: VERSION,
      deviceKey: key,
      revokedBy: (await this.getProfile()).localDeviceKey,
      revokedAt: now,
      reason,
      signature: null
    }
    await this._writeJson(`device/${key}`, nextDevice)
    await this._writeJson(`device-revocation/${key}`, revocation)
    return revocation
  }

  async createUser(opts = {}) {
    await this.ready()
    const existing = await this.getProfile()
    if (existing && !opts.force) return this.getLocalDevice()

    const deviceName = opts.deviceName || process.env.USER || 'This device'
    const mnemonic = opts.mnemonic || IdentityKey.generateMnemonic()
    const identity = await IdentityKey.from({ mnemonic })
    const envelope = createEnvelopeKeyPair()
    const dht = transportKeyPair()
    const proof = await identity.bootstrap(envelope.publicKey)
    const now = Date.now()
    const deviceKey = hex(envelope.publicKey)
    const profile = {
      version: VERSION,
      identityKey: hex(identity.identityPublicKey),
      identityMnemonic: mnemonic,
      profileDiscoveryPublicKey: hex(identity.profileDiscoveryPublicKey),
      profileDiscoveryEncryptionKey: hex(identity.getProfileDiscoveryEncryptionKey()),
      localDeviceKey: deviceKey,
      deviceKeys: [deviceKey],
      createdAt: now,
      updatedAt: now
    }
    const device = {
      version: VERSION,
      deviceKey,
      envelopePublicKey: deviceKey,
      envelopeSecretKey: hex(envelope.secretKey),
      dhtKey: hex(dht.publicKey),
      dhtSecretKey: hex(dht.secretKey),
      identityKey: profile.identityKey,
      identityProof: hex(proof),
      name: deviceName,
      status: ACTIVE,
      addedAt: now,
      updatedAt: now
    }
    await this._writeJson('profile/self', profile)
    await this._writeJson(`device/${deviceKey}`, device)
    return materializeDevice(profile, device)
  }

  async importLegacyLocalDevice(paths) {
    const legacyFile = path.join(paths.root, 'local-device-key.json')
    let raw
    try {
      raw = JSON.parse(await fs.promises.readFile(legacyFile, 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
    if (!raw.publicKey || !raw.secretKey) return null
    if (!raw.identityMnemonic || !raw.identityPublicKey || !raw.identityProof) return null
    if (!raw.dhtPublicKey || !raw.dhtSecretKey) return null

    const now = Date.now()
    const deviceKey = raw.publicKey
    let profileDiscoveryPublicKey = null
    let profileDiscoveryEncryptionKey = null
    try {
      const identity = await IdentityKey.from({ mnemonic: raw.identityMnemonic })
      profileDiscoveryPublicKey = hex(identity.profileDiscoveryPublicKey)
      profileDiscoveryEncryptionKey = hex(identity.getProfileDiscoveryEncryptionKey())
    } catch {}

    const profile = {
      version: VERSION,
      identityKey: raw.identityPublicKey,
      identityMnemonic: raw.identityMnemonic,
      profileDiscoveryPublicKey,
      profileDiscoveryEncryptionKey,
      localDeviceKey: deviceKey,
      deviceKeys: [deviceKey],
      createdAt: now,
      updatedAt: now,
      migratedFrom: 'local-device-key.json'
    }
    const device = {
      version: VERSION,
      deviceKey,
      envelopePublicKey: raw.publicKey,
      envelopeSecretKey: raw.secretKey,
      dhtKey: raw.dhtPublicKey,
      dhtSecretKey: raw.dhtSecretKey,
      identityKey: raw.identityPublicKey,
      identityProof: raw.identityProof,
      name: process.env.USER || 'This device',
      status: ACTIVE,
      addedAt: now,
      updatedAt: now
    }
    await this._writeJson('profile/self', profile)
    await this._writeJson(`device/${deviceKey}`, device)
    return materializeDevice(profile, device)
  }

  // Per-device ed25519 signing key used for live identity challenges. Lazily
  // generated into the existing device record - `version` stays at VERSION,
  // only two new fields appear, so older readers keep loading the record.
  async ensureAuthKeyPair() {
    const profile = await this.getProfile()
    if (!profile || !profile.localDeviceKey) {
      throw new EngineError(CODES.E_NOKEY, 'No local device in this account')
    }
    const deviceKey = profile.localDeviceKey
    const device = await this.getDevice(deviceKey)
    if (!device) throw new EngineError(CODES.E_NOKEY, 'No local device in this account')
    if (device.authPublicKey && device.authSecretKey) {
      return {
        publicKey: b4a.from(device.authPublicKey, 'hex'),
        secretKey: b4a.from(device.authSecretKey, 'hex')
      }
    }
    const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
    const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
    sodium.crypto_sign_keypair(publicKey, secretKey)
    await this._writeJson(`device/${deviceKey}`, {
      ...device,
      authPublicKey: hex(publicKey),
      authSecretKey: hex(secretKey),
      updatedAt: Date.now()
    })
    return { publicKey, secretKey }
  }

  verifyDeviceProof(device, opts = {}) {
    const profile = opts.profile || null
    const expectedIdentity =
      opts.expectedIdentity || (profile && profile.identityKey) || device.identityKey
    const expectedDevice = opts.expectedDevice || device.deviceKey
    if (device.status === REVOKED) return false
    return verifyDeviceProof(device.identityProof, expectedIdentity, expectedDevice)
  }

  _path(key) {
    return path.join(this.root, ...key.split('/'))
  }

  async _readJson(key) {
    try {
      return JSON.parse(await fs.promises.readFile(this._path(key) + '.json', 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return null
      if (err instanceof SyntaxError) {
        throw new EngineError(CODES.E_CORRUPT, `Corrupt account record: ${key}`)
      }
      throw err
    }
  }

  async _writeJson(key, value) {
    assertVersion(value)
    const file = this._path(key) + '.json'
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await fs.promises.rename(tmp, file)
    await fs.promises.chmod(file, 0o600).catch(() => {})
  }
}

function createEnvelopeKeyPair() {
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function materializeDevice(profile, device) {
  return {
    publicKey: b4a.from(device.envelopePublicKey || device.deviceKey, 'hex'),
    secretKey: b4a.from(device.envelopeSecretKey, 'hex'),
    dhtPublicKey: b4a.from(device.dhtKey, 'hex'),
    dhtSecretKey: b4a.from(device.dhtSecretKey, 'hex'),
    identityPublicKey: b4a.from(profile.identityKey || device.identityKey, 'hex'),
    identityProof: b4a.from(device.identityProof, 'hex'),
    authPublicKey: device.authPublicKey ? b4a.from(device.authPublicKey, 'hex') : null,
    authSecretKey: device.authSecretKey ? b4a.from(device.authSecretKey, 'hex') : null,
    profileDiscoveryPublicKey: profile.profileDiscoveryPublicKey
      ? b4a.from(profile.profileDiscoveryPublicKey, 'hex')
      : null,
    profileDiscoveryEncryptionKey: profile.profileDiscoveryEncryptionKey
      ? b4a.from(profile.profileDiscoveryEncryptionKey, 'hex')
      : null,
    name: device.name,
    status: device.status
  }
}

function assertVersion(record) {
  if (!record || record.version !== VERSION) {
    throw new EngineError(CODES.E_CORRUPT, 'Unsupported account record version')
  }
}

function verifyDeviceProof(identityProof, identityPublicKey, devicePublicKey) {
  try {
    const proof = b4a.isBuffer(identityProof) ? identityProof : b4a.from(identityProof, 'hex')
    const expectedIdentity = b4a.isBuffer(identityPublicKey)
      ? identityPublicKey
      : b4a.from(identityPublicKey, 'hex')
    const expectedDevice = b4a.isBuffer(devicePublicKey)
      ? devicePublicKey
      : b4a.from(devicePublicKey, 'hex')
    return !!IdentityKey.verify(proof, null, { expectedIdentity, expectedDevice })
  } catch {
    return false
  }
}

function hex(value) {
  return b4a.isBuffer(value) ? b4a.toString(value, 'hex') : String(value)
}

module.exports = {
  AccountStore,
  ACTIVE,
  REVOKED,
  verifyDeviceProof
}
