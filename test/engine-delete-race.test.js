const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')

const SessionEngine = require('../engine')

// A host whose shell takes a moment to exit, like a real PTY.
class SlowExitHost extends EventEmitter {
  spawn(sessionId) {
    let alive = true
    return {
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {
        if (!alive) return
        alive = false
        setTimeout(() => this.emit('exit', { sessionId, exit: { code: 0, signal: null } }), 20)
      }
    }
  }

  output(sessionId, text) {
    this.emit('data', { sessionId, data: Buffer.from(text) })
  }
}

// What the renderer does when the selected live session exits: list the
// sessions and reopen the exited one for playback, while session.delete (which
// caused the exit) is still removing its files.
test('deleting a live session wins over the playback reopen its exit triggers', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-delete-race-test-'))
  const host = new SlowExitHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  try {
    for (let round = 0; round < 5; round++) {
      const { sessionId } = await engine.invoke('session.create', { cols: 80, rows: 24 })
      for (let i = 0; i < 50; i++) host.output(sessionId, `line ${i}\r\n`)
      const reopened = []
      const onExit = (event) => {
        if (event.sessionId !== sessionId) return
        reopened.push(engine.invoke('session.list').catch(() => {}))
        reopened.push(engine.invoke('player.open', { sessionId }).catch((err) => err))
      }
      engine.on('session:exit', onExit)
      await engine.invoke('session.delete', { sessionId })
      await Promise.all(reopened)
      engine.off('session:exit', onExit)

      const list = await engine.invoke('session.list')
      t.absent(
        list.some((item) => item.sessionId === sessionId),
        `round ${round}: gone from the list`
      )
      t.absent(engine.players.has(sessionId), `round ${round}: no player left holding it`)
      t.absent(
        fs.existsSync(path.join(engine.paths.corestore, sessionId)),
        `round ${round}: recording removed`
      )
    }
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('playback of a deleted session does not recreate its recording', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-delete-race-test-'))
  const host = new SlowExitHost()
  const engine = new SessionEngine({ userData: dir, ptyHost: host })
  await engine.ready()
  try {
    const { sessionId } = await engine.invoke('session.create', { cols: 80, rows: 24 })
    await engine.invoke('session.delete', { sessionId })
    await t.exception(engine.invoke('player.open', { sessionId }), /not found/)
    await t.exception(engine.invoke('session.open', { sessionId }), /not found/)
    t.absent(fs.existsSync(path.join(engine.paths.corestore, sessionId)))
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})
