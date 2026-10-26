// A hand-written `postcard` decoder/encoder for exactly the zxterm-core
// seam's message shapes (K7, spike S3). `postcard` is a compact binary
// format (varint-encoded lengths, no schema negotiation); there is no npm
// package for it, so this is a small hand-rolled codec, not a dependency
// (K7's own Requirements & inputs).
//
// Wire shapes, matching `crates/zxterm-core/src/seam/protocol.rs::Frame`
// exactly (variant index is one LEB128 varint, struct fields follow in
// declaration order with no field tags — verified against this codec's own
// test, which reads the golden `.bin` files that crate's own tests write):
//
//   0 Request { id: string, method: string, args: string }
//   1 Reply   { id: string, ok: Result<string, WireError> }
//              (Result is postcard's own 2-variant enum: 0 = Ok(string), 1 = Err(WireError))
//   2 Event   { name: string, data: string }
//   3 Output  { stream: string, bytes: Buffer }
//   4 Chan    { chan: u64 (varint), bytes: Buffer }   (K10: raw channel
//              bytes of the Freenet transport service, both directions,
//              never dropped)
//   WireError { code: string, message: string }
//
// Every payload field (`args`, a `Reply`'s `Ok`/`Err` value, `data`) is
// carried as JSON *text*, not a nested postcard value — see
// `protocol.rs`'s own doc comment for why (`postcard` is not
// self-describing). This codec never parses that text itself: callers
// (`client.js`) do, once they know which method's reply shape to expect.

'use strict'

function readVarint(buf, offset) {
  let result = 0
  let shift = 0
  let pos = offset
  for (;;) {
    if (pos >= buf.length) throw new Error('postcard: truncated varint')
    const byte = buf[pos]
    pos++
    result += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) break
    shift += 7
    if (shift > 35) throw new Error('postcard: varint too long for this codec')
  }
  return { value: result, offset: pos }
}

function writeVarint(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`postcard: cannot varint-encode ${value}`)
  }
  const bytes = []
  let remaining = value
  do {
    let byte = remaining % 128
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return Buffer.from(bytes)
}

function readString(buf, offset) {
  const len = readVarint(buf, offset)
  const start = len.offset
  const end = start + len.value
  if (end > buf.length) throw new Error('postcard: truncated string')
  return { value: buf.toString('utf8', start, end), offset: end }
}

function writeString(str) {
  const body = Buffer.from(String(str), 'utf8')
  return Buffer.concat([writeVarint(body.length), body])
}

function readBytes(buf, offset) {
  const len = readVarint(buf, offset)
  const start = len.offset
  const end = start + len.value
  if (end > buf.length) throw new Error('postcard: truncated byte string')
  return { value: buf.subarray(start, end), offset: end }
}

function writeBytes(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return Buffer.concat([writeVarint(body.length), body])
}

function readWireError(buf, offset) {
  const code = readString(buf, offset)
  const message = readString(buf, code.offset)
  return { value: { code: code.value, message: message.value }, offset: message.offset }
}

function writeWireError(err) {
  return Buffer.concat([writeString(err.code), writeString(err.message)])
}

// Decodes exactly one `Frame` starting at `offset` (default 0). Returns
// `{ frame, offset }`, where `offset` is just past the frame's last byte —
// `FrameDecoder` uses this to find the next frame in a longer buffer.
function decodeFrame(buf, offset = 0) {
  const variant = readVarint(buf, offset)
  switch (variant.value) {
    case 0: {
      const id = readString(buf, variant.offset)
      const method = readString(buf, id.offset)
      const args = readString(buf, method.offset)
      return {
        frame: { kind: 'Request', id: id.value, method: method.value, args: args.value },
        offset: args.offset
      }
    }
    case 1: {
      const id = readString(buf, variant.offset)
      const tag = readVarint(buf, id.offset)
      if (tag.value === 0) {
        const value = readString(buf, tag.offset)
        return {
          frame: { kind: 'Reply', id: id.value, ok: { ok: true, value: value.value } },
          offset: value.offset
        }
      }
      if (tag.value === 1) {
        const err = readWireError(buf, tag.offset)
        return {
          frame: { kind: 'Reply', id: id.value, ok: { ok: false, error: err.value } },
          offset: err.offset
        }
      }
      throw new Error(`postcard: unknown Result variant ${tag.value} in Reply`)
    }
    case 2: {
      const name = readString(buf, variant.offset)
      const data = readString(buf, name.offset)
      return { frame: { kind: 'Event', name: name.value, data: data.value }, offset: data.offset }
    }
    case 3: {
      const stream = readString(buf, variant.offset)
      const bytes = readBytes(buf, stream.offset)
      return {
        frame: { kind: 'Output', stream: stream.value, bytes: Buffer.from(bytes.value) },
        offset: bytes.offset
      }
    }
    case 4: {
      const chan = readVarint(buf, variant.offset)
      const bytes = readBytes(buf, chan.offset)
      return {
        frame: { kind: 'Chan', chan: chan.value, bytes: Buffer.from(bytes.value) },
        offset: bytes.offset
      }
    }
    default:
      throw new Error(`postcard: unknown Frame variant ${variant.value}`)
  }
}

// Encodes one frame object (the same shape `decodeFrame` returns) to its
// raw `postcard` bytes (no length prefix).
function encodeFrame(frame) {
  switch (frame.kind) {
    case 'Request':
      return Buffer.concat([
        writeVarint(0),
        writeString(frame.id),
        writeString(frame.method),
        writeString(frame.args)
      ])
    case 'Reply': {
      const isOk = !!(frame.ok && frame.ok.ok)
      const tag = writeVarint(isOk ? 0 : 1)
      const payload = isOk ? writeString(frame.ok.value) : writeWireError(frame.ok.error)
      return Buffer.concat([writeVarint(1), writeString(frame.id), tag, payload])
    }
    case 'Event':
      return Buffer.concat([writeVarint(2), writeString(frame.name), writeString(frame.data)])
    case 'Output':
      return Buffer.concat([writeVarint(3), writeString(frame.stream), writeBytes(frame.bytes)])
    case 'Chan':
      return Buffer.concat([writeVarint(4), writeVarint(frame.chan), writeBytes(frame.bytes)])
    default:
      throw new Error(`codec.js: unknown frame kind ${frame && frame.kind}`)
  }
}

// The socket-level framing (`protocol.rs::write_frame`/`read_frame`): a
// `u32` little-endian byte length of `encodeFrame(frame)`, then the
// encoding itself.
function encodeMessage(frame) {
  const body = encodeFrame(frame)
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

// Incremental length-prefixed frame decoder for a byte stream: `push(chunk)`
// returns every complete frame now available (zero, one or several), and
// buffers a partial one for the next call. `client.js` feeds this socket
// data directly.
class FrameDecoder {
  constructor() {
    this._buf = Buffer.alloc(0)
  }

  push(chunk) {
    this._buf = this._buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this._buf, chunk])
    const frames = []
    for (;;) {
      if (this._buf.length < 4) break
      const len = this._buf.readUInt32LE(0)
      if (this._buf.length < 4 + len) break
      const body = this._buf.subarray(4, 4 + len)
      const { frame } = decodeFrame(body, 0)
      frames.push(frame)
      this._buf = this._buf.subarray(4 + len)
    }
    return frames
  }
}

module.exports = {
  readVarint,
  writeVarint,
  readString,
  writeString,
  readBytes,
  writeBytes,
  decodeFrame,
  encodeFrame,
  encodeMessage,
  FrameDecoder
}
