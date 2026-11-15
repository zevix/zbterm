// Stream positions for the selected live session (261114_live-output-and-fixes,
// design A). The engine stamps every `session:data` chunk with `end` (the
// session's stream position after it) and every frame with `through` (the
// position the frame holds). This module decides, chunk by chunk, what the
// terminal still has to write, so a frame and the stream around it show every
// byte once whatever order they arrive in. Pure: no DOM, no xterm, no IPC;
// renderer/app.js does the writing, acking and resyncing.
//
// createLiveStream() → stream:
//   hold(sessionId)         a frame is coming for this session: hold its chunks.
//                           Holding another session drops what was held.
//   take(chunk)             { sessionId, end, data: Uint8Array } →
//                           { action: 'other' | 'hold' | 'drop' | 'write' | 'gap', data }
//                           'write' carries the bytes still to write (a chunk
//                           the frame partly holds is cut), 'gap' means bytes
//                           between the last one written and this chunk never
//                           came: the caller repaints from a fresh frame.
//   frame(sessionId, through) the frame is painted: → { writes: [data], dropped, gap }
//                           for the chunks held meanwhile. `through` not a number
//                           (a core before 261114): the held chunks are dropped,
//                           as the reset before the frame always wiped them.
//   release(sessionId)      no frame after all (the session is restoring): the
//                           held chunks come back to be written as they are, and
//                           the next chunk anchors the position.
//   clear()                 forget everything (another view, a restarted core).
//   snapshot()              the state, for the debug server.
// A chunk without `end` (a core before 261114) is written as it is and turns
// tracking off until the next frame with a `through`.
;(() => {
  function createLiveStream() {
    const s = {
      sessionId: null,
      holding: false,
      held: [],
      // Position of the last byte handed to the terminal; null: not known yet.
      written: null,
      // true once `written` came from a frame's `through` (gaps and a lost
      // tail can be told only then).
      anchored: false,
      tracked: true,
      counts: { held: 0, dropped: 0, cut: 0, gaps: 0, frames: 0, untracked: 0 }
    }

    function hold(sessionId) {
      if (s.sessionId !== sessionId) {
        s.held = []
        s.written = null
        s.anchored = false
      }
      s.sessionId = sessionId
      s.holding = true
    }

    function place(chunk) {
      const data = chunk.data
      if (!Number.isFinite(chunk.end)) {
        // An older core: no positions, write everything as before.
        s.tracked = false
        s.written = null
        s.anchored = false
        s.counts.untracked++
        return { action: 'write', data }
      }
      const len = data.byteLength
      const start = chunk.end - len
      if (s.written === null) {
        s.written = chunk.end
        s.tracked = true
        return { action: 'write', data }
      }
      if (chunk.end <= s.written) {
        s.counts.dropped++
        return { action: 'drop', data: null }
      }
      if (start < s.written) {
        s.counts.cut++
        const out = data.subarray(s.written - start)
        s.written = chunk.end
        return { action: 'write', data: out }
      }
      if (start > s.written) {
        s.counts.gaps++
        return { action: 'gap', data: null }
      }
      s.written = chunk.end
      return { action: 'write', data }
    }

    function take(chunk) {
      if (!chunk || chunk.sessionId !== s.sessionId) {
        // Not the stream this module follows: the caller writes it untracked.
        return { action: 'other', data: chunk ? chunk.data : null }
      }
      if (s.holding) {
        s.held.push(chunk)
        s.counts.held++
        return { action: 'hold', data: null }
      }
      if (!s.tracked && !Number.isFinite(chunk.end)) {
        s.counts.untracked++
        return { action: 'write', data: chunk.data }
      }
      return place(chunk)
    }

    function frame(sessionId, through) {
      const out = { writes: [], dropped: 0, gap: false }
      if (sessionId !== s.sessionId) return out
      const held = s.held
      s.held = []
      s.holding = false
      s.counts.frames++
      if (!Number.isFinite(through)) {
        s.written = null
        s.anchored = false
        s.tracked = false
        out.dropped = held.length
        return out
      }
      s.written = through
      s.anchored = true
      s.tracked = true
      for (let i = 0; i < held.length; i++) {
        const r = place(held[i])
        if (r.action === 'write') out.writes.push(r.data)
        else if (r.action === 'drop') out.dropped++
        else if (r.action === 'gap') {
          out.gap = true
          out.dropped += held.length - i
          break
        }
      }
      return out
    }

    function release(sessionId) {
      if (sessionId !== s.sessionId) return []
      const held = s.held
      s.held = []
      s.holding = false
      s.written = null
      s.anchored = false
      const writes = []
      for (const chunk of held) {
        const r = place(chunk)
        if (r.action === 'write') writes.push(r.data)
      }
      return writes
    }

    function clear() {
      s.sessionId = null
      s.holding = false
      s.held = []
      s.written = null
      s.anchored = false
      s.tracked = true
    }

    function snapshot() {
      return {
        sessionId: s.sessionId,
        holding: s.holding,
        held: s.held.length,
        written: s.written,
        anchored: s.anchored,
        tracked: s.tracked,
        counts: { ...s.counts }
      }
    }

    return {
      hold,
      take,
      frame,
      release,
      clear,
      snapshot,
      get sessionId() {
        return s.sessionId
      },
      get holding() {
        return s.holding
      },
      get written() {
        return s.written
      },
      get anchored() {
        return s.anchored
      }
    }
  }

  const api = { createLiveStream }
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api
  }
  if (typeof window === 'object' && window) {
    window.zbtermLiveStream = api
  }
})()
