# Improvements and fixes — notes and context

## The user's words

Verbatim, 2026-11-21:

> Please start a new project of improvements and fixes and add this as the first point.

"This" is the suggestion that closed the investigation below: a confirmation before a window with
live sessions closes.

## R1: the window that closed before the lid (2026-11-20)

A `--scratch` run (pid 894503, up 31.6 h) quit cleanly with exit code 0. Its exit log:
`window:last-window-close` at 23:48:09.3 local, `source: "external"` (no in-app quit path had
stamped `firstExitTrigger`), `lastQuitKey` Ctrl+W 122 s earlier, so not that key. The system
journal (`sudo journalctl`) shows `systemd-logind: Lid closed.` at 23:48:14.63 and the suspend
right after, and nothing at 23:48:09: the close came from the desktop (KWin) 5 s before the lid,
not from the lid or suspend. Most likely an accidental title-bar close, Alt+F4 (KWin takes it
before the app sees it) or a taskbar "Close". `engine.close()` then timed out after 10 s because
the system was suspending mid-shutdown; the process finished at resume, 23:55:57.

Proposal, not yet approved:

- On a `close` event with `source: "external"` while any session in the window is live, prevent
  the close and show "Close ZBTerm? N sessions are still running." with **Close** and **Cancel**
  (Cancel focused).
- No prompt when the quit came from the app (`firstExitTrigger` set), when no session is live, or
  when Electron reports a session end (logout/shutdown: `app` `before-quit` from the system).
- Open: whether a "Don't ask again" setting is wanted.

## The user's words (2026-11-21, second list)

Verbatim:

> please add to the project:
> - in search results in the "Session name matches" section, hilight in cyan the match in the session name
> - if search is active, even if the terminal is in focus, Esc should cancel the search
> - Move the N/M from the right side of the (x) icon in the search box to be in the status text, and add "(In terminal Enter/
> Shift+Enter, in profiles ⬆️/⬇️ )"
> - with the settings menu options "Edit new profile ...":
>   - add  the stamp icon on the options left
>   - When selecting open the dialog with "Advanced open" like with F2
> - add appropriate icons for the "STUN..." and "ZBTerm Relay..." options
> - There is a strange bug with the profile editor when browsing a remote directory - filtering and shortening the list may m
> ake the whole dialog jump up on the screen ~ its height - WTF???
> - Rename "Extend" to "Resume"
> - Change the right-click menu of a profile to be: (all with icons)
>   - Clone (immidiate)
>   - Create a copy, edit first
>   ------
>   - Edit
>   - Remove HD
>   - Delete History
>   - Delete
>   ------
>   - Share Session
>   - Share Keyboard                              [or unshare if shared]
>   - Enable HD (save and share more updates)     [or "Disable ...]
>   ------
>   - Resume
>
> then update the tests as required, complete the project reqs and design by @/zp/zdata/work/ubitron/dev/docs/templates/howto.md
>
> Please take over - I'm going to sleep, hope to see the release ready version in the morning!
> (hint - dont stop for questions, you have all the info, and if really stuck ask a fable a short question)

## The user's words (2026-11-21, after the morning report, R14–R16)

> very good work!
> A few more things please:
> - make the search status bar text  "M/N"  of search  "M / N" bold and cyan M, normal / and non-bold and cyan N
> - Add near the (x) icon two small toggles with hover info for whole word and case sensitive search
> - When starting the app can you make the profiles list show earlier and/or show "loading profiles" ?

## Requirement notes (R14–R16)

- **R14.** Read as: M bold + cyan, " / " in the line's own style, N cyan at normal weight.
- **R15.** "Aa" (Match case) and an underlined "ab" (Match whole word), the match cyan when on, at the
  box's right just left of the x; mousedown is cancelled so a click keeps the box's focus. One matcher
  everywhere: `engine/buffer-search.js` gains `caseSensitive`/`wholeWord` and `findInText`; the
  catalog's name filter, `session.searchBuffer`, the renderer's in-session scan and highlights, and the
  name marks all take them (additive args, dated in `docs/CORE-CONTRACT.md`). Whole word: no letter,
  digit or `_` touching the match, checked at each end of the query that is itself a word character.
  Stored install-wide (`zbterm.searchCaseSensitive`, `zbterm.searchWholeWord`), like the theme.
- **R16.** Measured on zr (packaged, 8 profiles, launch → first list answer, from the app log): about
  1.15 s before, 1.12 s after. The engine (~0.3 s to boot) now starts while the page loads
  (`electron/main.js`, before `loadAppWindow`, not after), and the list is read alongside the share
  backends and the peer records instead of after them, which matters most where those are slow (a
  Freenet probe). The engine's own boot is the floor here; a cached list drawn before the engine
  answers was not built (stale rows that could be clicked before the engine is up). Until the first
  list the list shows a spinner and "Loading profiles…", never "No sessions yet".

## Requirement notes (R2–R13)

- **R2.** The engine's name filter is a case-insensitive substring (`engine/catalog.js::list`);
  every occurrence in the name is marked, in the theme's `--match-cyan` (the buffer-match cyan).
- **R3.** "Active" = the box holds text (`searchIsOn`). Esc then ends the search exactly as the
  box's own Esc and the blue x do (`clearSearch`), and is not passed to the shell. With a menu or
  dialog open, Esc keeps closing that first.
- **R4.** Status text while the in-session search has a query: `N/M (In terminal Enter/Shift+Enter,
  in profiles ⬆️/⬇️ )`; 0/0 with no match. The `#searchCount` element stays, always hidden, so older
  kits that read it find it empty.
- **R6.** F2 opens Advanced when the profile is a template (`editSessionProfile`); a trigger's
  template always has its trigger chosen, so the settings item opens it the same way.
- **R7.** Icons: STUN/TURN `fa-tower-broadcast`, relay `fa-server`.
- **R8.** Cause: `anchorPanel`'s `place()` runs on every panel resize and chooses below/above the
  anchor afresh, so a list that shrinks flips the dialog between the two places (a jump of about its
  height). Fix: after the first placement only the window edge moves it.
- **R10/R12 labels.** "Unshare Session", "Unshare Keyboard", "Disable HD (save and share fewer
  updates)". Remove HD moves to `fa-eraser` so it does not share the rocket with Enable HD.
- **R12 Unshare.** There is no "stop sharing" in the engine. Unshare revokes every live invite link
  (`share.revokeLink`, which disconnects that link's viewers and rotates keys); `share.status` gains
  `liveLinks` (the count of unrevoked links) so the label knows when nothing is shared any more.
- **R13.** Version 1.9.2 (already bumped with R1). No publish, no tag.

## Soft changes

- 2026-11-21 R12: the user's `[or "Disable ...]` → "Disable HD (save and share fewer updates)":
  the literal tail "more updates" would say the opposite of what disabling does.
