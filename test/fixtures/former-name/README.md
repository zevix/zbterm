# Former-name fixtures

Fixtures for `test/former-name.test.js`, proving `Z-4` (`docs/decisions.md`
`D-23`): an invite or a signed identity claim made under the predecessor's
name is refused by ZBTerm, with a message that says why, well under the join
timeout.

Every file here is a **hex encoding** of the artefact, never the raw bytes:
`test/name.test.js` scans the whole working tree (tracked and untracked,
outside its own exempt paths) for the predecessor's name and fails on any
byte match, so the name itself must not appear in plaintext anywhere in this
directory. Decode with `Buffer.from(fs.readFileSync(file, 'utf8'), 'hex')`
(or `xxd -r -p`).

## How each fixture was made

All three were produced by a scratch script (not committed — it necessarily
spells the predecessor's name and constants in the clear) that required the
**pre-`Z3` snapshot** of this repository (the tree as it stood immediately
before the rename, `<scratch>/z3/pre-z3-tree.tgz` in the Z4 brief) and ran its
own, unmodified `engine/invite.js` and `engine/identity/claim.js`. Nothing
from the predecessor's live repository or the owner's machine was used:

- A scratch `HOME` (`<scratch>/oldhome`), never the owner's.
- A scratch `node_modules` (a symlink to this repo's, since the module
  surface the snapshot's code imports is unchanged).
- A throwaway ed25519 SSH key made with `ssh-keygen -t ed25519 -f <scratch>/k
-N ''`, used only to sign the fixture claim and discarded with the rest of
  the scratch directory afterwards.

**`pear-invite.hex`** — the predecessor's `engine/invite.js::encodeLink`
called with a synthetic but well-formed v1 Pear payload (`v`, `linkId`,
`topic`, a random 32-byte `hostDhtKey`, `claim: null`). Its scheme is the
predecessor's own link scheme, not `zbterm://`.

**`freenet-invite.hex`** — the same `encodeLink`, called with a v2 payload
(`b: 'freenet'`, `peer`, an opaque `route`). Same predecessor scheme.

**`claim.hex`** — a JSON identity claim built from the predecessor's
`claimBytes()` encoding (its own `CLAIM_MAGIC`) and signed for real with
`ssh-keygen -Y sign -f <scratch>/k -n <predecessor NAMESPACE>` over that
byte string. The resulting SSHSIG armor is namespaced under the
predecessor's SSH-signature namespace, not ZBTerm's (`zbterm-identity`).
Before being written out, the maker script re-verified the signature with
the predecessor's own `verifySshSignature()`, so the fixture is known-good
under the code that made it — the whole point is that it still fails under
ZBTerm's `engine/identity/verify.js`, which checks the namespace.

**`claim-message.hex`** — the exact raw bytes the signature above was made
over (the predecessor's `claimBytes(claim)` output, `CLAIM_MAGIC` line and
all), kept separately from `claim.hex` so a test can call
`verifySshSignature()` directly against the untouched message/signature
pair. Recomputing `claimBytes(claim)` from ZBTerm's current code would
change the first line (ZBTerm's own `CLAIM_MAGIC`) and mask a reverted
`NAMESPACE` behind an unrelated digest mismatch; this file isolates the
namespace check on its own.

Regenerating: extract the pre-`Z3` snapshot into scratch, symlink its
`node_modules` at this repo's, make a throwaway key, and run a script
equivalent to the one above against `<scratch>/old/engine/invite.js` and
`<scratch>/old/engine/identity/claim.js`; hex-encode each artefact into this
directory.
