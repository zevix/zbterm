# ZBTerm identity providers — changelog of completed phases

Phases are appended here in order as they are verified and cut from `identity-providers_plan.md`.

> **2026-09-28 (Z3 of `docs/projects/260928_zbterm-fork/`, D-27).** This log predates the ZBTerm
> fork; the two `forge.config.js` lint-output paths below ran in the predecessor repository
> (frozen at commit `b856e15`), not this tree. Left as mechanically renamed text rather than
> rewriting the transcript by hand.

---

## Phase 1: Identity core — records, claim/challenge crypto, engine methods

### Goal

The worker owns a complete, tested identity model with no network and no SSH-file access: a
per-device auth signing keypair, an `IdentityStore` under `<profile>/account/identity/`, a provider
registry with `unknown` and `github`, canonical byte encodings for the identity **claim** and the
handshake **challenge**, SSHSIG build/verify for ed25519, and engine invoke methods that let a
caller mint the bytes to be SSH-signed, install a signed claim, read the local identity, and read
and annotate peer identities. Nothing in the UI or the wire uses it yet.

### Requirements & inputs

Read before editing: `engine/index.js` (constructor `:37-84`, `ready()` `:86`, `invoke()` `:134`,
`identity()` `:1074`), `engine/account-store.js` (whole file), `engine/schema.js` (`VERSION`),
`engine/errors.js`, `engine/crypto.js` (export style), `engine/rpc/schema.js:112`
(`LOW_RATE_EVENTS`), `test/account-store.test.js` and `test/crypto.test.js` (test style).

Create: `engine/identity/claim.js`, `engine/identity/store.js`, `engine/identity/providers.js`,
`test/identity-claim.test.js`, `test/identity-store.test.js`.
Modify: `engine/account-store.js`, `engine/index.js`, `engine/rpc/schema.js`.

Contracts to honor (frozen — later phases encode/parse exactly these bytes):

- **Auth keypair.** `AccountStore.ensureAuthKeyPair()` returns `{publicKey, secretKey}` (Buffers).
  It lazily generates a `sodium.crypto_sign_keypair()` and persists `authPublicKey` /
  `authSecretKey` (hex) into the existing `device/<deviceKey>.json` record, keeping
  `version: VERSION` (2) untouched. `materializeDevice()` gains `authPublicKey` / `authSecretKey`
  Buffers so `engine.localDevice.authPublicKey` works. `engine.ready()` calls it once.
- **Display id.** `github` → `<username-lowercased>@github`. `unknown` →
  `<identityKeyHex.slice(0, 12)>@UNKNOWN`. Never render a raw key anywhere else.
- **Username rule (github).** `/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/`, stored and
  compared lowercased.
- **Claim record** `identity/self.json`:
  ```json
  { "version": 2, "provider": "github", "subject": "octocat",
    "identityKey": "<hex>", "authKey": "<hex>",
    "sshPublicKey": "<ssh wire blob, base64>", "sshKeyType": "ssh-ed25519",
    "sshFingerprint": "SHA256:…", "issuedAt": 1750000000000, "nonce": "<32 hex chars>",
    "signature": "-----BEGIN SSH SIGNATURE-----\n…", "createdAt": 1750000000000 }
  ```
  `provider: "unknown"` records store `{version, provider:"unknown", identityKey, createdAt}` only.
- **Canonical claim bytes** — `claimBytes(claim)` in `engine/identity/claim.js`, LF-separated ASCII,
  trailing LF, fields in exactly this order, no JSON:
  ```
  zbterm-identity-claim/v1
  provider=<provider>
  subject=<subject>
  identityKey=<hex>
  authKey=<hex>
  sshFingerprint=<SHA256:…>
  issuedAt=<ms>
  nonce=<32 hex chars>
  ```
- **Canonical challenge bytes** — `challengeBytes(challenge)`, same style:
  ```
  zbterm-identity-challenge/v1
  sessionId=<sessionId or "">
  challengeId=<32 hex chars>
  nonce=<64 hex chars>
  verifierDhtKey=<hex>
  proverDhtKey=<hex>
  role=<host|viewer>
  ```
  `role` is the **prover's** role. Both DHT keys are mandatory and come from the live socket
  (`socket.remotePublicKey` / own DHT key) — that is what defeats a relaying MITM.
- **SSHSIG.** `signedDataBlob(namespace, hashAlg, message)` =
  `"SSHSIG"` ‖ `string(namespace)` ‖ `string("")` ‖ `string(hashAlg)` ‖ `string(sha512(message))`.
  Armored container decodes to `"SSHSIG"` ‖ `uint32 1` ‖ `string(pubkeyBlob)` ‖ `string(namespace)`
  ‖ `string("")` ‖ `string(hashAlg)` ‖ `string(sigBlob)`, where `sigBlob` =
  `string("ssh-ed25519")` ‖ `string(64-byte raw sig)`. `string(x)` is uint32-BE length + bytes.
  Namespace is `zbterm-identity`, hash `sha512`. Armor: `-----BEGIN SSH SIGNATURE-----`, base64 in
  70-char lines, `-----END SSH SIGNATURE-----`.
- **Fingerprint.** `SHA256:` + base64(sha256(pubkeyBlob)) with `=` padding stripped — identical to
  `ssh-keygen -lf`.
- **Peer record** `identity/peers/<identityKeyHex>.json`:
  `{version:2, identityKey, provider, subject, displayId, status, lastVerifiedAt, lastSeenAt,
    localName, localComment, sshFingerprint, failureReason}` where `status ∈
  'unknown'|'pending'|'verified'|'failed'`.
- **Engine methods** added to `SessionEngine.invoke` (`engine/index.js:134`):
  `identity.self` → `{configured, provider, subject, displayId, identityKey, authKey,
  sshFingerprint, issuedAt}`; `identity.beginClaim({provider, subject})` → `{claim, bytes}` where
  `bytes` is base64 of `claimBytes` and `claim` is the unsigned record (fresh `nonce`, `issuedAt`);
  `identity.setSelf({claim, signature})` → verifies the SSHSIG locally before writing, throws
  `EngineError(CODES.E_AUTH, …)` if it does not verify, returns the same shape as `identity.self`;
  `identity.clear()` → drops to unknown; `identity.peers()` → array of peer records;
  `identity.annotatePeer({identityKey, name, comment})` → updated peer record.
- **Event** `identity:changed` (payload = `identity.self` result) appended to `LOW_RATE_EVENTS`.

### Steps to perform

1. `engine/identity/claim.js`: ssh wire codec (`readString`/`writeString`), ed25519 pubkey blob
   encode/decode, `fingerprint(blob)`, `claimBytes`, `challengeBytes`, `signedDataBlob`,
   `buildArmoredSignature({pubkeyBlob, rawSig})`, `parseArmoredSignature(armored)` →
   `{pubkeyBlob, namespace, hashAlg, rawSig}`, `verifySshSignature({message, armored,
   expectedPublicKeyBlob?})` → boolean (rejects non-`ssh-ed25519`, wrong namespace, wrong hashAlg,
   pubkey mismatch), `signChallenge(secretKey, challenge)` / `verifyChallenge(publicKey, challenge,
   sig)` using `sodium.crypto_sign_detached`.
2. `engine/identity/providers.js`: registry keyed by provider id. Each entry:
   `{id, label, displayId(subject), validateSubject(subject), needsResolver}`. Export
   `getProvider(id)` throwing `EngineError(CODES.E_AUTH, 'Unknown identity provider: …')`, and
   `PROVIDERS` for the UI. Only `unknown` and `github`.
3. `engine/identity/store.js`: `IdentityStore(rootDir)` with atomic 0o600 JSON read/write copied
   from `AccountStore._writeJson` semantics (tmp file + rename + chmod), and methods `ready()`,
   `getSelf()`, `setSelf(record)`, `clearSelf()`, `listPeers()`, `getPeer(idHex)`,
   `putPeer(idHex, patch)` (merge, never drop `localName`/`localComment`).
4. `engine/account-store.js`: `ensureAuthKeyPair()` + `materializeDevice` fields, as specified.
5. `engine/index.js`: construct `this.identity = new IdentityStore(path.join(dataRoot,
   'account/identity'))` next to `this.account`; in `ready()` call `this.identity.ready()` and
   `this.account.ensureAuthKeyPair()`; add the six invoke methods; keep the existing
   `identity()` method (device/DHT keys) untouched but have `identity.get` also return
   `displayId` and `provider` so existing debug consumers see identity at a glance.
6. `engine/rpc/schema.js`: append `'identity:changed'` to `LOW_RATE_EVENTS`.
7. Tests as listed in Acceptance criteria.

### Acceptance criteria

- `test/identity-claim.test.js` proves: (a) a claim signed by this code verifies with the real
  `ssh-keygen -Y verify` against an `ssh-keygen`-generated ed25519 key and an allowed-signers file;
  (b) a signature produced by real `ssh-keygen -Y sign -n zbterm-identity` verifies with
  `verifySshSignature`; (c) fingerprints match `ssh-keygen -lf` output byte for byte; (d) flipping
  any single field of the claim makes verification fail; (e) an RSA-key SSHSIG is rejected with a
  clear error, not a crash. Tests `t.skip` (not fail) if `ssh-keygen` is absent.
- `test/identity-store.test.js` proves: self record round-trips; `setSelf` rejects a claim whose
  signature does not match its bytes; `annotatePeer` preserves prior status fields; peer files are
  `0o600`; `clearSelf` leaves peers intact.
- `challengeBytes` output for a fixed input is asserted against a literal string in the test (the
  format is now frozen).
- `engine.ready()` on a fresh profile writes `authPublicKey`/`authSecretKey` into the device record
  and a second `ready()` does not rotate them.
- An account record written by the pre-change code still loads (add a fixture that omits the auth
  fields).

### Verification

```
node_modules/.bin/brittle-node test/identity-claim.test.js
node_modules/.bin/brittle-node test/identity-store.test.js
node_modules/.bin/brittle-node test/account-store.test.js
npm test
npm run lint
```
Pass = every brittle run ends `# ok` with no failing assertions, `npm test` shows no regressions in
the pre-existing files, and lint exits 0.

### Top gotchas

- `sodium.crypto_sign_keypair(pk, sk)` fills **caller-allocated** buffers
  (`crypto_sign_PUBLICKEYBYTES` / `crypto_sign_SECRETKEYBYTES`); it does not return an object.
- `crypto_sign_detached(sig, message, secretKey)` needs the 64-byte secret key; the OpenSSH "private
  key" for ed25519 is already that 64-byte value (seed ‖ pubkey), not a 32-byte seed.
- SSHSIG signs `signedDataBlob(...)` — i.e. ed25519 over a blob that *contains* `sha512(message)`,
  not over the message. Signing the message directly silently produces something `ssh-keygen -Y
  verify` rejects.
- The armored base64 must be line-wrapped at 70 chars or `ssh-keygen -Y verify` refuses it.
- `assertVersion` in `account-store.js` throws on any record whose `version !== 2`. New identity
  records must set `version: 2` even though they are a different record family.
- The worker runs under Bare: use `require('fs')`/`require('path')` (mapped by the `imports` field
  in `package.json`), never `node:fs`, and no `Buffer.from(x, 'base64url')` exotics — `b4a` is the
  house style for hex/base64 conversions.

### Re-planning signals

- If `ssh-keygen -Y verify` cannot be made to accept our armored output after ~an hour, drop SSHSIG
  for a plain `zbterm-sig/v1` blob (raw ed25519 over `claimBytes`) and record that in the handoff —
  Phase 2's signer and Phase 5's verifier both change shape.
- If `sodium-native` turns out to be unavailable in some target the shell also needs (Phase 2 runs
  in Electron main), note it: the SSHSIG helpers may need to move to a runtime-neutral module.
- If `AccountStore` mutation for the auth keypair conflicts with the profile lock in a way that
  surfaces in `profile-manager.test.js`, the keypair may need its own record file — flag it.

### Handoff notes

### Phase 1 — Identity core (done 2026-08-18)
- Decisions: the IdentityStore instance is `engine.identityStore`, NOT `engine.identity` — `SessionEngine.prototype.identity()` already owns that name and an instance property would shadow it (plan text was self-contradictory here). `identity.beginClaim` also accepts `{sshPublicKey}` (base64 wire blob; fingerprint/keyType derived from it) because `claimBytes` needs `sshFingerprint`. `identity.setSelf` additionally enforces claim.identityKey === local identity key and claim.authKey === local device auth key; `IdentityStore.setSelf` enforces fingerprint(pubkeyBlob from the SSHSIG) === claim.sshFingerprint. `verifySshSignature` THROWS EngineError(E_AUTH) for unsupported key type / malformed armor and RETURNS false for namespace, hashAlg, pubkey or signature mismatch. Peer status default is 'unknown'; peers sort by lastSeenAt desc.
- Gotchas: engine.ready() cannot be called twice on one instance (rocksdb/catalog FD lock) — the "does not rotate" test reopens a second SessionEngine on the same userData. SSHSIG must be signed over signedDataBlob(ns, 'sha512', msg) with a 70-char-wrapped armor or `ssh-keygen -Y verify` refuses. `ensureAuthKeyPair()` is called in ready() after localDevice is materialized and also assigns `localDevice.authPublicKey/authSecretKey` in memory (materializeDevice only fills them once the record has them).
- Files: engine/identity/claim.js, engine/identity/store.js, engine/identity/providers.js, test/identity-claim.test.js, test/identity-store.test.js (added); engine/account-store.js, engine/index.js, engine/rpc/schema.js, test/account-store.test.js (modified).
- Contracts: invoke `identity.self`→{configured,provider,subject,displayId,identityKey,authKey,sshFingerprint,issuedAt}; `identity.beginClaim({provider,subject,sshPublicKey?,sshFingerprint?,sshKeyType?})`→{claim,bytes(base64 of claimBytes)}; `identity.setSelf({claim,signature})`→identity.self shape (E_AUTH on bad sig); `identity.clear()`; `identity.peers()`→peer records; `identity.annotatePeer({identityKey,name,comment})`→peer record; `identity.get` now also returns {provider,displayId}. Event `identity:changed` (payload = identity.self) in LOW_RATE_EVENTS. Modules: engine/identity/claim.js exports {NAMESPACE:'zbterm-identity',HASH_ALG:'sha512',KEY_TYPE:'ssh-ed25519',writeString,readString,encodeEd25519PublicKey,decodePublicKeyBlob,fingerprint,claimBytes,challengeBytes,signedDataBlob,buildArmoredSignature,parseArmoredSignature,verifySshSignature,signChallenge,verifyChallenge,randomHex}; providers.js exports {PROVIDERS,UNKNOWN,GITHUB,GITHUB_USERNAME,getProvider,displayIdFor,listProviders}; store.js exports {IdentityStore,PEER_STATUS}; AccountStore.ensureAuthKeyPair()→{publicKey,secretKey}.

