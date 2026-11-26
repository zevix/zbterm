// 261121_dialog-and-command-plugins: the user's command plugins (R5–R7, U1–U3)
// and the profile-name placeholders (R8).
const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const launch = require('../renderer/plugins')
const commandPlugins = require('../electron/command-plugins')

const { seed, readChoice, readChoiceState, unsafeReason, displayDir, sampleFiles, SAMPLES_DIR } =
  commandPlugins._test

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbcp-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Runs a plugin file the way the renderer does: a script that sees
// window.zbtermLaunch, its registrations marked with the file.
function runFile(file, source) {
  return launch.loadingFrom(file, () => {
    vm.runInNewContext(source, { window: { zbtermLaunch: launch } }, { filename: file })
  })
}

test('placeholders: {{name}}, {{slug}} and {{name_can}}', (t) => {
  t.is(launch.slugOf('Work #2'), 'work-2')
  t.is(launch.slugOf('  Café Été / build  '), 'cafe-ete-build')
  t.is(launch.slugOf('###'), 'profile')
  const vars = launch.profileVars('Work #2')
  t.alike(vars, { name: 'Work #2', slug: 'work-2', name_can: 'work-2' })
  t.is(
    launch.substitute('{{name}}|{{ slug }}|{{name_can}}|{{other}}', vars),
    'Work #2|work-2|work-2|{{other}}'
  )
  t.is(launch.substitute('{{name}}', null), '{{name}}', 'no vars: left as it is')
})

test('placeholders fill every step at compile time; the stored settings keep them', (t) => {
  const steps = launch.createSteps([
    { plugin: 'cd', config: { path: '~/work/{{slug}}' } },
    // 2026-11-21 (builder P1, C1/A-12): a Shell Command's placeholder is
    // filled as one quoted word, so it is written bare, not "{{name}}".
    { plugin: 'shell', config: { command: 'echo {{name}}' } }
  ])
  const env = { platform: 'linux' }
  t.alike(launch.compile(steps, launch.withName(env, 'Work #2')), {
    cwd: '~/work/work-2',
    command: "echo 'Work #2'"
  })
  t.is(steps[1].getConfig().command, 'echo {{name}}', 'the step still holds the placeholder')
  // A quoted path keeps the name inside its quotes.
  const later = launch.createSteps([
    { plugin: 'shell', config: { command: 'true' } },
    { plugin: 'cd', config: { path: '~/w/{{name}}' } }
  ])
  t.is(
    launch.compile(later, launch.withName(env, "it's #1")).command,
    "true && cd ~/'w/it'\\''s #1' && exec \"$SHELL\""
  )
})

test('stepsFor and relaunchFor: a copy keeps its steps and launches under its own name', (t) => {
  const env = { platform: 'linux' }
  const stored = [
    { plugin: 'cd', config: { path: '~/' } },
    { plugin: 'shell', config: { command: 'tmux new -A -s {{slug}}' } }
  ]
  const work = { name: 'Work', cwd: '~/', command: 'tmux new -A -s work', steps: stored }
  t.is(launch.stepsFor(work, env).length, 2)
  t.is(launch.stepsFor(work, env)[1].getConfig().command, 'tmux new -A -s {{slug}}')
  // The copy's dialog: prefilled "Work #2", launched as "Work".
  const copy = { ...work, name: 'Work #2' }
  t.is(
    launch.stepsFor(copy, env)[1].getConfig().command,
    'tmux new -A -s work',
    'without launchName: falls back'
  )
  t.is(
    launch.stepsFor({ ...copy, launchName: 'Work' }, env)[1].getConfig().command,
    'tmux new -A -s {{slug}}'
  )
  t.alike(launch.relaunchFor(work, 'Work #2', env), { cwd: '~/', command: 'tmux new -A -s work-2' })
  // No placeholder, or steps that no longer describe the launch: nothing to redo.
  t.is(launch.relaunchFor({ ...work, steps: [stored[0]], command: '' }, 'X', env), null)
  t.is(launch.relaunchFor({ ...work, command: 'htop' }, 'Work #2', env), null)
})

