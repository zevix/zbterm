// The Freenet share path's side of the core's C3 history (K17 of
// zxterm-core, stage C3; ZBTerm D-40). A Freenet share's history is the Rust
// `zxterm-core` sidecar's: `history.*` keeps it in segment files
// (`zxterm_core::history`), serves a viewer's range live on the session's
// `history` channel (`share.history`) and publishes it to the `segment-v1`
// contract so a viewer can read it with the host offline
// (`history.readContract`); `crate::seam::history_methods` in zxterm is the
// method table. Local-only sessions and Pear shares never come here: their
// history is the Hypercore of `../session-store.js` (D-18).
//
// Two halves, neither knowing the engine or the share manager:
//
//   HostHistory         the host's writer. At a session's first Freenet share
//                       it feeds the session's existing Hypercore packets to
//                       `history.import` once (X-02; `imported` in the state
//                       file below), then appends what the store records
//                       from then on (`history.append`, in the order the store
//                       appended it), tells the core about each epoch
//                       (`history.setEpoch`) and closes a segment when the
//                       output goes quiet (`history.flush`), because the core
//                       serves and publishes closed segments only.
//
//   CoreHistoryHandle   the viewer's reader: the `HistoryHandle` the backend's
//                       `attachHistory` returns. `fetch({start, end})` asks
//                       the core for the packets of a range and appends what
//                       it verified to the viewer's store
//                       (`SessionStore#appendVerified`). Live, it is a range
//                       request to the host over the `history` channel
//                       (`share.history`, each segment verified with
//                       `history.verify`); with the host gone, or when the
//                       core holds no connection to it, it is a read of the
//                       contract (`history.readContract`). The core offers the
//                       two as separate calls, so the choice between them is
//                       made here from one fact, whether the host's
//                       connection is live (zxterm R-26).
//
// The label of the former Hypercore-over-raw-channel
// replication (a `zbterm` history channel) is gone with `engine/backends/freenet/history.js`.
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const b4a = require('b4a')

const { EngineError, CODES } = require('../errors')
const { PacketKind } = require('../schema')
const { deriveSnapshotKey } = require('../crypto')
const { b64, unb64 } = require('./share')

// Under a session's directory: the core's segment files and ZBTerm's own
// record of them. Neither is replicated: `state.json` holds the signing seed.
const HISTORY_DIR = 'zxhistory'
const SEGMENTS_DIR = 'segments'
const STATE_FILE = 'state.json'
const CORE_SEGMENTS_FILE = 'segments.zxs'

// `history.import` and `history.append` take their packets as JSON text, bytes
// in base64 (a third bigger), and the seam refuses a frame above 8 MiB
// (`zxterm_core::seam::protocol::MAX_FRAME_BYTES`) by dropping the connection:
// a batch is at most this many bytes of payload.
const IMPORT_BATCH_BYTES = 4 * 1024 * 1024
const APPEND_BATCH_BYTES = 3 * 1024 * 1024
// A segment still open is neither served nor published, so a host whose
// output has gone quiet closes it.
const IDLE_FLUSH_MS = 2000
// `history.close` waits for the contract's acknowledgement up to 10 s.
const CLOSE_WAIT_MS = 12000

// `history.read` and `history.verify` hand packets back in the core's shape.
function packetFromCore(p) {
  return {
    seq: p.seq,
    tsMs: p.tsMs,
    kind: p.kind,
    cols: p.cols === undefined ? null : p.cols,
    rows: p.rows === undefined ? null : p.rows,
    payload: p.payload ? unb64(p.payload) : Buffer.alloc(0),
    hd: !!p.hd
  }
}

function packetToCore(p) {
  const out = { tsMs: p.tsMs, kind: p.kind, hd: !!p.hd }
  if (p.cols !== undefined && p.cols !== null) out.cols = p.cols
  if (p.rows !== undefined && p.rows !== null) out.rows = p.rows
  if (p.payload) out.payload = b64(p.payload)
  return out
}

function packetBytes(p) {
  return 64 + (p.payload ? p.payload.byteLength : 0)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The file `state.json` is written like ZBTerm's other JSON records
// (session-store.js::writeRemoteManifest, account-store.js): a temp file in
// the same directory, then a rename, so a crash leaves the old or the new
// record and never half of one.
async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.promises.writeFile(temp, JSON.stringify(value))
  await fs.promises.rename(temp, file)
}

