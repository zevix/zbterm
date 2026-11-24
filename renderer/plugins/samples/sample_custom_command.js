// A sample ZBTerm command plugin. ZBTerm runs every .js file in this
// directory when it starts; commands.json says which of them the session
// dialog's "+ Add" menu offers (tick them in "+ Add" > "Plugins…").
//
// A plugin is a class that extends window.zbtermLaunch.LaunchPlugin, in the
// same shape as ZBTerm's own (renderer/plugins/ in its source):
//   static id        a stable name, stored with each profile that uses it
//   static title     the "+ Add" menu's and the step's label
//   static icon      a Font Awesome icon (https://fontawesome.com/icons)
//   static defaults  its settings and their starting values (all strings)
//   getUI(ui)        the step's controls, built with the dialog's toolkit
//   validate(ctx)    '' or why the step cannot run
//   apply(ctx)       what the step adds to the launch
//
// In any setting, {{name}} is the profile's name ("Work #2") and {{slug}}
// (or {{name_can}}) is that name as a slug ("work-2"). ZBTerm reads a new or
// changed file when the Plugins dialog or a profile dialog opens.
;(() => {
  const launch = window.zbtermLaunch

  class SampleCustomCommand extends launch.LaunchPlugin {
    static id = 'sample-custom-command'
    static title = 'Sample custom command'
    static icon = 'fa-wand-magic-sparkles'

    static defaults() {
      return { message: 'Hello from {{name}} ({{slug}})' }
    }

    getUI(ui) {
      return ui.input({
        name: 'message',
        placeholder: 'a message to print',
        value: this.config.message,
        onInput: (value) => {
          this.config.message = value.trim()
        }
      })
    }

    validate() {
      return this.config.message ? '' : 'Type a message to print'
    }

    // add() takes a command already quoted for the shell. Setting
    // `interactive` says the session goes on after it: to the next step, or
    // to an interactive shell (as "Change Directory" does). Leave it out and
    // a Shell Command before this step would end the session here.
    apply(ctx) {
      ctx.scope.add(`echo ${ctx.quote(this.config.message)}`)
      ctx.scope.interactive = true
    }
  }

  launch.register(SampleCustomCommand)
})()
