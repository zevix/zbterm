// SSH key discovery and SSHSIG signing for the Electron shell.
//
// The Bare worker has no filesystem access to `~/.ssh` and no unix-socket
// client, so everything that touches the user's real SSH keys lives here.
// This module is deliberately free of any `electron` require: it is loaded
// directly by tests under plain Node.
//
// Canonical byte formats (SSH string codec, fingerprints, the SSHSIG
// container) come from `engine/identity/claim.js` - never re-implement them
// here, a claim signed by this file must verify with stock `ssh-keygen -Y
// verify -n zbterm-identity`.
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const crypto = require('crypto')
const b4a = require('b4a')
const sodium = require('sodium-native')

const { EngineError, CODES } = require('../engine/errors')
const {
  KEY_TYPE,
  KEY_TYPES,
  RSA_KEY_TYPE,
  NAMESPACE,
  HASH_ALG,
  writeString,
  readString,
  stripMpint,
  signatureAlgorithmFor,
  fingerprint,
  buildArmoredSignature,
  signedDataBlob
} = require('../engine/identity/claim')

const OPENSSH_MAGIC = 'openssh-key-v1\0'
const PEM_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----'
const PEM_END = '-----END OPENSSH PRIVATE KEY-----'
const PRIVATE_BLOCK_SIZE = 8

// ssh-agent protocol (draft-miller-ssh-agent), only the two requests we need.
const SSH_AGENT_FAILURE = 5
const SSH_AGENTC_REQUEST_IDENTITIES = 11
const SSH_AGENT_IDENTITIES_ANSWER = 12
const SSH_AGENTC_SIGN_REQUEST = 13
const SSH_AGENT_SIGN_RESPONSE = 14
// Ask an agent holding an RSA key for the SHA-512 variant; without this flag
// it answers with a SHA-1 `ssh-rsa` signature, which we refuse.
const SSH_AGENT_RSA_SHA2_512 = 4
const AGENT_TIMEOUT_MS = 5000
const AGENT_MAX_FRAME = 1024 * 1024

// `Include` in ~/.ssh/config is resolved exactly one level deep; an Include
// inside an included file is ignored (recorded in the handoff notes - the
// wizard offers a manual key path for the configurations this misses).
const INCLUDE_DEPTH = 1

const SSH_CONFIG_HOST = 'github.com'

const DEFAULT_KEY_EXCLUDES = /^(config|authorized_keys|known_hosts.*)$/

// ---------------------------------------------------------------------------
// ssh-config parser
// ---------------------------------------------------------------------------

function expandPath(value, home) {
  let out = String(value || '').trim()
  if (out.startsWith('"') && out.endsWith('"') && out.length > 1) out = out.slice(1, -1)
  out = out.replace(/%d/g, home)
  if (out === '~') return home
  if (out.startsWith('~/')) out = path.join(home, out.slice(2))
  return path.isAbsolute(out) ? out : path.join(home, '.ssh', out)
}

function parseConfigLine(line) {
  const stripped = line.replace(/^\s+/, '')
  if (!stripped || stripped.startsWith('#')) return null
  const match = /^([A-Za-z0-9_-]+)\s*(?:=|\s)\s*(.*)$/.exec(stripped)
  if (!match) return null
  const value = match[2].trim()
  if (!value) return null
  return { keyword: match[1].toLowerCase(), value }
}

function splitArgs(value) {
  const out = []
  const re = /"([^"]*)"|(\S+)/g
  let m
  while ((m = re.exec(value)) !== null) out.push(m[1] !== undefined ? m[1] : m[2])
  return out
}

// OpenSSH host patterns: `*` and `?` wildcards, `!` negates.
function hostPatternMatches(patterns, host) {
  let matched = false
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!')
    const body = negated ? pattern.slice(1) : pattern
    const re = new RegExp(
      '^' +
        body
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$'
    )
    if (!re.test(host)) continue
    if (negated) return false
    matched = true
  }
  return matched
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function resolveIncludes(value, home) {
  const files = []
  for (const arg of splitArgs(value)) {
    const target = expandPath(arg, home)
    const dir = path.dirname(target)
    const base = path.basename(target)
    if (!/[*?]/.test(base)) {
      files.push(target)
      continue
    }
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    const re = new RegExp(
      '^' +
        base
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$'
    )
    for (const entry of entries.sort()) {
      if (re.test(entry)) files.push(path.join(dir, entry))
    }
  }
  return files
}

