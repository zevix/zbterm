'use strict'

// Native addons must never be linked against the host Node's shared runtime.
//
// On distros that build Node as a shared library (Debian's nodejs + libnodeNNN,
// Ubuntu, and others) /usr/include/node/common.gypi appends `-lnode` to every
// node-gyp link line, so any addon compiled from source there carries a
// DT_NEEDED on libnode.so.NNN. Loading such an addon inside Electron - which
// already has Node statically linked - makes dlopen() drag a second, complete
// Node runtime into the process; libnode's static initialisers re-register
// node's option parser against an already-initialised runtime and the process
// dies with SIGSEGV inside ld.so, before Electron boots. No stderr, no window,
// no exit message, and nothing in JS can catch it: it happens in the dynamic
// loader. Prevention is the only option, which is what this module is for.
//
// The ELF parsing here is deliberately dependency-free and does not shell out
// to readelf/ldd/objdump: this runs from a postinstall on machines that may
// have no binutils at all, and a missing tool must never be mistaken for a
// clean result.
const fs = require('fs')
const path = require('path')

const ELF_MAGIC = 0x7f454c46

const PT_LOAD = 1
const PT_DYNAMIC = 2

const DT_NULL = 0
const DT_NEEDED = 1
const DT_STRTAB = 5
const DT_STRSZ = 10

// A .node this large is not something we can usefully parse in a postinstall.
const MAX_ADDON_BYTES = 128 * 1024 * 1024

const FORBIDDEN = /^libnode\.so/

function readerFor(buf, is64, little) {
  const word = is64
    ? (off) => Number(little ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off))
    : (off) => (little ? buf.readUInt32LE(off) : buf.readUInt32BE(off))
  const half = (off) => (little ? buf.readUInt16LE(off) : buf.readUInt16BE(off))
  const word32 = (off) => (little ? buf.readUInt32LE(off) : buf.readUInt32BE(off))
  return { word, half, word32 }
}

function cstring(buf, off) {
  if (off < 0 || off >= buf.length) return ''
  const end = buf.indexOf(0, off)
  return buf.toString('utf8', off, end === -1 ? buf.length : end)
}

// Returns the DT_NEEDED entries of an ELF shared object, or [] for anything
// that is not a parseable ELF (Mach-O and PE prebuilds for other platforms
// land here too, and are correctly uninteresting).
function neededLibraries(buf) {
  if (buf.length < 64 || buf.readUInt32BE(0) !== ELF_MAGIC) return []

  const is64 = buf[4] === 2
  const little = buf[5] === 1
  if (buf[4] !== 1 && buf[4] !== 2) return []
  if (buf[5] !== 1 && buf[5] !== 2) return []

  const { word, half, word32 } = readerFor(buf, is64, little)

  const phoff = is64 ? word(0x20) : word32(0x1c)
  const phentsize = is64 ? half(0x36) : half(0x2a)
  const phnum = is64 ? half(0x38) : half(0x2c)
  if (!phoff || !phentsize || !phnum) return []
  if (phoff + phentsize * phnum > buf.length) return []

  const loads = []
  let dynamic = null

  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize
    const type = word32(ph)
    // p_offset/p_vaddr/p_filesz sit at different slots in the 32- and 64-bit
    // program headers (p_flags moves), hence the two layouts.
    const offset = is64 ? word(ph + 0x08) : word32(ph + 0x04)
    const vaddr = is64 ? word(ph + 0x10) : word32(ph + 0x08)
    const filesz = is64 ? word(ph + 0x20) : word32(ph + 0x10)
    if (type === PT_LOAD) loads.push({ offset, vaddr, filesz })
    else if (type === PT_DYNAMIC) dynamic = { offset, filesz }
  }

  if (!dynamic) return []

  // The dynamic section addresses its string table by virtual address, so it
  // has to be mapped back through the PT_LOAD segments to a file offset.
  const toOffset = (vaddr) => {
    for (const load of loads) {
      if (vaddr >= load.vaddr && vaddr < load.vaddr + load.filesz) {
        return vaddr - load.vaddr + load.offset
      }
    }
    return -1
  }

  const entrySize = is64 ? 16 : 8
  const valueAt = is64 ? word : word32
  const needed = []
  let strtab = -1
  let strsz = 0

  for (let off = dynamic.offset; off + entrySize <= buf.length; off += entrySize) {
    if (off - dynamic.offset >= dynamic.filesz) break
    const tag = valueAt(off)
    const value = valueAt(off + entrySize / 2)
    if (tag === DT_NULL) break
    if (tag === DT_NEEDED) needed.push(value)
    else if (tag === DT_STRTAB) strtab = toOffset(value)
    else if (tag === DT_STRSZ) strsz = value
  }

  if (strtab < 0) return []
  const table = buf.subarray(strtab, strsz ? Math.min(strtab + strsz, buf.length) : buf.length)
  return needed.map((nameOffset) => cstring(table, nameOffset)).filter(Boolean)
}

