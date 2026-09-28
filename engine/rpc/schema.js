const c = require('compact-encoding')
const { EngineError, CODES } = require('../errors')

// Frame layout over FramedStream (docs/DESIGN-SWARM-AND-WORKER.md, "The
// seam: EngineClient (shell) / EngineHost (worker)"): uint8 kind, uint32 id
// (0 for events / fire-and-forget frames), then a kind-specific body.
const FrameKind = {
  INVOKE: 0,
  REPLY_OK: 1,
  REPLY_ERR: 2,
  EVENT_JSON: 3,
  EVENT_DATA: 4,
  PTY_SPAWN: 5,
  PTY_WRITE: 6,
  PTY_RESIZE: 7,
  PTY_KILL: 8,
  PTY_PAUSE: 9,
  PTY_RESUME: 10,
  PTY_DATA: 11,
  PTY_EXIT: 12,
  // Attach mode across the seam (docs/CORE-CONTRACT.md 6). Appended, never
  // inserted: 0-12 are wire-compatible state. PTY_DETACH exists as its own
  // kind - rather than a new PtyExit field - precisely so PtyExit's encoding
  // stays byte-identical; see the comment above PtyExit.
  PTY_ATTACH: 13,
  PTY_DETACH: 14
}

// Peer connections across the seam (docs/CORE-CONTRACT.md 3; Freenet design
// 3.1, D-06/D-09): the worker holds the backend, the host owns the WebRTC peer
// connections (electron/rtc-host.js), and the worker drives them through
// engine/backends/freenet/rtc-remote.js. Appended with Object.assign so the
// literal above - kinds 0-14 - stays byte-for-byte what it was.
Object.assign(FrameKind, {
  BACKEND_OPEN: 15,
  BACKEND_SIGNAL: 16,
  BACKEND_STATE: 17,
  BACKEND_CHANNEL: 18,
  BACKEND_DATA: 19,
  BACKEND_FLOW: 20,
  BACKEND_CLOSE: 21
})

const FrameKindName = Object.keys(FrameKind).reduce((acc, name) => {
  acc[FrameKind[name]] = name
  return acc
}, {})

const optional = (codec) => ({
  preencode(state, value) {
    c.bool.preencode(state, value !== undefined && value !== null)
    if (value !== undefined && value !== null) codec.preencode(state, value)
  },
  encode(state, value) {
    const present = value !== undefined && value !== null
    c.bool.encode(state, present)
    if (present) codec.encode(state, value)
  },
  decode(state) {
    return c.bool.decode(state) ? codec.decode(state) : null
  }
})

const OptionalString = optional(c.string)
const OptionalUint = optional(c.uint)
const OptionalBuffer = optional(c.buffer)
const OptionalJson = optional(c.json)

const Invoke = {
  preencode(state, m) {
    c.string.preencode(state, m.method)
    c.json.preencode(state, m.args)
  },
  encode(state, m) {
    c.string.encode(state, m.method)
    c.json.encode(state, m.args)
  },
  decode(state) {
    return { method: c.string.decode(state), args: c.json.decode(state) }
  }
}

const ReplyOk = {
  preencode(state, m) {
    c.json.preencode(state, m.result)
  },
  encode(state, m) {
    c.json.encode(state, m.result)
  },
  decode(state) {
    return { result: c.json.decode(state) }
  }
}

// error is EngineError.toJSON(): { name, code, message, details } - details
// is JSON-safe by construction (EngineError never carries anything else).
const ReplyErr = {
  preencode(state, m) {
    c.json.preencode(state, m.error)
  },
  encode(state, m) {
    c.json.encode(state, m.error)
  },
  decode(state) {
    return { error: c.json.decode(state) }
  }
}

const EventJson = {
  preencode(state, m) {
    c.string.preencode(state, m.name)
    c.json.preencode(state, m.data)
  },
  encode(state, m) {
    c.string.encode(state, m.name)
    c.json.encode(state, m.data)
  },
  decode(state) {
    return { name: c.string.decode(state), data: c.json.decode(state) }
  }
}

