// renderer/session-keys.js: the Ctrl+R / Ctrl+D guard and the neighbour shown
// after a delete by key (261125_speed-and-keys R3, R5, U1, F1, F13).
const test = require('brittle')
const {
  canExtendSession,
  offlineKeyTarget,
  neighbourCandidates,
  pickNeighbour
} = require('../renderer/session-keys.js')

const closed = { sessionId: 's1', active: false }
const drawn = (session, extra = {}) => ({
  mode: 'playback',
  selectedId: session.sessionId,
  session,
  switchTarget: session.sessionId,
  drawnId: session.sessionId,
  ...extra
})

test('a closed session of our own, shown and drawn, passes the guard', (t) => {
  t.is(offlineKeyTarget(drawn(closed)), 's1')
  t.ok(canExtendSession(closed))
})

test('joined and pending sessions never pass the guard (U1)', (t) => {
  const forms = [
    { sessionId: 'j1', active: false, owner: 'joined' },
    { sessionId: 'j2', active: false, isJoined: true },
    { sessionId: 'j3', active: true, owner: 'joined' },
    { sessionId: 'pending:x', pending: true, active: false },
    { sessionId: 'pending:y', pending: true, active: false, owner: 'joined' }
  ]
  for (const session of forms) {
    t.absent(canExtendSession(session), `${session.sessionId}: not resumable`)
    t.is(offlineKeyTarget(drawn(session)), null, `${session.sessionId}: no target, drawn`)
    t.is(
      offlineKeyTarget(drawn(session, { mode: 'live' })),
      null,
      `${session.sessionId}: no target, live mode`
    )
  }
})

test('a live session, or no session, never passes the guard (U1)', (t) => {
  const live = { sessionId: 'l1', active: true }
  t.is(offlineKeyTarget(drawn(live)), null)
  t.is(offlineKeyTarget(drawn(live, { mode: 'live' })), null)
  t.is(offlineKeyTarget(drawn(closed, { mode: 'live' })), null)
  t.is(offlineKeyTarget({ mode: 'playback', selectedId: null, session: null }), null)
  t.is(offlineKeyTarget(null), null)
})

test('a switch not yet drawn has no target (F1)', (t) => {
  // Ctrl+PgDn asked for s2, the screen still shows s1.
  t.is(offlineKeyTarget(drawn(closed, { switchTarget: 's2' })), null)
  // s1 selected, its frame not drawn yet.
  t.is(offlineKeyTarget(drawn(closed, { drawnId: null })), null)
  t.is(offlineKeyTarget(drawn(closed, { drawnId: 's0' })), null)
  // The entry handed in is another session's: refused.
  t.is(offlineKeyTarget(drawn(closed, { session: { sessionId: 's9', active: false } })), null)
})

test('the neighbour: the next row with another id, else the previous, each once (F13)', (t) => {
  t.alike(neighbourCandidates(['a', 'b', 'c', 'd'], 'b'), ['c', 'd', 'a'])
  t.alike(neighbourCandidates(['a', 'b', 'c'], 'c'), ['b', 'a'])
  // Listed twice while searching: the cursor's row counts, the copies are skipped.
  t.alike(neighbourCandidates(['b', 'a', 'b', 'c'], 'b', 2), ['c', 'a'])
  t.alike(neighbourCandidates(['b', 'a', 'b', 'c'], 'b', 0), ['a', 'c'])
  t.alike(neighbourCandidates(['b'], 'b'), [])
  // Not drawn at all: every row, last first.
  t.alike(neighbourCandidates(['a', 'c'], 'b'), ['c', 'a'])
})

test('the neighbour is checked against the refreshed list; none left is null (R5)', (t) => {
  t.is(pickNeighbour(['c', 'a'], ['a', 'c'], 'b'), 'c')
  t.is(pickNeighbour(['c', 'a'], ['a'], 'b'), 'a')
  t.is(pickNeighbour(['c'], ['x', 'y'], 'b'), 'x')
  t.is(pickNeighbour([], ['b'], 'b'), null)
  t.is(pickNeighbour([], [], 'b'), null)
})

