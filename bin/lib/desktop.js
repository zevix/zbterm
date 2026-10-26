'use strict'

// `zbterm install-desktop` / `zbterm uninstall-desktop`.
//
// Linux only, user-scoped: everything lands under ~/.local/share (and, via
// xdg-mime, ~/.config/mimeapps.list). Nothing here ever writes to /usr/share
// or needs root.
//
// Why this exists at all: electron/main.js calls
// `app.setAsDefaultProtocolClient` at startup, but for an *unpackaged* app on
// Linux that writes a desktop entry pointing at the raw electron binary, which
// launches Electron with no app root. The file written here has the same name
// and wins, and it is the supported way to claim zbterm://.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const pkg = require('../../package.json')

const APP_ROOT = path.join(__dirname, '..', '..')
const DESKTOP_FILE_NAME = 'zbterm.desktop'
const ICON_BASENAME = 'zbterm.png'
const ICON_SOURCE_PATTERN = /^icon-(\d+)x(\d+)\.png$/
const SCHEMES = ['zbterm']
const DEFAULT_APPLICATIONS = '[Default Applications]'
// [Default Applications] decides who opens a scheme; [Added Associations] only
// says "this application can". A desktop environment whose mimeinfo.cache never
// got rebuilt falls back to the latter, so both are claimed.
const ADDED_ASSOCIATIONS = '[Added Associations]'

function resolveHome(env = process.env) {
  return env.HOME || os.homedir()
}

// Desktop launches do not inherit the user's PATH, so `Exec=zbterm` would only
// work by luck. Resolve argv[1] through any symlinks (a global npm install is
// a symlink farm) and write the absolute target.
function resolveLaunchPath(argv1 = process.argv[1]) {
  const candidate = argv1 || path.join(APP_ROOT, 'bin', 'zbterm.js')
  try {
    return fs.realpathSync(candidate)
  } catch {
    return path.resolve(candidate)
  }
}

function iconSources(iconSourceDir) {
  let entries = []
  try {
    entries = fs.readdirSync(iconSourceDir)
  } catch {
    return []
  }
  return entries
    .map((entry) => ({ entry, match: ICON_SOURCE_PATTERN.exec(entry) }))
    .filter(({ match }) => match && match[1] === match[2])
    .map(({ entry, match }) => ({
      size: match[1] + 'x' + match[2],
      from: path.join(iconSourceDir, entry)
    }))
    .sort((a, b) => Number(a.size.split('x')[0]) - Number(b.size.split('x')[0]))
}

function layout({
  home = resolveHome(),
  iconSourceDir = path.join(APP_ROOT, 'build', 'icon')
} = {}) {
  const dataHome = path.join(home, '.local', 'share')
  const configHome = path.join(home, '.config')
  const applicationsDir = path.join(dataHome, 'applications')
  const iconsRoot = path.join(dataHome, 'icons', 'hicolor')
  return {
    home,
    dataHome,
    configHome,
    applicationsDir,
    iconsRoot,
    mimeapps: path.join(configHome, 'mimeapps.list'),
    desktopFile: path.join(applicationsDir, DESKTOP_FILE_NAME),
    icons: iconSources(iconSourceDir).map((icon) => ({
      ...icon,
      to: path.join(iconsRoot, icon.size, 'apps', ICON_BASENAME)
    }))
  }
}

// `%u` is not optional: without it the desktop entry is invoked with no
// argument and a zbterm:// link opens an empty session.
function desktopFileContents({ launchPath, version = pkg.version }) {
  return (
    [
      '[Desktop Entry]',
      'Type=Application',
      'Version=1.0',
      'Name=ZBTerm',
      'GenericName=Terminal',
      'Comment=' + pkg.description,
      'Exec=' + launchPath + ' %u',
      'Icon=zbterm',
      'Terminal=false',
      'Categories=Development;System;TerminalEmulator;',
      'MimeType=' + SCHEMES.map((scheme) => 'x-scheme-handler/' + scheme).join(';') + ';',
      'Keywords=terminal;shell;p2p;hypercore;',
      'StartupWMClass=ZBTerm',
      'X-ZBTerm-Version=' + version
    ].join('\n') + '\n'
  )
}

// Best effort by design: a minimal container has none of these binaries, and
// the desktop entry is still valid and still found by anything that rescans.
function runHook(command, args, env) {
  try {
    const result = spawnSync(command, args, { env, stdio: 'ignore' })
    if (result.error) {
      return { command, ok: false, detail: result.error.code || result.error.message }
    }
    return { command, ok: result.status === 0, detail: 'exit ' + result.status }
  } catch (err) {
    return { command, ok: false, detail: err.message }
  }
}