// session:data / player:data are the two hot, binary events. Their JS
// shapes differ (engine/index.js _recordLiveData / serializePacket), so the
// body carries a small event-name tag plus every field either shape needs,
// each present/absent via `optional()` rather than forcing one shape on the
// other. Deviation from the design doc's literal 3-field EVENT_DATA table
// (docs/DESIGN-SWARM-AND-WORKER.md) - recorded there per the deviation
// policy since player:data's payload (seq/tsMs/kind/cols/rows) doesn't fit
// { sessionId, flags(hd/source), data }. The `data` buffer itself is never
// JSON/base64-wrapped, preserving the ground rule this table exists to
// protect.
const EVENT_DATA_NAMES = ['session:data', 'player:data']
const LOW_RATE_EVENTS = [
  'session:exit',
  'session:hd-changed',
  'session:restored',
  'session:availability-changed',
  'session:list-changed',
  'share:changed',
  'share:join-changed',
  'share:approval-pending',
  'share:approval-cancelled',
  'share:peer-identity',
  'share:debug',
  'player:frame',
  'player:end',
  'engine:error',
  'identity:changed',
  'identity:resolve-request'
]

const EventData = {
  preencode(state, m) {
    c.uint.preencode(state, EVENT_DATA_NAMES.indexOf(m.name))
    c.string.preencode(state, m.sessionId)
    c.bool.preencode(state, !!m.hd)
    OptionalString.preencode(state, m.source)
    OptionalUint.preencode(state, m.seq)
    OptionalUint.preencode(state, m.tsMs)
    OptionalUint.preencode(state, m.kind)
    OptionalUint.preencode(state, m.cols)
    OptionalUint.preencode(state, m.rows)
    OptionalBuffer.preencode(state, m.data)
  },
  encode(state, m) {
    c.uint.encode(state, EVENT_DATA_NAMES.indexOf(m.name))
    c.string.encode(state, m.sessionId)
    c.bool.encode(state, !!m.hd)
    OptionalString.encode(state, m.source)
    OptionalUint.encode(state, m.seq)
    OptionalUint.encode(state, m.tsMs)
    OptionalUint.encode(state, m.kind)
    OptionalUint.encode(state, m.cols)
    OptionalUint.encode(state, m.rows)
    OptionalBuffer.encode(state, m.data)
  },
  decode(state) {
    const nameIndex = c.uint.decode(state)
    const name = EVENT_DATA_NAMES[nameIndex]
    if (name === undefined) throw new EngineError(CODES.E_CORRUPT, 'Unknown EVENT_DATA name')
    const sessionId = c.string.decode(state)
    const hd = c.bool.decode(state)
    const source = OptionalString.decode(state)
    const seq = OptionalUint.decode(state)
    const tsMs = OptionalUint.decode(state)
    const kind = OptionalUint.decode(state)
    const cols = OptionalUint.decode(state)
    const rows = OptionalUint.decode(state)
    const data = OptionalBuffer.decode(state)
    return { name, sessionId, hd, source, seq, tsMs, kind, cols, rows, data }
  }
}

const PtySpawn = {
  preencode(state, m) {
    c.string.preencode(state, m.sessionId)
    c.uint.preencode(state, m.cols)
    c.uint.preencode(state, m.rows)
    OptionalString.preencode(state, m.shell)
    OptionalString.preencode(state, m.cwd)
    // `command` is a trailing field written only when set, so a spawn without
    // one stays byte-identical to the frame before the field existed.
    if (m.command) c.string.preencode(state, m.command)
  },
  encode(state, m) {
    c.string.encode(state, m.sessionId)
    c.uint.encode(state, m.cols)
    c.uint.encode(state, m.rows)
    OptionalString.encode(state, m.shell)
    OptionalString.encode(state, m.cwd)
    if (m.command) c.string.encode(state, m.command)
  },
  decode(state) {
    return {
      sessionId: c.string.decode(state),
      cols: c.uint.decode(state),
      rows: c.uint.decode(state),
      shell: OptionalString.decode(state),
      cwd: OptionalString.decode(state),
      command: state.start < state.end ? c.string.decode(state) : null
    }
  }
}

