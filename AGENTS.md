# Shape map contributor instructions

- Read `README.md`, `docs/FORMAT.md`, and `docs/SHAPE-MAP.md` before changing contracts.
- The `.mmd` file is authoritative for semantic content. `.view.json` holds canvas state only.
- Keep stable feature IDs. Reject unsupported or invalid source instead of silently rewriting it.
- Preserve authored content and unrelated work. Local user maps are not release fixtures.
- Never manufacture human review or development history. Blue is a recorded turn difference.
- Keep visible language understandable to people who do not develop software.
- Use focused tests for persistence, concurrency, or interaction changes. Verify visible UI in a browser.
- Before proposing a change, run `npm ci`, `npm test`, `npm run build`, and `npm run test:browser`
  (see CONTRIBUTING.md "Checks"). Every check must pass and mean something; fix or remove a stale one.
