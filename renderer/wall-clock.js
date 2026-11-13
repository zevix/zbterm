// The wall-clock time shown in the timeline bubble (261110_ui-chrome R2), and
// the durations' format (261113_ui-polish R5, formatDuration below). The clock:
// the shorter, the more recent. `tsMs` and `nowMs` are epoch milliseconds, so the
// instant is absolute and is shown in the viewer's own time zone; days are
// compared by local calendar date, never by 24-hour steps (DST, midnight).
//   the same calendar day      14:32:05
//   the previous six days      Thu 14:32:05
//   older, or a later day      2026-11-10 14:32:05
// Loaded as a plain script by renderer/index.html (window.zbtermFormatWallClock)
// and required by test/wall-clock.test.js.
;(() => {
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  function pad2(value) {
    return String(value).padStart(2, '0')
  }

  // The local calendar date as a day count, so two dates subtract to whole days.
  function localDayNumber(date) {
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000
  }

  function formatWallClock(tsMs, nowMs) {
    const ts = new Date(Number(tsMs))
    if (!Number.isFinite(ts.getTime())) return ''
    const now = new Date(Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now())
    const clock = `${pad2(ts.getHours())}:${pad2(ts.getMinutes())}:${pad2(ts.getSeconds())}`
    const daysAgo = localDayNumber(now) - localDayNumber(ts)
    if (daysAgo === 0) return clock
    if (daysAgo >= 1 && daysAgo <= 6) return `${WEEKDAYS[ts.getDay()]} ${clock}`
    return `${ts.getFullYear()}-${pad2(ts.getMonth() + 1)}-${pad2(ts.getDate())} ${clock}`
  }

  // A duration (261113_ui-polish R5): "m:ss", "h:mm:ss", and from 24 h on
  // "Nd h:mm:ss" with the hours unpadded (54:32:10 is "2d 6:32:10", exactly
  // 24 h is "1d 0:00:00"). Clock times never go through this.
  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0)
    const days = Math.floor(totalSeconds / 86400)
    const hours = Math.floor((totalSeconds % 86400) / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    if (days) return `${days}d ${hours}:${pad2(minutes)}:${pad2(seconds)}`
    if (hours) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    return `${minutes}:${pad2(seconds)}`
  }

  if (typeof module === 'object' && module && module.exports) {
    module.exports = { formatWallClock, formatDuration }
  }
  if (typeof window === 'object' && window) {
    window.zbtermFormatWallClock = formatWallClock
    window.zbtermFormatDuration = formatDuration
  }
})()
