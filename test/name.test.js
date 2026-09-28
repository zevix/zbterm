// Pins D-27 (docs/decisions.md): the old name is removed everywhere, historical records
// included. Reads the working tree (not `git grep`, which only sees tracked files, and most
// of this tree is still untracked) and fails on any byte match of the old name, anywhere in
// the tree. No path is exempt any longer: the rename script that Z3 exempted is gone (Z5),
// and this project's own folder (docs/projects/260928_zbterm-fork/) was rewritten by hand in
// Z5 to describe the project without the old name. The pattern is built from two
// literals so this file's own source never spells the banned name out (it would otherwise
// fail against itself).
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const test = require('brittle')

const ROOT = path.join(__dirname, '..')
const OLD_NAME = new RegExp('pear' + 'term', 'i')

function listFiles() {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  return out
    .split('\n')
    .filter(Boolean)
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)))
}

test('no file anywhere in the tree still spells the old name', (t) => {
  const files = listFiles()
  t.ok(files.length > 100, `sanity: the working tree lists files (${files.length})`)
  let hits = 0
  for (const rel of files) {
    // latin1 is a 1:1 byte<->char mapping, so this also catches the name inside a binary
    // file (e.g. a compiled .wasm with the old domain string) without corrupting anything -
    // the file is only read, never written.
    const bytes = fs.readFileSync(path.join(ROOT, rel), 'latin1')
    if (OLD_NAME.test(bytes)) {
      hits++
      t.fail(`${rel} still contains the old name`)
    }
  }
  t.is(hits, 0, 'no hit anywhere in the tree')
})
