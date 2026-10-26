// Fixture builder for test/ssh-keys.test.js: writes a fresh, unencrypted
// OpenSSH (`openssh-key-v1`) ed25519 private key plus its `.pub`, and hands
// back the key material so an in-process fake ssh-agent can sign with it.
// Before K9 of zxterm-core the test read the secret back with
// `parseOpenSshPrivateKey`; the core's `identity.sshParsePrivateKey` seam
// method never returns a secret, so the test now owns the key from the start.
// Only fixture bytes are built here - nothing the test asserts about.
const fs = require('fs')
const b4a = require('b4a')
const sodium = require('sodium-native')

const { writeString } = require('./ssh-wire')

const MAGIC = 'openssh-key-v1\0'
const BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----'
const END = '-----END OPENSSH PRIVATE KEY-----'

function uint32(value) {
  const buf = b4a.alloc(4)
  buf.writeUInt32BE(value >>> 0, 0)
  return buf
}

function writeEd25519Key(file, comment) {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  const publicKeyBlob = b4a.concat([writeString('ssh-ed25519'), writeString(publicKey)])

  const check = b4a.alloc(4)
  sodium.randombytes_buf(check)
  let section = b4a.concat([
    check,
    check,
    writeString('ssh-ed25519'),
    writeString(publicKey),
    writeString(secretKey),
    writeString(comment)
  ])
  const pad = []
  for (let i = 1; (section.byteLength + pad.length) % 8 !== 0; i++) pad.push(i)
  section = b4a.concat([section, b4a.from(pad)])

  const body = b4a.concat([
    b4a.from(MAGIC, 'binary'),
    writeString('none'),
    writeString('none'),
    writeString(b4a.alloc(0)),
    uint32(1),
    writeString(publicKeyBlob),
    writeString(section)
  ])
  const lines = b4a.toString(body, 'base64').match(/.{1,70}/g)
  fs.writeFileSync(file, [BEGIN, ...lines, END, ''].join('\n'), { mode: 0o600 })
  fs.writeFileSync(
    file + '.pub',
    `ssh-ed25519 ${b4a.toString(publicKeyBlob, 'base64')} ${comment}\n`
  )
  return { publicKeyBlob, secretKey }
}

module.exports = { writeEd25519Key }