// PtySpawn minus shell/cwd: attach mode registers a terminal the host already
// owns, so there is nothing to launch and nowhere to launch it. cols/rows are
// plain uints - the core validates geometry before encoding (engine/index.js
// isGeometry, engine/pty-remote.js attach()), because c.uint cannot carry the
// null/NaN/negative values that validator exists to reject.
const PtyAttach = {
  preencode(state, m) {
    c.string.preencode(state, m.sessionId)
    c.uint.preencode(state, m.cols)
    c.uint.preencode(state, m.rows)
  },
  encode(state, m) {
    c.string.encode(state, m.sessionId)
    c.uint.encode(state, m.cols)
    c.uint.encode(state, m.rows)
  },
  decode(state) {
    return {
      sessionId: c.string.decode(state),
      cols: c.uint.decode(state),
      rows: c.uint.decode(state)
    }
  }
}

const SessionIdOnly = {
  preencode(state, m) {
    c.string.preencode(state, m.sessionId)
  },
  encode(state, m) {
    c.string.encode(state, m.sessionId)
  },
  decode(state) {
    return { sessionId: c.string.decode(state) }
  }
}

const PtyResize = {
  preencode(state, m) {
    c.string.preencode(state, m.sessionId)
    c.uint.preencode(state, m.cols)
    c.uint.preencode(state, m.rows)
  },
  encode(state, m) {
    c.string.encode(state, m.sessionId)
    c.uint.encode(state, m.cols)
    c.uint.encode(state, m.rows)
  },
  decode(state) {
    return {
      sessionId: c.string.decode(state),
      cols: c.uint.decode(state),
      rows: c.uint.decode(state)
    }
  }
}

const SessionData = {
  preencode(state, m) {
    c.string.preencode(state, m.sessionId)
    c.buffer.preencode(state, m.data)
  },
  encode(state, m) {
    c.string.encode(state, m.sessionId)
    c.buffer.encode(state, m.data)
  },
  decode(state) {
    return { sessionId: c.string.decode(state), data: c.buffer.decode(state) }
  }
}

// node-pty's onExit reports `signal` as a numeric signal number (or
// undefined), not a string - `IPty['onExit']: { exitCode: number, signal?:
// number }` (node_modules/@lydell/node-pty/node-pty.d.ts). Both fields are
// therefore OptionalUint, not OptionalString.
const PtyExit = {
  preencode(state, m) {
    c.string.preencode(state, m.sessionId)
    OptionalUint.preencode(state, m.code)
    OptionalUint.preencode(state, m.signal)
  },
  encode(state, m) {
    c.string.encode(state, m.sessionId)
    OptionalUint.encode(state, m.code)
    OptionalUint.encode(state, m.signal)
  },
  decode(state) {
    return {
      sessionId: c.string.decode(state),
      code: OptionalUint.decode(state),
      signal: OptionalUint.decode(state)
    }
  }
}

// The BACKEND_* bodies (Freenet design 3.1). `connId` names one peer
// connection and `chanId` one data channel on it; both are chosen by the
// worker, except for a channel the remote side opened, whose `chanId` the host
// assigns (electron/rtc-host.js). Fields the design leaves empty in some
// states - `sdp` versus `candidate`/`mid`, the fingerprints and the path
// before a connection exists - are `optional()`.
const BackendOpen = {
  preencode(state, m) {
    c.uint.preencode(state, m.connId)
    OptionalJson.preencode(state, m.iceServers)
  },
  encode(state, m) {
    c.uint.encode(state, m.connId)
    OptionalJson.encode(state, m.iceServers)
  },
  decode(state) {
    return { connId: c.uint.decode(state), iceServers: OptionalJson.decode(state) }
  }
}

