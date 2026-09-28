const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-native')

const { listCandidates, signBytes, parseOpenSshPrivateKey } = require('../electron/ssh-keys')
const {
  NAMESPACE,
  verifySshSignature,
  encodeRsaPublicKey,
  writeString,
  readString
} = require('../engine/identity/claim')

const NO_SSH_KEYGEN = !hasSshKeygen()
// Every test must be blind to the developer's own agent and ~/.ssh.
const NO_AGENT = {}

function hasSshKeygen() {
  const result = spawnSync('ssh-keygen', ['-h'], { encoding: 'utf8' })
  return !result.error
}

function keygen(dir, name, type, passphrase = '') {
  const file = path.join(dir, name)
  const result = spawnSync(
    'ssh-keygen',
    ['-q', '-t', type, '-N', passphrase, '-C', `${name}@test`, '-f', file],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(`ssh-keygen failed: ${result.stderr || result.stdout}`)
  return file
}

// A throwaway HOME with its own .ssh - nothing here reads or writes the real one.
function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-ssh-'))
  fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 })
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

test('ssh-config Host github.com IdentityFile wins and sorts first', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  keygen(ssh, 'work_ed25519', 'ed25519')
  keygen(ssh, 'id_ed25519', 'ed25519')
  fs.mkdirSync(path.join(ssh, 'conf.d'))
  fs.writeFileSync(
    path.join(ssh, 'conf.d', 'github.conf'),
    ['Host github.com', '  IdentityFile ~/.ssh/work_ed25519', '  IdentitiesOnly yes', ''].join('\n')
  )
  fs.writeFileSync(
    path.join(ssh, 'config'),
    ['Include conf.d/*.conf', 'Host *', '  IdentityFile %d/.ssh/id_ed25519', ''].join('\n')
  )

  const candidates = await listCandidates({ home, env: NO_AGENT })
  t.is(candidates[0].path, path.join(ssh, 'work_ed25519'))
  t.is(candidates[0].source, 'ssh-config')
  t.is(candidates[0].keyType, 'ssh-ed25519')
  t.is(candidates[0].signable, true)
  t.is(candidates[0].reason, null)
  t.is(candidates[0].encrypted, false)
  t.ok(candidates[0].fingerprint.startsWith('SHA256:'))
  // The `Host *` block only applies when github.com did not match first.
  t.is(
    candidates.filter((entry) => entry.path === path.join(ssh, 'id_ed25519')).length,
    0,
    'config match suppresses the default glob'
  )
})

test('the config fingerprint and comment match ssh-keygen', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  const file = keygen(ssh, 'id_ed25519', 'ed25519')
  const [candidate] = await listCandidates({ home, env: NO_AGENT })
  const out = spawnSync('ssh-keygen', ['-lf', file + '.pub'], { encoding: 'utf8' }).stdout
  t.ok(out.includes(candidate.fingerprint), `${out.trim()} contains ${candidate.fingerprint}`)
  t.is(candidate.comment, 'id_ed25519@test')
})

test('without a config, id_ed25519 precedes id_rsa and both are signable', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  keygen(ssh, 'id_rsa', 'rsa')
  keygen(ssh, 'id_ed25519', 'ed25519')
  keygen(ssh, 'id_ecdsa', 'ecdsa')
  fs.writeFileSync(path.join(ssh, 'known_hosts'), 'github.com ssh-ed25519 AAAA\n')
  fs.writeFileSync(path.join(ssh, 'authorized_keys'), '')

  const candidates = await listCandidates({ home, env: NO_AGENT })
  t.is(candidates.length, 3)
  t.is(path.basename(candidates[0].path), 'id_ed25519')
  t.is(candidates[0].source, 'default')
  t.is(candidates[0].signable, true)
  const rsa = candidates.find((entry) => path.basename(entry.path) === 'id_rsa')
  t.is(rsa.keyType, 'ssh-rsa', 'type comes from the inner keytype, not the PEM header')
  t.is(rsa.signable, true, 'Phase 8: RSA keys are signable')
  t.is(rsa.reason, null)
  // ECDSA and sk-* stay out of scope, but the reason must not claim ed25519
  // is the only thing we can sign with.
  const ecdsa = candidates.find((entry) => path.basename(entry.path) === 'id_ecdsa')
  t.is(ecdsa.signable, false)
  t.is(
    ecdsa.reason,
    `ZBTerm can only sign with ssh-ed25519 or ssh-rsa keys (this key is ${ecdsa.keyType})`,
    ecdsa.reason
  )
})

