// SSH wire-format byte helpers for building test fixtures (an agent's
// frames, a public-key blob from a JWK). Byte-for-byte the bodies
// `engine/identity/claim.js` had before K9 of zxterm-core moved every
// identity computation into the Rust `zxterm-core` sidecar; a test uses them
// to build inputs, never to compute a value it asserts about.
const crypto = require('crypto')
const b4a = require('b4a')

function writeString(value) {
  const body = b4a.isBuffer(value) ? value : b4a.from(String(value), 'utf8')
  const header = b4a.alloc(4)
  header.writeUInt32BE(body.byteLength, 0)
  return b4a.concat([header, body])
}

function readString(buffer, offset = 0) {
  if (offset + 4 > buffer.byteLength) throw new Error('Truncated SSH string')
  const length = buffer.readUInt32BE(offset)
  const start = offset + 4
  const end = start + length
  if (end > buffer.byteLength) throw new Error('Truncated SSH string')
  return { value: buffer.subarray(start, end), offset: end }
}

function stripMpint(value) {
  const raw = b4a.isBuffer(value) ? value : b4a.from(value, 'hex')
  let at = 0
  while (at < raw.byteLength - 1 && raw[at] === 0) at++
  return b4a.from(raw.subarray(at))
}

function writeMpint(value) {
  const raw = stripMpint(value)
  if (raw.byteLength && (raw[0] & 0x80) !== 0) {
    return writeString(b4a.concat([b4a.alloc(1), raw]))
  }
  return writeString(raw)
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex')
}

module.exports = { writeString, readString, writeMpint, stripMpint, randomHex }
