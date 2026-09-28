# Baseline — 2026-09-28 (Z0)

- Tree: branch `freenet`, code at `b337e48` (the owner's commit of the pending work); only the docs
  of this project changed on top, and they are committed with this file.
- `npm test` (the `test` script's `brittle-node` command, run with its own `HOME` and a short
  `TMPDIR`), two full runs: both `# tests = 461/461 pass`, `# asserts = 2977/2977 pass`, exit 0,
  about 4 min 5 s each. No failing ids; `S-03` did not recur.
- `npm run lint`: exit 0, 98 `require-await` warnings (the same count as at the V0 baseline of
  `260919_no-updater-archive-tabby`).
- Harness note, not a finding: with a long `TMPDIR` the SSH-agent test cannot listen, because the
  socket path passes the 108-byte Unix limit (`EINVAL` on `listen`). Keep `TMPDIR` short in every
  later gate.
- Next free: `S-36`, `D-29`.
