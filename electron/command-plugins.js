// The user's command plugins (261121_dialog-and-command-plugins R5–R7, U1, U2):
// `.js` files in <app data>/plugins/commands/ (~/.config/ZBTerm/plugins/commands/
// on Linux), each a launch plugin in the built-in ones' own format
// (renderer/plugins/), and `commands.json` there, which says which plugins the
// session dialog's "+ Add" offers. The renderer runs the files; this side only
// finds, reads, seeds and saves them.
const fs = require('fs')
const os = require('os')
const path = require('path')

const CHOICE_FILE = 'commands.json'
const SAMPLES_DIR = path.join(__dirname, '..', 'renderer', 'plugins', 'samples')
// The one sample chosen in a new directory's commands.json (R7).
const DEFAULT_CHOSEN = ['sample_custom_command.js']
// A plugin file larger than this is listed with an error, not read.
const MAX_SOURCE_BYTES = 256 * 1024
const MAX_FILES = 200

let root = ''

// `dataDir` is the app's own data directory (main.js's stableUserData).
function configure({ dataDir } = {}) {
  root = dataDir ? path.join(dataDir, 'plugins', 'commands') : ''
}

function dir() {
  if (!root) throw new Error('Command plugins are not configured')
  return root
}

// The directory as the dialog names it: under the home directory with `~`.
function displayDir(target = dir(), home = os.homedir()) {
  const rel = path.relative(home, target)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return `~/${rel.split(path.sep).join('/')}/`
  }
  return target.endsWith(path.sep) ? target : target + path.sep
}