test('a plugin file registers with its source; it cannot take another id (U1)', (t) => {
  const source = (id, title) => `
    ;(() => {
      const launch = window.zbtermLaunch
      class P extends launch.LaunchPlugin {
        static id = ${JSON.stringify(id)}
        static title = ${JSON.stringify(title)}
        apply(ctx) { ctx.scope.add('true') }
      }
      launch.register(P)
    })()`
  t.teardown(() => {
    launch.unregisterFrom('a.js')
    launch.unregisterFrom('b.js')
  })
  t.alike(runFile('a.js', source('t-one', 'One')), ['t-one'])
  t.is(launch.plugin('t-one').source, 'a.js')
  // Read again (the file changed): the same file may replace its own.
  t.alike(runFile('a.js', source('t-one', 'One again')), ['t-one'])
  t.is(launch.plugin('t-one').title, 'One again')
  t.exception(() => runFile('b.js', source('t-one', 'Thief')), /taken by a\.js/)
  t.exception(() => runFile('b.js', source('shell', 'Shadow')), /taken by a built-in/)
  t.is(launch.plugin('shell').title, 'Shell Command', 'the built-in is untouched')
  t.exception(
    () => runFile('b.js', 'window.zbtermLaunch.register(class X { static id = "t-x" })'),
    /does not extend LaunchPlugin/
  )
  launch.unregisterFrom('a.js')
  t.is(launch.plugin('t-one'), null)
  t.exception(
    () => launch.register(launch.plugin('cd')),
    /registered twice/,
    'built-ins stay strict'
  )
})

test('the samples run, offer their steps and fill the placeholders', (t) => {
  const files = sampleFiles()
  t.ok(files.includes('sample_custom_command.js'), 'sample_custom_command.js ships')
  t.ok(files.length >= 3, 'a few samples')
  t.teardown(() => files.forEach((file) => launch.unregisterFrom(file)))
  for (const file of files) {
    const ids = runFile(file, fs.readFileSync(path.join(SAMPLES_DIR, file), 'utf8'))
    t.is(ids.length, 1, `${file} registers one plugin`)
  }
  const env = launch.withName({ platform: 'linux' }, 'Work #2')
  const sample = launch.createSteps([{ plugin: 'sample-custom-command', config: {} }])
  t.is(launch.compile(sample, env).command, `echo 'Hello from Work #2 (work-2)' && exec "$SHELL"`)
  const tmux = launch.createSteps([{ plugin: 'sample-tmux-session', config: {} }])
  t.is(launch.compile(tmux, env).command, 'tmux new-session -A -s work-2')
  // After a Shell Command the sample still leaves a shell (it sets interactive).
  const after = launch.createSteps([
    { plugin: 'shell', config: { command: 'make' } },
    { plugin: 'sample-custom-command', config: {} }
  ])
  t.is(
    launch.compile(after, env).command,
    `make && echo 'Hello from Work #2 (work-2)' && exec "$SHELL"`
  )
  const venv = launch.createSteps([
    { plugin: 'sample-python-venv', config: { venv: '~/v/{{slug}}/' } }
  ])
  t.is(launch.compile(venv, env).command, `. ~/v/work-2/bin/activate && exec "$SHELL"`)
  t.ok(
    launch.addable([], { platform: 'linux' }).some((Plugin) => Plugin.id === 'sample-python-venv')
  )
  t.absent(
    launch
      .addable(launch.createSteps([{ plugin: 'ssh', config: { host: 'box' } }]), {})
      .some((Plugin) => Plugin.id === 'sample-python-venv'),
    'the venv sample is local only'
  )
})

test('the plugins directory: seeded once, never overwritten (R7, U2)', (t) => {
  const home = scratch(t)
  const dir = path.join(home, 'plugins', 'commands')
  t.ok(seed(dir), 'a missing directory is created')
  const files = fs.readdirSync(dir).sort()
  t.ok(files.includes('commands.json') && files.includes('sample_custom_command.js'))
  t.alike(readChoice(dir), { builtin: null, commands: ['sample_custom_command.js'] })
  fs.writeFileSync(path.join(dir, 'sample_custom_command.js'), '// mine')
  fs.writeFileSync(path.join(dir, 'commands.json'), '{"commands": []}')
  t.absent(seed(dir), 'an existing directory is left alone')
  t.is(fs.readFileSync(path.join(dir, 'sample_custom_command.js'), 'utf8'), '// mine')
  t.alike(readChoice(dir), { builtin: null, commands: [] })
  // An existing directory without commands.json is the user's too.
  const other = path.join(home, 'other')
  fs.mkdirSync(other)
  t.absent(seed(other))
  t.alike(fs.readdirSync(other), [])
  t.alike(readChoice(other), { builtin: null, commands: [] }, 'missing: every built-in, no file')
  fs.writeFileSync(path.join(other, 'commands.json'), 'not json')
  t.alike(readChoice(other), { builtin: null, commands: [] }, 'unreadable: the same')
})

