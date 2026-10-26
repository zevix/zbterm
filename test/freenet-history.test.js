// A Freenet session's history is the core's (K17 of zxterm-core, stage C3;
// ZBTerm D-40), end to end: two real `SessionEngine`s, each with the Rust
// `zxterm-core` sidecar of its profile, real WebRTC between them and one
// throwaway local-mode Freenet node (never the owner's). What is under test
// is ZBTerm's half of C3 - the host feeding its recording to the core once
// (`history.import`) and appending what it records afterwards, the viewer's
// store filling from the core's answers, and a viewer reading the history
// from the `segment-v1` contract after the host is gone - not the core's own
// checks (`zxterm_core::history`, tests/history_*.rs in zevix/zxterm).
//
//   npx brittle-node test/freenet-history.test.js
const fs = require('fs')
const path = require('path')
const test = require('brittle')

const { freenetAvailable, startLocalNode } = require('./helpers/freenet-node')
const {
  delay,
  until,
  makeEngine,
  scratch,
  textOf,
  joinLink,
  countRequests,
  hostWithRecording,
  share,
  published,
  killSidecar,
  alive
} = require('./helpers/freenet-engines')
const { HISTORY_DIR } = require('../engine/zxterm/history')

test('freenet history: a pre-share recording is imported once and a viewer reads all of it, live', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  t.timeout(240000)
  const node = await startLocalNode()
  t.teardown(() => node.stop())

  const host = await hostWithRecording(t, node)
  t.teardown(() => host.engine.close().catch(() => {}))
  const { sessionId, runtime } = host
  const preLength = runtime.store.log.length
  const preText = (await textOf(runtime.store, preLength)).text
  t.ok(preText.includes('before-share-line-39'), 'the recording holds the pre-share output')

  const imports = countRequests(host.engine, 'history.import')
  const opens = countRequests(host.engine, 'history.open')
  const link = await share(host)
  t.is(imports.n, 1, 'the first Freenet share imported the recording once')
  t.is(imports.calls[0].packets.length, preLength, 'every packet of the Hypercore log went in')
  t.is(imports.calls[0].firstSeq, 1, 'at the log positions the Hypercore had')
  t.is(opens.n, 0, 'and nothing was opened separately')
  const state = JSON.parse(
    await fs.promises.readFile(path.join(runtime.store.dir, HISTORY_DIR, 'state.json'), 'utf8')
  )
  t.is(state.imported, true, 'the session is marked imported')

  const viewer = await makeEngine(t, node, await scratch(t, 'viewer'))
  t.teardown(() => viewer.engine.close().catch(() => {}))
  const reads = countRequests(viewer.engine, 'share.history')
  await joinLink(viewer.engine, link)
  const remote = viewer.engine.remoteSessions.get(sessionId)
  t.ok(remote.store.historyCache, "the viewer's store is a cache of the core's history")
  await until(
    async () => (await remote.store.availableLength()) >= preLength,
    60000,
    'the backfill'
  )
  const seen = await textOf(remote.store, preLength)
  t.is(seen.text, preText, 'the viewer has the whole pre-share history, as the host recorded it')
  t.is(
    seen.packets.length,
    (await textOf(runtime.store, preLength)).packets.length,
    'packet for packet'
  )
  t.ok(reads.n >= 1, 'asked of the host over the history channel, through the core')

  // Output after the share: appended to the core as the store records it,
  // and served once the host's segment is closed.
  const after = `after-share-marker-${Date.now()}\r\n`
  host.ptyHost.push(sessionId, Buffer.from(after))
  await until(() => runtime.store.log.length > preLength, 15000, 'the new packet')
  const total = runtime.store.log.length
  await until(async () => (await remote.store.availableLength()) >= total, 30000, 'the new output')
  const all = await textOf(remote.store, total)
  t.ok(all.text.endsWith(after), 'output recorded after the share reaches the viewer history')
  t.is(all.text, (await textOf(runtime.store, total)).text, 'and the two histories are equal')

  // The same segments reach the contract, and the host's close waits for them.
  const { head, status } = await published(host)
  t.ok(status.ready && status.headLength >= head.length, 'the contract holds the head')
  t.is(host.errors.length + viewer.errors.length, 0, 'no engine error on either side')
})