function hookEnv(paths, env = process.env, cacheHome = null) {
  // Pin the XDG roots so a fake HOME cannot leak writes into the real one.
  const next = {
    ...env,
    HOME: paths.home,
    XDG_DATA_HOME: paths.dataHome,
    XDG_CONFIG_HOME: paths.configHome
  }
  if (cacheHome) next.XDG_CACHE_HOME = cacheHome
  return next
}

// xdg-mime delegates to whatever desktop environment is running, and KDE's
// helper rebuilds its service cache under $XDG_CACHE_HOME as a side effect.
// When the target home is the session's own home that is exactly what we want;
// when it is not (a sandboxed install, a test), the cache is meaningless and
// would be litter uninstall() has no business removing - so it goes to a
// throwaway directory instead.
//
// `os.homedir()` is no use for that comparison: it just echoes $HOME. The
// account's real home comes from the passwd entry via os.userInfo().
function scratchCacheHome(home) {
  let accountHome = null
  try {
    accountHome = os.userInfo().homedir
  } catch {
    accountHome = os.homedir()
  }
  if (accountHome && path.resolve(home) === path.resolve(accountHome)) return null
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-desktop-'))
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// mimeapps.list is an INI-ish file of `type=handler.desktop` lines grouped
// under section headers. Only the lines under [Default Applications] decide
// which application actually opens a scheme.
function sectionLines(raw, section) {
  const lines = raw === null ? [] : raw.split('\n')
  const start = lines.findIndex((line) => line.trim() === section)
  if (start === -1) return []
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('[')) break
    out.push(lines[i])
  }
  return out
}

// [Added Associations] values are `;`-terminated lists shared with other
// applications; [Default Applications] values are a single desktop id. Reading
// both through the same splitter also tolerates a stray trailing `;` that some
// desktop environments write into [Default Applications].
function splitList(value) {
  return value
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function schemesPresent(raw, section) {
  const present = new Set()
  for (const line of sectionLines(raw, section)) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (splitList(line.slice(eq + 1)).includes(DESKTOP_FILE_NAME)) {
      present.add(line.slice(0, eq).trim())
    }
  }
  return present
}

// The one honest answer to "did the registration land?": what the file says
// now, not what a hook's exit code claimed. Reported per section, because a
// file can easily be short in one and complete in the other.
function missingAssociations(raw) {
  const defaults = schemesPresent(raw, DEFAULT_APPLICATIONS)
  const added = schemesPresent(raw, ADDED_ASSOCIATIONS)
  return {
    defaults: SCHEMES.filter((scheme) => !defaults.has('x-scheme-handler/' + scheme)),
    added: SCHEMES.filter((scheme) => !added.has('x-scheme-handler/' + scheme))
  }
}

function noneMissing(missing) {
  return missing.defaults.length === 0 && missing.added.length === 0
}

// Merge, never overwrite: this file holds every default application the user
// has ever chosen. Only the two x-scheme-handler keys are added or extended,
// every other line (and every other section) is passed through untouched.
//
// `list` picks the value semantics: false replaces the single desktop id,
// true appends to the `;`-terminated list without disturbing what is already
// in it (and re-emits the significant trailing separator).
function mergeAssociations(raw, section, entries, { list = false } = {}) {
  const keys = Object.keys(entries)
  const format = (key) => key + '=' + entries[key] + (list ? ';' : '')
  const lines = raw === null || raw === '' ? [] : raw.split('\n')
  const sectionStart = lines.findIndex((line) => line.trim() === section)

  if (sectionStart === -1) {
    const out = lines.slice()
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
    if (out.length > 0) out.push('')
    out.push(section)
    for (const key of keys) out.push(format(key))
    out.push('')
    return out.join('\n')
  }

  let sectionEnd = lines.length
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('[')) {
      sectionEnd = i
      break
    }
  }

  const head = lines.slice(0, sectionEnd)
  const replaced = new Set()
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const eq = head[i].indexOf('=')
    if (eq === -1) continue
    const key = head[i].slice(0, eq).trim()
    if (!keys.includes(key)) continue
    replaced.add(key)
    if (!list) {
      head[i] = key + '=' + entries[key]
      continue
    }
    const values = splitList(head[i].slice(eq + 1))
    // Already in the list: leave the line byte-for-byte alone, so a second
    // install rewrites nothing.
    if (values.includes(entries[key])) continue
    head[i] = key + '=' + values.concat(entries[key]).join(';') + ';'
  }

  // Append what was not already there just below the last entry of the
  // section, so any blank line separating it from the next header survives.
  let insertAt = sectionEnd
  while (insertAt > sectionStart + 1 && head[insertAt - 1].trim() === '') insertAt--
  const additions = keys.filter((key) => !replaced.has(key)).map(format)
  head.splice(insertAt, 0, ...additions)

  return head.concat(lines.slice(sectionEnd)).join('\n')
}

