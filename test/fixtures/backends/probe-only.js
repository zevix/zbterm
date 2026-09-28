// A backend that loads but declares itself unusable (the shape B8's Freenet
// stub takes): listed, `state: 'broken'`, with the detail it gives.
const LoopbackBackend = require('../../../engine/backends/loopback')

class ProbeOnlyBackend extends LoopbackBackend {
  static availability() {
    return { state: 'broken', detail: 'probe only' }
  }

  describe() {
    return { ...super.describe(), id: 'freenet', label: 'Fixture (probe only)' }
  }
}

module.exports = ProbeOnlyBackend
