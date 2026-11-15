# Live output and fixes — phases (the HOW)

A builder's brief is: `docs/templates/rules.md`, **one** phase section below,
`goal_requirements.md`, `baseline.md`, and the status file. Paths, not pasted bodies.

## Conventions

Node via npm (never pnpm). Tests: `HOME=<scratch> TMPDIR=<under 20 chars> npm test`, every command
under `timeout`. Lint: `npm run lint` (= CI). The kit needs a scratch package:
`ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zblive/out npm run package`, repackaged after any renderer or
engine change. `docs/decisions.md` rows are not edited.

**Host.** `zr` (Linux): `uisolate`, `xdotool`, `jq`, `curl`, `fc-match`, the packaged build at
`$ZBUI_APP`; the same facts as the `need` lines in `acceptance/`.

## Order

```
P0  baseline: baseline.md (Today, Cost, tree)                       needs: —
P1  R4–R7: stamp mark, hidden split, + A / - A in serif             needs: P0 (independent of P2)
P2  R1–R3, U1, U2: stream positions (engine, wire, renderer)        needs: P0
P3  acceptance/run_all.sh at the working tree, status               needs: P1, P2
P4  R8–R13, U3–U4: search mode, history ends, logo screen          needs: user approval of R8–R13
```

## Phase P0: baseline

**Goal.** *Today* and *Cost* in `baseline.md` from the committed tree.
**Covers.** `baseline.md`.
**Steps.** The `git show HEAD:… | grep` lines quoted in `baseline.md`.
**Acceptance.** Every *Today*/*Cost* cell has its command; `acceptance/run_all.sh --needs` exits 0 on `zr`.

## Phase P1: the user's smaller fixes (R4–R7)

**Goal.** A template row shows a stamp left of any pin; a buffer-match row splits hidden history
matches out of its count; the font buttons read "+ A" / "- A" with a serif A.
**Covers.** R4, R5, R6, R7.
**Code map.** `renderer/app.js::buildSessionRow` (marks: template first, then pin; `matchCountText`),
`::takeSessionBufferAnswer` (keeps `answer.hidden`), `::renderSessionBufferSection`;
`engine/index.js::searchBuffer` (`hidden`: the normal buffer's matches while the alternate screen
is shown); `renderer/index.html` (`#fontSizeIncrease/Decrease` spans `.font-size-a`, its CSS);
`renderer/app.js` `setButtonLabel(…, 'A')`. Tests: `test/buffer-search.test.js`.
**Acceptance.** `acceptance/R4_template_mark.sh`, `R5_hidden_matches.sh`, `R6_font_labels.sh` exit 0.
**Gotchas.** `setButtonLabel` rewrites the span's text on every toolbar update: change the label there too.

## Phase P2: stream positions (R1–R3, U1, U2)

**Goal.** Design A (`design.md`): `end` on `session:data`, `through` on frames, the renderer places
every chunk by position, resyncs on a gap, and behaves as before without positions.
**Covers.** R1, R2, R3, U1, U2; A-1…A-4.
**Code map.** `engine/index.js::_recordLiveData` (`end`), `::_sessionState`/`::_liveFrame` (snapshot
last, pending tail, `through`, `position`, `frame: false`), `::openSession` remote branch and
`::applyRemoteData` (`bytesSeen`, `mirrorBytes`); `engine/rpc/schema.js::EventData` (`end` last,
optional on decode); `engine/worker.js`, `engine/client.js::_onEventData`;
`electron/session-data-batcher.js` (last `end`); `renderer/live-stream.js` (new);
`renderer/app.js`: the `session:data` handler, `takeLiveChunk`, `renderLiveFrame` (drain, then
paint), `releaseLiveStream`, `resyncLiveStream`, `checkLiveTail`, `selectSession`,
`session:restored`, `clearCaches`, debug commands `live-stream-state`, `live-drop-next`, `live-seam`.
Tests: `test/live-stream.test.js`, `test/stream-positions.test.js`, `test/rpc-schema.test.js`,
`test/session-data-batcher.test.js`.
**Acceptance.** `acceptance/R1_switch_exact.sh`, `R2_repaint_exact.sh`, `R3_joined_exact.sh`,
`U1_gap_resync.sh`, `U2_old_peer.sh` exit 0; `npm test` has no new failure.
**Gotchas.** `renderLiveFrame` now paints asynchronously (after xterm drains); a caller that reads
the terminal right after it must wait. `ZBTERM_NO_STREAM_POS` is read once when the engine loads.

## Phase P3: the kit

**Goal.** `acceptance/run_all.sh` green on `zr`; a verifier in a fresh context writes the report.
**Covers.** all rows. **Acceptance.** the report, one verdict per row.

## Do not

Never lower a tolerance, weaken an assertion or re-bless a count to get green. No change to the share
backends' wire formats. No new dependency.

## Phase P4: search mode, history ends, logo screen

**Goal.** R8–R13 and U3–U4 as in `design.md` (section *R8–R13*), renderer only.
**Covers.** `renderer/index.html`, `renderer/app.js`, the debug commands `search-mode` and `logo-text`,
README's UI text where it names the toolbar or the search box.
**Steps.** Search mode (`syncSearchMode`, placeholder, icon swap, native cancel hidden); arrows
(`moveSearchSelection`, green 2 px border); `#jumpStart`/`#jumpEnd` with `jumpTo`, the Live classes and
the shared beacon phase; the logo lines. Then the four kit scripts `R8_search_mode.sh`,
`R10_search_arrows.sh`, `R11_history_ends.sh`, `R13_logo_text.sh` in `acceptance/run_all.sh`.
**Acceptance.** The whole kit green on `zr` against a fresh scratch package; lint 0 errors.