async function readState(dir) {
  try {
    const state = JSON.parse(await fs.promises.readFile(path.join(dir, STATE_FILE), 'utf8'))
    if (state && typeof state.signingSeed === 'string' && state.signingSeed.length === 64) {
      return { signingSeed: state.signingSeed, imported: state.imported === true }
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err
  }
  return null
}

// Whether `store` is a real session store this module can read and write
// history for (a test's stub has no directory to keep files in).
function supportsHistory(store) {
  return !!(
    store &&
    typeof store.dir === 'string' &&
    typeof store.readRange === 'function' &&
    store.log &&
    typeof store.log.length === 'number'
  )
}

class HostHistory {
  // `request(method, args)` is the seam's (the bridge's); `store` the
  // session's SessionStore.
  constructor({ request, store, sessionId, debug }) {
    this._request = request
    this.store = store
    this.sessionId = sessionId
    this._debug = debug || (() => {})
    this.dir = path.join(store.dir, HISTORY_DIR)
    this.verifyingKey = null
    this.next = 1
    this.imported = false
    this.opened = false
    this.published = false
    this._buf = []
    this._chain = Promise.resolve()
    this._draining = false
    this._idle = null
    this._closed = false
    this._listener = null
  }

  // Opens (or creates) the session's history in the core, feeds it the
  // packets it lacks and starts publishing it. The store's appends are
  // forwarded from here on. Throws what the core refuses.
  async open() {
    const store = this.store
    await fs.promises.mkdir(this.dir, { recursive: true })
    let state = await readState(this.dir)
    if (!state) {
      state = { signingSeed: crypto.randomBytes(32).toString('hex'), imported: false }
      await writeJson(path.join(this.dir, STATE_FILE), state)
    }
    const segments = path.join(this.dir, SEGMENTS_DIR)
    const exists = fs.existsSync(path.join(segments, CORE_SEGMENTS_FILE))
    const epochKeys = await this._epochKeys()
    const epoch = store.epoch
    const base = {
      sessionId: this.sessionId,
      dir: segments,
      signingKey: state.signingSeed,
      snapshotKey: b4a.toString(deriveSnapshotKey(store.localDevice.secretKey), 'hex'),
      cols: (store.info && store.info.cols) || 80,
      rows: (store.info && store.info.rows) || 24,
      epochKeys,
      epoch,
      firstSeq: 1
    }
    // Packets forwarded while this runs wait in `_buf` (the store's hook is
    // set first), and are appended by sequence number afterwards.
    this.attach()
    const length = store.log.length
    let result
    try {
      result = await this._openOrImport({ base, state, exists, length, epochKeys, epoch })
    } catch (err) {
      this.detach()
      throw err
    }
    this.next = result.nextSeq
    this.opened = true
    await this._catchUp(store.log.length)
    const head = await this._request('history.head', { sessionId: this.sessionId })
    this.verifyingKey = head.verifyingKey
    store.historyVerifyingKey = this.verifyingKey
    try {
      await this._request('history.publish', { sessionId: this.sessionId })
      this.published = true
    } catch (err) {
      // The share still works without the offline copy; say why it has none.
      this._debug('host:history:publish-failed', {
        sessionId: this.sessionId,
        message: err.message
      })
    }
    this._drain()
    return this
  }

  async _openOrImport({ base, state, exists, length, epochKeys, epoch }) {
    const open = async (args) => {
      try {
        return await this._request(args.method, args.args)
      } catch (err) {
        // A sidecar outlives an engine: a history its last run left open is
        // closed and opened again, as share.hostOpen's is.
        if (!/already open/.test((err && err.message) || '')) throw err
        await this._request('history.close', { sessionId: this.sessionId }).catch(() => {})
        return await this._request(args.method, args.args)
      }
    }
    if (exists) {
      // The core already holds this session (an earlier share, or a crash
      // between the import and the flag): never import a second time.
      const result = await open({ method: 'history.open', args: base })
      if (!state.imported) {
        await writeJson(path.join(this.dir, STATE_FILE), { ...state, imported: true })
      }
      this.imported = true
      return result
    }
    if (state.imported || length === 0) {
      const result = await open({ method: 'history.open', args: { ...base, create: true } })
      if (!state.imported) {
        await writeJson(path.join(this.dir, STATE_FILE), { ...state, imported: true })
      }
      this.imported = true
      return result
    }
    // The first Freenet share of a session that has a recording: its
    // Hypercore packets become the core's history, once (X-02). The first
    // batch goes to `history.import`; a longer log's rest is appended by
    // `_catchUp`, which is also what a crash after the import resumes.
    const packets = []
    let bytes = 0
    for await (const packet of this.store.readRange(1, length, { wait: false })) {
      packets.push(packetToCore(packet))
      bytes += packetBytes(packet)
      if (bytes >= IMPORT_BATCH_BYTES) break
    }
    const result = await open({
      method: 'history.import',
      args: { ...base, epoch, historyKey: epochKeys[String(epoch)], packets }
    })
    await writeJson(path.join(this.dir, STATE_FILE), { ...state, imported: true })
    this.imported = true
    this._debug('host:history:imported', {
      sessionId: this.sessionId,
      packets: packets.length,
      length
    })
    return result
  }

  // The history key of every epoch the store holds, by epoch.
  async _epochKeys() {
    const out = {}
    for (let epoch = 1; epoch <= this.store.epoch; epoch++) {
      try {
        const keys = await this.store._loadLocalEpochKeys(epoch)
        if (keys && keys.historyKey) out[String(epoch)] = b4a.toString(keys.historyKey, 'hex')
      } catch {
        // An epoch this device holds no key for has no packets to seal.
      }
    }
    return out
  }

  // The store tells this what it appends, in order.
  attach() {
    if (this._listener) return
    this._listener = (seq, plain) => this.append(seq, plain)
    this.store.onAppend = this._listener
  }

  detach() {
    if (this._listener && this.store.onAppend === this._listener) this.store.onAppend = null
    this._listener = null
  }

  // One packet the store appended at `seq`.
  append(seq, plain) {
    if (this._closed) return
    this._buf.push({ seq, plain })
    if (this.opened) this._drain()
  }

  _drain() {
    if (this._draining || !this._buf.length) return
    this._draining = true
    this._chain = this._chain
      .then(() => this._drainNow())
      .catch((err) =>
        this._debug('host:history:error', { sessionId: this.sessionId, message: err.message })
      )
      .then(() => {
        this._draining = false
        if (this._buf.length) this._drain()
        else this._armIdle()
      })
  }

  // Everything queued, in the order it was queued: packets go out in batches,
  // and an epoch change is a barrier between the batch before it and the one
  // after (a packet recorded after a rotation must be sealed under the new
  // epoch's key, or a member that rotation excluded could read it).
  async _drainNow() {
    while (this._buf.length) {
      const batch = []
      let bytes = 0
      let epoch = null
      while (this._buf.length && bytes < APPEND_BATCH_BYTES) {
        const item = this._buf[0]
        if (item.epoch !== undefined) {
          if (batch.length) break
          epoch = this._buf.shift()
          break
        }
        this._buf.shift()
        if (item.seq < this.next) continue
        if (item.seq > this.next + batch.length) {
          // A packet the core was never given (the store kept appending
          // while no history was attached): read the gap from the store.
          if (batch.length) await this._appendBatch(batch.splice(0))
          await this._catchUp(item.seq - 1)
        }
        if (item.seq !== this.next + batch.length) continue
        batch.push(packetToCore(item.plain))
        bytes += packetBytes(item.plain)
      }
      if (batch.length) await this._appendBatch(batch)
      if (epoch) {
        await this._request('history.setEpoch', {
          sessionId: this.sessionId,
          epoch: epoch.epoch,
          ...(epoch.key ? { key: epoch.key } : {})
        })
      }
    }
  }

  async _appendBatch(packets) {
    if (!packets.length) return
    const result = await this._request('history.append', { sessionId: this.sessionId, packets })
    this.next = result.nextSeq
  }

  // Appends store packets `this.next..last` the core does not hold.
  async _catchUp(last) {
    while (this.next <= last) {
      const packets = []
      let bytes = 0
      const from = this.next
      for await (const packet of this.store.readRange(from, last, { wait: false })) {
        packets.push(packetToCore(packet))
        bytes += packetBytes(packet)
        if (bytes >= APPEND_BATCH_BYTES) break
      }
      if (!packets.length) break
      await this._appendBatch(packets)
    }
  }

  _armIdle() {
    if (this._closed) return
    if (this._idle) clearTimeout(this._idle)
    this._idle = setTimeout(() => {
      this._idle = null
      this._chain = this._chain
        .then(() => (this._buf.length ? null : this._request('history.flush', this._sid())))
        .catch(() => {})
    }, IDLE_FLUSH_MS)
    if (this._idle.unref) this._idle.unref()
  }

  _sid() {
    return { sessionId: this.sessionId }
  }

  // The epoch `epoch` is current from the next packet on; `historyKeyHex` is
  // its history key. Queued between the packets appended before it and the
  // ones after.
  setEpoch(epoch, historyKeyHex) {
    if (this._closed || !this.opened) return
    this._buf.push({ epoch, key: historyKeyHex || null })
    this._drain()
  }

  // Closes the open segment now and waits for it to be published.
  async flush() {
    if (!this.opened) return
    this._chain = this._chain
      .then(() => this._drainNow())
      .then(() => this._request('history.flush', this._sid()))
      .catch(() => {})
    await this._chain
  }

  // Forwards the rest, closes the last segment, and lets the core publish it
  // (up to 10 s) before it drops the history.
  async close() {
    if (this._closed) return
    this.detach()
    if (this._idle) clearTimeout(this._idle)
    this._idle = null
    if (this.opened) {
      this._chain = this._chain
        .then(() => this._drainNow())
        .then(() => this._request('history.flush', this._sid()))
        .then(() => this._request('history.close', this._sid()))
        .catch(() => {})
      await Promise.race([this._chain, delay(CLOSE_WAIT_MS)])
    }
    this._closed = true
    this.opened = false
  }
}

// The viewer's reader. `core` is the seam bridge (`request`, events
// `historySegment`/`historyDone`); `live()` says whether the connection to
// the host is up; `keys` is an object whose `verifyingKey` (hex) may arrive
// after this is made.
const LIVE_POLL_MS = 1000
const CONTRACT_POLL_MS = 5000
// Segments a `history.readContract` reply holds: its packets come back as JSON
// in one seam frame (8 MiB at most), a segment being up to 128 KiB of output.
const CONTRACT_SEGMENTS = 32
// A range request that brings neither a segment nor its end in this long is
// over: the host is gone.
const REPLY_TIMEOUT_MS = 30000

class CoreHistoryHandle {
  constructor({ core, store, keys, live, debug }) {
    this.core = core
    this.store = store
    this.keys = keys || {}
    this._live = live || (() => false)
    this._debug = debug || (() => {})
    this._closed = false
    this._downloads = new Set()
    this._inbox = new Map()
    this._waiting = new Map()
    this._lastContractError = null
    const onSegment = (d) => this._deliver(d, 'segment')
    const onDone = (d) => this._deliver(d, 'done')
    if (core && typeof core.on === 'function') {
      core.on('historySegment', onSegment)
      core.on('historyDone', onDone)
      this._off = () => {
        core.off('historySegment', onSegment)
        core.off('historyDone', onDone)
      }
    } else {
      this._off = () => {}
    }
  }

  // The `HistoryHandle` contract: a range of the log (`start` packets held,
  // up to `end`) as an object with `done()` and `destroy()`.
  fetch({ start, end }) {
    const job = { destroyed: false, promise: null }
    job.promise = this.pull(Number.isFinite(end) ? end : Infinity, job)
    job.promise.catch(() => {})
    const download = {
      done: () => job.promise,
      destroy: () => {
        job.destroyed = true
        this._downloads.delete(download)
        for (const waiter of this._waiting.values()) waiter.wake()
      }
    }
    void start
    this._downloads.add(download)
    return download
  }

  close() {
    this._closed = true
    this._off()
    for (const download of Array.from(this._downloads)) download.destroy()
    for (const waiter of this._waiting.values()) waiter.wake()
  }

  // Fetches until the store holds `end` packets or a round brings none; a
  // round that brings none waits before it returns, so a caller looping on
  // it polls for output the host has not closed into a segment yet.
  async pull(end, job = { destroyed: false }, { poll = true } = {}) {
    for (;;) {
      if (this._closed || job.destroyed) return
      const have = await this.store.availableLength()
      if (have >= end) return
      const progressed = await this._round(have, end, job)
      if (!progressed) {
        if (poll) await delay(this._live() ? LIVE_POLL_MS : CONTRACT_POLL_MS)
        return
      }
    }
  }

  get ready() {
    return !!(this._verifyingKey() && this.store.historyInfoReady)
  }

  _verifyingKey() {
    return this.keys.verifyingKey || this.store.historyVerifyingKey || null
  }

  // One request; whether it added packets.
  async _round(have, end, job) {
    if (!this.ready) return false
    if (this._live()) {
      try {
        return await this._liveRound(have, end, job)
      } catch (err) {
        // The connection went before the range could be asked for: the
        // contract holds the same segments. A segment that failed its
        // checks is not that, and is thrown.
        if (!err || !err.noPeer) throw err
        this._debug('viewer:history:live-gone', { message: err.message })
      }
    }
    return await this._contractRound(have, job)
  }

  async _liveRound(have, end, job) {
    const sessionId = this.store.sessionId
    const first = have + 1
    const to = Number.isFinite(end) ? end + 1 : first + 1e9
    let requestId
    try {
      ;({ requestId } = await this.core.request('share.history', {
        sessionId,
        start: first,
        end: to
      }))
    } catch (err) {
      err.noPeer = true
      throw err
    }
    const inbox = this._inboxFor(requestId)
    let progressed = false
    try {
      for (;;) {
        if (this._closed || job.destroyed) return progressed
        const item = await this._next(requestId, inbox, job)
        if (!item) return progressed
        if (item.type === 'done') {
          await this.core.request('history.verifyDone', {
            sessionId,
            requestId,
            start: first,
            next: item.next
          })
          return progressed
        }
        const verified = await this.core.request('history.verify', {
          sessionId,
          requestId,
          verifyingKey: this._verifyingKey(),
          epochKeys: this.store.historyKeysHex(),
          data: item.data
        })
        if (await this._store(verified.packets)) progressed = true
        this.core
          .request('share.historyCredit', { sessionId, requestId, credit: 1 })
          .catch(() => {})
      }
    } finally {
      this._inbox.delete(requestId)
    }
  }

  async _contractRound(have, job) {
    const sessionId = this.store.sessionId
    let from = 0
    let progressed = false
    for (;;) {
      if (this._closed || job.destroyed) return progressed
      let view
      try {
        view = await this.core.request('history.readContract', {
          sessionId,
          verifyingKey: this._verifyingKey(),
          epochKeys: this.store.historyKeysHex(),
          from,
          count: CONTRACT_SEGMENTS
        })
      } catch (err) {
        // The node or the contract is not there: nothing to add. A state the
        // viewer refuses (a bad signature, a broken chain) is not that.
        if (err && (err.code === CODES.E_CORRUPT || err.code === CODES.E_AUTH)) throw err
        this._lastContractError = err.message
        this._debug('viewer:history:contract-unavailable', { message: err.message })
        return progressed
      }
      for (const segment of view.segments) {
        const packets = segment.packets.filter((p) => p.seq > have)
        if (packets.length && (await this._store(packets))) {
          progressed = true
          have = await this.store.availableLength()
        }
      }
      const last = view.segments.length ? view.segments[view.segments.length - 1].index : -1
      if (!view.segments.length || last + 1 >= view.headLength) return progressed
      from = last + 1
    }
  }

  // Appends the verified packets that continue the store; whether any did.
  async _store(rawPackets) {
    if (!rawPackets || !rawPackets.length) return false
    const have = await this.store.availableLength()
    const packets = rawPackets.map(packetFromCore).filter((p) => p.seq > have)
    if (!packets.length) return false
    if (packets[0].seq !== have + 1) return false
    await this.store.appendVerified(packets)
    return true
  }

  _inboxFor(requestId) {
    let inbox = this._inbox.get(requestId)
    if (!inbox) {
      inbox = { items: [] }
      this._inbox.set(requestId, inbox)
    }
    return inbox
  }

  // A seam event for some range request: queued for whoever waits for it.
  _deliver(data, type) {
    if (!data || data.sessionId !== this.store.sessionId) return
    const inbox = this._inboxFor(data.requestId)
    inbox.items.push(type === 'segment' ? { type, data: data.data } : { type, next: data.next })
    const waiter = this._waiting.get(data.requestId)
    if (waiter) waiter.wake()
  }

  async _next(requestId, inbox, job) {
    for (;;) {
      if (inbox.items.length) return inbox.items.shift()
      if (this._closed || job.destroyed) return null
      let timedOut = false
      await new Promise((resolve) => {
        const waiter = {
          wake: () => {
            clearTimeout(timer)
            this._waiting.delete(requestId)
            resolve()
          }
        }
        const timer = setTimeout(() => {
          timedOut = true
          waiter.wake()
        }, REPLY_TIMEOUT_MS)
        this._waiting.set(requestId, waiter)
      })
      if (timedOut && !inbox.items.length) {
        const err = new EngineError(CODES.E_NET, 'The host stopped answering a history request')
        err.noPeer = true
        throw err
      }
    }
  }
}

module.exports = {
  HostHistory,
  CoreHistoryHandle,
  supportsHistory,
  packetFromCore,
  packetToCore,
  HISTORY_DIR,
  IDLE_FLUSH_MS,
  PacketKind
}
