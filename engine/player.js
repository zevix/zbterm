const { EventEmitter } = require('events')

const { PacketKind } = require('./schema')
const { TerminalFrame } = require('./terminal-frame')

const SPEEDS = [0.5, 1, 2, 4, 8]
const PLAYBACK_TICK_MS = 16
const PLAYBACK_YIELD_MS = 8
const PLAYBACK_MAX_BATCH_BYTES = 256 * 1024
const PLAYBACK_MAX_BATCH_PACKETS = 256
const FRAME_REPLAY_MAX_BATCH_BYTES = 512 * 1024

class Player extends EventEmitter {
  constructor(store, snapshotCache) {
    super()
    this.store = store
    this.snapshotCache = snapshotCache
    this.timer = null
    this.seq = storeLength(this.store)
    this.currentTsMs = this.store.timeline.length
      ? this.store.timeline[this.store.timeline.length - 1].tsMs
      : Date.now()
    this.speed = 1
    this.collapse = null
    this.playing = false
    this.playStartedAt = 0
    this.playStartedTsMs = this.currentTsMs
    // Fit-to-window playback. null = true-to-recording (the default and the
    // only mode before Phase 10): frames are rebuilt at the geometry the
    // recording was made at. A viewport re-renders history at the caller's
    // geometry instead - see _buildViewFrame().
    this.viewport = null
    this.viewFrame = null
  }

  /**
   * Re-render history at `{cols, rows}` instead of the recording's geometry.
   *
   * Pass null to go back to true-to-recording. Geometry is validated by the
   * caller (SessionEngine.playerView); a partially-specified viewport would
   * silently fall back to TerminalFrame's DEFAULT_COLS/DEFAULT_ROWS and
   * produce confidently wrong output, so nothing here accepts undefined.
   */
  setViewport(view) {
    const next = view ? { cols: view.cols, rows: view.rows } : null
    const same = next
      ? !!this.viewport && this.viewport.cols === next.cols && this.viewport.rows === next.rows
      : !this.viewport
    if (same) return this.viewport
    this.viewport = next
    this._disposeViewFrame()
    return this.viewport
  }

  /** Pauses and drops the re-render terminal; the store is not this player's. */
  dispose() {
    this.pause()
    this._disposeViewFrame()
  }

  _disposeViewFrame() {
    if (!this.viewFrame) return
    try {
      this.viewFrame.frame.dispose()
    } catch {
      /* a headless terminal that already threw has nothing left to free */
    }
    this.viewFrame = null
  }

  async seek(tsMs) {
    this.pause()
    const seq = Math.min(seqForTime(this.store.timeline, tsMs), storeLength(this.store))
    const frame = await this.buildFrame(seq, tsMs)
    this.seq = seq
    this.currentTsMs = tsMs
    this.emit('player:frame', frame)
    return frame
  }

  async buildFrame(targetSeq, displayTsMs = tsForSeq(this.store.timeline, targetSeq)) {
    if (this.viewport) return await this._buildViewFrame(targetSeq, displayTsMs)
    const nearest = this.snapshotCache ? this.snapshotCache.nearest(targetSeq) : null
    let base = { seq: 0, cols: this.store.info.cols, rows: this.store.info.rows, data: '' }
    if (nearest) {
      try {
        base = await this.snapshotCache.read(nearest.seq)
      } catch {
        base = { seq: 0, cols: this.store.info.cols, rows: this.store.info.rows, data: '' }
      }
    }
    const frame = new TerminalFrame(
      base.cols || this.store.info.cols,
      base.rows || this.store.info.rows
    )
    try {
      await frame.restore(base)
      // A remote/joined store may not have replicated everything up to
      // targetSeq yet (session-store.js's own rebuildTimeline/
      // extendTimeline already refuse to wait for a remote store the same
      // way, `{ wait: !this.remote }`): without this, hypercore's `get()`
      // waits forever for a block that may never arrive - a stuck peer, or
      // one that simply does not have it - and the only thing that ever
      // unstuck it was engine/client.js's whole-worker invoke timeout, which
      // killed and respawned the entire engine over one slow scrollback
      // read. `wait: false` instead returns whatever has actually landed so
      // far; a screen built from a shorter prefix than requested still
      // renders, rather than hanging the seek/open/step that asked for it.
      await replayPacketsIntoFrame(
        frame,
        this.store.readRange(base.seq + 1, targetSeq, { wait: !this.store.remote })
      )
      const snapshot = frame.snapshot(targetSeq, displayTsMs)
      snapshot.hd = hdForSeq(this.store.timeline, targetSeq)
      return snapshot
    } finally {
      frame.dispose()
    }
  }

