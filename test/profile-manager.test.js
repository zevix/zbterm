const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const test = require('brittle')

const { ProfileManager } = require('../engine/profile-manager')

test('profile manager creates isolated profile paths and tracks last used', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const manager = new ProfileManager(dir)
  await manager.ready()
  const second = await manager.createProfile({ name: 'Second' })
  await manager.markLastUsed(second.id)
  const list = await manager.listProfiles()

  t.is(list.profiles.length, 2)
  t.is(list.lastUsedProfileId, second.id)
  t.ok(second.path.endsWith(second.id))
})

test('profile manager resolves profile selector by id or name', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const manager = new ProfileManager(dir)
  await manager.ready()
  const work = await manager.createProfile({ id: 'work-id', name: 'Work Laptop' })

  t.is(await manager.resolveProfileId(work.id), work.id)
  t.is(await manager.resolveProfileId('Work Laptop'), work.id)
  t.is(await manager.resolveProfileId('work laptop'), work.id)
})

test('profile manager gives ids precedence over duplicate names', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const manager = new ProfileManager(dir)
  await manager.ready()
  await manager.createProfile({ id: 'alpha', name: 'Shared' })
  await manager.createProfile({ id: 'Shared', name: 'Other' })
  await manager.createProfile({ id: 'bravo', name: 'Shared' })

  t.is(await manager.resolveProfileId('Shared'), 'Shared')
  await t.exception(() => manager.resolveProfileId('shared'), /ambiguous/i)
})

test('profile lock disables a running profile and releases cleanly', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const manager = new ProfileManager(dir)
  await manager.ready()
  const lock = await manager.acquireLock('default')
  const locked = await manager.listProfiles()
  t.is(locked.profiles.find((p) => p.id === 'default').locked, true)
  await lock.release()
  const unlocked = await manager.listProfiles()
  t.is(unlocked.profiles.find((p) => p.id === 'default').locked, false)
})

test('profile lock is reclaimable by the same owner only after the worker is gone', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const manager = new ProfileManager(dir)
  await manager.ready()
  const profilePath = manager.resolveProfilePath('default')
  const lockDir = path.join(profilePath, 'lock')
  const ownerFile = path.join(lockDir, 'owner.json')

  await fs.promises.mkdir(lockDir, { recursive: true })
  await fs.promises.writeFile(
    ownerFile,
    JSON.stringify({
      version: 2,
      pid: 99999999,
      ownerPid: process.ppid || process.pid,
      hostname: 'same-owner',
      createdAt: Date.now()
    })
  )

  const manager2 = new ProfileManager(dir)
  const lock2 = await manager2.acquireLock('default')
  t.ok(lock2.held, 'same owner can reclaim once the recorded worker is dead')
  await lock2.release()
})

test('profile lock remains locked when owner is dead but worker still lives', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const manager = new ProfileManager(dir)
  await manager.ready()

  const profilePath = manager.resolveProfilePath('default')
  const lockDir = path.join(profilePath, 'lock')
  const ownerFile = path.join(lockDir, 'owner.json')

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'])
  t.teardown(() => child.kill())
  await new Promise((resolve) => child.once('spawn', resolve))

  await fs.promises.mkdir(lockDir, { recursive: true })
  await fs.promises.writeFile(
    ownerFile,
    JSON.stringify({
      version: 2,
      pid: child.pid,
      ownerPid: 99999999,
      hostname: 'orphan-worker',
      createdAt: Date.now()
    })
  )

  const list = await manager.listProfiles()
  t.is(list.profiles.find((p) => p.id === 'default').locked, true)
  await t.exception(() => manager.acquireLock('default'), /already running/i)
})

test('profile lock rejects a different, still-alive owner (the race the fix closes)', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const manager = new ProfileManager(dir)
  await manager.ready()

  const profilePath = manager.resolveProfilePath('default')
  const lockDir = path.join(profilePath, 'lock')
  const ownerFile = path.join(lockDir, 'owner.json')

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'])
  t.teardown(() => child.kill())
  await new Promise((resolve) => child.once('spawn', resolve))

  await fs.promises.mkdir(lockDir, { recursive: true })
  await fs.promises.writeFile(
    ownerFile,
    JSON.stringify({
      version: 2,
      pid: child.pid,
      ownerPid: child.pid,
      hostname: 'other-host',
      createdAt: Date.now()
    })
  )

  await t.exception(
    () => manager.acquireLock('default'),
    /already running/i,
    'a lock owned by a different live process is not stolen'
  )
})

function temp() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-profile-test-'))
}
