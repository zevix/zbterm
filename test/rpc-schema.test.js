const test = require('brittle')
const fs = require('fs')
const path = require('path')
const {
  FrameKind,
  FrameKindName,
  LOW_RATE_EVENTS,
  EVENT_DATA_NAMES,
  encodeFrame,
  decodeFrame
} = require('../engine/rpc/schema')

function roundTrip(t, kind, id, body, expected = body) {
  const buf = encodeFrame(kind, id, body)
  const decoded = decodeFrame(buf)
  t.is(decoded.kind, kind, `${FrameKindName[kind]} kind round trips`)
  t.is(decoded.id, id, `${FrameKindName[kind]} id round trips`)
  t.alike(decoded.body, expected, `${FrameKindName[kind]} body round trips`)
}

test('INVOKE round trips method + json args', (t) => {
  roundTrip(t, FrameKind.INVOKE, 1, { method: 'session.create', args: { cols: 80, rows: 24 } })
})

test('REPLY_OK round trips a json result', (t) => {
  roundTrip(t, FrameKind.REPLY_OK, 1, { result: { sessionId: 'abc', ok: true } })
})

test('REPLY_ERR round trips an EngineError.toJSON() shape', (t) => {
  roundTrip(t, FrameKind.REPLY_ERR, 1, {
    error: { name: 'EngineError', code: 'E_INTERNAL', message: 'boom', details: { foo: 1 } }
  })
})

test('EVENT_JSON round trips a low-rate event', (t) => {
  roundTrip(t, FrameKind.EVENT_JSON, 0, {
    name: 'share:changed',
    data: { sessionId: 's1', links: [] }
  })
})

test('EVENT_DATA round trips session:data (pty source)', (t) => {
  roundTrip(
    t,
    FrameKind.EVENT_DATA,
    0,
    { name: 'session:data', sessionId: 's1', hd: false, source: 'pty', data: Buffer.from('hi') },
    {
      name: 'session:data',
      sessionId: 's1',
      hd: false,
      source: 'pty',
      seq: null,
      tsMs: null,
      kind: null,
      cols: null,
      rows: null,
      data: Buffer.from('hi')
    }
  )
})

test('EVENT_DATA round trips session:data (socket source)', (t) => {
  roundTrip(
    t,
    FrameKind.EVENT_DATA,
    0,
    {
      name: 'session:data',
      sessionId: 's1',
      hd: true,
      source: 'socket',
      data: Buffer.from('yo')
    },
    {
      name: 'session:data',
      sessionId: 's1',
      hd: true,
      source: 'socket',
      seq: null,
      tsMs: null,
      kind: null,
      cols: null,
      rows: null,
      data: Buffer.from('yo')
    }
  )
})

test('EVENT_DATA round trips player:data (richer shape, multi-byte-boundary payload)', (t) => {
  const data = Buffer.alloc(70000, 7) // crosses a multi-byte varint length boundary
  roundTrip(
    t,
    FrameKind.EVENT_DATA,
    0,
    {
      name: 'player:data',
      sessionId: 's2',
      hd: false,
      seq: 42,
      tsMs: 1700000000000,
      kind: 0,
      cols: 80,
      rows: 24,
      data
    },
    {
      name: 'player:data',
      sessionId: 's2',
      hd: false,
      source: null,
      seq: 42,
      tsMs: 1700000000000,
      kind: 0,
      cols: 80,
      rows: 24,
      data
    }
  )
})

test('EVENT_DATA round trips a null data payload (player:end-adjacent non-DATA packet)', (t) => {
  roundTrip(
    t,
    FrameKind.EVENT_DATA,
    0,
    {
      name: 'player:data',
      sessionId: 's2',
      hd: false,
      seq: 1,
      tsMs: 1,
      kind: 1,
      cols: null,
      rows: null,
      data: null
    },
    {
      name: 'player:data',
      sessionId: 's2',
      hd: false,
      source: null,
      seq: 1,
      tsMs: 1,
      kind: 1,
      cols: null,
      rows: null,
      data: null
    }
  )
})

