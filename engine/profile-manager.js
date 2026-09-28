const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const { VERSION } = require('./schema')
const { EngineError, CODES } = require('./errors')

class ProfileManager {
  constructor(root) {
    this.root = root
    this.registryPath = path.join(root, 'profiles.json')
  }

  async ready() {
    await fs.promises.mkdir(this.root, { recursive: true })
    const registry = await this._readRegistry()
    if (!registry.profiles.length) {
      await this.createProfile({ name: 'Default', id: 'default' })
    }
  }

  async listProfiles() {
    await this.ready()
    const registry = await this._syncRegistryWithDirs()
    const profiles = []
    for (const profile of registry.profiles) {
      const profilePath = this.resolveProfilePath(profile.id)
      profiles.push({
        ...profile,
        path: profilePath,
        locked: await isLocked(profilePath)
      })
    }
    return { version: VERSION, lastUsedProfileId: registry.lastUsedProfileId, profiles }
  }

  async createProfile(opts = {}) {
    const registry = await this._readRegistry()
    const id = sanitizeId(opts.id || crypto.randomBytes(8).toString('hex'))
    if (registry.profiles.some((profile) => profile.id === id)) {
      throw new EngineError(CODES.E_INTERNAL, 'Profile already exists')
    }
    const now = Date.now()
    const profile = {
      version: VERSION,
      id,
      name: opts.name || `Profile ${registry.profiles.length + 1}`,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null
    }
    registry.profiles.push(profile)
    registry.lastUsedProfileId = registry.lastUsedProfileId || id
    await fs.promises.mkdir(this.resolveProfilePath(id), { recursive: true })
    await this._writeRegistry(registry)
    return { ...profile, path: this.resolveProfilePath(id), locked: false }
  }

  async renameProfile(id, name) {
    const registry = await this._readRegistry()
    const profile = findProfile(registry, id)
    profile.name = String(name || '').trim() || profile.name
    profile.updatedAt = Date.now()
    await this._writeRegistry(registry)
    return profile
  }

  async deleteEmptyProfile(id) {
    const registry = await this._readRegistry()
    const profile = findProfile(registry, id)
    const profilePath = this.resolveProfilePath(id)
    if (await isLocked(profilePath)) {
      throw new EngineError(CODES.E_INTERNAL, 'Profile is currently running')
    }
    const names = await fs.promises.readdir(profilePath).catch((err) => {
      if (err.code === 'ENOENT') return []
      throw err
    })
    const nonLock = names.filter((name) => name !== 'lock')
    if (nonLock.length) throw new EngineError(CODES.E_INTERNAL, 'Profile is not empty')
    registry.profiles = registry.profiles.filter((item) => item.id !== profile.id)
    if (registry.lastUsedProfileId === id) {
      registry.lastUsedProfileId = registry.profiles[0]?.id || null
    }
    await fs.promises.rm(profilePath, { recursive: true, force: true })
    await this._writeRegistry(registry)
    return true
  }

  async markLastUsed(id) {
    const registry = await this._readRegistry()
    const profile = findProfile(registry, id)
    profile.lastUsedAt = Date.now()
    profile.updatedAt = profile.lastUsedAt
    registry.lastUsedProfileId = id
    await this._writeRegistry(registry)
    return profile
  }

  async resolveProfileId(value) {
    const requested = String(value || '').trim()
    if (!requested) throw new EngineError(CODES.E_INTERNAL, 'Profile is required')
    const registry = await this._syncRegistryWithDirs()
    const exactId = registry.profiles.find((profile) => profile.id === requested)
    if (exactId) return exactId.id

    const exactNameMatches = registry.profiles.filter((profile) => profile.name === requested)
    if (exactNameMatches.length === 1) return exactNameMatches[0].id
    if (exactNameMatches.length > 1) {
      throw new EngineError(CODES.E_INTERNAL, `Profile name is ambiguous: ${requested}`)
    }

    const lower = requested.toLowerCase()
    const foldedNameMatches = registry.profiles.filter(
      (profile) => String(profile.name || '').toLowerCase() === lower
    )
    if (foldedNameMatches.length === 1) return foldedNameMatches[0].id
    if (foldedNameMatches.length > 1) {
      throw new EngineError(CODES.E_INTERNAL, `Profile name is ambiguous: ${requested}`)
    }

    throw new EngineError(CODES.E_INTERNAL, `Profile does not exist: ${requested}`)
  }

  resolveProfilePath(id) {
    return path.join(this.root, sanitizeId(id))
  }

  async acquireLock(id) {
    const profilePath = this.resolveProfilePath(id)
    await fs.promises.mkdir(profilePath, { recursive: true })
    const lock = new ProfileLock(profilePath)
    await lock.acquire()
    await this.markLastUsed(id)
    return lock
  }

  async acquirePathLock(profilePath) {
    const lock = new ProfileLock(profilePath)
    await lock.acquire()
    return lock
  }

  async _readRegistry() {
    try {
      const registry = JSON.parse(await fs.promises.readFile(this.registryPath, 'utf8'))
      if (!registry || registry.version !== VERSION || !Array.isArray(registry.profiles)) {
        throw new EngineError(CODES.E_CORRUPT, 'Unsupported profile registry version')
      }
      return registry
    } catch (err) {
      if (err.code === 'ENOENT') return { version: VERSION, lastUsedProfileId: null, profiles: [] }
      if (err instanceof SyntaxError) {
        throw new EngineError(CODES.E_CORRUPT, 'Corrupt profile registry')
      }
      throw err
    }
  }

