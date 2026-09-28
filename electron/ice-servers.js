// The ICE servers the host's WebRTC adapter (electron/rtc-host.js) gives
// every new peer connection (D-11; Freenet design §9). Four sources, the
// first that says something wins:
//
//   the settings field "STUN/TURN servers" (renderer, when non-empty)
//   --ice-servers <list>
//   ZBTERM_ICE_SERVERS
//   DEFAULT_ICE_SERVERS (electron/rtc-host.js)
//
// A list is comma-separated ICE URLs, `stun:host:port` and
// `turn:user:secret@host:port`. An empty flag or variable is a value: it
// means no server at all, so only host candidates are offered. An empty
// settings field is not: it leaves the flag, the variable or the default in
// charge.
const { DEFAULT_ICE_SERVERS } = require('./rtc-host')

const FLAG = '--ice-servers'

function parseIceServers(text) {
  return String(text)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

// paparam refuses a flag with an empty value, so the flag is read here, and
// `strip` is argv without it for paparam. `value` is undefined when absent.
function iceServersFlag(argv) {
  let value
  const strip = []
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    if (arg === FLAG) {
      value = i + 1 < argv.length ? String(argv[i + 1]) : ''
      i++
    } else if (arg.startsWith(FLAG + '=')) {
      value = arg.slice(FLAG.length + 1)
    } else {
      strip.push(argv[i])
    }
  }
  return { value, strip }
}

function resolveIceServers({ setting, flag, env } = {}) {
  if (typeof setting === 'string' && setting.trim()) {
    return { servers: parseIceServers(setting), source: 'setting' }
  }
  if (typeof flag === 'string') return { servers: parseIceServers(flag), source: 'flag' }
  const fromEnv = env && env.ZBTERM_ICE_SERVERS
  if (typeof fromEnv === 'string') return { servers: parseIceServers(fromEnv), source: 'env' }
  return { servers: DEFAULT_ICE_SERVERS.slice(), source: 'default' }
}

module.exports = { FLAG, parseIceServers, iceServersFlag, resolveIceServers }
