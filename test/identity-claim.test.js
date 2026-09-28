const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-native')

const {
  NAMESPACE,
  HASH_ALG,
  claimBytes,
  challengeBytes,
  signedDataBlob,
  buildArmoredSignature,
  parseArmoredSignature,
  verifySshSignature,
  encodeEd25519PublicKey,
  encodeRsaPublicKey,
  fingerprint,
  readString,
  writeString,
  signChallenge,
  verifyChallenge
} = require('../engine/identity/claim')

const NO_SSH_KEYGEN = !hasSshKeygen()

const CLAIM = {
  provider: 'github',
  subject: 'octocat',
  identityKey: 'a'.repeat(64),
  authKey: 'b'.repeat(64),
  sshFingerprint: 'SHA256:placeholder',
  issuedAt: 1750000000000,
  nonce: 'c'.repeat(32)
}

test('claim bytes are the frozen canonical encoding', (t) => {
  const bytes = b4a.toString(claimBytes(CLAIM), 'utf8')
  t.is(
    bytes,
    'zbterm-identity-claim/v1\n' +
      'provider=github\n' +
      'subject=octocat\n' +
      `identityKey=${'a'.repeat(64)}\n` +
      `authKey=${'b'.repeat(64)}\n` +
      'sshFingerprint=SHA256:placeholder\n' +
      'issuedAt=1750000000000\n' +
      `nonce=${'c'.repeat(32)}\n`
  )
})

test('challenge bytes are the frozen canonical encoding', (t) => {
  const bytes = b4a.toString(
    challengeBytes({
      sessionId: 'sess-1',
      challengeId: '0'.repeat(32),
      nonce: '1'.repeat(64),
      verifierDhtKey: '2'.repeat(64),
      proverDhtKey: '3'.repeat(64),
      role: 'viewer'
    }),
    'utf8'
  )
  t.is(
    bytes,
    'zbterm-identity-challenge/v1\n' +
      'sessionId=sess-1\n' +
      `challengeId=${'0'.repeat(32)}\n` +
      `nonce=${'1'.repeat(64)}\n` +
      `verifierDhtKey=${'2'.repeat(64)}\n` +
      `proverDhtKey=${'3'.repeat(64)}\n` +
      'role=viewer\n'
  )
  const empty = b4a.toString(
    challengeBytes({
      challengeId: '0'.repeat(32),
      nonce: '1'.repeat(64),
      verifierDhtKey: '2'.repeat(64),
      proverDhtKey: '3'.repeat(64),
      role: 'host'
    }),
    'utf8'
  )
  t.ok(empty.includes('\nsessionId=\n'), 'a missing sessionId encodes as an empty value')
})

test('challenge signatures round trip and reject tampering', (t) => {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  const challenge = {
    sessionId: 'sess-1',
    challengeId: '0'.repeat(32),
    nonce: '1'.repeat(64),
    verifierDhtKey: '2'.repeat(64),
    proverDhtKey: '3'.repeat(64),
    role: 'viewer'
  }
  const signature = signChallenge(secretKey, challenge)

  t.ok(verifyChallenge(publicKey, challenge, signature))
  t.absent(verifyChallenge(publicKey, { ...challenge, role: 'host' }, signature))
  t.absent(verifyChallenge(publicKey, { ...challenge, proverDhtKey: '4'.repeat(64) }, signature))
})

test(
  'our armored claim signature verifies with real ssh-keygen -Y verify',
  { skip: NO_SSH_KEYGEN },
  (t) => {
    const dir = tmpdir(t)
    keygen(t, ['-t', 'ed25519', '-N', '', '-C', 'zbterm-test', '-f', path.join(dir, 'id')])
    const key = parseOpenSshPrivateKey(fs.readFileSync(path.join(dir, 'id'), 'utf8'))

    const claim = { ...CLAIM, sshFingerprint: fingerprint(key.pubkeyBlob) }
    const message = claimBytes(claim)
    const rawSig = b4a.alloc(sodium.crypto_sign_BYTES)
    sodium.crypto_sign_detached(rawSig, signedDataBlob(NAMESPACE, HASH_ALG, message), key.secretKey)
    const armored = buildArmoredSignature({ pubkeyBlob: key.pubkeyBlob, rawSig })

    const msgFile = path.join(dir, 'claim.txt')
    const sigFile = path.join(dir, 'claim.txt.sig')
    const signers = path.join(dir, 'allowed_signers')
    fs.writeFileSync(msgFile, message)
    fs.writeFileSync(sigFile, armored)
    fs.writeFileSync(signers, `zbterm@test ssh-ed25519 ${b4a.toString(key.pubkeyBlob, 'base64')}\n`)

    const verify = spawnSync(
      'ssh-keygen',
      ['-Y', 'verify', '-f', signers, '-I', 'zbterm@test', '-n', NAMESPACE, '-s', sigFile],
      { input: message, encoding: 'utf8' }
    )
    t.is(verify.status, 0, `ssh-keygen -Y verify: ${verify.stdout}${verify.stderr}`)
    t.ok(verifySshSignature({ message, armored }), 'and it verifies with our own verifier')
  }
)

