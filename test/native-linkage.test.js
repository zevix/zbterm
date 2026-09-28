const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')

const linkage = require('../bin/lib/native-linkage')

const REPO_ROOT = path.join(__dirname, '..')

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writePackage(dir, json) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json))
  return dir
}

// A real ELF with a real DT_NEEDED beats a hand-rolled fixture: the whole
// point of the parser is to agree with ld.so on actual binaries. Any dynamic
// executable on the box will do.
function someElf() {
  for (const candidate of [process.execPath, '/bin/ls', '/usr/bin/ls']) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

test('native-linkage: parses DT_NEEDED out of a real ELF', async (t) => {
  const elf = someElf()
  if (!elf || process.platform !== 'linux') {
    t.pass('skipped: needs a Linux ELF')
    return
  }

  const needed = linkage.neededLibrariesOf(elf)
  t.ok(needed.length > 0, elf + ' has DT_NEEDED entries')
  t.ok(
    needed.some((lib) => /^libc\.so/.test(lib) || /^ld-/.test(lib)),
    'libc is among them: ' + needed.join(', ')
  )
})

test('native-linkage: non-ELF input yields no libraries rather than throwing', async (t) => {
  const dir = tmpdir(t, 'zbterm-linkage-junk-')
  const notElf = path.join(dir, 'mach-o-ish.node')
  fs.writeFileSync(notElf, Buffer.from('cffaedfe000000000000', 'hex'))

  t.alike(linkage.neededLibrariesOf(notElf), [])
  t.alike(linkage.neededLibrariesOf(path.join(dir, 'absent.node')), [])
  t.alike(linkage.neededLibraries(Buffer.alloc(0)), [])
})

test('native-linkage: scan follows the dependency graph and flags libnode', async (t) => {
  const elf = someElf()
  if (!elf || process.platform !== 'linux') {
    t.pass('skipped: needs a Linux ELF')
    return
  }
  // The fixture has to be an addon that genuinely links libnode, which only a
  // shared-library Node build provides. Without one there is nothing honest to
  // assert, so the positive case is skipped rather than faked.
  const shared = [process.execPath, '/usr/bin/node'].find((bin) => {
    try {
      return linkage.neededLibrariesOf(bin).some((lib) => /^libnode\.so/.test(lib))
    } catch {
      return false
    }
  })

  const root = tmpdir(t, 'zbterm-linkage-scan-')
  writePackage(root, { name: 'root', dependencies: { clean: '*', dirty: '*' } })
  const clean = writePackage(path.join(root, 'node_modules', 'clean'), { name: 'clean' })
  const dirty = writePackage(path.join(root, 'node_modules', 'dirty'), { name: 'dirty' })
  // Unreachable from root's dependencies, so it must never be scanned.
  const stray = writePackage(path.join(root, 'node_modules', 'stray'), { name: 'stray' })

  fs.copyFileSync(elf, path.join(clean, 'clean.node'))
  if (shared) {
    fs.copyFileSync(shared, path.join(dirty, 'pty.node'))
    fs.copyFileSync(shared, path.join(stray, 'stray.node'))
  }

  const offenders = linkage.scan({ root, platform: 'linux' })

  if (!shared) {
    t.pass('skipped positive case: no shared-libnode binary on this machine')
  } else {
    t.is(offenders.length, 1, 'exactly the reachable offender')
    t.is(offenders[0].file, path.join(dirty, 'pty.node'))
    t.ok(offenders[0].needed.every((lib) => /^libnode\.so/.test(lib)))
  }

  t.absent(
    offenders.some((o) => o.file.includes(path.sep + 'clean' + path.sep)),
    'a cleanly linked addon is not flagged'
  )
  t.absent(
    offenders.some((o) => o.file.includes(path.sep + 'stray' + path.sep)),
    'packages outside the dependency graph are never scanned'
  )
})

test('native-linkage: scan is a no-op off Linux', async (t) => {
  t.alike(linkage.scan({ root: REPO_ROOT, platform: 'darwin' }), [])
  t.alike(linkage.scan({ root: REPO_ROOT, platform: 'win32' }), [])
})

test('native-linkage: the installed tree is clean', async (t) => {
  const offenders = linkage.scan({ root: REPO_ROOT })
  t.alike(
    offenders.map((o) => path.relative(REPO_ROOT, o.file) + ' -> ' + o.needed.join(', ')),
    [],
    'no addon in node_modules links the host Node runtime'
  )
})

test('native-linkage: describe names every offender and the escape hatch', async (t) => {
  const text = linkage.describe([
    { file: '/x/node_modules/n/pty.node', needed: ['libnode.so.115'] }
  ])
  t.ok(text.includes('pty.node'))
  t.ok(text.includes('libnode.so.115'))
  t.ok(text.includes('SIGSEGV'))
  t.ok(text.includes('ZBTERM_ALLOW_HOST_NODE_LINKAGE=1'))
})