test('a passphrase-protected key is listed, encrypted and unsignable without an agent', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  const file = keygen(ssh, 'id_ed25519', 'ed25519', 'hunter2hunter2')

  const [candidate] = await listCandidates({ home, env: NO_AGENT })
  t.is(candidate.encrypted, true)
  t.is(candidate.signable, false)
  t.ok(/ssh-agent/.test(candidate.reason), candidate.reason)
  t.is(candidate.keyType, 'ssh-ed25519')
  const out = spawnSync('ssh-keygen', ['-lf', file + '.pub'], { encoding: 'utf8' }).stdout
  t.ok(out.includes(candidate.fingerprint), 'public half is still parsed')
  t.is(candidate.comment, 'id_ed25519@test')
})

test('a truncated key file yields an unsignable candidate rather than throwing', async (t) => {
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  fs.writeFileSync(
    path.join(ssh, 'id_ed25519'),
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZX\n-----END OPENSSH PRIVATE KEY-----\n'
  )
  fs.writeFileSync(path.join(ssh, 'id_garbage'), 'not a key at all\n')

  const candidates = await listCandidates({ home, env: NO_AGENT })
  t.is(candidates.length, 2)
  for (const candidate of candidates) {
    t.is(candidate.signable, false)
    t.ok(candidate.reason, `${candidate.path}: ${candidate.reason}`)
    t.is(candidate.publicKeyBlobBase64, null)
  }
})

test('a .pub without its private key is agent-signable only', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  const file = keygen(ssh, 'id_ed25519', 'ed25519')
  fs.rmSync(file)

  const [candidate] = await listCandidates({ home, env: NO_AGENT })
  t.is(candidate.path, file)
  t.is(candidate.keyType, 'ssh-ed25519')
  t.is(candidate.signable, false)
  t.ok(/ssh-agent/.test(candidate.reason), candidate.reason)
  t.ok(candidate.publicKeyBlobBase64, 'the public half is still reported')
})

test('signBytes produces an SSHSIG that ssh-keygen -Y verify accepts', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  const file = keygen(ssh, 'id_ed25519', 'ed25519')
  const message = b4a.from('zbterm-identity-claim/v1\nprovider=github\n', 'utf8')

  const result = await signBytes({
    messageBase64: b4a.toString(message, 'base64'),
    keyPath: file,
    env: NO_AGENT
  })
  t.is(result.via, 'file')
  t.ok(result.signature.startsWith('-----BEGIN SSH SIGNATURE-----'))
  t.ok(verifySshSignature({ armored: result.signature, message }), 'verifies in-process')

  const sigFile = path.join(home, 'claim.sig')
  const msgFile = path.join(home, 'claim.bin')
  const allowed = path.join(home, 'allowed_signers')
  fs.writeFileSync(sigFile, result.signature)
  fs.writeFileSync(msgFile, message)
  const pub = fs
    .readFileSync(file + '.pub', 'utf8')
    .trim()
    .split(/\s+/)
  fs.writeFileSync(allowed, `tester ${pub[0]} ${pub[1]}\n`)
  const verify = spawnSync(
    'ssh-keygen',
    ['-Y', 'verify', '-f', allowed, '-I', 'tester', '-n', NAMESPACE, '-s', sigFile],
    { input: fs.readFileSync(msgFile), encoding: 'utf8' }
  )
  t.is(verify.status, 0, `${verify.stdout || ''}${verify.stderr || ''}`)
  t.is(
    result.fingerprint,
    spawnSync('ssh-keygen', ['-lf', file + '.pub'], {
      encoding: 'utf8'
    }).stdout.split(/\s+/)[1]
  )
})

