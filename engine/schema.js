const c = require('compact-encoding')
const { EngineError, CODES } = require('./errors')

const VERSION = 2

const PacketKind = {
  DATA: 0,
  RESIZE: 1,
  MARKER: 2
}

const PacketKindName = ['DATA', 'RESIZE', 'MARKER']

const Flags = {
  COLS: 1,
  ROWS: 2,
  PAYLOAD: 4,
  HD: 8
}

const StoredPacket = {
  preencode(state, packet) {
    c.uint.preencode(state, packet.version)
    c.uint.preencode(state, packet.epoch)
    c.uint64.preencode(state, packet.seq)
    c.buffer.preencode(state, packet.ciphertext)
  },
  encode(state, packet) {
    c.uint.encode(state, packet.version)
    c.uint.encode(state, packet.epoch)
    c.uint64.encode(state, packet.seq)
    c.buffer.encode(state, packet.ciphertext)
  },
  decode(state) {
    const version = c.uint.decode(state)
    if (version !== VERSION) throw new Error('Unknown OutputPacket version')
    return {
      version,
      epoch: c.uint.decode(state),
      seq: Number(c.uint64.decode(state)),
      ciphertext: c.buffer.decode(state)
    }
  }
}

const PlainPacket = {
  preencode(state, packet) {
    c.uint.preencode(state, packet.version)
    c.uint64.preencode(state, packet.tsMs)
    c.uint.preencode(state, packet.kind)
    let flags = 0
    if (packet.cols !== undefined && packet.cols !== null) flags |= Flags.COLS
    if (packet.rows !== undefined && packet.rows !== null) flags |= Flags.ROWS
    if (packet.payload && packet.payload.byteLength) flags |= Flags.PAYLOAD
    if (packet.hd) flags |= Flags.HD
    c.uint.preencode(state, flags)
    if (flags & Flags.COLS) c.uint.preencode(state, packet.cols)
    if (flags & Flags.ROWS) c.uint.preencode(state, packet.rows)
    if (flags & Flags.PAYLOAD) c.buffer.preencode(state, packet.payload)
  },
  encode(state, packet) {
    c.uint.encode(state, packet.version)
    c.uint64.encode(state, packet.tsMs)
    c.uint.encode(state, packet.kind)
    let flags = 0
    if (packet.cols !== undefined && packet.cols !== null) flags |= Flags.COLS
    if (packet.rows !== undefined && packet.rows !== null) flags |= Flags.ROWS
    if (packet.payload && packet.payload.byteLength) flags |= Flags.PAYLOAD
    if (packet.hd) flags |= Flags.HD
    c.uint.encode(state, flags)
    if (flags & Flags.COLS) c.uint.encode(state, packet.cols)
    if (flags & Flags.ROWS) c.uint.encode(state, packet.rows)
    if (flags & Flags.PAYLOAD) c.buffer.encode(state, packet.payload)
  },
  decode(state) {
    const version = c.uint.decode(state)
    if (version !== VERSION) throw new Error('Unknown plain packet version')
    const tsMs = Number(c.uint64.decode(state))
    const kind = c.uint.decode(state)
    const flags = c.uint.decode(state)
    return {
      version,
      tsMs,
      kind,
      cols: flags & Flags.COLS ? c.uint.decode(state) : null,
      rows: flags & Flags.ROWS ? c.uint.decode(state) : null,
      payload: flags & Flags.PAYLOAD ? c.buffer.decode(state) : Buffer.alloc(0),
      hd: (flags & Flags.HD) !== 0
    }
  }
}

const SessionInfo = {
  preencode(state, info) {
    c.uint.preencode(state, info.version)
    c.string.preencode(state, info.name)
    c.uint64.preencode(state, info.createdAt)
    c.uint.preencode(state, info.flags && info.flags.sensitive ? 1 : 0)
    c.uint.preencode(state, info.flags ? info.flags.quickCatchupKB || 0 : 0)
    c.uint.preencode(state, info.cols)
    c.uint.preencode(state, info.rows)
  },
  encode(state, info) {
    c.uint.encode(state, info.version)
    c.string.encode(state, info.name)
    c.uint64.encode(state, info.createdAt)
    c.uint.encode(state, info.flags && info.flags.sensitive ? 1 : 0)
    c.uint.encode(state, info.flags ? info.flags.quickCatchupKB || 0 : 0)
    c.uint.encode(state, info.cols)
    c.uint.encode(state, info.rows)
  },
  decode(state) {
    const version = c.uint.decode(state)
    if (version !== VERSION) throw new Error('Unknown SessionInfo version')
    return {
      version,
      name: c.string.decode(state),
      createdAt: Number(c.uint64.decode(state)),
      flags: {
        sensitive: c.uint.decode(state) !== 0,
        quickCatchupKB: c.uint.decode(state)
      },
      cols: c.uint.decode(state),
      rows: c.uint.decode(state)
    }
  }
}

const JsonRecord = {
  preencode(state, record) {
    c.buffer.preencode(state, Buffer.from(JSON.stringify(record)))
  },
  encode(state, record) {
    c.buffer.encode(state, Buffer.from(JSON.stringify(record)))
  },
  decode(state) {
    const record = JSON.parse(c.buffer.decode(state).toString('utf8'))
    assertKnownVersion(record)
    return record
  }
}

const AccountProfile = versionedJsonCodec('AccountProfile')
const AccountDevice = versionedJsonCodec('AccountDevice')
const DeviceRevocation = versionedJsonCodec('DeviceRevocation')
const AddDeviceInviteIssuer = versionedJsonCodec('AddDeviceInviteIssuer')
const OwnDeviceSessionCard = versionedJsonCodec('OwnDeviceSessionCard')
const SessionMember = versionedJsonCodec('SessionMember')
const EpochRecord = versionedJsonCodec('EpochRecord')
const KeyEnvelopePayload = versionedJsonCodec('KeyEnvelopePayload')

function encode(codec, value) {
  return c.encode(codec, value)
}

function decode(codec, value) {
  return c.decode(codec, value)
}

function versionedJsonCodec(name) {
  return {
    preencode(state, record) {
      assertKnownVersion(record, name)
      JsonRecord.preencode(state, record)
    },
    encode(state, record) {
      assertKnownVersion(record, name)
      JsonRecord.encode(state, record)
    },
    decode(state) {
      const record = JsonRecord.decode(state)
      assertKnownVersion(record, name)
      return record
    }
  }
}

function assertKnownVersion(record, name = 'record') {
  if (!record || record.version !== VERSION) {
    throw new EngineError(CODES.E_CORRUPT, `Unsupported ${name} version`)
  }
}

module.exports = {
  VERSION,
  PacketKind,
  PacketKindName,
  StoredPacket,
  PlainPacket,
  SessionInfo,
  AccountProfile,
  AccountDevice,
  DeviceRevocation,
  AddDeviceInviteIssuer,
  OwnDeviceSessionCard,
  SessionMember,
  EpochRecord,
  KeyEnvelopePayload,
  assertKnownVersion,
  encode,
  decode
}
