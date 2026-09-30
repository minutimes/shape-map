# Contributing to Shape map

Start with the product behavior you want to improve. Describe what a person sees
today, what they should see afterward, and why the change helps them understand
or shape their product.

Keep changes bounded and feature IDs stable. A map, its comments, proposals, and
recorded turns share one canonical source. Canvas placement must not change the
semantic parent of a feature. Old map files must remain readable.

When changing persistence or conflict handling, add a focused regression. When
changing the interface, inspect the actual browser result at the affected sizes
and exercise its reachable states. Run `npm test` and `npm run build`.

Do not commit personal maps, generated view state, credentials, or local runtime
files. Use a synthetic map for a reproducible bug report. A screenshot showing
the specific problem is useful; redact private product content.

Contributions are made under the project's MIT License.
