// Bare sidecar entrypoint for test/backends/freenet-bare.test.js: proves the
// Freenet client under the Bare the product ships. Spawned through
// engine/spawn-worker.js::spawnWorker with argv [nodeUrl, idleMs?]; writes one
// JSON line on Bare.IPC: { ok, health, routeOk, error, idleHealth }. With
// idleMs the node connection is left idle that long first (S-29, F9).
//
// The same three globals engine/worker.js installs before anything else.
globalThis.process = require('bare-process')
globalThis.navigator = globalThis.navigator || { userAgent: 'bare' }
globalThis.performance = globalThis.performance || { now: () => Date.now() }

const nodeUrl = Bare.argv[2]
const idleMs = Number(Bare.argv[3]) || 0

function reply(body) {
  Bare.IPC.write(JSON.stringify(body) + '\n')
}

async function main() {
  const FreenetBackend = require('../../engine/backends/freenet/index.js')
  const backend = new FreenetBackend({ nodeUrl })
  const keyPair = { publicKey: Buffer.alloc(32, 7), secretKey: Buffer.alloc(64, 7) }
  await backend.start({ keyPair: () => keyPair })
  const health = backend.health()
  let idleHealth = null
  if (idleMs) {
    await new Promise((resolve) => setTimeout(resolve, idleMs))
    idleHealth = backend.health()
  }
  const route = backend.routeFor('bare-link', null)
  const routeOk =
    typeof route.sig === 'string' &&
    /^[0-9a-f]{64}$/.test(route.code) &&
    route.params.host === '07'.repeat(32)
  await backend.stop()
  await backend.stop()
  return {
    ok: health.started === true && routeOk,
    health,
    routeOk,
    idleHealth,
    stopped: backend.health()
  }
}

main().then(reply, (err) =>
  reply({ ok: false, error: String((err && err.stack) || err), code: err && err.code })
)
