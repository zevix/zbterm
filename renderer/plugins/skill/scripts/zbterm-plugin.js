#!/usr/bin/env node
// Checks, installs and enables ZBTerm command plugins (see ../SKILL.md).
//
//   zbterm-plugin.js check <file.js> [--dir <plugins dir>]
//   zbterm-plugin.js install <file.js> [--dir <plugins dir>] [--no-enable] [--force]
//   zbterm-plugin.js enable|disable <name.js> [--dir <plugins dir>]
//   zbterm-plugin.js list [--dir <plugins dir>]
//
// It uses the app's own launch core (see pluginsDir), so what it reports
// is what the app would do with the file. It never touches a running app.
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const CHOICE_FILE = 'commands.json'
const DEFAULT_CHOSEN = ['sample_custom_command.js']
const MAX_SOURCE_BYTES = 256 * 1024
// The dialog toolkit a plugin's getUI may call (renderer/plugins/steps-editor.js).
const TOOLKIT = [
  'el',
  'button',
  'input',
  'iconButton',
  'setValue',
  'combo',
  'row',
  'stack',
  'changed',
  'showError',
  'chooseDirectory',
  'host'
]

// The app's launch plugins (launch-core.js, index.js, the built-ins and
// samples/): `../lib` in a skill ZBTerm installed (its Plugins dialog copies
// them there), else `renderer/plugins/` of the ZBTerm checkout this file or
// the working directory is in, or of $ZBTERM_REPO.
function pluginsDir() {
  const lib = path.join(__dirname, '..', 'lib')
  if (fs.existsSync(path.join(lib, 'launch-core.js'))) return lib
  const starts = [process.env.ZBTERM_REPO, __dirname, process.cwd()].filter(Boolean)
  for (const start of starts) {
    let at = path.resolve(start)
    for (;;) {
      const dir = path.join(at, 'renderer', 'plugins')
      if (fs.existsSync(path.join(dir, 'launch-core.js'))) return dir
      const up = path.dirname(at)
      if (up === at) break
      at = up
    }
  }
  throw new Error('ZBTerm launch plugins not found: run inside the repo or set ZBTERM_REPO')
}

function defaultDir() {
  const home = os.homedir()
  let base
  if (process.platform === 'win32') {
    base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  } else if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support')
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  }
  return path.join(base, 'ZBTerm', 'plugins', 'commands')
}

function isPluginFileName(name) {
  return /^[^/\\]+\.js$/.test(name) && !name.startsWith('.')
}

// The app's own rule (electron/command-plugins.js unsafeReason).
function unsafeReason(stat) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return ''
  if (stat.uid !== process.getuid()) return 'Not owned by you'
  if (stat.mode & 0o002) return 'Writable by other users'
  if (stat.mode & 0o020 && stat.gid !== process.getgid()) return 'Writable by other users'
  return ''
}

function execute(launch, file, source) {
  return launch.runFile(file, () => {
    vm.runInNewContext(source, { window: { zbtermLaunch: launch } }, { filename: file })
  })
}

// A stand-in for any DOM node: every property and call answers itself.
function domStub() {
  const stub = new Proxy(function () {}, {
    get: (_, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : stub),
    set: () => true,
    apply: () => stub,
    construct: () => stub
  })
  return stub
}

function fakeToolkit(ctx) {
  const stub = domStub()
  const kit = { document: stub, context: () => ctx }
  for (const name of TOOLKIT) kit[name] = () => stub
  return kit
}

