# ZBTerm — pluggable identity providers (GitHub first) implementation plan

Goal of the whole effort: every ZBTerm peer carries a **display identity** — either
`<username>@github` (cryptographically proven) or `<12-hex>@UNKNOWN` (not proven). On startup an
unauthenticated user is offered a popup to pick one. When sharing or joining, the other side's
identity is shown next to the session with a red question mark (`@UNKNOWN`), an animated spinner
(verification in flight), a green check (verified), or a refusal (verification failed → connection
dropped). The verifier may attach a local name/comment to any remote peer. The provider layer is a
registry so `gitlab`, `google`, … can be added without touching the handshake.

## Repo facts an implementer needs (verified 2026-08-17)

- Three domains: renderer (`renderer/app.js`, `renderer/index.html`) → Electron shell
  (`electron/main.js` → `electron/engine-lifecycle.js` → `electron/engine-client.js`) → **Bare**
  worker (`workers/engine.js` → `engine/index.js` `SessionEngine`). The renderer only ever calls
  `zbterm.invoke(method, args)` and listens to `zbterm:event` (`electron/preload.js`).
- `electron/main.js:1398` (`ipcMain.handle('zbterm:invoke')`) intercepts `app.*`, `debug.*` and
  `profile.*` **in the shell** before forwarding to the worker. That is the extension point for
  identity methods that need OS/network access.
- The worker has **no HTTP client and no unix-socket client**. `require('https')` appears only in
  `electron/update-channel.js`. `~/.ssh` reading, `ssh-agent` and `https://github.com/<u>.keys`
  therefore live in the shell.
- Worker→shell push exists only as engine events. Event names forwarded across the seam are the
  literal list `LOW_RATE_EVENTS` in `engine/rpc/schema.js:112`; `workers/engine.js` subscribes to
  exactly that list and `electron/engine-lifecycle.js` re-emits it. **Adding an event name to that
  one array is all that is needed** — no new frame kinds.
- Node's `crypto.createPrivateKey`/`createPublicKey` **cannot parse OpenSSH keys** (verified:
  `error:1E08010C:DECODER routines::unsupported` on Node 24 for ed25519, RSA, and `.pub` lines).
  All SSH key parsing in this effort is hand-rolled.
- `sodium-native` (already a dependency, loads in Bare and in the shell) has
  `crypto_sign_keypair`, `crypto_sign_detached`, `crypto_sign_verify_detached`,
  `crypto_hash_sha512`, `randombytes_buf` — enough for ed25519 SSH signatures and SSHSIG.
- Account records live under `<profile>/account/` (`engine/index.js:50`, `engine/account-store.js`),
  are JSON, `mode 0o600`, atomically written, and every record must carry `version: VERSION` where
  `VERSION = 2` (`engine/schema.js:4`); `assertVersion` compares for equality, so **adding fields to
  an existing record type is allowed, bumping VERSION is not**.
- Join handshake today: viewer `_handleViewerConnection` (`engine/share-manager.js:1178`) sends
  `{type:'join-request', deviceKey, identityKey, identityProof, deviceName}`; host
  `_confirmJoin` (`:844`) validates link + `verifyDeviceIdentity` + revocation, then either emits
  `approval:pending` or calls `_grantJoin` (`:907`) which replies `{type:'confirm', …}`.
  `identityProof` is a **static, replayable** blob — this is exactly why a live challenge is needed.
- Popups: the shell keeps a `pendingPopups` registry (`electron/main.js:369-433`) exposed over the
  loopback debug server (`GET /popups`, `POST /popups/:id/actions/:action`,
  `electron/debug-server.js:117,131`), mirrored by real renderer modals (`showModal`,
  `renderer/app.js:3247`). `profile-picker` and `share-approval` are the two existing types; the
  identity wizard becomes the third.
- Tests: `npm test` → `brittle-node test/*.test.js`; single file
  `node_modules/.bin/brittle-node test/<file>.test.js`. Lint: `npm run lint` (prettier check +
  lunte), autofix `npm run format`. Full app e2e: `npm run test:debug-server`
  (`test/debug-server-e2e.js`, launches Electron and drives the REST debug server).
- `ssh-keygen` is available on the dev machine and is the intended fixture generator for tests.

## Decisions already made — do not relitigate

1. **Two-layer proof.** An SSH-signed *claim* (minted once, at setup) binds
   `provider+username ↔ zbterm identityKey ↔ a fresh per-device auth ed25519 key`. A *live
   challenge/response* signed by that auth key binds the claim to the peer on this socket. The SSH
   private key is touched only during setup, never during a handshake.
2. **SSHSIG** (`ssh-keygen -Y sign` wire format, namespace `zbterm-identity`, hash `sha512`) is the
   claim signature format, stored armored. A user must be able to verify a claim with stock
   `ssh-keygen -Y verify`.
3. **ed25519 SSH keys only** in v1, for both signing and verifying. RSA/ECDSA/sk-* keys are
   discovered and listed but disabled with a reason string.
4. Encrypted private key files are **not decrypted** by ZBTerm (no bcrypt_pbkdf). The fallback for
   an encrypted key is `ssh-agent` via `SSH_AUTH_SOCK`.
5. GitHub binding is checked against `https://github.com/<username>.keys` (override base URL with
   `ZBTERM_GITHUB_KEYS_BASE`, default `https://github.com`), fetched **in the Electron shell**,
   cached in the worker's account dir.
