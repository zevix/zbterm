// The ShareBackend conformance suite, run against the Pear backend over a
// local hyperdht testnet (no public network, no relay). Every swarm made here
// is destroyed in teardown - a leaked one keeps the process alive.
const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')

const PearBackend = require('../../engine/backends/pear')
const conformance = require('./conformance')

async function makePair() {
  const testnet = await createTestnet(3)
  const made = []
  const create = () => {
    const backend = new PearBackend()
    // The swarm factory is the Pear backend's seam: the testnet bootstrap is
    // installed there. The relay registry lookup would reach for the public
    // DHT, so it is switched off.
    backend._relayPublicKey = null
    backend._startRelayRegistryLookup = () => {}
    backend._createSwarm = (opts = {}) =>
      new Hyperswarm({
        keyPair: backend._keyPair(),
        bootstrap: testnet.bootstrap,
        firewall: opts.firewall,
        relayThrough: 'relayThrough' in opts ? opts.relayThrough : backend._relayPublicKey
      })
    made.push(backend)
    return backend
  }
  return {
    host: create(),
    viewer: create(),
    create,
    teardown: async () => {
      for (const backend of made) await backend.stop()
      await testnet.destroy()
    }
  }
}

conformance.run('pear', makePair)

// Pear-only: Hyperswarm dedupes to one socket per remote keypair, so the two
// joins of the shared case ride one connection. This assertion moved here from
// test/share-manager-network.test.js (backend-abstraction B5); the rest of
// that case is in the suite, where it runs against every backend.
test(
  'a single viewer identity can join two sessions hosted by the same host over one shared ' +
    'swarm (closes the Phase 1 regression - see docs/DESIGN-SWARM-AND-WORKER.md, ' +
    '"New pitfall 3 addendum")',
  async (t) => {
    const { statusA, statusB, hostManager } = await conformance.joinTwoSessions(t, makePair)
    t.is(statusA.status, 'joined', 'the first session join reaches joined')
    t.is(statusB.status, 'joined', 'the second session join (same host) also reaches joined')

    const diagnostics = hostManager.diagnostics()
    t.is(
      diagnostics.hostSwarm.connections,
      1,
      'both sessions are served to this one viewer identity over a single deduped connection'
    )
  }
)