  /**
   * Rebuilds the screen at the viewport's geometry by replaying raw history.
   *
   * The snapshot cache is deliberately NOT used here. A cached snapshot is a
   * SerializeAddon dump taken at the recording's width, i.e. text that has
   * already been hard-wrapped at that width; restoring it into a narrower
   * terminal re-wraps the wrapping instead of re-wrapping the original output.
   * Replaying the bytes is the only rendering that is actually true to what
   * the program wrote.
   *
   * The replay terminal is kept between calls and advanced forward, which is
   * what keeps a resize or a mode switch inside the 200ms budget on a long
   * recording; it is thrown away and rebuilt whenever the geometry changes or
   * the target moves backwards. Forward-advancing and rebuilding produce the
   * same screen because xterm's parser is stateful across write() calls, so
   * where the byte stream is chopped cannot change what it renders - that is
   * what makes "seek to T then play to T+30s" match "seek straight to T+30s".
   */
  async _buildViewFrame(targetSeq, displayTsMs) {
    const { cols, rows } = this.viewport
    let held = this.viewFrame
    if (held && (held.cols !== cols || held.rows !== rows || held.seq > targetSeq)) {
      this._disposeViewFrame()
      held = null
    }
    if (!held) {
      held = { frame: new TerminalFrame(cols, rows), seq: 0, cols, rows }
      this.viewFrame = held
    }
    if (held.seq < targetSeq) {
      // ignoreResize: the recording's own RESIZE packets would snap the
      // headless terminal back to the recording's geometry mid-replay, which
      // is exactly the size the caller asked NOT to render at.
      //
      // wait: false for a remote/joined store (see buildFrame's comment):
      // do not hang waiting for a block that has not replicated yet. The
      // replay may then stop short of targetSeq, so `held.seq` - the forward-
      // advance position this cache trusts on every later call - is moved to
      // wherever the replay actually reached, never past it: claiming more
      // would permanently skip the gap once the rest of the history lands.
      const replayedTo = await replayPacketsIntoFrame(
        held.frame,
        this.store.readRange(held.seq + 1, targetSeq, { wait: !this.store.remote }),
        { ignoreResize: true }
      )
      if (replayedTo > held.seq) held.seq = replayedTo
    }
    const snapshot = held.frame.snapshot(targetSeq, displayTsMs)
    snapshot.hd = hdForSeq(this.store.timeline, targetSeq)
    snapshot.view = { cols, rows }
    return snapshot
  }

  play(speed = 1, collapse = null) {
    const nextSpeed = SPEEDS.includes(speed) ? speed : 1
    if (this.playing) {
      this.setSpeed(nextSpeed)
      this.setCollapse(collapse)
      return
    }
    this.pause()
    this.speed = nextSpeed
    this.collapse = normalizeCollapse(collapse)
    this.playing = true
    this.playStartedAt = Date.now()
    this.playStartedTsMs = this.currentTsMs
    this._scheduleNext(0)
  }

  setCollapse(collapse) {
    this.collapse = normalizeCollapse(collapse)
  }

  setSpeed(speed = 1) {
    const nextSpeed = SPEEDS.includes(speed) ? speed : 1
    if (!this.playing) {
      this.speed = nextSpeed
      return
    }
    this.playStartedTsMs = this._playheadTsMs()
    this.playStartedAt = Date.now()
    this.speed = nextSpeed
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this._scheduleNext(0)
  }

