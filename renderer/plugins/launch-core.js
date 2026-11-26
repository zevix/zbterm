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

  // ---- profile placeholders ---------------------------------------------

  // 261121_dialog-and-command-plugins R8: in any step's settings `{{name}}` is
  // the profile's name and `{{slug}}` (also `{{name_can}}`) that name made
  // lower case, accents dropped, every run of other characters one `-`:
  // "Work #2" -> "work-2". A name with nothing left is "profile".
  function slugOf(name) {
    const slug = String(name || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return slug || 'profile'
  }

  // The values the placeholders stand for, for a profile named `name`.
  function profileVars(name) {
    const text = String(name || '')
    const slug = slugOf(text)
    return { name: text, slug, name_can: slug }
  }

  const PLACEHOLDER = /\{\{\s*([A-Za-z_]+)\s*\}\}/g

  // An unknown placeholder, or any without `vars`, is left as it is.
  // `wrap(value)`, when given, turns each value into the text that replaces
  // its placeholder (C1: one quoted shell word).
  function substitute(text, vars, wrap) {
    if (!vars || typeof text !== 'string' || !text.includes('{{')) return text
    return text.replace(PLACEHOLDER, (whole, key) => {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) return whole
      const value = String(vars[key])
      return wrap ? wrap(value) : value
    })
  }

  function hasPlaceholder(steps) {
    return (steps || []).some((step) =>
      Object.values(step.getConfig()).some((value) => /\{\{\s*[A-Za-z_]+\s*\}\}/.test(value))
    )
  }

  // ---- context -----------------------------------------------------------

  class LaunchScope {
    // `close(script)` renders the scope, whose commands are `script`, into the
    // one command its parent scope runs; the root scope has none.
    // `interactiveShell` is the command that leaves the scope's shell open.
    // `sameMachine`: the scope wraps the rest of the chain on the machine
    // its parent runs on (a terminal multiplexer, `ubt run`), so the steps
    // offered there by machine (Change Directory and SSH locally, Change
    // Remote Directory after SSH) are offered inside it too; it inherits the
    // parent's shell unless given one. `machine` is the scope that opened
    // the machine: the root, an SSH scope, or the scope itself.
    // `takesCwd`: the scope's `close` passes `this.cwd` on itself (a
    // `--cwd` option); without it a directory set inside a nested scope
    // becomes a `cd` at the start of its script.
    constructor(kind, opts = {}, parent = null) {
      const same = !!(opts.sameMachine && parent)
      this.kind = kind
      this.shell = opts.shell || (same ? parent.shell : 'posix')
      this.machine = same ? parent.machine : this
      this.takesCwd = !!opts.takesCwd
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
    // scope opened inside this one, which then runs last. `nested`: this is
    // not the root scope, whose directory the PTY host starts in.
    script(child, nested = false) {
      const entries = [...this.commands]
      if (nested && this.cwd && !this.takesCwd) {
        const cd = this.shell === 'cmd' ? 'cd /d' : 'cd'
        entries.unshift({ text: `${cd} ${quotePath(this.cwd, this.shell)}`, loose: false })
      }
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
      const scope = new LaunchScope(kind, opts, this.scope)
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
        child = this.scopes[i].close(this.scopes[i].script(child, true))
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
    // The settings the plugin hands to the shell as typed (Shell Command's
    // `command`): a profile placeholder there is filled as one quoted word.
    static shellFields = []

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

  // While the app runs a user's plugin file, `loading` names it: the plugin is
  // marked with its `source`, may replace one the same file registered before
  // (the file was read again), and may not take a built-in's or another
  // file's id.
  let loading = ''

  function register(Plugin) {
    if (!Plugin || !Plugin.id) throw new Error('A launch plugin needs a static id')
    if (typeof Plugin.id !== 'string') throw new Error('A launch plugin id is a string')
    const taken = registry.get(Plugin.id)
    if (loading) {
      if (!(Plugin.prototype instanceof LaunchPlugin)) {
        throw new Error(`${Plugin.id} does not extend LaunchPlugin`)
      }
      if (taken && taken.source !== loading) {
        throw new Error(`The id ${Plugin.id} is taken by ${taken.source || 'a built-in plugin'}`)
      }
      Object.defineProperty(Plugin, 'source', { value: loading, configurable: true })
      registry.set(Plugin.id, Plugin)
      return Plugin
    }
    if (taken) throw new Error(`Launch plugin registered twice: ${Plugin.id}`)
    registry.set(Plugin.id, Plugin)
    return Plugin
  }

  // Runs `fn` (which runs a user's plugin file) with `file` as the source of
  // whatever it registers; returns the ids it registered.
  function loadingFrom(file, fn) {
    const before = new Map(registry)
    loading = String(file || '') || 'a plugin file'
    try {
      fn()
    } finally {
      loading = ''
    }
    return Array.from(registry.values())
      .filter((Plugin) => Plugin.source === file && before.get(Plugin.id) !== Plugin)
      .map((Plugin) => Plugin.id)
  }

  // The plugins one file registered, and dropping them (the file is gone).
  function pluginsFrom(file) {
    return plugins().filter((Plugin) => Plugin.source === file)
  }

  function unregisterFrom(file) {
    for (const Plugin of pluginsFrom(file)) registry.delete(Plugin.id)
  }

  function errorText(err) {
    if (err && err.name && err.message) return `${err.name}: ${err.message}`
    return String((err && err.message) || err || '') || 'Failed to run'
  }

  // Runs one user plugin file, `execute()` (U1): a syntax error or a throw is
  // caught here and returned, never thrown on to the page; the file's
  // plugins are dropped first and again on an error, so a failed file leaves
  // nothing half-registered and every other file's plugins as they were.
  // Returns { ids, error }.
  function runFile(file, execute) {
    let ids = []
    let error = ''
    try {
      unregisterFrom(file)
      ids = loadingFrom(file, execute)
    } catch (err) {
      error = errorText(err)
    }
    if (error) {
      unregisterFrom(file)
      ids = []
    } else if (!ids.length) {
      error = 'It registered no plugin'
    }
    return { ids, error }
  }

  // The directory read again: `previous` and the result are [{ file, source,
  // ids, error }], `listed` is the main process's [{ file, source | error }]
  // in name order, `execute(file, source)` runs one file's source. Files that
  // are gone drop out first (so an id they held is free), then a new or
  // changed file runs, and so does every file that failed last time
  // (C3: a refused file may win the id its winner gave up); an unchanged
  // file that loaded keeps its plugins.
  function reloadFiles(previous, listed, execute) {
    const before = new Map((previous || []).map((entry) => [entry.file, entry]))
    const now = new Set((listed || []).map((entry) => entry.file))
    for (const file of before.keys()) if (!now.has(file)) unregisterFrom(file)
    const files = []
    for (const entry of listed || []) {
      const old = before.get(entry.file)
      if (entry.error) {
        unregisterFrom(entry.file)
        files.push({ file: entry.file, source: '', ids: [], error: entry.error })
        continue
      }
      if (old && !old.error && old.source === entry.source) {
        files.push(old)
        continue
      }
      const ran = runFile(entry.file, () => execute(entry.file, entry.source))
      files.push({ file: entry.file, source: entry.source, ids: ran.ids, error: ran.error })
    }
    return files
  }

  // C12: the plugin ids stored steps name that are not registered (a file
  // removed, renamed or failing), in order, once each.
  function missingPlugins(stored) {
    if (!Array.isArray(stored)) return []
    const ids = stored
      .map((step) => (step && typeof step.plugin === 'string' ? step.plugin : ''))
      .filter((id) => id && !registry.has(id))
    return Array.from(new Set(ids))
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
    // `env.vars` (profileVars): the placeholders are filled in for the step's
    // validate and apply only; its stored settings keep them.
    const vars = env && env.vars
    for (const step of steps) {
      const scope = ctx.scope
      const own = step.config
      if (vars && own) {
        // 261121_dialog-and-command-plugins C1 (F1, A-12): in a field the
        // plugin passes to the shell as typed (`static shellFields`), a
        // placeholder is one word, quoted for this scope's shell, so a name
        // can never become shell syntax ("Work #2" -> 'Work #2'). Other
        // fields are filled raw; their plugin quotes what it builds.
        const shellFields = Array.isArray(step.constructor.shellFields)
          ? step.constructor.shellFields
          : []
        const word = (value) => quote(value, scope.shell)
        const filled = {}
        for (const [key, value] of Object.entries(own)) {
          filled[key] = substitute(value, vars, shellFields.includes(key) ? word : null)
        }
        step.config = filled
      }
      try {
        trace.push({
          step,
          available: !!step.constructor.isAvailable(ctx),
          scope,
          depth: ctx.depth,
          kind: scope.kind,
          error: step.validate(ctx) || ''
        })
        step.apply(ctx)
      } finally {
        step.config = own
      }
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
    return { platform: env.platform, vars: env.vars }
  }

  // `env` with the placeholders of a profile named `name`.
  function withName(env, name) {
    return { ...(env || {}), vars: profileVars(name) }
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
  //
  // With placeholders (R8) the steps compile with the name the session was
  // launched as: `session.launchName` when the caller knows one that differs
  // from `name` (a copy's dialog, prefilled "Work #2", of "Work"), else its
  // name.
  function stepsFor(session = {}, env) {
    const stored = createSteps(session.steps)
    if (stored && stored.length) {
      const cwd = session.cwd || ''
      const names = [session.launchName, session.name].filter((name) => typeof name === 'string')
      if (!names.length) names.push('')
      for (const name of names) {
        const launch = compile(stored, withName(env, name))
        if (sameText(launch.cwd, cwd) && sameText(launch.command, session.command)) return stored
      }
    }
    return stepsFromLaunch(session)
  }

  // { cwd, command } for stored steps under a new name, or null when the
  // steps no longer describe the session's launch (stepsFor fell back) or
  // hold no placeholder (nothing changes).
  function relaunchFor(session = {}, name, env) {
    const stored = createSteps(session.steps)
    if (!stored || !stored.length || !hasPlaceholder(stored)) return null
    const kept = stepsFor(session, env)
    if (
      kept.length !== stored.length ||
      kept.some((step, i) => step.constructor !== stored[i].constructor)
    ) {
      return null
    }
    if (!sameText(JSON.stringify(serialize(kept)), JSON.stringify(serialize(stored)))) return null
    return compile(kept, withName(env, name))
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
    relaunchFor,
    withName,
    profileVars,
    slugOf,
    substitute,
    loadingFrom,
    pluginsFrom,
    unregisterFrom,
    runFile,
    reloadFiles,
    missingPlugins,
    quote,
    quotePath,
    posixQuote
  }

  if (typeof module === 'object' && module && module.exports) module.exports = launch
  if (typeof window === 'object' && window) window.zbtermLaunch = launch
})()