// Returns the flat directive list of a config file with `Include`s spliced in
// at the position they appear, up to `depth` levels.
function flattenConfig(file, home, depth, seen = new Set()) {
  const resolved = path.resolve(file)
  if (seen.has(resolved)) return []
  seen.add(resolved)
  const text = readTextFile(resolved)
  if (text === null) return []
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const directive = parseConfigLine(line)
    if (!directive) continue
    if (directive.keyword === 'include') {
      if (depth <= 0) continue
      for (const included of resolveIncludes(directive.value, home)) {
        out.push(...flattenConfig(included, home, depth - 1, seen))
      }
      continue
    }
    out.push(directive)
  }
  return out
}

// The first `Host` block whose patterns match `host` wins; every IdentityFile
// in it is returned, in file order. A `Match` block ends the current Host
// block (we never evaluate Match conditions).
function identityFilesForHost({ home, host = SSH_CONFIG_HOST, configPath = null }) {
  const file = configPath || path.join(home, '.ssh', 'config')
  const directives = flattenConfig(file, home, INCLUDE_DEPTH)
  let current = null
  const blocks = []
  for (const directive of directives) {
    if (directive.keyword === 'host') {
      current = { patterns: splitArgs(directive.value), identityFiles: [] }
      blocks.push(current)
      continue
    }
    if (directive.keyword === 'match') {
      current = null
      continue
    }
    if (directive.keyword === 'identityfile' && current) {
      for (const arg of splitArgs(directive.value)) {
        current.identityFiles.push(expandPath(arg, home))
      }
    }
  }
  for (const block of blocks) {
    if (!hostPatternMatches(block.patterns, host)) continue
    if (!block.identityFiles.length) continue
    return block.identityFiles
  }
  return []
}

// ---------------------------------------------------------------------------
// OpenSSH private key parser
// ---------------------------------------------------------------------------

function isPadding(buffer) {
  if (buffer.byteLength >= PRIVATE_BLOCK_SIZE) return false
  for (let i = 0; i < buffer.byteLength; i++) {
    if (buffer[i] !== i + 1) return false
  }
  return true
}

// Reads the ssh strings of the private section until only the 1,2,3,... pad
// remains. The last string read is always the comment, whatever the key type.
function readPrivateFields(section, offset) {
  const fields = []
  let at = offset
  while (!isPadding(section.subarray(at))) {
    const next = readString(section, at)
    fields.push(b4a.from(next.value))
    at = next.offset
    if (fields.length > 32) throw new EngineError(CODES.E_CORRUPT, 'Private key section too long')
  }
  return fields
}

function keyTypeOf(publicKeyBlob) {
  const type = readString(publicKeyBlob, 0)
  return b4a.toString(type.value, 'utf8')
}

