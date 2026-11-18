// "Shell Command": a command line run by the shell of whatever scope the step
// is in: the local shell, or the remote one after SSH. Left empty it stands
// for that scope's interactive shell.
;(() => {
  const node = typeof module === 'object' && module && module.exports
  const launch = node ? require('./launch-core.js') : window.zbtermLaunch

  class ShellCommand extends launch.LaunchPlugin {
    static id = 'shell'
    static title = 'Shell Command'
    static icon = 'fa-terminal'

    static defaults() {
      return { command: '' }
    }

    getUI(ui) {
      const remote = ui.context().scope.kind !== 'local'
      return ui.input({
        name: 'command',
        placeholder: remote ? 'remote login shell' : 'default shell',
        value: this.config.command,
        onInput: (value) => {
          this.config.command = value.trim()
        }
      })
    }

    validate(ctx) {
      // A remote command travels inside one quoted argument of the local ssh.
      if (ctx.depth > 1 && ctx.unquotable(this.config.command)) {
        return 'On Windows a remote command cannot contain " or %'
      }
      return ''
    }

    apply(ctx) {
      if (this.config.command) ctx.scope.run(this.config.command)
      else ctx.scope.interactive = true
    }
  }

  launch.register(ShellCommand)
  if (node) module.exports = ShellCommand
})()