### Verification output (all five commands, exit 0)

```
$ node_modules/.bin/brittle-node test/identity-claim.test.js
ok 2 - ssh-keygen -Y verify: Good "zbterm-identity" signature for zbterm@test with ED25519 key SHA256:MTenLNfdkVv8w2EJhHavI5adLVMB4QR2Bi5Ck0IUq7g
ok 10 - armored signatures wrap base64 at 70 characters # time = 0.444209ms

1..10
# tests = 10/10 pass
# asserts = 45/45 pass
# time = 129.066894ms

# ok

$ node_modules/.bin/brittle-node test/identity-store.test.js
ok 7 - engine identity methods mint, install, annotate and clear identities # time = 33.037657ms

1..7
# tests = 7/7 pass
# asserts = 64/64 pass
# time = 299.373682ms

# ok

$ node_modules/.bin/brittle-node test/account-store.test.js
ok 5 - account records written before the auth keypair existed still load # time = 24.269072ms

1..5
# tests = 5/5 pass
# asserts = 27/27 pass
# time = 211.727169ms

# ok

$ npm test
1..146
# tests = 146/146 pass
# asserts = 751/751 pass
# time = 19376.415136ms

# ok

$ npm run lint
> zbterm@1.0.44 lint
> prettier --check package.json forge.config.js electron engine renderer test workers && lunte electron engine renderer test workers forge.config.js

Checking formatting...
All matched files use Prettier code style!
... (80 pre-existing require-await WARNINGs, none in new/changed files) ...
80 warnings
```

Re-planning signals: none fired. `ssh-keygen -Y verify` accepts our armored SSHSIG (signal negative — SSHSIG stays); `sodium-native` + `b4a` + mapped `fs`/`path` are the only deps in `engine/identity/*`; `test/profile-manager.test.js` and the whole suite pass with the auth-keypair mutation in place.

---

## Phase 2: Shell SSH provider — discovery, parsing, SSHSIG signing, ssh-agent

### Goal

The Electron shell can answer "which SSH keys could this user have on GitHub?" and "sign these bytes
with key X". `~/.ssh/config` is parsed for the `github.com` host's `IdentityFile`(s); if none, the
usual `~/.ssh/id_*` candidates are enumerated. Each candidate is reported with its type,
fingerprint, comment, whether it is encrypted, and whether ZBTerm can sign with it (directly for an
unencrypted ed25519 file, or via `ssh-agent` when the agent holds it). Signing produces the armored
SSHSIG defined in Phase 1. Two new shell-intercepted invoke methods expose this to the renderer.

### Requirements & inputs

Read before editing: `electron/main.js:1398-1455` (`zbterm:invoke` interception and
`handleProfileInvoke` pattern around `:960-1006`), `engine/identity/claim.js` (Phase 1: ssh wire
codec, `fingerprint`, `buildArmoredSignature`, `signedDataBlob`), the Phase 1 handoff block.

Create: `electron/ssh-keys.js`, `test/ssh-keys.test.js`. Modify: `electron/main.js`.

Contracts to honor:

- `electron/ssh-keys.js` exports:
  - `listCandidates({home = os.homedir()})` → `Promise<Array<{path, source:'ssh-config'|'default'|
    'agent', keyType, fingerprint, comment, publicKeyBlobBase64, encrypted:boolean,
    signable:boolean, reason:string|null}>>` sorted: ssh-config matches first, then `id_ed25519`,
    then other `id_*`, then agent-only keys. Never throws for an unreadable/malformed key — that
    key is reported with `signable:false` and a `reason`.
  - `signBytes({messageBase64, keyPath = null, publicKeyBlobBase64 = null})` →
    `Promise<{signature, publicKeyBlobBase64, fingerprint, via:'file'|'agent'}>` where `signature`
    is the armored SSHSIG string.
- Discovery rules, in order: (1) parse `~/.ssh/config` — case-insensitive keywords, `Host`/`Match`
  blocks, `Include` directives resolved one level, first `Host` pattern matching `github.com` wins,
  take every `IdentityFile` in it (expand `~`, `%d`); (2) if no config match, glob `~/.ssh/id_*`
  excluding `*.pub`, `known_hosts*`, `config`, `authorized_keys`; (3) always union in keys offered
  by `ssh-agent` if `SSH_AUTH_SOCK` is set.
- Private-key parsing (`openssh-key-v1\0`): read ciphername/kdfname/kdfoptions/nkeys, public blob,
  private section. `ciphername !== 'none'` ⇒ `encrypted: true`, `signable` only if the agent holds
  that public key. Unencrypted ed25519 ⇒ check1 === check2, keytype `ssh-ed25519`, 32-byte pub,
  64-byte priv.
- ssh-agent protocol over `net.connect({path: process.env.SSH_AUTH_SOCK})`: frames are
  uint32-BE length + payload; `REQUEST_IDENTITIES = 11` → `IDENTITIES_ANSWER = 12`
  (`uint32 nkeys`, then `string blob, string comment`); `SIGN_REQUEST = 13`
  (`string blob, string data, uint32 flags=0`) → `SIGN_RESPONSE = 14` (`string sigblob`). Agent
  errors (`SSH_AGENT_FAILURE = 5`) become a rejected promise with an actionable message. Hard 5s
  timeout on any agent round trip.
- Shell invoke methods, added in `ipcMain.handle('zbterm:invoke')` **before** the
  `lifecycle.engineReady` check, in a `method.startsWith('identity.ssh')` branch (they must work
  while the engine is still starting): `identity.sshCandidates` → `listCandidates(...)`;
  `identity.sshSign({messageBase64, keyPath, publicKeyBlobBase64})` → `signBytes(...)`. Errors are
  returned in the existing `{error:{name, code, message}}` envelope with `code: 'E_AUTH'`.
- The signer never logs key material; `console.log(debugPrefix('zbterm:invoke'), method,
  JSON.stringify(args))` at `electron/main.js:1399` would print arguments — redact `identity.ssh*`
  args to `'[redacted]'` there.

### Steps to perform

1. Write `electron/ssh-keys.js` with sections: ssh-config parser, candidate enumeration, OpenSSH
   private-key parser, `.pub` line parser, agent client, `signBytes` (file path first, agent
   fallback when the file is encrypted or absent).
2. Import Phase 1's `engine/identity/claim.js` helpers rather than re-implementing the wire codec or
   armoring — the shell runs Node, the module is runtime-neutral.
3. Wire the two invoke methods and the log redaction in `electron/main.js`.
4. Write `test/ssh-keys.test.js`: generate a temp `~/.ssh` with `ssh-keygen` (`ed25519`
   unencrypted, `ed25519` with passphrase, `rsa`), plus a hand-written `config` with an `Include`
   and a `Host github.com` block.

### Acceptance criteria

- With a config containing `Host github.com` / `IdentityFile ~/.ssh/work_ed25519`, that key is
  first in `listCandidates` with `source:'ssh-config'`.
- With no config, `id_ed25519` precedes `id_rsa`; `id_rsa` has `signable:false` and a reason naming
  ed25519.
- The passphrase-protected key reports `encrypted:true`, `signable:false` when no agent is
  configured, and its `fingerprint` and `keyType` are still correct (public half is parsed).
- `signBytes` on the unencrypted ed25519 key yields an armored signature that `ssh-keygen -Y verify
  -n zbterm-identity` accepts (test shells out).
- `listCandidates` on a directory containing a truncated/garbage `id_ed25519` returns a candidate
  with `signable:false` and does not throw.
- `.pub`-only entries (public key present, private key missing) are listed as agent-signable only.
- No test writes outside its temp dir and none reads the developer's real `~/.ssh`.

### Verification

```
node_modules/.bin/brittle-node test/ssh-keys.test.js
npm test
npm run lint
```
Plus a manual smoke, pasted into the CHANGELOG:
```
node -e "require('./electron/ssh-keys').listCandidates({}).then(r=>console.log(JSON.stringify(r.map(k=>({p:k.path,t:k.keyType,s:k.signable,r:k.reason})),null,2)))"
```
Pass = brittle `# ok`, lint 0, and the smoke prints the developer's real candidates with no key
material in the output.

### Top gotchas

- `ssh-keygen -Y verify` needs an allowed-signers file (`<principal> <keytype> <base64>`) and
  `-I <principal>`; without `-n zbterm-identity` it verifies against the wrong namespace and fails
  confusingly.
- The private section of an OpenSSH key is padded with `1,2,3,…`; check1/check2 mismatch means
  "encrypted or corrupt", not "wrong format".
- `SSH_AUTH_SOCK` may point at a dead socket (agent killed) — `ECONNREFUSED`/`ENOENT` must degrade
  to "no agent", not fail discovery.
- Agent frames can be split across TCP reads; accumulate until `4 + length` bytes are present.
- `ssh-keygen -t rsa` on modern OpenSSH still writes the `openssh-key-v1` container, so type
  detection must come from the inner keytype string, not the PEM header.
- Electron main is Node, but this module is also imported by tests directly — do not `require`
  anything from `electron` in `ssh-keys.js`.

### Re-planning signals

- If agent-held keys turn out to cover the common case better than file parsing (e.g. every test
  machine uses an agent), note it — Phase 4's wizard should then default to agent keys and the
  file parser can stay a fallback.
- If `Include` handling in real user configs proves recursive/complex, cap it and record the cap;
  Phase 4's UI must then offer a manual "browse for key file" entry.
- If a real user's GitHub keys are predominantly RSA, flag it: an RSA verify path (Phase 5) becomes
  a required follow-up phase rather than out of scope.

### Handoff notes

### Phase 2 — Shell SSH provider (done 2026-08-18)
- Decisions: `listCandidates`/`signBytes` take an extra optional `env` (default `process.env`) purely so tests can hide the developer's real agent — the shell always calls with defaults. Default-glob enumeration also lists an `id_*.pub` whose private half is missing, keyed by the *private* path (`path` points at the absent file, `signable:false` until an agent holds it). Non-file candidates use `path: null`, `source:'agent'`. `identity.sshCandidates` ignores any renderer-supplied home and always uses `os.homedir()`.
- Gotchas: prettier/lunte require braces on multi-line `for-of` (curly error) and flag `async` test fns with no `await`; the OpenSSH private section is parsed by reading ssh strings until only the 1,2,3,… pad remains, so the *last* string is the comment for every key type (rsa and ed25519 alike); `ssh-keygen -Y verify` needs `-f <allowed_signers> -I <principal> -n zbterm-identity` with the message on **stdin**; `Include` is capped at exactly one level (`INCLUDE_DEPTH = 1`).
- Files: electron/ssh-keys.js, test/ssh-keys.test.js (added); electron/main.js (modified).
- Contracts: `electron/ssh-keys.js` exports {listCandidates({home,env}), signBytes({messageBase64,keyPath,publicKeyBlobBase64,env}), identityFilesForHost({home,host,configPath}), parseOpenSshPrivateKey(text), parsePublicKeyLine(text), agentIdentities({env}), agentSign({publicKeyBlob,data,env})}. Shell invokes `identity.sshCandidates` (no args) and `identity.sshSign({messageBase64,keyPath,publicKeyBlobBase64})`, both handled before the engineReady gate, errors as `{error:{name,code:'E_AUTH',message,details:null}}`; `identity.ssh*` args are logged as `'[redacted]'`.

### Verification output (all commands, exit 0)

```
$ node_modules/.bin/brittle-node test/ssh-keys.test.js
# an agent-held encrypted key becomes signable and signs via the agent
    ok 1 - Key has comment 'id_ed25519@test'
    ok 2 - the agent covers the passphrase-protected file
    ok 3 - should be equal
    ok 4 - should be equal
    ok 5 - expected truthy value
ok 11 - an agent-held encrypted key becomes signable and signs via the agent # time = 157.048004ms

# parseOpenSshPrivateKey reports encryption without decrypting
    ok 1 - should be equal
    ok 2 - should be equal
    ok 3 - should be equal
ok 12 - parseOpenSshPrivateKey reports encryption without decrypting # time = 148.157033ms

# listCandidates never reads the real home when one is supplied
    ok 1 - should be equal
ok 13 - listCandidates never reads the real home when one is supplied # time = 0.399009ms

1..13
# tests = 13/13 pass
# asserts = 54/54 pass
# time = 874.101657ms

# ok

$ npm test
1..159
# tests = 159/159 pass
# asserts = 805/805 pass
# time = 19759.431892ms

# ok

$ npm run lint
/zp/zdata/zeev/github/zbterm/forge.config.js:165:15  WARNING (require-await)  Anonymous function has no 'await' expression.
80 warnings
(0 errors; all 80 warnings pre-existing, none from electron/ssh-keys.js or test/ssh-keys.test.js)

$ node -e "require('./electron/ssh-keys').listCandidates({}).then(r=>console.log(JSON.stringify(r.map(k=>({p:k.path,t:k.keyType,s:k.signable,r:k.reason})),null,2)))"
[
  {
    "p": "/home/zeev/.ssh/id_rsa",
    "t": "ssh-rsa",
    "s": false,
    "r": "ZBTerm can only sign with ssh-ed25519 keys (this key is ssh-rsa)"
  },
  {
    "p": "/home/zeev/.ssh/id_rsa_BAK",
    "t": "ssh-rsa",
    "s": false,
    "r": "ZBTerm can only sign with ssh-ed25519 keys (this key is ssh-rsa)"
  },
  {
    "p": "/home/zeev/.ssh/id_rsa_string_crypto",
    "t": "ssh-rsa",
    "s": false,
    "r": "ZBTerm can only sign with ssh-ed25519 keys (this key is ssh-rsa)"
  }
]
```

