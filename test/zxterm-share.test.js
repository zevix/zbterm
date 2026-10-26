// engine/zxterm/share.js: the Freenet share path's seam client (K14 of
// zxterm-core; ZBTerm D-38). No sidecar here: a scripted `request` stands in
// for it, and an EventEmitter for the profile's `Core`. The real thing runs in
// test/backends/freenet-session.test.js.
const { EventEmitter } = require('events')
const test = require('brittle')

const { ShareBridge, OrderedRequests, bridgeFor, b64, unb64 } = require('../engine/zxterm/share')

// A scripted sidecar: every request is recorded with how many were in flight
// when it arrived, and answered after `latencyMs`.
function scripted({ latencyMs = 5, fail = () => false } = {}) {
  const seen = []
  let inFlight = 0
  const request = async (method, args) => {
    inFlight++
    seen.push({ method, args, concurrent: inFlight })
    await new Promise((resolve) => setTimeout(resolve, latencyMs))
    inFlight--
    if (fail(method, args)) throw new Error(`${method} refused`)
    return { ok: method }
  }
  return { request, seen }
}

test('ordered requests: one at a time, in the order they were queued', async (t) => {
  const core = scripted()
  const ordered = new OrderedRequests(core.request)
  const replies = await Promise.all([
    ordered.send('share.info', { n: 1 }),
    ordered.send('share.end', { n: 2 }),
    ordered.send('share.resize', { n: 3 })
  ])
  t.alike(
    core.seen.map((item) => item.args.n),
    [1, 2, 3],
    'queued order is request order'
  )
  t.ok(
    core.seen.every((item) => item.concurrent === 1),
    'no request starts before the one before it is answered'
  )
  t.alike(
    replies,
    [{ ok: 'share.info' }, { ok: 'share.end' }, { ok: 'share.resize' }],
    'every send() gets its own reply'
  )
})

test('ordered requests: output queued behind an unanswered request joins into one', async (t) => {
  const core = scripted()
  const ordered = new OrderedRequests(core.request)
  const first = ordered.push('s', Buffer.from('a'), false)
  const rest = [
    ordered.push('s', Buffer.from('b'), false),
    ordered.push('s', Buffer.from('c'), false),
    ordered.push('s', Buffer.from('d'), true),
    ordered.push('s', Buffer.from('e'), true)
  ]
  await Promise.all([first, ...rest])
  const sent = core.seen.map((item) => [
    item.method,
    unb64(item.args.data).toString('utf8'),
    item.args.hd
  ])
  t.alike(
    sent,
    [
      ['share.push', 'a', false],
      ['share.push', 'bc', false],
      ['share.push', 'de', true]
    ],
    'the first goes at once; b and c join, d and e join, the hd flag is never mixed'
  )
  t.alike(
    core.seen.map((item) => item.args.sessionId),
    ['s', 's', 's'],
    'each names its session'
  )
  t.is(rest[0], rest[1], 'chunks that joined share one reply')
})

test('ordered requests: another request between two pushes keeps their order', async (t) => {
  const core = scripted()
  const ordered = new OrderedRequests(core.request)
  const done = [
    ordered.push('s', Buffer.from('1'), false),
    ordered.push('s', Buffer.from('2'), false),
    ordered.send('share.bootstrap', { requestId: 7 }),
    ordered.push('s', Buffer.from('3'), false)
  ]
  await Promise.all(done)
  t.alike(
    core.seen.map((item) =>
      item.method === 'share.push' ? unb64(item.args.data).toString() : 'B'
    ),
    ['1', '2', 'B', '3'],
    'output before the bootstrap answer stays before it, output after stays after'
  )
})

test('ordered requests: a push is cut at 64 KiB, and a failed request breaks nothing', async (t) => {
  const core = scripted({ fail: (method, args) => method === 'share.info' && args.bad })
  const ordered = new OrderedRequests(core.request)
  const big = Buffer.alloc(40 * 1024, 1)
  const pushes = [
    ordered.push('s', big, false),
    ordered.push('s', big, false),
    ordered.push('s', big, false)
  ]
  const bad = ordered.send('share.info', { bad: true })
  const after = ordered.send('share.info', { bad: false })
  await Promise.all(pushes)
  t.ok(
    core.seen
      .filter((item) => item.method === 'share.push')
      .every((item) => unb64(item.args.data).length <= 64 * 1024),
    'no push carries more than 64 KiB'
  )
  t.is(
    core.seen
      .filter((item) => item.method === 'share.push')
      .reduce((sum, item) => sum + unb64(item.args.data).length, 0),
    3 * big.length,
    'and every byte goes out'
  )
  await t.exception(bad, /share.info refused/, 'the failing request rejects its own promise')
  t.alike(await after, { ok: 'share.info' }, 'the ones behind it still run')
})

test('bridge: share events become emitter events, everything else is ignored', (t) => {
  const core = new EventEmitter()
  const bridge = new ShareBridge(core)
  const got = []
  for (const name of ['output', 'joinChanged', 'exit']) {
    bridge.on(name, (data) => got.push([name, data]))
  }
  core.emit('event', { name: 'share.output', data: { sessionId: 's', data: 'AA==' } })
  core.emit('event', { name: 'freenet.connection', data: { conn: 1 } })
  core.emit('event', { name: 'share.joinChanged', data: undefined })
  core.emit('exit', { code: 1, signal: null })
  t.alike(
    got,
    [
      ['output', { sessionId: 's', data: 'AA==' }],
      ['joinChanged', {}],
      ['exit', { code: 1, signal: null }]
    ],
    'share.* without its prefix, an absent payload as {}, exit passed on'
  )
  t.is(bridgeFor(core), bridgeFor(core), 'one bridge per core')
  t.not(bridgeFor(new EventEmitter()), bridgeFor(core), 'and one per core only')
})

test('bridge: request goes to the core with the method as named', async (t) => {
  const calls = []
  const core = Object.assign(new EventEmitter(), {
    request: (method, args) => {
      calls.push([method, args])
      return Promise.resolve({ joinId: 'j' })
    }
  })
  const bridge = new ShareBridge(core)
  t.alike(await bridge.request('share.join', { linkId: 'x' }), { joinId: 'j' })
  t.alike(calls, [['share.join', { linkId: 'x' }]])
})

test('bytes cross as base64', (t) => {
  const bytes = Buffer.from([0, 1, 2, 250, 255])
  t.is(b64(bytes), 'AAEC+v8=')
  t.alike(unb64(b64(bytes)), bytes, 'and back')
  t.is(unb64(undefined).length, 0, 'nothing is nothing')
})
