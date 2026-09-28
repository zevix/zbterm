const test = require('brittle')

const SessionEngine = require('../engine')

test('archive packetizer helpers detect terminal boundaries', (t) => {
  const { ARCHIVE_PROFILES, byteLength, hasTerminalBoundary } = SessionEngine._test

  t.is(byteLength([Buffer.from('abc'), Buffer.from('defg')]), 7)
  t.is(hasTerminalBoundary(Buffer.from('plain text')), false)
  t.is(hasTerminalBoundary(Buffer.from('line\n')), true)
  t.is(hasTerminalBoundary(Buffer.from('carriage\r')), true)
  t.is(hasTerminalBoundary(Buffer.from([0x1b, 0x5b, 0x48, 0x07])), true)
  t.is(ARCHIVE_PROFILES.hd.maxMs, 50)
  t.ok(ARCHIVE_PROFILES.hd.maxMs < ARCHIVE_PROFILES.normal.maxMs)
})
