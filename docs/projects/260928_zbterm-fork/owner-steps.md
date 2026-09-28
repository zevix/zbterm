# zbterm-fork — owner steps (`Z5`)

Written by `Z5` (close-out). No git command in this file has been run by any phase: the working
tree is uncommitted on purpose, exactly as `Z5` left it. Every command below is for the owner to
run, in order, from `/zp/zdata/zeev/github/zbterm`.

**State this was written against:** `HEAD` = `main` @ `931a836` (this folder, already pushed);
working tree modified/untracked throughout (Z0–Z5, uncommitted); `origin` =
`git@github.com:zevix/zbterm.git`, no other remote; no tags. Re-run the pre-flight check below
before trusting anything after this file was written.

**Pre-flight (either option).**
```sh
cd /zp/zdata/zeev/github/zbterm
git rev-parse HEAD                 # expect 931a836c3bdc9271b9f678964e106818fe454711
git remote                         # expect: origin
git tag                            # expect: (empty)
git stash list                     # expect: (empty)
```

## Option A — keep `931a836`, commit the renamed tree as one more commit on `main`

Does **not** satisfy `requirements.md` `Z-1`/`Z-3` ("not in zbterm's published history"), because
`931a836` itself already names the predecessor and stays in the history. Use this option only if
that is acceptable.

```sh
cd /zp/zdata/zeev/github/zbterm
git add -A
git commit -m "Rename the project to ZBTerm on the current Pear stack (Z0-Z5)"
```

Checks:
1. `git log -1 --format=%B | grep -qi "$(printf 'p%sterm' ear)" && echo FAIL || echo OK`
   — expect `OK` (the commit message names no old name).
2. `git grep -il "$(printf 'p%sterm' ear)" HEAD ; echo "hits exit: $?"`
   — expect no file names printed and `hits exit: 1`.
3. `git log --oneline`
   — expect the new commit on top, then `931a836`, then only template commits down to the
     project's root; no commit from the predecessor repository.
4. `git remote`
   — expect exactly: `origin`.
5. `git tag`
   — expect no predecessor tag (this project created none, so expect it empty unless the owner
     added tags elsewhere).

## Option B — rebuild `main` from `72710d1`, then one squashed commit, then force-push

Satisfies `Z-1`/`Z-3`: `931a836` is dropped from `main`'s history, so no commit that names the
predecessor is published. This rewrites the remote `main`; anyone who already pulled `931a836`
must re-clone or hard-reset.

```sh
cd /zp/zdata/zeev/github/zbterm
git update-ref refs/heads/main 72710d1   # moves the *ref* only; the working tree/index (the
                                          # renamed, uncommitted tree) is untouched by this
git add -A
git commit -m "Import the renamed project tree as ZBTerm (squashed history)"
git push --force origin main
```

Notes on the sequence:
- `git update-ref` (not `git checkout`/`git branch -f`) is used deliberately: it moves what
  `main` points to without touching a single file on disk, so the renamed tree already sitting in
  the working directory becomes the diff `git add -A && git commit` captures. `git branch -f main
  72710d1` would be refused (`main` is the checked-out branch); `git checkout 72710d1 -B main`
  would overwrite the working tree with the old template snapshot and must not be used here.
- The `git push --force` step is the one destructive, publishing action in this file. Run it only
  when ready; nothing else here reaches the remote.

Checks (same shape as Option A, run after the commit and again after the push):
1. `git log -1 --format=%B | grep -qi "$(printf 'p%sterm' ear)" && echo FAIL || echo OK`
   — expect `OK`.
2. `git grep -il "$(printf 'p%sterm' ear)" HEAD ; echo "hits exit: $?"`
   — expect no file names printed and `hits exit: 1`.
3. `git log --oneline`
   — expect the new commit on top, then `72710d1` directly (no `931a836`, no commit from the
     predecessor repository) down through only template commits.
4. `git remote`
   — expect exactly: `origin`.
5. `git tag`
   — expect no predecessor tag.
6. After `git push --force origin main`: `git log --oneline origin/main` (or check on
   `github.com/zevix/zbterm`) shows the same history as the local check above.

## Either option — zxterm-core

Once one of the two options above has landed, `docs/projects/260928_zbterm-fork/QnA_assumptions.md`
`Q-8`/`D-29` allows zxterm-core's ZBTerm-side stages (from its `C0` onward) to start landing changes
in this repository.