test(
  'a real ssh-keygen -Y sign signature verifies with verifySshSignature',
  { skip: NO_SSH_KEYGEN },
  (t) => {
    const dir = tmpdir(t)
    keygen(t, ['-t', 'ed25519', '-N', '', '-C', 'zbterm-test', '-f', path.join(dir, 'id')])
    const pubkeyBlob = b4a.from(
      fs.readFileSync(path.join(dir, 'id.pub'), 'utf8').split(' ')[1],
      'base64'
    )

    const claim = { ...CLAIM, sshFingerprint: fingerprint(pubkeyBlob) }
    const message = claimBytes(claim)
    const msgFile = path.join(dir, 'claim.txt')
    fs.writeFileSync(msgFile, message)
    const sign = spawnSync(
      'ssh-keygen',
      ['-Y', 'sign', '-f', path.join(dir, 'id'), '-n', NAMESPACE, msgFile],
      { encoding: 'utf8' }
    )
    t.is(sign.status, 0, `ssh-keygen -Y sign: ${sign.stdout}${sign.stderr}`)
    const armored = fs.readFileSync(msgFile + '.sig', 'utf8')

    const parsed = parseArmoredSignature(armored)
    t.is(parsed.namespace, NAMESPACE)
    t.is(parsed.hashAlg, HASH_ALG)
    t.alike(parsed.pubkeyBlob, pubkeyBlob)
    t.ok(verifySshSignature({ message, armored }))
    t.ok(verifySshSignature({ message, armored, expectedPublicKeyBlob: pubkeyBlob }))
    t.absent(
      verifySshSignature({ message, armored, expectedPublicKeyBlob: otherPubkeyBlob() }),
      'a different key is rejected'
    )
    t.absent(verifySshSignature({ message, armored, namespace: 'other' }), 'wrong namespace fails')
    t.absent(verifySshSignature({ message, armored, hashAlg: 'sha256' }), 'wrong hash fails')
  }
)

test('fingerprints match ssh-keygen -lf byte for byte', { skip: NO_SSH_KEYGEN }, (t) => {
  const dir = tmpdir(t)
  keygen(t, ['-t', 'ed25519', '-N', '', '-C', 'zbterm-test', '-f', path.join(dir, 'id')])
  const pub = fs.readFileSync(path.join(dir, 'id.pub'), 'utf8')
  const blob = b4a.from(pub.split(' ')[1], 'base64')
  const listed = spawnSync('ssh-keygen', ['-lf', path.join(dir, 'id.pub')], { encoding: 'utf8' })

  t.is(listed.status, 0, listed.stderr)
  t.is(fingerprint(blob), listed.stdout.split(' ')[1])
  t.is(fingerprint(b4a.toString(blob, 'base64')), listed.stdout.split(' ')[1])
})

test('flipping any claim field breaks verification', { skip: NO_SSH_KEYGEN }, (t) => {
  const dir = tmpdir(t)
  keygen(t, ['-t', 'ed25519', '-N', '', '-f', path.join(dir, 'id')])
  const key = parseOpenSshPrivateKey(fs.readFileSync(path.join(dir, 'id'), 'utf8'))
  const claim = { ...CLAIM, sshFingerprint: fingerprint(key.pubkeyBlob) }
  const rawSig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(
    rawSig,
    signedDataBlob(NAMESPACE, HASH_ALG, claimBytes(claim)),
    key.secretKey
  )
  const armored = buildArmoredSignature({ pubkeyBlob: key.pubkeyBlob, rawSig })

  t.ok(verifySshSignature({ message: claimBytes(claim), armored }))
  const mutations = {
    provider: 'gitlab',
    subject: 'not-octocat',
    identityKey: 'd'.repeat(64),
    authKey: 'e'.repeat(64),
    sshFingerprint: 'SHA256:other',
    issuedAt: 1750000000001,
    nonce: 'f'.repeat(32)
  }
  for (const [key_, value] of Object.entries(mutations)) {
    const tampered = { ...claim, [key_]: value }
    t.absent(
      verifySshSignature({ message: claimBytes(tampered), armored }),
      `tampering with ${key_} fails verification`
    )
  }
})

