// "Change Directory": where the local shell starts, or a `cd` once commands
// have already run. Local only: on another machine (after SSH, say) that
// scope's own directory plugin takes over. Inside a same-machine wrapper the
// directory is the wrapper's `scope.cwd` (launch-core.js LaunchScope).
;(() => {
  const node = typeof module === 'object' && module && module.exports
  const launch = node ? require('./launch-core.js') : window.zbtermLaunch

  class ChangeDirectory extends launch.LaunchPlugin {
    static id = 'cd'
    static title = 'Change Directory'
    static icon = 'fa-folder-open'

    static isAvailable(ctx) {
      return ctx.scope.machine.kind === 'local'
    }

    static defaults() {
      return { path: '~/' }
    }

    getUI(ui) {
      const input = ui.input({
        name: 'cwd',
        placeholder: '~/',
        value: this.config.path,
        onInput: (value) => {
          this.config.path = value.trim()
        }
      })
      const browse = ui.iconButton({
        icon: 'fa-folder-open',
        title: 'Browse',
        onClick: async () => {
          const chosen = await ui.chooseDirectory(input.value)
          if (chosen) ui.setValue(input, chosen)
          input.focus()
        }
      })
      return ui.row(input, browse)
    }

    validate(ctx) {
      if (ctx.unquotable(this.config.path)) return 'On Windows a directory cannot contain " or %'
      return ''
    }

    apply(ctx) {
      const scope = ctx.scope
      const path = this.config.path
      if (!path) {
        scope.interactive = true
        return
      }
      if (scope.commands.length) {
        // Commands ran already: this is a `cd` between them.
        const cd = scope.shell === 'cmd' ? 'cd /d' : 'cd'
        scope.add(`${cd} ${ctx.quotePath(path)}`)
      } else if (!/^([~\\/]|[A-Za-z]:)/.test(path)) {
        // A relative path: under the directory before it, or under home (the
        // shell would otherwise start relative to wherever the app did).
        scope.cwd = `${(scope.cwd || '~').replace(/[\\/]+$/, '')}/${path}`
      } else {
        // The PTY host starts the shell here (and falls back to the home
        // directory when it is gone).
        scope.cwd = path
      }
      scope.interactive = true
    }
  }

  launch.register(ChangeDirectory)
  if (node) module.exports = ChangeDirectory
})()