// Parses the `openssh-key-v1\0` container. Throws EngineError for anything
// malformed; callers turn that into a `signable:false` candidate.
function parseOpenSshPrivateKey(text) {
  const source = String(text || '')
  const begin = source.indexOf(PEM_BEGIN)
  const end = source.indexOf(PEM_END)
  if (begin === -1 || end === -1 || end < begin) {
    throw new EngineError(CODES.E_CORRUPT, 'Not an OpenSSH private key (missing PEM armor)')
  }
  const base64 = source
    .slice(begin + PEM_BEGIN.length, end)
    .split('\n')
    .map((line) => line.trim())
    .join('')
  const buffer = b4a.from(base64, 'base64')
  if (b4a.toString(buffer.subarray(0, OPENSSH_MAGIC.length), 'binary') !== OPENSSH_MAGIC) {
    throw new EngineError(CODES.E_CORRUPT, 'Not an OpenSSH private key (bad magic)')
  }
  let at = OPENSSH_MAGIC.length
  const cipher = readString(buffer, at)
  const kdf = readString(buffer, cipher.offset)
  const kdfOptions = readString(buffer, kdf.offset)
  at = kdfOptions.offset
  if (at + 4 > buffer.byteLength) {
    throw new EngineError(CODES.E_CORRUPT, 'Truncated OpenSSH private key')
  }
  const nkeys = buffer.readUInt32BE(at)
  at += 4
  if (nkeys !== 1) {
    throw new EngineError(CODES.E_CORRUPT, `Unsupported OpenSSH private key (${nkeys} keys)`)
  }
  const publicSection = readString(buffer, at)
  const privateSection = readString(buffer, publicSection.offset)
  const publicKeyBlob = b4a.from(publicSection.value)
  const cipherName = b4a.toString(cipher.value, 'utf8')
  const keyType = keyTypeOf(publicKeyBlob)
  const encrypted = cipherName !== 'none'
  if (encrypted) {
    return { keyType, publicKeyBlob, encrypted: true, comment: '', secretKey: null, rsa: null }
  }
  const section = b4a.from(privateSection.value)
  if (section.byteLength < 8) {
    throw new EngineError(CODES.E_CORRUPT, 'Truncated OpenSSH private key section')
  }
  const check1 = section.readUInt32BE(0)
  const check2 = section.readUInt32BE(4)
  if (check1 !== check2) {
    // Not necessarily corruption: this is also what a wrong passphrase or an
    // undeclared cipher looks like.
    throw new EngineError(CODES.E_CORRUPT, 'OpenSSH private key is encrypted or corrupt')
  }
  const innerType = readString(section, 8)
  const innerKeyType = b4a.toString(innerType.value, 'utf8')
  if (innerKeyType !== keyType) {
    throw new EngineError(CODES.E_CORRUPT, 'OpenSSH private key type mismatch')
  }
  const fields = readPrivateFields(section, innerType.offset)
  const comment = fields.length ? b4a.toString(fields[fields.length - 1], 'utf8') : ''
  if (keyType === RSA_KEY_TYPE) {
    // OpenSSH order is n, e, d, iqmp, p, q, comment - not the PKCS#1 order,
    // and iqmp sits between d and p.
    if (fields.length < 7) {
      throw new EngineError(CODES.E_CORRUPT, 'Truncated RSA private key')
    }
    const [n, e, d, iqmp, p, q] = fields
    return {
      keyType,
      publicKeyBlob,
      encrypted: false,
      comment,
      secretKey: null,
      rsa: { n, e, d, iqmp, p, q }
    }
  }
  if (keyType !== KEY_TYPE) {
    return { keyType, publicKeyBlob, encrypted: false, comment, secretKey: null, rsa: null }
  }
  if (fields.length < 3) {
    throw new EngineError(CODES.E_CORRUPT, 'Truncated ed25519 private key')
  }
  const pub = fields[0]
  const priv = fields[1]
  if (pub.byteLength !== sodium.crypto_sign_PUBLICKEYBYTES) {
    throw new EngineError(CODES.E_CORRUPT, 'ed25519 public key must be 32 bytes')
  }
  if (priv.byteLength !== sodium.crypto_sign_SECRETKEYBYTES) {
    throw new EngineError(CODES.E_CORRUPT, 'ed25519 private key must be 64 bytes')
  }
  return { keyType, publicKeyBlob, encrypted: false, comment, secretKey: priv, rsa: null }
}

// `ssh-ed25519 AAAAC3Nz... comment` - the type in the line and the type inside
// the blob must agree, otherwise the file is junk.
function parsePublicKeyLine(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith('#'))
  if (!line) throw new EngineError(CODES.E_CORRUPT, 'Empty SSH public key file')
  const parts = line.split(/\s+/)
  if (parts.length < 2) throw new EngineError(CODES.E_CORRUPT, 'Malformed SSH public key line')
  const publicKeyBlob = b4a.from(parts[1], 'base64')
  const keyType = keyTypeOf(publicKeyBlob)
  if (keyType !== parts[0]) {
    throw new EngineError(CODES.E_CORRUPT, 'SSH public key type does not match its blob')
  }
  return { keyType, publicKeyBlob, comment: parts.slice(2).join(' ') }
}

// ---------------------------------------------------------------------------
// ssh-agent client
// ---------------------------------------------------------------------------

function agentSocketPath(env) {
  const socket = env && env.SSH_AUTH_SOCK ? String(env.SSH_AUTH_SOCK) : ''
  return socket || null
}

