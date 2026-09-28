const test = require('brittle')

const {
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
} = require('../engine/caps')

test('cap bit operations and defaults', (t) => {
  t.ok(hasCap(FULL_CAPS, VIEW_LIVE))
  t.ok(hasCap(FULL_CAPS, READ_HISTORY))
  t.ok(hasCap(FULL_CAPS, QUICK_CATCHUP))
  t.ok(hasCap(FULL_CAPS, SEND_INPUT))
  t.ok(hasCap(FULL_CAPS, ADMIN))
  t.is(mergeCaps(VIEW_LIVE, SEND_INPUT), VIEW_LIVE | SEND_INPUT)
  t.is(capsForOwnDevice(), FULL_CAPS)
})

test('link options map to capability masks', (t) => {
  t.is(capsFromLinkOptions({ caps: VIEW_LIVE }), VIEW_LIVE)
  t.is(capsFromLinkOptions({}), VIEW_LIVE | READ_HISTORY | QUICK_CATCHUP)
  t.is(capsFromLinkOptions({ quickCatchup: false }), VIEW_LIVE | READ_HISTORY)
  t.is(
    capsFromLinkOptions({ sendInput: true, admin: true }),
    VIEW_LIVE | READ_HISTORY | QUICK_CATCHUP | SEND_INPUT | ADMIN
  )
})