test('freenet history: with the host killed, a viewer reads the whole history from segment-v1', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  t.timeout(300000)
  const node = await startLocalNode()
  t.teardown(() => node.stop())

  const host = await hostWithRecording(t, node, { lines: 60, name: 'offline' })
  const { sessionId, runtime } = host
  const hostText = (await textOf(runtime.store, runtime.store.log.length)).text
  const link = await share(host)
  const viewerDir = await scratch(t, 'viewer')
  let viewer = await makeEngine(t, node, viewerDir)
  await joinLink(viewer.engine, link)
  const hostLine = `live-line-${Date.now()}\r\n`
  const before = runtime.store.log.length
  host.ptyHost.push(sessionId, Buffer.from(hostLine))
  await until(() => runtime.store.log.length > before, 15000, 'the new line')
  await delay(800)
  const length = runtime.store.log.length
  const expected = (await textOf(runtime.store, length)).text
  t.ok(expected.includes(hostLine) && expected.startsWith(hostText), 'the host recorded it all')

  // Everything is in the contract before the host goes.
  const { head, status } = await published(host)
  t.ok(status.ready && status.headLength >= head.length, 'the host published its history')
  const remote = viewer.engine.remoteSessions.get(sessionId)
  const offline = new Promise((resolve) => viewer.engine.once('session:exit', resolve))

  // The host process is killed, not disconnected.
  const pid = killSidecar(host.engine)
  await until(() => !alive(pid), 10000, 'the host sidecar to be gone')
  host.engine.close().catch(() => {})
  await Promise.race([offline, delay(30000)])

  // The viewer's copy is emptied (an app that lost its cache, or a new
  // install of the same profile) and the app started again.
  await viewer.engine.close()
  const dir = path.join(viewer.engine.paths.corestore, sessionId)
  t.ok(
    fs.existsSync(path.join(dir, 'remote-manifest.json')),
    'the viewer kept its joined-session record'
  )
  await fs.promises.rm(path.join(dir, 'log'), { recursive: true, force: true })
  await fs.promises.rm(path.join(dir, 'timeline.json'), { force: true })
  void remote
  viewer = await makeEngine(t, node, viewerDir)
  t.teardown(() => viewer.engine.close().catch(() => {}))
  const reads = {
    live: countRequests(viewer.engine, 'share.history'),
    contract: countRequests(viewer.engine, 'history.readContract')
  }
  t.absent(alive(pid), 'the host is not running at read time')
  // A joined session with no snapshots is backfilled in the background from
  // the engine's start, and that opens the store outside the store lock
  // (S-48): the open below waits for it.
  await until(() => viewer.engine.snapshotBackfills.size === 0, 60000, 'the snapshot backfill')

  const opened = await viewer.engine.openSession(sessionId)
  t.is(reads.contract.n >= 1, true, 'the history was read from the contract')
  t.is(reads.live.n, 0, 'and no live request was made: there is no host to ask')
  t.is(opened.length, length, 'the viewer sees every packet the host recorded')
  const cachedStore = await viewer.engine._withStore(sessionId, async (store) => {
    const read = await textOf(store, length)
    return { text: read.text, packets: read.packets.length, historyCache: store.historyCache }
  })
  t.is(cachedStore.text, expected, "the viewer's history is the host's recorded output")
  t.is(cachedStore.historyCache, true, 'from the core-backed cache')
  t.alike(
    viewer.errors.map((err) => err.message),
    [],
    'no engine error'
  )
})

