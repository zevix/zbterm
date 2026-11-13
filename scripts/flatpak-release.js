#!/usr/bin/env node
// Flatpak release bookkeeping for build_all.sh. A Flatpak is built only on
// request (`build_all.sh --flatpak`), and only once per version: the
// manifest (flatpak/net.z33v.zbterm.yml) and metainfo describe published
// tarballs, so one version must never stand for two different builds.
//
// Builds are stamped with a fingerprint of the source tree: the git tree of
// the working copy (tracked + untracked, minus ignored files and flatpak/,
// which this script itself rewrites). Submodules count by their checked-out
// commit.
//
//   node scripts/flatpak-release.js fingerprint
//       prints the source fingerprint.
//   node scripts/flatpak-release.js check <outRoot>
//       refuses a Flatpak build of the current version (exit 1, reasons on
//       stderr) when its release notes are missing or a Flatpak of this
//       version was already built from different sources.
//   node scripts/flatpak-release.js record-build <outRoot>
//       stamps a regular build: <outRoot>/build-stamp.json.
//   node scripts/flatpak-release.js finish <outRoot>
//       after the flatpak maker: stamps the host-arch tarball, writes its
//       file name + sha512 into the manifest, and adds (or refreshes) the
//       version's <release> in the metainfo, with the notes as description.
//   node scripts/flatpak-release.js report <outRoot> <built:0|1>
//       prints the end-of-build Flatpak note and divergence warnings.
//
// ZBTERM_SRC_FP, when set, is used as the fingerprint instead of computing it.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const FLATPAK_DIR = path.join(ROOT, 'flatpak')
const MANIFEST = path.join(FLATPAK_DIR, 'net.z33v.zbterm.yml')
const METAINFO = path.join(FLATPAK_DIR, 'net.z33v.zbterm.metainfo.xml')
const NOTES_DIR = path.join(FLATPAK_DIR, 'releases')
// forge arch -> Flatpak arch (the manifest's only-arches).
const ARCHES = { x64: 'x86_64', arm64: 'aarch64' }

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
// pear-electron-forge-maker-flatpak's tarball name.
const FLAT_NAME = (pkg.productName || pkg.name).toLowerCase().replace(/[^a-z0-9-]/g, '-')

const rel = (p) => path.relative(ROOT, p) || '.'
const notesFile = (version) => path.join(NOTES_DIR, `${version}.md`)
const tarballName = (version, arch) => `${FLAT_NAME}_${version}_${arch}_flatpak.tar.gz`
const stampOf = (tarball) => `${tarball}.stamp.json`
const buildStampFile = (outRoot) => path.join(outRoot, 'build-stamp.json')

function git(args, env) {
  return execFileSync('git', args, {
    cwd: ROOT,
    env: env || process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function fingerprint() {
  if (process.env.ZBTERM_SRC_FP) return process.env.ZBTERM_SRC_FP
  // A scratch index, seeded from the real one so unchanged files hash fast.
  const index = path.join(os.tmpdir(), `zbterm-fp-${process.pid}.index`)
  try {
    fs.copyFileSync(path.join(ROOT, git(['rev-parse', '--git-path', 'index'])), index)
    const env = { ...process.env, GIT_INDEX_FILE: index }
    git(['add', '-A', '--', '.', ':(exclude)flatpak'], env)
    git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', 'flatpak'], env)
    return git(['write-tree'], env)
  } finally {
    fs.rmSync(index, { force: true })
  }
}

function stamp(extra) {
  return {
    version: VERSION,
    fingerprint: fingerprint(),
    commit: git(['rev-parse', '--short', 'HEAD']),
    dirty: git(['status', '--porcelain']) !== '',
    date: new Date().toISOString(),
    ...extra
  }
}

const readJSON = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const describe = (s) =>
  `${s.commit}${s.dirty ? ' + uncommitted changes' : ''}, sources ${s.fingerprint.slice(0, 10)}`

// Flatpak tarballs of `version` in <outRoot>/make, with their stamps.
function flatpaksOf(outRoot, version) {
  return Object.keys(ARCHES)
    .map((arch) => {
      const file = path.join(outRoot, 'make', tarballName(version, arch))
      return fs.existsSync(file) ? { arch, file, stamp: readJSON(stampOf(file)) } : null
    })
    .filter(Boolean)
}

function notes(version) {
  const file = notesFile(version)
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8').trim()
  return text || null
}

// Release notes (paragraph lines and `-`/`*` bullets) -> AppStream markup.
function notesToXml(text, indent) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const out = []
  let list = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || /^#/.test(line)) continue
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet && !list) out.push(`${indent}<ul>`)
    if (!bullet && list) out.push(`${indent}</ul>`)
    list = !!bullet
    out.push(bullet ? `${indent}  <li>${esc(bullet[1])}</li>` : `${indent}<p>${esc(line)}</p>`)
  }
  if (list) out.push(`${indent}</ul>`)
  return out.join('\n')
}

