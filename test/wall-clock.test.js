// renderer/wall-clock.js::formatWallClock, the timeline bubble's wall clock
// (261110_ui-chrome R2). The cases mirror acceptance/R2_bubble_clock.sh, in the
// zone with a DST change on 2026-10-25 (CEST -> CET).
process.env.TZ = 'Europe/Berlin'

const test = require('brittle')
const { formatWallClock, formatDuration } = require('../renderer/wall-clock.js')

const ms = (iso) => Date.parse(iso)

const CASES = [
  ['2026-11-11T08:15:30Z', '2026-11-11T09:00:00Z', '09:15:30', 'today'],
  ['2026-11-08T13:32:05Z', '2026-11-11T09:00:00Z', 'Sun 14:32:05', '3 days ago'],
  ['2026-11-01T11:00:00Z', '2026-11-11T09:00:00Z', '2026-11-01 12:00:00', '10 days ago'],
  ['2026-11-05T08:00:00Z', '2026-11-11T09:00:00Z', 'Thu 09:00:00', '6 days ago: this week'],
  ['2026-11-04T22:00:00Z', '2026-11-11T09:00:00Z', '2026-11-04 23:00:00', '7 days ago'],
  ['2026-11-12T09:00:00Z', '2026-11-11T09:00:00Z', '2026-11-12 10:00:00', 'a later day'],
  ['2026-11-10T22:59:50Z', '2026-11-10T23:00:30Z', 'Tue 23:59:50', '40 s ago, across midnight'],
  ['2026-10-24T23:30:00Z', '2026-10-25T11:00:00Z', '01:30:00', 'same day across DST'],
  ['2026-10-25T00:30:00Z', '2026-10-25T01:45:00Z', '02:30:00', 'the repeated 02:xx hour'],
  ['2026-10-24T11:30:00Z', '2026-10-25T11:00:00Z', 'Sat 13:30:00', '23.5 h ago, previous day'],
  ['2026-10-24T10:30:00Z', '2026-10-25T11:00:00Z', 'Sat 12:30:00', '24.5 h ago across DST'],
  ['2026-01-02T23:00:00Z', '2026-01-03T00:30:00Z', '00:00:00', 'just after midnight']
]

test('formatWallClock: shorter the more recent, by local calendar day', (t) => {
  for (const [ts, now, want, why] of CASES) {
    t.is(formatWallClock(ms(ts), ms(now)), want, `${why}: ${ts} at ${now}`)
  }
})

test('formatWallClock: hours are 24h and zero-padded', (t) => {
  t.is(formatWallClock(ms('2026-11-11T00:05:09Z'), ms('2026-11-11T12:00:00Z')), '01:05:09')
  t.is(formatWallClock(ms('2026-11-11T22:59:59Z'), ms('2026-11-11T22:59:59Z')), '23:59:59')
})

test('formatWallClock: a timestamp that is not a number gives no text', (t) => {
  t.is(formatWallClock(NaN, ms('2026-11-11T12:00:00Z')), '')
  t.is(formatWallClock(undefined, ms('2026-11-11T12:00:00Z')), '')
})

// formatDuration (261113_ui-polish R5): durations of 24 h or more as "Nd h:mm:ss".
const H = 3600000
const DURATIONS = [
  [0, '0:00'],
  [42000, '0:42'],
  [(3 * 3600 + 5 * 60 + 9) * 1000, '3:05:09'],
  [24 * H - 1000, '23:59:59'],
  [24 * H, '1d 0:00:00'],
  [(54 * 3600 + 32 * 60 + 10) * 1000, '2d 6:32:10'],
  [(48 * 3600 + 5) * 1000, '2d 0:00:05'],
  [(10 * 86400 + 11 * 3600 + 7 * 60) * 1000 + 999, '10d 11:07:00'],
  [-5000, '0:00']
]

test('formatDuration: under 24 h unchanged, from 24 h "Nd h:mm:ss"', (t) => {
  for (const [value, want] of DURATIONS) t.is(formatDuration(value), want, `${value} ms`)
})
