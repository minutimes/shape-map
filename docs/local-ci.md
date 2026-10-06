# Owner-Mac CI

CI uses the repository-scoped `mac-m4max-shape-map` runner with labels
`self-hosted, macOS, ARM64, shape-map-mac`. Its official `svc.sh` service lives
in `/Users/minmac/actions-runner/shape-map`.

One job installs locked npm dependencies, runs unit/API tests, builds the app
and executes every browser acceptance check using Playwright's separate
headless Chromium. It reuses the build and local caches. Screenshots and logs
retain their existing seven-day retention. The owner's signed-in Chrome
profile is not used.

External-fork PRs are skipped on this public repository's owner runner.
GitHub approval is required for all external contributors. Checkout credentials
are not persisted. Review code before granting repository write access or
approving an external workflow. CI runs on trusted PRs and manual dispatch;
the suite is not repeated on merge push.

The Mac must be awake, connected and logged in. Queued work waits locally
without a hosted fallback. All services share the Mac's resources.
Run `./svc.sh status` in the service directory for local availability.