test('PTY_SPAWN round trips with and without optional shell/cwd', (t) => {
  roundTrip(
    t,
    FrameKind.PTY_SPAWN,
    5,
    { sessionId: 's1', cols: 80, rows: 24, shell: '/bin/bash', cwd: '/home/x' },
    { sessionId: 's1', cols: 80, rows: 24, shell: '/bin/bash', cwd: '/home/x', command: null }
  )
  roundTrip(
    t,
    FrameKind.PTY_SPAWN,
    5,
    { sessionId: 's1', cols: 80, rows: 24 },
    { sessionId: 's1', cols: 80, rows: 24, shell: null, cwd: null, command: null }
  )
  roundTrip(t, FrameKind.PTY_SPAWN, 5, {
    sessionId: 's1',
    cols: 80,
    rows: 24,
    shell: null,
    cwd: '~/src',
    command: 'htop -d 5'
  })
})

test('PTY_WRITE / PTY_DATA round trip sessionId + buffer', (t) => {
  roundTrip(t, FrameKind.PTY_WRITE, 0, { sessionId: 's1', data: Buffer.from('echo hi\n') })
  roundTrip(t, FrameKind.PTY_DATA, 0, { sessionId: 's1', data: Buffer.from('output') })
})

test('PTY_RESIZE round trips cols/rows', (t) => {
  roundTrip(t, FrameKind.PTY_RESIZE, 0, { sessionId: 's1', cols: 120, rows: 40 })
})

test('PTY_KILL / PTY_PAUSE / PTY_RESUME round trip sessionId only', (t) => {
  roundTrip(t, FrameKind.PTY_KILL, 0, { sessionId: 's1' })
  roundTrip(t, FrameKind.PTY_PAUSE, 0, { sessionId: 's1' })
  roundTrip(t, FrameKind.PTY_RESUME, 0, { sessionId: 's1' })
})

test('PTY_EXIT round trips code+signal, and nullable variants', (t) => {
  roundTrip(t, FrameKind.PTY_EXIT, 0, { sessionId: 's1', code: 0, signal: null })
  roundTrip(t, FrameKind.PTY_EXIT, 0, { sessionId: 's1', code: null, signal: 9 })
})

test('decodeFrame throws cleanly on a truncated buffer', (t) => {
  t.exception(() => decodeFrame(Buffer.alloc(0)))
  t.exception(() => decodeFrame(Buffer.from([0, 0])))
  t.exception(() => decodeFrame(Buffer.from([FrameKind.INVOKE, 0, 0, 0, 0])))
})

test('decodeFrame throws cleanly on an unknown kind byte', (t) => {
  t.exception(() => decodeFrame(Buffer.from([200, 0, 0, 0, 0])))
})

test('decodeFrame throws cleanly on a valid kind with a corrupted/short body', (t) => {
  const good = encodeFrame(FrameKind.PTY_KILL, 0, { sessionId: 'abc' })
  t.exception(() => decodeFrame(good.subarray(0, good.byteLength - 1)))

  const withGarbageTail = Buffer.concat([good, Buffer.from([1, 2, 3])])
  t.exception(() => decodeFrame(withGarbageTail), 'trailing bytes after a valid body must throw')
})

test('decodeFrame throws EngineError with E_CORRUPT code on all garbage input', (t) => {
  const inputs = [
    Buffer.alloc(0),
    Buffer.from([255, 255, 255, 255, 255]),
    Buffer.from([FrameKind.EVENT_DATA, 0, 0, 0, 0, 255])
  ]
  for (const input of inputs) {
    try {
      decodeFrame(input)
      t.fail('expected decodeFrame to throw')
    } catch (err) {
      t.is(err.code, 'E_CORRUPT')
    }
  }
})

test('worker and lifecycle both wire events from the shared schema constants', (t) => {
  const root = path.join(__dirname, '..')
  const worker = fs.readFileSync(path.join(root, 'engine/worker.js'), 'utf8')
  const lifecycle = fs.readFileSync(path.join(root, 'electron/engine-lifecycle.js'), 'utf8')

  t.ok(LOW_RATE_EVENTS.length > 0, 'low-rate events are declared in the shared schema')
  t.ok(EVENT_DATA_NAMES.length > 0, 'binary event names are declared in the shared schema')
  t.ok(
    /for \(const name of LOW_RATE_EVENTS\)/.test(worker),
    'worker forwards low-rate events by iterating LOW_RATE_EVENTS'
  )
  t.ok(
    /for \(const name of LOW_RATE_EVENTS\)/.test(lifecycle),
    'lifecycle subscribes to low-rate events by iterating LOW_RATE_EVENTS'
  )
  t.ok(
    /for \(const name of EVENT_DATA_NAMES\)/.test(lifecycle),
    'lifecycle subscribes to binary events by iterating EVENT_DATA_NAMES'
  )
})
