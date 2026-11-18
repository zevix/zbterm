// The launch plugins (renderer/plugins/, 261118_session-plugins): what a chain
// of steps compiles to, which plugins are available where, which steps may be
// deleted, and the SSH plugin's main-process half.
const fs = require('fs')
const path = require('path')
const test = require('brittle')

const launch = require('../renderer/plugins')
const Ssh = require('../renderer/plugins/ssh.js')
const pluginHost = require('../electron/launch-plugin-host')

const LINUX = { platform: 'linux', facts: { ssh: { available: true } } }
const WINDOWS = { platform: 'win32', facts: {} }

const steps = (...stored) => launch.createSteps(stored)
const cd = (dir) => ({ plugin: 'cd', config: { path: dir } })
const shell = (command) => ({ plugin: 'shell', config: { command } })
const ssh = (host, more = {}) => ({
  plugin: 'ssh',
  config: { host, port: '', identity: '', ...more }
})
const remoteCd = (dir) => ({ plugin: 'ssh-cd', config: { path: dir } })
const compile = (...stored) => launch.compile(steps(...stored), LINUX)
const ids = (list) => list.map((Plugin) => Plugin.id)

test('the default chain is the old two fields', (t) => {
  const chain = launch.stepsFromLaunch({})
  t.alike(launch.serialize(chain), [cd('~/'), shell('')])
  t.alike(launch.compile(chain, LINUX), { cwd: '~/', command: '' })
  t.alike(
    launch.compile(launch.stepsFromLaunch({ cwd: '/srv', command: 'htop -d 5' }), LINUX),
    { cwd: '/srv', command: 'htop -d 5' },
    'a session saved before plugins compiles back to its own cwd and command'
  )
})

test('local steps run in order, and the last one keeps the terminal', (t) => {
  t.alike(compile(shell('make')), { cwd: '', command: 'make' })
  t.alike(compile(cd('~/a'), shell('make'), shell('make test')), {
    cwd: '~/a',
    command: 'make && make test'
  })
  t.alike(
    compile(shell('make'), cd('~/my dir')),
    { cwd: '', command: `make && cd ~/'my dir' && exec "$SHELL"` },
    'a directory after a command is a cd, and leaves a shell open in it'
  )
  t.alike(
    compile(shell('make'), shell('')),
    { cwd: '', command: 'make && exec "$SHELL"' },
    'an empty command is the interactive shell'
  )
  t.alike(compile(cd('~/a'), cd('b')), { cwd: '~/a/b', command: '' }, 'a relative directory nests')
  t.alike(compile(cd('~/a'), cd('/b')), { cwd: '/b', command: '' })
  t.alike(
    compile(cd('rel')),
    { cwd: '~/rel', command: '' },
    'a bare relative directory: under home'
  )
  t.alike(launch.compile(steps(shell('build'), cd('~/x y')), WINDOWS), {
    cwd: '',
    command: 'build && cd /d "%USERPROFILE%/x y" && cmd'
  })
})

test('a typed command that && cannot follow is followed by a new line', (t) => {
  t.alike(compile(shell('make &'), cd('-x')), {
    cwd: '',
    command: 'make &\ncd ./-x && exec "$SHELL"'
  })
  t.is(compile(shell('a # note'), shell('b')).command, 'a # note\nb')
  t.is(compile(shell('a;'), shell('b')).command, 'a;\nb')
  t.is(
    compile(shell('a; b'), shell('c')).command,
    'a; b && c',
    'a plain command still guards the next'
  )
  t.is(
    compile(ssh('box'), shell('x # y'), remoteCd('/srv')).command,
    `ssh -t box 'x # y\ncd /srv && exec "$SHELL" -l'`,
    'remotely too'
  )
  t.is(
    launch.compile(steps(shell('a &'), shell('b')), WINDOWS).command,
    'a & && b',
    'cmd.exe takes one line'
  )
})

test('SSH wraps the steps after it', (t) => {
  t.alike(compile(cd('~/'), shell(''), ssh('me@box')), { cwd: '~/', command: 'ssh me@box' })
  t.alike(compile(ssh('me@box', { port: '2222', identity: '~/.ssh/my key' })), {
    cwd: '',
    command: `ssh -p 2222 -i ~/'.ssh/my key' me@box`
  })
  t.alike(
    compile(ssh('box'), remoteCd('~/src/my app')),
    { cwd: '', command: `ssh -t box 'cd ~/'\\''src/my app'\\'' && exec "$SHELL" -l'` },
    'a remote directory keeps a login shell open in it'
  )
  t.alike(compile(ssh('box'), remoteCd('/srv'), shell("tail -f 'a b.log'")), {
    cwd: '',
    command: `ssh -t box 'cd /srv && tail -f '\\''a b.log'\\'''`
  })
  t.alike(
    compile(shell('make'), ssh('box'), shell('uptime')),
    { cwd: '', command: 'make && ssh -t box uptime' },
    'local commands run first'
  )
  t.alike(launch.compile(steps(ssh('box'), remoteCd('/srv/a b')), WINDOWS), {
    cwd: '',
    command: `ssh -t box "cd '/srv/a b' && exec \\"$SHELL\\" -l"`
  })
})

