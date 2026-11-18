// What the demo's shells find in their scratch HOME: a prompt, and a small
// project whose scripts print the same thing on every run, with no network.
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const BASHRC = `# ZBTerm demo shell
PS1='\\[\\e[1;32m\\]\${ZBDEMO_WHO:-demo}@laptop\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ '
alias ls='ls --color=auto'
export LS_COLORS='di=1;34:ex=1;32'
cd() { builtin cd "$@"; }
`

const BUILD = `#!/usr/bin/env bash
step() { printf '\\e[1;34m==>\\e[0m \\e[1m%s\\e[0m\\n' "$1"; }
ok() { printf '    \\e[32m✔\\e[0m %s\\n' "$1"; }
step "Installing dependencies"; sleep 0.5; ok "214 packages, 0 vulnerabilities"
step "Linting"; sleep 0.4; ok "62 files checked"
step "Running tests"
for t in auth cart checkout inventory payments; do
  sleep 0.22; printf '    \\e[32mPASS\\e[0m  test/%s.test.js\\n' "$t"
done
step "Bundling"
for i in 1 2 3 4 5 6 7 8 9 10; do
  bar=$(printf '%*s' "$((i * 3))" '' | tr ' ' '#')
  printf '\\r    [%-30s] %3d%%' "$bar" "$((i * 10))"; sleep 0.12
done
printf '\\n'
step "Uploading the artifact"; sleep 3.2; ok "shop-api-2.4.0.tgz (1.8 MB)"
printf '\\e[1;32mBuild succeeded\\e[0m in 7.1s\\n'
`

const DEPLOY = `#!/usr/bin/env bash
env=\${1:-staging}
printf '\\e[1;34m==>\\e[0m \\e[1mDeploying shop-api 2.4.0 to %s\\e[0m\\n' "$env"
sleep 0.4; printf '    rolling out  api-1  \\e[32mok\\e[0m\\n'
sleep 0.4; printf '    rolling out  api-2  \\e[32mok\\e[0m\\n'
if [ "$env" != staging ]; then
  sleep 0.4; printf '    rolling out  api-3  \\e[32mok\\e[0m\\n'
  printf '\\e[1;32mDeployed\\e[0m shop-api 2.4.0 to %s\\n' "$env"
  exit 0
fi
# Staging's third node fails: what the search scene finds.
sleep 0.5; printf '    rolling out  api-3  \\e[31mERROR\\e[0m health check failed (503)\\n'
sleep 0.3; printf '\\e[1;31mERROR\\e[0m deploy to %s rolled back\\n' "$env"
exit 1
`

const LOGS = `#!/usr/bin/env bash
# A log stream that never ends: the same lines in the same order.
lines=(
  "INFO  GET /products 200 12ms"
  "INFO  GET /cart 200 8ms"
  "INFO  POST /cart/items 201 21ms"
  "WARN  slow query: inventory.lookup 480ms"
  "INFO  GET /products/42 200 9ms"
  "ERROR payment gateway timeout (order 7731)"
  "INFO  POST /checkout 502 3004ms"
  "INFO  GET /health 200 1ms"
  "INFO  GET /products 200 11ms"
  "ERROR payment gateway timeout (order 7732)"
  "WARN  retrying payment (attempt 2)"
  "INFO  POST /checkout 200 640ms"
)
n=0
while :; do
  line=\${lines[$((n % \${#lines[@]}))]}
  case $line in
    ERROR*) c='\\e[1;31m' ;; WARN*) c='\\e[33m' ;; *) c='\\e[2m' ;;
  esac
  printf '%s %b%s\\e[0m\\n' "$(date +%H:%M:%S)" "$c" "$line"
  n=$((n + 1)); sleep 0.45
done
`

const FILES = {
  'README.md': '# shop-api\n\nThe demo project of the ZBTerm walk-through.\n',
  'package.json': '{\n  "name": "shop-api",\n  "version": "2.4.0"\n}\n',
  'src/server.js': "const app = require('./routes')\napp.listen(8080)\n",
  'src/routes.js': '// routes\n',
  'src/db.js': '// database\n',
  'test/auth.test.js': '// test\n',
  'test/cart.test.js': '// test\n',
  'test/checkout.test.js': '// test\n'
}

function writeFixtures(home) {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, '.bashrc'), BASHRC)
  // A login shell reads this one.
  fs.writeFileSync(path.join(home, '.bash_profile'), '. ~/.bashrc\n')
  const project = path.join(home, 'shop-api')
  for (const [name, text] of Object.entries(FILES)) {
    const file = path.join(project, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  for (const [name, text] of Object.entries({
    'build.sh': BUILD,
    'deploy.sh': DEPLOY,
    'logs.sh': LOGS
  })) {
    fs.writeFileSync(path.join(project, name), text, { mode: 0o755 })
  }
  return project
}

// The demo's own ~/.ssh, handed to the app with --custom-dot-ssh-path: the
// SSH step lists these Host names and keys, never the presenter's. ssh is
// kept inside it too: no agent, only these keys, its own known_hosts (the
// app adds that one), and a first connection that accepts the host key
// without asking.
function writeDotSsh(home) {
  const dir = path.join(home, '.ssh')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const name of ['id_ed25519', 'work_ed25519']) {
    const key = path.join(dir, name)
    if (fs.existsSync(key)) continue
    const made = spawnSync(
      'ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', `alice@laptop`, '-f', key],
      { stdio: 'ignore' }
    )
    // Without ssh-keygen the list still shows the names.
    if (made.status !== 0) {
      fs.writeFileSync(key, '', { mode: 0o600 })
      fs.writeFileSync(`${key}.pub`, '')
    }
  }
  const config = [
    "# The demo's ssh config (scripts/demo/fixtures.js)",
    'Host starwars',
    '  HostName starwarstel.net',
    '  User alice',
    '',
    'Host build-box',
    '  HostName 10.20.0.14',
    '  User deploy',
    '',
    'Host staging-db',
    '  HostName 10.20.0.31',
    '',
    'Host git-mirror',
    '  HostName git.shop.internal',
    '',
    'Host *',
    '  IdentityAgent none',
    '  IdentitiesOnly yes',
    `  IdentityFile ${path.join(dir, 'id_ed25519')}`,
    '  StrictHostKeyChecking accept-new',
    '  LogLevel ERROR',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'config'), config, { mode: 0o600 })
  return dir
}

// App-wide settings the demo starts from (the file the app keeps under its
// own config directory): the logo on the idle screen instead of the
// developer log, and the dark theme.
function writeAppPreferences(configHome, productName) {
  const dir = path.join(configHome, productName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'preferences.json'),
    JSON.stringify({ 'zbterm.devb': '0', 'zbterm.theme': 'dark' }, null, 2)
  )
}

module.exports = { writeFixtures, writeDotSsh, writeAppPreferences }