// One request/response round trip. Agent frames are uint32-BE length + payload
// and can arrive split across reads, so accumulate until 4 + length bytes.
function agentRoundTrip(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const header = b4a.alloc(4)
    header.writeUInt32BE(payload.byteLength, 0)
    let socket = null
    let chunks = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => {
      finish(new EngineError(CODES.E_AUTH, 'ssh-agent did not respond within 5s'))
    }, AGENT_TIMEOUT_MS)
    if (timer.unref) timer.unref()

    function finish(err, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (socket) socket.destroy()
      if (err) reject(err)
      else resolve(value)
    }

    try {
      socket = net.connect({ path: socketPath })
    } catch (err) {
      finish(new EngineError(CODES.E_AUTH, `Cannot reach ssh-agent: ${err.message}`))
      return
    }
    socket.on('error', (err) => {
      finish(new EngineError(CODES.E_AUTH, `Cannot reach ssh-agent: ${err.message}`))
    })
    socket.on('connect', () => socket.write(b4a.concat([header, payload])))
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      size += chunk.byteLength
      if (size < 4) return
      const buffer = chunks.length === 1 ? chunks[0] : b4a.concat(chunks)
      chunks = [buffer]
      const length = buffer.readUInt32BE(0)
      if (length > AGENT_MAX_FRAME) {
        finish(new EngineError(CODES.E_AUTH, 'ssh-agent sent an oversized reply'))
        return
      }
      if (size < 4 + length) return
      finish(null, b4a.from(buffer.subarray(4, 4 + length)))
    })
    socket.on('end', () => {
      finish(new EngineError(CODES.E_AUTH, 'ssh-agent closed the connection'))
    })
  })
}

async function agentIdentities({ env = process.env } = {}) {
  const socketPath = agentSocketPath(env)
  if (!socketPath) return []
  let reply
  try {
    reply = await agentRoundTrip(socketPath, b4a.from([SSH_AGENTC_REQUEST_IDENTITIES]))
  } catch {
    // A stale SSH_AUTH_SOCK (agent killed, socket left behind) must degrade to
    // "no agent" rather than break discovery.
    return []
  }
  try {
    if (!reply.byteLength || reply[0] !== SSH_AGENT_IDENTITIES_ANSWER) return []
    const count = reply.readUInt32BE(1)
    let at = 5
    const keys = []
    for (let i = 0; i < count; i++) {
      const blob = readString(reply, at)
      const comment = readString(reply, blob.offset)
      at = comment.offset
      keys.push({
        publicKeyBlob: b4a.from(blob.value),
        comment: b4a.toString(comment.value, 'utf8')
      })
    }
    return keys
  } catch {
    return []
  }
}

async function agentSign({ publicKeyBlob, data, env = process.env }) {
  const socketPath = agentSocketPath(env)
  if (!socketPath) {
    throw new EngineError(CODES.E_AUTH, 'No ssh-agent available (SSH_AUTH_SOCK is not set)')
  }
  const keyType = keyTypeOf(publicKeyBlob)
  const expected = signatureAlgorithmFor(keyType)
  if (!expected) throw new EngineError(CODES.E_AUTH, unsupportedKeyTypeReason(keyType))
  const flags = b4a.alloc(4)
  if (keyType === RSA_KEY_TYPE) flags.writeUInt32BE(SSH_AGENT_RSA_SHA2_512, 0)
  const payload = b4a.concat([
    b4a.from([SSH_AGENTC_SIGN_REQUEST]),
    writeString(publicKeyBlob),
    writeString(data),
    flags
  ])
  const reply = await agentRoundTrip(socketPath, payload)
  if (!reply.byteLength || reply[0] === SSH_AGENT_FAILURE) {
    throw new EngineError(
      CODES.E_AUTH,
      'ssh-agent refused to sign - is the key still loaded? Run `ssh-add -l` to check'
    )
  }
  if (reply[0] !== SSH_AGENT_SIGN_RESPONSE) {
    throw new EngineError(CODES.E_AUTH, `Unexpected ssh-agent response (${reply[0]})`)
  }
  const sigBlob = readString(reply, 1)
  const sigType = readString(sigBlob.value, 0)
  const rawSig = readString(sigBlob.value, sigType.offset)
  const type = b4a.toString(sigType.value, 'utf8')
  // Some agents ignore the flags byte and answer with a SHA-1 `ssh-rsa`
  // signature; that is a refusal, not something to armor and ship.
  if (type !== expected) {
    throw new EngineError(
      CODES.E_AUTH,
      `ssh-agent returned an unsupported signature type: ${type} (expected ${expected})`
    )
  }
  return b4a.from(rawSig.value)
}

// ---------------------------------------------------------------------------
// Candidate enumeration
// ---------------------------------------------------------------------------

