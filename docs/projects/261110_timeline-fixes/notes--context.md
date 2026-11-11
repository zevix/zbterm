# Timeline, playback and selection fixes — notes and context

Companion to `goal_requirements.md`. Not a spec; nothing here is approved or built from.

## The user's words

**2026-11-10** ("Please add to the project bugs I found now"):

> - Selecting text while scrolling through history has a bug - the selection dissapears immidiately. It should also pause automatically if playing and blink the play/pause button with a caret icon in the selection color
> - Selecting text in live terminal then right-clicking - the selection disapears when the dialog opens, so the "Copy" option is disabled
> - In compressed time view, hovering the end time (near the [ 1x v] dropdown on the bottom right - make the "Uncomporessed .../..." popup blinks
> - In compressed time view, the end time does not update for some reason after swithing to and from real time
> - Mouse wheel scroll + ALT toe the left and then back to the right does not return to real time like regular scrolling above the slider

> + on playback in compressed mode the current / total time does not update in empty spaces - I think it should jump over blank times

## Context

- The user asked for these to go into "the project". `261110_ui-chrome`'s goal page was at 391 of the 400 words, so they are a third sibling project (2026-11-10). It runs after `261110_ui-chrome` P2, which changes the same functions (`updateTimeLabels`, `scrubberTipTextForTs`) for the bubble clock.
- The six items are six rows, R1 to R7. The first item is two rows: R1 (the selection is kept) and R2 (pause and blink).

## Requirement notes

- **R1** "scrolling through history" is read as being in playback (history) mode, paused or scrubbed to a point. A-1 covers frame changes.
- **R2** "caret icon" is `fa-i-cursor`. "selection color" is the theme's `--terminal-selection` (`renderer/index.html`).
- **R3** "the dialog" is the terminal context menu (`openTerminalMenu`).
- **R4** The popup is the `title` of `#timeLabel`, the current/total label beside the speed dropdown. Its text today is "Ucompresses: …"; it becomes "Uncompressed: …".
- **R5** The cause is not yet reproduced (`design.md` *Causes*).
- **R6** "real time" in the user's words means live. The plain-wheel behaviour is `commitScrub` → `goLive()`.
- **R7** "jump over blank times": A-2.

## Soft changes

- **2026-11-11 (builder P2, planner decision), R5 mechanism.** The design's answer (the map built for the current end, `toggleTimeCollapse` keeping the exact clock ts) was not enough: P1 found that in live mode `state.timeline` never takes in live output, so the compressed total of a running session stalled at about 0:02. The compressed map now also takes in the live session's output times (`state.liveTimeline`, fed from `session:data`; a burst of packets under 100 ms apart keeps only its first and last time, which leaves the compressed span unchanged). It is rebuilt with them at most once a second (design row 4); in between only its end moves to "now", in place. `state.timeline` itself is unchanged, so `lastSeq` and the scrubber marks are as before. Read back to the user before "done".
- **2026-11-11 (builder P2), R7 mechanism, and the goal's *Out of scope* line on `engine/player.js`.** The bug also lives in the engine player, found in P2 rather than P1. After it jumps a collapsed gap, `_playheadTsMs` kept the wall clock it started with, so the playhead lagged the packet it had jumped to by (gap - threshold). The next packets stalled that long, and each later gap took the threshold plus that lag. Evidence: in `p3_kit/R7_compressed_playback.txt` a 3.2 s gap followed by the 20 s gap made the 20 s gap take about 3.2 s, not 2 s. A new `test/player.test.js` case failed before the fix (`seq 3 853 ms after seq 2`, want under 250; log `p2_player-before.log`). The fix, in `_scheduleNext`: when a delivered packet is ahead of the raw playhead with collapse on, the playhead re-anchors on it. Without it R7's renderer clock, held below the next packet, would stall about 1.2 s inside the gap. Read back to the user before "done".
- **2026-11-11 (builder P4), R5 running total, two causes in the product.** R5's last running check showed 16 s for 17 s real in three runs of three (`p4_R5_run{1,2,3}.log`), inside its ±1 s only by luck. Causes: (a) a running session's labels came from a free-running 1 s `setInterval`, so the shown second could be up to 1 s behind, at a phase fixed by when the app started; (b) between rebuilds the map's end moved in place from the last point it was built with, and the end segment is capped at the threshold, so once that end lay more than the threshold past it with newer output waiting, the cap dropped real time. Fixes: `startSessionClock` ticks just after the shown total turns over to its next second (`msToNextSecond`, a 1 s wait when the total did not move); `retargetTimeCollapseMap` takes a `pending` flag and asks for a rebuild in case (b). Tests in `test/time-collapse.test.js` failed before (`p4_time-collapse-before.log`). After: 17 s for 17 s in three runs of three (`p4_R5_fix_run{1,2,3}.log`). The tolerance is unchanged. Read back to the user before "done".

## Superseded text

None.
