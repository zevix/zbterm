Done 2026-09-18. Phases B0–B9 retired (see CHANGELOG.md). Suite 347 tests / 2053 asserts
(baseline 277 / 1533); lint exit 0, 98 warnings. Delivered: the ShareBackend interface, the
Pear adapter, a loopback backend with a conformance suite, the registry with --backend /
ZBTERM_BACKEND and share.backends, build variants and UI gating, Freenet probes (probes.md)
and the Freenet adapter design (freenet-backend-design.md). Awaiting the owner: sign-off on
S-13 (the `none` package still ships hyperswarm because D-02 keeps the OTA updater) and review
of the executor decisions D-04, D-05, D-06. Known intermittent test: S-03. Open items:
open-issues.md. Nothing was committed; git was not touched.

2026-09-19: the S-13 sign-off is no longer pending; resolved by D-07 in ../260919_nonpear-no-updater/.
