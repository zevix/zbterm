// The main-process half of the launch plugins (renderer/plugins/): a plugin's
// static `host` object holds the functions that need Node - probing for a
// binary, listing a remote directory - and the renderer reaches them through
// `app.launchPlugin` (electron/main.js).
const launch = require('../renderer/plugins')

function hostOf(id) {
  const Plugin = typeof id === 'string' ? launch.plugin(id) : null
  return Plugin && Plugin.host ? Plugin.host : null
}

// What the plugins' main-process functions are told about this run:
// { dotSsh } is --custom-dot-ssh-path. Set once, before the first call.
let settings = {}
function configure(next = {}) {
  settings = { ...next }
  envPromise = null
}

// { platform, facts }: what `isAvailable` may ask about this machine. Probed
// once; a plugin whose probe throws just has no facts.
let envPromise = null
function env() {
  if (!envPromise) {
    envPromise = (async () => {
      const facts = {}
      for (const Plugin of launch.plugins()) {
        if (!Plugin.host || typeof Plugin.host.probe !== 'function') continue
        try {
          facts[Plugin.id] = await Plugin.host.probe({ ...settings })
        } catch {}
      }
      return { platform: process.platform, facts }
    })()
  }
  return envPromise
}

// Only a function the plugin itself declared, by its own name: never an
// inherited one.
async function call(request = {}) {
  const host = hostOf(request.plugin)
  const method = typeof request.method === 'string' ? request.method : ''
  if (
    !host ||
    !Object.prototype.hasOwnProperty.call(host, method) ||
    typeof host[method] !== 'function'
  ) {
    throw new Error(`Unknown launch plugin call: ${request.plugin}.${method}`)
  }
  const args = request.args && typeof request.args === 'object' ? request.args : {}
  return await host[method](args, { ...settings })
}

module.exports = { configure, env, call }