function listDefaultKeyFiles(home) {
  const dir = path.join(home, '.ssh')
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const names = new Set()
  for (const entry of entries) {
    if (!entry.startsWith('id_')) continue
    // A lone `id_x.pub` (private half on a smartcard, or only in the agent) is
    // still a candidate - it is keyed by the private path that is missing.
    const name = entry.endsWith('.pub') ? entry.slice(0, -4) : entry
    if (!name || DEFAULT_KEY_EXCLUDES.test(name)) continue
    names.add(name)
  }
  return [...names].sort().map((entry) => path.join(dir, entry))
}

function describeFile(file) {
  const privateText = readTextFile(file)
  const publicText = readTextFile(file + '.pub')
  if (privateText !== null) {
    try {
      const parsed = parseOpenSshPrivateKey(privateText)
      let comment = parsed.comment
      if (!comment && publicText !== null) {
        try {
          comment = parsePublicKeyLine(publicText).comment
        } catch {
          comment = ''
        }
      }
      return {
        keyType: parsed.keyType,
        publicKeyBlob: parsed.publicKeyBlob,
        comment,
        encrypted: parsed.encrypted,
        hasPrivate: true,
        error: null
      }
    } catch (err) {
      // A truncated/garbage private key still deserves a row - and if the
      // matching .pub is intact we can at least name the key.
      if (publicText !== null) {
        try {
          const pub = parsePublicKeyLine(publicText)
          return {
            keyType: pub.keyType,
            publicKeyBlob: pub.publicKeyBlob,
            comment: pub.comment,
            encrypted: false,
            hasPrivate: false,
            error: err.message
          }
        } catch {
          // fall through to the private-key error below
        }
      }
      return {
        keyType: null,
        publicKeyBlob: null,
        comment: '',
        encrypted: false,
        hasPrivate: false,
        error: err.message
      }
    }
  }
  if (publicText !== null) {
    try {
      const pub = parsePublicKeyLine(publicText)
      return {
        keyType: pub.keyType,
        publicKeyBlob: pub.publicKeyBlob,
        comment: pub.comment,
        encrypted: false,
        hasPrivate: false,
        error: null
      }
    } catch (err) {
      return {
        keyType: null,
        publicKeyBlob: null,
        comment: '',
        encrypted: false,
        hasPrivate: false,
        error: err.message
      }
    }
  }
  return {
    keyType: null,
    publicKeyBlob: null,
    comment: '',
    encrypted: false,
    hasPrivate: false,
    error: 'Key file is missing or unreadable'
  }
}

function unsupportedKeyTypeReason(keyType) {
  return `ZBTerm can only sign with ${KEY_TYPES.join(' or ')} keys (this key is ${keyType})`
}

function signability({ keyType, encrypted, hasPrivate, error, inAgent, path: keyPath }) {
  if (!keyType) {
    return { signable: false, reason: error || 'Key could not be parsed' }
  }
  if (!KEY_TYPES.includes(keyType)) {
    return { signable: false, reason: unsupportedKeyTypeReason(keyType) }
  }
  if (inAgent) return { signable: true, reason: null }
  if (encrypted) {
    const hint = keyPath ? `ssh-add ${keyPath}` : 'ssh-add'
    return {
      signable: false,
      reason: `Key is passphrase-protected - add it to ssh-agent (${hint}) to sign with it`
    }
  }
  if (!hasPrivate) {
    return {
      signable: false,
      reason: error
        ? `${error} - add the key to ssh-agent to sign with it`
        : 'Private key file is not available - add the key to ssh-agent to sign with it'
    }
  }
  return { signable: true, reason: null }
}

function sortRank(candidate) {
  if (candidate.source === 'ssh-config') return 0
  if (candidate.source === 'default') {
    return path.basename(candidate.path || '') === 'id_ed25519' ? 1 : 2
  }
  return 3
}

/**
 * Enumerate every SSH key this user could plausibly have on GitHub.
 * Never throws for a single bad key - that key is reported with
 * `signable:false` and a `reason`.
 */