function check(outRoot) {
  const problems = []
  if (!notes(VERSION)) {
    problems.push(`no release notes for ${VERSION}: write ${rel(notesFile(VERSION))}`)
  }
  const fp = fingerprint()
  for (const f of flatpaksOf(outRoot, VERSION)) {
    if (f.stamp && f.stamp.fingerprint !== fp) {
      problems.push(
        `a ${VERSION} Flatpak (${f.arch}) was already built from other sources ` +
          `(${describe(f.stamp)}); bump the version (--bump-build) before building it again`
      )
    }
  }
  if (!ARCHES[process.arch]) problems.push(`no Flatpak arch for this machine (${process.arch})`)
  if (problems.length) {
    for (const p of problems) console.error(`ERROR: --flatpak: ${p}`)
    process.exit(1)
  }
}

function recordBuild(outRoot) {
  fs.mkdirSync(outRoot, { recursive: true })
  fs.writeFileSync(buildStampFile(outRoot), JSON.stringify(stamp(), null, 2) + '\n')
}

function updateManifest(arch, sha512) {
  const lines = fs.readFileSync(MANIFEST, 'utf8').split('\n')
  const at = lines.findIndex((l) => /^\s*url:/.test(l) && l.includes(`_${arch}_flatpak.tar.gz`))
  if (at < 0) throw new Error(`no ${arch} source url in ${rel(MANIFEST)}`)
  lines[at] = lines[at].replace(
    new RegExp(`${FLAT_NAME}_[^/\\s]*_${arch}_flatpak\\.tar\\.gz`),
    tarballName(VERSION, arch)
  )
  let i = at + 1
  while (i < lines.length && !/^\s*-\s+type:/.test(lines[i]) && !/^\s*sha512:/.test(lines[i])) i++
  if (i >= lines.length || !/^\s*sha512:/.test(lines[i])) {
    throw new Error(`no sha512 for the ${arch} source in ${rel(MANIFEST)}`)
  }
  lines[i] = lines[i].replace(/^(\s*sha512:).*$/, `$1 ${sha512}`)
  fs.writeFileSync(MANIFEST, lines.join('\n'))
}

function updateMetainfo() {
  const xml = fs.readFileSync(METAINFO, 'utf8')
  const releaseRe = /([ \t]*)<release\b[^>]*?(?:\/>|>[\s\S]*?<\/release>)/
  const first = releaseRe.exec(xml)
  const indent = first ? first[1] : '    '
  const today = new Date().toISOString().slice(0, 10)
  const entry = [
    `${indent}<release date="${today}" version="${VERSION}">`,
    `${indent}  <description>`,
    notesToXml(notes(VERSION), `${indent}    `),
    `${indent}  </description>`,
    `${indent}</release>`
  ].join('\n')
  let out
  if (first && new RegExp(`\\bversion="${VERSION.replace(/\./g, '\\.')}"`).test(first[0])) {
    out = xml.replace(releaseRe, entry) // a rebuild of the same version: refresh it
  } else if (first) {
    out = xml.replace(releaseRe, `${entry}\n${first[0]}`) // newest first
  } else if (/<releases>/.test(xml)) {
    out = xml.replace(/([ \t]*)<releases>/, `$1<releases>\n${entry}`)
  } else {
    throw new Error(`no <releases> in ${rel(METAINFO)}`)
  }
  fs.writeFileSync(METAINFO, out)
}

