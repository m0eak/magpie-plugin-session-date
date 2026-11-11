# Local acceptance summary

Recorded on November 8, 2026. The session date filter passed local Web integration acceptance for the source snapshot based on `ddc384ce4674bd70b2638c28624c15a97d8b11d8` plus the accepted working changes. It has not been published or deployed.

## Recorded environment and checks

The recorded host was version 0.1.3319, with Bun 1.3.10, Node.js v22.23.0, Chromium 149.0.7827.55, and Playwright Core 1.61.1. The recorded checks reported:

- Node test suite: 84 passed, 0 failed, and 8 Bun-only checks skipped.
- Bun test suite: 62 passed and 0 failed.
- Bun integration check: passed.
- Local host acceptance covered plugin loading, the page/service bridge and token checks, filtering counts, narrow layout, refresh and stale-state behavior, persistence and restart readback, and the documented remove-and-restart uninstall flow.

The integration used an isolated local host and a synthetic loopback upstream. It did not send real business model requests. These are results recorded in the acceptance evidence; this publication preparation did not rerun the test suites.

## Limits

Acceptance applies to the recorded environment. The desktop statistics page, other host versions, and real-world cache benefits were not verified. Known Gemini media and code parts can increase the unmatched-count denominator. Statistics count prompt transformations and do not measure model cache hits or token savings. Pending increments can be lost if the process exits abnormally before persistence. Removing a plugin registration may require restarting host processes that loaded it.

## Follow-up source validation

On November 11, 2026, the source changes for independent date and topic-title controls, category counters, and concurrent settings updates passed local validation on the merge candidate. Node reported 108 passing tests, 11 skipped, and 0 failures; Bun reported 67 passing tests, 1 skipped, and 0 failures. The local integration check passed for the hook, read-only HTTP service, owner-only permissions, and four-process SQLite aggregation. `npm pack --dry-run --json --ignore-scripts` listed 18 package files.

This follow-up did not repeat the November 8 host acceptance, install or reload the plugin in a running host, publish a package, send real model requests, or measure provider cache behavior. The host acceptance above remains limited to its recorded November 8 source snapshot.