6. Unknown identity is a **first-class, allowed** state (`<identityKeyHex[0..12]>@UNKNOWN`, red `?`).
   Only a *presented claim that fails verification* refuses the connection. A peer that sends no
   claim at all (older build, or user chose UNKNOWN) connects as unknown.
7. Identity is **per profile** (stored under the selected profile's `account/` dir), like devices.
8. No wire-protocol version bump and no `PROTOCOL` string change: new fields on existing JSON ctl
   messages plus two new message types, all backward compatible.
9. New engine events go into `LOW_RATE_EVENTS`; no new `FrameKind`.

## Phase order and dependencies

| Phase | Title | Depends on |
| --- | --- | --- |
| 1 | Identity core: records, claim/challenge crypto, engine methods | — |
| 2 | Shell SSH provider: key discovery, parsing, SSHSIG signing, ssh-agent | 1 (canonical byte formats only) |
| 3 | GitHub key resolver: shell fetch + worker resolver bridge + cache | 1 |
| 4 | Startup identity wizard (popup + renderer modal) | 1, 2, 3 |
| 5 | Handshake: claim exchange, challenge/response, refusal | 1, 3 |
| 6 | UI: identity badges, peer annotations | 5 (4 for the styles it adds) |
| 7 | End-to-end scenario + architecture docs | all |
| 8 | RSA SSH key support (added 2026-08-18 — Phase 2 signal fired) | 2, 3, 5, 7 |
| 9 | Hardening: adversarial RSA vectors + worker-crash lock recovery (added 2026-08-18) | 7, 8 |

Reorderable: 2 and 3 are independent of each other. 5 may be done before 4 (protocol before UI) if
identity records are seeded by hand; 6 must follow 5. Phase 8 was added after Phase 2 shipped and
ran after 3–7 — those phases remain ed25519-only and did not anticipate it. Phase 9 is an interim
hardening phase: it ships no new user-facing capability, it pays down two debts the earlier phases
knowingly took on (Phase 7's red e2e, Phase 8's hand-rolled verifier) and it is a prerequisite for
calling the identity work releasable.

## Out of scope — do not do these

- ECDSA / FIDO (`sk-*`) SSH keys; decrypting passphrase-protected key files; prompting for a
  passphrase. **RSA moved out of this list on 2026-08-18** — the Phase 2 signal fired (the dev
  machine has only RSA keys), so RSA is now Phase 8. It stays out of scope for phases 3–7.
- Implementing any provider other than `github` and `unknown` (the registry must accept more; do not
  add GitLab/Google/email code).
- Publishing or discovering identities over the DHT; any identity directory or server.
- Changing `keet-identity-key` usage, the device/envelope key model, `VERSION` in
  `engine/schema.js`, epoch/rekey logic, or member records in `engine/session-store.js`.
- Gating *authorization* on identity (caps, link types, approval policy stay exactly as they are).
  Identity affects display and the refuse-on-failed-verification rule only.
- Avatars, GitHub API tokens, OAuth, GitHub org/team lookups.
- Rotating or revoking a claim, multi-identity per profile, migrating existing sessions' member
  records to identity ids.

## Handoff-notes contract

When a phase's verification passes, append a block of **2–5 lines** to the "Handoff notes" section
below, in this shape:

```
### Phase N — <title> (done <YYYY-MM-DD>)
- Decisions: <anything a later phase must honor that was not already in this doc>
- Gotchas: <what bit you, and the workaround now in the code>
- Files: <comma-separated paths added/modified>
- Contracts: <exact new method/event/message names and their argument shapes>
```

Later phases inherit **only** this section plus their own phase text. If you invented a field name,
a status string, or an error code, it must appear here verbatim.

## Completion protocol

This document holds only work that is **not done yet**. When a phase's verification passes:

1. Append its handoff block to "Handoff notes" (above the phase spine).
2. **Cut** the phase's full section out of this file and append it verbatim to
   `docs/identity-providers_CHANGELOG.md` (create it on the first completion, with the phase's
   verification output pasted under it).
3. Leave exactly one line here in its place:
   `## Phase N: <title> — ✅ done (see CHANGELOG)`

## Handoff notes

### Phase 1 — Identity core (done 2026-08-18)
- Decisions: the IdentityStore instance is `engine.identityStore`, **not** `engine.identity` —
  `SessionEngine.prototype.identity()` already owns that name and an instance property would shadow
  it. `identity.beginClaim` also accepts `{sshPublicKey}` (base64 wire blob; fingerprint/keyType
  derived from it) because `claimBytes` needs `sshFingerprint`. `identity.setSelf` additionally
  enforces `claim.identityKey` === local identity key and `claim.authKey` === local device auth key;
  `IdentityStore.setSelf` enforces `fingerprint(pubkeyBlob from the SSHSIG)` === `claim.sshFingerprint`.
  `verifySshSignature` **throws** `EngineError(E_AUTH)` for unsupported key type / malformed armor and
  **returns false** for namespace, hashAlg, pubkey or signature mismatch. Peer status defaults to
  `'unknown'`; `listPeers()` sorts by `lastSeenAt` desc.
- Gotchas: `engine.ready()` cannot be called twice on one instance (rocksdb/catalog FD lock) — reopen
  a second `SessionEngine` over the same userData instead. SSHSIG must be signed over
  `signedDataBlob(ns, 'sha512', msg)` with 70-char-wrapped armor or `ssh-keygen -Y verify` refuses.
  `ensureAuthKeyPair()` runs in `ready()` after `localDevice` is materialized and also assigns
  `localDevice.authPublicKey`/`authSecretKey` in memory.
- Files: engine/identity/claim.js, engine/identity/store.js, engine/identity/providers.js,
  test/identity-claim.test.js, test/identity-store.test.js (added); engine/account-store.js,
  engine/index.js, engine/rpc/schema.js, test/account-store.test.js (modified).
- Contracts: invoke `identity.self`→`{configured,provider,subject,displayId,identityKey,authKey,sshFingerprint,issuedAt}`;
  `identity.beginClaim({provider,subject,sshPublicKey?,sshFingerprint?,sshKeyType?})`→`{claim,bytes}`
  (`bytes` = base64 of `claimBytes`); `identity.setSelf({claim,signature})`→`identity.self` shape
  (E_AUTH on bad sig); `identity.clear()`; `identity.peers()`→peer records;
  `identity.annotatePeer({identityKey,name,comment})`→peer record; `identity.get` now also returns
  `{provider,displayId}`. Event `identity:changed` (payload = `identity.self`) in `LOW_RATE_EVENTS`.
  Modules — `engine/identity/claim.js` exports `{NAMESPACE:'zbterm-identity', HASH_ALG:'sha512',
  KEY_TYPE:'ssh-ed25519', writeString, readString, encodeEd25519PublicKey, decodePublicKeyBlob,
  fingerprint, claimBytes, challengeBytes, signedDataBlob, buildArmoredSignature,
  parseArmoredSignature, verifySshSignature, signChallenge, verifyChallenge, randomHex}`;
  `providers.js` exports `{PROVIDERS, UNKNOWN, GITHUB, GITHUB_USERNAME, getProvider, displayIdFor,
  listProviders}`; `store.js` exports `{IdentityStore, PEER_STATUS}`;
  `AccountStore.ensureAuthKeyPair()`→`{publicKey, secretKey}`.
- Plan edits made after this phase: Phase 3 step 3 and Phase 5 step 4 now say `engine.identityStore`
  instead of `engine.identity`, because the plan's original name collided with the pre-existing
  `SessionEngine.prototype.identity()` method. No re-planning signal fired.

### Phase 2 — Shell SSH provider (done 2026-08-18)
- Decisions: `listCandidates`/`signBytes` take an extra optional `env` (default `process.env`) purely
  so tests can hide the developer's real agent — the shell always calls with defaults. Default-glob
  enumeration also lists an `id_*.pub` whose private half is missing, keyed by the *private* path
  (`path` points at the absent file, `signable:false` until an agent holds it). Non-file candidates
  use `path: null`, `source:'agent'`. `identity.sshCandidates` ignores any renderer-supplied home and
  always uses `os.homedir()`.
- Gotchas: prettier/lunte require braces on multi-line `for-of` and flag `async` test fns with no
  `await`; the OpenSSH private section is parsed by reading ssh strings until only the 1,2,3,… pad
  remains, so the *last* string is the comment for every key type; `ssh-keygen -Y verify` needs
  `-f <allowed_signers> -I <principal> -n zbterm-identity` with the message on **stdin**; `Include`
  is capped at exactly one level (`INCLUDE_DEPTH = 1`).
- Files: electron/ssh-keys.js, test/ssh-keys.test.js (added); electron/main.js (modified).
- Contracts: `electron/ssh-keys.js` exports `{listCandidates({home,env}),
  signBytes({messageBase64,keyPath,publicKeyBlobBase64,env}),
  identityFilesForHost({home,host,configPath}), parseOpenSshPrivateKey(text),
  parsePublicKeyLine(text), agentIdentities({env}), agentSign({publicKeyBlob,data,env})}`. Shell
  invokes `identity.sshCandidates` (no args) and
  `identity.sshSign({messageBase64,keyPath,publicKeyBlobBase64})`, both handled before the
  `engineReady` gate; errors as `{error:{name,code:'E_AUTH',message,details:null}}`; `identity.ssh*`
  args are logged as `'[redacted]'`.
- Plan edits made after this phase (two signals fired, see below): **Phase 8 added** (RSA support) and
  **Phase 4's manual "browse for a key file" entry promoted from optional to required**.

### Phase 3 — GitHub key resolver (done 2026-08-18)
- Decisions: the cache is owned by `IdentityStore` (`readProviderCache(provider, subject)` /
  `writeProviderCache(provider, subject, {status, keys, fetchedAt})`), not by the resolver, so
  subject strings go through `getProvider().validateSubject()` plus a `^[a-z0-9][a-z0-9._-]{0,63}$`
  filename guard before they can become a path; `requestId` is `randomHex(16)` from
  `identity/claim.js`, not `crypto.randomBytes`, to stay Bare-safe; `resolve()` rejects synchronously
  for an unknown provider/invalid subject and its returned answer keeps `blobBase64`, while
  `identity.lookup` strips it to `{keyType, fingerprint}`.
- Gotchas: the timeout timer must **not** be `unref`'d (an unref'd timer never fires in an otherwise
  idle test process, turning "no answer" into a hang — `SessionEngine.close()` calls
  `identityResolver.close()` instead); the `identity:resolve-request` emit happens *after* the async
  cache read, so a test cannot count microtasks to catch it (poll the event array); a 200 with an
  empty body is `{status:'ok', keys:[]}`, never `not-found`.