  async _writeRegistry(registry) {
    await fs.promises.mkdir(this.root, { recursive: true })
    const tmp = `${this.registryPath}.${process.pid}.${Date.now()}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(registry, null, 2))
    await fs.promises.rename(tmp, this.registryPath)
  }

  async _syncRegistryWithDirs() {
    const registry = await this._readRegistry()
    const dirs = await this._readProfileDirs()
    const byId = new Map(registry.profiles.map((profile) => [profile.id, profile]))
    const next = []
    let changed = false

    for (const id of dirs) {
      const existing = byId.get(id)
      if (existing) {
        next.push(existing)
        continue
      }
      const now = Date.now()
      next.push({
        version: VERSION,
        id,
        name: id === 'default' ? 'Default' : id,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null
      })
      changed = true
    }

    if (next.length !== registry.profiles.length) changed = true
    if (
      !registry.lastUsedProfileId ||
      !next.some((profile) => profile.id === registry.lastUsedProfileId)
    ) {
      registry.lastUsedProfileId = next[0]?.id || null
      changed = true
    }
    registry.profiles = next
    if (changed) await this._writeRegistry(registry)
    return registry
  }

  async _readProfileDirs() {
    await fs.promises.mkdir(this.root, { recursive: true })
    const entries = await fs.promises.readdir(this.root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => sanitizeId(entry.name))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  }
}

// The lock is a directory, not a file: bare-fs's `fs.promises.open(path,
// 'wx')` does not enforce O_EXCL (verified directly - a second `wx` open
// against an existing path silently succeeds instead of throwing EEXIST),
// so it cannot be used as the exclusivity primitive once ProfileManager
// runs in the worker under Bare (docs/PHASE2-WORK-PLAN.md "Profile lock
// ownership"). `fs.promises.mkdir` (non-recursive) reliably throws EEXIST
// on both Node and Bare, so directory creation is the exclusivity gate;
// the lock's payload lives in a file inside that directory.
function lockDir(profilePath) {
  return path.join(profilePath, 'lock')
}

function lockOwnerFile(profilePath) {
  return path.join(lockDir(profilePath), 'owner.json')
}

class ProfileLock {
  constructor(profilePath) {
    this.profilePath = profilePath
    this.dir = lockDir(profilePath)
    this.ownerFile = lockOwnerFile(profilePath)
    this.held = false
  }

  async acquire() {
    await fs.promises.mkdir(this.profilePath, { recursive: true })
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await fs.promises.mkdir(this.dir)
        await fs.promises.writeFile(this.ownerFile, JSON.stringify(lockPayload()))
        this.held = true
        return
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
      }

      const existing = await readLock(this.ownerFile)
      if (!existing) {
        await delay(25 * (attempt + 1))
        continue
      }
      const ownerAlive = isProcessAlive(existing.ownerPid)
      const workerAlive = isProcessAlive(existing.pid)
      const mine = existing.ownerPid === ownerPid()
      if (!mine && (ownerAlive || workerAlive)) {
        throw new EngineError(CODES.E_INTERNAL, 'Profile is already running')
      }
      if (mine && workerAlive) {
        throw new EngineError(CODES.E_INTERNAL, 'Profile is already running')
      }
      if (mine && !workerAlive) {
        await fs.promises.rm(this.dir, { recursive: true, force: true })
        continue
      }
      if (!ownerAlive && !workerAlive) {
        await fs.promises.rm(this.dir, { recursive: true, force: true })
        continue
      }
    }
    const existing = await readLock(this.ownerFile)
    if (existing) throw new EngineError(CODES.E_INTERNAL, 'Profile is already running')
    try {
      await fs.promises.rmdir(this.dir)
      await fs.promises.mkdir(this.dir)
      await fs.promises.writeFile(this.ownerFile, JSON.stringify(lockPayload()))
      this.held = true
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') {
        throw new EngineError(CODES.E_INTERNAL, 'Profile is already running')
      }
      throw err
    }
  }

  async release() {
    if (!this.held) return
    this.held = false
    await fs.promises.rm(this.dir, { recursive: true, force: true })
  }
}

async function isLocked(profilePath) {
  const existing = await readLock(lockOwnerFile(profilePath))
  if (!existing) return false
  if (isProcessAlive(existing.ownerPid) || isProcessAlive(existing.pid)) return true
  await fs.promises.rm(lockDir(profilePath), { recursive: true, force: true }).catch(() => {})
  return false
}

async function readLock(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ownerPid, not process.pid, is what staleness checks key on: it is the
// long-lived process (the Electron shell, via its worker child's ppid)
// that actually owns a profile for as long as the app is running, not the
// worker subprocess that respawns on every crash. See
// docs/DESIGN-SWARM-AND-WORKER.md "Additional Bare-compatibility findings"
// for why keying on the worker's own pid instead created a real lock-
// staleness race across a crash/respawn cycle.
function ownerPid() {
  return process.ppid || process.pid
}

function lockPayload() {
  return {
    version: VERSION,
    pid: process.pid,
    ownerPid: ownerPid(),
    hostname: os.hostname(),
    createdAt: Date.now()
  }
}

function findProfile(registry, id) {
  const profile = registry.profiles.find((item) => item.id === id)
  if (!profile) throw new EngineError(CODES.E_INTERNAL, 'Profile does not exist')
  return profile
}

function sanitizeId(id) {
  return (
    String(id)
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .slice(0, 80) || 'default'
  )
}

module.exports = { ProfileManager, ProfileLock }