test('signBytes signs with an RSA key file and ssh-keygen -Y verify accepts it', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  const file = keygen(ssh, 'id_rsa', 'rsa')
  const message = b4a.from('zbterm-identity-claim/v1\nprovider=github\n', 'utf8')

  const result = await signBytes({
    messageBase64: b4a.toString(message, 'base64'),
    keyPath: file,
    env: NO_AGENT
  })
  t.is(result.via, 'file')
  t.ok(verifySshSignature({ armored: result.signature, message }), 'verifies in-process')

  const sigFile = path.join(home, 'claim.sig')
  const allowed = path.join(home, 'allowed_signers')
  fs.writeFileSync(sigFile, result.signature)
  const pub = fs
    .readFileSync(file + '.pub', 'utf8')
    .trim()
    .split(/\s+/)
  t.is(pub[0], 'ssh-rsa')
  fs.writeFileSync(allowed, `tester ${pub[0]} ${pub[1]}\n`)
  const verify = spawnSync(
    'ssh-keygen',
    ['-Y', 'verify', '-f', allowed, '-I', 'tester', '-n', NAMESPACE, '-s', sigFile],
    { input: message, encoding: 'utf8' }
  )
  t.is(verify.status, 0, `${verify.stdout || ''}${verify.stderr || ''}`)
  t.is(
    result.fingerprint,
    spawnSync('ssh-keygen', ['-lf', file + '.pub'], {
      encoding: 'utf8'
    }).stdout.split(/\s+/)[1]
  )
})

test('signBytes refuses key types that are still out of scope', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  const file = keygen(ssh, 'id_ecdsa', 'ecdsa')
  await t.exception(
    signBytes({
      messageBase64: b4a.toString(b4a.from('x'), 'base64'),
      keyPath: file,
      env: NO_AGENT
    }),
    /ssh-ed25519 or ssh-rsa/
  )
})

test('signBytes without an agent socket reports no agent', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  const file = keygen(ssh, 'id_ed25519', 'ed25519', 'hunter2hunter2')
  await t.exception(
    signBytes({
      messageBase64: b4a.toString(b4a.from('x'), 'base64'),
      keyPath: file,
      env: NO_AGENT
    }),
    /SSH_AUTH_SOCK/
  )
})

test('a dead SSH_AUTH_SOCK degrades to no agent instead of failing discovery', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  keygen(ssh, 'id_ed25519', 'ed25519')
  const candidates = await listCandidates({
    home,
    env: { SSH_AUTH_SOCK: path.join(home, 'no-such-agent.sock') }
  })
  t.is(candidates.length, 1)
  t.is(candidates[0].signable, true)
})

// A minimal in-process ssh-agent: enough of the protocol to answer
// REQUEST_IDENTITIES and SIGN_REQUEST for one ed25519 key.
function fakeAgent(t, home, { publicKeyBlob, secretKey, comment = 'agent-key', sign = null }) {
  const socketPath = path.join(home, 'agent.sock')
  const server = net.createServer((socket) => {
    let buffer = b4a.alloc(0)
    socket.on('data', (chunk) => {
      buffer = b4a.concat([buffer, chunk])
      while (buffer.byteLength >= 4 && buffer.byteLength >= 4 + buffer.readUInt32BE(0)) {
        const length = buffer.readUInt32BE(0)
        const payload = buffer.subarray(4, 4 + length)
        buffer = b4a.from(buffer.subarray(4 + length))
        socket.write(frame(reply(payload)))
      }
    })
  })

  function frame(payload) {
    const header = b4a.alloc(4)
    header.writeUInt32BE(payload.byteLength, 0)
    return b4a.concat([header, payload])
  }

  function reply(payload) {
    if (payload[0] === 11) {
      const count = b4a.alloc(4)
      count.writeUInt32BE(1, 0)
      return b4a.concat([
        b4a.from([12]),
        count,
        writeString(publicKeyBlob),
        writeString(b4a.from(comment, 'utf8'))
      ])
    }
    if (payload[0] === 13) {
      const blob = readString(payload, 1)
      const data = readString(payload, blob.offset)
      const flags = payload.readUInt32BE(data.offset)
      if (sign) {
        const answer = sign(b4a.from(data.value), flags)
        const sigBlob = b4a.concat([
          writeString(b4a.from(answer.type, 'utf8')),
          writeString(answer.rawSig)
        ])
        return b4a.concat([b4a.from([14]), writeString(sigBlob)])
      }
      const rawSig = b4a.alloc(64)
      sodium.crypto_sign_detached(rawSig, b4a.from(data.value), secretKey)
      const sigBlob = b4a.concat([
        writeString(b4a.from('ssh-ed25519', 'utf8')),
        writeString(rawSig)
      ])
      return b4a.concat([b4a.from([14]), writeString(sigBlob)])
    }
    return b4a.from([5])
  }

  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({ SSH_AUTH_SOCK: socketPath }))
  })
}

