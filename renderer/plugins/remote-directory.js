// "Change Remote Directory": a sub-step of SSH. It exists only inside an `ssh`
// scope, and browses the remote machine through the SSH step that opened it
// (`ctx.scope.data.target`), whatever that step is set to at the moment.
;(() => {
  const node = typeof module === 'object' && module && module.exports
  const launch = node ? require('./launch-core.js') : window.zbtermLaunch

  function parentPath(path) {
    const trimmed = String(path).replace(/\/+$/, '')
    const cut = trimmed.lastIndexOf('/')
    return cut <= 0 ? '/' : trimmed.slice(0, cut)
  }

  function childPath(path, name) {
    return `${String(path).replace(/\/+$/, '')}/${name}`
  }

  // What the field holds, read against the directory the browser shows:
  // the start of a name to keep in the list ('' keeps them all). Stepping
  // into a directory writes `<it>/` in the field, so typing after the slash
  // narrows that directory's names; anything else typed narrows by its last
  // part.
  function filterTerm(value, path) {
    const text = String(value || '').trim()
    const here = String(path || '')
    if (!text || text === '~' || text === here) return ''
    const prefix = here === '/' ? '/' : `${here.replace(/\/+$/, '')}/`
    if (text.startsWith(prefix)) {
      const rest = text.slice(prefix.length)
      return rest.includes('/') ? '' : rest
    }
    return text.slice(text.lastIndexOf('/') + 1)
  }

  function matches(name, term) {
    return !term || name.toLowerCase().includes(term.toLowerCase())
  }

  class RemoteDirectory extends launch.LaunchPlugin {
    static id = 'ssh-cd'
    static title = 'Change Remote Directory'
    static icon = 'fa-folder-tree'

    static isAvailable(ctx) {
      // Also inside a same-machine wrapper opened after SSH.
      return ctx.scope.machine.kind === 'ssh'
    }

    static defaults() {
      return { path: '' }
    }

    getUI(ui) {
      const input = ui.input({
        name: 'remote-cwd',
        placeholder: 'remote home directory',
        value: this.config.path,
        onInput: (value) => {
          this.config.path = value.trim()
        }
      })
      const browser = ui.el('div', 'launch-remote-browser')
      browser.hidden = true
      const browse = ui.iconButton({
        icon: 'fa-folder-open',
        title: 'Browse the remote machine',
        onClick: () => {
          if (!browser.hidden) {
            browser.hidden = true
            return
          }
          this._browse(ui, input, browser, input.value.trim())
        }
      })
      // Typing narrows the names the browser shows; Down walks into them.
      input.addEventListener('input', () => this._filter(input, browser))
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' || browser.hidden) return
        const first = browser.querySelector('.launch-remote-entry:not([hidden])')
        if (!first) return
        event.preventDefault()
        first.focus()
      })
      browser.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const entries = Array.from(browser.querySelectorAll('.launch-remote-entry:not([hidden])'))
        const at = entries.indexOf(ui.document.activeElement)
        if (at < 0) return
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        if (at + step < 0) input.focus()
        else entries[Math.min(entries.length - 1, at + step)].focus()
      })
      return ui.stack(ui.row(input, browse), browser)
    }

    // Shows only the directories whose names hold what the field narrows to
    // (`..` always stays).
    _filter(input, browser) {
      if (browser.hidden || browser.dataset.state !== 'ready') return
      const term = filterTerm(input.value, browser.dataset.path)
      let shown = 0
      for (const entry of browser.querySelectorAll('.launch-remote-entry[data-name]')) {
        entry.hidden = !matches(entry.dataset.name, term)
        if (!entry.hidden) shown++
      }
      const none = browser.querySelector('.launch-remote-nomatch')
      if (none) {
        none.hidden = shown > 0 || !term
        none.textContent = `No directory matches "${term}"`
      }
    }

    // Shows `path` on the remote machine inside `browser`: its sub-directories
    // to step into, and a button that takes the directory shown.
    async _browse(ui, input, browser, path) {
      // Read when asked, not when the step was drawn: the SSH step may have
      // been edited since.
      const ctx = ui.context()
      const target = ctx.scope.machine.data.target
      const sshError = ctx.scope.machine.owner.validate(ctx)
      // Whatever was asked before is out of date from here on.
      const request = (this._request = {})
      browser.hidden = false
      browser.dataset.state = 'loading'
      browser.replaceChildren(ui.el('div', 'launch-remote-status', sshError || 'Connecting...'))
      if (sshError) {
        browser.dataset.state = 'error'
        return
      }
      let listing
      try {
        listing = await ui.host('ssh', 'listDirectory', { ...target, path })
      } catch (err) {
        if (this._request !== request) return
        browser.dataset.state = 'error'
        const retry = ui.button({
          text: 'Remote home',
          onClick: () => this._browse(ui, input, browser, '')
        })
        browser.replaceChildren(
          ui.el('div', 'launch-remote-status launch-remote-error', err.message),
          ui.el('div', 'launch-remote-actions', null, [retry])
        )
        return
      }
      // A slower, older answer must not replace a newer one.
      if (this._request !== request) return
      browser.dataset.state = 'ready'
      browser.dataset.path = listing.path

      // U+200E: the box is right-to-left so a long path loses its start, not
      // its end; the mark keeps the path itself left-to-right.
      const here = ui.el('div', 'launch-remote-path', `\u200e${listing.path}`)
      here.title = listing.path
      const list = ui.el('div', 'launch-remote-list')
      // Stepping in writes the directory in the field, ending in `/`, so
      // what is typed next narrows its names.
      const entry = (label, target, icon) => {
        const item = ui.button({
          text: label,
          icon,
          className: 'launch-remote-entry',
          onClick: () => {
            ui.setValue(input, target === '/' ? '/' : `${target}/`)
            input.focus()
            return this._browse(ui, input, browser, target)
          }
        })
        item.dataset.path = target
        return item
      }
      if (listing.path !== '/') list.append(entry('..', parentPath(listing.path), 'fa-turn-up'))
      for (const name of listing.directories) {
        const item = entry(name, childPath(listing.path, name), 'fa-folder')
        item.dataset.name = name
        list.append(item)
      }
      if (!listing.directories.length) {
        list.append(ui.el('div', 'launch-remote-status', 'No sub-directories'))
      } else {
        const none = ui.el('div', 'launch-remote-status launch-remote-nomatch')
        none.hidden = true
        list.append(none)
      }
      const use = ui.button({
        text: 'Use this directory',
        className: 'mode-pause launch-remote-use',
        onClick: () => {
          ui.setValue(input, listing.path)
          browser.hidden = true
          input.focus()
        }
      })
      const close = ui.button({
        text: 'Close',
        onClick: () => {
          browser.hidden = true
        }
      })
      browser.replaceChildren(here, list, ui.el('div', 'launch-remote-actions', null, [use, close]))
      this._filter(input, browser)
    }

    validate(ctx) {
      if (ctx.unquotable(this.config.path)) return 'On Windows a directory cannot contain " or %'
      return ''
    }

    apply(ctx) {
      const scope = ctx.scope
      if (this.config.path) scope.add(`cd ${ctx.quotePath(this.config.path)}`)
      scope.interactive = true
    }
  }

  RemoteDirectory._test = { parentPath, childPath, filterTerm }

  launch.register(RemoteDirectory)
  if (node) module.exports = RemoteDirectory
})()