// `type` is 'offer', 'answer' or 'candidate': a description carries `sdp`, a
// candidate carries `candidate` and `mid`.
const BackendSignal = {
  preencode(state, m) {
    c.uint.preencode(state, m.connId)
    c.string.preencode(state, m.type)
    OptionalString.preencode(state, m.sdp)
    OptionalString.preencode(state, m.candidate)
    OptionalString.preencode(state, m.mid)
  },
  encode(state, m) {
    c.uint.encode(state, m.connId)
    c.string.encode(state, m.type)
    OptionalString.encode(state, m.sdp)
    OptionalString.encode(state, m.candidate)
    OptionalString.encode(state, m.mid)
  },
  decode(state) {
    return {
      connId: c.uint.decode(state),
      type: c.string.decode(state),
      sdp: OptionalString.decode(state),
      candidate: OptionalString.decode(state),
      mid: OptionalString.decode(state)
    }
  }
}

const BackendState = {
  preencode(state, m) {
    c.uint.preencode(state, m.connId)
    c.string.preencode(state, m.state)
    OptionalString.preencode(state, m.localFingerprint)
    OptionalString.preencode(state, m.remoteFingerprint)
    OptionalString.preencode(state, m.pathKind)
  },
  encode(state, m) {
    c.uint.encode(state, m.connId)
    c.string.encode(state, m.state)
    OptionalString.encode(state, m.localFingerprint)
    OptionalString.encode(state, m.remoteFingerprint)
    OptionalString.encode(state, m.pathKind)
  },
  decode(state) {
    return {
      connId: c.uint.decode(state),
      state: c.string.decode(state),
      localFingerprint: OptionalString.decode(state),
      remoteFingerprint: OptionalString.decode(state),
      pathKind: OptionalString.decode(state)
    }
  }
}

// `op` is 'open' (worker -> host: open one), 'opened' (host -> worker: open,
// either side's) or 'closed' (either way).
const BackendChannel = {
  preencode(state, m) {
    c.uint.preencode(state, m.connId)
    c.uint.preencode(state, m.chanId)
    OptionalString.preencode(state, m.label)
    c.string.preencode(state, m.op)
  },
  encode(state, m) {
    c.uint.encode(state, m.connId)
    c.uint.encode(state, m.chanId)
    OptionalString.encode(state, m.label)
    c.string.encode(state, m.op)
  },
  decode(state) {
    return {
      connId: c.uint.decode(state),
      chanId: c.uint.decode(state),
      label: OptionalString.decode(state),
      op: c.string.decode(state)
    }
  }
}

// One data-channel message (<= 65 536 bytes, S-07), as bytes: never
// JSON/base64-wrapped, like SessionData.
const BackendData = {
  preencode(state, m) {
    c.uint.preencode(state, m.connId)
    c.uint.preencode(state, m.chanId)
    c.buffer.preencode(state, m.data)
  },
  encode(state, m) {
    c.uint.encode(state, m.connId)
    c.uint.encode(state, m.chanId)
    c.buffer.encode(state, m.data)
  },
  decode(state) {
    return {
      connId: c.uint.decode(state),
      chanId: c.uint.decode(state),
      data: c.buffer.decode(state)
    }
  }
}

const BackendFlow = {
  preencode(state, m) {
    c.uint.preencode(state, m.connId)
    c.uint.preencode(state, m.chanId)
    c.bool.preencode(state, !!m.paused)
  },
  encode(state, m) {
    c.uint.encode(state, m.connId)
    c.uint.encode(state, m.chanId)
    c.bool.encode(state, !!m.paused)
  },
  decode(state) {
    return {
      connId: c.uint.decode(state),
      chanId: c.uint.decode(state),
      paused: c.bool.decode(state)
    }
  }
}