// Everything the app would say about one plugin file, plus what its steps
// compile to. Returns { ok, lines }.
function check(file, dir) {
  const launch = require(path.join(pluginsDir(), 'index.js'))
  const lines = []
  const problems = []
  const warn = (text) => lines.push(`  warning: ${text}`)
  const name = path.basename(file)
  if (!isPluginFileName(name)) {
    problems.push(`${name}: the name must end in .js and not start with "."`)
  }
  const stat = fs.statSync(file)
  if (stat.size > MAX_SOURCE_BYTES) problems.push('Larger than 256 KB: the app will not read it')
  const source = fs.readFileSync(file, 'utf8')

  // The other files of the directory hold their ids first.
  if (dir && fs.existsSync(dir)) {
    for (const other of fs.readdirSync(dir).filter(isPluginFileName).sort()) {
      if (other === name) continue
      try {
        execute(launch, other, fs.readFileSync(path.join(dir, other), 'utf8'))
      } catch {}
    }
  }

  const ran = execute(launch, name, source)
  if (ran.error) {
    problems.push(`does not load: ${ran.error}`)
    return { ok: false, lines: problems.map((text) => `  error: ${text}`) }
  }
  if (/\brequire\s*\(/.test(source)) {
    warn('require() does not exist in the renderer (sandboxed page, no Node)')
  }

  for (const id of ran.ids) {
    const Plugin = launch.plugin(id)
    lines.push(`plugin ${id}: "${Plugin.title}" (${Plugin.icon})`)
    if (!Plugin.title) problems.push(`${id}: no static title`)
    if (!/^fa-[a-z0-9-]+$/.test(Plugin.icon || '')) {
      warn(`${id}: icon "${Plugin.icon}" is not fa-<name>`)
    }
    if (Plugin.host) {
      warn(`${id}: static host is ignored for command plugins (main process only loads built-ins)`)
    }
    const defaults = Plugin.defaults()
    for (const key of Object.keys(defaults)) {
      if (typeof defaults[key] !== 'string') {
        problems.push(`${id}: defaults().${key} is not a string (setConfig keeps strings only)`)
      }
    }

    const chains = [
      { title: 'local', before: [] },
      { title: 'after SSH', before: [{ plugin: 'ssh', config: { host: 'example.org' } }] }
    ]
    let placed = false
    for (const chain of chains) {
      for (const platform of ['linux', 'win32']) {
        const env = launch.withName({ platform }, 'Work #2')
        const before = launch.createSteps(chain.before)
        let available
        try {
          available = !!Plugin.isAvailable(launch.contextAt(before, before.length, env))
        } catch (err) {
          problems.push(`${id}: isAvailable throws (${chain.title}, ${platform}): ${err.message}`)
          continue
        }
        if (!available) {
          lines.push(`  ${chain.title}, ${platform}: not offered`)
          continue
        }
        placed = true
        const step = new Plugin()
        const steps = [...before, step]
        try {
          const ui = fakeToolkit(launch.contextAt(steps, before.length, env))
          step.getUI(ui)
        } catch (err) {
          problems.push(`${id}: getUI throws: ${err.message}`)
        }
        try {
          const error = launch.firstError(steps, env)
          const compiled = launch.compile(steps, env)
          const cwd = compiled.cwd ? ` (cwd ${compiled.cwd})` : ''
          lines.push(`  ${chain.title}, ${platform}, defaults, profile "Work #2":`)
          lines.push(`    command: ${compiled.command || '<default shell>'}${cwd}`)
          if (error) lines.push(`    validate: ${error.message}`)
          // Followed by a Shell Command: does the chain go on?
          const more = [
            ...steps,
            launch.createStep({ plugin: 'shell', config: { command: 'htop' } })
          ]
          lines.push(`    then "htop": ${launch.compile(more, env).command}`)
        } catch (err) {
          problems.push(
            `${id}: validate/apply throws (${chain.title}, ${platform}): ${err.message}`
          )
        }
      }
    }
    if (!placed) warn(`${id}: not offered locally or after SSH on linux or win32`)
  }
  for (const text of new Set(problems)) lines.push(`  error: ${text}`)
  return { ok: !problems.length, lines }
}

function readChoice(dir) {
  const file = path.join(dir, CHOICE_FILE)
  if (!fs.existsSync(file)) return { commands: [] }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file}: expected {"builtin": [...], "commands": [...]}`)
  }
  if (parsed.commands !== undefined && !Array.isArray(parsed.commands)) {
    throw new Error(`${file}: "commands" is not a list`)
  }
  return parsed
}

function writeChoice(dir, choice) {
  const file = path.join(dir, CHOICE_FILE)
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(choice, null, 2) + '\n')
  fs.renameSync(temp, file)
}

function setEnabled(dir, name, on) {
  const choice = readChoice(dir)
  const commands = (choice.commands || []).filter((item) => item !== name)
  if (on) commands.push(name)
  writeChoice(dir, { ...choice, commands })
}

// A directory that does not exist is what the app seeds with its samples on
// first start; creating it empty would lose them, so it is seeded here.
function ensureDir(dir) {
  if (fs.existsSync(dir)) return false
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  const samples = path.join(pluginsDir(), 'samples')
  for (const file of fs.readdirSync(samples).filter((item) => item.endsWith('.js'))) {
    fs.copyFileSync(path.join(samples, file), path.join(dir, file))
    fs.chmodSync(path.join(dir, file), 0o644)
  }
  writeChoice(dir, { commands: DEFAULT_CHOSEN })
  return true
}

function install(file, dir, opts) {
  const name = path.basename(file)
  const result = check(file, dir)
  console.log(result.lines.join('\n'))
  if (!result.ok) throw new Error('Not installed: fix the errors above')
  if (ensureDir(dir)) console.log(`created ${dir} with the app's samples`)
  const dirUnsafe = unsafeReason(fs.statSync(dir))
  if (dirUnsafe) throw new Error(`${dir}: ${dirUnsafe} (the app refuses the whole folder)`)
  readChoice(dir) // an unreadable commands.json stops here, before anything is written
  const into = path.join(dir, name)
  const source = fs.readFileSync(file)
  if (fs.existsSync(into) && !fs.readFileSync(into).equals(source) && !opts.force) {
    throw new Error(`${into} exists and differs: pass --force to replace it`)
  }
  const temp = path.join(dir, `.${name}.${process.pid}.tmp`)
  fs.writeFileSync(temp, source, { mode: 0o644 })
  fs.chmodSync(temp, 0o644)
  fs.renameSync(temp, into)
  console.log(`installed ${into}`)
  if (!opts.noEnable) {
    setEnabled(dir, name, true)
    console.log(`enabled ${name} in ${CHOICE_FILE}`)
  }
  console.log('A running ZBTerm reads it when a profile dialog or the Plugins dialog next opens.')
}