function mergeDefaultApplications(raw, entries) {
  return mergeAssociations(raw, DEFAULT_APPLICATIONS, entries)
}

function mergeAddedAssociations(raw, entries) {
  return mergeAssociations(raw, ADDED_ASSOCIATIONS, entries, { list: true })
}

// xdg-mime exits 0 whether or not it wrote anything (on KDE it shells out to
// qtpaths, and a missing qtpaths is a silent no-op), so the hooks are treated
// as a best-effort first attempt and the file is checked afterwards. If the
// lines are not there, they get written directly and checked again.
function ensureAssociations(paths, { write = true } = {}) {
  const desired = {}
  for (const scheme of SCHEMES) desired['x-scheme-handler/' + scheme] = DESKTOP_FILE_NAME

  const failures = []
  let raw = readIfPresent(paths.mimeapps)
  let missing = missingAssociations(raw)
  let repaired = false

  if (!noneMissing(missing) && write) {
    try {
      fs.mkdirSync(paths.configHome, { recursive: true })
      const merged = mergeAddedAssociations(mergeDefaultApplications(raw, desired), desired)
      fs.writeFileSync(paths.mimeapps, merged)
      repaired = true
    } catch (err) {
      failures.push({
        command: 'write ' + paths.mimeapps,
        ok: false,
        detail: err.code || err.message
      })
    }
    raw = readIfPresent(paths.mimeapps)
    missing = missingAssociations(raw)
  }

  return { verified: noneMissing(missing), missing, repaired, failures }
}

// "x-scheme-handler/zbterm in [Default Applications]", one per section that is
// still short, so the warning names the section the user has to fix.
function missingDescriptions(missing) {
  return [
    ...missing.defaults.map(
      (scheme) => 'x-scheme-handler/' + scheme + ' in ' + DEFAULT_APPLICATIONS
    ),
    ...missing.added.map((scheme) => 'x-scheme-handler/' + scheme + ' in ' + ADDED_ASSOCIATIONS)
  ]
}

function manualCommands(paths) {
  return [
    'update-desktop-database ' + paths.applicationsDir,
    ...SCHEMES.map(
      (scheme) => 'xdg-mime default ' + DESKTOP_FILE_NAME + ' x-scheme-handler/' + scheme
    )
  ]
}

function install({
  home = resolveHome(),
  iconSourceDir = path.join(APP_ROOT, 'build', 'icon'),
  launchPath = resolveLaunchPath(),
  runHooks = true,
  env = process.env
} = {}) {
  const paths = layout({ home, iconSourceDir })
  const written = []

  fs.mkdirSync(paths.applicationsDir, { recursive: true })
  fs.writeFileSync(paths.desktopFile, desktopFileContents({ launchPath }))
  written.push(paths.desktopFile)

  for (const icon of paths.icons) {
    fs.mkdirSync(path.dirname(icon.to), { recursive: true })
    fs.copyFileSync(icon.from, icon.to)
    written.push(icon.to)
  }

  const hooks = []
  if (runHooks) {
    // xdg-mime writes $XDG_CONFIG_HOME/mimeapps.list but will not create the
    // directory itself; without this it fails and still exits 0.
    fs.mkdirSync(paths.configHome, { recursive: true })
    const cacheHome = scratchCacheHome(paths.home)
    try {
      const childEnv = hookEnv(paths, env, cacheHome)
      hooks.push(runHook('update-desktop-database', [paths.applicationsDir], childEnv))
      for (const scheme of SCHEMES) {
        hooks.push(
          runHook(
            'xdg-mime',
            ['default', DESKTOP_FILE_NAME, 'x-scheme-handler/' + scheme],
            childEnv
          )
        )
      }
    } finally {
      if (cacheHome) fs.rmSync(cacheHome, { recursive: true, force: true })
    }
  }

  const associations = ensureAssociations(paths, { write: runHooks })

  return {
    paths,
    written,
    hooks,
    launchPath,
    desktopFile: paths.desktopFile,
    icons: paths.icons.map((icon) => icon.to),
    mimeapps: paths.mimeapps,
    mimeVerified: associations.verified,
    mimeMissing: associations.missing,
    mimeRepaired: associations.repaired,
    hookFailures: [...hooks.filter((hook) => !hook.ok), ...associations.failures]
  }
}