function finish(outRoot) {
  const arch = process.arch
  const file = path.join(outRoot, 'make', tarballName(VERSION, arch))
  if (!fs.existsSync(file)) throw new Error(`the flatpak maker produced no ${rel(file)}`)
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex')
  updateManifest(arch, sha512)
  updateMetainfo()
  // Last: a stamp means the manifest and metainfo describe this tarball.
  fs.writeFileSync(stampOf(file), JSON.stringify(stamp({ arch, sha512 }), null, 2) + '\n')
  console.log(`==> Flatpak ${VERSION} (${arch}): ${rel(file)}`)
  console.log(`    sha512 + file name written to ${rel(MANIFEST)}`)
  console.log(`    <release ${VERSION}> written to ${rel(METAINFO)}`)
}

function report(outRoot, built) {
  const say = (s) => console.log(s)
  const metaVersion = (/<release\b[^>]*\bversion="([^"]+)"/.exec(
    fs.readFileSync(METAINFO, 'utf8')
  ) || [])[1]
  const manifest = fs.readFileSync(MANIFEST, 'utf8')
  const flatpaks = flatpaksOf(outRoot, VERSION)
  const build = readJSON(buildStampFile(outRoot))

  say('==> Flatpak')
  if (built) {
    say(`    built ${VERSION} for ${process.arch} (manifest and metainfo updated).`)
  } else {
    const have = flatpaks.map((f) => f.arch).join(', ')
    say(`    not built this run (pass --flatpak to build it).`)
    say(
      `    ${VERSION}: ${have ? `Flatpak tarball(s) present for ${have}` : 'no Flatpak built yet'};`
    )
    say(`    newest release in the metainfo: ${metaVersion || 'none'}.`)
  }

  const missing = []
  if (!notes(VERSION)) missing.push(`release notes: ${rel(notesFile(VERSION))}`)
  if (process.platform !== 'linux')
    missing.push('a Linux machine (the flatpak maker is Linux-only)')
  for (const [arch, flat] of Object.entries(ARCHES)) {
    const line = manifest.split('\n').find((l) => /^\s*url:/.test(l) && l.includes(`_${arch}_`))
    if (line && !line.includes(tarballName(VERSION, arch))) {
      missing.push(
        `a ${VERSION} tarball for ${arch}/${flat} (the manifest still points at an older one)`
      )
    }
  }
  if (/url:\s*https?:\/\/(localhost|127\.0\.0\.1)/.test(manifest)) {
    missing.push('a hosting location: the manifest URLs still point at localhost')
  }
  try {
    execFileSync('flatpak-builder', ['--version'], { stdio: 'ignore' })
  } catch {
    missing.push(
      'flatpak-builder, to build/test the Flatpak from the manifest (./install_deps.sh --optional)'
    )
  }
  if (missing.length) {
    say(`    to publish ${VERSION} as a Flatpak you still need:`)
    for (const m of missing) say(`      - ${m}`)
  }

  // Divergence: a Flatpak of this version from sources the last build no longer has.
  for (const f of flatpaks) {
    if (!f.stamp) {
      say(
        `WARNING: ${rel(f.file)} has no stamp (made outside build_all.sh --flatpak?); its sources are unknown.`
      )
    } else if (build && build.version === VERSION && build.fingerprint !== f.stamp.fingerprint) {
      say(`WARNING: the ${VERSION} Flatpak (${f.arch}) was built from ${describe(f.stamp)},`)
      say(
        `         but the last regular ${VERSION} build is from ${describe(build)} - different sources`
      )
      say(
        `         under the same version. Bump it (--bump-build) before the next --flatpak build.`
      )
    }
  }
}

const [cmd, outRoot = 'out', arg] = process.argv.slice(2)
const out = path.resolve(ROOT, outRoot)
try {
  if (cmd === 'fingerprint') console.log(fingerprint())
  else if (cmd === 'check') check(out)
  else if (cmd === 'record-build') recordBuild(out)
  else if (cmd === 'finish') finish(out)
  else if (cmd === 'report') report(out, arg === '1')
  else {
    console.error(
      'usage: flatpak-release.js fingerprint|check|record-build|finish|report <outRoot> [built]'
    )
    process.exit(1)
  }
} catch (err) {
  console.error(`ERROR: ${err.message}`)
  process.exit(1)
}
