// The ShareBackend conformance suite, run against the in-process loopback
// backend. Each pair gets its own hub, so tests cannot reach each other.
const LoopbackBackend = require('../../engine/backends/loopback')
const { LoopbackHub } = require('../../engine/backends/loopback')
const conformance = require('./conformance')

conformance.run('loopback', () => {
  const hub = new LoopbackHub()
  const made = []
  const create = () => {
    const backend = new LoopbackBackend({ hub })
    made.push(backend)
    return backend
  }
  return Promise.resolve({
    host: create(),
    viewer: create(),
    create,
    teardown: async () => {
      for (const backend of made) await backend.stop()
    }
  })
})
