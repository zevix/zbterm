# UI chrome and collapsible side pane — design (one page)

**Serves:** `goal_requirements.md` R1–R6, U1–U2
**Written:** 2026-11-10
**Reviewed:** 2026-11-10, Sonnet 5.5, fresh context, on the combined draft before the split. Its 15 rows are answered here and in `../261110_session-templates/design.md`.
**Approved:** see end.

## Interface

- **Settings menu** (`renderer/app.js::settingsMenuItems`, `renderSettingsMenu`). The items gain a `kind`: `check`, `field`, `separator` or `info`. Order:
  1. today's items;
  2. the sibling project's template section;
  3. Identity (with dot) and Theme, only while collapsed;
  4. separator;
  5. `info` "ZBTerm <version>" (disabled; last).
- **Bubble** (`#scrubberTip`, `scrubberTipTextForTs`): `formatWallClock(tsMs, nowMs)`, a pure function. The result is `<clock> · <elapsed>`, e.g. `14:32:05 · 0:42`, or `14:32:05 · 0:42 (1:05)` with collapsed gaps.
- **Pane.**
  - `toggleSidePane()`: from `#brandMark` click and Ctrl+Shift+B.
  - `applySidePane(collapsed)`: sets `.app.side-collapsed`, moves the nodes, refits the terminal.
  - The logo's `title`: "Hide side pane (Ctrl+Shift+B)" or "Show side pane (Ctrl+Shift+B)".
  - On `:hover` and `:focus-visible` the logo image is swapped for `fa-bars` (CSS only).
- **Hotkey.** Ctrl+Shift+B is matched as `ctrlKey && shiftKey && !altKey && !metaKey && key.toLowerCase() === 'b'` (layout-aware, Caps-Lock-proof, like the existing Ctrl+R).
  - It is handled in the existing capture `keydown` on `document`.
  - Also in `term.attachCustomKeyEventHandler`, returning `false`, so xterm never encodes it, whichever listener runs first.
  - It is ignored, and not swallowed, while a modal overlay is open (`.modal-overlay`, `.session-editor-overlay`, the identity wizard).
