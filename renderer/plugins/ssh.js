// "SSH": runs everything after it on another machine. The step opens an `ssh`
// scope, so the steps that follow belong to the remote shell: "Shell Command"
// runs there, "Change Remote Directory" becomes available, and the local
// "Change Directory" no longer is.
;(() => {
  const node = typeof module === 'object' && module && module.exports
  const launch = node ? require('./launch-core.js') : window.zbtermLaunch

  const LIST_TIMEOUT_MS = 20000
  // The remote `cd` failed (as opposed to ssh itself failing, which exits 255).
  const EXIT_NO_DIRECTORY = 66

  // `host` is a destination ssh takes as one argument: `host`, `user@host` or
  // a Host alias from ~/.ssh/config. A leading `-` would be read as an option.
  function hostError(host) {
    if (!host) return 'SSH needs a host'
    if (/^-/.test(host) || /\s/.test(host)) return 'The SSH host is not valid'
    return ''
  }

  function portError(port) {
    if (!port) return ''
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      return 'The SSH port must be a number from 1 to 65535'
    }
    return ''
  }

  function targetError(target) {
    return hostError(target.host) || portError(target.port)
  }

  // The script whose output `parseListing` reads: the directory's real path,
  // then its entries, directories (and links to them) ending in `/`.
  function listScript(path) {
    const dir = String(path || '').trim()
    const cd =
      dir && dir !== '~'
        ? `cd ${launch.quotePath(dir, 'posix')} || exit ${EXIT_NO_DIRECTORY}; `
        : ''
    return `${cd}pwd && ls -1ApL 2>/dev/null; true`
  }

  function parseListing(stdout) {
    const lines = String(stdout).split('\n')
    const path = (lines.shift() || '').trim()
    const directories = lines
      .filter((line) => line.endsWith('/') && line !== './' && line !== '../')
      .map((line) => line.slice(0, -1))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    return { path, directories }
  }

  // With --custom-dot-ssh-path, ssh reads that directory's `config` and
  // `known_hosts` in place of ~/.ssh's (ssh itself would read the real
  // ~/.ssh: it finds the home directory from the user database, not $HOME).
  // `dotSsh`: the probe's fact, { dir, config } or null.
  function dotSshArgs(dotSsh, platform) {
    if (!dotSsh || !dotSsh.dir) return []
    const sep = platform === 'win32' ? '\\' : '/'
    const nothing = platform === 'win32' ? 'NUL' : '/dev/null'
    return [
      '-F',
      dotSsh.config || nothing,
      '-o',
      `UserKnownHostsFile=${dotSsh.dir.replace(/[\\/]+$/, '')}${sep}known_hosts`
    ]
  }

  // The ssh arguments for a non-interactive call: it must never stop to ask
  // for a password or a host key, since nobody could answer.
  function batchArgs(target, script, home, dotSsh) {
    const args = [...dotSshArgs(dotSsh, process.platform), '-o', 'BatchMode=yes']
    args.push('-o', 'ConnectTimeout=10')
    if (target.port) args.push('-p', target.port)
    if (target.identity) {
      const identity = target.identity
      args.push('-i', /^~(?=$|[\\/])/.test(identity) && home ? home + identity.slice(1) : identity)
    }
    args.push('--', target.host, script)
    return args
  }

  function listFailure(target, path, err, stderr) {
    const lines = String(stderr || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    let reason = lines.length ? lines[lines.length - 1] : (err && err.message) || 'ssh failed'
    if (err && err.code === 'ENOENT') reason = 'ssh is not installed'
    else if (err && err.killed) reason = 'the connection timed out'
    else if (err && err.code === EXIT_NO_DIRECTORY) reason = `no such directory: ${path}`
    else if (/permission denied/i.test(reason)) {
      reason += ' - browsing needs a key or an SSH agent; the path can still be typed'
    } else if (/host key verification failed/i.test(reason)) {
      reason += ' - connect once from a terminal to accept the host key'
    }
    return new Error(`Could not browse ${target.host}: ${reason}`)
  }

  // ---- the ssh directory (main process) -----------------------------------

  // The directory that stands for ~/.ssh: --custom-dot-ssh-path, or the
  // real one. { dir, config (its `config` file, '' when there is none),
  // custom }.
  function dotSshOf(opts = {}) {
    const fs = require('fs')
    const path = require('path')
    const custom = !!opts.dotSsh
    const dir = custom
      ? path.resolve(opts.dotSsh)
      : path.join(opts.home || require('os').homedir(), '.ssh')
    const config = path.join(dir, 'config')
    let hasConfig = false
    try {
      hasConfig = fs.statSync(config).isFile()
    } catch {}
    return { dir, config: hasConfig ? config : '', custom }
  }

  // `~/...` for a file under the home directory, so the field shows what a
  // person would type; any other path as it is.
  function displayPath(file, home) {
    const path = require('path')
    const root = String(home || '').replace(/[\\/]+$/, '')
    if (root && file.startsWith(root + path.sep)) return `~/${file.slice(root.length + 1)}`
    return file
  }

  // `*` and `?` in the last part of an Include path.
  function globFiles(pattern) {
    const fs = require('fs')
    const path = require('path')
    const dir = path.dirname(pattern)
    const base = path.basename(pattern)
    if (!/[*?]/.test(base)) return [pattern]
    const escaped = base.replace(/[.+^$()|[\]{}\\]/g, '\\$&')
    const re = new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => re.test(name))
        .sort()
        .map((name) => path.join(dir, name))
    } catch {
      return []
    }
  }

  // The Host names an ssh config offers, in file order: each one a name ssh
  // takes as it is (no patterns), with the HostName and User it sets.
  // Follows Include (relative paths are under the ssh directory).
  function configHosts(dotSsh, home) {
    const fs = require('fs')
    const path = require('path')
    const found = new Map()
    const seen = new Set()
    const read = (file, depth) => {
      if (depth > 8 || seen.has(file)) return
      seen.add(file)
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        return
      }
      let current = []
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim()
        const match = /^(\S+?)\s*(?:=\s*|\s+)(.*)$/.exec(line)
        if (!match) continue
        const key = match[1].toLowerCase()
        const value = match[2].trim().replace(/^"(.*)"$/, '$1')
        if (key === 'host') {
          current = value
            .split(/\s+/)
            .filter((name) => name && !/[*?!]/.test(name))
            .map((name) => {
              if (!found.has(name)) found.set(name, { name, hostName: '', user: '' })
              return found.get(name)
            })
        } else if (key === 'match') {
          current = []
        } else if (key === 'hostname' || key === 'user') {
          const field = key === 'hostname' ? 'hostName' : 'user'
          for (const entry of current) if (!entry[field]) entry[field] = value
        } else if (key === 'include') {
          for (const part of value.split(/\s+/)) {
            let target = part.replace(/^~(?=[\\/])/, home)
            if (!path.isAbsolute(target)) target = path.join(dotSsh.dir, target)
            for (const included of globFiles(target)) read(included, depth + 1)
          }
        }
      }
    }
    if (dotSsh.config) read(dotSsh.config, 0)
    return [...found.values()]
  }

  // The private keys in the ssh directory: a file with a `.pub` beside it,
  // or one named like ssh's own defaults (id_*).
  function keyFiles(dotSsh, home) {
    const fs = require('fs')
    const path = require('path')
    let names
    try {
      names = fs.readdirSync(dotSsh.dir)
    } catch {
      return []
    }
    const present = new Set(names)
    return names
      .filter(
        (name) => !name.endsWith('.pub') && !/^(config|known_hosts|authorized_keys)/.test(name)
      )
      .filter((name) => present.has(`${name}.pub`) || /^id_/.test(name))
      .filter((name) => {
        try {
          return fs.statSync(path.join(dotSsh.dir, name)).isFile()
        } catch {
          return false
        }
      })
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, path: displayPath(path.join(dotSsh.dir, name), home) }))
  }

  class Ssh extends launch.LaunchPlugin {
    static id = 'ssh'
    static title = 'SSH'
    static icon = 'fa-server'

    // Main process only.
    static host = {
      // Is there an `ssh` to run? And which directory stands for ~/.ssh
      // (`dotSsh`, only with --custom-dot-ssh-path: the launch adds it to
      // the ssh command).
      probe(settings = {}) {
        const fs = require('fs')
        const path = require('path')
        const names = process.platform === 'win32' ? ['ssh.exe', 'ssh'] : ['ssh']
        const dirs = String(process.env.PATH || '').split(path.delimiter)
        const found = dirs.some(
          (dir) => dir && names.some((name) => fs.existsSync(path.join(dir, name)))
        )
        const dotSsh = settings.dotSsh ? dotSshOf(settings) : null
        return {
          available: found,
          dotSsh: dotSsh ? { dir: dotSsh.dir, config: dotSsh.config } : null
        }
      },

      // The Host names of the ssh config, for the host field's list:
      // [{ name, hostName, user }].
      hosts(args = {}, opts = {}) {
        const home = opts.home || require('os').homedir()
        return configHosts(dotSshOf(opts), home)
      },

      // The private keys in the ssh directory, for the identity field's
      // list: [{ name, path }].
      identities(args = {}, opts = {}) {
        const home = opts.home || require('os').homedir()
        return keyFiles(dotSshOf(opts), home)
      },

      // The directories under `path` on the target (the remote home when
      // empty): { path, directories }. `opts.execFile` is the tests' seam.
      listDirectory(args = {}, opts = {}) {
        const target = new Ssh(args).getConfig()
        const path = typeof args.path === 'string' ? args.path.trim() : ''
        const invalid = targetError(target)
        if (invalid) return Promise.reject(new Error(invalid))
        const execFile = opts.execFile || require('child_process').execFile
        const home = opts.home || require('os').homedir()
        const dotSsh = opts.dotSsh ? dotSshOf(opts) : null
        return new Promise((resolve, reject) => {
          execFile(
            'ssh',
            batchArgs(target, listScript(path), home, dotSsh),
            { timeout: LIST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
              if (err) return reject(listFailure(target, path, err, stderr))
              const listing = parseListing(stdout)
              if (!listing.path) return reject(listFailure(target, path, null, stderr))
              resolve(listing)
            }
          )
        })
      }
    }

    static isAvailable(ctx) {
      // One hop: a second SSH inside the first would need remote browsing
      // through a jump host. An ssh_config ProxyJump alias covers that case.
      if (ctx.scope.kind !== 'local') return false
      return !(ctx.facts.ssh && ctx.facts.ssh.available === false)
    }

    static defaults() {
      return { host: '', port: '', identity: '' }
    }

    getUI(ui) {
      const set = (key) => (value) => {
        this.config[key] = value.trim()
      }
      const host = ui.combo({
        name: 'ssh-host',
        placeholder: 'user@host or ssh config',
        value: this.config.host,
        onInput: set('host'),
        // The ssh config's Host names, read once per dialog.
        items: () =>
          ui.host('ssh', 'hosts', {}).then((hosts) =>
            hosts.map((entry) => ({
              value: entry.name,
              detail: [entry.user, entry.hostName].filter(Boolean).join('@')
            }))
          )
      })
      const port = ui.input({
        name: 'ssh-port',
        placeholder: 'port 22',
        value: this.config.port,
        onInput: set('port'),
        className: 'launch-input-short'
      })
      const identity = ui.combo({
        name: 'ssh-identity',
        placeholder: 'identity file (optional)',
        value: this.config.identity,
        onInput: set('identity'),
        // The keys in the ssh directory, listed by file name.
        items: () =>
          ui
            .host('ssh', 'identities', {})
            .then((keys) => keys.map((key) => ({ value: key.path, label: key.name })))
      })
      return ui.stack(ui.row(host, port), identity)
    }

    validate(ctx) {
      const invalid = targetError(this.config)
      if (invalid) return invalid
      if (ctx.unquotable(this.config.host) || ctx.unquotable(this.config.identity)) {
        return 'On Windows the SSH host and identity file cannot contain " or %'
      }
      return ''
    }

    apply(ctx) {
      const parent = ctx.scope
      const target = this.getConfig()
      const dotSsh = ctx.facts.ssh ? ctx.facts.ssh.dotSsh : null
      ctx.pushScope('ssh', {
        shell: 'posix',
        owner: this,
        // Remote steps that end on a directory keep a login shell open in it.
        interactiveShell: 'exec "$SHELL" -l',
        // What the remote steps need to reach the same machine.
        data: { target },
        close: (script) => {
          const args = ['ssh']
          if (script) args.push('-t')
          for (const arg of dotSshArgs(dotSsh, ctx.platform)) {
            args.push(arg.startsWith('-') ? arg : launch.quotePath(arg, parent.shell))
          }
          if (target.port) args.push('-p', launch.quote(target.port, parent.shell))
          if (target.identity) args.push('-i', launch.quotePath(target.identity, parent.shell))
          // validate() refuses such a host; should one get here anyway, it
          // is still a host and not an option.
          if (target.host.startsWith('-')) args.push('--')
          args.push(launch.quote(target.host, parent.shell))
          if (script) args.push(launch.quote(script, parent.shell))
          return args.join(' ')
        }
      })
    }
  }

  Ssh._test = {
    listScript,
    parseListing,
    batchArgs,
    listFailure,
    dotSshArgs,
    configHosts,
    keyFiles
  }

  launch.register(Ssh)
  if (node) module.exports = Ssh
})()