async function listCandidates({ home = os.homedir(), env = process.env } = {}) {
  const configFiles = identityFilesForHost({ home })
  const source = configFiles.length ? 'ssh-config' : 'default'
  const files = configFiles.length ? configFiles : listDefaultKeyFiles(home)
  const agentKeys = await agentIdentities({ env })
  const agentByBlob = new Map()
  for (const key of agentKeys) {
    agentByBlob.set(b4a.toString(key.publicKeyBlob, 'base64'), key)
  }

  const candidates = []
  const seenFiles = new Set()
  const usedAgentBlobs = new Set()
  for (const file of files) {
    if (seenFiles.has(file)) continue
    seenFiles.add(file)
    const info = describeFile(file)
    const blobBase64 = info.publicKeyBlob ? b4a.toString(info.publicKeyBlob, 'base64') : null
    const inAgent = blobBase64 ? agentByBlob.has(blobBase64) : false
    if (inAgent) usedAgentBlobs.add(blobBase64)
    const verdict = signability({ ...info, inAgent, path: file })
    candidates.push({
      path: file,
      source,
      keyType: info.keyType,
      fingerprint: info.publicKeyBlob ? fingerprint(info.publicKeyBlob) : null,
      comment: info.comment || (inAgent ? agentByBlob.get(blobBase64).comment : ''),
      publicKeyBlobBase64: blobBase64,
      encrypted: info.encrypted,
      signable: verdict.signable,
      reason: verdict.reason
    })
  }

  for (const key of agentKeys) {
    const blobBase64 = b4a.toString(key.publicKeyBlob, 'base64')
    if (usedAgentBlobs.has(blobBase64)) continue
    usedAgentBlobs.add(blobBase64)
    let keyType = null
    try {
      keyType = keyTypeOf(key.publicKeyBlob)
    } catch {
      continue
    }
    const verdict = signability({
      keyType,
      encrypted: false,
      hasPrivate: false,
      error: null,
      inAgent: true,
      path: null
    })
    candidates.push({
      path: null,
      source: 'agent',
      keyType,
      fingerprint: fingerprint(key.publicKeyBlob),
      comment: key.comment || '',
      publicKeyBlobBase64: blobBase64,
      encrypted: false,
      signable: verdict.signable,
      reason: verdict.reason
    })
  }

  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => sortRank(a.candidate) - sortRank(b.candidate) || a.index - b.index)
    .map((entry) => entry.candidate)
}

/**
 * Describe exactly one key path, in the same shape `listCandidates` returns
 * but with `source:'manual'`. Discovery follows OpenSSH semantics and so
 * misses keys bound to GitHub through an alias `Host` block; the wizard lets
 * the user name such a file directly. Throws when the path holds no key.
 */
