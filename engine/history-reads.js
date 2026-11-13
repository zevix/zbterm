// Counts the engine's reads of recorded history (261111_buffer-search U2):
// every store opened on a recording (`SessionStore.open`/`openJoined`), every
// packet read from one (`SessionStore#readRange`, the one path to a
// recording's packets) and every snapshot read from the cache
// (`SnapshotCache#read`). Answered by `debug.historyReads`, so a check can
// show that a buffer search reads none of it. Counting only; nothing reads
// these to decide anything.
const counts = { storeOpens: 0, packets: 0, snapshots: 0 }

function noteHistoryRead(kind) {
  counts[kind] = (counts[kind] || 0) + 1
}

function historyReads() {
  return { ...counts }
}

module.exports = { noteHistoryRead, historyReads }
