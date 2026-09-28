# Upstream issue draft: the npm package's licence field contradicts the repository

**Status: drafted 2026-09-24 (F9), not filed.** `A-13`: the owner files it, or the executor does with
the owner's go-ahead; the close-out records the URL or "drafted, awaiting the owner". Target:
<https://github.com/freenet/freenet-stdlib/issues/new>.

---

**Title:** `@freenetorg/freenet-stdlib` on npm declares `MIT+APACHE-2.0`, but the repository is LGPL-3.0

**Body:**

Hello, and thanks for the TypeScript SDK.

We ship `@freenetorg/freenet-stdlib` 0.4.0 unmodified inside a desktop application (ZBTerm, an
Apache-2.0 terminal-sharing app that talks to a local Freenet node over its WebSocket API). While
writing our third-party notices we found two licence declarations for the same code that disagree:

1. The npm package's `package.json` (0.4.0, as published on npmjs.com):

   ```json
   "license": "MIT+APACHE-2.0",
   "homepage": "https://github.com/freenet/freenet-stdlib",
   "repository": { "type": "git", "url": "https://github.com/freenet/freenet-stdlib.git" },
   ```

2. The repository that field points to, `https://github.com/freenet/freenet-stdlib`, whose
   `LICENSE.md` begins:

   ```
   # GNU LESSER GENERAL PUBLIC LICENSE

   Version 3, 29 June 2007
   ```

   and the Rust crate built from the same repository (`freenet-stdlib` 0.10.0 on crates.io)
   declares in its `Cargo.toml`:

   ```toml
   license = "LGPL-3.0-only"
   repository = "https://github.com/freenet/freenet-stdlib"
   ```

(`MIT+APACHE-2.0` is also not a valid SPDX expression; `MIT OR Apache-2.0` or
`MIT AND Apache-2.0` would be.)

Could you say which licence applies to the npm package (the `typescript/` directory), and align the
`license` field, or the repository's licence files, accordingly? Until then we list the package
under both declarations and distribute it under LGPL-3.0 terms, shipped unmodified in its own
`node_modules` folder.

A related question, if you have a moment: the Rust contracts we build link `freenet-stdlib` 0.10.0
(`LGPL-3.0-only`) statically into WebAssembly. Is it your intent that contract authors satisfy
LGPL-3.0 §4 by publishing their contract source (as we do), or would you consider a linking
exception for contracts?

Thank you.
