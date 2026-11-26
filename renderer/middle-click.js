// The terminal's middle click: a paste, or a click the program is told about,
// never both. Real xterm's rule: while the program has mouse tracking on, a
// middle click is reported to it and nothing is pasted; Shift+middle click
// pastes, and is not reported (xterm.js lets Shift force selection).
//
// Two pastes can follow a middle click:
// - native (Linux): Chromium pastes the PRIMARY selection on the middle
//   button's mouseup, into the focused element - xterm.js's textarea, whose
//   `paste` listener sends the text to the program through onData. Chromium
//   skips that paste when the mouseup is default-prevented
//   (EventHandler::HandleMouseReleaseEvent only runs the release default
//   action - SelectionController's HandlePasteGlobalSelection - for an
//   unhandled mouseup);
// - the clipboard, pasted by the app on `auxclick` where there is no native
//   middle-click paste (macOS).
// xterm.js reports the press from its own `mousedown` listener when mouse
// events are active and the selection is not forced
// (CoreBrowserTerminal.bindMouse), and the release from a document `mouseup`
// listener. Neither checks defaultPrevented, so cancelling the mouseup still
// reports it.
//
// createMiddleClick({ getTerm, nativePaste, pasteClipboard }) → handlers:
//   mousedown(event)  on the terminal's container, in the capture phase (before
//                     xterm's own): notes whether xterm will report this press.
//   mouseup(event)    on the window, in the capture phase: cancels the native
//                     paste of a reported middle click.
//   auxclick(event)   on the terminal's container: pastes the clipboard for an
//                     unreported middle click when there is no native paste.
//   reported(event)   whether xterm reports this middle press to the program.
;(() => {
  function middleClickReported(term, event) {
    if (!term || !event || event.button !== 1) return false
    const mode = term.modes && term.modes.mouseTrackingMode
    if (!mode || mode === 'none') return false
    // The same test xterm.js makes in its mousedown listener (renderer/app.js
    // may have widened it, for paused playback).
    const selection = term._core && term._core._selectionService
    const forced =
      selection && typeof selection.shouldForceSelection === 'function'
        ? selection.shouldForceSelection(event)
        : !!event.shiftKey
    return !forced
  }

  function createMiddleClick({ getTerm, nativePaste, pasteClipboard }) {
    // Set at the middle press, read at its release and its auxclick.
    let pressReported = false
    let releaseReported = false
    return {
      reported: (event) => middleClickReported(getTerm(), event),
      mousedown(event) {
        if (event.button !== 1) return
        pressReported = middleClickReported(getTerm(), event)
      },
      mouseup(event) {
        if (event.button !== 1) return
        releaseReported = pressReported
        pressReported = false
        if (releaseReported && nativePaste) event.preventDefault()
      },
      auxclick(event) {
        if (event.button !== 1) return
        const reported = releaseReported
        releaseReported = false
        if (reported || nativePaste) return
        event.preventDefault()
        return pasteClipboard()
      }
    }
  }

  const api = { createMiddleClick, middleClickReported }
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api
  }
  if (typeof window === 'object' && window) {
    window.zbtermMiddleClick = api
  }
})()
