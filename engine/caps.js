const VIEW_LIVE = 1 << 0
const READ_HISTORY = 1 << 1
const QUICK_CATCHUP = 1 << 2
const SEND_INPUT = 1 << 3
const ADMIN = 1 << 4

const FULL_CAPS = VIEW_LIVE | READ_HISTORY | QUICK_CATCHUP | SEND_INPUT | ADMIN

function hasCap(caps, cap) {
  return (normalize(caps) & cap) === cap
}

function mergeCaps(...values) {
  let out = 0
  for (const value of values) out |= normalize(value)
  return out
}

function capsFromLinkOptions(opts = {}) {
  if (Number.isFinite(opts.caps)) return normalize(opts.caps)
  let caps = VIEW_LIVE | READ_HISTORY
  if (opts.quickCatchup !== false) caps |= QUICK_CATCHUP
  if (opts.sendInput || opts.input) caps |= SEND_INPUT
  if (opts.admin) caps |= ADMIN
  return caps
}

function capsForOwnDevice() {
  return FULL_CAPS
}

function normalize(value) {
  return Number.isFinite(value) ? value & FULL_CAPS : 0
}

module.exports = {
  VIEW_LIVE,
  READ_HISTORY,
  QUICK_CATCHUP,
  SEND_INPUT,
  ADMIN,
  FULL_CAPS,
  hasCap,
  mergeCaps,
  capsFromLinkOptions,
  capsForOwnDevice
}
