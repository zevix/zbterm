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

None.

## Superseded text

None.