- Files: electron/github-keys.js, engine/identity/resolver.js, test/github-keys.test.js,
  test/identity-resolver.test.js (added); engine/index.js, engine/rpc/schema.js,
  engine/identity/store.js, electron/main.js (modified).
- Contracts: `fetchKeys(username, {baseUrl, timeoutMs})`→`{status:'ok'|'not-found',
  keys:[{keyType, blobBase64, fingerprint}]}`; `IdentityResolver({store, emit, timeoutMs=10000,
  fetchImpl=null, positiveTtlMs=6h, negativeTtlMs=10min, now})` with `resolve(provider, subject)`→
  `{status, keys, fetchedAt, source:'cache'|'cache-stale'|'remote'}`, `handleResponse({requestId, ok,
  result, error})`, `close()`; engine instance is `engine.identityResolver`; invokes
  `identity.lookup({provider, subject})`→`{provider, subject, status, fetchedAt, source,
  keys:[{keyType, fingerprint}]}` and `identity.resolveResult({requestId, ok, result, error})`→`true`;
  event `'identity:resolve-request'` `{requestId, provider, subject}` (in `LOW_RATE_EVENTS`); cache
  file `account/identity/provider-cache/<provider>/<subject>.json` =
  `{version:2, provider, subject, status, keys, fetchedAt}`. Neither Phase 3 re-planning signal fired.

