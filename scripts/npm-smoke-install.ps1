#!/usr/bin/env pwsh
# Windows counterpart of scripts/npm-smoke-install.sh.
#
# Installs a zbterm tarball into a throwaway global prefix and proves the
# result actually works: the CLI runs, every `zbterm doctor` check is green,
# and the runtime Electron survived the install.
#
#   pwsh scripts/npm-smoke-install.ps1 [tarball]
#
# Why a separate script rather than teaching the bash one about Windows:
# `npm install -g --prefix DIR` puts the bin shims in DIR/bin and the package
# in DIR/lib/node_modules on Unix, but puts the shims in DIR itself and the
# package in DIR/node_modules on Windows. That layout difference is the whole
# reason the bash script refuses to run here; it is not a deeper
# incompatibility - the native dependencies are all N-API and prebuilt.
#
# Nothing outside the temporary prefix is touched: APPDATA/LOCALAPPDATA are
# redirected into the prefix before zbterm is run, so the real
# %APPDATA%\ZBTerm tree is never read or written. The prefix is removed on
# exit, including on failure.
#
# GUI stage: there is none. GitHub's windows-latest runners have no usable
# interactive desktop for an Electron window, so this script asserts `doctor`
# only - the headless engine boot is covered by the Linux job, which has
# xvfb-run. Keep that limitation visible in the CI job name.
#
# Exit status: 0 when every stage passed, 1 otherwise.

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string] $Tarball = '',

  [switch] $Help
)

Set-StrictMode -Version Latest
# NOTE: this does NOT make a failing native command throw. PowerShell only
# surfaces exit codes from external programs through $LASTEXITCODE, and a
# pipeline swallows them entirely, so every `npm`/`zbterm`/`node` call below
# checks $LASTEXITCODE explicitly.
$ErrorActionPreference = 'Stop'

function Show-Usage {
  @'
Usage: pwsh scripts/npm-smoke-install.ps1 [tarball] [-Help]

Smoke-tests an installed zbterm npm tarball on Windows. Runnable from any
cwd; the repo root is resolved from this script's own path.

  tarball   Path to a zbterm-*.tgz. Defaults to the tarball for the current
            package version in the repo root, and runs `npm pack` to build one
            if it is not there. Use scripts/npm-pack-check.sh to produce a
            validated tarball first.

What it does:
  1. Installs the tarball into a fresh directory under $env:TEMP used as an
     `npm install -g --prefix`.
  2. Runs `zbterm --version`.
  3. Runs `zbterm doctor --json` and asserts on the PARSED report: the
     command must exit 0 AND every check must report ok:true. Exit code alone
     is not trusted here.
  4. Asserts the installed tree still has a runtime `electron` (a global
     install drops devDependencies, so the deliberate duplicate listing of
     electron in both dependency blocks must not be the only copy).
'@ | Write-Output
}

if ($Help) {
  Show-Usage
  exit 0
}

function Step($message) { Write-Output "==> $message" }
function Ok($message) { Write-Output "    ok: $message" }
function Die($message) {
  Write-Output "    FAIL: $message"
  [Console]::Error.WriteLine("npm-smoke-install: $message")
  exit 1
}

$Root = Split-Path -Parent $PSScriptRoot

if (-not $Tarball) {
  $version = (Get-Content -Raw (Join-Path $Root 'package.json') | ConvertFrom-Json).version
  $Tarball = Join-Path $Root "zbterm-$version.tgz"
  if (-not (Test-Path -LiteralPath $Tarball)) {
    Step "No tarball given and $Tarball is missing - running npm pack"
    $packOut = & npm pack --pack-destination $Root
    if ($LASTEXITCODE -ne 0) {
      Write-Output ($packOut | Out-String)
      Die "npm pack exited $LASTEXITCODE"
    }
  }
}
if (-not (Test-Path -LiteralPath $Tarball)) { Die "tarball not found: $Tarball" }
$Tarball = (Resolve-Path -LiteralPath $Tarball).Path

