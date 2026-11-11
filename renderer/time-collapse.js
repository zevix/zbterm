// Collapsed ("compressed") time on the playback timeline (261110_timeline-fixes
// R5, R7). A gap between two recorded packets counts for at most the
// threshold, so the compressed timeline is a piecewise-linear map of the real
// one: breakpoints `{ realTs, compTs }`, one per packet, with `compTs` growing
// by `min(gap, thresholdMs)` from one to the next.
//
// Loaded as a plain script by renderer/index.html (window.zbtermTimeCollapse)
// and required by test/time-collapse.test.js.
;(() => {
  // The map from `startTs` to `endTs` over the packet times `points` (epoch ms,
  // any order). `maxPointTs` is the latest point, so a caller can tell whether
  // a later end leaves out none of them (retargetTimeCollapseMap).
  function buildTimeCollapseMap(points, startTs, endTs, thresholdMs) {
    let maxPointTs = -Infinity
    for (const tsMs of points) if (tsMs > maxPointTs) maxPointTs = tsMs
    if (endTs <= startTs) {
      return {
        breakpoints: [
          { realTs: startTs, compTs: 0 },
          { realTs: endTs, compTs: 0 }
        ],
        interior: 1,
        compressedSpan: 0,
        endTs,
        maxPointTs,
        complete: false
      }
    }
    const inside = new Set([startTs])
    for (const tsMs of points) if (tsMs > startTs && tsMs < endTs) inside.add(tsMs)
    const sorted = Array.from(inside).sort((a, b) => a - b)
    const breakpoints = [{ realTs: sorted[0], compTs: 0 }]
    let compTs = 0
    for (let i = 1; i < sorted.length; i++) {
      compTs += Math.min(sorted[i] - sorted[i - 1], thresholdMs)
      breakpoints.push({ realTs: sorted[i], compTs })
    }
    const map = {
      breakpoints,
      interior: breakpoints.length,
      compressedSpan: 0,
      endTs,
      maxPointTs,
      // Every point is inside the map, so a later end can be set in place.
      complete: endTs > maxPointTs
    }
    setTimeCollapseEnd(map, endTs, thresholdMs)
    return map
  }

  function setTimeCollapseEnd(map, endTs, thresholdMs) {
    const bp = map.breakpoints
    bp.length = map.interior
    const last = bp[bp.length - 1]
    const compTs = last.compTs + Math.min(Math.max(0, endTs - last.realTs), thresholdMs)
    bp.push({ realTs: endTs, compTs })
    map.compressedSpan = compTs
    map.endTs = endTs
  }

  // Moves the map's end to `endTs` in place, without rebuilding it, when no
  // point is left out (a running session's end is "now", which moves on every
  // frame). False when the caller has to rebuild. `pending` says output came
  // in since the map was built: then the in-place end is right only while it
  // is within the threshold of the map's last point, since past it the cap
  // would drop time the new output keeps (2026-11-11, R5).
  function retargetTimeCollapseMap(map, endTs, thresholdMs, pending = false) {
    if (map.endTs === endTs) return true
    if (!map.complete || endTs <= map.maxPointTs || endTs <= map.breakpoints[0].realTs) {
      return false
    }
    if (pending && endTs - map.breakpoints[map.interior - 1].realTs > thresholdMs) return false
    setTimeCollapseEnd(map, endTs, thresholdMs)
    return true
  }

  function realToCompressed(map, tsMs) {
    const bp = map.breakpoints
    if (!bp || !bp.length) return 0
    if (tsMs <= bp[0].realTs) return bp[0].compTs
    if (tsMs >= bp[bp.length - 1].realTs) return bp[bp.length - 1].compTs
    const hi = firstAbove(bp, 'realTs', tsMs)
    const a = bp[hi - 1]
    const b = bp[hi]
    const realSpan = b.realTs - a.realTs
    if (realSpan <= 0) return a.compTs
    return a.compTs + ((b.compTs - a.compTs) * (tsMs - a.realTs)) / realSpan
  }

  function compressedToReal(map, compTs) {
    const bp = map.breakpoints
    if (!bp || !bp.length) return 0
    if (compTs <= bp[0].compTs) return bp[0].realTs
    if (compTs >= bp[bp.length - 1].compTs) return bp[bp.length - 1].realTs
    const hi = firstAbove(bp, 'compTs', compTs)
    const a = bp[hi - 1]
    const b = bp[hi]
    const compSpan = b.compTs - a.compTs
    if (compSpan <= 0) return a.realTs
    return a.realTs + ((b.realTs - a.realTs) * (compTs - a.compTs)) / compSpan
  }

  // The running playback clock while collapse is on: `advancedMs` of
  // compressed time (wall time x speed) after the anchor, as a real ts. It is
  // held just below the next packet after the anchor until that packet
  // arrives (the caller re-anchors on it), so it never shows a time before the
  // frame is drawn and never steps back. The map's end is not a packet.
  function compressedClockTs(map, anchorTs, anchorComp, advancedMs) {
    const realTs = compressedToReal(map, anchorComp + Math.max(0, advancedMs))
    const bp = map.breakpoints
    if (!bp || bp.length < 2) return Math.max(anchorTs, realTs)
    const next = firstAbove(bp, 'realTs', anchorTs)
    if (next <= 0 || next >= bp.length - 1) return Math.max(anchorTs, realTs)
    return Math.max(anchorTs, Math.min(realTs, bp[next].realTs - 1))
  }

  // The index of the first breakpoint whose `key` is above `value`
  // (bp.length when none is).
  function firstAbove(bp, key, value) {
    let lo = 0
    let hi = bp.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (bp[mid][key] <= value) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  // Live output times for the map, kept short: inside a burst (packets closer
  // than `mergeMs`) only its first and last time are kept. The gaps dropped are
  // all under `mergeMs`, so the compressed span is the same for any threshold
  // of at least `mergeMs`.
  function addLivePoint(points, tsMs, mergeMs) {
    const n = points.length
    if (n && tsMs < points[n - 1]) return
    if (n >= 2 && tsMs - points[n - 1] < mergeMs && points[n - 1] - points[n - 2] < mergeMs) {
      points[n - 1] = tsMs
      return
    }
    points.push(tsMs)
  }

  // How long until a clock showing `elapsedMs` (in whole seconds) shows the
  // next second; the live time labels tick on it, not on a free-running
  // 1 s timer that could show a second up to 1 s late (2026-11-11, R5).
  function msToNextSecond(elapsedMs) {
    const into = elapsedMs > 0 ? elapsedMs % 1000 : 0
    return 1000 - into
  }

  const api = {
    buildTimeCollapseMap,
    retargetTimeCollapseMap,
    realToCompressed,
    compressedToReal,
    compressedClockTs,
    addLivePoint,
    msToNextSecond
  }
  if (typeof module === 'object' && module && module.exports) module.exports = api
  if (typeof window === 'object' && window) window.zbtermTimeCollapse = api
})()