test('freenet history: a second share of the same session imports nothing and duplicates nothing', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  t.timeout(300000)
  const node = await startLocalNode()
  t.teardown(() => node.stop())

  const hostDir = await scratch(t, 'host')
  let host = await hostWithRecording(t, node, { dir: hostDir })
  const { sessionId } = host
  const first = countRequests(host.engine, 'history.import')
  await share(host)
  t.is(first.n, 1, 'the first share imported')
  const length = host.runtime.store.log.length
  const expected = (await textOf(host.runtime.store, length)).text
  await published(host)
  const statePath = path.join(host.runtime.store.dir, HISTORY_DIR, 'state.json')
  await host.engine.close()

  // A second share of the same session, in a later run.
  host = { ...(await makeEngine(t, node, hostDir)), sessionId }
  t.teardown(() => host.engine.close().catch(() => {}))
  await host.engine.invoke('session.extend', { sessionId })
  const runtime = host.engine.sessions.get(sessionId)
  const second = {
    imports: countRequests(host.engine, 'history.import'),
    opens: countRequests(host.engine, 'history.open'),
    appends: countRequests(host.engine, 'history.append')
  }
  const link = await share(host)
  t.is(second.imports.n, 0, 'the second share did not import again')
  t.is(second.opens.n, 1, "it opened the core's history instead")
  const afterResize = runtime.store.log.length
  const extra = second.appends.calls.reduce((n, call) => n + call.packets.length, 0)
  t.is(extra, afterResize - length, 'and appended only what the session recorded since')

  const viewer = await makeEngine(t, node, await scratch(t, 'viewer'))
  t.teardown(() => viewer.engine.close().catch(() => {}))
  await joinLink(viewer.engine, link)
  const remote = viewer.engine.remoteSessions.get(sessionId)
  await until(async () => (await remote.store.availableLength()) >= length, 60000, 'the history')
  const seen = await textOf(remote.store, length)
  t.is(seen.text, expected, 'the viewer sees the pre-share history once')
  t.is(seen.packets.length, length, 'with no packet twice')
  t.is(await remote.store.availableLength(), await remote.store.availableLength(), 'stable')
  void statePath
})

test('freenet history: a crash between the import and its flag imports nothing again', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  t.timeout(300000)
  const node = await startLocalNode()
  t.teardown(() => node.stop())

  const hostDir = await scratch(t, 'host')
  let host = await hostWithRecording(t, node, { dir: hostDir, lines: 20 })
  const { sessionId } = host
  await share(host)
  const statePath = path.join(host.runtime.store.dir, HISTORY_DIR, 'state.json')
  const length = host.runtime.store.log.length
  await host.engine.close()

  // What a crash right after the core accepted the import leaves: its files,
  // and a state file that does not say so yet.
  const state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'))
  t.is(state.imported, true)
  await fs.promises.writeFile(statePath, JSON.stringify({ ...state, imported: false }))

  host = { ...(await makeEngine(t, node, hostDir)), sessionId }
  t.teardown(() => host.engine.close().catch(() => {}))
  await host.engine.invoke('session.extend', { sessionId })
  const imports = countRequests(host.engine, 'history.import')
  await share(host)
  t.is(imports.n, 0, 'no second import')
  const after = JSON.parse(await fs.promises.readFile(statePath, 'utf8'))
  t.is(after.imported, true, 'the flag is written on the next open')
  t.is(after.signingSeed, state.signingSeed, 'the signing key is the one the history was made with')
  const head = await host.engine.core.request('history.head', { sessionId })
  t.ok(head.nextSeq >= length + 1, 'the core holds every packet once')
})

function sha256(text) {
  return require('crypto').createHash('sha256').update(text).digest('hex')
}

