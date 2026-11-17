// Key handling for zbterm-relay (relay/server.js): the relay secret, the
// access salt, and the access key pair derived from both.
//
// - Relay secret: 32 bytes (64 hex). ZBTERM_RELAY_SEED, else
//   ~/.zbterm/relay-secret, else generated and saved there. Never leaves
//   the box.
// - Access salt: 32 bytes (64 hex). ZBTERM_RELAY_ACCESS_SALT, else
//   ~/.zbterm/relay-access, else generated and saved there. Rotating it
//   (--rotate-access-key) changes the access key without touching the secret.
// - Access key pair: DHT.keyPair(sha256('zbterm-relay-access-v1' || secret || salt)).
//   Its public key (hex) is the "access key" users paste into ZBTerm.
//
// Pure apart from file I/O on the paths it is given: the home directory and
// the environment are injected so tests never touch the real ~/.zbterm.
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const DHT = require('hyperdht')

const ACCESS_DOMAIN = 'zbterm-relay-access-v1'
const HEX64 = /^[0-9a-fA-F]{64}$/

const KEYS = {
  secret: {
    label: 'relay secret',
    envName: 'ZBTERM_RELAY_SEED',
    fileName: 'relay-secret'
  },
  salt: {
    label: 'access salt',
    envName: 'ZBTERM_RELAY_ACCESS_SALT',
    fileName: 'relay-access'
  }
}

class KeyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'KeyError'
  }
}

function keyDir(home) {
  return path.join(home, '.zbterm')
}

function keyFile(home, which) {
  return path.join(keyDir(home), KEYS[which].fileName)
}

// Returns the 32 bytes for a valid value (surrounding whitespace allowed),
// or null.
function parseHex(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!HEX64.test(trimmed)) return null
  return Buffer.from(trimmed, 'hex')
}

function readFileIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new KeyError(`Cannot read ${file}: ${err.message}`)
  }
}

function ensureDir(dir) {
  if (fs.existsSync(dir)) return
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {}
}

// Atomic: a temp file in the same directory (mode 0600), then rename over the
// target. Throws on any failure (the caller decides what that means).
function writeKeyFile(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  let fd = null
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    fs.writeSync(fd, value.toString('hex') + '\n')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw err
  }
}

// Resolves one key. Options:
//   home, env      - injected home directory and environment
//   create         - true: generate and save when neither env nor file has it
//                    false: a missing value is an error (--print-key, --check)
// Returns { value, source: 'env'|'file'|'generated', file, notes, infos, errors }
// where notes/infos/errors are message lines for the caller to print and
// errors are non-fatal (U5: generated but not saved). Throws KeyError when
// the value is unusable.
function resolveKey(which, { home, env = {}, create = true } = {}) {
  const spec = KEYS[which]
  if (!spec) throw new Error(`unknown key ${which}`)
  const file = keyFile(home, which)
  const result = { which, value: null, source: null, file, notes: [], infos: [], errors: [] }

  const envText = env[spec.envName]
  const envGiven = typeof envText === 'string' && envText !== ''

  if (envGiven) {
    const value = parseHex(envText)
    if (!value) {
      throw new KeyError(
        `${spec.envName} is not a valid ${spec.label}: expected 64 hex characters.`
      )
    }
    result.value = value
    result.source = 'env'
    const fileText = readFileIfExists(file)
    if (fileText !== null) {
      const fileValue = parseHex(fileText)
      if (!fileValue || !fileValue.equals(value)) {
        result.notes.push(
          `${spec.envName} differs from ${file}: using the variable for this run; the file is left unchanged.`
        )
      }
    }
    return result
  }

  const fileText = readFileIfExists(file)
  if (fileText !== null) {
    const value = parseHex(fileText)
    if (!value) {
      throw new KeyError(
        `${file} is not a valid ${spec.label}: expected 64 hex characters. ` +
          `Fix or remove the file (zbterm-relay never overwrites it), or set ${spec.envName}.`
      )
    }
    result.value = value
    result.source = 'file'
    return result
  }

  if (!create) {
    throw new KeyError(
      `No ${spec.label}: ${file} does not exist and ${spec.envName} is not set ` +
        `(starting zbterm-relay creates it).`
    )
  }

  result.value = crypto.randomBytes(32)
  result.source = 'generated'
  try {
    writeKeyFile(file, result.value)
    result.infos.push(`Created a new ${spec.label} in ${file}.`)
  } catch (err) {
    result.saved = false
    result.errors.push(
      `Could not save the new ${spec.label} to ${file} (${err.message}): this run uses it anyway, ` +
        'but the access key will change on the next restart.'
    )
  }
  return result
}

function deriveKeyPair(secret, salt) {
  const seed = crypto
    .createHash('sha256')
    .update(Buffer.from(ACCESS_DOMAIN, 'utf8'))
    .update(secret)
    .update(salt)
    .digest()
  return DHT.keyPair(seed)
}

function accessKeyLine(keyPair) {
  return `ZBTerm relay access key: ${keyPair.publicKey.toString('hex')}`
}

// Reads the salt file for the running relay's watcher. Returns
// { value } on a valid file, { error } otherwise. Never throws.
function readSaltFile(home) {
  const file = keyFile(home, 'salt')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return {
      error: `Cannot read ${file}: ${err.code === 'ENOENT' ? 'it was removed' : err.message}`
    }
  }
  const value = parseHex(text)
  if (!value) return { error: `${file} is not a valid access salt: expected 64 hex characters.` }
  return { value }
}

// --rotate-access-key: a fresh salt, written atomically. Throws on failure.
function rotateSalt(home) {
  const file = keyFile(home, 'salt')
  const value = crypto.randomBytes(32)
  writeKeyFile(file, value)
  return { value, file }
}

module.exports = {
  ACCESS_DOMAIN,
  KEYS,
  KeyError,
  keyDir,
  keyFile,
  parseHex,
  writeKeyFile,
  resolveKey,
  deriveKeyPair,
  accessKeyLine,
  readSaltFile,
  rotateSalt
}