test('list and save: every .js file, the reasons, the choice (R6, U1)', (t) => {
  const data = scratch(t)
  commandPlugins.configure({ dataDir: data })
  const first = commandPlugins.list()
  t.ok(first.seeded)
  t.is(first.dir, path.join(data, 'plugins', 'commands'))
  t.alike(
    first.files.map((entry) => entry.file),
    sampleFiles()
  )
  t.ok(first.files.every((entry) => typeof entry.source === 'string' && !entry.error))
  fs.writeFileSync(path.join(first.dir, 'big.js'), 'x'.repeat(300 * 1024))
  fs.mkdirSync(path.join(first.dir, 'dir.js'))
  fs.writeFileSync(path.join(first.dir, 'notes.txt'), 'not a plugin')
  const second = commandPlugins.list()
  t.absent(second.seeded)
  const byName = Object.fromEntries(second.files.map((entry) => [entry.file, entry]))
  t.is(byName['big.js'].error, 'Larger than 256 KB')
  t.is(byName['dir.js'].error, 'Not a file')
  t.absent(byName['notes.txt'], 'only .js files')
  const saved = commandPlugins.save({
    builtin: ['cd', 'shell', 'cd'],
    commands: ['tmux_session.js', '../x.js', 7]
  })
  t.alike(saved, { builtin: ['cd', 'shell'], commands: ['tmux_session.js'] })
  t.alike(commandPlugins.list().choice, saved)
  t.alike(commandPlugins.save({ builtin: null, commands: [] }), { builtin: null, commands: [] })
  t.is(
    displayDir(path.join(os.homedir(), '.config', 'ZBTerm', 'plugins', 'commands')),
    '~/.config/ZBTerm/plugins/commands/'
  )
})

test('C1: a placeholder in a Shell Command is one quoted word, never shell syntax (F1)', (t) => {
  const env = { platform: 'linux' }
  const shell = (command) => launch.createSteps([{ plugin: 'shell', config: { command } }])
  const hostile = 'x"; rm -rf ~; "'
  t.is(
    launch.compile(shell('tmux new -s {{name}}'), launch.withName(env, hostile)).command,
    `tmux new -s 'x"; rm -rf ~; "'`
  )
  t.is(
    launch.compile(shell('echo {{name}}'), launch.withName(env, 'z; touch "$HOME/PWNED"')).command,
    `echo 'z; touch "$HOME/PWNED"'`
  )
  t.is(
    launch.compile(shell('echo {{name}}'), launch.withName(env, "a $(id) `id` it's")).command,
    "echo 'a $(id) `id` it'\\''s'"
  )
  t.is(
    launch.compile(shell('tmux new -A -s {{slug}}'), launch.withName(env, hostile)).command,
    'tmux new -A -s x-rm-rf',
    'a slug is always [a-z0-9-], so it needs no quotes'
  )
  t.alike(launch.plugin('shell').shellFields, ['command'])
  // Windows: quoted for cmd.exe.
  t.is(
    launch.compile(shell('echo {{name}}'), launch.withName({ platform: 'win32' }, 'Work #2'))
      .command,
    'echo "Work #2"'
  )
  // A field the plugin quotes itself is filled raw (cd's path, quotePath).
  const cd = launch.createSteps([
    { plugin: 'shell', config: { command: 'true' } },
    { plugin: 'cd', config: { path: '~/{{name}}' } }
  ])
  t.is(
    launch.compile(cd, launch.withName(env, 'a;b')).command,
    'true && cd ~/\'a;b\' && exec "$SHELL"'
  )
})