// Phase 8: RSA claims. `-m PEM` only changes how the *private* half is stored
// (so Node can read it - it cannot parse OpenSSH containers); the .pub half is
// an ordinary `ssh-rsa` line either way.
test(
  'an RSA claim we sign verifies with real ssh-keygen -Y verify',
  { skip: NO_SSH_KEYGEN },
  (t) => {
    const dir = tmpdir(t)
    const file = path.join(dir, 'id_rsa')
    keygen(t, ['-t', 'rsa', '-b', '2048', '-m', 'PEM', '-N', '', '-C', 'zbterm-test', '-f', file])
    const privateKey = crypto.createPrivateKey(fs.readFileSync(file))
    const jwk = privateKey.export({ format: 'jwk' })
    const pubkeyBlob = encodeRsaPublicKey({
      e: b4a.from(jwk.e, 'base64'),
      n: b4a.from(jwk.n, 'base64')
    })
    const published = b4a.from(fs.readFileSync(file + '.pub', 'utf8').split(' ')[1], 'base64')
    t.alike(pubkeyBlob, published, 'encodeRsaPublicKey rebuilds the exact ssh-rsa blob')
    const listed = spawnSync('ssh-keygen', ['-lf', file + '.pub'], { encoding: 'utf8' })
    t.is(listed.status, 0, listed.stderr)
    t.is(fingerprint(pubkeyBlob), listed.stdout.split(' ')[1], 'RSA fingerprint matches -lf')

    const claim = { ...CLAIM, sshFingerprint: fingerprint(pubkeyBlob) }
    const message = claimBytes(claim)
    const rawSig = crypto.sign('sha512', signedDataBlob(NAMESPACE, HASH_ALG, message), privateKey)
    const armored = buildArmoredSignature({ pubkeyBlob, rawSig })
    t.is(parseArmoredSignature(armored).sigType, 'rsa-sha2-512', 'never a bare ssh-rsa signature')

    const msgFile = path.join(dir, 'claim.txt')
    const sigFile = path.join(dir, 'claim.txt.sig')
    const signers = path.join(dir, 'allowed_signers')
    fs.writeFileSync(msgFile, message)
    fs.writeFileSync(sigFile, armored)
    fs.writeFileSync(signers, `zbterm@test ssh-rsa ${b4a.toString(pubkeyBlob, 'base64')}\n`)
    const verify = spawnSync(
      'ssh-keygen',
      ['-Y', 'verify', '-f', signers, '-I', 'zbterm@test', '-n', NAMESPACE, '-s', sigFile],
      { input: message, encoding: 'utf8' }
    )

    t.is(verify.status, 0, `ssh-keygen -Y verify: ${verify.stdout}${verify.stderr}`)
    t.ok(verifySshSignature({ message, armored }), 'and it verifies with our own verifier')
    t.absent(
      verifySshSignature({ message: claimBytes({ ...claim, subject: 'mallory' }), armored }),
      'a tampered RSA claim does not verify'
    )
  }
)

test(
  'a real ssh-keygen -Y sign RSA signature verifies, its SHA-1 variant does not',
  { skip: NO_SSH_KEYGEN },
  (t) => {
    const dir = tmpdir(t)
    const file = path.join(dir, 'id_rsa')
    keygen(t, ['-t', 'rsa', '-b', '2048', '-N', '', '-C', 'zbterm-test', '-f', file])
    const pubkeyBlob = b4a.from(fs.readFileSync(file + '.pub', 'utf8').split(' ')[1], 'base64')
    const claim = { ...CLAIM, sshFingerprint: fingerprint(pubkeyBlob) }
    const message = claimBytes(claim)
    const msgFile = path.join(dir, 'claim.txt')
    fs.writeFileSync(msgFile, message)
    const sign = spawnSync('ssh-keygen', ['-Y', 'sign', '-f', file, '-n', NAMESPACE, msgFile], {
      encoding: 'utf8'
    })
    t.is(sign.status, 0, `ssh-keygen -Y sign: ${sign.stdout}${sign.stderr}`)
    const armored = fs.readFileSync(msgFile + '.sig', 'utf8')

    const parsed = parseArmoredSignature(armored)
    t.is(parsed.sigType, 'rsa-sha2-512')
    t.is(parsed.hashAlg, HASH_ALG)
    t.alike(parsed.pubkeyBlob, pubkeyBlob)
    t.ok(verifySshSignature({ message, armored, expectedPublicKeyBlob: pubkeyBlob }))
    t.absent(verifySshSignature({ message, armored, namespace: 'other' }), 'wrong namespace fails')
    t.absent(
      verifySshSignature({ message: claimBytes({ ...claim, nonce: '9'.repeat(32) }), armored }),
      'a different message fails'
    )
    // Same key, same signature bytes, relabelled as the SHA-1 algorithm: the
    // digest no longer matches what we recompute, and we refuse it by name.
    t.exception(
      () => verifySshSignature({ message, armored: reArmor(parsed, 'ssh-rsa') }),
      /Unsupported SSH signature algorithm: ssh-rsa/,
      'a bare ssh-rsa (SHA-1) SSHSIG is rejected, not accepted'
    )
  }
)

