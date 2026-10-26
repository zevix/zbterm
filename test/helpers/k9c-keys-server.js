// A loopback stand-in for github.com's `<user>.keys` endpoint, for tests
// whose `zxterm-core` sidecar fetches provider keys itself (K9 of
// zxterm-core): pass `server.base` as the sidecar's `ZBTERM_GITHUB_KEYS_BASE`.
// Every request is recorded (`server.requests`, the path asked for), and
// `server.respond(name)` decides the answer: `{ status, body, delayMs }`.
// Never reaches the network beyond 127.0.0.1.
const http = require('http')

async function keysServer(t, respond) {
  const handle = { requests: [], respond: respond || (() => ({ status: 404 })), base: null }
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(
      String(req.url)
        .replace(/^\//, '')
        .replace(/\.keys$/, '')
    )
    handle.requests.push(req.url)
    const answer = handle.respond(name) || {}
    const send = () => {
      res.writeHead(answer.status || 200, { 'content-type': 'text/plain' })
      res.end(answer.body || '')
    }
    if (answer.delayMs) setTimeout(send, answer.delayMs)
    else send()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  handle.base = `http://127.0.0.1:${server.address().port}`
  t.teardown(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(() => resolve()))
  })
  return handle
}

// The body github serves for a list of published keys.
function keysBody(keys) {
  return keys.map((key) => `${key.keyType} ${key.blobBase64}`).join('\n') + '\n'
}

// A loopback base URL nothing listens on: a fetch against it is refused at
// once (ECONNREFUSED), the sidecar's "provider unreachable" case.
async function refusedBase() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

module.exports = { keysServer, keysBody, refusedBase }
