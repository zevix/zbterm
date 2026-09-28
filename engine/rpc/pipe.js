// Shared tuning for the framed-stream pipe between the host process and the
// worker (engine/worker.js <-> engine/client.js: the one physical pipe that
// carries every INVOKE/PTY_*/EVENT_*/BACKEND_* frame, docs/CORE-CONTRACT.md).
//
// framed-stream never exposes a highWaterMark option (node_modules/
// framed-stream/index.js's constructor hardcodes `{ mapWritable }` to its
// `super()` call, dropping anything else a caller might pass), so its
// Writable side keeps streamx's default of 16 384 bytes. That default made
// `pipe.write()` return false for ANY single write of 16 KiB or more, even on
// a completely idle pipe: streamx's WritableState.push() adds this write's
// byte length to `buffered` and *then* compares it to `highWaterMark` (see
// node_modules/streamx/index.js), so one write already past the threshold
// reports "full" before anything is actually queued behind it, real
// congestion or none.
//
// Callers up the stack treated that `false` as "this link cannot keep up
// right now" and paused delivery - RtcRemote.send (engine/backends/freenet/
// rtc-remote.js) pausing a channel's flow, EngineClient._sendBackendData /
// _sendPtyData (engine/client.js) pausing the rtc/pty source - including
// ShareManager's own lag-resync bootstrap (engine/share-manager.js), which is
// itself typically tens of KiB. The result: a single BACKEND_DATA frame of
// 16 KiB or more always reported backpressure, and the resync meant to bring
// a lagging peer back always re-tripped the same false alarm, so a peer that
// started lagging under a flood never came back - it saw a new screen only
// once every LAG_RESYNC_MAX_MS, forever.
//
// The fix: `write()` returning false must mean "a meaningful number of bytes
// are actually buffered ahead of this one", not "one write happened to be
// big". PIPE_HIGH_WATER_MARK sits comfortably above the largest single frame
// this seam ever carries in one piece - a Freenet data-channel part is capped
// at MAX_MESSAGE_SIZE (65 536 bytes, engine/backends/freenet/channel.js) plus
// a small envelope, and a PTY read is far smaller - so one frame from an
// otherwise idle pipe never trips it, while genuine congestion (many frames
// queued because the transport truly cannot drain them fast enough) still
// does, once buffered bytes cross it. The value matches FLOW_LIMIT
// (engine/index.js), this codebase's existing threshold for "meaningfully
// behind".
const PIPE_HIGH_WATER_MARK = 1024 * 1024

// Raises a FramedStream's Writable-side highWaterMark after construction,
// since framed-stream itself never takes the option. Both ends of the seam
// call this on their own FramedStream (engine/worker.js's `pipe`,
// engine/client.js's `this._pipe`, each time one is (re)spawned) so the fix
// applies symmetrically in both directions of the same physical pipe.
function tunePipe(pipe) {
  if (pipe && pipe._writableState) pipe._writableState.highWaterMark = PIPE_HIGH_WATER_MARK
  return pipe
}

module.exports = { PIPE_HIGH_WATER_MARK, tunePipe }