test('plugins are offered by the scope the chain ends in', (t) => {
  t.alike(ids(launch.addable([], LINUX)), ['cd', 'shell', 'ssh'])
  t.alike(
    ids(launch.addable(steps(cd('~/'), shell(''), ssh('box')), LINUX)),
    ['shell', 'ssh-cd'],
    'after SSH: the remote directory, not the local one, and no second SSH'
  )
  t.alike(
    ids(launch.addable([], { platform: 'linux', facts: { ssh: { available: false } } })),
    ['cd', 'shell'],
    'no SSH without an ssh binary'
  )
  t.alike(
    ids(launch.addable([], { platform: 'linux' })),
    ['cd', 'shell', 'ssh'],
    'unprobed: offered'
  )
  const full = Array.from({ length: launch.MAX_STEPS }, () => shell('x'))
  t.alike(launch.addable(steps(...full), LINUX), [], 'a full chain takes no more')
})

test('a step can be deleted while the later ones keep their meaning', (t) => {
  const chain = steps(cd('~/'), shell('make'), ssh('box'), remoteCd('/srv'), shell('uptime'))
  const removable = chain.map((_, index) => launch.canRemove(chain, index, LINUX))
  t.alike(
    removable,
    [true, true, false, true, true],
    'SSH cannot be pulled out from under its remote steps'
  )
  const bare = steps(cd('~/'), ssh('box'))
  t.ok(launch.canRemove(bare, 1, LINUX), 'SSH goes once it is last')
  t.absent(launch.canRemove(bare, 2, LINUX))
  t.absent(
    launch.canRemove(steps(ssh('box'), shell('uptime')), 0, LINUX),
    'a remote command must not silently become a local one'
  )
})

test('a chain reports its first problem', (t) => {
  t.is(launch.firstError(steps(cd('~/'), shell('')), LINUX), null)
  t.alike(launch.firstError(steps(cd('~/'), ssh('')), LINUX), {
    index: 1,
    message: 'SSH needs a host'
  })
  t.is(
    launch.firstError(steps(ssh('-oProxyCommand=evil')), LINUX).message,
    'The SSH host is not valid'
  )
  t.is(launch.firstError(steps(ssh('a b')), LINUX).message, 'The SSH host is not valid')
  t.ok(/port/.test(launch.firstError(steps(ssh('box', { port: '70000' })), LINUX).message))
  t.is(
    launch.firstError(steps(ssh('box')), {
      platform: 'linux',
      facts: { ssh: { available: false } }
    }),
    null,
    'an SSH step already there stays valid where ssh is missing: the session stays editable'
  )
  t.is(
    launch.compile(steps(ssh('-oProxyCommand=evil', { port: '1;x' })), LINUX).command,
    `ssh -p '1;x' -- -oProxyCommand=evil`,
    'even unchecked, a host is never an option and a port never a command'
  )
  for (const bad of [
    [cd('a"&calc&"')],
    [ssh('a"&calc&"')],
    [ssh('box', { identity: '%X%' })],
    [ssh('box'), remoteCd('a"b')],
    [ssh('box'), shell('echo "a" && b')]
  ]) {
    t.ok(
      /On Windows/.test(launch.firstError(steps(...bad), WINDOWS).message),
      `cmd.exe cannot quote ${JSON.stringify(bad[bad.length - 1].config)}`
    )
    t.is(launch.firstError(steps(...bad), LINUX), null)
  }
  t.is(
    launch.firstError(steps(shell('echo "a" %B%')), WINDOWS),
    null,
    'a local command is as typed'
  )
  t.alike(
    launch.firstError(steps(ssh('box'), cd('~/')), LINUX),
    { index: 1, message: 'Change Directory is not available here' },
    'a stored chain that breaks the rules is caught'
  )
})

test('stored steps: plain text only, and unknown plugins refuse the chain', (t) => {
  const step = launch.createStep({
    plugin: 'ssh',
    config: { host: '  box ', port: 22, extra: 'x', identity: { evil: true } }
  })
  t.alike(step.getConfig(), { host: 'box', port: '', identity: '' })
  t.is(launch.createSteps([cd('~/'), { plugin: 'nope', config: {} }]), null)
  t.is(launch.createSteps('cd'), null)
  t.is(launch.createSteps(Array.from({ length: launch.MAX_STEPS + 1 }, () => shell('x'))), null)
})

