// Session composition: a session's launch is a chain of steps, each one an
// instance of a launch plugin (docs/projects/261118_session-plugins/design.md).
//
// A plugin is a class in its own file under renderer/plugins/ that extends
// LaunchPlugin and registers itself. The class answers four questions:
//   static isAvailable(ctx)  may a step of this kind be added here?
//   getUI(ui)                the DOM it shows in the session dialog
//   getConfig()              its settings as a plain JSON object
//   setConfig(config)        take settings back from such an object
// and one more, which is how steps know about each other:
//   apply(ctx)               what the step does to the launch context
//
// The context is folded through the chain in order. It is a stack of scopes:
// the bottom one is the local shell, and a step such as SSH pushes a scope of
// its own, so every later step runs inside it. A plugin never names another
// plugin: it reads `ctx.scope.kind` (and `ctx.scope.data`, which the step that
// opened the scope filled in). That is why "Change Remote Directory" shows up
// after SSH and "Change Directory" does not.
//
// The chain compiles to the `{ cwd, command }` pair the PTY host has always
// taken, so nothing below the session dialog knows plugins exist.
//
// Loaded as plain scripts by renderer/index.html (window.zbtermLaunch) and
// required by electron/launch-plugin-host.js and the tests through
// renderer/plugins/index.js.
;(() => {
  const MAX_STEPS = 32

  // ---- quoting -----------------------------------------------------------

  function posixQuote(text) {
    const value = String(text)
    if (value && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
    return `'${value.replace(/'/g, `'\\''`)}'`
  }

  // cmd.exe has no real quoting; this is the conventional best effort.
  function cmdQuote(text) {
    const value = String(text)
    if (value && /^[A-Za-z0-9_@+=:,.\\/-]+$/.test(value)) return value
    return `"${value.replace(/"/g, '\\"')}"`
  }

  // `dialect` is a scope's shell: 'posix' or 'cmd'.
  function quote(text, dialect) {
    return dialect === 'cmd' ? cmdQuote(text) : posixQuote(text)
  }

  // A path keeps a leading `~` or `~/` outside the quotes so the shell still
  // expands it; cmd.exe has no `~`, so it becomes %USERPROFILE% there.
  function quotePath(text, dialect) {
    const value = String(text).trim()
    const tilde = /^~(?=$|[\\/])/.test(value)
    const rest = tilde ? value.slice(1) : value
    if (!tilde) return quote(protectDash(rest), dialect)
    if (dialect === 'cmd') return `"%USERPROFILE%${rest.replace(/"/g, '\\"')}"`
    if (!rest || rest === '/') return `~${rest}`
    return `~/${posixQuote(rest.slice(1))}`
  }

  // A command the user typed is passed on exactly as typed, so it may end in
  // something `&&` cannot follow: a comment, `&`, `;`, a line break. Such a
  // command is followed by a new line instead (and then cannot stop the chain
  // when it fails). cmd.exe takes one line only.
  function isLoose(text) {
    return /[\n#]/.test(text) || /[&;|\\]\s*$/.test(text)
  }

  function joinCommands(entries, dialect) {
    let script = ''
    entries.forEach((entry, i) => {
      script += entry.text
      if (i < entries.length - 1) script += entry.loose && dialect !== 'cmd' ? '\n' : ' && '
    })
    return script
  }

  // A relative path starting with `-` would be read as an option.
  function protectDash(value) {
    return value.startsWith('-') ? `./${value}` : value
  }

  // ---- context -----------------------------------------------------------

  class LaunchScope {
    // `close(script)` renders the scope, whose commands are `script`, into the
    // one command its parent scope runs; the root scope has none.
    // `interactiveShell` is the command that leaves the scope's shell open.
    constructor(kind, opts = {}) {
      this.kind = kind
      this.shell = opts.shell || 'posix'
      this.data = opts.data || {}
      this.close = opts.close || null
      this.owner = opts.owner || null
      this.interactiveShell =
        opts.interactiveShell || (this.shell === 'cmd' ? 'cmd' : 'exec "$SHELL"')
      this.cwd = ''
      // { text, loose }: see add() and run().
      this.commands = []
      // Whoever is last keeps the terminal: a scope that ends on a command
      // ends with it, anything else ends in an interactive shell.
      this.interactive = true
      this.steps = []
    }

    // A command a plugin built: one well-formed, already quoted command.
    add(command) {
      this.commands.push({ text: String(command), loose: false })
    }

    // A command line the user typed, run as typed. It keeps the terminal
    // unless something follows it.
    run(command) {
      const text = String(command || '').trim()
      if (!text) return
      this.commands.push({ text, loose: isLoose(text) })
      this.interactive = false
    }

    // The scope's commands as one script; `child` is the command of the
    // scope opened inside this one, which then runs last.
    script(child) {
      const entries = [...this.commands]
      if (child) entries.push({ text: child, loose: false })
      else if (entries.length && this.interactive) {
        entries.push({ text: this.interactiveShell, loose: false })
      }
      return joinCommands(entries, this.shell)
    }
  }

  class LaunchContext {
    constructor(env = {}) {
      this.platform = env.platform || 'linux'
      // Per-plugin facts about the host, from each plugin's `host.probe()`.
      this.facts = env.facts || {}
      this.scopes = [
        new LaunchScope('local', { shell: this.platform === 'win32' ? 'cmd' : 'posix' })
      ]
      this.steps = []
    }

    get scope() {
      return this.scopes[this.scopes.length - 1]
    }

    get depth() {
      return this.scopes.length
    }

    // The steps of plugin `id` so far; `inScope` narrows to the current scope.
    stepsOf(id, inScope = false) {
      const steps = inScope ? this.scope.steps : this.steps
      return steps.filter((step) => step.constructor.id === id)
    }

    has(id, inScope = false) {
      return this.stepsOf(id, inScope).length > 0
    }

    pushScope(kind, opts = {}) {
      const scope = new LaunchScope(kind, opts)
      this.scopes.push(scope)
      return scope
    }

    quote(text) {
      return quote(text, this.scope.shell)
    }

    quotePath(text) {
      return quotePath(text, this.scope.shell)
    }

    // cmd.exe cannot quote `"` or `%`: text holding either cannot be made one
    // argument of a command the local Windows shell runs.
    unquotable(text) {
      return this.scopes[0].shell === 'cmd' && /["%]/.test(String(text || ''))
    }

    // { cwd, command }: what the PTY host spawns. An empty command is the
    // user's default shell.
    render() {
      let child = ''
      for (let i = this.scopes.length - 1; i > 0; i--) {
        child = this.scopes[i].close(this.scopes[i].script(child))
      }
      const root = this.scopes[0]
      return { cwd: root.cwd, command: root.script(child) }
    }
  }

  // ---- the plugin interface ---------------------------------------------

  class LaunchPlugin {
    // Stable: it is what a stored step names its plugin by.
    static id = ''
    static title = ''
    // A Font Awesome icon name for the "+ Add" menu.
    static icon = 'fa-terminal'
    // Optional, main process only (electron/launch-plugin-host.js): functions
    // the plugin's UI reaches with `ui.host(method, args)`. `probe()`, when
    // there is one, runs once and its answer is `ctx.facts[id]`.
    static host = null

    // May a step of this kind be added to a chain whose context is `ctx`?
    static isAvailable() {
      return true
    }

    static defaults() {
      return {}
    }

    constructor(config) {
      this.config = this.constructor.defaults()
      if (config) this.setConfig(config)
    }

    getConfig() {
      return { ...this.config }
    }

    // Unknown keys are dropped and every value is kept as a trimmed string,
    // so a stored step can never smuggle anything but text into a plugin.
    setConfig(config) {
      const next = this.constructor.defaults()
      for (const key of Object.keys(next)) {
        if (config && typeof config[key] === 'string') next[key] = config[key].trim()
      }
      this.config = next
    }

    // The step's controls. `ui` is the dialog's toolkit (steps-editor.js):
    // `ui.input()`, `ui.iconButton()`, `ui.changed()`, `ui.context()` (the
    // context this step runs in, always current), `ui.host()`, and so on.
    getUI() {
      return null
    }

    // '' when the step can run, else what is wrong with it.
    validate() {
      return ''
    }

    // What the step does to the launch.
    apply() {}

    // The label of the step's row; a plugin may word it by context.
    label() {
      return this.constructor.title
    }
  }

  // ---- registry and chains ----------------------------------------------

  const registry = new Map()

  function register(Plugin) {
    if (!Plugin || !Plugin.id) throw new Error('A launch plugin needs a static id')
    if (registry.has(Plugin.id)) throw new Error(`Launch plugin registered twice: ${Plugin.id}`)
    registry.set(Plugin.id, Plugin)
    return Plugin
  }

  function plugins() {
    return Array.from(registry.values())
  }

  function plugin(id) {
    return registry.get(id) || null
  }

  // A stored step is `{ plugin: id, config: {...} }`.
  function createStep(stored) {
    const Plugin = stored && typeof stored.plugin === 'string' ? registry.get(stored.plugin) : null
    if (!Plugin) return null
    return new Plugin(stored.config && typeof stored.config === 'object' ? stored.config : null)
  }

  // Null when any step names a plugin this build does not have.
  function createSteps(stored) {
    if (!Array.isArray(stored) || stored.length > MAX_STEPS) return null
    const steps = stored.map(createStep)
    return steps.every(Boolean) ? steps : null
  }

  function serialize(steps) {
    return steps.map((step) => ({ plugin: step.constructor.id, config: step.getConfig() }))
  }

  // Folds the chain. `trace[i]` is where step i ran and whether it was
  // allowed there; `ctx` is the context after the last step.
  function run(steps, env) {
    const ctx = new LaunchContext(env)
    const trace = []
    for (const step of steps) {
      const scope = ctx.scope
      trace.push({
        step,
        available: !!step.constructor.isAvailable(ctx),
        scope,
        depth: ctx.depth,
        kind: scope.kind,
        error: step.validate(ctx) || ''
      })
      step.apply(ctx)
      scope.steps.push(step)
      ctx.steps.push(step)
    }
    return { ctx, trace }
  }

  // The context step `index` runs in (the one after the last step when
  // `index` is the chain's length).
  function contextAt(steps, index, env) {
    return run(steps.slice(0, index), env).ctx
  }

  function compile(steps, env) {
    return run(steps, env).ctx.render()
  }

  // The rules of a chain without the machine's facts: a step that is already
  // there is judged by where it stands, not by whether its program was found
  // (a session with an SSH step must stay editable where `ssh` is missing).
  // Only what "+ Add" offers depends on the facts.
  function structural(env = {}) {
    return { platform: env.platform }
  }

  // The plugins the "+ Add" menu offers at the end of the chain.
  function addable(steps, env) {
    if (steps.length >= MAX_STEPS) return []
    const ctx = run(steps, env).ctx
    return plugins().filter((Plugin) => Plugin.isAvailable(ctx))
  }

  // A step can go when the steps after it still mean what they meant: each
  // is still allowed and still runs in the same scope. So the last step can
  // always go, and SSH cannot be pulled out from under its remote steps.
  function canRemove(steps, index, env) {
    if (index < 0 || index >= steps.length) return false
    const before = run(steps, structural(env)).trace
    const rest = steps.filter((_, i) => i !== index)
    const after = run(rest, structural(env)).trace
    for (let i = index; i < rest.length; i++) {
      const was = before[i + 1]
      const now = after[i]
      if (!now.available || now.depth !== was.depth || now.kind !== was.kind) return false
    }
    return true
  }

  // The first problem in the chain: { index, message }, or null.
  function firstError(steps, env) {
    const { trace } = run(steps, structural(env))
    for (let i = 0; i < trace.length; i++) {
      const title = trace[i].step.constructor.title
      if (!trace[i].available) return { index: i, message: `${title} is not available here` }
      if (trace[i].error) return { index: i, message: trace[i].error }
    }
    return null
  }

  // ---- sessions ----------------------------------------------------------

  // What a session's dialog starts from when it has no stored steps: the two
  // fields the dialog had before plugins.
  function stepsFromLaunch(launch = {}) {
    const stored = [
      { plugin: 'cd', config: { path: launch.cwd || '~/' } },
      { plugin: 'shell', config: { command: launch.command || '' } }
    ]
    return createSteps(stored) || []
  }

  function sameText(a, b) {
    return String(a || '').trim() === String(b || '').trim()
  }

  // A session's steps. Its stored steps are used only while they still
  // compile to the `cwd` and `command` it launches with; a session edited by
  // something that knows only those two (an older build, the debug server)
  // falls back to them, so the dialog never shows a launch that is not the
  // one that runs.
  function stepsFor(session = {}, env) {
    const stored = createSteps(session.steps)
    if (stored && stored.length) {
      const launch = compile(stored, env)
      const cwd = session.cwd || ''
      if (sameText(launch.cwd, cwd) && sameText(launch.command, session.command)) return stored
    }
    return stepsFromLaunch(session)
  }

  const launch = {
    MAX_STEPS,
    LaunchPlugin,
    LaunchContext,
    LaunchScope,
    register,
    plugins,
    plugin,
    createStep,
    createSteps,
    serialize,
    run,
    contextAt,
    compile,
    addable,
    canRemove,
    firstError,
    stepsFromLaunch,
    stepsFor,
    quote,
    quotePath,
    posixQuote
  }

  if (typeof module === 'object' && module && module.exports) module.exports = launch
  if (typeof window === 'object' && window) window.zbtermLaunch = launch
})()