// R7, U2: only a directory that does not exist yet is created and filled;
// one that exists (even empty, even without commands.json) is the user's.
// C8 (F8): the samples and commands.json go into a sibling temp directory
// that is renamed into place in one step, so a second app process seeding at
// the same moment, or a crash half-way, never leaves a half-filled directory
// (which would then count as the user's and never be seeded again). If the
// target appeared meanwhile, the temp is dropped and the target left alone.
// `hooks.beforeRename(temp)` is for the tests.
function seed(target = dir(), samples = SAMPLES_DIR, hooks = {}) {
  if (fs.existsSync(target)) return false
  const parent = path.dirname(target)
  fs.mkdirSync(parent, { recursive: true })
  const temp = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.seed-`))
  try {
    fs.chmodSync(temp, 0o755)
    for (const file of sampleFiles(samples)) {
      const into = path.join(temp, file)
      fs.copyFileSync(path.join(samples, file), into, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(into, 0o644)
    }
    writeChoice(temp, { builtin: null, commands: DEFAULT_CHOSEN })
    if (hooks.beforeRename) hooks.beforeRename(temp)
    // rename(2) would replace an empty directory: look once more first.
    if (fs.existsSync(target)) return false
    fs.renameSync(temp, target)
    return true
  } catch (err) {
    // The target exists after all (another process won): not an error.
    if (fs.existsSync(target) && err && (err.code === 'ENOTEMPTY' || err.code === 'EEXIST')) {
      return false
    }
    throw err
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function sampleFiles(samples = SAMPLES_DIR) {
  try {
    return fs
      .readdirSync(samples)
      .filter((file) => file.endsWith('.js'))
      .sort()
  } catch {
    return []
  }
}

// { builtin: [id] | null (every built-in), commands: [file] }. A missing or
// unreadable file reads as every built-in and no file.
function readChoice(target = dir()) {
  return readChoiceState(target).choice
}

// { choice, error }: `error` says why an existing commands.json could not be
// used (C9, F9), '' when it was read or is simply missing.
function readChoiceState(target = dir()) {
  const fallback = { builtin: null, commands: [] }
  let text
  try {
    text = fs.readFileSync(path.join(target, CHOICE_FILE), 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { choice: fallback, error: '' }
    return { choice: fallback, error: (err && err.message) || String(err) }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { choice: fallback, error: (err && err.message) || 'Not JSON' }
  }
  const listOrAbsent = (value) => value === undefined || value === null || Array.isArray(value)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !listOrAbsent(parsed.builtin) ||
    !listOrAbsent(parsed.commands)
  ) {
    return { choice: fallback, error: 'Expected {"builtin": [...], "commands": [...]}' }
  }
  return { choice: normalizeChoice(parsed), error: '' }
}

function normalizeChoice(value = {}) {
  const strings = (list) =>
    Array.isArray(list)
      ? Array.from(new Set(list.filter((item) => typeof item === 'string' && item)))
      : null
  const commands = (strings(value.commands) || []).filter(isPluginFileName)
  return { builtin: strings(value.builtin), commands }
}

function writeChoice(target, choice) {
  const value = normalizeChoice(choice)
  const body = {
    // What "+ Add" offers: the built-in plugins by id (absent: all of them)
    // and the files of this directory by name.
    builtin: value.builtin === null ? undefined : value.builtin,
    commands: value.commands
  }
  const file = path.join(target, CHOICE_FILE)
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(body, null, 2) + '\n')
  fs.renameSync(temp, file)
  return readChoice(target)
}

function isPluginFileName(name) {
  return typeof name === 'string' && /^[^/\\]+\.js$/.test(name) && !name.startsWith('.')
}

// C2 (F2, A-9): a plugin is code the app runs with the renderer's rights,
// so on POSIX a file, or the directory, that another user owns or can write
// is refused. Group-writable counts only when the group is not the user's
// own primary group: with the usual umask 002 every file a user makes is
// group-writable by their private group, which no other user is in.
function unsafeReason(stat, ids = posixIds()) {
  if (!ids) return ''
  if (stat.uid !== ids.uid) return 'Not owned by you'
  if (stat.mode & 0o002) return 'Writable by other users'
  if (stat.mode & 0o020 && stat.gid !== ids.gid) return 'Writable by other users'
  return ''
}

function posixIds() {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null
  return { uid: process.getuid(), gid: process.getgid() }
}

// { dir, displayDir, seeded, choice, choiceError, files: [{ file, source?,
// error? }] }: every `.js` file of the directory, sorted by name.
function list(ids = posixIds()) {
  const target = dir()
  let seeded = false
  try {
    seeded = seed(target)
  } catch (err) {
    console.error('command-plugins: could not create', target, err && err.message)
  }
  let names = []
  let dirError = ''
  try {
    dirError = unsafeReason(fs.statSync(target), ids)
    names = fs.readdirSync(target).filter(isPluginFileName).sort().slice(0, MAX_FILES)
  } catch {}
  const files = names.map((file) => {
    try {
      if (dirError) return { file, error: `The folder: ${dirError}` }
      const full = path.join(target, file)
      const stat = fs.statSync(full)
      if (!stat.isFile()) return { file, error: 'Not a file' }
      const unsafe = unsafeReason(stat, ids)
      if (unsafe) return { file, error: unsafe }
      if (stat.size > MAX_SOURCE_BYTES) return { file, error: 'Larger than 256 KB' }
      return { file, source: fs.readFileSync(full, 'utf8') }
    } catch (err) {
      return { file, error: (err && err.message) || String(err) }
    }
  })
  const { choice, error } = readChoiceState(target)
  return {
    dir: target,
    displayDir: displayDir(target),
    seeded,
    choice,
    choiceError: error ? `commands.json could not be read: ${error}` : '',
    files
  }
}

// C9: a commands.json that could not be read is kept as commands.json.bad
// before the new choice replaces it, so the user's old choice is not lost.
function save(choice = {}) {
  const target = dir()
  fs.mkdirSync(target, { recursive: true })
  if (readChoiceState(target).error) {
    fs.copyFileSync(path.join(target, CHOICE_FILE), path.join(target, `${CHOICE_FILE}.bad`))
  }
  return writeChoice(target, choice)
}

// The "zbterm-plugin" Claude skill (renderer/plugins/skill/): how to write,
// check, install and enable a command plugin. The Plugins dialog installs it
// for the user's Claude Code, as ~/.claude/skills/zbterm-plugin/ (under
// $CLAUDE_CONFIG_DIR when that is set): the skill's own files, and in `lib/`
// the launch plugins its script loads (launch-core.js, the built-ins, the
// samples), so it works without ZBTerm's sources. Installing again replaces
// the files it ships and leaves any other file there alone.
const SKILL_NAME = 'zbterm-plugin'
const PLUGINS_DIR = path.join(__dirname, '..', 'renderer', 'plugins')
const SKILL_DIR = path.join(PLUGINS_DIR, 'skill')

function skillTarget(env = process.env, home = os.homedir()) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  return path.join(base, 'skills', SKILL_NAME)
}

// [from (absolute), to (relative to the installed skill)]
function skillFiles() {
  const files = []
  const walk = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const source = path.join(from, entry.name)
      const dest = to ? path.join(to, entry.name) : entry.name
      if (entry.isDirectory()) walk(source, dest)
      else if (entry.isFile()) files.push([source, dest])
    }
  }
  walk(SKILL_DIR, '')
  const scripts = (dir) =>
    fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.js'))
      .sort()
  for (const file of scripts(PLUGINS_DIR)) {
    files.push([path.join(PLUGINS_DIR, file), path.join('lib', file)])
  }
  for (const file of scripts(SAMPLES_DIR)) {
    files.push([path.join(SAMPLES_DIR, file), path.join('lib', 'samples', file)])
  }
  return files
}

// { dir, displayDir, files, updated }: `updated` when a skill was there.
function installSkill(target = skillTarget()) {
  const updated = fs.existsSync(path.join(target, 'SKILL.md'))
  const files = skillFiles()
  for (const [from, to] of files) {
    const into = path.join(target, to)
    fs.mkdirSync(path.dirname(into), { recursive: true })
    // Through a temp file: a link left at `into` is replaced, not followed.
    const temp = path.join(path.dirname(into), `.${path.basename(into)}.${process.pid}.tmp`)
    fs.copyFileSync(from, temp)
    fs.chmodSync(temp, to.startsWith('scripts' + path.sep) ? 0o755 : 0o644)
    fs.renameSync(temp, into)
  }
  return { dir: target, displayDir: displayDir(target), files: files.length, updated }
}

module.exports = {
  configure,
  dir,
  list,
  save,
  installSkill,
  _test: {
    skillTarget,
    skillFiles,
    seed,
    readChoice,
    readChoiceState,
    unsafeReason,
    writeChoice,
    displayDir,
    normalizeChoice,
    sampleFiles,
    SAMPLES_DIR
  }
}