// The R4 restart fix: a file that throws, or does not parse, is caught where
// it runs; the other files' plugins stay registered.
test('runFile and reloadFiles: a throwing file leaves the others registered (U1)', (t) => {
  const good = (id) => `
    ;(() => {
      const launch = window.zbtermLaunch
      class P extends launch.LaunchPlugin {
        static id = ${JSON.stringify(id)}
        static title = ${JSON.stringify(id)}
      }
      launch.register(P)
    })()`
  const execute = (file, source) =>
    vm.runInNewContext(source, { window: { zbtermLaunch: launch } }, { filename: file })
  const names = ['a.js', 'b.js', 'c.js', 'd.js']
  t.teardown(() => names.forEach((file) => launch.unregisterFrom(file)))
  const listed = [
    { file: 'a.js', source: good('t-a') },
    { file: 'b.js', source: 'throw new TypeError("boom")' },
    { file: 'c.js', source: 'this is not ( javascript' },
    { file: 'd.js', source: good('t-d') }
  ]
  const files = launch.reloadFiles([], listed, execute)
  const by = Object.fromEntries(files.map((entry) => [entry.file, entry]))
  t.alike(by['a.js'].ids, ['t-a'])
  t.is(by['b.js'].error, 'TypeError: boom')
  t.ok(/^SyntaxError: /.test(by['c.js'].error), by['c.js'].error)
  t.alike(by['d.js'].ids, ['t-d'])
  t.ok(launch.plugin('t-a') && launch.plugin('t-d'), 'the files on either side still registered')
  // A file that registers, then throws, leaves nothing half-registered.
  const half = `${good('t-half')}\nthrow new Error('after')`
  const ran = launch.runFile('b.js', () => execute('b.js', half))
  t.is(ran.error, 'Error: after')
  t.is(launch.plugin('t-half'), null)
  t.alike(
    launch.runFile('b.js', () => {}),
    { ids: [], error: 'It registered no plugin' }
  )
})

test('C3: a refused file runs again on every load, and wins an id set free (F3)', (t) => {
  const claim = (title) => `
    ;(() => {
      const launch = window.zbtermLaunch
      class P extends launch.LaunchPlugin {
        static id = 't-x'
        static title = ${JSON.stringify(title)}
      }
      launch.register(P)
    })()`
  const execute = (file, source) =>
    vm.runInNewContext(source, { window: { zbtermLaunch: launch } }, { filename: file })
  t.teardown(() => ['a.js', 'b.js'].forEach((file) => launch.unregisterFrom(file)))
  const a = { file: 'a.js', source: claim('A') }
  const b = { file: 'b.js', source: claim('B') }
  let files = launch.reloadFiles([], [a, b], execute)
  t.is(launch.plugin('t-x').source, 'a.js')
  t.ok(/taken by a\.js/.test(files[1].error), files[1].error)
  // Unchanged, loaded: kept as it was (not run again).
  const again = launch.reloadFiles(files, [a, b], execute)
  t.is(again[0], files[0], 'an unchanged file that loaded is kept')
  // a.js deleted: b.js, unchanged, runs again and takes the id.
  files = launch.reloadFiles(again, [b], execute)
  t.alike(files[0].ids, ['t-x'])
  t.is(files[0].error, '')
  t.is(launch.plugin('t-x').source, 'b.js')
  t.is(launch.plugin('t-x').title, 'B')
})

test('C11, C12: slugs never empty; missing plugins named; rename recompiles', (t) => {
  t.is(launch.slugOf('###'), 'profile')
  t.is(launch.slugOf('日本語'), 'profile')
  t.is(launch.slugOf('🙂'), 'profile')
  t.alike(
    launch.missingPlugins([
      { plugin: 'cd', config: {} },
      { plugin: 'sample-tmux-session', config: {} },
      { plugin: 'sample-tmux-session', config: {} },
      { plugin: 'gone', config: {} }
    ]),
    ['sample-tmux-session', 'gone']
  )
  t.alike(launch.missingPlugins(null), [])
  // A stored step whose plugin is not loaded: the dialog shows the launch as
  // a command, and the launch itself is unchanged.
  const session = {
    name: 'Work #2',
    cwd: '~/',
    command: 'tmux new-session -A -s work-2',
    steps: [
      { plugin: 'cd', config: { path: '~/' } },
      { plugin: 'sample-tmux-session', config: {} }
    ]
  }
  const shown = launch.stepsFor(session, { platform: 'linux' })
  t.alike(launch.serialize(shown), [
    { plugin: 'cd', config: { path: '~/' } },
    { plugin: 'shell', config: { command: 'tmux new-session -A -s work-2' } }
  ])
  t.is(launch.relaunchFor(session, 'Work #9', { platform: 'linux' }), null, 'nothing to recompile')
  // Rename (Q-1): steps with a placeholder compile under the new name.
  const work = {
    name: 'Work #2',
    cwd: '~/',
    command: 'tmux new -A -s work-2',
    steps: [
      { plugin: 'cd', config: { path: '~/' } },
      { plugin: 'shell', config: { command: 'tmux new -A -s {{slug}}' } }
    ]
  }
  t.alike(launch.relaunchFor(work, 'Work #9', { platform: 'linux' }), {
    cwd: '~/',
    command: 'tmux new -A -s work-9'
  })
})

