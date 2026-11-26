// The closed-session keys, Ctrl+R (resume) and Ctrl+D (delete), and what is
// shown after such a delete (261125_speed-and-keys R3, R5, U1, F1, F2, F13).
//
// Loaded as a plain script by renderer/index.html (window.zbtermSessionKeys)
// and required by test/session-keys.test.js.
;(() => {
  // A closed session of our own: it can be resumed (and so deleted by key).
  // A pending join, a joined session or a live one never is.
  function canExtendSession(session) {
    return !!(
      session &&
      !session.pending &&
      !session.active &&
      session.owner !== 'joined' &&
      !session.isJoined
    )
  }

  // The session Ctrl+R or Ctrl+D acts on, or null. `view`: `mode` ('live' |
  // 'playback'), `selectedId`, `session` (the selected session's list entry),
  // `switchTarget` (the last switch asked for), `drawnId` (the session whose
  // frame was last drawn). A switch not yet drawn has no target (F1): the key
  // would hit a session the user has not seen.
  function offlineKeyTarget(view) {
    if (!view || view.mode !== 'playback' || !view.selectedId) return null
    if (switchUndrawn(view)) return null
    if (!view.session || view.session.sessionId !== view.selectedId) return null
    return canExtendSession(view.session) ? view.selectedId : null
  }

  function switchUndrawn(view) {
    if (view.switchTarget && view.switchTarget !== view.selectedId) return true
    return view.drawnId !== view.selectedId
  }

  // The ids to show after `deletedId` is deleted, best first: the rows drawn
  // after its row (`at`, its index in `rowIds`, else its first row), then the
  // rows before it nearest first, then the first listed; never `deletedId`,
  // each id once (a profile can be listed twice while searching). The caller
  // takes the first one still listed after the list's refresh.
  function neighbourCandidates(rowIds, deletedId, at) {
    const ids = Array.isArray(rowIds) ? rowIds : []
    let i = Number.isInteger(at) && ids[at] === deletedId ? at : ids.indexOf(deletedId)
    if (i < 0) i = ids.length
    const out = []
    const add = (id) => {
      if (id && id !== deletedId && !out.includes(id)) out.push(id)
    }
    for (let k = i + 1; k < ids.length; k++) add(ids[k])
    for (let k = Math.min(i, ids.length) - 1; k >= 0; k--) add(ids[k])
    return out
  }

  // The first candidate that is still in `listedIds` (the refreshed list),
  // else the first listed id, else null (no session left).
  function pickNeighbour(candidates, listedIds, deletedId) {
    const listed = Array.isArray(listedIds) ? listedIds.filter((id) => id !== deletedId) : []
    for (const id of candidates || []) if (listed.includes(id)) return id
    return listed.length ? listed[0] : null
  }

  // ---- The two search states (261125_speed-and-keys R6-R11, P5) ----------

  // What a key does in the search box itself (R8), or null when the box
  // leaves it alone (an IME composing, a Ctrl/Alt/Meta chord: those are the
  // document's). Enter and Shift+Enter only ever step the matches.
  function searchBoxKey(event) {
    if (!event || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return null
    if (event.key === 'Enter') return event.shiftKey ? 'newer' : 'older'
    if (event.shiftKey) return null
    if (event.key === 'Escape') return 'exit'
    if (event.key === 'ArrowDown') return 'next'
    if (event.key === 'ArrowUp') return 'prev'
    return null
  }

  // The status line while the search is on (R9; the wording is soft):
  // `[M / N] ` when the shown session has matches, the keys always, and the
  // closed-session keys while the shown session is closed.
  const SEARCH_STATUS_KEYS = 'Search: ⬆️/⬇️ profiles · Enter/Shift+Enter matches · Esc exit'
  const SEARCH_STATUS_CLOSED = ' · ^R resume · ^D delete'

  function searchStatus(view) {
    const v = view || {}
    const total = Number(v.total) || 0
    const position = total > 0 ? [String(v.index >= 0 ? v.index + 1 : 0), String(total)] : null
    const keys = SEARCH_STATUS_KEYS + (v.closed ? SEARCH_STATUS_CLOSED : '')
    const text = position ? `[${position[0]} / ${position[1]}] ${keys}` : keys
    return { position, keys, text }
  }

  // Ctrl+PgUp/PgDn outside search (R10): the id `delta` rows from `fromId`
  // in `rowIds` (the rows as drawn), wrapping; an id drawn twice is one stop.
  // From an id not drawn: the first row. No rows: null.
  function wrapStep(rowIds, fromId, delta) {
    const ids = []
    for (const id of Array.isArray(rowIds) ? rowIds : []) if (id && !ids.includes(id)) ids.push(id)
    if (!ids.length) return null
    const at = ids.indexOf(fromId)
    if (at < 0) return ids[0]
    const n = ids.length
    return ids[(((at + delta) % n) + n) % n]
  }

  // The heading over the top row while searching (R11): "Current session"
  // only while that row is the one shown.
  function currentHeading(topId, shownId) {
    return topId && topId === shownId ? 'Current session' : 'Search started here'
  }

  const api = {
    canExtendSession,
    offlineKeyTarget,
    switchUndrawn,
    neighbourCandidates,
    pickNeighbour,
    searchBoxKey,
    searchStatus,
    wrapStep,
    currentHeading,
    SEARCH_STATUS_KEYS,
    SEARCH_STATUS_CLOSED
  }
  if (typeof module === 'object' && module && module.exports) module.exports = api
  if (typeof window === 'object' && window) window.zbtermSessionKeys = api
})()