function list(dir) {
  if (!fs.existsSync(dir)) {
    return console.log(`${dir} does not exist (the app creates it on first start)`)
  }
  const launch = require(path.join(pluginsDir(), 'index.js'))
  const dirUnsafe = unsafeReason(fs.statSync(dir))
  if (dirUnsafe) console.log(`the folder: ${dirUnsafe}`)
  let chosen = []
  try {
    chosen = readChoice(dir).commands || []
  } catch (err) {
    console.log(`error: ${err.message}`)
  }
  for (const name of fs.readdirSync(dir).filter(isPluginFileName).sort()) {
    const full = path.join(dir, name)
    const unsafe = unsafeReason(fs.statSync(full))
    const ran = unsafe
      ? { ids: [], error: unsafe }
      : execute(launch, name, fs.readFileSync(full, 'utf8'))
    const mark = chosen.includes(name) ? '[x]' : '[ ]'
    console.log(`${mark} ${name}  ${ran.error ? `ERROR: ${ran.error}` : ran.ids.join(', ')}`)
  }
  for (const name of chosen) {
    if (!fs.existsSync(path.join(dir, name))) console.log(`[x] ${name}  MISSING FILE`)
  }
}

function main(argv) {
  const args = []
  const opts = { dir: '', force: false, noEnable: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') opts.dir = argv[++i]
    else if (argv[i] === '--force') opts.force = true
    else if (argv[i] === '--no-enable') opts.noEnable = true
    else args.push(argv[i])
  }
  const [command, target] = args
  const dir = path.resolve(opts.dir || defaultDir())
  if (command === 'list') return list(dir)
  if (!target) {
    throw new Error(
      'usage: zbterm-plugin.js check|install|enable|disable|list [file] [--dir <dir>]'
    )
  }
  if (command === 'check') {
    const result = check(path.resolve(target), dir)
    console.log(result.lines.join('\n'))
    if (!result.ok) process.exitCode = 1
    return
  }
  if (command === 'install') return install(path.resolve(target), dir, opts)
  if (command === 'enable' || command === 'disable') {
    const name = path.basename(target)
    if (command === 'enable' && !fs.existsSync(path.join(dir, name))) {
      throw new Error(`${path.join(dir, name)} does not exist`)
    }
    setEnabled(dir, name, command === 'enable')
    return console.log(`${command}d ${name} in ${path.join(dir, CHOICE_FILE)}`)
  }
  throw new Error(`unknown command: ${command}`)
}

try {
  main(process.argv.slice(2))
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exitCode = 1
}