### Phase 4 — Startup identity wizard (done 2026-08-18)
- Decisions: no gear/settings menu exists in this app, so the "open the wizard anyway" entry point is
  a new `#identitySetup` icon button in the sidebar brand actions; the shell clears `identity-setup`
  on the `identity:changed` engine event; `identity:changed` is now recorded by the debug server so
  `/events` can prove a rejected username never reached the engine; popup `data` carries the live
  wizard state (`provider`, `username`, `fingerprints`, `candidates`, `selectedFingerprint`).
- Gotchas: `showIdentityWizard()` resolves only when the modal CLOSES, so `openIdentityWizard()` must
  fire it and return immediately or the `identity-open` debug command hangs forever;
  `maybeShowIdentityWizard()` is called un-awaited after `startupPhase='ready'` so the wizard never
  gates startup or `/health`; **`debugModalState()` still returns the FIRST `.modal-overlay`, so on a
  fresh profile the auto-opened wizard shadows the share/join modals in `npm run test:debug-server` —
  Phase 7 must dismiss it (`POST /popups/identity-setup/actions/dismiss`) or seed
  `identity.setupDismissed='1'` in each e2e profile.**
- Files: electron/ssh-keys.js, electron/main.js, renderer/app.js, renderer/index.html,
  test/renderer-static.test.js.
- Contracts: shell method `identity.sshInspect({keyPath})`→ one `listCandidates`-shaped candidate with
  `source:'manual'` (E_AUTH on a missing/unparseable path); `sshKeys.inspectKey({keyPath,home,env})`;
  popup action bodies `fill-username {name}`, `select-key {fingerprint}`, `add-key {keyPath}`,
  `submit {}`; preference key `identity.setupDismissed` (`'1'` = skip at startup); renderer debug
  commands `identity-open`, `identity-choose {provider}`, `identity-username {value}`,
  `identity-select-key {fingerprint}`, `identity-add-key {keyPath}`, `identity-submit`, all returning
  `debugModalState()` + `identity:{provider,username,selectedFingerprint,candidates:[{fingerprint,
  keyType,signable,onProvider}]}`; candidates gain an `onProvider` boolean; `document.title` now
  appends the identity `displayId`.

### Phase 5 — Handshake (done 2026-08-18)
- Decisions: `join-request` is sent from synchronous code, so the local claim is read from a new
  engine cache `engine.selfIdentityClaim` (refreshed in `ready()`/`setIdentitySelf`/`clearIdentity`),
  never `await getSelf()`; the viewer has no independent host identityKey (confirm carries only
  `hostIdentityClaim`/`hostAuthKey`), so it verifies against `claim.identityKey` and binds trust via
  `hostAuthKey` + the challenge; **a failed/unknown peer is persisted with `provider:'unknown',
  subject:null` so its `displayId` never renders as `alice@github`** — the claimed provider/subject
  survive only in the emitted event and in `failureReason`; the identity gate runs before
  `approval:pending`, so an approval dialog always sees a settled identity.
- Gotchas: `identity-challenge`/`identity-response` must BYPASS the viewer's `state.messageQueue` —
  the `confirm` handler runs inside that chain and blocks on the response, so queueing it deadlocks.
  Host `join-request` is guarded by `peer.identityState` set synchronously in the ctl switch. A
  missing challenge answer is checked in verify.js *before* the resolver, otherwise a resolver hiccup
  would downgrade a silent prover to `unknown` instead of refusing.
- Files: engine/identity/verify.js, test/identity-handshake.test.js (added); engine/share-manager.js,
  engine/index.js, engine/rpc/schema.js (modified).
- Contracts: `engine/identity/verify.js` exports `{verifyPeerIdentity({claim,authKey,identityKey,
  deviceKey,identityProof,challenge,signature,resolver,store}) -> {status,displayId,provider,subject,
  sshFingerprint,reason}, IDENTITY_TIMEOUT_MS=15000, RESOLVER_UNREACHABLE='resolver-unreachable'}`
  (it also persists the outcome itself via `store.putPeer`). Wire: `join-request` += `identityClaim|
  null`, `authKey|null`; `confirm` += `hostIdentityClaim|null`, `hostAuthKey|null`; new
  `{type:'identity-challenge',challengeId,nonce,sessionId,role:'viewer'|'host'}` and
  `{type:'identity-response',challengeId,signature}` (hex). Event `'share:peer-identity'`
  `{sessionId,direction:'viewer'|'host',identityKey,deviceKey,displayId,provider,status,reason}`.
  `ShareManager.status(sessionId).viewers = [{identityKey,deviceKey,displayId,status}]`.
  `ShareManager#identityTimeoutMs` (settable, or via `engine.identityTimeoutMs`); peer/state fields
  `identityPending`, `identityState`, `identityStatus`, `identityDisplayId`; new debug events
  `host:identity:result`, `viewer:identity:result`, `host:join-request:duplicate`, deny reason
  `identity`.

