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

  // The ssh arguments for a non-interactive call: it must never stop to ask
  // for a password or a host key, since nobody could answer.
  function batchArgs(target, script, home) {
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
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

  class Ssh extends launch.LaunchPlugin {
    static id = 'ssh'
    static title = 'SSH'
    static icon = 'fa-server'

    // Main process only.
    static host = {
      // Is there an `ssh` to run?
      probe() {
        const fs = require('fs')
        const path = require('path')
        const names = process.platform === 'win32' ? ['ssh.exe', 'ssh'] : ['ssh']
        const dirs = String(process.env.PATH || '').split(path.delimiter)
        const found = dirs.some(
          (dir) => dir && names.some((name) => fs.existsSync(path.join(dir, name)))
        )
        return { available: found }
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
        return new Promise((resolve, reject) => {
          execFile(
            'ssh',
            batchArgs(target, listScript(path), home),
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
      const host = ui.input({
        name: 'ssh-host',
        placeholder: 'user@host',
        value: this.config.host,
        onInput: set('host')
      })
      const port = ui.input({
        name: 'ssh-port',
        placeholder: 'port 22',
        value: this.config.port,
        onInput: set('port'),
        className: 'launch-input-short'
      })
      const identity = ui.input({
        name: 'ssh-identity',
        placeholder: 'identity file (optional)',
        value: this.config.identity,
        onInput: set('identity')
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

  Ssh._test = { listScript, parseListing, batchArgs, listFailure }

  launch.register(Ssh)
  if (node) module.exports = Ssh
})()
