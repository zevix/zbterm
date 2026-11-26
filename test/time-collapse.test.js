// renderer/time-collapse.js: the compressed timeline and the compressed
// playback clock (261110_timeline-fixes R5, R7).
const test = require('brittle')
const {
  buildTimeCollapseMap,
  timeCollapseBase,
  extendTimeCollapseBase,
  retargetTimeCollapseMap,
  realToCompressed,
  compressedToReal,
  compressedClockTs,
  addLivePoint,
  msToNextSecond
} = require('../renderer/time-collapse.js')

const TH = 2000

test('a gap counts for at most the threshold', (t) => {
  // Packets at 0, 5 s and 10 s: two 5 s gaps of 2 s each (R5's ended fixture).
  const map = buildTimeCollapseMap([0, 5000, 10000], 0, 10000, TH)
  t.is(map.compressedSpan, 4000)
  t.is(realToCompressed(map, 5000), 2000)
  t.is(realToCompressed(map, 2500), 1000, 'linear inside a gap')
  t.is(compressedToReal(map, 3000), 7500)
  t.is(compressedToReal(map, realToCompressed(map, 8123)), 8123, 'round trip')
})

test('short gaps keep their real length', (t) => {
  const points = []
  for (let i = 0; i <= 14; i++) points.push(i * 1000)
  const map = buildTimeCollapseMap(points, 0, 14000, TH)
  t.is(map.compressedSpan, 14000)
})

test('the end moves in place, and the trailing idle time is capped', (t) => {
  const map = buildTimeCollapseMap([0, 1000, 2000], 0, 2500, TH)
  t.is(map.compressedSpan, 2500)
  const breakpoints = map.breakpoints
  t.ok(retargetTimeCollapseMap(map, 3500, TH))
  t.is(map.breakpoints, breakpoints, 'no rebuild')
  t.is(map.compressedSpan, 3500)
  t.ok(retargetTimeCollapseMap(map, 60000, TH))
  t.is(map.compressedSpan, 4000, 'idle after the last packet counts for the threshold')
  t.is(map.breakpoints.length, 4)
})

test('an end that would leave a point out asks for a rebuild', (t) => {
  const map = buildTimeCollapseMap([0, 1000, 5000], 0, 3000, TH)
  t.is(map.compressedSpan, 3000)
  t.absent(retargetTimeCollapseMap(map, 6000, TH), 'the 5 s point was left out')
  const full = buildTimeCollapseMap([0, 1000, 5000], 0, 6000, TH)
  t.is(full.compressedSpan, 1000 + 2000 + 1000)
})

// 2026-11-11 (P4): a running session's map is moved in place between
// rebuilds while new output is waiting. If the end then lies more than the
// threshold past the map's last point, the cap drops real time the waiting
// output would have kept (R5's running check, 16 s shown for 17 s).
test('an end past the threshold with output waiting asks for a rebuild', (t) => {
  const map = buildTimeCollapseMap([0, 1000], 0, 1500, TH)
  t.ok(retargetTimeCollapseMap(map, 2900, TH, true), 'inside the threshold: in place')
  t.is(map.compressedSpan, 2900)
  t.absent(retargetTimeCollapseMap(map, 3500, TH, true), 'past it: rebuild')
  t.ok(retargetTimeCollapseMap(map, 3500, TH), 'nothing waiting: in place')
  t.is(map.compressedSpan, 3000)
  const full = buildTimeCollapseMap([0, 1000, 2000], 0, 3500, TH)
  t.is(full.compressedSpan, 3500)
})

test('the live clock ticks when the shown second changes', (t) => {
  t.is(msToNextSecond(0), 1000)
  t.is(msToNextSecond(16940), 60)
  t.is(msToNextSecond(17000), 1000)
  t.is(msToNextSecond(-5), 1000, 'never in the past')
})

test('the compressed clock moves through a gap at full speed', (t) => {
  // A 20 s gap after 1 s: it plays in the 2 s threshold.
  const map = buildTimeCollapseMap([0, 1000, 21000, 21100], 0, 21100, TH)
  const anchorComp = realToCompressed(map, 1000)
  let last = 1000
  for (let ms = 100; ms < 2000; ms += 100) {
    const ts = compressedClockTs(map, 1000, anchorComp, ms)
    t.ok(ts > last, `moving at ${ms} ms`)
    last = ts
  }
  t.is(compressedClockTs(map, 1000, anchorComp, 1000), 11000, 'half the gap in half the threshold')
})

test('the compressed clock waits just below the next packet', (t) => {
  const map = buildTimeCollapseMap([0, 1000, 21000, 21100], 0, 21100, TH)
  const anchorComp = realToCompressed(map, 1000)
  t.is(compressedClockTs(map, 1000, anchorComp, 5000), 20999, 'held below the packet at 21 s')
  // Re-anchored on that packet, it moves on.
  const next = compressedClockTs(map, 21000, realToCompressed(map, 21000), 50)
  t.is(next, 21050)
  // The map's end is not a packet: the clock may reach it.
  t.is(compressedClockTs(map, 21100, realToCompressed(map, 21100), 500), 21100)
  // Never before the anchor.
  t.is(compressedClockTs(map, 21000, realToCompressed(map, 21000), -10), 21000)
})

test('live points keep a burst to its first and last time', (t) => {
  const points = []
  for (const ts of [0, 10, 20, 30, 1000, 1010, 4000]) addLivePoint(points, ts, 100)
  t.alike(points, [0, 30, 1000, 1010, 4000])
  // The dropped gaps are all under the merge distance: the span is unchanged.
  const all = buildTimeCollapseMap([0, 10, 20, 30, 1000, 1010, 4000], 0, 4000, TH)
  const kept = buildTimeCollapseMap(points, 0, 4000, TH)
  t.is(kept.compressedSpan, all.compressedSpan)
})

// 261125_speed-and-keys P2: a running session's map from the timeline's
// cached breakpoints plus its live output is the full build's map.
test('a map extended from a base equals the full build', (t) => {
  let seed = 7
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (let round = 0; round < 50; round++) {
    const startTs = 1000 + rand(3) * 500
    const timeline = []
    let ts = 0
    for (let i = 0; i < 40; i++) {
      ts += rand(4) === 0 ? 3000 + rand(9000) : rand(600)
      timeline.push(ts)
    }
    const live = []
    let liveTs = ts + rand(2)
    for (let i = 0; i < 10; i++) {
      liveTs += rand(3) === 0 ? 2500 + rand(5000) : rand(300)
      live.push(liveTs)
    }
    const endTs = liveTs + rand(4000)
    const base = timeCollapseBase(timeline, startTs, TH)
    const extended = extendTimeCollapseBase(base, live, endTs)
    const full = buildTimeCollapseMap(timeline.concat(live), startTs, endTs, TH)
    t.alike(extended, full, `round ${round}`)
  }
})

test('an extended map defers to the full build when it cannot be exact', (t) => {
  const base = timeCollapseBase([0, 1000, 5000], 0, TH)
  t.is(extendTimeCollapseBase(base, [6000], 5000), null, 'end not after the last point')
  t.is(extendTimeCollapseBase(base, [3000], 9000), null, 'a live point inside the base')
  t.ok(extendTimeCollapseBase(base, [5000, 6000], 9000), 'a live point equal to the last')
})