### Phase 6 — UI badges and peer annotations (done 2026-08-18)
- Decisions: badges live in a `<span class="session-identity">` appended to `.session-main`; the pencil
  is rendered on session-row badges only, **not** in the approval dialog (a second `.modal-overlay`
  would shadow the approval popup in `debugModalState()`); the verified line in the approval dialog is
  a non-danger `.share-warning.modal-warning.identity-note` while the group-link warning keeps
  `share-warning-danger`; a refused join is sticky — `setStatus()` is a no-op while
  `state.identityRefusal` is set, and clicking `#status` dismisses it.
- Gotchas: a peer that presents no claim emits `identityKey:null`, so `applyPeerIdentity` falls back to
  `event.deviceKey` and derives `<12hex>@UNKNOWN` itself — without that a joined session with an
  unknown host rendered no badge at all; `session.list` only carries `viewers` for hosted rows, so the
  viewer's host badge can come only from the event; peer records are read from `identity.peers`
  exactly once (init), never in the render loop.
- Files: renderer/app.js, renderer/index.html, test/renderer-static.test.js.
- Contracts: debug commands `identity-peers` / `identity-annotate {identityKey,name,comment}` both
  return `[{sessionId, identityKey, direction:'viewer'|'host'|null, displayId, status, localName,
  text}]` (rendered row badges first, then known-but-not-rendered peers with `sessionId:null`);
  `__zbtermDebugLayout().identityBadges` is that same array; CSS `.identity-badge`,
  `.identity-badge-text`, `.identity-verified|pending|unknown|failed`, `.identity-collapsed`,
  `.identity-annotate`, `.session-identity`, `.modal-identity`, `.identity-note`, `.status-refused`;
  `showModal` gained `fields[]`, `badge` and `note` options.
- **Collapse rule shipped (Phase 7 asserts against this):** `viewers.length <= 2` → one badge per
  viewer in `share.status().viewers` order. `> 2` → exactly one
  `<span class="identity-badge identity-collapsed identity-<worst>" title="<one viewer per line>">`
  with the worst-status mark and text **`N viewers`** (e.g. `3 viewers`), no pencil; worst-status
  precedence `failed` > `pending` > `unknown` > `verified`. In `identity-peers` the collapsed chip is
  `{sessionId, identityKey:null, direction:"viewer", displayId:"", status:"<worst>", localName:null,
  text:"3 viewers"}`. Individual badge text is `displayId` or `displayId (localName)`; verified
  `title` = SSH fingerprint, failed `title` = failure reason.

### Phase 7 — E2E scenario and architecture docs (done 2026-08-18)
- Decisions: identity apps get one `--storage` root EACH (not the shared one) so a picker could only
  ever list their own profile; `--reset-profiles` now persists window slots BEFORE
  `runWorkerCrashScenario`, which tears the engine down for good.
- Gotchas: **`--storage`/`--electron-user-data` do NOT move `electron/main.js` `stableUserData`**
  (debug log, window state, preferences) — only `XDG_CONFIG_HOME` does, and only on Linux. Before this
  was fixed, every e2e-spawned app wrote into the developer's real `~/.config/ZBTerm` and
  `--reset-profiles` overwrote their real window positions. The suite needs a real display: xterm's
  webgl addon requires WebGL2 that `xvfb-run` cannot supply, with or without `--disable-gpu`.
- Files: test/debug-server-e2e.js, test/fixtures/identity/README.md, docs/ARCHITECTURE.md.
- Contracts: flag `--identity-only`; helpers `assertProfileIsolated(port,name,profileDir)` and
  `assertRealUserDataUntouched(label)`; consts `appConfigRoot=<root>/config` and `realAppConfigDir`;
  fixture gains `storages[name]`; ARCHITECTURE §6.3 "Provider-Backed Identity", worker box gains
  IdentityStore, §13.3 preamble, §15 identity-e2e bullet, §A.3 identity code pointers.
- **Open, accepted by the user:** `npm run test:debug-server` still exits 1 at
  `runWorkerCrashScenario` (`File descriptor could not be locked` — leaked corestore lock after a
  `SIGKILL` respawn, same class as `engine/index.js:1288`/`:1313`). Strongly indicated to be
  pre-existing (a control run with the identity scenario skipped fails identically, 4/4), though the
  control did not isolate this phase's reorder of that call. Everything before that step is green.
  Fixing worker crash recovery is a separate product change → **now Phase 9**.