// F8's 256 KiB-block case, on the core's history: blocks of incompressible
// output, each bigger than a data-channel message and a segment's target,
// arrive whole and in order.
test('freenet history: 256 KiB blocks of incompressible output arrive intact through the core', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  t.timeout(300000)
  const node = await startLocalNode()
  t.teardown(() => node.stop())
  const host = await hostWithRecording(t, node, { lines: 5, name: 'blocks' })
  t.teardown(() => host.engine.close().catch(() => {}))
  const { sessionId, runtime } = host
  const link = await share(host)
  const viewer = await makeEngine(t, node, await scratch(t, 'viewer'))
  t.teardown(() => viewer.engine.close().catch(() => {}))
  await joinLink(viewer.engine, link)
  const remote = viewer.engine.remoteSessions.get(sessionId)

  const BLOCK = 256 * 1024
  const BLOCKS = 16
  for (let i = 0; i < BLOCKS; i++) {
    // Text-safe bytes that do not compress: base64 of random data.
    const block = Buffer.from(
      require('crypto')
        .randomBytes((BLOCK / 4) * 3)
        .toString('base64')
    )
    t.is(block.byteLength, BLOCK)
    host.ptyHost.push(sessionId, block)
    await delay(20)
  }
  await until(
    async () => {
      const a = runtime.store.log.length
      await delay(700)
      return a === runtime.store.log.length && a > BLOCKS
    },
    30000,
    'the host recording'
  )
  const length = runtime.store.log.length
  await until(
    async () => (await remote.store.availableLength()) >= length,
    120000,
    'the viewer history'
  )
  const hostSide = await textOf(runtime.store, length)
  const viewerSide = await textOf(remote.store, length)
  t.is(viewerSide.packets.length, hostSide.packets.length, 'the same packets')
  t.is(sha256(viewerSide.text), sha256(hostSide.text), 'byte for byte')
  t.ok(
    Buffer.byteLength(viewerSide.text) > BLOCKS * BLOCK,
    `${Buffer.byteLength(viewerSide.text)} bytes of output`
  )
  t.is(viewer.errors.length + host.errors.length, 0, 'no engine error')
})

// S-26's "each connection carries its own session's history", on the core: two
// sessions of one host, one viewer that joined both.
test('freenet history: two sessions of one host each keep their own history in the viewer', async (t) => {
  if (!freenetAvailable()) {
    t.skip('freenet binary not on PATH')
    return
  }
  t.timeout(300000)
  const node = await startLocalNode()
  t.teardown(() => node.stop())
  const hostDir = await scratch(t, 'host')
  const first = await hostWithRecording(t, node, { dir: hostDir, lines: 12, name: 'first' })
  t.teardown(() => first.engine.close().catch(() => {}))
  const created = await first.engine.invoke('session.create', {
    name: 'second',
    cols: 100,
    rows: 30
  })
  const secondId = created.sessionId
  for (let i = 0; i < 12; i++) {
    first.ptyHost.push(secondId, Buffer.from(`second-session-line-${i}\r\n`))
  }
  const second = first.engine.sessions.get(secondId)
  await until(() => second.store.log.length > 1, 15000, 'the second recording')
  await delay(600)
  const linkA = await share(first)
  const linkB = await share({ ...first, sessionId: secondId })

  const viewer = await makeEngine(t, node, await scratch(t, 'viewer'))
  t.teardown(() => viewer.engine.close().catch(() => {}))
  await joinLink(viewer.engine, linkA)
  await joinLink(viewer.engine, linkB)
  for (const [id, runtime] of [
    [first.sessionId, first.runtime],
    [secondId, second]
  ]) {
    const remote = viewer.engine.remoteSessions.get(id)
    const length = runtime.store.log.length
    await until(
      async () => (await remote.store.availableLength()) >= length,
      60000,
      `history of ${id}`
    )
    t.is(
      (await textOf(remote.store, length)).text,
      (await textOf(runtime.store, length)).text,
      `the viewer's copy of ${id.slice(0, 8)} is that session's own history`
    )
  }
  t.absent(
    (await textOf(viewer.engine.remoteSessions.get(first.sessionId).store, 1000)).text.includes(
      'second-session'
    ),
    "and the first session's copy holds nothing of the second"
  )
})