  pause() {
    this.playing = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async stepPacket(delta) {
    this.pause()
    const target = Math.max(1, Math.min(storeLength(this.store), this.seq + delta))
    const frame = await this.buildFrame(target)
    this.seq = target
    this.currentTsMs = frame.tsMs
    this.emit('player:frame', frame)
    return frame
  }

  _scheduleNext(delay) {
    if (!this.playing) return
    this.timer = setTimeout(async () => {
      try {
        if (this.seq >= storeLength(this.store)) {
          this.pause()
          this.emit('player:end')
          return
        }
        const targetSeq = Math.min(
          seqForTime(this.store.timeline, this._playheadTsMs()),
          storeLength(this.store)
        )
        if (targetSeq <= this.seq) {
          this._scheduleNext(Math.min(this._delayToNext(), PLAYBACK_TICK_MS))
          return
        }
        const batch = await this._readPlaybackBatch(this.seq + 1, targetSeq)
        if (!batch.length) {
          this._scheduleNext(Math.min(this._delayToNext(), PLAYBACK_TICK_MS))
          return
        }
        const last = batch[batch.length - 1]
        this.seq = last.seq
        this.currentTsMs = last.tsMs
        for (const packet of coalescePackets(batch)) this.emit('player:data', packet)
        const nextDelay =
          this.seq < targetSeq ? PLAYBACK_YIELD_MS : Math.min(this._delayToNext(), PLAYBACK_TICK_MS)
        this._scheduleNext(nextDelay)
      } catch (err) {
        this.pause()
        this.emit('player:error', err)
      }
    }, delay)
  }

  async _readPlaybackBatch(from, targetSeq) {
    const packets = []
    let bytes = 0
    // Same reasoning as buildFrame(): a remote store may not have this batch
    // yet, and must not hang waiting for it - an empty/short batch just
    // pauses this tick's advance (below) instead of freezing playback.
    for await (const packet of this.store.readRange(from, targetSeq, {
      wait: !this.store.remote
    })) {
      packets.push(packet)
      bytes += packet.payload ? packet.payload.byteLength : 0
      if (packets.length >= PLAYBACK_MAX_BATCH_PACKETS || bytes >= PLAYBACK_MAX_BATCH_BYTES) {
        break
      }
    }
    return packets
  }

  _playheadTsMs() {
    const raw = this.playStartedTsMs + (Date.now() - this.playStartedAt) * this.speed
    if (!this.collapse) return raw
    if (this.seq >= storeLength(this.store)) return raw
    const nextTs = tsForSeq(this.store.timeline, this.seq + 1)
    const rawGap = nextTs - this.currentTsMs
    if (rawGap <= this.collapse.thresholdMs) return raw
    const cap = this.currentTsMs + this.collapse.thresholdMs
    if (raw < cap) return raw
    return nextTs
  }

  _delayToNext() {
    if (this.seq >= storeLength(this.store)) return 0
    return Math.max(0, tsForSeq(this.store.timeline, this.seq + 1) - this.currentTsMs) / this.speed
  }
}

function normalizeCollapse(collapse) {
  if (!collapse || !collapse.enabled) return null
  const thresholdMs = Number(collapse.thresholdMs)
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return null
  return { enabled: true, thresholdMs }
}

function storeLength(store) {
  if (!store.remote) return store.log.length
  return store.playbackLength === undefined ? store.log.length : store.playbackLength
}

function coalescePackets(packets) {
  const out = []
  let data = []
  let dataBytes = 0
  let lastDataPacket = null
  let dataHd = false

  const flushData = () => {
    if (!lastDataPacket) return
    out.push({
      ...lastDataPacket,
      payload: Buffer.concat(data, dataBytes)
    })
    data = []
    dataBytes = 0
    lastDataPacket = null
    dataHd = false
  }

  for (const packet of packets) {
    if (packet.kind === PacketKind.DATA) {
      if (lastDataPacket && dataHd !== !!packet.hd) flushData()
      data.push(packet.payload)
      dataBytes += packet.payload.byteLength
      lastDataPacket = packet
      dataHd = !!packet.hd
      continue
    }
    flushData()
    out.push(packet)
  }
  flushData()
  return out
}

// Returns the seq of the last packet actually replayed (0 if `packets`
// yielded none), which the caller uses instead of blindly trusting it reached
// whatever seq it asked for - `packets` may be a `{ wait: false }` readRange
// on a remote store that stops short of the requested end because that much
// has not replicated yet (see buildFrame/_buildViewFrame).
async function replayPacketsIntoFrame(frame, packets, opts = {}) {
  const ignoreResize = !!opts.ignoreResize
  let chunks = []
  let bytes = 0
  let lastSeq = 0

  const flush = async () => {
    if (!chunks.length) return
    await frame.write(Buffer.concat(chunks, bytes).toString('utf8'))
    chunks = []
    bytes = 0
  }

  for await (const packet of packets) {
    lastSeq = packet.seq
    if (packet.kind === PacketKind.DATA) {
      chunks.push(packet.payload)
      bytes += packet.payload.byteLength
      if (bytes >= FRAME_REPLAY_MAX_BATCH_BYTES) await flush()
      continue
    }
    await flush()
    if (packet.kind === PacketKind.RESIZE && !ignoreResize) frame.resize(packet.cols, packet.rows)
  }
  await flush()
  return lastSeq
}

/**
 * DEC private modes that switch the terminal to the alternate screen buffer.
 *
 * 47 is the original one, 1047 adds the clear-on-exit and 1049 (what every
 * modern TUI uses) additionally saves and restores the cursor. All three are
 * "the program is now painting at absolute cell positions", which is the
 * condition fit-to-window playback must refuse: reflowing absolute-positioned
 * output produces confident, wrong text.
 */
const ALT_SCREEN_MODES = new Set([47, 1047, 1049])

/**
 * A byte-level scanner for alternate-screen entry/exit.
 *
 * A state machine rather than a regex over each payload, because an escape
 * sequence can be split across two recorded packets: the PTY hands the core
 * whatever the kernel gave it, and `\x1b[?10` / `49h` in two chunks is
 * ordinary. Anything that matched per-packet would miss exactly the case where
 * a TUI starts up.
 *
 * `feed()` returns the state *after* the chunk, or null when the chunk did not
 * change it.
 */
function createAltScreenScanner() {
  const IDLE = 0
  const ESC = 1
  const CSI = 2
  let state = IDLE
  let priv = false
  let params = []
  let cur = -1
  let active = false

  const finish = (final) => {
    params.push(cur)
    let changed = null
    if (priv && (final === 0x68 || final === 0x6c)) {
      const wanted = final === 0x68
      for (const value of params) {
        if (value >= 0 && ALT_SCREEN_MODES.has(value) && active !== wanted) {
          active = wanted
          changed = active
        }
      }
    }
    state = IDLE
    return changed
  }

  return {
    get active() {
      return active
    },
    feed(bytes) {
      let changed = null
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]
        if (b === 0x1b) {
          state = ESC
          continue
        }
        if (state === ESC) {
          if (b === 0x5b) {
            state = CSI
            priv = false
            params = []
            cur = -1
          } else {
            state = IDLE
          }
          continue
        }
        if (state !== CSI) continue
        if (b === 0x3f && !params.length && cur < 0) priv = true
        else if (b >= 0x30 && b <= 0x39) cur = (cur < 0 ? 0 : cur) * 10 + (b - 0x30)
        else if (b === 0x3b) {
          params.push(cur)
          cur = -1
        } else if (b >= 0x20 && b <= 0x2f) {
          /* intermediate byte; keep collecting */
        } else if (b >= 0x40 && b <= 0x7e) {
          const result = finish(b)
          if (result !== null) changed = result
        } else state = IDLE
      }
      return changed
    }
  }
}

