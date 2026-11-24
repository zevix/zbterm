// A sample ZBTerm command plugin: attach to a tmux session named after the
// profile, creating it the first time. See sample_custom_command.js for the
// shape of a plugin; tick it in "+ Add" > "Plugins…" to offer it.
;(() => {
  const launch = window.zbtermLaunch

  class TmuxSession extends launch.LaunchPlugin {
    static id = 'sample-tmux-session'
    static title = 'tmux session'
    static icon = 'fa-table-columns'

    static defaults() {
      return { session: '{{slug}}' }
    }

    getUI(ui) {
      return ui.input({
        name: 'session',
        placeholder: 'tmux session name',
        value: this.config.session,
        onInput: (value) => {
          this.config.session = value.trim()
        }
      })
    }

    validate() {
      return this.config.session ? '' : 'Name the tmux session'
    }

    // run() is a command line used as typed, which keeps the terminal: the
    // session ends when tmux does.
    apply(ctx) {
      ctx.scope.run(`tmux new-session -A -s ${ctx.quote(this.config.session)}`)
    }
  }

  launch.register(TmuxSession)
})()