function removeIfPresent(target, removed) {
  try {
    fs.unlinkSync(target)
    removed.push(target)
  } catch {}
}

function pruneEmptyDirs(dir, stopAt) {
  let current = dir
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      fs.rmdirSync(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}

// The mimeapps.list entries and the mimeinfo.cache are written by xdg-mime and
// update-desktop-database rather than by install(), but they only exist here
// because install() ran, so uninstall() has to undo them too - otherwise a
// clean uninstall still leaves zbterm wired up as a scheme handler.
// A section header whose entries all belonged to zbterm is dropped along with
// the (blank) remainder of its body - but only a section this uninstall
// actually emptied, so a section the user left empty is not "tidied" away.
function dropEmptiedSections(lines, emptied) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!emptied.has(i)) {
      out.push(lines[i])
      continue
    }
    let end = i + 1
    while (end < lines.length && !lines[end].trim().startsWith('[')) end++
    if (lines.slice(i + 1, end).some((line) => line.includes('='))) {
      out.push(lines[i])
      continue
    }
    i = end - 1
  }
  return out
}

// Section-aware removal: a [Default Applications] key names one handler, so the
// whole line goes; an [Added Associations] key names a list other applications
// share, so only zbterm is spliced out of it - split, filter, re-join, never a
// `;;` or a leading `;`.
function stripAssociations(raw) {
  const pattern = new RegExp('^x-scheme-handler/(' + SCHEMES.join('|') + ')$')
  const kept = []
  const emptied = new Set()
  let section = null
  let header = -1
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      section = trimmed
      header = kept.length
      kept.push(line)
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1 || !pattern.test(line.slice(0, eq).trim())) {
      kept.push(line)
      continue
    }
    if (header !== -1) emptied.add(header)
    if (section !== ADDED_ASSOCIATIONS) continue
    const rest = splitList(line.slice(eq + 1)).filter((value) => value !== DESKTOP_FILE_NAME)
    if (rest.length > 0) kept.push(line.slice(0, eq) + '=' + rest.join(';') + ';')
  }
  return dropEmptiedSections(kept, emptied)
}

function cleanAssociations(paths, removed) {
  const mimeapps = paths.mimeapps
  const raw = readIfPresent(mimeapps)
  if (raw !== null) {
    const kept = stripAssociations(raw)
    if (kept.some((line) => line.includes('='))) {
      fs.writeFileSync(mimeapps, kept.join('\n'))
    } else {
      removeIfPresent(mimeapps, removed)
    }
  }

  const cache = path.join(paths.applicationsDir, 'mimeinfo.cache')
  let remaining = []
  try {
    remaining = fs.readdirSync(paths.applicationsDir).filter((f) => f.endsWith('.desktop'))
  } catch {}
  if (remaining.length === 0) removeIfPresent(cache, removed)
  else if (fs.existsSync(cache)) {
    runHook('update-desktop-database', [paths.applicationsDir], hookEnv(paths))
  }
}

function uninstall({
  home = resolveHome(),
  iconSourceDir = path.join(APP_ROOT, 'build', 'icon')
} = {}) {
  const paths = layout({ home, iconSourceDir })
  const removed = []

  removeIfPresent(paths.desktopFile, removed)
  for (const icon of paths.icons) removeIfPresent(icon.to, removed)
  // Sizes that were installed by an older build (a size since dropped from
  // build/icon/) would otherwise be orphaned.
  let sizes = []
  try {
    sizes = fs.readdirSync(paths.iconsRoot)
  } catch {}
  for (const size of sizes) {
    removeIfPresent(path.join(paths.iconsRoot, size, 'apps', ICON_BASENAME), removed)
  }

  cleanAssociations(paths, removed)

  for (const size of sizes) pruneEmptyDirs(path.join(paths.iconsRoot, size, 'apps'), paths.dataHome)
  pruneEmptyDirs(paths.iconsRoot, paths.dataHome)
  pruneEmptyDirs(paths.applicationsDir, paths.dataHome)
  pruneEmptyDirs(paths.dataHome, path.join(home, '.local'))
  pruneEmptyDirs(paths.configHome, home)

  return { paths, removed }
}

