'use strict'

// Session output is sent to the renderer in batches (261111_buffer-search F3,
// U3): a flood arrives as thousands of ~1 KB chunks a second, and one IPC
// message each backed the main-to-renderer channel up until nothing else
// (invoke answers, the debug server's scripts) got through. Chunks of the same
// session, source and HD state are joined and sent every `flushMs`, or at once
// past `flushBytes`. The caller must flush before anything else it sends the
// renderer - other events AND invoke answers (F4: a `session.open` answer that
// overtook queued output got that output painted twice over its frame) - so
// the order the renderer sees is unchanged. The bytes are the same, so the
// renderer's acks count the same.

const DEFAULT_FLUSH_MS = 8
const DEFAULT_FLUSH_BYTES = 64 * 1024

function byteLength(data) {
  if (!data) return 0
  if (typeof data === 'string') return Buffer.byteLength(data)
  return data.byteLength || 0
}

function createSessionDataBatcher({
  send,
  flushMs = DEFAULT_FLUSH_MS,
  flushBytes = DEFAULT_FLUSH_BYTES,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let queue = []
  let bytes = 0
  let timer = null

  function flush() {
    if (timer) clearTimer(timer)
    timer = null
    const items = queue
    queue = []
    bytes = 0
    if (!items.length) return
    const first = items[0]
    const data =
      items.length === 1
        ? first.data
        : Buffer.concat(items.map((item) => Buffer.from(item.data || [])))
    send({ ...first, data })
  }

  function push(data) {
    const last = queue[queue.length - 1]
    if (
      last &&
      (last.sessionId !== data.sessionId || last.source !== data.source || last.hd !== data.hd)
    ) {
      flush()
    }
    queue.push(data)
    bytes += byteLength(data.data)
    if (bytes >= flushBytes) {
      flush()
    } else if (!timer) {
      timer = setTimer(flush, flushMs)
    }
  }

  return { push, flush, pending: () => queue.length }
}

module.exports = { createSessionDataBatcher, DEFAULT_FLUSH_MS, DEFAULT_FLUSH_BYTES }