### Phase 8 — RSA SSH key support (done 2026-08-18)
- Decisions: `KEY_TYPE` stays the string `'ssh-ed25519'` (engine/index.js:1188 uses it as the default
  `sshKeyType`); the new frozen `KEY_TYPES` `['ssh-ed25519','ssh-rsa']` is the set every type check
  consults. **RSA claim verification is in-worker pure-JS BigInt PKCS#1 v1.5 inside
  `engine/identity/claim.js`** — the plan offered "in-worker Node crypto" or "shell bridge" and
  neither was viable, so a third route was taken. No `identity.sshVerify` bridge exists; verification
  still needs nothing but the worker, and Phase 5's "unreachable ⇒ unknown" rule is untouched.
  **This is hand-rolled signature verification and warrants an independent security review** →
  **Phase 9** adds the adversarial vector suite that makes that review evidence-based.
- Gotchas: `bare-crypto` has zero RSA (no `createPublicKey`; `subtle` does ed25519/hmac/pbkdf2/sha
  only) — proven by a spike run under `bare`. ssh-agent sign requests set `flags=4` and the reply's
  algorithm is asserted to be `rsa-sha2-512`, never `'ssh-rsa'`. OpenSSH's private field order
  `n,e,d,iqmp,p,q` maps to JWK with `dp`/`dq` computed as `d mod (p-1)`/`(q-1)` and `qi=iqmp`. Node
  cannot read OpenSSH private containers, so the claim test generates its RSA key with
  `ssh-keygen -m PEM`.
- Files: engine/identity/claim.js, electron/ssh-keys.js, renderer/app.js, docs/ARCHITECTURE.md,
  test/identity-claim.test.js, test/ssh-keys.test.js, test/identity-handshake.test.js.
- Contracts: claim.js adds `KEY_TYPES`, `RSA_KEY_TYPE='ssh-rsa'`, `RSA_SIG_ALG='rsa-sha2-512'`,
  `encodeRsaPublicKey({e,n})`, `writeMpint`, `stripMpint`, `signatureAlgorithmFor(keyType)`;
  `decodePublicKeyBlob` now returns `{type, publicKey, rsa:{e,n}|null}`; `verifySshSignature` throws
  E_AUTH for a bare `ssh-rsa` SSHSIG. `parseOpenSshPrivateKey` adds `rsa:{n,e,d,iqmp,p,q}|null`; the
  unsignable reason is now `"ZBTerm can only sign with ssh-ed25519 or ssh-rsa keys (this key is
  <type>)"`. Neither Phase 8 re-planning signal fired.

### Fired re-planning signals and what changed

- **Phase 2 signal "a real user's GitHub keys are predominantly RSA" — FIRED.** Every key in this
  machine's `~/.ssh` is `ssh-rsa` (`id_rsa`, `id_rsa_BAK`, `id_rsa_string_crypto`), and the key the
  user's ssh config dedicates to this project (`~/.ssh/zbterm-github`) is `ssh-rsa` too. There is
  no ed25519 key on the box, so the ed25519-only wizard would show zero *signable* candidates here.
  Per the signal's own instruction, an RSA path is now a required follow-up phase rather than out of
  scope: **Phase 8** below. Phases 3–7 are unchanged and still ship ed25519-only; Phase 8 widens
  signing and verification afterwards, so nothing earlier needs to anticipate it.
- **Phase 2 signal "`Include` handling proves complex" — partially fired.** The real config has 86
  `Host` blocks and zero `Include`s, so the one-level cap was never stressed. But GitHub is reached
  through an *alias* block (`Host zbterm-github.com` / `HostName github.com` /
  `IdentityFile ~/.ssh/zbterm-github`). The frozen rule "first `Host` pattern matching `github.com`
  wins" matches OpenSSH semantics and correctly does **not** select that block — which means the key
  the user actually pushes to GitHub with is invisible to discovery. Phase 4's manual key-file entry
  is therefore **required**, not optional (contract added to Phase 4).
- **Phase 5 signal "the challenge round trip delays join completion" — partially fired.** The
  challenge itself is 3 ms in-process and one extra RTT on a LAN — not a problem. But on a **cold
  provider cache** the host blocks the join on a `github.com/<user>.keys` fetch through the shell
  seam (up to the resolver's 10 s timeout) before `confirm` is sent. → note added to Phase 6: the
  join UI must tolerate a visibly slow first verification.
- **Phase 5 signal "old-build interop" — not fired, but unverified empirically.** → note added to
  Phase 7.
- **Phase 4 signal "the candidate list is commonly empty" — fired in spirit, already mitigated.** On
  this machine `listCandidates` returns 3 entries but **zero signable** (all `ssh-rsa`). The manual
  key-file path Phase 4 already mandated was necessary and sufficient — no "paste a public key" or
  "generate a key for me" path was added. Phase 7 gained two gotchas as a result (generate the e2e's
  own ed25519 key; dismiss the auto-opened wizard in pre-existing scenarios).
- **Phase 4 signal "`identity.lookup` latency" — did not fire.** `fill-username` returned well inside
  a 20 s budget, so no "Check GitHub" button. Caveat: measured against a local fixture server, not
  real github.com.
- **Phase 2 signal "agent-held keys cover the common case" — did not fire.** `SSH_AUTH_SOCK` is set
  but `ssh-add -l` reports no identities; file parsing stays the primary path.

---

## Phase 1: Identity core — records, claim/challenge crypto, engine methods — ✅ done (see CHANGELOG)

---

## Phase 2: Shell SSH provider — discovery, parsing, SSHSIG signing, ssh-agent — ✅ done (see CHANGELOG)

---

## Phase 3: GitHub key resolver — shell fetch, worker bridge, cache — ✅ done (see CHANGELOG)

---

## Phase 4: Startup identity wizard — ✅ done (see CHANGELOG)

---

## Phase 5: Handshake — claim exchange, live challenge, refusal — ✅ done (see CHANGELOG)

---

## Phase 6: UI — identity badges and peer annotations — ✅ done (see CHANGELOG)

---

## Phase 7: End-to-end scenario and architecture documentation — ✅ done (see CHANGELOG)

---

## Phase 8: RSA SSH key support (signing and verification) — ✅ done (see CHANGELOG)

---

## Phase 9: Hardening — adversarial RSA vectors and worker-crash lock recovery

> Added 2026-08-18. Interim phase: no new user-facing capability. It pays down the two debts the
> earlier phases explicitly booked — Phase 8's hand-rolled RSA verifier has no negative test coverage,
> and Phase 7 left `npm run test:debug-server` red. Both were accepted at the time so the feature
> could land; neither is acceptable to ship on.

### Goal

Two independent deliverables in one phase, both provable by command output:

**A. Adversarial vectors for the RSA verifier.** `verifyRsaSha512` in `engine/identity/claim.js` is a
hand-rolled BigInt PKCS#1 v1.5 implementation (Phase 8 took this third route because `bare-crypto`
has no RSA at all). Today's tests prove it *accepts* real `ssh-keygen` signatures. They do not prove
it *rejects* forged ones. After this phase, every classic attack against a v1.5 verifier is a named,
red-if-broken test.

