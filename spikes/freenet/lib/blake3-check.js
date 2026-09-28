// Node-only cross-check of lib/blake3.js against @noble/hashes. Run: node spikes/freenet/lib/blake3-check.js
const noble = require('@noble/hashes/blake3').blake3
const { blake3 } = require('./blake3')
const crypto = require('crypto')
let bad = 0
for (const n of [0, 1, 63, 64, 65, 1023, 1024, 1025, 2048, 2049, 3072, 4097, 8192, 31744, 181292, 1000003]) {
  const buf = new Uint8Array(crypto.randomBytes(n))
  const same = Buffer.compare(Buffer.from(noble(buf)), Buffer.from(blake3(buf))) === 0
  if (!same) bad++
  console.log(n, same ? 'ok' : 'MISMATCH')
}
process.exit(bad ? 1 : 0)
