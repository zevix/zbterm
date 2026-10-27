// The ShareBackend conformance suite, run against the Freenet backend
// (docs/projects/260924_freenet-backend/), every case of it since F8. Since
// K11 of zxterm-core (ZBTerm D-34) the backend is a proxy to the Rust
// `zxterm-core` sidecar, which runs the contract client and WebRTC: every
// backend of a pair gets a sidecar of its own (test/helpers/zxterm-core.js),
// no ICE servers (host candidates only), and all of them meet on one
// throwaway local-mode node (test/helpers/freenet-node.js, never the
// owner's).
//
//   npx brittle-node test/backends/conformance-freenet.test.js
const test = require('brittle')

const { testCore } = require('../helpers/zxterm-core')

const FreenetBackend = require('../../engine/backends/freenet')
const { freenetAvailable, startLocalNode } = require('../helpers/freenet-node')
const conformance = require('./conformance')

let node = null

async function nodeUrl() {
  if (!node) node = await startLocalNode()
  return node.url
}

if (!freenetAvailable()) {
  test('freenet backend conformance: skipped', (t) =>
    t.comment('SKIP:', 'freenet binary not on PATH'))
} else {
  // K14 (ZBTerm D-38): a Freenet share's epochs, envelopes, live frames and
  // input are the core's (`session: true`); every case of the suite runs.
  conformance.run(
    'freenet',
    async () => {
      const url = await nodeUrl()
      const made = []
      const create = () => {
        const core = testCore(null)
        const backend = new FreenetBackend({ nodeUrl: url, core, iceServers: [] })
        made.push({ backend, core })
        return backend
      }
      return {
        host: create(),
        viewer: create(),
        create,
        teardown: async () => {
          for (const { backend, core } of made) {
            await backend.stop()
            core.close()
          }
        }
      }
    },
    { session: true, history: 'core' }
  )

  // Last: the node this file started.
  test('freenet backend conformance: teardown', async (t) => {
    if (node) await node.stop()
    t.pass(node ? `stopped the local node (pid ${node.pid})` : 'no node was started')
  })
}
