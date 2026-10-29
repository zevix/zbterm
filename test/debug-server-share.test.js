// POST /sessions/:id/share passes the share options through to
// share.createLink, the network (`backend`) included.
const net = require('net')
const test = require('brittle')

const { createDebugServer } = require('../electron/debug-server')

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

test('debug server: a share request passes its backend to share.createLink', async (t) => {
  const calls = []
  const engine = {
    invoke: async (method, args) => {
      calls.push([method, args])
      return { linkId: 'l1', uri: 'zbterm://join/x' }
    }
  }
  const server = createDebugServer({ getEngine: () => engine, port: await freePort() })
  const { host, port } = await server.start()
  t.teardown(() => server.stop())

  const res = await fetch(`http://${host}:${port}/sessions/s1/share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'group', autoJoin: true, backend: 'freenet' })
  })
  t.is(res.status, 200)
  const [method, args] = calls.find(([name]) => name === 'share.createLink')
  t.is(method, 'share.createLink')
  t.is(args.sessionId, 's1')
  t.is(args.backend, 'freenet', 'the network choice is not dropped')
  t.is(args.type, 'group')
  t.is(args.autoJoin, true)
})
