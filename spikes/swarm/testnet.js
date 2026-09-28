// Shared helper for spikes 2 and 3: a local hyperdht testnet (no public
// DHT, no relay) plus a factory that builds Hyperswarm instances shaped
// like ShareManager._createSwarm (engine/share-manager.js) - same keyPair
// per identity, firewall/relayThrough passthrough. Throwaway spike code,
// never imported by app code.
const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const crypto = require('hypercore-crypto')

async function setupTestnet(size = 1) {
  const testnet = await createTestnet(size)
  return testnet
}

// Mirrors ShareManager._createSwarm's shape: fixed keyPair identity,
// optional firewall, no relay (relayThrough left unset - this app's
// relayThrough is a fallback path spikes 2/3 don't exercise).
function makeSwarm(testnet, opts = {}) {
  const keyPair = opts.keyPair || crypto.keyPair()
  return new Hyperswarm({
    keyPair,
    bootstrap: testnet.bootstrap,
    firewall: opts.firewall
  })
}

module.exports = { setupTestnet, makeSwarm }