test('an ECDSA SSHSIG is still rejected with a clear error', { skip: NO_SSH_KEYGEN }, (t) => {
  const dir = tmpdir(t)
  keygen(t, ['-t', 'ecdsa', '-N', '', '-f', path.join(dir, 'id_ecdsa')])
  const msgFile = path.join(dir, 'claim.txt')
  const message = claimBytes(CLAIM)
  fs.writeFileSync(msgFile, message)
  const sign = spawnSync(
    'ssh-keygen',
    ['-Y', 'sign', '-f', path.join(dir, 'id_ecdsa'), '-n', NAMESPACE, msgFile],
    { encoding: 'utf8' }
  )
  t.is(sign.status, 0, `ssh-keygen -Y sign: ${sign.stdout}${sign.stderr}`)
  const armored = fs.readFileSync(msgFile + '.sig', 'utf8')

  t.execution(() => parseArmoredSignature(armored), 'the container still parses')
  t.exception(
    () => verifySshSignature({ message, armored }),
    /Unsupported SSH key type: ecdsa-sha2-/,
    'and verification refuses it by name'
  )
})

test('malformed armor is refused, not crashed on', (t) => {
  t.exception(() => parseArmoredSignature('not a signature'), /Malformed SSH signature/)
  t.exception(() => verifySshSignature({ message: 'x', armored: '' }), /Malformed SSH signature/)
})

test('armored signatures wrap base64 at 70 characters', (t) => {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  const rawSig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(rawSig, signedDataBlob(NAMESPACE, HASH_ALG, 'hello'), secretKey)
  const armored = buildArmoredSignature({ pubkeyBlob: encodeEd25519PublicKey(publicKey), rawSig })
  const lines = armored.trim().split('\n')

  t.is(lines[0], '-----BEGIN SSH SIGNATURE-----')
  t.is(lines[lines.length - 1], '-----END SSH SIGNATURE-----')
  for (const line of lines.slice(1, -1)) t.ok(line.length <= 70, 'base64 line is at most 70 chars')
  t.ok(verifySshSignature({ message: 'hello', armored }))
})

// Rebuilds an armored container from its parsed parts with a chosen signature
// algorithm - the only way to get a bare `ssh-rsa` SSHSIG out of a modern
// ssh-keygen, which always signs as rsa-sha2-512.
function reArmor(parsed, sigType) {
  const version = b4a.alloc(4)
  version.writeUInt32BE(1, 0)
  const sigBlob = b4a.concat([writeString(sigType), writeString(parsed.rawSig)])
  const container = b4a.concat([
    b4a.from('SSHSIG', 'ascii'),
    version,
    writeString(parsed.pubkeyBlob),
    writeString(parsed.namespace),
    writeString(''),
    writeString(parsed.hashAlg),
    writeString(sigBlob)
  ])
  const base64 = b4a.toString(container, 'base64')
  const lines = []
  for (let i = 0; i < base64.length; i += 70) lines.push(base64.slice(i, i + 70))
  return (
    ['-----BEGIN SSH SIGNATURE-----', ...lines, '-----END SSH SIGNATURE-----'].join('\n') + '\n'
  )
}

function otherPubkeyBlob() {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return encodeEd25519PublicKey(publicKey)
}

// Minimal reader for an unencrypted OpenSSH ed25519 private key, so the test
// can sign with a key ssh-keygen itself produced.
function parseOpenSshPrivateKey(text) {
  const base64 = text
    .split('\n')
    .filter((line) => line && !line.startsWith('-----'))
    .join('')
  const buffer = b4a.from(base64, 'base64')
  let offset = 'openssh-key-v1\0'.length
  const cipher = readString(buffer, offset)
  offset = cipher.offset
  const kdf = readString(buffer, offset)
  offset = kdf.offset
  const kdfOptions = readString(buffer, offset)
  offset = kdfOptions.offset + 4 // + uint32 key count
  const pubkeyBlob = readString(buffer, offset)
  const priv = readString(buffer, pubkeyBlob.offset)
  const section = priv.value
  const type = readString(section, 8) // skip the two check uint32s
  const pub = readString(section, type.offset)
  const secret = readString(section, pub.offset)
  return {
    pubkeyBlob: b4a.from(pubkeyBlob.value),
    publicKey: b4a.from(pub.value),
    secretKey: b4a.from(secret.value)
  }
}

function keygen(t, args) {
  const result = spawnSync('ssh-keygen', args, { encoding: 'utf8' })
  t.is(result.status, 0, `ssh-keygen ${args.join(' ')}: ${result.stdout}${result.stderr}`)
}

function hasSshKeygen() {
  const result = spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' })
  return !result.error
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-identity-claim-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
