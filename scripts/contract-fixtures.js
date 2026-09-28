#!/usr/bin/env node
// Writes the `fdev verify-merge` corpus of ZBTerm's Freenet contracts
// (engine/backends/freenet/contracts/src/{signalling,pointer}/): params.json
// and states/*.json of each crate, signed with fixed seeds so the files are
// the same on every run (ed25519 signatures are deterministic). The contract
// sources document the signed bytes; signEntry()/signRecord() below produce
// them the same way.
//
//   node scripts/contract-fixtures.js
//
// Signalling states s0-s5 are the P-5 probe's corpus with signed v:/h: roles;
// s6 carries a mis-signed entry (invalid on its own), s7 replays an older
// signed entry under an existing (l, r, s), s8 + s9 give one viewer key 17
// entries, s10 + s11 give the host 65 h: entries. Pointer states: p0 empty,
// p1-p3 valid records (p3 ties p2's ver), p4 mis-signed.
const fs = require('fs')
const path = require('path')
const sodium = require('sodium-native')

const SRC = path.join(__dirname, '..', 'engine', 'backends', 'freenet', 'contracts', 'src')

function keyPair(byte) {
  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, Buffer.alloc(32, byte))
  return { publicKey, secretKey, hex: publicKey.toString('hex') }
}

function sign(secretKey, message) {
  const signature = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, message, secretKey)
  return signature.toString('hex')
}

// u32le(len(x)) ‖ x
function lp(bytes) {
  const len = Buffer.alloc(4)
  len.writeUInt32LE(bytes.length)
  return Buffer.concat([len, bytes])
}

function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function u64(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

// "zbterm/fnet-signal/1" ‖ lp(params) ‖ lp(l) ‖ lp(r) ‖ u32le(s) ‖ u64le(t) ‖ u8(d) ‖ lp(p)
function entryBytes(params, e) {
  return Buffer.concat([
    Buffer.from('zbterm/fnet-signal/1'),
    lp(params),
    lp(Buffer.from(e.l)),
    lp(Buffer.from(e.r)),
    u32(e.s),
    u64(e.t),
    Buffer.from([e.d ? 1 : 0]),
    lp(Buffer.from(e.p))
  ])
}

// Returns the entry in wire field order, `g` set.
function signEntry(secretKey, params, { l, r, s, t, d = false, p = '' }) {
  const e = { l, r, s, t, d, p }
  return { ...e, g: sign(secretKey, entryBytes(params, e)) }
}

// "zbterm/fnet-pointer/1" ‖ lp(own params) ‖ u64le(ver) ‖ lp(sig) ‖ lp(code) ‖ lp(params)
function recordBytes(ownParams, rec) {
  return Buffer.concat([
    Buffer.from('zbterm/fnet-pointer/1'),
    lp(ownParams),
    u64(rec.ver),
    lp(Buffer.from(rec.sig)),
    lp(Buffer.from(rec.code)),
    lp(Buffer.from(rec.params))
  ])
}

function signRecord(secretKey, ownParams, { ver, sig, code, params }) {
  const rec = { ver, sig, code, params }
  return { ...rec, g: sign(secretKey, recordBytes(ownParams, rec)) }
}

// The contract's canonical order: by (l, r, s).
function wire(entries) {
  const sorted = [...entries].sort((a, b) =>
    a.l !== b.l ? (a.l < b.l ? -1 : 1) : a.r !== b.r ? (a.r < b.r ? -1 : 1) : a.s - b.s
  )
  return JSON.stringify({ e: sorted })
}

function writeCorpus(crate, params, states) {
  const dir = path.join(SRC, crate)
  fs.writeFileSync(path.join(dir, 'params.json'), params)
  const statesDir = path.join(dir, 'states')
  fs.rmSync(statesDir, { recursive: true, force: true })
  fs.mkdirSync(statesDir)
  for (const [name, text] of Object.entries(states)) {
    fs.writeFileSync(path.join(statesDir, `${name}.json`), text)
  }
}

function signalling() {
  const host = keyPair(1)
  const [v1, v2, v3, v4] = [2, 3, 4, 5].map(keyPair)
  const params = Buffer.from(
    JSON.stringify({ ttl_ms: 120000, host: host.hex, n: 'zbterm-f5-verify-merge' })
  )
  const v = (kp, e) => signEntry(kp.secretKey, params, { ...e, r: `v:${kp.hex}` })
  const h = (viewer, e) => signEntry(host.secretKey, params, { ...e, r: `h:${viewer.hex}` })
  const quota = []
  for (let s = 0; s < 16; s++) quota.push(v(v3, { l: 'link1', s, t: 3000 + s, p: `q${s}` }))
  const answers = []
  for (let i = 0; i < 64; i++) {
    answers.push(h([v1, v2, v3, v4][i % 4], { l: 'link1', s: i, t: 4000 + i, p: `a${i}` }))
  }
  const forged = v(v2, { l: 'link1', s: 0, t: 1800, p: 'forged' })
  forged.g = v(v3, { l: 'link1', s: 0, t: 1800, p: 'forged' }).g
  const states = {
    s0: wire([]),
    s1: wire([v(v1, { l: 'link1', s: 0, t: 1000, p: 'offer-A' })]),
    s2: wire([
      v(v1, { l: 'link1', s: 0, t: 2000, p: 'offer-B' }),
      h(v1, { l: 'link1', s: 0, t: 1500, p: 'answer' })
    ]),
    s3: wire([v(v1, { l: 'link2', s: 1, t: 130000, p: 'late' })]),
    s4: wire([
      v(v1, { l: 'link1', s: 0, t: 2000, d: true }),
      v(v2, { l: 'link3', s: 0, t: 2500, p: 'x' })
    ]),
    s5: wire([
      v(v1, { l: 'link1', s: 0, t: 2000, p: 'offer-C' }),
      v(v2, { l: 'link3', s: 0, t: 121500, p: 'y' })
    ]),
    s6: wire([forged]),
    s7: wire([v(v1, { l: 'link1', s: 0, t: 500, p: 'offer-old' })]),
    s8: wire(quota),
    s9: wire([v(v3, { l: 'link1', s: 16, t: 3016, p: 'q16' })]),
    s10: wire(answers),
    s11: wire([h(v1, { l: 'link1', s: 100, t: 4100, p: 'a64' })])
  }
  writeCorpus('signalling', params, states)
  return Object.keys(states).length
}

function pointer() {
  const host = keyPair(1)
  const other = keyPair(6)
  const own = Buffer.from(JSON.stringify({ host: host.hex }))
  const target = (n) => ({
    sig: `instance-${n}`,
    code: 'ab'.repeat(32),
    params: JSON.stringify({ ttl_ms: 120000, host: host.hex, n: `n${n}` })
  })
  const states = {
    p0: '',
    p1: JSON.stringify(signRecord(host.secretKey, own, { ver: 1, ...target(1) })),
    p2: JSON.stringify(signRecord(host.secretKey, own, { ver: 2, ...target(2) })),
    p3: JSON.stringify(signRecord(host.secretKey, own, { ver: 2, ...target(3) })),
    p4: JSON.stringify(signRecord(other.secretKey, own, { ver: 9, ...target(4) }))
  }
  writeCorpus('pointer', own, states)
  return Object.keys(states).length
}

if (require.main === module) {
  console.log(`signalling: ${signalling()} states; pointer: ${pointer()} states`)
}

module.exports = { keyPair, entryBytes, signEntry, recordBytes, signRecord, wire }
