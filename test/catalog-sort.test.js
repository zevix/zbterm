// 261115_quit-pins-reorder R7, U3: the catalog lists newest first by a
// session's manual `sortAt` when it has one, else by when it last started.
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')

const Catalog = require('../engine/catalog')
const { sortTime } = require('../engine/catalog')

async function withCatalog(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbcat-'))
  const catalog = new Catalog(dir)
  await catalog.ready()
  t.teardown(async () => {
    await catalog.close()
    await fs.promises.rm(dir, { recursive: true, force: true })
  })
  return catalog
}

test('catalog: no sortAt sorts by last start, as before (U3)', async (t) => {
  const catalog = await withCatalog(t)
  await catalog.put({ sessionId: 'a', name: 'a', startedAt: 1000 })
  await catalog.put({ sessionId: 'b', name: 'b', startedAt: 2000 })
  await catalog.put({ sessionId: 'c', name: 'c', startedAt: 500, lastStartedAt: 3000 })
  const ids = (await catalog.list()).map((entry) => entry.sessionId)
  t.alike(ids, ['c', 'b', 'a'])
})

test('catalog: sortAt overrides the start time; null clears it (R7)', async (t) => {
  const catalog = await withCatalog(t)
  await catalog.put({ sessionId: 'a', name: 'a', startedAt: 1000 })
  await catalog.put({ sessionId: 'b', name: 'b', startedAt: 2000 })
  await catalog.put({ sessionId: 'c', name: 'c', startedAt: 3000 })
  // a dropped between c and b: the midpoint of their times.
  await catalog.update('a', { sortAt: 2500 })
  t.alike(
    (await catalog.list()).map((entry) => entry.sessionId),
    ['c', 'a', 'b']
  )
  // b dropped at the top: the first row's time + 42 min.
  await catalog.update('b', { sortAt: 3000 + 42 * 60 * 1000 })
  t.alike(
    (await catalog.list()).map((entry) => entry.sessionId),
    ['b', 'c', 'a']
  )
  await catalog.update('b', { sortAt: null })
  t.alike(
    (await catalog.list()).map((entry) => entry.sessionId),
    ['c', 'a', 'b']
  )
  t.is(sortTime({ startedAt: 5, lastStartedAt: 7, sortAt: 0 }), 0)
  t.is(sortTime({ startedAt: 5, lastStartedAt: 7, sortAt: null }), 7)
})