Re-planning signals:
- **Signal 3 (RSA-predominant) — FIRED.** Every key in the developer's real `~/.ssh` is `ssh-rsa`; the key their config dedicates to this project (`~/.ssh/zbterm-github`) is also `ssh-rsa`. No ed25519 key exists on this machine, so the wizard would have zero signable candidates here. → new **Phase 8: RSA SSH key support** added to the plan.
- **Signal 2 (Include complexity) — partially fired.** The real config has 86 `Host` blocks and no `Include`s, so the one-level cap was never stressed; but GitHub is bound through an alias (`Host zbterm-github.com` / `HostName github.com` / `IdentityFile ~/.ssh/zbterm-github`). The frozen "first `Host` pattern matching `github.com` wins" rule correctly does not pick that block, which makes the user's actual GitHub key invisible to discovery. → Phase 4's manual "browse for a key file" entry promoted from optional to **required**.
- **Signal 1 (agent covers the common case) — did not fire.** `SSH_AUTH_SOCK` is set but `ssh-add -l` reports no identities; file parsing stays the primary path.

---
## Phase 3: GitHub key resolver — shell fetch, worker bridge, cache

### Goal

The worker can ask, mid-handshake, "does GitHub user `octocat` publish this ed25519 key?" and get an
answer without owning an HTTP client. A shell module fetches `https://github.com/<user>.keys`; a
worker-side resolver pushes requests over the existing event channel, awaits a reply invoke, and
caches results (positive and negative) in the profile's account dir. A no-shell fallback (tests,
headless) is injectable.

### Requirements & inputs

Read before editing: `engine/rpc/schema.js:112` (`LOW_RATE_EVENTS`), `workers/engine.js` (event
subscription loop), `electron/engine-lifecycle.js:35-40` (`onEngineEvent`), `electron/main.js:285`
(the `onEngineEvent` handler), `electron/update-channel.js` (house style for `https` requests,
timeouts, redirects), `engine/identity/store.js` + `engine/identity/claim.js` (Phase 1), the Phase 1
and Phase 2 handoff blocks.

Create: `electron/github-keys.js`, `engine/identity/resolver.js`, `test/github-keys.test.js`,
`test/identity-resolver.test.js`. Modify: `engine/index.js`, `engine/rpc/schema.js`,
`electron/main.js`, `engine/identity/store.js`.

Contracts to honor:

- `electron/github-keys.js` exports `fetchKeys(username, {baseUrl = process.env
  .ZBTERM_GITHUB_KEYS_BASE || 'https://github.com', timeoutMs = 8000})` →
  `Promise<{status:'ok'|'not-found', keys:[{keyType, blobBase64, fingerprint}]}>`. Non-2xx other
  than 404 rejects. Follows at most 2 redirects. Ignores lines that are not
  `ssh-ed25519`/`ssh-rsa`/`ecdsa-*` (keeps all types in the result; the *caller* filters to
  ed25519). Response body cap 64 KiB.
- Worker side, `engine/identity/resolver.js`: `IdentityResolver({store, emit, timeoutMs = 10000,
  fetchImpl = null})` with `resolve(provider, subject)` →
  `Promise<{status, keys, fetchedAt, source:'cache'|'remote'}>` and `handleResponse({requestId, ok,
  result, error})`. When `fetchImpl` is set (tests) it is used directly; otherwise it emits
  `identity:resolve-request` `{requestId, provider, subject}` and waits. Concurrent `resolve` calls
  for the same `(provider, subject)` share one in-flight promise.
- Cache in `identity/provider-cache/<provider>/<subject>.json`:
  `{version:2, provider, subject, status, keys, fetchedAt}`. Positive TTL **6 h**, negative
  (`not-found`) TTL **10 min**, both overridable via constructor for tests. A stale entry is served
  only if a live resolve fails, and then flagged `source:'cache-stale'`.
- New engine invoke method `identity.resolveResult({requestId, ok, result, error})` → `true`, plus
  `identity.lookup({provider, subject})` (renderer-facing, used by Phase 4 to preselect a key).
- New event name `'identity:resolve-request'` appended to `LOW_RATE_EVENTS`.
- `electron/main.js` `onEngineEvent`: on `identity:resolve-request`, call `fetchKeys`, then
  `lifecycle.engine.invoke('identity.resolveResult', {...})`. Never throws into the event handler;
  a failure sends `{ok:false, error:{message}}`. This is fire-and-forget — do not await it in the
  event dispatch path.

### Steps to perform

1. Write `electron/github-keys.js` (plain `https.get`, explicit `timeoutMs`, abort on cap).
2. Write `engine/identity/resolver.js` (pending map keyed by `requestId` from
   `crypto.randomBytes(16).toString('hex')`, timers cleared on settle, dedupe map keyed by
   `provider + '/' + subject`).
3. Instantiate it in `SessionEngine` (`this.identityResolver = new IdentityResolver({store:
   this.identityStore, emit: (name, data) => this.emit(name, data)})` — the store lives on
   `engine.identityStore`, see the Phase 1 handoff), add the two invoke methods, and
   clear pending requests in `close()`.
4. Append the event name in `engine/rpc/schema.js`; wire the shell handler in `electron/main.js`.
5. Tests: `test/github-keys.test.js` against a local `http.createServer` with
   `baseUrl: 'http://127.0.0.1:<port>'`; `test/identity-resolver.test.js` with a stub emit + manual
   `handleResponse`, covering cache hit, TTL expiry, negative cache, timeout, dedupe, stale-serve.

### Acceptance criteria

- A 200 body of three keys (one ed25519, one rsa, one comment-suffixed line) parses to three entries
  with fingerprints matching `ssh-keygen -lf` for each.
- A 404 yields `{status:'not-found', keys:[]}` and is cached; a second `resolve` within 10 min emits
  **no** new `identity:resolve-request` event.
- Two concurrent `resolve('github','octocat')` calls produce exactly one emitted request.
- A request with no response inside `timeoutMs` rejects with `EngineError` code `E_NET` and the
  pending entry is removed (assert the internal map is empty).
- After a successful resolve, a resolver constructed fresh over the same directory serves from cache
  with `source:'cache'` and emits nothing.
- `identity.lookup` returns fingerprints only — no raw key blobs larger than the cache record.

### Verification

```
node_modules/.bin/brittle-node test/github-keys.test.js
node_modules/.bin/brittle-node test/identity-resolver.test.js
npm test
npm run lint
```
Plus one real-network smoke (skip offline, paste output into the CHANGELOG):
```
node -e "require('./electron/github-keys').fetchKeys('torvalds').then(r=>console.log(r.status, r.keys.length))"
```
Pass = brittle `# ok` on both new files, lint 0, smoke prints `ok <n>` with n ≥ 0.

### Top gotchas

- `identity:resolve-request` must be added to `LOW_RATE_EVENTS` **and** the payload must be
  JSON-serializable — the event body is encoded with `c.json`; Buffers silently degrade.
- Requests emitted before the shell finished wiring `onEngineEvent` are lost forever; the resolver's
  timeout is the only recovery, so keep it ≤ 10 s and make the failure message actionable.
- `github.com/<user>.keys` returns 200 with an **empty body** for a user with no keys — that is
  `status:'ok'` with `keys: []`, not `not-found`, and it must still refuse verification later.
- GitHub redirects `/<User>.keys` for renamed accounts; follow redirects but re-validate the final
  path still ends in `.keys`.
- In tests, `emit` from the resolver runs synchronously inside `resolve()` — resolve the pending
  entry on a `queueMicrotask`, or the first `handleResponse` can land before the pending map entry
  exists.

### Re-planning signals

- If GitHub rate-limits `.keys` in practice, add an "identity verification is degraded" status and
  note that Phase 5 must not refuse connections on resolver failure (it currently must not — keep
  it that way).
- If the fire-and-forget shell handler proves racy against worker restarts (EngineLifecycle
  respawn), record it; Phase 5 may need to re-issue verification after `engine:restarting`.

---
### Handoff notes

### Phase 3 — GitHub key resolver (done 2026-08-18)
- Decisions: the cache is owned by `IdentityStore` (`readProviderCache(provider, subject)` / `writeProviderCache(provider, subject, {status, keys, fetchedAt})`), not by the resolver, so subject strings go through `getProvider().validateSubject()` plus a `^[a-z0-9][a-z0-9._-]{0,63}$` filename guard before they can become a path; `requestId` is `randomHex(16)` from `identity/claim.js`, not `crypto.randomBytes`, to stay Bare-safe; `resolve()` rejects synchronously for an unknown provider/invalid subject, and its answer keeps `blobBase64` while `identity.lookup` strips it to `{keyType, fingerprint}`.
- Gotchas: the timeout timer must NOT be `unref`'d (an unref'd timer never fires in an otherwise idle process, turning "no answer" into a hang — `SessionEngine.close()` calls `identityResolver.close()` instead); the `identity:resolve-request` emit happens *after* the async cache read, so a test cannot count microtasks to catch it (poll the event array); a 200 with an empty body is `{status:'ok', keys:[]}`, never `not-found`.
- Files: electron/github-keys.js, engine/identity/resolver.js, test/github-keys.test.js, test/identity-resolver.test.js (added); engine/index.js, engine/rpc/schema.js, engine/identity/store.js, electron/main.js (modified).
- Contracts: `fetchKeys(username, {baseUrl, timeoutMs})`→`{status:'ok'|'not-found', keys:[{keyType, blobBase64, fingerprint}]}`; `IdentityResolver({store, emit, timeoutMs=10000, fetchImpl=null, positiveTtlMs=6h, negativeTtlMs=10min, now})` with `resolve(provider, subject)`→`{status, keys, fetchedAt, source:'cache'|'cache-stale'|'remote'}`, `handleResponse({requestId, ok, result, error})`, `close()`; engine instance is `engine.identityResolver`; invokes `identity.lookup({provider, subject})`→`{provider, subject, status, fetchedAt, source, keys:[{keyType, fingerprint}]}` and `identity.resolveResult({requestId, ok, result, error})`→`true`; event `'identity:resolve-request'` `{requestId, provider, subject}` (in LOW_RATE_EVENTS); cache file `account/identity/provider-cache/<provider>/<subject>.json` = `{version:2, provider, subject, status, keys, fetchedAt}`. Neither Phase 3 re-planning signal fired.

### Verification output (all five commands, exit 0)

```
$ node_modules/.bin/brittle-node test/github-keys.test.js
TAP version 13

# a 200 body parses every key type and matches ssh-keygen fingerprints
    ok 1 - requests <user>.keys
    ok 2 - should be equal
    ok 3 - all three key types are kept - the caller filters to ed25519
    ok 4 - should be equal
    ok 5 - should be equal
    ok 6 - should be equal
    ok 7 - should be equal
    ok 8 - should be equal
    ok 9 - should be equal
    ok 10 - blob excludes the comment
ok 1 - a 200 body parses every key type and matches ssh-keygen fingerprints # time = 70.728241ms

# 404 is not-found, not an error
    ok 1 - should deep equal
ok 2 - 404 is not-found, not an error # time = 2.74075ms

# a 200 with an empty body is ok with no keys
    ok 1 - should be equal
    ok 2 - a user with no published keys is ok, not not-found
ok 3 - a 200 with an empty body is ok with no keys # time = 1.440554ms

# a non-2xx other than 404 rejects
    ok 1 - should reject
ok 4 - a non-2xx other than 404 rejects # time = 6.558739ms

# follows a redirect for a renamed account
    ok 1 - should be equal
    ok 2 - should be equal
ok 5 - follows a redirect for a renamed account # time = 1.887648ms

# rejects a redirect that leaves the .keys path
    ok 1 - should reject
ok 6 - rejects a redirect that leaves the .keys path # time = 0.985802ms

# rejects more than two redirects
    ok 1 - should reject
    ok 2 - the original request plus exactly two follows
ok 7 - rejects more than two redirects # time = 1.865414ms

# aborts a body over the 64 KiB cap
    ok 1 - should reject
ok 8 - aborts a body over the 64 KiB cap # time = 1.496731ms

# times out on a stalled response
    ok 1 - should reject
ok 9 - times out on a stalled response # time = 156.134146ms

# ignores lines that are not recognisable key lines
    ok 1 - only the ecdsa line survives
    ok 2 - should be equal
    ok 3 - expected truthy value
ok 10 - ignores lines that are not recognisable key lines # time = 0.978792ms

1..10
# tests = 10/10 pass
# asserts = 24/24 pass
# time = 271.135766ms

# ok

$ node_modules/.bin/brittle-node test/identity-resolver.test.js
TAP version 13

# a remote answer is cached, and a fresh resolver serves it without emitting
    ok 1 - should be equal
    ok 2 - should be equal
    ok 3 - should deep equal
    ok 4 - one request emitted
    ok 5 - should be equal
    ok 6 - should be equal
    ok 7 - the subject is normalised by the provider
    ok 8 - should be equal
    ok 9 - should be equal
    ok 10 - should be equal
    ok 11 - should be equal
    ok 12 - should be equal
    ok 13 - should deep equal
    ok 14 - should be equal
    ok 15 - should be equal
    ok 16 - should deep equal
    ok 17 - a fresh resolver over the same dir emits nothing
ok 1 - a remote answer is cached, and a fresh resolver serves it without emitting # time = 5.40578ms

# a positive entry past its TTL is re-fetched
    ok 1 - should be equal
    ok 2 - should be equal
    ok 3 - the stale positive entry triggered a second request
ok 2 - a positive entry past its TTL is re-fetched # time = 44.016745ms

# a not-found answer is negatively cached for its own TTL
    ok 1 - should be equal
    ok 2 - should be equal
    ok 3 - should be equal
    ok 4 - should be equal
    ok 5 - should be equal
    ok 6 - no second request inside the negative TTL
ok 3 - a not-found answer is negatively cached for its own TTL # time = 1.107507ms

# a negative entry past its 10 min equivalent is re-fetched
    ok 1 - should be equal
ok 4 - a negative entry past its 10 min equivalent is re-fetched # time = 45.152145ms

# concurrent resolves for the same subject share one request
    ok 1 - the same promise is handed to both callers
    ok 2 - exactly one request emitted for two concurrent resolves
    ok 3 - should deep equal
    ok 4 - should deep equal
    ok 5 - should be equal
ok 5 - concurrent resolves for the same subject share one request # time = 6.52137ms

# a request with no answer rejects with E_NET and leaves no pending entry
    ok 1 - should reject
    ok 2 - the pending map is empty after the timeout
    ok 3 - should be equal
    ok 4 - should be equal
    ok 5 - should be equal
ok 6 - a request with no answer rejects with E_NET and leaves no pending entry # time = 126.555565ms

# a shell error rejects with the shell message
    ok 1 - should reject
ok 7 - a shell error rejects with the shell message # time = 0.939793ms

# a stale entry is served when the live lookup fails
    ok 1 - should be equal
    ok 2 - should be equal
    ok 3 - should deep equal
    ok 4 - it did try the network first
ok 8 - a stale entry is served when the live lookup fails # time = 40.912838ms

# fetchImpl bypasses the shell seam entirely
    ok 1 - should be equal
    ok 2 - should be equal
    ok 3 - should be equal
    ok 4 - should deep equal
    ok 5 - no event emitted when fetchImpl is injected
ok 9 - fetchImpl bypasses the shell seam entirely # time = 1.137983ms

# a malformed shell answer is rejected rather than cached
    ok 1 - should reject
    ok 2 - should be equal
ok 10 - a malformed shell answer is rejected rather than cached # time = 2.06045ms

# close rejects everything still pending
    ok 1 - should be equal
    ok 2 - should reject
    ok 3 - should be equal
ok 11 - close rejects everything still pending # time = 7.22088ms

# an unknown provider or an invalid subject is refused before any request
    ok 1 - should throw
    ok 2 - should throw
    ok 3 - should be equal
ok 12 - an unknown provider or an invalid subject is refused before any request # time = 0.637576ms

1..12
# tests = 12/12 pass
# asserts = 55/55 pass
# time = 299.717566ms

# ok

$ npm test
ok 181 - zbterm update runs `npm install -g zbterm@latest` # time = 33.366415ms

1..181
# tests = 181/181 pass
# asserts = 884/884 pass
# time = 20578.973224ms

# ok

$ npm run lint
> zbterm@1.0.44 lint
> prettier --check package.json forge.config.js electron engine renderer test workers && lunte electron engine renderer test workers forge.config.js
Checking formatting...
All matched files use Prettier code style!
80 warnings
(80 lunte warnings, all pre-existing `require-await` notices; prettier clean, exit 0)

$ node -e "require('./electron/github-keys').fetchKeys('torvalds').then(r=>console.log(r.status, r.keys.length))"
ok 1
```