/**
 * Every stretch of a recording that was painted on the alternate screen.
 *
 * Computed by reading the packet stream once - **nothing is written**, so this
 * adds no field to the on-disk format and works on recordings made before this
 * code existed. Ranges are half-open at the end: `toSeq === null` means the
 * recording ends inside the alternate screen (a session killed while `htop`
 * was up).
 */
async function scanAltScreenRanges(packets) {
  const scanner = createAltScreenScanner()
  const ranges = []
  let open = null
  let bytes = 0
  let lastSeq = 0
  for await (const packet of packets) {
    lastSeq = packet.seq
    if (packet.kind !== PacketKind.DATA || !packet.payload) continue
    bytes += packet.payload.byteLength
    const changed = scanner.feed(packet.payload)
    if (changed === null) continue
    if (changed) {
      open = { fromSeq: packet.seq, fromTsMs: packet.tsMs, toSeq: null, toTsMs: null }
      ranges.push(open)
    } else if (open) {
      open.toSeq = packet.seq
      open.toTsMs = packet.tsMs
      open = null
    }
  }
  // `lastSeq`: how far the scan actually got - a `{ wait: false }` read on a
  // remote store still downloading stops short of the range it was asked
  // for (session-store.js readRange) rather than hanging; the caller uses
  // this to tell a genuinely complete scan from a partial one.
  return { used: ranges.length > 0, ranges, bytes, lastSeq }
}

function seqForTime(timeline, tsMs) {
  if (!timeline.length) return 0
  if (tsMs < timeline[0].tsMs) return 0
  let lo = 0
  let hi = timeline.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (timeline[mid].tsMs <= tsMs) lo = mid + 1
    else hi = mid - 1
  }
  return timeline[Math.max(0, hi)].seq
}

function tsForSeq(timeline, seq) {
  const item = timeline.find((p) => p.seq === seq)
  if (item) return item.tsMs
  return timeline.length ? timeline[timeline.length - 1].tsMs : Date.now()
}

function hdForSeq(timeline, seq) {
  const item = timeline.find((p) => p.seq === seq)
  return !!(item && item.hd)
}

module.exports = {
  Player,
  seqForTime,
  SPEEDS,
  coalescePackets,
  replayPacketsIntoFrame,
  hdForSeq,
  createAltScreenScanner,
  scanAltScreenRanges,
  ALT_SCREEN_MODES
}