function neededLibrariesOf(file) {
  let stat = null
  try {
    stat = fs.statSync(file)
  } catch {
    return []
  }
  if (!stat.isFile() || stat.size > MAX_ADDON_BYTES) return []
  try {
    return neededLibraries(fs.readFileSync(file))
  } catch {
    return []
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Node's own resolution algorithm, minus the parts that can throw: walk up
// from `fromDir` looking for node_modules/<name>. Doing it by hand rather than
// through require.resolve avoids packages whose `exports` map hides
// ./package.json, which would otherwise look like a missing dependency.
function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', ...name.split('/'))
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Every *.node inside a package directory, not descending into its nested
// node_modules - those are reached as their own package via the dependency
// walk, so each addon is visited exactly once.
function addonsIn(dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      addonsIn(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.node')) {
      out.push(full)
    }
  }
  return out
}

// Walks the installed dependency tree from `root` and returns every addon that
// carries a forbidden DT_NEEDED. Bounded by the actual dependency graph, so a
// global install never wanders into unrelated packages sharing the prefix.
function scan({ root = path.join(__dirname, '..', '..'), platform = process.platform } = {}) {
  // libnode.so only exists on the platforms that ship Node as a shared object.
  // Elsewhere every addon links the executable's exported symbols and there is
  // nothing to find.
  if (platform !== 'linux') return []

  const seen = new Set()
  const queue = [root]
  const offenders = []

  while (queue.length) {
    const dir = queue.shift()
    const real = path.resolve(dir)
    if (seen.has(real)) continue
    seen.add(real)

    for (const addon of addonsIn(real)) {
      const bad = neededLibrariesOf(addon).filter((lib) => FORBIDDEN.test(lib))
      if (bad.length) offenders.push({ file: addon, needed: bad })
    }

    const pkg = readJson(path.join(real, 'package.json'))
    if (!pkg) continue
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })
    for (const name of deps) {
      const resolved = resolvePackageDir(name, real)
      if (resolved) queue.push(resolved)
    }
  }

  return offenders
}

// The message is the whole point of the check: an install that leaves a
// libnode-linked addon behind produces a silent SIGSEGV at startup with no
// output at all, which is indistinguishable from "the command does nothing".
// Failing the install turns that into one actionable message, at the one
// moment the user is already looking at install output.
function describe(offenders) {
  const lines = [
    '',
    'zbterm: install aborted - a native addon was linked against the host Node runtime.',
    ''
  ]
  for (const { file, needed } of offenders) {
    lines.push('  ' + path.relative(process.cwd(), file) + '  ->  ' + needed.join(', '))
  }
  lines.push(
    '',
    'These addons were compiled from source against a Node built as a shared',
    'library (Debian/Ubuntu nodejs + libnode, Fedora /usr/bin/node, and others).',
    'zbterm loads them inside Electron, which already has Node statically linked,',
    'so dlopen() would pull a second Node runtime into the process and the app',
    'would die with SIGSEGV before printing anything.',
    '',
    'Fixes, in order of preference:',
    '',
    '  1. Install with a Node that is statically linked, so no source build picks',
    '     up -lnode - e.g. an official nodejs.org build, or nvm/fnm:',
    '',
    '       nvm install 22 && nvm use 22 && npm install -g zbterm',
    '',
    '  2. Rebuild the addons against Electron instead of the host Node:',
    '',
    '       npx @electron/rebuild -m "$(npm root -g)/zbterm"',
    '',
    '  3. Remove the source build so a shipped prebuild is used instead:',
    '',
    '       rm -rf "$(npm root -g)/zbterm/node_modules/<package>/build"',
    '',
    'To install anyway and accept the crash, set ZBTERM_ALLOW_HOST_NODE_LINKAGE=1.',
    ''
  )
  return lines.join('\n') + '\n'
}

module.exports = {
  scan,
  describe,
  neededLibraries,
  neededLibrariesOf,
  resolvePackageDir,
  addonsIn
}