const BackendClose = {
  preencode(state, m) {
    c.uint.preencode(state, m.connId)
    OptionalString.preencode(state, m.reason)
  },
  encode(state, m) {
    c.uint.encode(state, m.connId)
    OptionalString.encode(state, m.reason)
  },
  decode(state) {
    return { connId: c.uint.decode(state), reason: OptionalString.decode(state) }
  }
}

const BODY_CODECS = {
  [FrameKind.INVOKE]: Invoke,
  [FrameKind.REPLY_OK]: ReplyOk,
  [FrameKind.REPLY_ERR]: ReplyErr,
  [FrameKind.EVENT_JSON]: EventJson,
  [FrameKind.EVENT_DATA]: EventData,
  [FrameKind.PTY_SPAWN]: PtySpawn,
  [FrameKind.PTY_WRITE]: SessionData,
  [FrameKind.PTY_RESIZE]: PtyResize,
  [FrameKind.PTY_KILL]: SessionIdOnly,
  [FrameKind.PTY_PAUSE]: SessionIdOnly,
  [FrameKind.PTY_RESUME]: SessionIdOnly,
  [FrameKind.PTY_DATA]: SessionData,
  [FrameKind.PTY_EXIT]: PtyExit,
  [FrameKind.PTY_ATTACH]: PtyAttach,
  // Detach carries nothing but the session: the *reason* (DETACH_SIGNAL) is
  // supplied by the core, so nothing string-shaped has to ride on PtyExit.
  [FrameKind.PTY_DETACH]: SessionIdOnly
}

// The BACKEND_* bodies, appended the same way as their kinds.
Object.assign(BODY_CODECS, {
  [FrameKind.BACKEND_OPEN]: BackendOpen,
  [FrameKind.BACKEND_SIGNAL]: BackendSignal,
  [FrameKind.BACKEND_STATE]: BackendState,
  [FrameKind.BACKEND_CHANNEL]: BackendChannel,
  [FrameKind.BACKEND_DATA]: BackendData,
  [FrameKind.BACKEND_FLOW]: BackendFlow,
  [FrameKind.BACKEND_CLOSE]: BackendClose
})

function bodyCodecFor(kind) {
  const codec = BODY_CODECS[kind]
  if (!codec) throw new EngineError(CODES.E_CORRUPT, `Unknown frame kind: ${kind}`)
  return codec
}

function encodeFrame(kind, id, body) {
  const codec = bodyCodecFor(kind)
  const state = c.state()
  c.uint8.preencode(state, kind)
  c.uint32.preencode(state, id)
  codec.preencode(state, body)
  state.buffer = Buffer.allocUnsafe(state.end)
  c.uint8.encode(state, kind)
  c.uint32.encode(state, id)
  codec.encode(state, body)
  return state.buffer
}

// Treats the wire as untrusted per docs/DESIGN-SWARM-AND-WORKER.md's "New
// surfaces introduced": always throws EngineError(E_CORRUPT) on truncation,
// an unrecognized kind byte, or a body that doesn't fully consume the
// frame - never a raw/unrelated exception, never a hang.
function decodeFrame(buffer) {
  try {
    const state = { buffer, start: 0, end: buffer.byteLength }
    if (buffer.byteLength < 5) {
      throw new EngineError(CODES.E_CORRUPT, 'Frame too short')
    }
    const kind = c.uint8.decode(state)
    const id = c.uint32.decode(state)
    const codec = bodyCodecFor(kind)
    const body = codec.decode(state)
    if (state.start !== state.end) {
      throw new EngineError(CODES.E_CORRUPT, 'Frame body length mismatch')
    }
    return { kind, id, body }
  } catch (err) {
    throw EngineError.from(err, CODES.E_CORRUPT)
  }
}

module.exports = {
  FrameKind,
  FrameKindName,
  LOW_RATE_EVENTS,
  EVENT_DATA_NAMES,
  encodeFrame,
  decodeFrame
}
