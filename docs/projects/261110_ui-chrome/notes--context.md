# UI chrome and collapsible side pane — notes and context

Companion to `goal_requirements.md`: the user's words, the history and the detail behind each
row, so the goal page stays one screen. Not a spec; nothing here is approved or built from.

## The user's words

**2026-11-10, the request** (pasted list; asked to plan it as a project by `/ubitron/dev/docs/templates/howto.md`):

> Move version to the bottom of the settings menu
> Show real date/time above timeline
> New / copy session add checkbox for "record session" default to yes
> New session add option for "set default for all new sessions" + confirmation
> Make "+" of new green and "->]" of join blue, turn the ZBTerm icon into hamburger menu when hovered for toggling the left pane, choose hotkey and show in tooltip
>     When left pane is collapsed:
>         move identity and theme buttons into the settings menu
>         Left of the top bar should be, with same color of the left bar:
>             ZBTerm logo, "ZBTerm"
>             New, Join  buttons with text, minimal width
>             settings button
>         Then the box that is currently above and same width of the terminal, will consume the remaining space
> Add orange or green dot marker on the identity icon to mark identified or not

**2026-11-10, answers to the first questions** (question in brackets, then the answer verbatim):

- [What is an unrecorded session?] Chose "Live only, no sharing": nothing is written to the log, no playback or history, sharing disabled, a new engine mode.
- [Where does the wall-clock time go?] "1 but 14:32:05 for today, "Thu 14:32:05" for this week, your suggestion otherwise" (option 1: in the scrubber bubble, next to the elapsed time; the suggestion was "2026-11-10 14:32:05").
- [Pane hotkey?] "Ctrl+Shift+B".
- [Default for new sessions?] "3 and lets make it more explicit. Add expandable "Advanced" on the bottom of the dialog, with "Set this profile as default for a new sessions when:" and below it a dropdown with:
  - The "+ New" button is clicked
  - CTRL+SHIFT+T is pressed
  - The "+ New" button is clicked while holding "Shift"

  Note the language - we are now pointing to a specific profile as the template for a scenario, and if the template profile is changed, we need to create accprding to that. Additionally, if the profile is deleted, we need to save an ivisible copy as the template until a profile is created, and it will become the new replacement template profile"

**2026-11-10, answers to the second questions:**

- [One profile, several triggers?] "No, single choice".
- [What does each trigger do?] "Another checkbox - "Skip new/edit profile dialog and open directly"
  And - add a section (separator above and below) in the settings menu with:
  - Edit new profile defaults
  - Edit new profile defaults for CTRL+SHIFT+t
  - Edit new profile defaults for Shift + "+ New" button

  And make the code generic enough so we can easily add later other combinations like CTRL+SHIFT+"+ New"
- [Who replaces a deleted template?] "1 but be explicit:
  - when deleting a template ask warn that this is the template for ... and it will be restored with that name next time you ...
  - if the user tries to create a profile with same name as deleted template, promt and warn it will override
  - future - we will allow searching for "archived" sessions" (option 1: the next session that trigger creates becomes its template)
- [Which fields does a template carry?] "Everything, including if it opens for editing and share settings (and later delete history after ...)"

## Context

- The repo had no `docs/projects/` before; `AGENTS.md` points at `docs/projects/README.md`, which does not exist yet and is left alone. These are the first projects here (2026-11-10).
- Planned on branch `ui-chrome` (worktree `.claude/worktrees/ui-chrome`) from `main` at 8173c60. The main checkout holds unrelated uncommitted release work (`baseline.md` *Working tree*).
- **Split 2026-11-10.** The request was planned as one project. Its goal page came to 572 words (`sed -n '/^## Goal/,/^## Approval/p' goal_requirements.md | wc -w`), over the 400-word cap, so it was split. This project is the window frame; `../261110_session-templates/` holds the dialog, recording and template items. The user's words for both are kept here.
- The design review (Sonnet, fresh context) ran on the combined draft. Its rows are answered in each project's `design.md`.

## Requirement notes

- **R1** The version is the last item, below a separator, and is not clickable. The brand bar loses `#version` (`renderer/index.html`).
- **R2** Formats, in local time:
  - the same calendar day: `14:32:05`;
  - the previous six calendar days: `Thu 14:32:05`;
  - older, or in the future: `2026-11-10 14:32:05`.

  The elapsed time stays: `14:32:05 · 0:42`, and with collapsed gaps `14:32:05 · 0:42 (1:05)`.
- **R3** Only the icons change; the button text keeps its colour. "->]" in the user's words is the `fa-right-to-bracket` icon.
- **R4** Tooltip: "Hide side pane (Ctrl+Shift+B)" or "Show side pane (Ctrl+Shift+B)". The hamburger is `fa-bars`. The state survives a restart (A-6).
- **R5** "the box that is currently above and same width of the terminal" is `.topbar-title`, which holds the session title and meta. Expanding the pane puts every moved node back.
- **R6** Green means `identity.self` returns `configured: true`. Orange means `configured: false` (the unknown provider). While collapsed, the dot is also on the Identity menu item and the settings button (A-7).
- **U1** Without the change, Ctrl+Shift+B reaches the shell as `^B` (`\002`).
- **U2** The narrow layout is the `@media (max-width: 780px)` block in `renderer/index.html`.

## Soft changes

None.

## Superseded text

None.
