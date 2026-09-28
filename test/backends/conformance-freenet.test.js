// The ShareBackend conformance suite, run against the Freenet backend
// (docs/projects/260924_freenet-backend/), every case of it since F8. Every
// backend of a pair meets on one throwaway local-mode node
// (test/helpers/freenet-node.js, never the owner's) and owns an
// electron/rtc-host.js RtcHost, the host half of its WebRTC, with no ICE
// servers (host candidates only).
//
//   npx brittle-node test/backends/conformance-freenet.test.js
const test = require('brittle')

const FreenetBackend = require('../../engine/backends/freenet')
const { RtcHost } = require('../../electron/rtc-host')
const { freenetAvailable, startLocalNode } = require('../helpers/freenet-node')
const conformance = require('./conformance')

let node = null

async function nodeUrl() {
  if (!node) node = await startLocalNode()
  return node.url
}

if (!freenetAvailable()) {
  test('freenet backend conformance: skipped', (t) => t.skip('freenet binary not on PATH'))
} else {
  conformance.run('freenet', async () => {
    const url = await nodeUrl()
    const made = []
    const create = () => {
      const rtcHost = new RtcHost({ iceServers: [] })
      const backend = new FreenetBackend({ nodeUrl: url, rtcHost, iceServers: [] })
      made.push({ backend, rtcHost })
      return backend
    }
    return {
      host: create(),
      viewer: create(),
      create,
      teardown: async () => {
        for (const { backend, rtcHost } of made) {
          await backend.stop()
          rtcHost.closeAll('teardown')
        }
      }
    }
  })

  // Last: the node this file started, and node-datachannel's global teardown
  // (without it the process never exits).
  test('freenet backend conformance: teardown', async (t) => {
    if (node) await node.stop()
    RtcHost.cleanup()
    t.pass(node ? `stopped the local node (pid ${node.pid})` : 'no node was started')
  })
}