Re-planning signals: neither fired. The single real-network fetch was served normally (no rate
limiting, HTTP 200), and the fire-and-forget shell handler was not observed racing a worker
restart — the resolver already tolerates a lost request via its 10 s timeout, and a failed
resolve is reported to the caller rather than turned into a refusal.

---

## Phase 4: Startup identity wizard

### Goal

On startup, once a profile is selected and the engine is ready, a user with no configured identity
gets a modal offering exactly two paths: keep `<12hex>@UNKNOWN`, or enter a GitHub username and pick
one of their local SSH keys (auto-preselected when it matches a key published on the account). On
submit, the claim is minted (`identity.beginClaim`), signed (`identity.sshSign`) and installed
(`identity.setSelf`), and the window title/status reflect the new display id. The same wizard is
drivable headlessly through the shell popup registry so e2e can complete it without a mouse.

### Requirements & inputs

Read before editing: `renderer/app.js` — `showModal` (`:3247`), `showJoinWizard` (`:3060`),
`wirePearRuntimeEvents` (`:344`), `ensureProfileSelected` (`:351`), event wiring (`:1080-1099`),
`__zbtermDebugCommand` (`:4731`), `debugModalState` (`:4691`); `renderer/index.html` styles near
`.share-warning` (`:1081`) and `.spinner` (`:1126`); `electron/main.js` popup helpers
(`:369-433`), `handlePopupAction` (`:1008`), `onProfileSelected` (`:302`); `electron/debug-server.js`
popup routes (`:117`, `:131`) and `rendererHealth` (`:327`); Phase 1–3 handoff blocks.

Modify: `renderer/app.js`, `renderer/index.html`, `electron/main.js`, `test/renderer-static.test.js`.

Contracts to honor:

- Shell popup: `setIdentityPopup(self)` registers `{id:'identity-setup', type:'identity-setup',
  title:'Choose your identity', data:{displayId, providers:[{id,label}], candidates:[]},
  actions:['choose-unknown','fill-username','select-key','add-key','submit','dismiss']}`. Registered from
  `onProfileSelected` when `identity.self.configured` is false, cleared on success or `dismiss`.
  `handlePopupAction` implements the same sequence the renderer does, calling
  `listCandidates`/`signBytes` from `electron/ssh-keys.js` and the three worker methods.