test('an agent-held encrypted key becomes signable and signs via the agent', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  const locked = keygen(ssh, 'id_ed25519', 'ed25519')
  const material = parseOpenSshPrivateKey(fs.readFileSync(locked, 'utf8'))
  // Same key, now passphrase-protected on disk but still held by the agent.
  const changed = spawnSync(
    'ssh-keygen',
    ['-q', '-p', '-f', locked, '-P', '', '-N', 'hunter2hunter2'],
    { encoding: 'utf8' }
  )
  t.is(changed.status, 0, changed.stderr || changed.stdout)
  const env = await fakeAgent(t, home, material)

  const candidates = await listCandidates({ home, env })
  const held = candidates.find((entry) => entry.encrypted)
  t.is(held.signable, true, 'the agent covers the passphrase-protected file')
  t.is(held.reason, null)

  const message = b4a.from('agent-signed claim', 'utf8')
  const result = await signBytes({
    messageBase64: b4a.toString(message, 'base64'),
    keyPath: locked,
    env
  })
  t.is(result.via, 'agent')
  t.ok(verifySshSignature({ armored: result.signature, message }))
})

test('parseOpenSshPrivateKey reports encryption without decrypting', (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const home = makeHome(t)
  const ssh = path.join(home, '.ssh')
  const file = keygen(ssh, 'id_ed25519', 'ed25519', 'hunter2hunter2')
  const parsed = parseOpenSshPrivateKey(fs.readFileSync(file, 'utf8'))
  t.is(parsed.encrypted, true)
  t.is(parsed.secretKey, null)
  t.is(parsed.keyType, 'ssh-ed25519')
})

// An RSA key that only ssh-agent holds: no private file at all, so the agent
// path is the only way to sign with it.
function rsaAgentKey() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = privateKey.export({ format: 'jwk' })
  const publicKeyBlob = encodeRsaPublicKey({
    e: b4a.from(jwk.e, 'base64'),
    n: b4a.from(jwk.n, 'base64')
  })
  return { privateKey, publicKeyBlob }
}

test('an agent-held RSA key signs as rsa-sha2-512, with the SHA-2 flag set', async (t) => {
  const home = makeHome(t)
  const { privateKey, publicKeyBlob } = rsaAgentKey()
  const flagsSeen = []
  const env = await fakeAgent(t, home, {
    publicKeyBlob,
    comment: 'rsa@agent',
    sign: (data, flags) => {
      flagsSeen.push(flags)
      return {
        // A well-behaved agent honours the flag; without it the answer would
        // be a SHA-1 `ssh-rsa` signature.
        type: flags === 4 ? 'rsa-sha2-512' : 'ssh-rsa',
        rawSig: b4a.from(crypto.sign('sha512', data, privateKey))
      }
    }
  })

  const [candidate] = await listCandidates({ home, env })
  t.is(candidate.source, 'agent')
  t.is(candidate.keyType, 'ssh-rsa')
  t.is(candidate.signable, true)
  t.is(candidate.reason, null)

  const message = b4a.from('agent-signed rsa claim', 'utf8')
  const result = await signBytes({
    messageBase64: b4a.toString(message, 'base64'),
    publicKeyBlobBase64: candidate.publicKeyBlobBase64,
    env
  })
  t.is(result.via, 'agent')
  t.alike(flagsSeen, [4], 'SSH_AGENT_RSA_SHA2_512 is set on the sign request')
  t.ok(verifySshSignature({ armored: result.signature, message }))
})

test('an agent that ignores the SHA-2 flag and answers ssh-rsa is refused', async (t) => {
  const home = makeHome(t)
  const { privateKey, publicKeyBlob } = rsaAgentKey()
  const env = await fakeAgent(t, home, {
    publicKeyBlob,
    sign: (data) => ({
      type: 'ssh-rsa',
      rawSig: b4a.from(crypto.sign('sha1', data, privateKey))
    })
  })

  await t.exception(
    signBytes({
      messageBase64: b4a.toString(b4a.from('x'), 'base64'),
      publicKeyBlobBase64: b4a.toString(publicKeyBlob, 'base64'),
      env
    }),
    /unsupported signature type: ssh-rsa \(expected rsa-sha2-512\)/
  )
})

test('listCandidates never reads the real home when one is supplied', async (t) => {
  const home = makeHome(t)
  const candidates = await listCandidates({ home, env: NO_AGENT })
  t.is(candidates.length, 0)
})