test('a session shows its stored steps only while they match what it launches', (t) => {
  const stored = [cd('~/a'), shell(''), ssh('box'), remoteCd('/srv')]
  const launched = launch.compile(steps(...stored), LINUX)
  t.alike(
    launch.serialize(launch.stepsFor({ ...launched, steps: stored }, LINUX)),
    stored,
    'matching steps are used'
  )
  t.alike(
    launch.serialize(launch.stepsFor({ cwd: '/tmp', command: 'htop', steps: stored }, LINUX)),
    [cd('/tmp'), shell('htop')],
    'stale steps give way to the cwd and command that really launch'
  )
  t.alike(
    launch.serialize(launch.stepsFor({ cwd: null, command: null, steps: [shell('')] }, LINUX)),
    [shell('')],
    'a chain that compiles to nothing matches a session with neither'
  )
  t.alike(launch.serialize(launch.stepsFor({ cwd: '~/', steps: [{ plugin: 'gone' }] }, LINUX)), [
    cd('~/'),
    shell('')
  ])
})

test('SSH browsing: the ssh call never prompts and never takes a path as an option', async (t) => {
  const { listScript, parseListing, batchArgs } = Ssh._test
  t.is(listScript(''), 'pwd && ls -1ApL 2>/dev/null; true')
  t.is(listScript('~'), 'pwd && ls -1ApL 2>/dev/null; true')
  t.is(
    listScript("~/a b/it's"),
    `cd ~/'a b/it'\\''s' || exit 66; pwd && ls -1ApL 2>/dev/null; true`
  )
  t.is(listScript('-rf'), 'cd ./-rf || exit 66; pwd && ls -1ApL 2>/dev/null; true')
  t.alike(parseListing('/home/me\n.cache/\nb/\nfile.txt\nA dir/\n./\n../\n'), {
    path: '/home/me',
    directories: ['.cache', 'A dir', 'b']
  })
  t.alike(batchArgs({ host: 'me@box', port: '2222', identity: '~/.ssh/k' }, 'pwd', '/home/me'), [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-p',
    '2222',
    '-i',
    '/home/me/.ssh/k',
    '--',
    'me@box',
    'pwd'
  ])

  const calls = []
  const execFile = (file, args, opts, done) => {
    calls.push({ file, args })
    done(null, '/srv\nwww/\nlog/\nnotes\n', '')
  }
  const listing = await Ssh.host.listDirectory(
    { host: 'box', path: '/srv' },
    { execFile, home: '/h' }
  )
  t.alike(listing, { path: '/srv', directories: ['log', 'www'] })
  t.is(calls[0].file, 'ssh')
  t.is(calls[0].args[calls[0].args.length - 2], 'box')

  await t.exception(
    Ssh.host.listDirectory({ host: '-oProxyCommand=evil' }, { execFile }),
    /not valid/,
    'an option in place of a host never reaches ssh'
  )
  t.is(calls.length, 1)

  const failing = (stderr, err) => (file, args, opts, done) => done(err, '', stderr)
  await t.exception(
    Ssh.host.listDirectory(
      { host: 'box' },
      { execFile: failing('me@box: Permission denied (publickey,password).\n', { code: 255 }) }
    ),
    /Permission denied.*key or an SSH agent/
  )
  await t.exception(
    Ssh.host.listDirectory(
      { host: 'box', path: '/nope' },
      { execFile: failing('sh: cd: /nope: No such file\n', { code: 66 }) }
    ),
    /no such directory: \/nope/
  )
})

