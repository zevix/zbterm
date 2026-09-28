const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')

const SessionEngine = require('../engine')
const PtyHost = require('../electron/pty-host')
const { _test } = require('../engine')
const { SessionStore } = require('../engine/session-store')
const { loadOrCreateLocalDevice } = require('../engine/crypto')
const PearBackend = require('../engine/backends/pear')

test('default local session names increment by user and host', async (t) => {
  const base = `${_test.currentUsername()} @ ${os.hostname()}`
  const engine = {
    profileId: 'default',
    catalog: {
      list: async () => [
        { name: `${base} #1` },
        { name: 'manually named session' },
        { name: `${base} #2` }
      ]
    },
    profileManager: {
      listProfiles: async () => ({ profiles: [{ id: 'default', name: 'Default' }] })
    },
    defaultSessionName: SessionEngine.prototype.defaultSessionName,
    defaultSessionNameBase: SessionEngine.prototype.defaultSessionNameBase,
    currentProfileDisplayName: SessionEngine.prototype.currentProfileDisplayName
  }

  t.is(await SessionEngine.prototype.defaultSessionName.call(engine), `${base} #3`)
})

test('default local session names include non-default profile names', async (t) => {
  const base = `${_test.currentUsername()} @ ${os.hostname()} (Work)`
  const engine = {
    profileId: 'work',
    catalog: {
      list: async () => [{ name: `${base} #4` }]
    },
    profileManager: {
      listProfiles: async () => ({ profiles: [{ id: 'work', name: 'Work' }] })
    },
    defaultSessionName: SessionEngine.prototype.defaultSessionName,
    defaultSessionNameBase: SessionEngine.prototype.defaultSessionNameBase,
    currentProfileDisplayName: SessionEngine.prototype.currentProfileDisplayName
  }

  t.is(await SessionEngine.prototype.defaultSessionName.call(engine), `${base} #5`)
})

