# Identity e2e fixtures

This directory is deliberately (almost) empty: **no key material is committed.**

`test/debug-server-e2e.js` needs an unencrypted ed25519 SSH key it can sign a
`zbterm-identity-claim/v1` with, and a `https://github.com/<user>.keys`
document that publishes the matching public key. Both are produced at test
time, inside the e2e's temp root:

- **Keys.** `generateEd25519Key()` shells out to `ssh-keygen -q -t ed25519 -N ''`
  once per app instance, writing into that instance's own fake `HOME`
  (`<e2e root>/identity/<app>-home/.ssh/id_ed25519`). Three keys are made per
  run: the host's, the bad host's, and one "unrelated" key that only the stub
  publishes. `HOME` is overridden **per app instance** so one instance's
  fixture `~/.ssh` can never leak into another's candidate list — and so the
  developer's real `~/.ssh` (which on the machine this was written on holds
  only RSA keys, i.e. nothing signable in this version) is never consulted.
- **Provider.** `startIdentityKeysServer()` runs a loopback `http.createServer`
  that answers `GET /<user>.keys` with one public key line. Both app instances
  are spawned with `ZBTERM_GITHUB_KEYS_BASE=http://127.0.0.1:<port>`, so no
  part of the scenario touches github.com.

## Staying out of the developer's real data

Three separate things have to be redirected before an app instance is safely
isolated, and only the first two are flags:

- `--profile-path <e2e root>/identity/<app>-profile` — the profile data the
  engine opens. Per instance.
- `--storage <e2e root>/identity/<app>-storage` — `pearDataRoot()`, i.e. the
  profile _registry_ a profile picker would enumerate. Per instance too, so the
  only profile any identity app can see is its own.
- `XDG_CONFIG_HOME=<e2e root>/config` — set by `startApp()` for **every**
  spawned app, identity or not. `electron/main.js` captures
  `stableUserData = app.getPath('userData')` before it repoints Chromium and
  keeps `debug_main.log`, `window-state.json`, `window-state.lock` and
  `preferences.json` there for the life of the process; no command-line flag
  moves them. Without the override those four files land in the developer's own
  `~/.config/ZBTerm`, which means an e2e run appends to their debug log and —
  under `--reset-profiles`, which tiles windows into screen quarters —
  overwrites the window positions of their real app.

`assertProfileIsolated()` proves the first two positively through the REST API
(the engine's device key must match the one in `<profile>/local-device-key.json`)
and fails the run if a `profile-picker` popup is present at all.
`assertRealUserDataUntouched()` proves the third: `main.js` writes to its debug
log during module evaluation, so an instance that resolved to the real data
directory changes that file's mtime within milliseconds of starting, long
before it could reach any UI.

This suite needs a real display. The renderer opens xterm's WebGL addon, which
requires WebGL2, and `xvfb-run` does not provide it — with or without
`--disable-gpu` or SwiftShader the renderer reports `WebGL2 not supported` and
`/health` never turns `ok`.

Nothing here is reusable across runs on purpose: the fixture directory is
deleted and regenerated at the start of every identity scenario, because a
profile that already carries an identity would never show the setup wizard the
scenario drives.

Run it with:

```
node test/debug-server-e2e.js --identity-only
```

Committing a private key here — even a throwaway one — would defeat the point:
`git status` must stay clean of key files after a run.