- Renderer: `showIdentityWizard()` built with the existing `.modal-overlay`/`.modal-panel` classes,
  registered in `state.popupResolvers` under popup id `identity-setup` so a headless action closes
  the on-screen modal too (same mechanism `showModal`'s `options.popupId` uses).
- Wizard flow: radio-style choice → `UNKNOWN` (immediate close, calls `identity.clear()`) or
  `GitHub` → username input (validated with the Phase 1 regex, inline error) → key list populated
  from `identity.sshCandidates`; after the username field loses focus, call
  `identity.lookup({provider:'github', subject})` and mark each candidate `on GitHub` /
  `not on GitHub`; preselect the first candidate that is both `signable` and on GitHub; disable
  Submit until a signable key is selected.
- Submit sequence, exactly: `identity.beginClaim` → `identity.sshSign({messageBase64: bytes,
  keyPath, publicKeyBlobBase64})` → `identity.setSelf({claim, signature})`. On `setSelf` failure show
  the error text in the modal and keep it open.
- "Don't ask again for this profile" checkbox → `preference.set {key:'identity.setupDismissed',
  value:'1'}`; the wizard is skipped on later startups while that is `'1'` and no claim exists.
  Entering the wizard from the gear/settings menu ignores that preference.
- New renderer debug commands in `__zbtermDebugCommand`: `identity-open`, `identity-choose`
  (`{provider}`), `identity-username` (`{value}`), `identity-select-key` (`{fingerprint}`),
  `identity-submit`, returning `debugModalState()` extended with `{identity:{provider, username,
  selectedFingerprint, candidates:[{fingerprint, keyType, signable, onProvider}]}}`.
- **Manual key-file entry (required — added after the Phase 2 signal fired).** Below the discovered
  candidate list, a text input labelled "Or enter the path to a private key file" plus an `add-key`
  action. On submit it calls the new shell method `identity.sshInspect({keyPath})` (add it to
  `electron/ssh-keys.js` as a thin wrapper that parses exactly one path and returns the same
  candidate shape as `listCandidates`, with `source:'manual'`), appends the result to the candidate
  list, and marks it on/not-on GitHub the same way. This is needed because discovery follows OpenSSH
  semantics and therefore misses keys bound to GitHub through an alias `Host` block (real example on
  the dev machine: `Host zbterm-github.com` / `HostName github.com` /
  `IdentityFile ~/.ssh/zbterm-github`). A non-existent or unparseable path shows an inline error
  and adds nothing. Corresponding debug command: `identity-add-key` (`{keyPath}`).
- Nothing in this phase blocks engine startup, terminal creation, or session restore. The wizard is
  dismissible with Escape at any time (equivalent to `dismiss`).

### Steps to perform

1. Renderer: wizard builder, validation, candidate list rendering, submit sequence, `identity:changed`
   subscription updating the header/status line, debug commands.
2. Styles in `renderer/index.html`: `.identity-option`, `.identity-key-row`,
   `.identity-key-row.selected`, `.identity-hint`, `.identity-error` — reuse existing color
   variables; no new fonts, no external assets.
3. Shell: `setIdentityPopup` / `clearIdentityPopup`, registration in `onProfileSelected`,
   `handlePopupAction` branch for `identity-setup`.
4. Startup gate in `renderer/app.js` after profile selection completes.
5. Extend `test/renderer-static.test.js` with assertions that the wizard markup/classes and the six
   debug commands exist in `renderer/app.js` (static string checks, matching the file's existing
   style).

### Acceptance criteria

- Fresh profile, no claim: `GET /popups` on the debug server lists `identity-setup` with the six
  actions.
- Driving `POST /popups/identity-setup/actions/fill-username {name:'octocat'}` then
  `.../select-key {fingerprint}` then `.../submit` results in `GET /identity` reporting
  `displayId:'octocat@github'`, and the on-screen modal is gone.
- `POST /popups/identity-setup/actions/choose-unknown` leaves `displayId` as `<12hex>@UNKNOWN` and
  clears the popup.
- Invalid username (`-bad-`) is rejected client-side with a visible error and no engine call
  (assert via `/events` that no `identity:changed` fired).
- With `identity.setupDismissed = '1'` and no claim, no popup is registered at startup, but opening
  the wizard from the settings menu still works.
- A key that is `signable:false` cannot be selected (Submit stays disabled).
- Manual entry: `POST /popups/identity-setup/actions/add-key {keyPath:'<temp ed25519 key>'}` appends
  a candidate with `source:'manual'` that can then be selected and submitted; a bogus path returns an
  inline error and leaves the candidate list unchanged.
- `npm run lint` passes, including prettier formatting of the two large renderer files.

### Verification

```
node_modules/.bin/brittle-node test/renderer-static.test.js
npm test
npm run lint
```
Then a live drive (start the app with the debug server, port printed in its stdout):
```
npm start -- --debug-server --debug-server-port=7801
curl -s localhost:7801/popups | head -40
curl -s -X POST localhost:7801/popups/identity-setup/actions/fill-username -d '{"name":"octocat"}'
curl -s -X POST localhost:7801/popups/identity-setup/actions/submit -d '{}'
curl -s localhost:7801/identity
```
Pass = the popup appears in `/popups`, the submit sequence returns 200s, `/identity` shows
`"displayId":"octocat@github"`, and the app window shows the modal closing.

### Top gotchas

- `renderer/app.js` is ~172 k and has no module system — add the wizard next to `showJoinWizard` and
  keep every helper inside the same IIFE scope; a stray top-level `const` breaks the whole file.
- `.modal-overlay` is matched by `document.querySelector('.modal-overlay')` in `debugModalState` —
  only one modal may be open at a time, so the wizard must not race the profile picker; gate it on
  the profile picker being hidden.
- `zbterm.invoke` rejects with `E_PROFILE_REQUIRED` until the engine is ready; `identity.ssh*` is
  shell-handled and works earlier, which makes it easy to build a wizard that half-works before the
  engine exists — gate the whole wizard on engine-ready.
- Popup actions and the on-screen modal must converge: register the resolver in
  `state.popupResolvers` or the headless path will leave a stuck modal on screen (this is exactly
  what `share-approval` does — copy it).
- `rendererHealth` in `electron/debug-server.js` treats a pending `profile-picker` specially; make
  sure an `identity-setup` popup does not make `/health` report `ok:false` and break the e2e.

### Re-planning signals

- If the candidate list is commonly empty (no `~/.ssh` keys), add a "paste a public key" or
  "generate a key for me" path and record it — Phase 7's e2e fixture assumptions change.
- If `identity.lookup` latency makes the wizard feel stuck, note it: the preselect step may need to
  move behind a "Check GitHub" button.

### Handoff notes

### Phase 4 — Startup identity wizard (done 2026-08-18)
- Decisions: no gear/settings menu exists in this app, so the "open the wizard anyway" entry point is a new `#identitySetup` icon button in the sidebar brand actions; the shell clears `identity-setup` on the `identity:changed` engine event; `identity:changed` is now recorded by the debug server so `/events` can prove a rejected username never reached the engine; popup `data` carries the live wizard state (`provider`, `username`, `fingerprints`, `candidates`, `selectedFingerprint`).
- Gotchas: `showIdentityWizard()` resolves only when the modal CLOSES, so `openIdentityWizard()` must fire it and return immediately or the `identity-open` debug command hangs forever; `maybeShowIdentityWizard()` is called un-awaited after `startupPhase='ready'` so the wizard never gates startup or `/health`; `debugModalState()` still returns the FIRST `.modal-overlay`, so on a fresh profile the auto-opened wizard shadows the share/join modals in `npm run test:debug-server` — Phase 7 must dismiss it or seed `identity.setupDismissed='1'` per e2e profile.
- Files: electron/ssh-keys.js, electron/main.js, renderer/app.js, renderer/index.html, test/renderer-static.test.js
- Contracts: shell method `identity.sshInspect({keyPath})`→ one `listCandidates`-shaped candidate with `source:'manual'` (E_AUTH on missing/unparseable path); `sshKeys.inspectKey({keyPath,home,env})`; popup actions with bodies `fill-username {name}`, `select-key {fingerprint}`, `add-key {keyPath}`, `submit {}`; preference key `identity.setupDismissed` (`'1'` = skip at startup); renderer debug commands `identity-open`, `identity-choose {provider}`, `identity-username {value}`, `identity-select-key {fingerprint}`, `identity-add-key {keyPath}`, `identity-submit`, all returning `debugModalState()` + `identity:{provider,username,selectedFingerprint,candidates:[{fingerprint,keyType,signable,onProvider}]}`; candidates gain an `onProvider` boolean; `document.title` now appends the identity `displayId`.

### Verification output (all commands, exit 0)

```
$ node_modules/.bin/brittle-node test/renderer-static.test.js
# identity wizard markup and styles exist
    ok 1 - app.js builds the identity wizard
    ok 2 - wizard reuses the modal overlay class
    ok 3 - wizard reuses the modal panel class
    ok 4 - wizard renders identity options
    ok 5 - wizard renders key rows
    ok 6 - wizard renders hints
    ok 7 - wizard renders inline errors
    ok 8 - wizard registers a popup resolver so headless actions close it
    ok 9 - wizard offers manual key entry
    ok 10 - manual entry inspects the key path
    ok 11 - index.html styles .identity-option
    ok 12 - index.html styles the selected key row
    ok 13 - index.html styles .identity-hint
    ok 14 - index.html styles .identity-error
ok 4 - identity wizard markup and styles exist # time = 1.015587ms

# renderer exposes the identity debug commands
    ok 1 - __zbtermDebugCommand handles identity-open
    ok 2 - __zbtermDebugCommand handles identity-choose
    ok 3 - __zbtermDebugCommand handles identity-username
    ok 4 - __zbtermDebugCommand handles identity-select-key
    ok 5 - __zbtermDebugCommand handles identity-add-key
    ok 6 - __zbtermDebugCommand handles identity-submit
ok 6 - renderer exposes the identity debug commands # time = 0.841034ms

1..6
# tests = 6/6 pass
# asserts = 26/26 pass
# time = 8.691836ms

# ok

$ npm test
1..184
# tests = 184/184 pass
# asserts = 905/905 pass
# time = 20166.71373ms

# ok

$ npm run lint
Checking formatting...
All matched files use Prettier code style!
80 warnings   (all pre-existing require-await, none in touched files)
```

Live drive — real Electron app on a temp `--storage` / `--electron-user-data` / `HOME`, with
`ZBTERM_GITHUB_KEYS_BASE=http://127.0.0.1:7802` serving `/octocat.keys` from a freshly generated
temp ed25519 key. Display `:1` available, no `xvfb-run` needed.

```
$ curl -s localhost:7801/popups | head -40
[{"createdAt":1787008815318,"id":"identity-setup","type":"identity-setup","title":"Choose your identity","data":{"displayId":"70baeec65a43@UNKNOWN","providers":[{"id":"unknown","label":"Unverified"},{"id":"github","label":"GitHub"}],"candidates":[]},"actions":["choose-unknown","fill-username","select-key","add-key","submit","dismiss"],"updatedAt":1787008815426,"renderer":{"visible":true,"visibleAt":1787008815426}}]

$ curl -s -X POST localhost:7801/popups/identity-setup/actions/fill-username -d '{"name":"octocat"}'
{"popupId":"identity-setup","action":"fill-username","username":"octocat","candidates":[{"path":".../home/.ssh/id_ed25519","source":"default","keyType":"ssh-ed25519","fingerprint":"SHA256:BDGKHWSpqBkZU/VHwyNiwEq5/z3sMnBsZTDrdHdg9BY","comment":"octocat@example","publicKeyBlobBase64":"AAAAC3NzaC1lZDI1NTE5AAAAIEx5nSM/hbGzEKns6bzR5J/xe57Vgf+515i2rhfVYraM","encrypted":false,"signable":true,"reason":null,"onProvider":true}],"selectedFingerprint":"SHA256:BDGKHWSpqBkZU/VHwyNiwEq5/z3sMnBsZTDrdHdg9BY"}

$ curl -s -X POST localhost:7801/popups/identity-setup/actions/select-key -d '{"fingerprint":"SHA256:BDGKHWSpqBkZU/VHwyNiwEq5/z3sMnBsZTDrdHdg9BY"}'
{"popupId":"identity-setup","action":"select-key","selectedFingerprint":"SHA256:BDGKHWSpqBkZU/VHwyNiwEq5/z3sMnBsZTDrdHdg9BY"}
HTTP 200

$ curl -s -X POST localhost:7801/popups/identity-setup/actions/submit -d '{}'
{"popupId":"identity-setup","action":"submit","identity":{"configured":true,"provider":"github","subject":"octocat","displayId":"octocat@github","identityKey":"70baeec65a43c93fe8160bcf086d1d2e1bed908010e6f879832ced0d5ac19d94","authKey":"5c59cf8d311639ff7267704f5f87af186781ef28bb3fdba1f2e36a219f6ad3dd","sshFingerprint":"SHA256:BDGKHWSpqBkZU/VHwyNiwEq5/z3sMnBsZTDrdHdg9BY","issuedAt":1787008845010}}
HTTP 200

$ curl -s localhost:7801/identity
{"deviceKey":"c2d09a3d2cb3f71582f90655c6196baacee42fdf5778158fead5285160994e00","dhtKey":"0e059fa6df506de797c8ff50d09b95733d045ce84287f34e399db7049bbb7f85","identityKey":"70baeec65a43c93fe8160bcf086d1d2e1bed908010e6f879832ced0d5ac19d94","deviceName":"zeev","deviceStatus":"active","provider":"github","displayId":"octocat@github"}

$ curl -s localhost:7801/popups ; curl -s -X POST localhost:7801/renderer/command -d '{"command":"modal-state"}'
[]null
```

Remaining acceptance criteria, also driven live:
- invalid username → `HTTP 400 {"message":"Invalid github username: -bad-"}`, `/events` = `[]` (after a successful submit `/events` = `['identity:changed']`).
- `choose-unknown` → `HTTP 200`, `/identity` → `"displayId":"6dfe39b41a3d@UNKNOWN"`, `/popups` → `[]`, modal `null`.
- `signable:false` key → `POST select-key` on an RSA fingerprint returns `HTTP 400 "ZBTerm can only sign with ssh-ed25519 keys (this key is ssh-rsa)"`; the row renders `disabled` and Submit stays disabled.
- manual entry (against the dev machine's real `~/.ssh`, zero signable auto-discovered candidates): `add-key` with the temp ed25519 path appended `{"source":"manual","signable":true,"onProvider":true}`, then selected and submitted to `octocat@github`; `add-key /nope/does-not-exist` → `HTTP 400 "Key file is missing or unreadable"`, candidate list unchanged at 3.
- `identity.setupDismissed='1'` with no claim → `/popups` `[]`, modal `null`, but `identity-open` still returns `"title":"Choose your identity"`.
- `/health` stayed `ok:true`, `renderer.ok:true`, `phase:"ready"` both with the popup pending and the modal on screen.

Re-planning signals:
- **"candidate list commonly empty" — fired in spirit, already mitigated.** On this machine `listCandidates` returns 3 entries but **zero signable** (all `ssh-rsa`). The manual key-file path this phase already mandated was necessary and sufficient; no "paste a public key" / "generate a key for me" path was needed. → Phase 7's fixture note added to the plan: the e2e must generate its own ed25519 key, not rely on the dev machine's `~/.ssh`.
- **`identity.lookup` latency — did not fire.** `fill-username` returned well inside a 20 s budget; no "Check GitHub" button needed. Measured against `http://127.0.0.1:7802`, not real github.com.

---

## Phase 5: Handshake — claim exchange, live challenge, refusal

### Goal

Host and viewer exchange identity claims during the existing join handshake and each proves, on the
live socket, that it holds the auth key named in its claim. A presented claim that fails any check
(bad SSH signature, key not published by the named GitHub user, bad challenge signature, timeout)
**refuses the connection**: the host denies the peer, the viewer aborts the join. A peer that
presents no claim connects as `unknown`. Verification state for each peer is persisted and emitted
so the UI can render it.

### Requirements & inputs

Read before editing: `engine/share-manager.js` — `join` (`:423`), `_handleViewerConnection`
(`:1178`, the `join-request` send at the end), `_handleViewerCtlMessage` (`:1281`), `_openHostChannel`
(`:752`, ctl `onmessage`), `_confirmJoin` (`:844`), `_grantJoin` (`:907`), `_denyPeer` (`:1055`),
`status` (`:594`); `engine/crypto.js` `verifyDeviceIdentity`; `engine/caps.js`; Phase 1's
`claimBytes`/`challengeBytes`/`verifySshSignature`/`signChallenge`/`verifyChallenge`; Phase 3's
resolver; the Phase 1–3 handoff blocks; `test/share-manager.test.js` (harness style: a fake
`runtime` object and a Protomux pair — copy it, do not invent a new harness).

Create: `engine/identity/verify.js`, `test/identity-handshake.test.js`.
Modify: `engine/share-manager.js`, `engine/index.js`, `engine/rpc/schema.js`.

Contracts to honor:

- **Wire additions** (all optional fields on existing JSON ctl messages — old peers omit them):
  - viewer → host `join-request` gains `identityClaim` (the self record incl. `signature`, or
    `null`) and `authKey` (hex).
  - host → viewer `confirm` gains `hostIdentityClaim` and `hostAuthKey`.
  - new bidirectional messages: `{type:'identity-challenge', challengeId, nonce, sessionId, role}`
    and `{type:'identity-response', challengeId, signature}` (hex ed25519 over Phase 1's
    `challengeBytes`). The DHT keys in the signed bytes are **not** transmitted — each side fills in
    its own view (`verifierDhtKey` = local DHT key of the verifier, `proverDhtKey` =
    `socket.remotePublicKey` from the verifier's side; mirrored by the prover). A mismatch therefore
    fails the signature check, which is the anti-relay property.
- **Order (host side)**, inside `_confirmJoin` after the existing link/proof/revocation checks and
  **before** `approval:pending` is emitted or `_grantJoin` is called: if `request.identityClaim` is
  null → peer status `unknown`, continue. Otherwise → status `pending`, emit
  `share:peer-identity`, run `verifyPeerIdentity`, and on failure
  `_denyPeer(peer, CODES.E_AUTH, 'Identity verification failed')` + `share:peer-identity` with
  `status:'failed'` and a `reason`, and return.
- **Order (viewer side)**: on `confirm`, if `hostIdentityClaim` is present, verify it before
  registering the remote session; on failure `state.finish({status:'failed', code: CODES.E_AUTH,
  message:'Host identity verification failed'})` and `state.socket.destroy()`. If absent → unknown,
  continue.
- `engine/identity/verify.js` exports `verifyPeerIdentity({claim, authKey, identityKey, deviceKey,
  identityProof, challenge, signature, resolver, store})` →
  `{status:'verified'|'unknown'|'failed', displayId, provider, subject, sshFingerprint, reason}`.
  Checks, in order: claim shape/provider known → `claim.identityKey === identityKey` and
  `claim.authKey === authKey` → SSHSIG verifies over `claimBytes(claim)` with the claim's own
  `sshPublicKey` → `resolver.resolve(provider, subject)` returns a key list containing that key's
  fingerprint → `verifyChallenge(authKey, challenge, signature)`. Any failure returns
  `status:'failed'` with a one-line human `reason`; a **resolver error/timeout** returns
  `status:'failed'` with `reason:'could not reach github.com'` — but the caller treats
  `reason`-class `resolver-unreachable` as **non-refusing**, downgrading to `unknown`. Encode that
  by returning `status:'unknown', reason:'resolver-unreachable'` from `verify.js` itself.
- Challenge timeout `IDENTITY_TIMEOUT_MS = 15000`; a timeout with a presented claim is a refusal.
- Persist every outcome via `IdentityStore.putPeer` (status, displayId, `lastVerifiedAt`,
  `failureReason`), preserving `localName`/`localComment`.
- New event `'share:peer-identity'` (append to `LOW_RATE_EVENTS`), payload `{sessionId, direction:
  'viewer'|'host', identityKey, deviceKey, displayId, provider, status, reason}`.
- `ShareManager.status(sessionId)` gains `viewers: [{identityKey, deviceKey, displayId, status}]`
  for confirmed peers, so `session.list` rows can render badges without a second call.
- Unchanged: caps, epochs, rekey, approval policy, link semantics, `PROTOCOL`, existing deny paths.

### Steps to perform

1. `engine/identity/verify.js` per the contract, pure and injectable (no ShareManager import).
2. Host side: challenge issue/await helper on the peer object (`peer.identityPending = {challengeId,
   challenge, resolve, timer}`), handling for `identity-challenge`/`identity-response` in the ctl
   `onmessage` switch, and the gate in `_confirmJoin`. Note the host is both verifier (of the
   viewer) and prover (for the viewer's challenge).
3. Viewer side: the mirror — respond to `identity-challenge`, issue one after `confirm`, gate remote
   registration on the result.
4. Fill claim/auth fields into `join-request` and `confirm` from `engine.identityStore.getSelf()`
   (the store instance name — see the Phase 1 handoff) / `engine.localDevice.authPublicKey`.
5. Emit + persist outcomes; extend `status()`.
6. `test/identity-handshake.test.js` using the existing Protomux-pair harness with a stub resolver.

### Acceptance criteria

- Happy path: both sides present valid claims; both reach `status:'verified'`; join completes; two
  `share:peer-identity` events with `status` transitioning `pending` → `verified`.
- No-claim path: viewer sends `identityClaim:null`; join completes; host records the peer as
  `unknown`; **no** `identity-challenge` is sent.
- Tampered claim (subject changed after signing): host denies with `E_AUTH`, the viewer's join
  settles `failed`, and no member record and no epoch rotation happened (assert `putMember` was
  never called on the fake runtime).
- Key not published by the claimed user (stub resolver returns a different fingerprint): refused,
  `reason` mentions the provider.
- Replay: a challenge response captured from one socket is replayed on a second socket with a
  different `proverDhtKey` → verification fails.
- Silent prover (never answers the challenge) with a claim present → refused after
  `IDENTITY_TIMEOUT_MS`; test uses an injected short timeout, not a 15 s sleep.
- Resolver timeout → connection **allowed** as `unknown`, not refused.
- `npm test` shows `test/share-manager.test.js` and `test/share-manager-network.test.js` still fully
  passing (no handshake regressions).

### Verification

```
node_modules/.bin/brittle-node test/identity-handshake.test.js
node_modules/.bin/brittle-node test/share-manager.test.js
node_modules/.bin/brittle-node test/share-manager-network.test.js
npm test
npm run lint
```
Pass = all four brittle runs `# ok`, lint 0.

### Top gotchas

- Protomux dispatches `onmessage` without awaiting the previous handler; the viewer already chains
  through `state.messageQueue` (`engine/share-manager.js:1256-1264`) — the new async verification
  **must** stay inside that chain or a `data` frame will be processed before the identity gate.
- The host's ctl `onmessage` has no such queue; do not `await` verification in a way that lets a
  second `join-request` on the same peer start a second challenge — guard with `peer.identityState`.
- `_denyPeer` closes the channel; sending `share:peer-identity` after it will silently drop — emit
  first, deny second.
- `socket.remotePublicKey` is the **DHT** key, not the device key; the viewer's own DHT key is
  `this.engine.localDevice.dhtPublicKey`. Getting these backwards produces a signature that verifies
  locally in unit tests and fails on the wire.
- The pre-existing group-link warning text in `renderer/app.js:1787` ("until we add user
  authentication…") becomes wrong for verified peers — leave it for Phase 6, do not touch it here.
- Adding fields to `join-request` must not break `test/share-manager.test.js`'s hand-built messages;
  update those fixtures rather than making the new fields required.

### Re-planning signals

- If the challenge round trip measurably delays join completion (> ~300 ms on a LAN), note it — the
  UI in Phase 6 may need to show live output while verification is still pending, rather than after.
- If `approval:pending` UX gets confusing because verification finishes after approval, record the
  observed ordering; Phase 6 may need to block the approval dialog until identity settles.
- If old-build interop turns out to break anyway (unexpected strict JSON handling on the peer),
  flag it before Phase 7 — the e2e must then run same-version only.

### Handoff notes

### Phase 5 — Handshake (done 2026-08-18)
- Decisions: `join-request` is sent from synchronous code, so the local claim is read from a new engine cache `engine.selfIdentityClaim` (refreshed in ready()/setIdentitySelf/clearIdentity), never `await getSelf()`; the viewer has no independent host identityKey (confirm carries only hostIdentityClaim/hostAuthKey), so it verifies against `claim.identityKey` and binds trust via `hostAuthKey` + the challenge; a failed/unknown peer is persisted with `provider:'unknown', subject:null` so its `displayId` never renders as `alice@github` (the claimed provider/subject survive only in the emitted event and in `failureReason`); the identity gate runs before `approval:pending`, so an approval dialog always sees a settled identity.
- Gotchas: `identity-challenge`/`identity-response` must BYPASS the viewer's `state.messageQueue` — the `confirm` handler runs inside that chain and blocks on the response, so queueing it deadlocks (bypass is in the `addMessage.onmessage` wrapper; everything else still chains). Host `join-request` is guarded by `peer.identityState` set synchronously in the ctl switch. A missing challenge answer is checked in verify.js *before* the resolver, otherwise a resolver hiccup would downgrade a silent prover to `unknown` instead of refusing.
- Files: engine/identity/verify.js, test/identity-handshake.test.js (added); engine/share-manager.js, engine/index.js, engine/rpc/schema.js (modified).
- Contracts: `engine/identity/verify.js` exports `{verifyPeerIdentity({claim,authKey,identityKey,deviceKey,identityProof,challenge,signature,resolver,store}) -> {status,displayId,provider,subject,sshFingerprint,reason}, IDENTITY_TIMEOUT_MS=15000, RESOLVER_UNREACHABLE='resolver-unreachable'}` (it also persists the outcome itself via `store.putPeer`). Wire: `join-request` += `identityClaim|null`, `authKey|null`; `confirm` += `hostIdentityClaim|null`, `hostAuthKey|null`; new `{type:'identity-challenge',challengeId,nonce,sessionId,role:'viewer'|'host'}` and `{type:'identity-response',challengeId,signature}` (hex). Event `'share:peer-identity'` `{sessionId,direction:'viewer'|'host',identityKey,deviceKey,displayId,provider,status,reason}`. `ShareManager.status(sessionId).viewers = [{identityKey,deviceKey,displayId,status}]`. `ShareManager#identityTimeoutMs` (settable, or via `engine.identityTimeoutMs`); peer/state fields `identityPending`, `identityState`, `identityStatus`, `identityDisplayId`; helpers `_selfIdentityClaim()`, `_localAuthKeyHex()`, `_issueIdentityChallenge`, `_answerIdentityChallenge`, `_verifyViewerIdentity`, `_verifyHostIdentity`; new debug events `host:identity:result`, `viewer:identity:result`, `host:join-request:duplicate`, deny reason `identity`.

### Verification output (all five commands, exit 0)

```
$ node_modules/.bin/brittle-node test/identity-handshake.test.js
# viewer treats a host that presents no claim as unknown and joins anyway
    ok 1 - should be equal
    ok 2 - should deep equal
    ok 3 - no challenge is issued to a host that presented no claim
ok 10 - viewer treats a host that presents no claim as unknown and joins anyway # time = 9.910131ms

1..10
# tests = 10/10 pass
# asserts = 64/64 pass
# time = 300.941764ms

# ok

$ node_modules/.bin/brittle-node test/share-manager.test.js
ok 20 - _disconnectHostPeer closes only the channel and never falls back to socket destroy # time = 0.605805ms

1..20
# tests = 20/20 pass
# asserts = 89/89 pass
# time = 242.194473ms

# ok

$ node_modules/.bin/brittle-node test/share-manager-network.test.js
ok 2 - a single viewer identity can join two sessions hosted by the same host over one shared swarm

1..2
# tests = 2/2 pass
# asserts = 6/6 pass
# time = 16108.468856ms

# ok

$ npm test
ok 194 - zbterm update runs `npm install -g zbterm@latest` # time = 71.437592ms

1..194
# tests = 194/194 pass
# asserts = 969/969 pass
# time = 20114.9611ms

# ok

$ npm run lint
Checking formatting...
All matched files use Prettier code style!
/zp/zdata/zeev/github/zbterm/forge.config.js:165:15  WARNING (require-await)  Anonymous function has no 'await' expression.
94 warnings
lint exit=0
```

Re-planning signals:
- **Signal 1 (round-trip delay) — partially fired.** The challenge round trip is cheap: **3 ms in-process** (`# in-process identity round trip + verification: 3ms`); on a LAN it is one extra RTT each way, well under 300 ms. It could not be measured on a real LAN (no networked identity e2e until Phase 7). The real latency risk is the **resolver**: on a cold provider cache the host blocks the join on a `github.com/<user>.keys` fetch through the shell seam (up to 10 s) before `confirm` is sent. → note added to Phase 6.
- **Signal 2 (approval UX) — did not fire.** The gate sits before `approval:pending` by construction, so verification always settles before the approval dialog is raised.
- **Signal 3 (old-build interop) — not fired, but unverified empirically.** All new fields are optional and neither side sends a challenge unless the peer presented a claim (two tests assert this), so an old peer degrades to `unknown` both ways. Not tested against an actually older build. → note added to Phase 7.

---

## Phase 6: UI — identity badges and peer annotations

### Goal

Every place a remote party appears — the session list row for a shared/joined session, the join
approval dialog, and the join progress status — shows that party's display id with a state icon: an
animated spinner while verification is in flight, a green check when verified, a red question mark
for `@UNKNOWN`, and a red cross plus the refusal reason when a connection was refused. The verifier
can attach a local name and comment to any peer, which is shown in parentheses after the display id
everywhere.

### Requirements & inputs

Read before editing: `renderer/app.js` — `renderSessions` (`:1147`), `handleApprovalRequest`
(`:1778`), `handleJoinStatus` (around `:2783`), event wiring (`:1080-1099`), `showModal` (`:3247`),
`__zbtermDebugLayout` (`:4775`); `renderer/index.html` — `.share-warning` (`:1081`), `.spinner`
(`:1126`), FontAwesome usage (`:1445+`); Phase 5's `share:peer-identity` payload and
`ShareManager.status().viewers`; Phase 1's `identity.peers` / `identity.annotatePeer`; the Phase 4–5
handoff blocks.

Modify: `renderer/app.js`, `renderer/index.html`, `test/renderer-static.test.js`.

Contracts to honor:

- Badge markup: `<span class="identity-badge identity-<status>" title="<reason or fingerprint>">`
  containing `<i class="fa-solid fa-circle-question">` (unknown, red), `<div class="spinner">`
  (pending; reuse the existing `.spinner` rule), `<i class="fa-solid fa-circle-check">` (verified,
  green), `<i class="fa-solid fa-circle-xmark">` (failed, red) followed by the display id text.
- Display text: `displayId` (+ ` (localName)` when set). Hover title shows the SSH fingerprint for
  verified peers, the failure reason for failed ones.
- The approval dialog (`handleApprovalRequest`) shows the badge above the buttons and **replaces**
  the group-link warning text at `renderer/app.js:1787` with: the existing warning only when the
  requester's status is `unknown`; for `verified`, show `Verified as <displayId>` instead.
- Annotation UI: a pencil affordance next to any peer badge opens `showModal` with two inputs
  (name, comment) and calls `identity.annotatePeer`. Available for `verified`, `unknown` and
  `failed` peers. Local-only; never sent on the wire.
- Refusal feedback: when a join fails with the Phase 5 identity reason, the join status line reads
  `Refused: <reason>` and stays until dismissed.
- State updates come from `share:peer-identity` events plus `session.list` rows; no polling.
- New debug commands: `identity-peers` (returns the rendered badge state per session:
  `[{sessionId, displayId, status, localName}]`) and `identity-annotate`
  (`{identityKey, name, comment}`). Extend `__zbtermDebugLayout` with `identityBadges`.

### Steps to perform

1. Add `renderIdentityBadge(peer)` and a `state.peerIdentity` map keyed by `identityKey`, fed by
   `share:peer-identity` and by `session.list` rows.
2. Hook it into `renderSessions` rows (host: one badge per confirmed viewer, collapsed to
   `N viewers` with a tooltip listing them when > 2; viewer: the host's badge).
3. Update `handleApprovalRequest` and the join status path.
4. Annotation modal + invoke calls.
5. Styles in `renderer/index.html` (`.identity-badge`, per-status colors, spinner sizing inside a
   badge). Respect the existing dark/light handling — no hard-coded `#fff`.
6. Extend `test/renderer-static.test.js` with string assertions for the badge classes, the four
   status modifiers, the removal of the unconditional group-link warning, and the two new debug
   commands.

### Acceptance criteria

- A session shared to a verified peer renders exactly one `.identity-badge.identity-verified` with
  the peer's `user@github` text.
- A joined session whose host is unknown renders `.identity-badge.identity-unknown` with the
  `fa-circle-question` icon and `<12hex>@UNKNOWN`.
- While Phase 5 verification is pending, the badge contains a `.spinner` element and no icon.
- After `identity.annotatePeer({name:'Alice'})`, the badge text is `alice@github (Alice)` without a
  reload (the annotate call refreshes state).
- The approval dialog for a `verified` requester does **not** contain the string
  "YOU CANT TELL WHO IS REALLY JOINING"; for an `unknown` requester it still does.
- A refused join leaves a visible `Refused:` status line naming the reason.
- `npm run lint` passes (prettier reformats these two files aggressively — run `npm run format`).

### Verification

```
node_modules/.bin/brittle-node test/renderer-static.test.js
npm test
npm run lint
```
Then live, with two app instances on the debug server (see Phase 7 for the two-app recipe) or one
app plus a hand-seeded peer record:
```
curl -s -X POST localhost:7801/renderer/command -d '{"command":"identity-peers"}'
curl -s -X POST localhost:7801/renderer/command -d '{"command":"identity-annotate","identityKey":"<hex>","name":"Alice"}'
curl -s -X POST localhost:7801/renderer/command -d '{"command":"identity-peers"}'
```
Pass = the first call reports the badge status matching the peer's actual verification state, and
the third shows `localName:"Alice"`.

### Top gotchas

- `renderSessions` runs on every list refresh (several times a second during activity) — build
  badges from a memoized map, do not call `identity.peers` inside the render loop.
- FontAwesome is vendored under `renderer/vendor` and loaded by relative path; `test/renderer-static
  .test.js` asserts no `../node_modules` references — do not add one.
- The session list row already has a context menu bound to `.session-row`; a click on the pencil must
  `stopPropagation` or it selects/opens the session.
- Status can arrive **before** the session row exists (join in flight); key the map by
  `identityKey`, not by row.
- **Added after Phase 5 shipped:** the challenge itself is fast (3 ms in-process, one LAN RTT), but on
  a **cold provider cache** the host blocks the join on a `github.com/<user>.keys` fetch through the
  shell seam for up to the resolver's 10 s timeout before `confirm` is sent. So a first-ever join to a
  given username can sit visibly in `pending`. The join status path must show the spinner badge and a
  reassuring line during that window rather than looking hung, and must not treat the delay as a
  failure.

### Re-planning signals

- If badge state proves ambiguous for group links with many viewers, note the collapse rule you
  actually shipped — Phase 7's assertions depend on the exact rendered text.
- If designers want the identity chip in the title bar too, record it as a follow-up rather than
  widening this phase.

### Handoff notes

### Phase 6 — UI badges and peer annotations (done 2026-08-18)
- Decisions: badges live in a `<span class="session-identity">` appended to `.session-main`; the pencil is rendered on session-row badges only, NOT in the approval dialog (avoids stacking a second `.modal-overlay` over the approval popup, which `debugModalState()` would then return); the verified line in the approval dialog is a non-danger `.share-warning.modal-warning.identity-note` while the group-link warning keeps `share-warning-danger`; a refused join is sticky — `setStatus()` is a no-op while `state.identityRefusal` is set, and clicking `#status` dismisses it.
- Gotchas: a peer that presents no claim emits `identityKey:null` (the host half is built from the claim), so `applyPeerIdentity` falls back to `event.deviceKey` and derives `<12hex>@UNKNOWN` itself — without that a joined session with an unknown host rendered no badge at all; `session.list` only carries `viewers` for hosted rows, so the viewer's host badge can come only from the event; peer records are read from `identity.peers` exactly once (init), never in the render loop.
- Files: renderer/app.js, renderer/index.html, test/renderer-static.test.js
- Contracts: debug commands `identity-peers` / `identity-annotate {identityKey,name,comment}` both return `[{sessionId, identityKey, direction:'viewer'|'host'|null, displayId, status, localName, text}]` (rendered row badges first, then known-but-not-rendered peers with `sessionId:null`); `__zbtermDebugLayout().identityBadges` is that same array; CSS `.identity-badge`, `.identity-badge-text`, `.identity-verified|pending|unknown|failed`, `.identity-collapsed`, `.identity-annotate`, `.session-identity`, `.modal-identity`, `.identity-note`, `.status-refused`; badge datasets `status/displayId/identityKey/localName/direction`; `showModal` gained `fields[]` (resolves to an array of trimmed values, `null` on cancel), `badge` (DOM node) and `note` options.

### Collapse rule shipped (Phase 7 assertions depend on this)

- `viewers.length <= 2` → one `<span class="identity-badge identity-<status>">` per viewer, in
  `share.status().viewers` order.
- `viewers.length > 2` → exactly one chip:
  `<span class="identity-badge identity-collapsed identity-<worst>" title="<display text of each viewer, one per line>">`,
  containing the worst-status mark (`.spinner` if worst is `pending`, else the `fa-circle-*` icon) and
  text **`N viewers`** — e.g. `3 viewers` — with no pencil. Worst-status precedence:
  `failed` > `pending` > `unknown` > `verified`.
- In `identity-peers` output the collapsed chip appears as
  `{sessionId, identityKey:null, direction:"viewer", displayId:"", status:"<worst>", localName:null, text:"3 viewers"}`.
- Individual badge text is `displayId` or `displayId (localName)`; verified peers' `title` is the SSH
  fingerprint, failed peers' `title` is the failure reason (local comment appended on a second line
  when set).

### Verification output (all commands, exit 0)

```
$ node_modules/.bin/brittle-node test/renderer-static.test.js
ok 10 - peer annotations are local and a refused join stays on the status line # time = 0.510873ms

1..10
# tests = 10/10 pass
# asserts = 62/62 pass
# time = 11.943768ms

# ok

$ npm test
ok 198 - zbterm update runs `npm install -g zbterm@latest` # time = 30.508463ms

1..198
# tests = 198/198 pass
# asserts = 1005/1005 pass
# time = 20158.876967ms

# ok

$ npm run lint
All matched files use Prettier code style!
94 warnings     (all pre-existing require-await; none in the touched files)
```

Live check — one app on a temp `--profile-path` with a hand-seeded verified peer record
(`account/identity/peers/<hex>.json`, `alice@github`), debug server on 7801, display `:1`:

```
+ curl -s -X POST localhost:7801/renderer/command -d '{"command":"identity-peers"}'
[{"sessionId":null,"identityKey":"7d6afdd1…","direction":null,"displayId":"alice@github","status":"verified","localName":null,"text":"alice@github"}]
+ curl -s -X POST localhost:7801/renderer/command -d '{"command":"identity-annotate","identityKey":"7d6afdd1…","name":"Alice"}'
[{"sessionId":null,…,"localName":"Alice","text":"alice@github (Alice)"}]
+ curl -s -X POST localhost:7801/renderer/command -d '{"command":"identity-peers"}'
[{"sessionId":null,…,"localName":"Alice","text":"alice@github (Alice)"}]
```

Bonus two-app live drive (host + fresh viewer, real share + join, both identities UNKNOWN):

```
== A (host) ==
[{"sessionId":"e59ba4f0…","identityKey":"7718943b949dfa77…","direction":"viewer","displayId":"7718943b949d@UNKNOWN","status":"unknown","localName":null,"text":"7718943b949d@UNKNOWN"}, …]
== B (viewer) ==
[{"sessionId":"e59ba4f0…","identityKey":"387956cd47da29ad…","direction":"host","displayId":"387956cd47da@UNKNOWN","status":"unknown","localName":null,"text":"387956cd47da@UNKNOWN"}]
after identity-annotate name=Bob:
[{"sessionId":"e59ba4f0…","direction":"viewer",…,"localName":"Bob","text":"7718943b949d@UNKNOWN (Bob)"}, …]
```

Finding handed to Phase 7 (not caused by this phase): `npm run test:debug-server` fails at
`launch host` with `Timed out waiting for host debug server`, because
`test/debug-server-e2e.js:1152` (`api()`) throws on any popup not in `allowPopupTypes` and Phase 4's
`identity-setup` popup is open at startup, so every `/health` poll throws. A manual `/health` on the
same storage/profile returns `ok:true`.

Re-planning signals: neither fired (no badge ambiguity found, no title-bar chip request).

---

## Phase 7: End-to-end scenario and architecture documentation

### Goal

`npm run test:debug-server` covers identity end to end with two real app instances: a host with a
GitHub identity backed by a fixture SSH key and a stubbed keys endpoint, a viewer that joins and
sees `user@github` verified, and a negative run where a tampered claim causes the join to be
refused. `docs/ARCHITECTURE.md` documents the identity layer so it is discoverable without this
plan.

### Requirements & inputs

Read before editing: `test/debug-server-e2e.js` — argument flags (`:8-40`), `api()`/
`rendererCommand()` helpers (`:1107`), the existing share→join scenario (`:1031-1106`),
app spawn/cleanup helpers; `electron/github-keys.js` (`ZBTERM_GITHUB_KEYS_BASE`);
`electron/debug-server.js` routes; `docs/ARCHITECTURE.md` sections 1.1 (Core Principles) and the
identity/authorization section; all prior handoff blocks.

Modify: `test/debug-server-e2e.js`, `docs/ARCHITECTURE.md`. Create: `test/fixtures/identity/README.md`
plus generated-at-runtime key material (do **not** commit private keys — generate with `ssh-keygen`
into the e2e temp root at test time).

Contracts to honor:

- A tiny `http.createServer` inside the e2e serves `/<user>.keys`; both app instances are spawned
  with `ZBTERM_GITHUB_KEYS_BASE=http://127.0.0.1:<port>`.
- The host instance's identity is installed through the **popup API** (`POST
  /popups/identity-setup/actions/...`), not by writing files — that is what proves Phase 4 works
  headlessly.
- New flag `--identity-only` runs just the identity scenario; the default full run includes it.
- The scenario asserts through the REST API, never by scraping logs: `/identity`,
  `/renderer/command {command:'identity-peers'}`, `/events` for `share:peer-identity`.
- `docs/ARCHITECTURE.md` gains a numbered subsection covering: the two-layer proof, why SSH access
  and HTTPS live in the shell, the claim and challenge canonical formats, the refusal rule, and the
  provider-registry extension point. Keep the document's existing voice (prose, no bullet dumps) and
  update the block diagram's worker box to include the identity store.

### Steps to perform

1. Fixture setup helper in the e2e: temp `~/.ssh`-like dir with an unencrypted ed25519 key, an
   `HOME` override for the host app instance, and the keys endpoint serving that public key for
   user `zbterm-e2e`.
2. Positive scenario: host completes the wizard headlessly → creates a session → mints a group link
   → viewer joins → assert viewer sees the host as `zbterm-e2e@github` verified and host sees the
   viewer as `@UNKNOWN`.
3. Negative scenario: restart the keys endpoint serving a *different* public key → new join attempt
   → assert the join settles `failed`, that `share:peer-identity` reported `status:'failed'`, and
   that no session row appeared on the viewer.
4. Annotation check: viewer annotates the host, asserts the name renders.
5. Architecture doc update.

### Acceptance criteria

- `npm run test:debug-server` completes with exit code 0 including the identity scenario, on a
  machine with a display (or under `xvfb-run`).
- `node test/debug-server-e2e.js --identity-only` completes in under 3 minutes.
- The negative scenario fails the join within `IDENTITY_TIMEOUT_MS + 5 s` and leaves both apps
  healthy (`GET /health` → `ok:true` on both afterwards).
- No private key material is committed; `git status` is clean of key files after a run.
- `docs/ARCHITECTURE.md` mentions `identity/self.json`, `zbterm-identity-claim/v1`,
  `zbterm-identity-challenge/v1`, the refusal rule, and the provider registry.

### Verification

```
node test/debug-server-e2e.js --identity-only
npm run test:debug-server
npm test
npm run lint
git status --porcelain
```
Pass = both e2e commands exit 0 (paste their final summary lines into the CHANGELOG), `npm test`
and lint clean, `git status --porcelain` shows only the intended source/doc changes.

### Top gotchas

- The e2e spawns real Electron apps; `HOME` must be overridden **per instance** or the host's
  fixture SSH dir leaks into the viewer's candidate list.
- `test/debug-server-e2e.js` cleans up on SIGINT/SIGTERM (`:47-56`); any new server or temp dir must
  register in the same `cleanup()` path or a failed run leaves a port bound and the next run flakes.
- App instances pick free ports dynamically unless `ZBTERM_E2E_*_PORT` is set — read the assigned
  port the way the existing scenario does; do not hard-code.
- Verification runs against a *cached* resolver result; the negative scenario must use a **different
  username** (or clear the cache dir) or it will hit the 6 h positive cache and pass wrongly.
- `rendererHealth` fails `/health` while a modal is open — close the identity wizard before asserting
  health. (Phase 4 measured `/health` staying `ok:true` with the identity popup pending and the modal
  on screen, so this is about *other* modals, not the wizard.)
- **The e2e is currently RED before you start — fixing it is part of this phase.** Phase 6 ran
  `npm run test:debug-server` and it fails at `launch host` with
  `Timed out waiting for host debug server`. Cause: `test/debug-server-e2e.js:1152` (`api()`) throws on
  any popup not in `allowPopupTypes`, and Phase 4's `identity-setup` popup is open at startup, so every
  `/health` poll throws. A manual `/health` against the same storage/profile returns `ok:true`, so the
  app is fine — the harness is not. Allow `identity-setup` in `allowPopupTypes`, and/or seed
  `identity.setupDismissed='1'` per e2e profile. Relatedly, `debugModalState()` returns the FIRST
  `.modal-overlay`, so any scenario driving a share/join modal must dismiss the wizard first or it
  reads the wizard's state instead.
- **Added after Phase 5 shipped:** old-build interop was reasoned through but never tested against an
  actually older build. All new fields are optional and neither side sends a challenge unless the peer
  presented a claim, so an old peer should degrade to `unknown` in both directions. If the e2e needs
  certainty, check out a pre-identity build for one of the two instances; otherwise record that the
  e2e is same-version only.
- **Added after Phase 4 shipped:** the dev machine's real `~/.ssh` contains only RSA keys, i.e. zero
  signable auto-discovered candidates. The e2e must generate its own ed25519 key into the per-instance
  temp `HOME` (or feed it through `add-key`) and must not rely on discovering a usable local key.

### Re-planning signals

- If the two-app identity scenario proves flaky on CI-less machines, split it into a worker-level
  integration test (two `ShareManager`s over a real DHT, as in
  `test/share-manager-network.test.js`) and record which coverage moved where.
- If the architecture doc update reveals a design inconsistency (e.g. identity state duplicated
  between `IdentityStore` and session member records), record it as a follow-up cleanup phase rather
  than fixing it inside this phase.

### Handoff notes

### Phase 7 — E2E scenario and architecture docs (done 2026-08-18)
- Decisions: identity apps get one `--storage` root EACH (not the shared one) so a picker could only ever list their own profile; `--reset-profiles` now persists window slots BEFORE `runWorkerCrashScenario`, which tears the engine down for good.
- Gotchas: `--storage`/`--electron-user-data` do NOT move `electron/main.js` `stableUserData` (debug log, window state, preferences) — only `XDG_CONFIG_HOME` does, and only on Linux; the suite needs a real display because xterm's webgl addon requires WebGL2 that `xvfb-run` cannot supply, with or without `--disable-gpu`/SwiftShader.
- Files: test/debug-server-e2e.js, test/fixtures/identity/README.md, docs/ARCHITECTURE.md
- Contracts: flag `--identity-only`; helpers `assertProfileIsolated(port,name,profileDir)` and `assertRealUserDataUntouched(label)`; consts `appConfigRoot=<root>/config` and `realAppConfigDir`; fixture gains `storages[name]`; ARCHITECTURE §6.3 "Provider-Backed Identity", worker box gains IdentityStore, §13.3 preamble, §15 identity-e2e bullet, §A.3 identity code pointers.

### The real-profile leak this phase found and fixed

`electron/main.js:64` captures `stableUserData = app.getPath('userData')` **before** it repoints
Chromium, and keeps `debug_main.log` (`:93`), `window-state.json` (`:497`), `window-state.lock`
(`:501`) and `preferences.json` (`:528`) there for the process lifetime. Neither `--storage` nor
`--electron-user-data` moves them, so every e2e-spawned app appended to the developer's real debug log
and — under `--reset-profiles`, which tiles windows into screen quarters — **overwrote the real app's
window positions** (`~/.config/ZBTerm/window-state.json` mtime 03:24:40 on the night of the incident).

Fix: `startApp()` now sets `XDG_CONFIG_HOME=<e2e root>/config` for **every** spawned app, so
`stableUserData` is structurally inside the temp root. Two assertions run after every spawn:
- `assertRealUserDataUntouched()` snapshots `~/.config/ZBTerm` before anything spawns and re-compares.
  `main.js` writes its debug log during module evaluation, so an instance resolving to the real
  directory changes an mtime within milliseconds — a positive detector, not an inference.
- `assertProfileIsolated()` asserts the profile dir is under the e2e root, proves through the REST API
  that the engine's `/identity.deviceKey` equals the `publicKey` in `<profile>/local-device-key.json`,
  and that no `profile-picker` popup exists at all.
`SIGHUP` also joined the cleanup signal list — a cancelled harness command was exactly the case that
orphaned an app window on the developer's desktop.

Across 6 full/identity runs since the fix, `~/.config/ZBTerm` mtimes are byte-for-byte at their
pre-work baseline, the log and window state land in `<root>/config/ZBTerm/`, and `ps` shows zero
strays after every run.

### Verification output

```
$ node test/debug-server-e2e.js --identity-only     → exit 0   (21 s, 50 assertions; run 4x identically)
    Identity E2E passed.

$ npm test                                          → exit 0
# tests = 198/198 pass
# asserts = 1005/1005 pass

$ npm run lint                                      → exit 0
94 warnings   (all pre-existing require-await)

$ git status --porcelain                            → exit 0
only intended source/doc changes, no key files

$ npm run test:debug-server                         → exit 1   ← ACCEPTED AS BLOCKED, see below
E2E failed: Error: Timed out waiting for crash-test session kept appending output through the
crash and after respawn: GET /sessions/<id>/stats failed with 500: File descriptor could not be locked
    at runWorkerCrashScenario (test/debug-server-e2e.js:799:3)
```

**Known-failing acceptance criterion.** `npm run test:debug-server` does not reach exit 0. The failure
is a leaked corestore lock in the respawned worker after `SIGKILL` — the same class of bug already
documented at `engine/index.js:1288` and `:1313`. A control run with `runIdentityScenario()` skipped
failed at the identical step with the identical error, in 4/4 full runs, so the implementing agent
judged it pre-existing. **Caveat recorded for honesty:** that control did not isolate the fact that
this phase also *moved* the `runWorkerCrashScenario()` call within `main()`, so "pre-existing" is
strongly indicated but not fully proven. Everything before that step is green — the identity scenario
(50 assertions), all four window-restore checks, sharing/join, playback, and every isolation
assertion. The user reviewed this and chose to accept the phase and proceed; fixing worker crash
recovery is a product change outside this phase's scope and remains open.

Re-planning signals: neither fired. The identity scenario is not flaky (4 consecutive `--identity-only`
runs at exactly 50 assertions, ~21 s, plus clean passes inside all 4 full runs), so it was not demoted
to a worker-level integration test. The architecture-doc pass revealed no `IdentityStore`/member-record
inconsistency; the one thing worth recording is that a refused peer is deliberately persisted as
`provider:'unknown'`, with the claimed subject surviving only in the `share:peer-identity` event —
now documented in ARCHITECTURE §6.3 rather than left implicit.

---

## Phase 8: RSA SSH key support (signing and verification)

> Added 2026-08-18 because the Phase 2 re-planning signal "a real user's GitHub keys are
> predominantly RSA" fired: the dev machine's `~/.ssh` contains only `ssh-rsa` keys
> (`id_rsa`, `id_rsa_BAK`, `id_rsa_string_crypto`, and the project's own `~/.ssh/zbterm-github`),
> so the ed25519-only wizard offers zero signable candidates there. Decision 3 ("ed25519 only in v1")
> is superseded **for this phase only**; phases 3–7 shipped ed25519-only and are not revisited.

### Goal

A user whose GitHub account publishes only RSA keys can complete the identity wizard, and a peer
presenting an RSA-signed claim verifies. ECDSA and `sk-*` remain out of scope and keep their
"disabled with a reason" treatment.

### Requirements & inputs

Read before editing: `engine/identity/claim.js`, `electron/ssh-keys.js`, `engine/identity/verify.js`,
`test/identity-claim.test.js`, `test/ssh-keys.test.js`, and the Phase 1–7 handoff blocks.

Modify: `engine/identity/claim.js`, `electron/ssh-keys.js`, `test/identity-claim.test.js`,
`test/ssh-keys.test.js`, `renderer/app.js` (candidate reason text only), `docs/ARCHITECTURE.md`.

Contracts to honor:

- SSHSIG algorithm for RSA is **`rsa-sha2-512`** (never bare `ssh-rsa`/SHA-1). The armored
  container's `sigBlob` becomes `string("rsa-sha2-512") ‖ string(rawSig)`; the outer `hashAlg` stays
  `sha512` and the namespace stays `zbterm-identity`.
- The public-key blob for RSA is `string("ssh-rsa") ‖ mpint(e) ‖ mpint(n)`. The fingerprint rule is
  unchanged (`SHA256:` + base64(sha256(blob)), padding stripped) and must still match `ssh-keygen -lf`.
- `verifySshSignature` gains RSA verification. `sodium-native` has no RSA, so verification uses
  Node's `crypto.verify('sha512', …)` with a public key reconstructed from `e`/`n` via a JWK
  (`crypto.createPublicKey({key:{kty:'RSA', n:<b64url>, e:<b64url>}, format:'jwk'})`) —
  **this runs in the worker under Bare**, so confirm `crypto.createPublicKey`/`crypto.verify` are
  available there before writing the verifier. If they are not, the RSA verify path must move to the
  shell behind a new `identity.sshVerify` invoke and the resolver-style request/response bridge from
  Phase 3 is the model to copy; record which route you took in the handoff.
- Signing with an RSA **file** requires RSA private-key parsing plus PKCS#1 v1.5 signing; signing via
  **ssh-agent** requires only the existing `SIGN_REQUEST` with `flags = SSH_AGENT_RSA_SHA2_512 = 4`.
  Prefer the agent path; implement the file path with Node's `crypto.sign` over a key rebuilt from
  the parsed OpenSSH private fields (`n, e, d, iqmp, p, q`) as a JWK.
- `KEY_TYPE` in `engine/identity/claim.js` becomes a set of supported types; every place that
  compared against the literal `'ssh-ed25519'` must accept `'ssh-rsa'` too. The `reason` string for
  ECDSA/`sk-*` candidates must stop naming ed25519 exclusively.
- Interop is one-directional-safe: an old build receiving an RSA claim fails verification and
  **refuses** the connection (Phase 5's rule). Note this in the handoff and in `docs/ARCHITECTURE.md`.

### Steps to perform

1. Confirm Bare's `crypto` surface for `createPublicKey`/`verify` (a 5-line spike under
   `workers/`), and pick the in-worker or shell-bridged verify route accordingly.
2. RSA public-blob encode/decode + fingerprint in `engine/identity/claim.js`; extend
   `parseArmoredSignature`/`verifySshSignature` for `rsa-sha2-512`.
3. `electron/ssh-keys.js`: RSA private-key parsing, `signBytes` via agent (`flags = 4`) and via file;
   mark RSA candidates `signable:true` when either route is available.
4. Renderer: update the disabled-reason text so RSA is no longer listed as unsupported.
5. Tests: extend `test/identity-claim.test.js` with an RSA round trip against real
   `ssh-keygen -Y sign`/`-Y verify`, and `test/ssh-keys.test.js` with an RSA file-signing and an
   RSA agent-signing case.
6. `docs/ARCHITECTURE.md`: record that both `ssh-ed25519` and `rsa-sha2-512` claims are accepted.

### Acceptance criteria

- A claim signed by this code with an `ssh-keygen -t rsa` key verifies with real
  `ssh-keygen -Y verify -n zbterm-identity`.
- A signature produced by real `ssh-keygen -Y sign -n zbterm-identity` with an RSA key verifies with
  `verifySshSignature`.
- RSA fingerprints match `ssh-keygen -lf` byte for byte.
- The dev machine's real `~/.ssh` smoke (`listCandidates`) now reports `signable:true` for at least
  one `ssh-rsa` key, with no key material in the output.
- A bare `ssh-rsa` (SHA-1) SSHSIG is **rejected**, not accepted.
- ECDSA and `sk-*` keys are still listed with `signable:false` and an accurate reason.
- Phase 5's handshake tests still pass unchanged, plus one new case: an RSA-claim peer verifies.

### Verification

```
node_modules/.bin/brittle-node test/identity-claim.test.js
node_modules/.bin/brittle-node test/ssh-keys.test.js
node_modules/.bin/brittle-node test/identity-handshake.test.js
npm test
npm run lint
node -e "require('./electron/ssh-keys').listCandidates({}).then(r=>console.log(JSON.stringify(r.map(k=>({p:k.path,t:k.keyType,s:k.signable,r:k.reason})),null,2)))"
```
Pass = every brittle run `# ok`, lint 0, and the smoke shows a signable `ssh-rsa` candidate.

### Top gotchas

- OpenSSH writes RSA private fields in the order `n, e, d, iqmp, p, q` — **not** the PKCS#1 order,
  and `iqmp` sits between `d` and `p`. JWK wants `d, p, q, dp, dq, qi`; `dp`/`dq` must be computed
  (`d mod (p-1)`, `d mod (q-1)`) with BigInt.
- ssh mpints are signed big-endian with a leading `0x00` when the high bit is set; stripping it (or
  failing to add it) changes the fingerprint and breaks `ssh-keygen -lf` parity.
- The agent returns the algorithm name inside `sigblob`; assert it is `rsa-sha2-512` and not
  `ssh-rsa` — some agents ignore the flags byte.
- Bare's `crypto` is not Node's; step 1 exists precisely because assuming parity here is the most
  likely way to lose a day.

### Re-planning signals

- If Bare cannot verify RSA in-worker and the shell bridge is needed, note that identity verification
  now depends on the shell being alive mid-handshake — Phase 5's "resolver unreachable ⇒ unknown,
  not refused" rule must be extended to "verifier unreachable ⇒ unknown", or headless worker-only
  tests will refuse every RSA peer.
- If RSA file signing proves fragile, ship agent-only RSA signing and record it: the wizard must then
  tell the user to `ssh-add` the key, and Phase 4's manual key-file entry needs that hint text.

### Handoff notes

### Phase 8 — RSA SSH key support (done 2026-08-18)
- Decisions: `KEY_TYPE` stays the string `'ssh-ed25519'` (engine/index.js:1188 uses it as the default `sshKeyType` and is outside this phase's file list); the new frozen `KEY_TYPES` `['ssh-ed25519','ssh-rsa']` is the set every type check consults. **RSA verification is in-worker pure-JS BigInt PKCS#1 v1.5 in claim.js** — no `identity.sshVerify` bridge exists, verification still needs nothing but the worker.
- Gotchas: Bare's crypto has zero RSA (no `createPublicKey`; `subtle` does ed25519/hmac/pbkdf2/sha only). ssh-agent sign requests now set `flags=4` and the reply's algorithm is asserted to be `rsa-sha2-512`, never `'ssh-rsa'`. OpenSSH's private field order `n,e,d,iqmp,p,q` is mapped to JWK with `dp`/`dq` computed as `d mod (p-1)`/`(q-1)` and `qi=iqmp`. Node cannot read OpenSSH private containers, so the claim test generates its RSA key with `ssh-keygen -m PEM`.
- Files: engine/identity/claim.js, electron/ssh-keys.js, renderer/app.js, docs/ARCHITECTURE.md, test/identity-claim.test.js, test/ssh-keys.test.js, test/identity-handshake.test.js
- Contracts: claim.js adds exports `KEY_TYPES`, `RSA_KEY_TYPE='ssh-rsa'`, `RSA_SIG_ALG='rsa-sha2-512'`, `encodeRsaPublicKey({e,n})->blob`, `writeMpint`, `stripMpint`, `signatureAlgorithmFor(keyType)->alg|null`; `decodePublicKeyBlob` now returns `{type, publicKey, rsa:{e,n}|null}`; `buildArmoredSignature` derives sigType from the pubkey blob; `verifySshSignature` throws E_AUTH `"Unsupported SSH signature algorithm: <alg> (<keyType> must sign with <alg>)"` for a bare `ssh-rsa` SSHSIG. ssh-keys.js `parseOpenSshPrivateKey` adds `rsa:{n,e,d,iqmp,p,q}|null`; the unsignable reason is now `"ZBTerm can only sign with ssh-ed25519 or ssh-rsa keys (this key is <type>)"`.

### The RSA verify route taken — a third option, not either of the two the plan listed

Step-1 spike (`workers/spike-rsa-crypto.js`, run under `bare`, then deleted):

```
keys: Cipheriv,Decipheriv,Hash,Hmac,constants,createCipheriv,createDecipheriv,createHash,
      createHmac,generateKeyPair,pbkdf2,pbkdf2Sync,randomBytes,randomFill,randomFillSync,
      randomUUID,sign,timingSafeEqual,verify,webcrypto
createPublicKey: undefined
verify: function
verify threw: false == true
```

`bare-crypto` has **no RSA anywhere**: no `createPublicKey`/`createPrivateKey`, `sign`/`verify` assert
on a `bare-crypto` `Key` and switch only on `ED25519`, and its WebCrypto `subtle` supports only
hmac/ed25519/pbkdf2/sha. So the plan's route A (in-worker Node `crypto`) is impossible.

Route B (a shell `identity.sshVerify` bridge) was **not** taken either. `verifySshSignature` is
synchronous and is called from two worker call sites (`engine/identity/verify.js` mid-handshake and
`engine/identity/store.js` `setSelf`); bridging it would have made peer verification depend on a live
shell, forced the Phase 5 "unreachable ⇒ unknown" rule to be widened, broken the headless handshake
harness (which the acceptance criteria require to gain an RSA case), and touched
main.js/engine-lifecycle/worker RPC — all outside this phase's edit list.

Instead `engine/identity/claim.js` verifies RSASSA-PKCS1-v1_5/SHA-512 itself with BigInt modular
exponentiation: it recovers the encoded message and compares it **byte-for-byte** against a rebuilt
`00 01 FF… 00 || DigestInfo || SHA-512`, never parsing what it recovered (so low-exponent/Bleichenbacher
forgeries are inert), with `s < n`, odd `e >= 3`, exact signature length and a 1024–8192-bit modulus
bound. This works identically under Node and Bare, needs no IPC, and keeps `verifySshSignature`
synchronous. **This is hand-rolled signature verification and is worth an independent security review**;
swapping it for the bridge is a contained change in one file.

Signing is unaffected: it happens in the shell, where Node's
`crypto.sign`/`createPrivateKey({format:'jwk'})` is available as the plan described.

### Verification output (all six commands, exit 0)

```
$ node_modules/.bin/brittle-node test/identity-claim.test.js
1..12
# tests = 12/12 pass
# asserts = 62/62 pass
# time = 290.8035ms

# ok

$ node_modules/.bin/brittle-node test/ssh-keys.test.js
1..16
# tests = 16/16 pass
# asserts = 68/68 pass
# time = 1101.581427ms

# ok

$ node_modules/.bin/brittle-node test/identity-handshake.test.js
1..11
# tests = 11/11 pass
# asserts = 71/71 pass
# time = 325.603932ms

# ok

$ npm test
1..204
# tests = 204/204 pass
# asserts = 1043/1043 pass
# time = 20930.246363ms

# ok

$ npm run lint
94 warnings   (all pre-existing require-await, none in touched files)
lint exit=0

$ node -e "require('./electron/ssh-keys').listCandidates({}).then(...)"
[
  { "p": "/home/zeev/.ssh/id_rsa",               "t": "ssh-rsa", "s": true,  "r": null },
  { "p": "/home/zeev/.ssh/id_rsa_BAK",           "t": "ssh-rsa", "s": true,  "r": null },
  { "p": "/home/zeev/.ssh/id_rsa_string_crypto", "t": "ssh-rsa", "s": false,
    "r": "Key is passphrase-protected - add it to ssh-agent (ssh-add /home/zeev/.ssh/id_rsa_string_crypto) to sign with it" }
]
```

Two signable `ssh-rsa` candidates, no key material in the output.
`inspectKey({keyPath:'~/.ssh/zbterm-github'})` — the manual-entry path the wizard offers, since the
alias `Host zbterm-github.com` block does not match discovery host `github.com` — also reports
`signable:true`.

Re-planning signals: neither fired.
- Signal 1 ("Bare cannot verify RSA in-worker **and the shell bridge is needed**"): the first half is
  true and proven by the spike, but the bridge turned out not to be needed, so Phase 5's "resolver
  unreachable ⇒ unknown" rule is untouched and no new mid-handshake shell dependency exists. Evidence:
  `test/identity-handshake.test.js` gained an RSA-claim peer case that verifies with the existing
  worker-only harness (no shell, no stub verifier) — 11/11 pass.
- Signal 2 ("RSA file signing proves fragile ⇒ ship agent-only"): did not fire. File signing works and
  its output is accepted by real `ssh-keygen -Y verify`
  (`Good "zbterm-identity" signature … with RSA key SHA256:WJxU…`), which matters because `ssh-add -l`
  still reports no identities on this machine. Both routes are implemented; the agent route is
  exercised by two new tests, including one asserting a flags-ignoring agent's `ssh-rsa` reply is
  refused.

---
