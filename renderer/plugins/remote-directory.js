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

  class RemoteDirectory extends launch.LaunchPlugin {
    static id = 'ssh-cd'
    static title = 'Change Remote Directory'
    static icon = 'fa-folder-tree'

    static isAvailable(ctx) {
      return ctx.scope.kind === 'ssh'
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
      return ui.stack(ui.row(input, browse), browser)
    }

    // Shows `path` on the remote machine inside `browser`: its sub-directories
    // to step into, and a button that takes the directory shown.
    async _browse(ui, input, browser, path) {
      // Read when asked, not when the step was drawn: the SSH step may have
      // been edited since.
      const ctx = ui.context()
      const target = ctx.scope.data.target
      const sshError = ctx.scope.owner.validate(ctx)
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
      const entry = (label, target, icon) => {
        const item = ui.button({
          text: label,
          icon,
          className: 'launch-remote-entry',
          onClick: () => this._browse(ui, input, browser, target)
        })
        item.dataset.path = target
        return item
      }
      if (listing.path !== '/') list.append(entry('..', parentPath(listing.path), 'fa-turn-up'))
      for (const name of listing.directories) {
        list.append(entry(name, childPath(listing.path, name), 'fa-folder'))
      }
      if (!listing.directories.length) {
        list.append(ui.el('div', 'launch-remote-status', 'No sub-directories'))
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

  RemoteDirectory._test = { parentPath, childPath }

  launch.register(RemoteDirectory)
  if (node) module.exports = RemoteDirectory
})()
