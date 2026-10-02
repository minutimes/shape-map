# Contributing to Shape map

Start with the product behavior you want to improve. Describe what a person sees
today, what they should see afterward, and why the change helps them understand
or shape their product.

Keep changes bounded and feature IDs stable. A map, its comments, proposals, and
recorded turns share one canonical source. Canvas placement must not change the
semantic parent of a feature. Old map files must remain readable.

When changing persistence or conflict handling, add a focused regression. When
changing the interface, inspect the actual browser result at the affected sizes
and exercise its reachable states.

## Checks

Run these from a clean `npm ci` before proposing a change:

| Command | What it proves | Time |
| --- | --- | --- |
| `npm test` | The unit and API tests in `tests/` pass: the map format, storage, conflicts, layout, and editing rules. | seconds |
| `npm run build` | The app compiles into `dist/`. | seconds |
| `npm run test:browser` | The real app works in headless Chromium: it builds once, then runs every `scripts/*-acceptance.mjs` against a production server on free ports. | about a minute |

`npm run test:browser` prints one line per check and a summary, and exits
nonzero if any check fails. The full output of each check is in
`test-results/browser-checks/<name>.log`; screenshots and reports are in
`test-results/<name>/`. Useful options:

```sh
npm run test:browser -- flow shell     # only checks whose name contains a word
npm run test:browser -- --skip-build   # reuse the current dist/
npm run test:browser -- --jobs 1       # one check at a time (default 3)
npm run test:browser -- --list         # list the checks
```

The browser checks need headless Chromium once per machine:
`npx playwright-core install --only-shell chromium`. Set
`PLAYWRIGHT_CHROME_PATH` to use another Chromium build.

| Browser check | What it covers |
| --- | --- |
| `project-shell` | Project list, map tabs, editing a feature, read-only maps, live additions, address history, single-map mode. |
| `map-create` | Creating the first and further maps from the app; only the new `.mmd` files appear and pass `map check`. |
| `flow-project` | User and system flows through the real server: edits, undo byte for byte, live disk edits, conflicts, source errors. |
| `flow` | The flow canvas on its development harness: lanes, tags, arrows, drag-to-connect, keyboard, a 200-step map. |
| `hierarchy-editor` | The detailed editor (`?editor=1`): editing, keyboard creation, copy/cut/paste, folding, restart persistence, external and invalid source, conflicts, toolbar at three widths. |
| `history-shortcuts` | Undo and redo shortcuts restore the exact graph and positions after deleting, and after renaming. |
| `node-layout` | Card sizing: resizing keeps the released size on screen while saving, the size limits, batch layouts written to Mermaid. |
| `reparent-drag` | Dragging cards into another card, with guidance and one undo for the drop. |
| `visible-layout` | A 50-card map restores its saved camera, and tidying visible cards leaves folded ones untouched. |

### Writing a browser check

Name a new check `scripts/<topic>-acceptance.mjs`; the runner finds it. Use the
helpers in `scripts/support/browser-check.mjs`: `startServer()` starts the built
app on a free port, `launchBrowser()` starts headless Chromium, and
`evidenceDir('<topic>')` gives a fresh `test-results/<topic>/`. Never use a fixed
port, a local Chrome path, or a real product repository; build fixtures in a
temporary folder or copy `examples/sample-project`. Exit nonzero on failure.

Each check must fail for a real regression, not for timing. Wait for the state
you assert instead of sleeping, and assert behavior the documentation describes.
When the product changes on purpose, update the check in the same change. Delete
a check only when what it guarded no longer exists or another check covers it.

GitHub Actions (`.github/workflows/ci.yml`) runs `npm test`, `npm run build`,
and `npm run test:browser` on every pull request and every push to `main`.

Do not commit personal maps, generated view state, credentials, or local runtime
files. Use a synthetic map for a reproducible bug report. A screenshot showing
the specific problem is useful; redact private product content.

Contributions are made under the project's MIT License.