test('a custom ssh directory: its Host names, its keys, and the ssh commands read it', async (t) => {
  const os = require('os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotssh-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'conf.d'))
  fs.writeFileSync(
    path.join(dir, 'config'),
    'Host starwars # the film\n  HostName starwarstel.net\n  User alice\nInclude conf.d/*\nHost * !x\n  IdentitiesOnly yes\n'
  )
  fs.writeFileSync(
    path.join(dir, 'conf.d', 'work'),
    'Host build-box staging-db\n  HostName=10.0.0.5\nMatch all\n  HostName ignored\n'
  )
  for (const name of ['id_ed25519', 'id_ed25519.pub', 'work', 'work.pub', 'known_hosts', 'notes']) {
    fs.writeFileSync(path.join(dir, name), '')
  }

  t.alike(Ssh.host.hosts({}, { dotSsh: dir }), [
    { name: 'starwars', hostName: 'starwarstel.net', user: 'alice' },
    { name: 'build-box', hostName: '10.0.0.5', user: '' },
    { name: 'staging-db', hostName: '10.0.0.5', user: '' }
  ])
  t.alike(Ssh.host.identities({}, { dotSsh: dir, home: '/elsewhere' }), [
    { name: 'id_ed25519', path: path.join(dir, 'id_ed25519') },
    { name: 'work', path: path.join(dir, 'work') }
  ])
  t.alike(
    Ssh.host.identities({}, { dotSsh: dir, home: path.dirname(dir) }).map((key) => key.path),
    [`~/${path.basename(dir)}/id_ed25519`, `~/${path.basename(dir)}/work`],
    'a key under the home directory reads as ~/...'
  )

  const probed = Ssh.host.probe({ dotSsh: dir })
  t.alike(probed.dotSsh, { dir, config: path.join(dir, 'config') })
  t.is(Ssh.host.probe({}).dotSsh, null, 'without the flag, ssh reads ~/.ssh as always')

  const facts = { platform: 'linux', facts: { ssh: { available: true, dotSsh: probed.dotSsh } } }
  t.is(
    launch.compile(steps(ssh('starwars')), facts).command,
    `ssh -F ${path.join(dir, 'config')} -o UserKnownHostsFile=${path.join(dir, 'known_hosts')} starwars`
  )
  t.alike(Ssh._test.dotSshArgs({ dir, config: '' }, 'linux').slice(0, 2), ['-F', '/dev/null'])

  const calls = []
  await Ssh.host.listDirectory(
    { host: 'starwars' },
    {
      dotSsh: dir,
      execFile: (file, args, opts, done) => {
        calls.push(args)
        done(null, '/home/alice\n', '')
      }
    }
  )
  t.alike(calls[0].slice(0, 4), [
    '-F',
    path.join(dir, 'config'),
    '-o',
    `UserKnownHostsFile=${path.join(dir, 'known_hosts')}`
  ])
})

test('remote browsing: the field narrows the names shown', (t) => {
  const { filterTerm } = require('../renderer/plugins/remote-directory.js')._test
  t.is(filterTerm('', '/home/me'), '')
  t.is(filterTerm('~', '/home/me'), '')
  t.is(filterTerm('/home/me', '/home/me'), '', 'the directory itself: everything')
  t.is(filterTerm('/home/me/', '/home/me'), '')
  t.is(filterTerm('/home/me/pro', '/home/me'), 'pro', 'typed after the slash')
  t.is(filterTerm('/home/me/a/b', '/home/me'), '', 'deeper than the list: no narrowing')
  t.is(filterTerm('/e', '/'), 'e')
  t.is(filterTerm('pro', '/home/me'), 'pro', 'a bare name')
  t.is(filterTerm('~/src/zb', '/home/me'), 'zb', 'anything else: its last part')
})

test('the main process runs only what a plugin declared', async (t) => {
  const env = await pluginHost.env()
  t.is(env.platform, process.platform)
  t.is(typeof env.facts.ssh.available, 'boolean')
  await t.exception(
    pluginHost.call({ plugin: 'ssh', method: 'constructor' }),
    /Unknown launch plugin call/
  )
  await t.exception(
    pluginHost.call({ plugin: 'ssh', method: 'toString' }),
    /Unknown launch plugin call/
  )
  await t.exception(
    pluginHost.call({ plugin: 'cd', method: 'probe' }),
    /Unknown launch plugin call/
  )
  await t.exception(
    pluginHost.call({ plugin: '__proto__', method: 'x' }),
    /Unknown launch plugin call/
  )
  await t.exception(
    pluginHost.call({ plugin: 'ssh', method: 'listDirectory', args: { host: '' } }),
    /needs a host/
  )
})

test('the renderer loads the plugin files Node does, in the same order', (t) => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8')
  const index = fs.readFileSync(path.join(__dirname, '../renderer/plugins/index.js'), 'utf8')
  const scripts = Array.from(html.matchAll(/<script src="plugins\/([^"]+)"/g), (m) => m[1])
  const required = Array.from(index.matchAll(/require\('\.\/([^']+)'\)/g), (m) => m[1])
  t.alike(scripts, [...required, 'steps-editor.js'])
  t.ok(
    html.indexOf('plugins/steps-editor.js') < html.indexOf('<script src="app.js"'),
    'before app.js, which uses them'
  )
  for (const file of fs.readdirSync(path.join(__dirname, '../renderer/plugins'))) {
    if (file === 'index.js') continue
    t.ok(scripts.includes(file), `${file} is loaded`)
  }
})
