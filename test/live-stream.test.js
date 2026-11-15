// renderer/live-stream.js (261114_live-output-and-fixes, design A): which
// chunks of the selected live session the terminal still has to write, by
// the engine's stream positions (`end` on chunks, `through` on frames).
const test = require('brittle')
const { createLiveStream } = require('../renderer/live-stream.js')

const enc = (text) => new Uint8Array(Buffer.from(text))
const dec = (data) => Buffer.from(data).toString()
// Chunks of one stream: text pieces, each stamped with the position after it.
function chunks(sessionId, pieces, from = 0) {
  let at = from
  return pieces.map((text) => {
    at += Buffer.byteLength(text)
    return { sessionId, end: at, data: enc(text) }
  })
}

test('chunks before the frame are held; those the frame holds are dropped, the straddling one cut', (t) => {
  const s = createLiveStream()
  const [a, b, c] = chunks('s', ['aaaa', 'bbbb', 'cccc']) // ends 4, 8, 12
  s.hold('s')
  t.is(s.take(a).action, 'hold')
  t.is(s.take(b).action, 'hold')
  t.is(s.take(c).action, 'hold')
  const out = s.frame('s', 6) // the frame holds aaaa + bb
  t.alike(out.writes.map(dec), ['bb', 'cccc'], 'only what the frame lacks')
  t.is(out.dropped, 1)
  t.is(out.gap, false)
  t.is(s.written, 12)
})

test('a chunk the frame holds arriving after it is dropped (mechanism 3)', (t) => {
  const s = createLiveStream()
  const [a, b] = chunks('s', ['line 128\n', 'line 129\n'])
  s.hold('s')
  s.frame('s', b.end) // both are in the frame
  t.is(s.take(b).action, 'drop', 'late duplicate dropped')
  const [c] = chunks('s', ['line 130\n'], b.end)
  const r = s.take(c)
  t.is(r.action, 'write')
  t.is(dec(r.data), 'line 130\n')
  t.ok(a)
})

test('output emitted after the snapshot is written, not lost (mechanism 1)', (t) => {
  const s = createLiveStream()
  const [a, b] = chunks('s', ['in frame\n', 'after snapshot\n'])
  s.hold('s')
  s.take(a)
  s.take(b) // arrived before the answer
  const out = s.frame('s', a.end)
  t.alike(out.writes.map(dec), ['after snapshot\n'])
})

test('a gap (bytes that never came) is reported, during replay and after', (t) => {
  const s = createLiveStream()
  const [a, b, c, d] = chunks('s', ['1111', '2222', '3333', '4444'])
  s.hold('s')
  s.frame('s', a.end)
  t.is(s.take(b).action, 'write')
  t.is(s.take(d).action, 'gap', 'c never came')
  t.is(s.written, b.end, 'nothing written past the hole')
  s.hold('s')
  s.take(d)
  const out = s.frame('s', a.end) // a stale frame cannot close the hole either
  t.is(out.gap, true)
  t.ok(c)
})

test('U2: a core with no positions works as before', (t) => {
  const s = createLiveStream()
  s.hold('s')
  t.is(s.take({ sessionId: 's', data: enc('early') }).action, 'hold')
  const out = s.frame('s', undefined)
  t.alike(out.writes, [], 'held chunks are dropped, as the reset always wiped them')
  t.is(out.dropped, 1)
  const r = s.take({ sessionId: 's', data: enc('late') })
  t.is(r.action, 'write')
  t.is(dec(r.data), 'late')
  t.is(s.take({ sessionId: 's', data: enc('more') }).action, 'write')
})

test('a frame with positions after chunks without them (and back)', (t) => {
  const s = createLiveStream()
  s.hold('s')
  s.frame('s', 10)
  t.is(s.take({ sessionId: 's', data: enc('x') }).action, 'write', 'no end: untracked write')
  const [c] = chunks('s', ['yy'], 3)
  t.is(s.take(c).action, 'write', 'the first chunk with an end anchors again')
  t.is(s.written, 5)
})

test('release: no frame (restoring) writes what was held and anchors on it', (t) => {
  const s = createLiveStream()
  const [a, b] = chunks('s', ['aa', 'bb'], 100)
  s.hold('s')
  s.take(a)
  s.take(b)
  t.alike(s.release('s').map(dec), ['aa', 'bb'])
  t.is(s.written, b.end)
  t.is(s.anchored, false, 'a lost tail cannot be told without a frame')
  t.is(s.holding, false)
})

test('other sessions and a switch: held chunks never cross sessions', (t) => {
  const s = createLiveStream()
  const [a] = chunks('A', ['from A'])
  s.hold('A')
  s.take(a)
  s.hold('B')
  t.is(s.take(a).action, 'other', 'A is not followed any more')
  const out = s.frame('B', 0)
  t.alike(out.writes, [], "A's held chunk was dropped at the switch")
  t.alike(s.frame('A', 50).writes, [], 'a stale frame for A changes nothing')
  t.is(s.written, 0)
})