**B. Worker crash recovery actually recovers.** `npm run test:debug-server` exits 1 at
`runWorkerCrashScenario` with `File descriptor could not be locked`. This is not a test bug to
paper over: it means a user whose engine worker dies gets an engine that cannot come back. Fix the
product, then the suite goes green.

A and B touch disjoint files and can be done in either order.

### Requirements & inputs

Read before editing (A): `engine/identity/claim.js` (`verifyRsaSha512`, `decodePublicKeyBlob`,
`parseArmoredSignature`, `verifySshSignature`), `test/identity-claim.test.js` (the Phase 8 RSA tests
at ~line 222 onward, and the `keygen`/`reArmor` helpers already there).

Read before editing (B): `test/debug-server-e2e.js` (`runWorkerCrashScenario`, ~line 750, called from
`main()` at ~line 537), `electron/engine-client.js` (`respawn()`, `:102`, and `_spawnWorker`),
`electron/engine-lifecycle.js` (`_onWorkerCrash` `:113`, `_giveUpAfterRepeatedCrashes` `:142`),
`engine/profile-manager.js` (`ProfileLock`, `acquireLock`/`acquirePathLock` `:130-142`, `isLocked`
`:298`), and the two existing lock-leak comments in `engine/index.js:1288` and `:1313` — the same
error string, already handled there for a different cause, and the model for how this codebase
reasons about exclusive corestore opens.

Modify (A): `test/identity-claim.test.js`. `engine/identity/claim.js` only if a vector genuinely
fails — that is the whole point of the exercise, and a real forgery acceptance is a security fix, not
a refactor.

Modify (B): whichever of `electron/engine-client.js`, `electron/engine-lifecycle.js`,
`engine/profile-manager.js`, `engine/index.js` the diagnosis actually implicates, plus
`test/debug-server-e2e.js` only if the scenario itself is racing.

Contracts to honor:

- `verifySshSignature` keeps its Phase 1 split: it **throws** `EngineError(E_AUTH)` for an
  unsupported key type or malformed armor, and **returns false** for a namespace, hashAlg, pubkey or
  signature mismatch. Every new vector must assert which of the two it gets — a forgery that throws
  where callers expect `false` is a behavior change, not a pass.
- Bare-safety: tests may use `ssh-keygen` and Node in the test process, but nothing added to
  `engine/identity/claim.js` may use `node:`-prefixed specifiers, `Buffer`, or `crypto` — `b4a` and
  `sodium-native` only, same as the rest of that file.
- Phase 7's isolation guarantees stay intact: `XDG_CONFIG_HOME` per spawned app,
  `assertRealUserDataUntouched()`, `assertProfileIsolated()`. Any change to the e2e keeps all three.
  **Do not weaken, skip, or `try/catch` past a failing assertion to get to exit 0.**

### Steps to perform

**A — adversarial vectors**

1. Generate one 2048-bit RSA key with `ssh-keygen` in a temp dir (reuse the existing `keygen` helper)
   and one real `-Y sign` signature over a known message. That valid pair is the control: every
   vector below is a mutation of it and must fail while the control passes in the same test.
2. Write the vectors. Each is one `t.is(verifySshSignature(...), false, '<name>')` (or a
   `t.exception` where E_AUTH is the contracted outcome):
   - **Bleichenbacher '06 low-exponent forgery.** Build an encoded message with the correct
     `00 01 FF… 00` prefix and DigestInfo but *garbage in the trailing bytes*, take its integer cube
     root, round up, and present that as the signature against an `e=3` key. This is the single most
     important vector — it is the exact attack the full-EM byte-for-byte comparison exists to stop.
   - **Short/loose DigestInfo:** a DigestInfo with an extra NULL parameter, a shorter-than-required
     padding run, or the SHA-512 OID replaced by SHA-256's — all with otherwise valid structure.
   - **Padding shortfall:** an EM with fewer than 8 `0xFF` bytes.
   - **Leading-byte manipulation:** EM starting `00 02` instead of `00 01`; EM missing the leading
     `00`; a signature that is `k-1` or `k+1` bytes long.
   - **Range violations:** `s ≥ n`; `s = 0`; `s = 1`; an even `e`; `e = 1`; `e ≥ n`.
   - **Cross-binding:** a signature that is genuinely valid, but for a *different message*, and one
     valid for a *different key* of the same size.
   - **Size bounds:** a modulus just under `RSA_MIN_MODULUS_BYTES` and just over
     `RSA_MAX_MODULUS_BYTES` are rejected without throwing; a modulus at each boundary is accepted.