test('C2: a file or folder other users can write, or own, is refused (F2)', (t) => {
  const ids = { uid: 1000, gid: 1000 }
  const stat = (mode, uid = 1000, gid = 1000) => ({ mode: 0o100000 | mode, uid, gid })
  t.is(unsafeReason(stat(0o644), ids), '')
  t.is(unsafeReason(stat(0o600), ids), '')
  t.is(unsafeReason(stat(0o666), ids), 'Writable by other users')
  t.is(unsafeReason(stat(0o646), ids), 'Writable by other users')
  t.is(unsafeReason(stat(0o664, 1000, 50), ids), 'Writable by other users', 'a shared group')
  t.is(unsafeReason(stat(0o664), ids), '', "the user's own private group (umask 002)")
  t.is(unsafeReason(stat(0o644, 0), ids), 'Not owned by you')
  t.is(unsafeReason(stat(0o666), null), '', 'no POSIX ids (Windows): not checked')
  if (process.platform === 'win32') return
  // For real: chmod 0666 -> listed with the reason, not read.
  const data = scratch(t)
  commandPlugins.configure({ dataDir: data })
  const dir = commandPlugins.list().dir
  const file = path.join(dir, 'open.js')
  fs.writeFileSync(file, 'window.zbtermLaunch')
  fs.chmodSync(file, 0o666)
  const entry = commandPlugins.list().files.find((item) => item.file === 'open.js')
  t.is(entry.error, 'Writable by other users')
  t.absent('source' in entry, 'its source is not read')
  fs.chmodSync(file, 0o644)
  fs.chmodSync(dir, 0o777)
  const all = commandPlugins.list().files
  t.ok(
    all.length && all.every((item) => item.error === 'The folder: Writable by other users'),
    'a folder others can write: every file refused'
  )
  fs.chmodSync(dir, 0o755)
})

test('C8: seeding is one rename; an existing or appearing target is left alone (F8)', (t) => {
  const home = scratch(t)
  const parent = path.join(home, 'plugins')
  const dir = path.join(parent, 'commands')
  // A target that exists is byte-identical afterwards.
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'mine.js'), '// mine')
  t.absent(seed(dir))
  t.alike(fs.readdirSync(dir), ['mine.js'])
  t.is(fs.readFileSync(path.join(dir, 'mine.js'), 'utf8'), '// mine')
  fs.rmSync(dir, { recursive: true })
  // Interrupted after the copy: no target, no temp left.
  t.exception(
    () =>
      seed(dir, SAMPLES_DIR, {
        beforeRename: () => {
          throw new Error('crash')
        }
      }),
    /crash/
  )
  t.absent(fs.existsSync(dir), 'no half-seeded target')
  t.alike(fs.readdirSync(parent), [], 'the temp directory is gone')
  // Another process seeds first (the target appears before the rename),
  // even as an empty directory: it is kept as it is.
  t.absent(seed(dir, SAMPLES_DIR, { beforeRename: () => fs.mkdirSync(dir) }))
  t.alike(fs.readdirSync(dir), [])
  t.alike(fs.readdirSync(parent), ['commands'])
  fs.rmSync(dir, { recursive: true })
  t.ok(seed(dir))
  t.alike(fs.readdirSync(parent), ['commands'], 'only the target, no temp')
  t.ok(fs.readdirSync(dir).includes('commands.json'))
})

test('C9: an unreadable commands.json is reported and kept as .bad on Save (F9)', (t) => {
  const data = scratch(t)
  commandPlugins.configure({ dataDir: data })
  const dir = commandPlugins.list().dir
  const choice = path.join(dir, 'commands.json')
  t.is(commandPlugins.list().choiceError, '')
  fs.writeFileSync(choice, '{"commands": ["sample_cust')
  const listed = commandPlugins.list()
  t.ok(/^commands\.json could not be read: /.test(listed.choiceError), listed.choiceError)
  t.alike(listed.choice, { builtin: null, commands: [] })
  t.ok(readChoiceState(dir).error)
  fs.writeFileSync(choice, '{"commands": "tmux_session.js"}')
  t.ok(commandPlugins.list().choiceError, 'the wrong shape is reported too')
  const bad = fs.readFileSync(choice)
  commandPlugins.save({ builtin: null, commands: ['tmux_session.js', '../x.js', '/etc/x.js'] })
  t.alike(fs.readFileSync(path.join(dir, 'commands.json.bad')), bad, 'the bad file is kept')
  t.alike(readChoice(dir), { builtin: null, commands: ['tmux_session.js'] }, 'paths dropped')
  t.is(commandPlugins.list().choiceError, '')
  // A missing file is not an error: every built-in, no file.
  fs.rmSync(choice)
  t.alike(readChoiceState(dir), { choice: { builtin: null, commands: [] }, error: '' })
})