async function inspectKey({ keyPath, home = os.homedir(), env = process.env } = {}) {
  const raw = String(keyPath === null || keyPath === undefined ? '' : keyPath).trim()
  if (!raw) throw new EngineError(CODES.E_AUTH, 'A key file path is required')
  let file = expandPath(raw, home)
  // Pointing at `key.pub` means the same key as pointing at `key`; describeFile
  // already reads the `.pub` sibling itself.
  if (file.endsWith('.pub')) file = file.slice(0, -4)
  const info = describeFile(file)
  if (!info.publicKeyBlob) {
    throw new EngineError(CODES.E_AUTH, info.error || `No SSH key could be read from ${file}`)
  }
  const blobBase64 = b4a.toString(info.publicKeyBlob, 'base64')
  const agentKeys = await agentIdentities({ env })
  const inAgent = agentKeys.some((key) => b4a.toString(key.publicKeyBlob, 'base64') === blobBase64)
  const verdict = signability({ ...info, inAgent, path: file })
  return {
    path: file,
    source: 'manual',
    keyType: info.keyType,
    fingerprint: fingerprint(info.publicKeyBlob),
    comment: info.comment || '',
    publicKeyBlobBase64: blobBase64,
    encrypted: info.encrypted,
    signable: verdict.signable,
    reason: verdict.reason
  }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function base64Url(value) {
  return b4a
    .toString(stripMpint(value), 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function toBigInt(value) {
  const hex = b4a.toString(stripMpint(value), 'hex')
  return hex ? BigInt('0x' + hex) : 0n
}

function fromBigInt(value) {
  const hex = value.toString(16)
  return b4a.from(hex.length % 2 ? '0' + hex : hex, 'hex')
}

// Node cannot read an OpenSSH private key, so the parsed fields are handed to
// it as a JWK. OpenSSH stores n, e, d, iqmp, p, q; JWK wants d, p, q, dp, dq,
// qi, so the two CRT exponents are computed here (`iqmp` is JWK's `qi`).
function rsaPrivateKey(rsa) {
  if (!rsa) throw new EngineError(CODES.E_AUTH, 'RSA private key fields are missing')
  const d = toBigInt(rsa.d)
  const p = toBigInt(rsa.p)
  const q = toBigInt(rsa.q)
  if (!d || p < 2n || q < 2n) {
    throw new EngineError(CODES.E_AUTH, 'RSA private key is incomplete')
  }
  return crypto.createPrivateKey({
    key: {
      kty: 'RSA',
      n: base64Url(rsa.n),
      e: base64Url(rsa.e),
      d: base64Url(rsa.d),
      p: base64Url(rsa.p),
      q: base64Url(rsa.q),
      dp: base64Url(fromBigInt(d % (p - 1n))),
      dq: base64Url(fromBigInt(d % (q - 1n))),
      qi: base64Url(rsa.iqmp)
    },
    format: 'jwk'
  })
}

// ed25519 signs with sodium; RSA signs with Node's PKCS#1 v1.5 over SHA-512,
// which is exactly what `rsa-sha2-512` means.
function signWithPrivateKey(parsed, blob) {
  if (parsed.keyType === KEY_TYPE) {
    const rawSig = b4a.alloc(sodium.crypto_sign_BYTES)
    sodium.crypto_sign_detached(rawSig, blob, parsed.secretKey)
    return rawSig
  }
  if (parsed.keyType === RSA_KEY_TYPE) {
    return b4a.from(crypto.sign('sha512', blob, rsaPrivateKey(parsed.rsa)))
  }
  throw new EngineError(CODES.E_AUTH, unsupportedKeyTypeReason(parsed.keyType))
}

/**
 * Produce an armored SSHSIG over `messageBase64` in the `zbterm-identity`
 * namespace. The private key file is used when it is an unencrypted
 * ed25519 or RSA key; otherwise the signature is requested from ssh-agent.
 */
async function signBytes({
  messageBase64,
  keyPath = null,
  publicKeyBlobBase64 = null,
  env = process.env
} = {}) {
  if (!messageBase64) {
    throw new EngineError(CODES.E_AUTH, 'messageBase64 is required')
  }
  const message = b4a.from(String(messageBase64), 'base64')
  const blob = signedDataBlob(NAMESPACE, HASH_ALG, message)
  let publicKeyBlob = publicKeyBlobBase64 ? b4a.from(String(publicKeyBlobBase64), 'base64') : null
  let fileError = null

  if (keyPath) {
    const info = describeFile(keyPath)
    if (info.publicKeyBlob) publicKeyBlob = info.publicKeyBlob
    if (info.keyType && !KEY_TYPES.includes(info.keyType)) {
      throw new EngineError(CODES.E_AUTH, unsupportedKeyTypeReason(info.keyType))
    }
    if (info.hasPrivate && !info.encrypted) {
      const parsed = parseOpenSshPrivateKey(readTextFile(keyPath))
      const rawSig = signWithPrivateKey(parsed, blob)
      const signature = buildArmoredSignature({
        pubkeyBlob: parsed.publicKeyBlob,
        rawSig,
        namespace: NAMESPACE,
        hashAlg: HASH_ALG
      })
      return {
        signature,
        publicKeyBlobBase64: b4a.toString(parsed.publicKeyBlob, 'base64'),
        fingerprint: fingerprint(parsed.publicKeyBlob),
        via: 'file'
      }
    }
    fileError = info.encrypted ? 'the key file is passphrase-protected' : info.error
  }

  if (!publicKeyBlob) {
    throw new EngineError(
      CODES.E_AUTH,
      fileError
        ? `Cannot sign with ${keyPath}: ${fileError}, and no public key was supplied for ssh-agent`
        : 'Either keyPath or publicKeyBlobBase64 is required'
    )
  }
  const keyType = keyTypeOf(publicKeyBlob)
  if (!KEY_TYPES.includes(keyType)) {
    throw new EngineError(CODES.E_AUTH, unsupportedKeyTypeReason(keyType))
  }
  const rawSig = await agentSign({ publicKeyBlob, data: blob, env })
  const signature = buildArmoredSignature({
    pubkeyBlob: publicKeyBlob,
    rawSig,
    namespace: NAMESPACE,
    hashAlg: HASH_ALG
  })
  return {
    signature,
    publicKeyBlobBase64: b4a.toString(publicKeyBlob, 'base64'),
    fingerprint: fingerprint(publicKeyBlob),
    via: 'agent'
  }
}

module.exports = {
  listCandidates,
  inspectKey,
  signBytes,
  identityFilesForHost,
  parseOpenSshPrivateKey,
  parsePublicKeyLine,
  agentIdentities,
  agentSign
}
