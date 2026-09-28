const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')

const SessionEngine = require('../engine')
const PtyHost = require('../electron/pty-host')

// Every open of a session's corestore takes an exclusive directory lock. Calls
// that open the store transiently (session.list measuring history size,
// session.open, player.open) used to race session.extend's open and fail it
// with "File descriptor could not be locked".
for (const other of ['session.list', 'session.open', 'player.open']) {
  test(`session.extend survives a concurrent ${other}`, async (t) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-store-lock-'))
    const engine = new SessionEngine({ userData: dir, ptyHost: new PtyHost() })
    await engine.ready()
    t.teardown(async () => {
      await engine.close().catch(() => {})
      await fs.promises.rm(dir, { recursive: true, force: true })
    })

    const { sessionId } = await engine.invoke('session.create', {
      name: 'lock',
      cols: 90,
      rows: 30
    })
    for (let round = 0; round < 4; round++) {
      const exited = new Promise((resolve) => {
        const onExit = (event) => {
          if (event.sessionId !== sessionId) return
          engine.off('session:exit', onExit)
          resolve()
        }
        engine.on('session:exit', onExit)
      })
      await engine.invoke('session.input', { sessionId, data: 'echo hi; exit\n' })
      await exited

      const calls = [engine.invoke('session.extend', { sessionId })]
      for (let k = 0; k < 6; k++) {
        calls.push(delay(k * round).then(() => engine.invoke(other, { sessionId })))
      }
      const results = await Promise.allSettled(calls)
      const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message)
      t.alike(failures, [], `round ${round}`)
      t.is(results[0].value && results[0].value.active, true, `round ${round} extended live`)
    }
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
