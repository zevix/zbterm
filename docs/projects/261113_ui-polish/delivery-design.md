# Output delivery: switching to a session while it prints — design note

**Status:** investigation only, no fix (the user, 2026-11-13, via the coordinator). Waits for the user's
choice of design. Written 2026-11-13 against the tree at `03c396e` (+ this project's R13 edit, which
does not touch this path).

## Symptom

Selecting a live session while it prints sometimes shows one or two lines twice, or drops one
(`261111_buffer-search/acceptance/report--2026-11-13-F3.md`: renderer count above the engine's in 2 of
18 trials, below it in 1 of 18 and 2 of 10 on the pre-F3 package).

## Root cause

The terminal on screen is built from two sources that share no position: a **frame** (the engine's
headless mirror serialised, the answer to `session.open`; also `session.extend` and the repaint after
`session:restored`) and the **stream** (`session:data` events). Nothing says which stream bytes a frame
already contains, so the renderer guesses "everything that arrived before the answer is in the frame,
everything after is not". Two places break that guess:

1. **Drop: the frame is cut before the answer is sent.** `engine/index.js::_sessionState` snapshots the
   mirror, then `await availabilitySummary(runtime.store)`. Output that arrives during that await is
   emitted as `session:data`, reaches the renderer *before* the answer (worker pipe and main's batcher
   keep order), is queued or written by `selectSession` (which already set `mode = 'live'` and
   `selectedId`), and is then wiped by `renderLiveFrame` (`clearLiveWrites` + `term.reset()`) and painted
   over with a frame that does not contain it. Lost.
2. **Duplicate: `term.reset()` does not cancel queued writes.** xterm.js 6 `CoreTerminal.reset()`
   resets the buffers and parser but not the `WriteBuffer`
   (`node_modules/@xterm/xterm/src/common/CoreTerminal.ts:244`). A chunk the renderer handed to
   `term.write` before the answer (output already in the frame) is still unparsed at the reset; it is
   parsed onto the blank screen first, then the frame (SerializeAddon output, which does not clear the
   screen) is written below it and pushes those lines into scrollback. Shown twice.

F3's batcher flush (`bceccbb`) fixed a third, main-side reordering; it cannot fix either of these,
which sit in the engine and the renderer.

## Proof

All runs 2026-11-13 on `zr`, each under `timeout 600`, against an instrumented *copy* of this project's
scratch package (`/tmp/claude-1000/zbdeliv/out`; the repo is untouched). The instrumentation: the
engine's `_sessionState` adds `probeSnapBytes` (`runtime.bytesSeen` at the snapshot) and
`probeAnswerBytes` (at the answer) to the frame; the renderer logs, in `renderLiveFrame`, the bytes of
the session's `session:data` that arrived while `session.open` was in flight and xterm's
`_writeBuffer._pendingData` just before `term.reset()`. Probes and results:
`delivery-probe/` (`dup_probe.sh`, `dup_fast.sh`, `dup_delay.sh`, `xterm_reset.js`, `probe1-3.txt`).

| run | what | result |
|---|---|---|
| 1 | `/tmp/claude-1000/zbv4/probe/dup.sh` as written (1200 lines at ~400/s), 12 trials | 12 × engine = renderer (1200); xterm held unparsed bytes at the reset in 2 trials (20 and 11 bytes, the command echo); output after the snapshot: 0 in all |
| 2 | flood 4000 lines through `pv -qL 40000`, 12 trials | 12 × equal (4001); nothing arrived inside the open window: the window is a few ms, which is why the bug is rare |
| 3 | run 2 with a 50 ms delay injected after the snapshot (`DELIV_DELAY_MS`, standing in for a slow `availabilitySummary` under load), 8 trials | **5 of 8 short**: each had 4364 bytes after the snapshot, all 4364 arrived before the answer (`inflightBytes`), and the renderer had 3637–3638 lines instead of 4001: 364 lost lines × 12 bytes = 4368 ≈ 4364. The 3 trials with nothing after the snapshot were equal. Mechanism 1, exactly. |
| 4 | `xterm_reset.js`: `@xterm/headless` 6.0.0, a 5-row terminal; write stale output, `reset()`, `VISIBLE_TERMINAL_RESET`, then the serialised frame of lines 1–8 | stale `line 7, line 8` → buffer correct (`?1049l` puts the cursor home, the frame paints over); stale `line 2`…`line 8` (more than a screen) → `line 2, line 3, line 4` **twice** in scrollback; stale `line 8 with a longer tail` → row 1 reads `line 1 with a longer tail`. A write before `reset()` is still parsed after it. Mechanism 2, exactly. |

So: drops come from output emitted between the snapshot and the answer (mechanism 1, timing-dependent,
widened by any load on the worker); duplicates and garbled rows come from output still queued in
xterm at the reset (mechanism 2), visible when the queued chunk is longer than a screen or than the
row it lands on.

## Candidate designs

**A. Stream positions (recommended).** The engine counts each live session's output bytes (it already
does: `runtime.bytesSeen`). Every `session:data` carries `end` (the count after the chunk); every frame
carries `through` (the count it contains: the mirror's writes plus the pending tail, taken in one
synchronous step). The renderer, while a frame is pending for the selected session, holds that session's
chunks instead of writing them; on the frame it drops held bytes `≤ through`, cuts the chunk that
straddles it, writes the rest after the frame, and afterwards writes a chunk only past the last `end`
written. Before painting any frame it waits for xterm's queue to drain (`term.write('', paint)`).
Correct whatever order the answer and the events arrive in, for open, extend and restore alike; a gap
between two `end`s becomes visible (the engine's backlog drops today are silent) and can trigger a
resync. *Cost:* `EVENT_DATA` gains a field (`engine/rpc/schema.js`, a minor version in
`docs/CORE-CONTRACT.md`), frames gain `through`, main's batcher keeps the last `end` when it joins
chunks, ~80 renderer lines, unit tests for trim and gap. Joined sessions need the same counter on the
viewer's side (their frames come from the remote mirror): a second step.

**B. Snapshot last, discard before the answer.** `_sessionState` computes everything else first and
takes the snapshot (with the pending tail) as its last synchronous step; the renderer holds the
session's chunks while the call is in flight and discards them all at the answer, and drains xterm
before the reset. *Cost:* ~10 engine and ~30 renderer lines, no contract change. *But* it stays correct
only while every event emitted before the answer also arrives before it: worker pipe, main's batcher
and Electron's ordering of `webContents.send` against `ipcMain.handle` replies. The batcher already broke
that once (F3), and Electron does not document the order between the two.

**C. Frames through the stream.** `session.open` answers without a frame and the engine emits
`session:frame {requestId}` on the same event channel as the data, in the same synchronous step as the
snapshot. One channel is ordered, so every chunk before the frame is in it and every chunk after is
not: the renderer discards the session's chunks until its frame arrives. *Cost:* a new event (contract
minor version), a request id so other windows ignore it, renderer waits for an event instead of an
answer; extend and restore move the same way. Exact, but it ties correctness to one channel's order
again (sound today), and a big frame now travels as an event to every window.

## Recommendation

**A.** It makes the screen correct by construction rather than by transport order, covers every
frame-returning call, and turns today's silent drops into a detectable gap. The xterm drain before a
reset is needed in every design and is the cheapest first step: it alone removes the duplicates.
