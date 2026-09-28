# zbterm-fork — questions and assumptions

Questions asked of the owner, with the answers as given. Answered questions become decisions in
[`../../decisions.md`](../../decisions.md).

## Q-1 — Must ZBTerm stay compatible with the predecessor? → `D-23`

Answered by the owner 2026-09-28: "I have no problem with breaking compatibility … It does not have
to be compatible with predecessor sessions [and] can freely break its protocol and formats as much as
we want when moving to zxterm-core." The rename is a hard fork into `git@github.com:zevix/zbterm.git`,
a fork of `holepunchto/hello-pear-electron`.

## Q-2 — What comes first, and on which Pear? → `D-24`

Answered by the owner 2026-09-28: start with the rename, before zxterm, and base ZBTerm on Pear's
new version because the one the predecessor was based on is being retired. Found (`requirements.md` §2):
the new version is Pear v3, which removed `pear run`; the predecessor already branched from the
post-v3 template and uses nothing v3 removed, so "basing on it" means the current template, current
modules and `Q-3`.

## Q-3 — Does the Pear OTA updater come back? → `D-25`

The template exists for `pear-runtime`'s peer-to-peer OTA updates; `D-08` removed them from
the predecessor ("it did not go well"). Bringing them back means `PearRuntime.run` for the worker,
`package.json#upgrade`, `pear.json` multisig keys, seeders and `pear stage` / `provision` /
`multisig` releases, all run by the owner.
Recommendation: not in this project. Keep `bare-sidecar` (what `PearRuntime.run` does anyway) so
the fork stays a rename, and open the updater as its own project once ZBTerm has a release
channel to update.

Answered by the owner 2026-09-28: the recommendation is accepted.

## Q-4 — `hyperbee` or `hyperbee2`? → `D-26`

`hyperbee2` calls itself the next major of `hyperbee`, to be merged back and released as one "when
fully done"; `hyperbee` 2.27.3 is not deprecated. Breaking the format is allowed (`D-23`).
Recommendation: stay on `hyperbee` 2.x; revisit when the new major ships, since Freenet history
leaves Hypercore anyway (`D-18`).

Answered by the owner 2026-09-28: the recommendation is accepted.

## Q-5 — Do historical records keep the former name? → `D-27`

Historical records are the decisions ledger, the register, closed projects under `docs/projects/`,
the CHANGELOGs and dated handoffs. Renaming them would state that ZBTerm did things that the
predecessor did. Recommendation: they keep the former name, with one dated note at the top of
each ledger; the name test allows exactly those paths.

Answered by the owner 2026-09-28, against the recommendation: "lets remove the former name
and rewrite history - it was not publish yet and the former name is unknown". Every record is
renamed. Until `Z5` the name test allows only the rename script and this project's folder, and
`Z5` rewrites this folder to say "the former name", so the test then allows no path.

## Q-6 — Is there a zbterm-tty? (open; answered by spike `T0`)

A Pear-network text client can only be JavaScript on Bare (`plan.md` §T0). The core half already
exists: `engine/` is a host-independent package (named for the former name, becoming
`zbterm-core`), so the only new piece is the text client. Open: whether it is worth a second text
client next to `zxterm-tty`, and whether it hosts local shells (no Bare PTY exists) or only views.

## Q-7 — Is the git commit history rewritten too? → `D-28`

`D-27` covers the tree. The old name is also in the history `Z1` would merge: in old file contents
in every commit, in 3 commit messages, and in paths such as the predecessor's `bin/` script, and
it would become public when `zevix/zbterm` is pushed. The recommendation was to rewrite that
history with `git filter-repo` on a throwaway clone before the merge.

Answered by the owner 2026-09-28: "better than rewrite - squash it in the new repo, we have history
in the predecessor repo which we won't touch anymore". zbterm gets the predecessor's tree as a
squash, and its published `main` gets one commit made after the rename (`plan.md` `Z1`, `Z5`).

## Q-8 — May zxterm-core run in parallel with this project? → `D-29`, `D-30`

Asked by the owner 2026-09-28: "I want to move the project to ../zbterm/ - please move the rename
and merge project there under docs/projects … and the zxterm project to ../zxterm/ so I can start
them in parallel". This supersedes the order of `D-24` (its "on the current Pear stack" stands)
and answers zxterm-core's `Q-11` (where the workspace lives) with its own repository.

- `D-29` The two projects run in parallel. This folder lives in `zevix/zbterm`, zxterm-core's in
  `zevix/zxterm`. zxterm-core's spikes and crates need nothing from this project; its stages that
  change ZBTerm code (C0 onwards) land in zbterm only after `Z5`, so the rename and the core swap
  never edit the same files at once. Until then its spikes test against the ZBTerm tree as it is.
- `D-30` The `zxterm` Cargo workspace is its own repository, `zevix/zxterm`, from the start. Its new
  decisions go into that repository's `docs/decisions.md` as `X-nn`, so the two ledgers never take
  the same id.

Both are appended to `docs/decisions.md` in `Z1`, when the ledger arrives here.

## Assumptions

- `A-1` The owner's live predecessor instance (ports 17069/17070 and its profile directory) keeps
  running from the source tree for the whole project; nothing here stops or changes it.
- `A-2` The package `author` field ("David Achitov" today) and the new logo art are the owner's
  to supply; the rename leaves the author as is and uses a text logo until then.
- `A-3` `hetzner-deb16` keeps running the predecessor's Freenet node recipe until the owner says
  otherwise; `Z3`'s infra rename changes the repo, not the host.
- `A-4` (2026-09-28, `Z3`) The forge contact address becomes `zbterm@1zk.net`; the owner confirms
  it exists. Other option: leave the old address until the owner names one.
- `A-5` (2026-09-28, `Z3`) The rebuilt Freenet contracts keep the names `signalling-v1.wasm` and
  `pointer-v1.wasm`: no ZBTerm link was ever made, so no key has to survive (`D-23`). Other option:
  ship them as `-v2` next to the old bytes, as the `D-10` rule for a moved contract says.