3. Add a mutation sanity check: assert that flipping **any single byte** of a valid signature makes
   it fail (sample ~16 positions, not all 256 — keep the test under a second).
4. Run the suite. **If any vector passes verification, stop and report it before writing anything
   else** — that is a live signature-forgery bug and its fix is the priority, not the rest of the list.

**B — crash recovery**

5. Reproduce and *locate* first. Run `npm run test:debug-server 2>&1 | tail -80` and capture: which
   `step(...)` was last printed, which process emitted `File descriptor could not be locked` (host app
   vs. client app vs. worker), and the full stack. Do not start editing before this is written down.
6. Determine which exclusive open is failing — the **profile lock** (`ProfileLock`, a directory +
   `owner.json` with a pid, stale-cleaned by `isLocked`) or a **corestore/RocksDB** open
   (`SessionStore.open*`, the `engine/index.js:1288`/`:1313` family). They produce the same message
   and have completely different fixes. Say which one in the handoff.
7. Fix the root cause, not the symptom. Likely shapes, in order of preference:
   - the respawned worker races the SIGKILLed worker's not-yet-released lock → `respawn()` must
     retry the acquire with a bounded backoff rather than fail the first attempt (note
     `engine-client.js:102`'s own comment already anticipates exactly this failure mode);
   - a store opened by the dying worker is never closed and the *same process* re-opens it → close on
     the error path, as `_doRegisterRemoteSession` already does;
   - the lock's staleness check does not consider a pid that no longer exists → make `isLocked`/
     `acquire` reclaim a lock whose owner pid is gone.
   Whichever it is, add a unit or integration test that fails without the fix — the e2e is too slow
   and too coarse to be the only regression guard.
8. Re-run the full e2e to exit 0, and re-run it once more with `--reset-profiles` to confirm the
   window-slot seeding path (which Phase 7 deliberately ordered before this scenario) still works.

### Acceptance criteria

- `verifyRsaSha512` rejects every vector in step 2, and the control signature still verifies in the
  same test file.
- The Bleichenbacher cube-root vector is present by name and is asserted to return `false`.
- No vector required loosening an existing assertion, and no existing test was deleted or skipped.
- `npm run test:debug-server` exits **0**, with `assertRealUserDataUntouched` and
  `assertProfileIsolated` still called and still passing.
- A non-e2e test exists that fails against the pre-fix crash-recovery code and passes after.
- `npm test` and `npm run lint` are green; test count is strictly greater than 204.
- The handoff block states which lock was at fault and which of step 7's shapes the fix took.

### Verification

Run these and paste the actual output:

```
node_modules/.bin/brittle-node test/identity-claim.test.js
node_modules/.bin/brittle-node test/profile-manager.test.js
npm test
npm run lint
npm run test:debug-server
```

`npm run test:debug-server` needs a real display (Phase 7: xterm's webgl addon needs WebGL2, which
`xvfb-run` cannot supply). Run it on the session's own display.

### Top gotchas

- The e2e's `api()` throws on any popup not in `allowPopupTypes`, and Phase 4's `identity-setup`
  popup auto-opens on a fresh profile — Phase 7 already handles this; do not regress it.
- `runWorkerCrashScenario` is deliberately **last** in `main()` because its final assertion tears the
  host engine down for good, and `--reset-profiles` seeds window slots *before* it. Keep that order.
- The 4-kills-in-60s backoff sequence at the end of the scenario is *supposed* to end with
  `engineReady === false` and a fatal `engine:error`. Do not "fix" that into a green engine.
- A leftover e2e app from a killed run holds ports and profile locks and will make this look like a
  product bug. `prepareStorageRoot()`/`findExistingE2eProcesses()` guard this — check for strays
  before diagnosing.
- Cube-root forgery construction needs exact integer arithmetic; use `BigInt` and verify the
  candidate by cubing it back, not by `Math.cbrt`.

### Re-planning signals

- **A vector is accepted by the verifier.** → The hand-rolled route is not safe as written. Stop,
  report, and re-open the route decision: the shell-bridge option (`identity.sshVerify` on the
  Electron main process, which *is* Node and has real RSA) becomes the recommended fix, with Phase
  5's "resolver unreachable ⇒ unknown, never refused" rule extended to "verifier unreachable ⇒
  unknown". `test/identity-handshake.test.js` already stubs the resolver, so a stub verifier is a
  small addition.
- **The crash failure turns out to be in the test harness, not the product.** → Fix the harness, but
  say so explicitly and drop the "add a non-e2e regression test" criterion, since there would be no
  product bug to guard.
- **The lock failure is inherent to the `SIGKILL`-then-immediately-respawn timing and can only be
  papered over with a sleep.** → Do not add a sleep. Report it, and add a follow-up phase for
  a real handover protocol (worker announces lock release, or the shell owns the lock and lends it).
- **Fixing crash recovery turns out to require changing who owns the profile lock** (shell instead of
  worker). → That contradicts `docs/PHASE2-WORK-PLAN.md` "Profile lock ownership". Stop and raise it;
  it is an architecture decision, not a bug fix.
