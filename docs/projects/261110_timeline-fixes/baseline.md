# Timeline, playback and selection fixes — baseline

Shared with the siblings: `../261110_ui-chrome/baseline.md` measured the same tree (8173c60) on the
same host on 2026-11-10: tests, lint, package and kit host. This project adds these *Today* facts:

| fact | command → output |
|---|---|
| The clock runs in real time during compressed playback | `sed -n 3917,3931p renderer/app.js` (`tickPlaybackClock`: `clockStartedTs + elapsed`) |
| A gap compresses to `min(gap, threshold)` | `grep -n "compTs += Math.min(gap, thresholdMs)" renderer/app.js` → `7269` |
| The engine player jumps a gap after the threshold | `sed -n 278,288p engine/player.js` (`_playheadTsMs`) |
| Frame step never goes live; the scrub commit does | `sed -n 3512,3525p renderer/app.js` (`step`), `sed -n 3539,3552p` (`commitScrub` → `goLive`) |
| The popup is a `title` rewritten every frame, misspelt | `grep -n "Ucompresses" renderer/app.js` → `6034`; `6039` sets `els.timeLabel.title` |
| Every frame render clears the selection | `sed -n 2968,2988p renderer/app.js` (`renderFrame` → `resetVisibleTerminal`) |
| Copy reads the selection when the menu opens | `grep -n "copy.disabled = !state.term.hasSelection()" renderer/app.js` → `2558` |

R1, R3 and R5 are reproduced in P1, with the logs under `runs/261110_timeline-fixes/`.
