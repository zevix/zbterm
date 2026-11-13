const test = require('brittle')
const { createSessionDataBatcher } = require('../electron/session-data-batcher')

// A fake clock: timers fire only when the test says so.
function harness(opts = {}) {
  const sent = []
  let timers = []
  const batcher = createSessionDataBatcher({
    send: (data) => sent.push(data),
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      timers = timers.filter((x) => x !== t)
    },
    ...opts
  })
  const fire = () => {
    const due = timers
    timers = []
    for (const t of due) t.fn()
  }
  return { batcher, sent, fire, timers: () => timers }
}

const chunk = (sessionId, text, extra = {}) => ({
  sessionId,
  source: 'live',
  hd: false,
  data: Buffer.from(text),
  ...extra
})

test('chunks of one session join into one message on the timer', (t) => {
  const { batcher, sent, fire, timers } = harness()
  batcher.push(chunk('a', 'one '))
  batcher.push(chunk('a', 'two '))
  batcher.push(chunk('a', 'three'))
  t.is(sent.length, 0, 'nothing sent before the timer')
  t.is(timers().length, 1, 'one timer for the whole batch')
  t.is(timers()[0].ms, 8)
  fire()
  t.is(sent.length, 1)
  t.is(sent[0].sessionId, 'a')
  t.is(Buffer.from(sent[0].data).toString(), 'one two three', 'bytes in order, none lost')
  t.is(timers().length, 0, 'no timer left behind')
})

test('a single small write goes out unchanged on the next timer', (t) => {
  const { batcher, sent, fire } = harness()
  const c = chunk('a', 'x')
  batcher.push(c)
  fire()
  t.is(sent.length, 1)
  t.is(sent[0].data, c.data, 'a lone chunk is passed through, not copied')
})

test('a change of session, source or hd flushes the earlier batch first', (t) => {
  const { batcher, sent, fire } = harness()
  batcher.push(chunk('a', '1'))
  batcher.push(chunk('b', '2'))
  batcher.push(chunk('b', '3', { source: 'replay' }))
  batcher.push(chunk('b', '4', { source: 'replay', hd: true }))
  fire()
  t.alike(
    sent.map((s) => [s.sessionId, s.source, s.hd, Buffer.from(s.data).toString()]),
    [
      ['a', 'live', false, '1'],
      ['b', 'live', false, '2'],
      ['b', 'replay', false, '3'],
      ['b', 'replay', true, '4']
    ]
  )
})

test('the byte bound flushes at once without waiting for the timer', (t) => {
  const { batcher, sent, timers } = harness({ flushBytes: 10 })
  batcher.push(chunk('a', '12345'))
  t.is(sent.length, 0)
  batcher.push(chunk('a', '67890'))
  t.is(sent.length, 1, 'flushed at the bound')
  t.is(Buffer.from(sent[0].data).toString(), '1234567890')
  t.is(timers().length, 0, 'the pending timer was cleared')
})

test('flush() sends queued output synchronously, before whatever the caller sends next', (t) => {
  // main.js calls flush() before every other event and before every invoke
  // answer: a session.open answer that overtook queued output got that output
  // painted twice over the frame it carries (261111_buffer-search F4).
  const order = []
  const batcher = createSessionDataBatcher({
    send: (d) => order.push('data:' + Buffer.from(d.data).toString()),
    setTimer: () => ({}),
    clearTimer: () => {}
  })
  batcher.push(chunk('a', 'early'))
  batcher.flush()
  order.push('answer')
  t.alike(order, ['data:early', 'answer'])
  batcher.flush()
  t.alike(order, ['data:early', 'answer'], 'an empty flush sends nothing')
})

test('byte totals are preserved, so renderer acks count the same', (t) => {
  const { batcher, sent, fire } = harness()
  let total = 0
  for (let i = 0; i < 100; i++) {
    const c = chunk('a', 'x'.repeat(i))
    total += c.data.byteLength
    batcher.push(c)
  }
  fire()
  t.is(
    sent.reduce((n, s) => n + s.data.byteLength, 0),
    total
  )
})

test('string data is counted in bytes, not characters', (t) => {
  const { batcher, sent } = harness({ flushBytes: 4 })
  batcher.push({ sessionId: 'a', data: 'éé' }) // 4 bytes, 2 characters
  t.is(sent.length, 1, 'flushed at 4 bytes')
})