test('engine extends a recorded local session with a new live shell', async (t) => {
  const dir = await temp()
  const engine = new SessionEngine({ userData: dir, ptyHost: new PtyHost() })
  await engine.ready()

  try {
    const created = await engine.invoke('session.create', {
      name: 'extend me',
      cols: 90,
      rows: 30
    })
    await engine.invoke('session.resize', { sessionId: created.sessionId, cols: 104, rows: 33 })
    await engine.invoke('session.close', { sessionId: created.sessionId })
    await waitFor(async () => {
      const sessions = await engine.invoke('session.list')
      const session = sessions.find((item) => item.sessionId === created.sessionId)
      return session && !session.active ? session : null
    })

    const playback = await engine.invoke('player.open', { sessionId: created.sessionId })
    t.ok(playback.length > 0)

    const extended = await engine.invoke('session.extend', {
      sessionId: created.sessionId,
      cols: 90,
      rows: 30
    })
    t.is(extended.sessionId, created.sessionId)
    t.is(extended.active, true)
    await waitFor(async () => {
      const state = await engine.invoke('session.open', { sessionId: created.sessionId })
      return !state.restoring
    })

    const opened = await engine.invoke('session.open', { sessionId: created.sessionId })
    t.is(opened.active, true)
    t.is(opened.length, playback.length)
    t.is(opened.frame.cols, 104)
    t.is(opened.frame.rows, 33)
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('engine revives an extended session at its last grid and font size, across a restart', async (t) => {
  const dir = await temp()
  let engine = new SessionEngine({ userData: dir, ptyHost: new PtyHost() })
  await engine.ready()

  try {
    const created = await engine.invoke('session.create', { name: 'font me', cols: 90, rows: 30 })
    const sessionId = created.sessionId
    await engine.invoke('session.resize', { sessionId, cols: 120, rows: 40, fontSize: 17.5 })
    // Nonsense font sizes are ignored; the geometry still lands.
    await engine.invoke('session.resize', { sessionId, cols: 110, rows: 36, fontSize: -3 })
    await engine.invoke('session.resize', { sessionId, cols: 104, rows: 33, fontSize: 'big' })
    let listed = (await engine.invoke('session.list')).find((s) => s.sessionId === sessionId)
    t.is(listed.fontSize, 17.5, 'the last valid font size is in the catalog')

    await engine.invoke('session.close', { sessionId })
    await waitFor(async () => {
      const sessions = await engine.invoke('session.list')
      const session = sessions.find((item) => item.sessionId === sessionId)
      return session && !session.active ? session : null
    })
    await engine.close()

    engine = new SessionEngine({ userData: dir, ptyHost: new PtyHost() })
    await engine.ready()
    listed = (await engine.invoke('session.list')).find((s) => s.sessionId === sessionId)
    t.is(listed.fontSize, 17.5, 'the font size survives a restart')

    const extended = await engine.invoke('session.extend', { sessionId })
    t.is(extended.cols, 104, 'revived at the last recorded cols')
    t.is(extended.rows, 33, 'revived at the last recorded rows')
    t.is(extended.fontSize, 17.5, 'revived with the last font size')
    await waitFor(async () => {
      const state = await engine.invoke('session.open', { sessionId })
      return !state.restoring
    })
    const opened = await engine.invoke('session.open', { sessionId })
    t.is(opened.frame.cols, 104)
    t.is(opened.frame.rows, 33)

    // A resize reporting the same size writes nothing new; a new one replaces it.
    await engine.invoke('session.resize', { sessionId, cols: 104, rows: 33, fontSize: 15 })
    listed = (await engine.invoke('session.list')).find((s) => s.sessionId === sessionId)
    t.is(listed.fontSize, 15)
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('remote timeline metadata schedules catch-up history downloads', async (t) => {
  const downloads = []
  let available = 2
  let extended = 0
  let destroyed = 0
  const remote = {
    active: true,
    store: {
      remote: true,
      availableLength: () => Promise.resolve(available),
      extendTimeline: () => {
        extended++
        return Promise.resolve()
      },
      log: {
        download: (opts) => {
          downloads.push(opts)
          return {
            done: () => {
              available = opts.end
              return Promise.resolve()
            },
            destroy: () => {
              destroyed++
            }
          }
        }
      }
    },
    historyDownloadQueue: Promise.resolve(),
    historyDownloads: new Set(),
    historyDownloadTarget: 0,
    historyDownloadActive: false
  }
  attachPearHistory(remote, downloads)
  const engine = {
    remoteSessions: new Map([['remote-session', remote]]),
    listSessions: () => Promise.resolve([]),
    emit: (name, err) => {
      if (name === 'engine:error') t.fail(`${name}: ${err && err.message}`)
    }
  }

  SessionEngine.prototype._scheduleRemoteHistoryDownload.call(engine, 'remote-session', 5)
  await remote.historyDownloadQueue

  t.alike(downloads, [{ start: 2, end: 5, linear: true }])
  t.is(available, 5)
  t.is(extended, 1)
  t.is(destroyed, 1)
})

test('engine preferences persist in the profile data root', async (t) => {
  const dir = await temp()
  const engine = {
    paths: {
      preferences: path.join(dir, 'profile', 'preferences.json')
    },
    _readPreferences: SessionEngine.prototype._readPreferences
  }

  try {
    t.is(await SessionEngine.prototype.getPreference.call(engine, 'zbterm.share.autoCopy'), null)

    const saved = await SessionEngine.prototype.setPreference.call(
      engine,
      'zbterm.share.autoCopy',
      '1'
    )
    t.alike(saved, { key: 'zbterm.share.autoCopy', value: '1' })
    t.is(await SessionEngine.prototype.getPreference.call(engine, 'zbterm.share.autoCopy'), '1')

    const raw = JSON.parse(await fs.promises.readFile(engine.paths.preferences, 'utf8'))
    t.is(raw['zbterm.share.autoCopy'], '1')
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('remote history catch-up downloads in bounded chunks', async (t) => {
  const downloads = []
  let available = 0
  const remote = {
    active: true,
    store: {
      remote: true,
      availableLength: () => Promise.resolve(available),
      extendTimeline: () => Promise.resolve(),
      log: {
        download: (opts) => {
          downloads.push(opts)
          return {
            done: () => {
              available = opts.end
              return Promise.resolve()
            },
            destroy: () => {}
          }
        }
      }
    },
    historyDownloadQueue: Promise.resolve(),
    historyDownloads: new Set(),
    historyDownloadTarget: 0,
    historyDownloadActive: false
  }
  attachPearHistory(remote, downloads)
  const engine = {
    remoteSessions: new Map([['remote-session', remote]]),
    listSessions: () => Promise.resolve([]),
    emit: () => {}
  }

  SessionEngine.prototype._scheduleRemoteHistoryDownload.call(engine, 'remote-session', 9000)
  await remote.historyDownloadQueue

  t.alike(downloads, [
    { start: 0, end: 8192, linear: true },
    { start: 8192, end: 9000, linear: true }
  ])
})

test('bulk remote timeline sync flushes and downloads only on final chunk', async (t) => {
  let flushes = 0
  let downloads = 0
  let backfills = 0
  const remote = {
    active: true,
    frame: null,
    store: {
      remote: true,
      timeline: [],
      timelineDirty: false,
      playbackLength: 0,
      flushTimeline: () => {
        flushes++
        return Promise.resolve()
      }
    }
  }
  const engine = {
    remoteSessions: new Map([['remote-session', remote]]),
    _scheduleRemoteHistoryDownload: () => {
      downloads++
    },
    _scheduleJoinedSnapshotBackfill: () => {
      backfills++
    }
  }

  await SessionEngine.prototype.applyRemoteTimeline.call(engine, 'remote-session', {
    items: [{ seq: 1, tsMs: 1000 }],
    length: 2,
    more: true
  })
  await SessionEngine.prototype.applyRemoteTimeline.call(engine, 'remote-session', {
    items: [{ seq: 2, tsMs: 2000 }],
    length: 2,
    more: false
  })

  t.is(flushes, 1)
  t.is(downloads, 1)
  t.is(backfills, 1)
  t.alike(
    remote.store.timeline.map((item) => item.seq),
    [1, 2]
  )
})

test('active remote session reports downloaded length separately from known timeline length', async (t) => {
  const remote = {
    active: true,
    hd: false,
    mirrorQueue: Promise.resolve(),
    timelineQueue: Promise.resolve(),
    frame: { seq: 10, tsMs: 1000, data: '' },
    store: {
      remote: true,
      info: { name: 'remote', cols: 80, rows: 24 },
      log: { length: 10 },
      timeline: [
        { seq: 1, tsMs: 100 },
        { seq: 2, tsMs: 200 },
        { seq: 10, tsMs: 1000 }
      ],
      availableLength: () => Promise.resolve(2),
      loadTimeline: () => Promise.resolve()
    }
  }
  const engine = {
    sessions: new Map(),
    remoteSessions: new Map([['remote-session', remote]]),
    _refreshRemoteTimelineFromDisk: SessionEngine.prototype._refreshRemoteTimelineFromDisk,
    _remoteAvailableLength: SessionEngine.prototype._remoteAvailableLength,
    _remoteKnownLength: SessionEngine.prototype._remoteKnownLength
  }

  const opened = await SessionEngine.prototype.openSession.call(engine, 'remote-session')

  t.is(opened.length, 2)
  t.is(opened.availability.availableLength, 2)
  t.is(opened.availability.logLength, 10)
})

test('registerRemoteSession closes an already-open offline player store for the same session first', async (t) => {
  const dir = await temp()
  const sessionId = 'rejoin-session'
  const device = await loadOrCreateLocalDevice({ root: dir })

  // Stand in for the offline joined SessionStore that openPlayer() left open
  // in this.players (eg. from earlier history/playback), per the bug report:
  // registering a fresh live join for the same sessionId must close it
  // before opening a second exclusive handle on the same corestore
  // directory, or the second open fails with "File descriptor could not be
  // locked".
  let closed = false
  const staleStore = {
    remote: true,
    close: async () => {
      closed = true
    }
  }
  const openedWhileStale = []

  const originalOpenRemote = SessionStore.openRemote
  const freshStore = {
    dir: path.join(dir, sessionId),
    info: { name: 'new long' },
    close: async () => {}
  }
  SessionStore.openRemote = async (...args) => {
    openedWhileStale.push(closed)
    return freshStore
  }

  const engine = {
    remoteSessions: new Map(),
    players: new Map([
      [sessionId, { player: { pause: () => {} }, store: staleStore, ownsStore: true }]
    ]),
    paths: { corestore: path.join(dir, 'corestore'), snapshots: path.join(dir, 'snapshots') },
    localDevice: device,
    catalog: { put: async () => {} },
    emit: () => {},
    listSessions: async () => [],
    _closePlayer: SessionEngine.prototype._closePlayer,
    _closePlayerNow: SessionEngine.prototype._closePlayerNow,
    _withStoreLock: SessionEngine.prototype._withStoreLock,
    _openRemoteLocked: SessionEngine.prototype._openRemoteLocked,
    _finishRegisterRemoteSession: SessionEngine.prototype._finishRegisterRemoteSession,
    _doRegisterRemoteSession: SessionEngine.prototype._doRegisterRemoteSession,
    registerRemoteSession: SessionEngine.prototype.registerRemoteSession
  }

  try {
    const message = {
      sessionId,
      logKey: 'a'.repeat(64),
      metaKey: 'b'.repeat(64),
      hostDeviceKey: 'c'.repeat(64),
      envelope: 'd'.repeat(64),
      info: { name: 'new long', createdAt: Date.now(), cols: 90, rows: 28 }
    }

    await engine.registerRemoteSession(message)

    t.ok(closed, 'stale offline player store was closed')
    t.alike(openedWhileStale, [true], 'the new store was only opened after the stale one closed')
    t.absent(engine.players.has(sessionId), 'stale player handle was removed')
    t.is(engine.remoteSessions.get(sessionId).store, freshStore)
  } finally {
    SessionStore.openRemote = originalOpenRemote
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

async function waitFor(fn) {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    const result = await fn()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for condition')
}

function temp() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-engine-session-test-'))
}

// The engine fetches catch-up ranges through the history handle the share
// backend attached at join time. This attaches the real Pear handle to a mocked
// remote, then forgets the full-range downloads attaching starts, so `downloads`
// holds only what the engine asked for.
function attachPearHistory(remote, downloads) {
  remote.store.metaCore = { download: () => ({ destroy: () => {} }) }
  remote.history = new PearBackend().attachHistory({ _replicate: () => {} }, remote.store)
  downloads.length = 0
}
