// A sample ZBTerm command plugin: activate a Python virtual environment, then
// go on to the next step or a shell. Offered only on this machine (not after
// SSH): it reads ctx.scope.machine.kind, as ZBTerm's own "Change Directory" does.
// See sample_custom_command.js for the shape of a plugin.
;(() => {
  const launch = window.zbtermLaunch

  class PythonVenv extends launch.LaunchPlugin {
    static id = 'sample-python-venv'
    static title = 'Python venv'
    static icon = 'fa-flask'

    static isAvailable(ctx) {
      return ctx.scope.machine.kind === 'local' && ctx.platform !== 'win32'
    }

    static defaults() {
      return { venv: '.venv' }
    }

    getUI(ui) {
      return ui.input({
        name: 'venv',
        placeholder: 'the venv directory, e.g. ~/venvs/{{slug}}',
        value: this.config.venv,
        onInput: (value) => {
          this.config.venv = value.trim()
        }
      })
    }

    validate() {
      return this.config.venv ? '' : 'Name the venv directory'
    }

    apply(ctx) {
      ctx.scope.add(`. ${ctx.quotePath(this.config.venv.replace(/\/+$/, '') + '/bin/activate')}`)
      ctx.scope.interactive = true
    }
  }

  launch.register(PythonVenv)
})()
