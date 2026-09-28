// Probe P-3 (Bare half): does each WebRTC library even load under Bare?
// Run: bare spikes/freenet/p3-bare.js
require('./lib/bare-shims')
for (const name of ['node-datachannel', 'werift', '@roamhq/wrtc']) {
  try {
    const m = require(name)
    console.log(JSON.stringify({ lib: name, loaded: true, exports: Object.keys(m).length }))
  } catch (err) {
    console.log(JSON.stringify({ lib: name, loaded: false, failure: String(err && err.message).split('\n')[0] }))
  }
}
Bare.exit(0)
