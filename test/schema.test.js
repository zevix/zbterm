const test = require('brittle')
const b4a = require('b4a')

const {
  VERSION,
  PacketKind,
  StoredPacket,
  PlainPacket,
  SessionInfo,
  AccountProfile,
  AccountDevice,
  KeyEnvelopePayload,
  encode,
  decode
} = require('../engine/schema')

test('schema round trips and golden vectors match', (t) => {
  const plain = {
    version: VERSION,
    tsMs: 1700000000000,
    kind: PacketKind.DATA,
    cols: null,
    rows: null,
    payload: b4a.from('abc'),
    hd: false
  }
  const hdPlain = { ...plain, hd: true }
  const stored = {
    version: VERSION,
    epoch: 1,
    seq: 1,
    ciphertext: b4a.from('001122', 'hex')
  }
  const info = {
    version: VERSION,
    name: 'demo',
    createdAt: 1700000000000,
    flags: { sensitive: false, quickCatchupKB: 0 },
    cols: 80,
    rows: 24
  }

  t.is(encode(PlainPacket, plain).toString('hex'), '020068e5cf8b010000000403616263')
  t.is(encode(PlainPacket, hdPlain).toString('hex'), '020068e5cf8b010000000c03616263')
  t.is(encode(StoredPacket, stored).toString('hex'), '0201010000000000000003001122')
  t.is(encode(SessionInfo, info).toString('hex'), '020464656d6f0068e5cf8b01000000005018')
  t.alike(decode(PlainPacket, encode(PlainPacket, plain)), plain)
  t.alike(decode(PlainPacket, encode(PlainPacket, hdPlain)), hdPlain)
  t.alike(decode(StoredPacket, encode(StoredPacket, stored)), stored)
  t.alike(decode(SessionInfo, encode(SessionInfo, info)), info)
})

test('schema rejects truncated input', (t) => {
  t.exception(() => decode(PlainPacket, b4a.from('0100', 'hex')))
  t.exception(() => decode(StoredPacket, b4a.from('0101', 'hex')))
})

test('phase 3 versioned records round trip and reject future versions', (t) => {
  const profile = {
    version: VERSION,
    identityKey: 'aa',
    localDeviceKey: 'bb',
    deviceKeys: ['bb']
  }
  const device = {
    version: VERSION,
    deviceKey: 'bb',
    dhtKey: 'cc',
    identityProof: 'dd',
    status: 'active'
  }
  const envelope = {
    version: VERSION,
    sessionId: 's',
    epoch: 1,
    caps: 3,
    liveKey: 'live',
    historyKey: null
  }

  t.alike(decode(AccountProfile, encode(AccountProfile, profile)), profile)
  t.alike(decode(AccountDevice, encode(AccountDevice, device)), device)
  t.alike(decode(KeyEnvelopePayload, encode(KeyEnvelopePayload, envelope)), envelope)
  t.exception(() => encode(AccountProfile, { ...profile, version: VERSION + 1 }))
  t.exception(() => decode(AccountDevice, encode(AccountDevice, device).subarray(0, 3)))
})