// The "zbterm-plugin" Claude skill: one source (renderer/plugins/skill/), the
// project's own skill through a link, and what the Plugins dialog installs.
test('the Claude skill: linked into the project, installed self-contained', (t) => {
  const { spawnSync } = require('child_process')
  const { skillTarget, skillFiles } = commandPlugins._test
  const source = path.join(__dirname, '..', 'renderer', 'plugins', 'skill')
  const link = path.join(__dirname, '..', '.claude', 'skills', 'zbterm-plugin')
  t.is(fs.realpathSync(link), fs.realpathSync(source), 'the project skill is the shipped one')
  t.ok(/^---\nname: zbterm-plugin\n/.test(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')))

  t.is(skillTarget({}, '/home/u'), path.join('/home/u', '.claude', 'skills', 'zbterm-plugin'))
  t.is(
    skillTarget({ CLAUDE_CONFIG_DIR: '/c' }, '/home/u'),
    path.join('/c', 'skills', 'zbterm-plugin')
  )

  const names = skillFiles().map(([, to]) => to.split(path.sep).join('/'))
  for (const name of [
    'SKILL.md',
    'scripts/zbterm-plugin.js',
    'lib/launch-core.js',
    'lib/index.js',
    'lib/ssh.js',
    'lib/samples/sample_custom_command.js'
  ]) {
    t.ok(names.includes(name), name)
  }

  const home = scratch(t)
  const target = path.join(home, '.claude', 'skills', 'zbterm-plugin')
  const first = commandPlugins.installSkill(target)
  t.is(first.dir, target)
  t.is(first.updated, false)
  t.is(first.files, names.length)
  // Again: the shipped files are replaced, the user's own file stays.
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'stale')
  fs.writeFileSync(path.join(target, 'notes.txt'), 'mine')
  t.is(commandPlugins.installSkill(target).updated, true)
  t.ok(
    fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8').startsWith('---\nname: zbterm-plugin')
  )
  t.is(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'mine')

  // The installed script runs on its own `lib/`, outside the sources: it
  // checks a plugin, then installs and enables it in a new directory, which
  // it seeds with the samples as the app would.
  const script = path.join(target, 'scripts', 'zbterm-plugin.js')
  const plugins = path.join(home, 'plugins', 'commands')
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args, '--dir', plugins], {
      cwd: home,
      env: { ...process.env, ZBTERM_REPO: '' },
      encoding: 'utf8',
      timeout: 30000
    })
  const mine = path.join(home, 'my_tmux.js')
  fs.writeFileSync(
    mine,
    fs
      .readFileSync(path.join(SAMPLES_DIR, 'tmux_session.js'), 'utf8')
      .replace('sample-tmux-session', 'my-tmux')
  )
  const checked = run('check', mine)
  t.is(checked.status, 0, checked.stderr)
  t.ok(checked.stdout.includes('command: tmux new-session -A -s work-2'), 'compiles the step')
  const bad = path.join(home, 'bad.js')
  fs.writeFileSync(bad, fs.readFileSync(mine, 'utf8').replace('my-tmux', 'shell'))
  t.is(run('check', bad).status, 1, 'a taken id fails the check')

  const installed = run('install', mine)
  t.is(installed.status, 0, installed.stderr)
  t.alike(readChoice(plugins).commands, ['sample_custom_command.js', 'my_tmux.js'])
  t.alike(
    fs
      .readdirSync(plugins)
      .filter((file) => file.endsWith('.js'))
      .sort(),
    ['my_tmux.js', ...sampleFiles()]
  )
  if (process.platform !== 'win32') {
    t.is(fs.statSync(path.join(plugins, 'my_tmux.js')).mode & 0o777, 0o644)
  }
  t.is(run('disable', 'my_tmux.js').status, 0)
  t.alike(readChoice(plugins).commands, ['sample_custom_command.js'])
})