$Prefix = Join-Path ([System.IO.Path]::GetTempPath()) ("zbterm-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 12))
New-Item -ItemType Directory -Path $Prefix -Force | Out-Null

try {
  Step "Temporary global prefix: $Prefix"

  Step "Installing $Tarball"
  # ignore-scripts is pinned off explicitly: the electron and node-pty install
  # scripts have to run, and the repo-local .npmrc that normally guarantees
  # that does not apply to an install targeting a different prefix.
  #
  # --omit=optional is never passed: @lydell/node-pty ships its binary as six
  # per-platform OPTIONAL dependencies, so omitting them leaves the install
  # with no pty at all.
  & npm install -g --prefix $Prefix --ignore-scripts=false $Tarball
  if ($LASTEXITCODE -ne 0) { Die "npm install exited $LASTEXITCODE" }

  # Windows layout: shims land in the prefix itself, the package under
  # <prefix>\node_modules. (Unix: <prefix>\bin and <prefix>\lib\node_modules.)
  $Bin = Join-Path $Prefix 'zbterm.cmd'
  if (-not (Test-Path -LiteralPath $Bin)) { Die "no shim at $Bin" }
  Ok $Bin

  $Installed = Join-Path $Prefix 'node_modules\zbterm'
  if (-not (Test-Path -LiteralPath $Installed)) { Die "installed package not found at $Installed" }

  # Sandbox the app's user data only now: npm's own defaults read APPDATA, and
  # the install above should see the real environment.
  $env:APPDATA = Join-Path $Prefix 'appdata-roaming'
  $env:LOCALAPPDATA = Join-Path $Prefix 'appdata-local'
  $env:ZBTERM_ELECTRON_USER_DATA = Join-Path $Prefix 'electron-user-data'
  New-Item -ItemType Directory -Path $env:APPDATA, $env:LOCALAPPDATA -Force | Out-Null

  Step 'zbterm --version'
  & $Bin --version
  if ($LASTEXITCODE -ne 0) { Die "zbterm --version exited $LASTEXITCODE" }

  Step 'Checking the installed tree kept a runtime electron'
  # Written to a file rather than passed with `node -e`: a multi-line script
  # argument has to survive PowerShell's native-argument quoting, and a file
  # sidesteps that entirely.
  $probeFile = Join-Path $Prefix 'electron-probe.js'
  @'
const path = require('path')
const root = process.argv[2]
try {
  const binary = require(path.join(root, 'node_modules', 'electron'))
  if (typeof binary === 'string' && binary) { process.stdout.write(binary); process.exit(0) }
} catch (err) {
  process.stderr.write(String(err && err.message) + '\n')
}
process.exit(1)
'@ | Set-Content -LiteralPath $probeFile -Encoding utf8
  $probeOut = & node $probeFile $Installed
  $probeExit = $LASTEXITCODE
  $electronBinary = ($probeOut | Out-String).Trim()
  if ($probeExit -ne 0 -or -not $electronBinary) {
    Die 'the global install has no usable electron (devDependencies are dropped - electron must stay in dependencies too)'
  }
  if (-not (Test-Path -LiteralPath $electronBinary)) {
    Die "electron binary is missing: $electronBinary"
  }
  Ok "electron binary: $electronBinary"

  Step 'zbterm doctor --json'
  # Captured into a variable rather than redirected to a file: `>` picks an
  # encoding that differs between Windows PowerShell 5.1 (UTF-16LE) and pwsh
  # (UTF-8), and reading it back wrong would look like broken JSON. Assigning
  # the output of a bare call - no pipeline - keeps $LASTEXITCODE intact.
  $doctorLines = & $Bin doctor --json
  $doctorExit = $LASTEXITCODE
  $raw = ($doctorLines | Out-String).Trim()
  if (-not $raw) { Die "zbterm doctor --json produced no output (exit $doctorExit)" }

  $report = $null
  try {
    $report = $raw | ConvertFrom-Json
  } catch {
    Write-Output $raw
    Die "zbterm doctor --json did not produce parseable JSON (exit $doctorExit)"
  }

  $checks = if ($null -ne $report.PSObject.Properties['checks']) { $report.checks } else { $report }
  if (-not $checks) { Die 'zbterm doctor --json reported no checks' }

  $failed = @()
  foreach ($check in $checks) {
    $isInfo = ($null -ne $check.PSObject.Properties['info']) -and $check.info
    $label = if ($isInfo) { 'INFO' } elseif ($check.ok) { 'PASS' } else { 'FAIL' }
    Write-Output ("    {0} {1}: {2}" -f $label, $check.name, $check.detail)
    if (-not $check.ok) {
      $failed += $check.name
      if ($check.fix) { Write-Output ("         fix: {0}" -f $check.fix) }
    }
  }

  # Both gates, deliberately: the parsed report is the real assertion, the exit
  # code is a cheap cross-check that doctor agrees with itself.
  if ($failed.Count -gt 0) {
    Die ("doctor checks reported ok:false: " + ($failed -join ', '))
  }
  if ($doctorExit -ne 0) { Die "zbterm doctor --json exited $doctorExit" }
  Ok 'doctor: every check ok'

  Write-Output '==> GUI stage SKIPPED: Windows runners have no usable desktop for Electron.'
  Write-Output '    The install was verified only through `zbterm doctor`.'
  Write-Output '==> Smoke install passed.'
  exit 0
} finally {
  Remove-Item -LiteralPath $Prefix -Recurse -Force -ErrorAction SilentlyContinue
}