// 261125_speed-and-keys P5 (R6-R11): the two search states' pure parts.
const {
  searchBoxKey,
  searchStatus,
  wrapStep,
  currentHeading
} = require('../renderer/session-keys.js')

test('the box keys: Enter/Shift+Enter only step matches; IME and chords are left alone (R8, F16)', (t) => {
  t.is(searchBoxKey({ key: 'Enter' }), 'older')
  t.is(searchBoxKey({ key: 'Enter', shiftKey: true }), 'newer')
  t.is(searchBoxKey({ key: 'Escape' }), 'exit')
  t.is(searchBoxKey({ key: 'ArrowDown' }), 'next')
  t.is(searchBoxKey({ key: 'ArrowUp' }), 'prev')
  // An IME composing owns Enter and the arrows.
  t.is(searchBoxKey({ key: 'Enter', isComposing: true }), null)
  t.is(searchBoxKey({ key: 'ArrowDown', isComposing: true }), null)
  // Chords are the document's (Ctrl+R, Ctrl+D, Ctrl+PgDn ...).
  t.is(searchBoxKey({ key: 'Enter', ctrlKey: true }), null)
  t.is(searchBoxKey({ key: 'r', ctrlKey: true }), null)
  t.is(searchBoxKey({ key: 'Escape', shiftKey: true }), null)
  t.is(searchBoxKey({ key: 'ArrowDown', shiftKey: true }), null)
  t.is(searchBoxKey({ key: 'a' }), null)
  t.is(searchBoxKey(null), null)
})

test('the search line: keys always, [M / N] with matches, ^R/^D on a closed session (R9)', (t) => {
  const keys = 'Search: ⬆️/⬇️ profiles · Enter/Shift+Enter matches · Esc exit'
  t.is(searchStatus({}).text, keys)
  t.is(searchStatus({ index: -1, total: 0 }).text, keys, 'zero matches: still the keys')
  t.is(searchStatus({ index: -1, total: 0 }).position, null)
  t.is(searchStatus({ index: 0, total: 3 }).text, `[1 / 3] ${keys}`)
  t.is(searchStatus({ index: -1, total: 3 }).text, `[0 / 3] ${keys}`)
  t.alike(searchStatus({ index: 2, total: 3 }).position, ['3', '3'])
  t.is(searchStatus({ closed: true }).text, `${keys} · ^R resume · ^D delete`)
  t.is(
    searchStatus({ index: 1, total: 2, closed: true }).text,
    `[2 / 2] ${keys} · ^R resume · ^D delete`
  )
})

test('Ctrl+PgUp/PgDn outside search: every drawn row in order, wrapping (R10)', (t) => {
  const ids = ['a', 'b', 'c']
  t.is(wrapStep(ids, 'a', 1), 'b')
  t.is(wrapStep(ids, 'c', 1), 'a', 'wraps forward')
  t.is(wrapStep(ids, 'a', -1), 'c', 'wraps back')
  t.is(wrapStep(ids, 'b', -1), 'a')
  t.is(wrapStep(ids, 'x', 1), 'a', 'not drawn: the first row')
  t.is(wrapStep(['a', 'b', 'a', 'c'], 'b', 1), 'c', 'a row drawn twice is one stop')
  t.is(wrapStep(['a'], 'a', 1), 'a')
  t.is(wrapStep([], 'a', 1), null)
  // Pressed as many times as there are rows: each row once, back to the start.
  const seen = []
  let at = 'a'
  for (let i = 0; i < ids.length; i++) seen.push((at = wrapStep(ids, at, 1)))
  t.alike(seen, ['b', 'c', 'a'])
})

test('the top heading: "Current session" only while its row is shown (R11)', (t) => {
  t.is(currentHeading('s1', 's1'), 'Current session')
  t.is(currentHeading('s1', 's2'), 'Search started here')
  t.is(currentHeading('s1', null), 'Search started here')
})