function unsupportedPlatformMessage(platform) {
  if (platform === 'darwin') {
    return (
      'zbterm: install-desktop is Linux-only. On macOS the app registers zbterm:// ' +
      'itself at startup (LaunchServices), so there is nothing to install.'
    )
  }
  if (platform === 'win32') {
    return (
      'zbterm: install-desktop is Linux-only. On Windows the app registers zbterm:// ' +
      'itself at startup (HKCU registry), so there is nothing to install.'
    )
  }
  return 'zbterm: install-desktop is Linux-only; nothing to do on ' + platform + '.'
}

// Everything install() would do, printed and nothing else - no directory is
// created, no hook is run (which is also why ~/.cache stays untouched), so the
// output is safe to hand to a packager or paste into a shell.
function printPlan(log, { home = resolveHome(), launchPath = resolveLaunchPath() } = {}) {
  const paths = layout({ home })
  log('zbterm: install-desktop --print-only (nothing is written)')
  log('')
  log('desktop entry: ' + paths.desktopFile)
  log('mime list:     ' + paths.mimeapps)
  log('')
  log('--- ' + DESKTOP_FILE_NAME + ' ---')
  log(desktopFileContents({ launchPath }).replace(/\n$/, ''))
  log('--- end ---')
  log('')
  log('icons:')
  if (paths.icons.length === 0) log('  (none found)')
  for (const icon of paths.icons) log('  ' + icon.from + ' -> ' + icon.to)
  log('')
  log('then run:')
  for (const command of manualCommands(paths)) log('  ' + command)
  log('')
  log('expected in ' + paths.mimeapps + ' under ' + DEFAULT_APPLICATIONS + ':')
  for (const scheme of SCHEMES) log('  x-scheme-handler/' + scheme + '=' + DESKTOP_FILE_NAME)
  log('')
  log('and under ' + ADDED_ASSOCIATIONS + ' (appended to any list already there):')
  for (const scheme of SCHEMES) log('  x-scheme-handler/' + scheme + '=' + DESKTOP_FILE_NAME + ';')
}

function runInstall(argv = [], { log = console.log, platform = process.platform } = {}) {
  if (platform !== 'linux') {
    log(unsupportedPlatformMessage(platform))
    return 0
  }

  if (argv.includes('--print-only')) {
    printPlan(log)
    return 0
  }

  let result = null
  try {
    result = install()
  } catch (err) {
    log(
      'zbterm: install-desktop failed: ' + (err.code ? err.code + ' ' + err.message : err.message)
    )
    return 1
  }

  log('zbterm: installed desktop integration')
  for (const file of result.written) log('  ' + file)
  log('  Exec=' + result.launchPath + ' %u')
  for (const failure of result.hookFailures) {
    log('  note: ' + failure.command + ' failed (' + failure.detail + ')')
  }

  if (result.mimeVerified) {
    for (const scheme of SCHEMES) {
      log('  verified x-scheme-handler/' + scheme + '=' + DESKTOP_FILE_NAME)
    }
    log(
      'zbterm: desktop integration installed and verified in ' +
        result.mimeapps +
        ' (' +
        DEFAULT_APPLICATIONS +
        ' and ' +
        ADDED_ASSOCIATIONS +
        ')'
    )
    return 0
  }

  log(
    'zbterm: WARNING could not verify ' +
      missingDescriptions(result.mimeMissing).join(', ') +
      ' in ' +
      result.mimeapps
  )
  log('  finish it by hand with:')
  for (const command of manualCommands(result.paths)) log('    ' + command)
  return 1
}

function runUninstall(argv, { log = console.log, platform = process.platform } = {}) {
  if (platform !== 'linux') {
    log(unsupportedPlatformMessage(platform).replace('install-desktop', 'uninstall-desktop'))
    return 0
  }

  const result = uninstall()
  if (result.removed.length === 0) {
    log('zbterm: nothing to remove')
    return 0
  }
  log('zbterm: removed desktop integration')
  for (const file of result.removed) log('  ' + file)
  return 0
}

module.exports = {
  runInstall,
  runUninstall,
  install,
  uninstall,
  layout,
  printPlan,
  mergeDefaultApplications,
  mergeAddedAssociations,
  missingAssociations,
  desktopFileContents,
  resolveLaunchPath,
  DESKTOP_FILE_NAME,
  SCHEMES,
  DEFAULT_APPLICATIONS,
  ADDED_ASSOCIATIONS
}
