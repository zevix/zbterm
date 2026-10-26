// The invite codec. An invite is the one artefact a share hands to a stranger
// (a URI pasted into a chat), so its shape is decoded in exactly one place.
//
// Two shapes exist on the wire:
//   v1  { v, linkId, topic, hostDhtKey, claim }
//   v2  { v: 2, b, linkId, peer, route, claim }  (+ the v1 fields for Pear)
//
// decodeLink() always returns the normalised v2 view `{v, b, linkId, peer,
// route, claim}` and keeps the v1 fields `topic` and `hostDhtKey` on the
// result, so callers written against v1 keep working unchanged.
const { EngineError, CODES } = require('./errors')

const LINK_PREFIX = 'zbterm://join/'
const INVITE_V2 = 2
const PEAR_BACKEND = 'pear'
const HOST_KEY_RE = /^[0-9a-f]{64}$/i

// Pear keeps emitting v1-shaped invites; v2 emission is opt-in (A-7). Read at
// call time so a test (or a host) can flip it without reloading the module.
function inviteV2Enabled() {
  return typeof process !== 'undefined' && !!process.env && process.env.ZBTERM_INVITE_V2 === '1'
}

// Takes either spelling of a payload: the v1 one (`topic`, `hostDhtKey`) or
// the backend-neutral one the share manager builds (`b`, `peer`, `route`).
//
// A Pear link is emitted v1-shaped by default, byte for byte as before. With
// ZBTERM_INVITE_V2=1 the v2 fields are added *alongside* the v1 ones, so a
// released (v1-only) build can still join the link. A link of any other
// backend is always v2: no released build could join it anyway.
function encodeLink(payload) {
  const out = shapeOf(payload)
  return LINK_PREFIX + Buffer.from(JSON.stringify(out)).toString('base64url')
}

function shapeOf(payload) {
  if (!payload || typeof payload !== 'object') return payload
  if ((payload.b || PEAR_BACKEND) !== PEAR_BACKEND) return toV2(payload)
  const v1 = toV1(payload)
  return inviteV2Enabled() ? toV2(v1) : v1
}

// A payload that is already v1-shaped is returned untouched.
function toV1(payload) {
  if (payload.b === undefined && payload.peer === undefined && payload.route === undefined) {
    return payload
  }
  const { v, b, linkId, peer, route, claim, topic, hostDhtKey, ...rest } = payload
  const out = {
    v,
    linkId,
    topic: topic || (route && route.topic),
    hostDhtKey: hostDhtKey || peer,
    ...rest
  }
  if (claim !== undefined) out.claim = claim
  return out
}

function toV2(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const { v, linkId, claim, ...rest } = payload
  const out = {
    v: INVITE_V2,
    b: payload.b || PEAR_BACKEND,
    linkId,
    peer: payload.peer || payload.hostDhtKey,
    route: payload.route || { topic: payload.topic },
    ...rest
  }
  if (claim !== undefined) out.claim = claim
  return out
}

function linkPrefixOf(uri) {
  if (!uri) return null
  return uri.startsWith(LINK_PREFIX) ? LINK_PREFIX : null
}

// The scheme (up to and including `://`) a rejected URI actually carried, for
// the error message below. Anything that isn't string-and-URI-shaped is
// truncated instead, so a huge or non-string input can't blow up the message.
function schemeOf(uri) {
  const str = typeof uri === 'string' ? uri : String(uri)
  const match = str.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)
  return match ? match[0] : str.slice(0, 32)
}

function decodeLink(uri) {
  const prefix = linkPrefixOf(uri)
  if (!prefix) {
    throw new EngineError(
      CODES.E_AUTH,
      `Invalid ZBTerm invite: not a ZBTerm link (${LINK_PREFIX}...); got "${schemeOf(uri)}"`
    )
  }
  try {
    const payload = JSON.parse(Buffer.from(uri.slice(prefix.length), 'base64url').toString('utf8'))
    const b = payload.b || PEAR_BACKEND
    const route = payload.route && typeof payload.route === 'object' ? payload.route : {}
    const topic = payload.topic || route.topic
    const hostDhtKey = payload.hostDhtKey || payload.peer
    // Only a Pear route is read here (its `topic`); any other backend's route
    // is opaque, and a backend this build lacks must reach the share manager
    // so it can answer E_BACKEND_UNSUPPORTED rather than "invalid invite".
    if (!payload.linkId) throw new Error('missing fields')
    if (b === PEAR_BACKEND && !topic) throw new Error('missing fields')
    // A link carrying both spellings must not disagree with itself: the v1
    // fields are what a released build dials, the v2 ones what this build
    // reads, and a split would pin one host while naming another.
    if (payload.topic && route.topic && payload.topic !== route.topic) {
      throw new Error('conflicting topic')
    }
    if (
      payload.hostDhtKey &&
      payload.peer &&
      String(payload.hostDhtKey).toLowerCase() !== String(payload.peer).toLowerCase()
    ) {
      throw new Error('conflicting host key')
    }
    // hostDhtKey is mandatory (not merely validated-if-present) so every join
    // is pinnable per docs/DESIGN-SWARM-AND-WORKER.md, "Phase 3 -> Pinning":
    // "hostDhtKey becomes mandatory ... so every join has a pinnable host key
    // and controls 1-2 apply universally. No unpinnable join path exists
    // after this phase." Every real invite already includes it (createLink,
    // listLinks), so this rejects only malformed/legacy invites, not a used
    // feature.
    if (!hostDhtKey || !HOST_KEY_RE.test(hostDhtKey)) {
      throw new Error('missing or invalid host key')
    }
    return {
      ...payload,
      b,
      peer: payload.peer || hostDhtKey,
      route: topic ? { ...route, topic } : { ...route },
      claim: payload.claim === undefined ? null : payload.claim,
      topic,
      hostDhtKey
    }
  } catch (err) {
    throw new EngineError(CODES.E_AUTH, 'Invalid ZBTerm invite')
  }
}

module.exports = { LINK_PREFIX, encodeLink, decodeLink }