- **Identity dot.** `applyIdentity` sets `data-identity="set|unset"` on `#identitySetup`, on the menu's Identity item and, while collapsed, on `#settingsToggle`. CSS draws an 8px dot: `--ok` green or `--warn` orange.
- **Colours.** `#newSession .btn-icon { color: var(--new-green) }` and `#joinLink .btn-icon { color: var(--join-blue) }`, with tokens for both themes.
- **Debug commands** (`window.__zbtermDebugCommand`; also used by the sibling's kit):
  - `ui-state` returns:
    - `sideCollapsed`;
    - `topbarLeft`: the ids, in order;
    - `menu`: kind and label per item;
    - `identityDot`;
    - `colors`: computed icon colours;
    - `bubble`: text and hidden flag;
    - `modal`: the open overlay's id and fields;
    - `titleBox`: the rect of `.topbar-title` and of `.main`.
  - `bubble-format` (`{ tsMs, nowMs }`) returns `formatWallClock`.
  - `click` (`{ selector, shift }`), `settings-open`, `settings-click` (`{ label }`).

## Data and state

- **Pane state.** `zbterm.sideCollapsed` app preference (`persistAppPreference`: localStorage plus the engine). It is read from localStorage synchronously, before the first paint of `.app`, so a collapsed start never shows the buttons jumping.
- **Collapsed DOM.** A new `<div class="topbar-brand">` at the start of `.topbar`. `applySidePane` *moves* these nodes into it, and back to their old parents on expand:
  - `.brand-mark`, `.brand-name`;
  - `#newSession`, `#joinLink`;
  - `#settingsToggle`.

  Moving keeps a single listener set. `.topbar-brand` has `background: var(--sidebar-bg)`, and its buttons have `width: auto`. `.topbar-title` gets `flex: 1`.
- **Before a move.** `applySidePane` closes the settings and session menus. Anchored popovers re-place themselves (`anchorPanel` observes resize).
- **Narrow windows.** Below the 780px media query, the single-column layout stacks the sidebar above `.main`; collapsed hides the stacked sidebar the same way. The `.topbar-brand` wraps to its own row when the top bar's container query (760px) says there is no room.

## Refuses

- Ctrl+Shift+B, or a logo click, while a modal is open: no action, and the key is passed on (U2).

## The reference program, step by step

`acceptance/run_all.sh` → each script:
1. `lib.sh::start_app`: `uisolate run --name zbui-<id> -- "$ZBUI_APP" --storage "$ZBUI_STORAGE" --debug-server --debug-server-port <free>`, with `HOME=$ZBUI_HOME TMPDIR=$ZBUI_TMP`. It waits for `/health`, then answers `profile-picker` with `create-and-select`.
2. The script drives the app:
   - `cmd` → `POST /renderer/command`;
   - real keys: `uisolate run --name zbui-<id> -- xdotool key ctrl+shift+b`;
   - window size: `POST /window/bounds`.
3. It asserts with `jq -e` on `ui-state`. For U1, the shell runs `od -c`, and the script checks the screen rows from `GET /renderer/terminal-display` for the absence of `002`.
4. `stop_app`: `uisolate stop zbui-<id>`, its own session only.

## Failure scenarios

The reviewer's rows that concern this project (numbering from the combined review; the rest are answered in the sibling design):

| # | scenario | at risk | design answer |
|---|---|---|---|
| 8 | Ctrl+Shift+B while a dialog, an input or playback has focus | U1, R4 | Ignored and not swallowed while a modal is open; acts otherwise (*Hotkey*). `U2_narrow_and_modal.sh` presses it with a dialog open. |
| 9 | Caps Lock or layout; xterm handling the key before the document | U1, R4 | `key.toLowerCase()` with exact modifiers, plus `attachCustomKeyEventHandler`. U1 uses real `xdotool` keys and reads `od -c` output. |
| 10 | Window under 780px or zoomed: single-column layout | R4, R5 | Collapsed hides the stacked sidebar too; the brand cluster wraps (*Data and state*). `U2_narrow_and_modal.sh` runs at 700x600; R5 at 1280x800. |
| 11 | Buttons moved while a menu or popover is anchored; collapsed state on first paint | R5 | Menus are closed before a move; popovers re-place; the state is read synchronously before first paint. R5 restarts collapsed and checks `topbarLeft` on the first `ui-state`. |
| 12 | Clock for a joined session, DST, midnight, future timestamps | R2 | `tsMs` is epoch ms, so the instant is absolute and is shown in the viewer's zone. Days are compared by local calendar date, not 24h steps. A future timestamp gets the full date. The R2 check runs `bubble-format` under `TZ=Europe/Berlin` across 2026-10-25 and midnight. |
| 15 | Synthetic events cannot prove the key never reaches the PTY | U1, R4 | Hotkey checks use `xdotool` on the private display, and the shell's `od -c` shows what arrived. |

## Questions and assumptions

- **Q-2**, answered 2026-11-10: the clock goes in the bubble.
  - Today: `14:32:05`.
  - This week: `Thu 14:32:05`.
  - Otherwise: `2026-11-10 14:32:05`.
- **Q-3**, answered 2026-11-10: the hotkey is Ctrl+Shift+B.
- **A-1** "This week" means the previous six local calendar days, so there are never two days with one name.
- **A-2** The bubble keeps today's visibility rules: it shows only during playback and hover.
- **A-6** The collapsed state persists across restarts, app-wide (not per profile).
- **A-7** While collapsed, the settings button also carries the identity dot.

## Decisions

None hard to reverse.

## Approval

Approved 2026-11-11 by the user ("approved" in chat, covering all three projects), file at sha256 a51503384a3b (the file as approved, before this line).
