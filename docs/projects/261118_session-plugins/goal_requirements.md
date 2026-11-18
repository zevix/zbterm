# Session composition plugins — goal and requirements (the WHAT)

**Project:** `261118_session-plugins` · **Area:** `renderer/plugins/`, `renderer/app.js`, `electron/`, `engine/index.js` · **Written:** 2026-11-18 · **Notes:** `notes--context.md`

## Goal

Replace the session dialog's two fixed fields, "Home Directory" and "Command", with a chain of
steps, each one a plugin, so a session's launch can be composed (and later extended with new
plugins) instead of typed as one command line. Checked on a scratch packaged app under `uisolate`
against a throwaway local `sshd`. Reference program: `acceptance/R1_launch_steps.sh`.

## Requirements

| id | hard/soft | the system shall … | check |
|---|---|---|---|
| R1 | hard | show, in the New/Copy/Edit/template dialogs, a list of launch steps in place of "Home Directory" and "Command"; a new session starts with two steps, "Change Directory" (`~/`) and "Shell Command" (empty: the default shell) | `acceptance/R1_launch_steps.sh` |
| R2 | hard | give every step a delete button and the list a "+ Add" button that opens a menu of the plugins available after the last step | `acceptance/R1_launch_steps.sh` |
| R3 | hard | let the user add steps, edit any step in place, and delete the last step; a step that is not last may be deleted only when every later step stays allowed and keeps running in the same place (so SSH cannot be deleted from under its remote steps) | `acceptance/R1_launch_steps.sh`, `test/launch-plugins.test.js` |
| R4 | hard | implement each plugin as one class in its own JS file with known functions: is it available (`static isAvailable(ctx)`), its UI (`getUI(ui)`), its settings as JSON (`getConfig()`), and taking them back (`setConfig(config)`) | `test/launch-plugins.test.js` |
| R5 | hard | let steps know about each other through a shared launch context, not by naming each other: after "SSH", "Change Remote Directory" (a sub-step of SSH, with remote browsing) is offered and the local "Change Directory" is not | `acceptance/R1_launch_steps.sh` |
| R6 | hard | ship three plugins the user named — "Change Directory", "Shell Command", "SSH" — and "Change Remote Directory" | `acceptance/R1_launch_steps.sh` |
| R7 | hard | refuse to close the dialog on a step that cannot run (SSH with no host), saying why | `acceptance/R1_launch_steps.sh` |
| R8 | hard | keep a session's steps with it (catalog field `steps`), show them again in its Edit dialog, in copies and in templates; a session saved before plugins opens as its two equivalent steps and launches exactly as before | `acceptance/R1_launch_steps.sh`, `test/engine-extend.test.js` |

## Unwanted

| id | the system shall not … | check |
|---|---|---|
| U1 | change the PTY spawn contract or anything below the dialog: a chain compiles to the `cwd` + `command` pair the host already takes | `test/launch-plugins.test.js` (compile), `test/engine-extend.test.js` (spawn) |
| U2 | let a path, host, port or identity file break out of its argument in the compiled command, or let the renderer run anything in the main process but a function a plugin declared | `test/launch-plugins.test.js` |
| U3 | show steps that are not what the session launches (stale steps after `cwd`/`command` were changed by something that does not know plugins) | `acceptance/R1_launch_steps.sh`, both unit tests |
