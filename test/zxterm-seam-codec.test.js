// codec.js's own test (K7 Step 8): reads the golden `.bin` fixtures Rust's
// own test suite writes (crates/zxterm-core/tests/seam_golden.rs ->
// crates/zxterm-core/tests/seam-golden/*.bin) and asserts codec.js decodes
// them to the expected logical values, for every message kind, and
// re-encodes each back to the exact same bytes.
const fs = require('fs')
const path = require('path')
const test = require('brittle')

const codec = require('../engine/zxterm/codec')

const GOLDEN_DIR = path.join(
  __dirname,
  '..',
  '..',
  'zxterm',
  'crates',
  'zxterm-core',
  'tests',
  'seam-golden'
)

function goldenPath(name) {
  const fromEnv = process.env.ZX_SEAM_GOLDEN_DIR
  const dir = fromEnv || GOLDEN_DIR
  return path.join(dir, `${name}.bin`)
}

function readGolden(name) {
  const file = goldenPath(name)
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file)
}

test('codec.js decodes the Rust-written golden Request fixture', (t) => {
  const bytes = readGolden('request')
  if (!bytes) {
    t.comment(
      'SKIP:',
      `golden fixture missing: ${goldenPath('request')} (run cargo test in zxterm-core with ZX_SEAM_GOLDEN_WRITE=1)`
    )
    return
  }
  const { frame, offset } = codec.decodeFrame(bytes, 0)
  t.is(offset, bytes.length, 'the whole fixture is consumed')
  t.alike(frame, { kind: 'Request', id: '1', method: 'core.version', args: '{}' })
  t.alike(codec.encodeFrame(frame), bytes, 're-encoding matches the checked-in bytes exactly')
})

test('codec.js decodes the Rust-written golden Reply (ok) fixture', (t) => {
  const bytes = readGolden('reply-ok')
  if (!bytes) {
    t.comment('SKIP:', `golden fixture missing: ${goldenPath('reply-ok')}`)
    return
  }
  const { frame, offset } = codec.decodeFrame(bytes, 0)
  t.is(offset, bytes.length)
  t.alike(frame, { kind: 'Reply', id: '1', ok: { ok: true, value: '{"version":"0.1.0"}' } })
  t.is(JSON.parse(frame.ok.value).version, '0.1.0')
  t.alike(codec.encodeFrame(frame), bytes)
})

test('codec.js decodes the Rust-written golden Reply (err) fixture', (t) => {
  const bytes = readGolden('reply-err')
  if (!bytes) {
    t.comment('SKIP:', `golden fixture missing: ${goldenPath('reply-err')}`)
    return
  }
  const { frame, offset } = codec.decodeFrame(bytes, 0)
  t.is(offset, bytes.length)
  t.alike(frame, {
    kind: 'Reply',
    id: '2',
    ok: { ok: false, error: { code: 'E_AUTH', message: 'bad signature' } }
  })
  t.alike(codec.encodeFrame(frame), bytes)
})

test('codec.js decodes the Rust-written golden Event fixture', (t) => {
  const bytes = readGolden('event')
  if (!bytes) {
    t.comment('SKIP:', `golden fixture missing: ${goldenPath('event')}`)
    return
  }
  const { frame, offset } = codec.decodeFrame(bytes, 0)
  t.is(offset, bytes.length)
  t.alike(frame, { kind: 'Event', name: 'resync', data: '{}' })
  t.alike(codec.encodeFrame(frame), bytes)
})

test('codec.js decodes the Rust-written golden Output fixture', (t) => {
  const bytes = readGolden('output')
  if (!bytes) {
    t.comment('SKIP:', `golden fixture missing: ${goldenPath('output')}`)
    return
  }
  const { frame, offset } = codec.decodeFrame(bytes, 0)
  t.is(offset, bytes.length)
  t.is(frame.kind, 'Output')
  t.is(frame.stream, 'test-flood')
  t.alike(Array.from(frame.bytes), [1, 2, 3, 4, 5])
  t.alike(codec.encodeFrame(frame), bytes)
})

test('codec.js decodes the Rust-written golden Chan fixture (K10)', (t) => {
  const bytes = readGolden('chan')
  if (!bytes) {
    t.comment('SKIP:', `golden fixture missing: ${goldenPath('chan')}`)
    return
  }
  const { frame, offset } = codec.decodeFrame(bytes, 0)
  t.is(offset, bytes.length)
  t.is(frame.kind, 'Chan')
  t.is(frame.chan, 300)
  t.alike(Array.from(frame.bytes), [0, 1, 2, 253, 254, 255])
  t.alike(codec.encodeFrame(frame), bytes)
})

test('codec.js round-trips every frame kind it did not just read from disk', (t) => {
  const cases = [
    { kind: 'Request', id: 'x', method: 'identity.self', args: '{"a":1}' },
    { kind: 'Reply', id: 'x', ok: { ok: true, value: '{"ok":true}' } },
    { kind: 'Reply', id: 'x', ok: { ok: false, error: { code: 'E_INTERNAL', message: 'oops' } } },
    { kind: 'Event', name: 'core.ready', data: '{}' },
    { kind: 'Output', stream: 'stdout', bytes: Buffer.from('hello, seam') },
    { kind: 'Chan', chan: 2 ** 33 + 5, bytes: Buffer.alloc(70000, 7) }
  ]
  for (const original of cases) {
    const bytes = codec.encodeFrame(original)
    const { frame, offset } = codec.decodeFrame(bytes, 0)
    t.is(offset, bytes.length)
    t.alike(frame, original)
  }
})

test('FrameDecoder assembles length-prefixed frames from arbitrarily split chunks', (t) => {
  const frame = { kind: 'Event', name: 'resync', data: '{"n":1}' }
  const message = codec.encodeMessage(frame)

  const decoder = new codec.FrameDecoder()
  let out = []
  // Feed it one byte at a time - the hardest possible split.
  for (let i = 0; i < message.length; i++) {
    out = out.concat(decoder.push(message.subarray(i, i + 1)))
  }
  t.is(out.length, 1)
  t.alike(out[0], frame)

  // Two whole messages glued into one chunk.
  const two = Buffer.concat([message, message])
  const decoder2 = new codec.FrameDecoder()
  const both = decoder2.push(two)
  t.is(both.length, 2)
  t.alike(both[0], frame)
  t.alike(both[1], frame)
})
