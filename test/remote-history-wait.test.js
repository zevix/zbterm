// Playback opened the moment a session is joined: the host has announced its
// history (the timeline), but a Freenet viewer's packets reach the local cache
// through the core a moment later. The open waits for them, briefly, instead
// of failing with "No replicated history".
const test = require('brittle')
const SessionEngine = require('../engine')

function fakeRemote({ announced, arrivesAfterMs }) {
  const startedAt = Date.now()
  return {
    active: true,
    store: {
      timeline: Array.from({ length: announced }, (_, i) => ({ seq: i + 1, tsMs: i, hd: false })),
      availableLength: async () => (Date.now() - startedAt >= arrivesAfterMs ? announced : 0)
    }
  }
}

function waitFor(remote) {
  const engine = Object.create(SessionEngine.prototype)
  return engine._waitForRemoteHistory(remote)
}

test('playback waits for announced history that is still arriving', async (t) => {
  const startedAt = Date.now()
  const length = await waitFor(fakeRemote({ announced: 4, arrivesAfterMs: 200 }))
  t.is(length, 4, 'the packets that arrived are playable')
  t.ok(Date.now() - startedAt >= 150, 'it waited for them')
})

test('playback does not wait when the host announced no history', async (t) => {
  const startedAt = Date.now()
  t.is(await waitFor(fakeRemote({ announced: 0, arrivesAfterMs: 10000 })), 0)
  t.ok(Date.now() - startedAt < 1000, 'answered at once')
})

test('playback does not wait for a session that is no longer joined', async (t) => {
  const remote = fakeRemote({ announced: 4, arrivesAfterMs: 10000 })
  remote.active = false
  const startedAt = Date.now()
  t.is(await waitFor(remote), 0)
  t.ok(Date.now() - startedAt < 1000, 'answered at once')
})
