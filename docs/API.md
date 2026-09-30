# Local collaboration API v1

The default data root is the code repository and the default map is
`maps/shape-map.mmd`. Set `FINAL_SHAPE_MAP_DATA_ROOT` to keep map data in a separate
workspace, then set `FINAL_SHAPE_MAP_PATH` to a `.mmd` inside that root. The map
path may be relative to the data root or absolute, but its resolved path must
remain inside the root. Traversal and map/view symlinks that resolve outside the
root are rejected. The server binds to `127.0.0.1` only.

Primary environment names:

- `FINAL_SHAPE_MAP_DATA_ROOT`: allowed map workspace; defaults to the code repository
- `FINAL_SHAPE_MAP_PATH`: selected `.mmd`; defaults to `maps/shape-map.mmd`
- `FINAL_SHAPE_MAP_PORT`: loopback port; defaults to `4317`
- `FINAL_SHAPE_MAP_INSTANCE_KEY`: optional pid/log identity; defaults to `port-<port>`
- `FINAL_SHAPE_MAP_RUN_DIR`: optional runtime directory; defaults to `.run`

The former `MLC_*` names remain accepted as compatibility aliases. Data-root
aliases also include `FINAL_SHAPE_DATA_ROOT` and `MLC_MAP_DATA_ROOT`.
For product comments, review, turns, discussion export, and repository history,
see [the Shape map contract](SHAPE-MAP.md).
New local launches write `.run/server-<instance>.pid` and `.log`. The launcher
continues to recognize the original `.run/server.pid` for an already-running
default 4317 demo until that process is stopped.

## Snapshot

`GET /api/map` and successful mutations return:

```json
{
  "revision": "sha256-prefix",
  "updatedAt": "ISO-8601",
  "origin": "startup|external|<clientId>",
  "mapPath": "maps/demo.mmd",
  "graph": {
    "direction": "LR",
    "settings": { "optionalFields": ["executor", "condition"] },
    "nodes": [
      { "id": "direction", "label": "영상 설계 지도", "parentId": null, "shape": "rounded", "category": "direction", "layout": { "mode": "fit" } },
      { "id": "sources", "label": "출처와 버전", "parentId": "direction", "shape": "rectangle", "category": "focus", "layout": { "mode": "fit" }, "section": "reference" }
    ],
    "categories": [
      { "id": "direction", "label": "방향", "description": "전체 구조의 출발점", "fill": "#16362F", "stroke": "#4FD1A0", "textColor": "#F5FFF9", "strokeWidth": 2 }
    ]
  },
  "view": {
    "positions": { "direction": { "x": 0, "y": 0 } },
    "collapsedIds": [],
    "viewport": { "x": 0, "y": 0, "zoom": 1 }
  },
  "sourceStatus": { "valid": true, "error": null }
}
```

## Revision-checked semantic edits

`POST /api/mutations` accepts `{ "baseRevision", "clientId", "operation" }`.
Supported operations:

- `addNode`: `{ "type", "id?", "parentId", "label", "shape", "category", "layout?", "section?", "task?", "proposal?", "workflow?" }`; `section`, when present, must be `"reference"`.
- `renameNode`: `{ "type", "id", "label" }`
- `moveNode`: `{ "type", "id", "parentId", "order?" }`
- `moveNodes`: `{ "type", "items": [{ "id", "parentId" }], "order?" }`
- `setNodePresentation`: `{ "type", "id", "shape", "category" }`
- `setNodeLayouts`: `{ "type", "items": [{ "id", "layout": { "mode": "fit" } | { "mode": "wrap", "width" } | { "mode": "fixed", "width", "height" } }] }`
- `setNodeTask`: `{ "type", "id", "task": object | null }`; `null` removes task metadata. A task may contain `logic`, `inputs`, `outputs`, `ui`, `condition`, and `executor`. Executor `kind` is one of `code`, `perception`, `llm`, `jev`, or `human`; `effort` is accepted only for `llm`, and `jev` language is normalized to `en`.
- `setNodeWorkflow`: `{ "type", "id", "workflow": { "mode": "group|sequence|parallel|conditional" } | null }`; `null` removes the explicit workflow, so the node uses the default `group` meaning.
- `setMapSettings`: `{ "type", "settings": { "optionalFields": ["executor" | "model" | "effort" | "condition" | "workflow", ...] } | null }`. The array is required, may be empty, and cannot contain duplicates. Unknown settings properties and enum values are rejected. `null` removes the map settings comment.
- `patchNodeContent`: `{ "type", "id", "changes": [{ "path", "before", "after" }] }`.
  Both guards are required; `null` means the field or object is absent. Allowed
  paths are `label`; `section`; `task.logic|inputs|outputs|ui|condition|executor`;
  `proposal.logic|inputs|outputs|ui|condition|executor|reason`; whole `proposal`;
  and whole `workflow`. `section` accepts `null` or `"reference"`. Whole proposal and workflow values are objects or `null`.
  Executor is one atomic object and cannot be patched by subfield. Duplicate,
  overlapping (for example `proposal` with `proposal.logic`), and unknown paths
  are rejected. Label cannot be empty. Optional text is trimmed and an empty
  value becomes absent. Every guard is checked before any field changes.
- `setChildOrder`: `{ "type", "id": "parentId", "childIds": ["every-direct-child-exactly-once"] }`; it swaps only the direct children’s existing slots in `graph.nodes`.
- `deleteLeaf`: `{ "type", "id" }` (for undoing a newly added leaf only)
- `deleteSubtrees`: `{ "type", "ids" }` (atomically deletes each selected node and all descendants; the root is rejected)
- `restoreNodes`: `{ "type", "nodes", "order" }` (history restoration with an exact complete node order)
- `upsertCategory`: `{ "type", "category": { "id", "label", "description", "fill", "stroke", "textColor", "strokeWidth" } }`

Task and proposal executor `model` and `effort` values describe intended design only; the map
service does not call provider APIs. Empty optional task strings are omitted.
Task and proposal text fields are limited to 4,000 characters, `model` to 160, and `effort` to
80. Unknown nested fields, invalid types, oversized values, non-`en` Jev language,
and effort on a non-LLM executor are rejected.

Proposal uses canonical Mermaid metadata `%% mlc-proposal: ID|JSON`. It has the
same fields as task plus optional `reason`; `{}` is valid and remains present.
Proposal metadata has no independent view semantics.

A node with `section: "reference"` starts a reference area. The UI applies that
classification to its entire subtree without changing descendants' IDs, parent
edges, tasks, proposals, workflows, or other stored content. The graph root
cannot be a reference section.

Map settings are authoritative source metadata. They select which optional
authoring features this map exposes and do not delete task/proposal/workflow
values. `{ "optionalFields": [] }` deliberately hides all optional features
while preserving their values. Missing settings stay missing across round trips
and unrelated edits.

When a node actually changes parent into an explicit `sequence` workflow, it is
appended after that parent's existing direct children. A `moveNodes` operation
appends multiple incoming nodes in `items` order. Other workflow modes retain the
legacy declaration order behavior. `moveNode` and `moveNodes` accept an internal
optional `order` array containing every graph node ID exactly once; history undo
uses it to restore the exact declaration order, including interleaved descendant
declarations. Invalid, incomplete, or duplicate orders are rejected.

Status `409` returns `{ "code": "revision_conflict", "message", "snapshot" }`
or `{ "code": "field_conflict", "message", "details": { "fields": [...] }, "snapshot" }`.
Status `422` returns a precise validation/source error without writing. The client
may show a pending operation and let the user explicitly retry it against the
new snapshot; it must never retry silently.

`patchNodeContent` is the narrow exception to that never-silent generic-retry
rule. It may carry a stale but non-empty `baseRevision`, because the server
compares every requested field with the latest canonical source. A field is safe
when its current value equals either `before` or `after`; the latter makes a
lost-response retry idempotent. Unrelated current fields remain untouched. If
any guard matches neither value, the entire operation fails with
`field_conflict`. All other semantic mutations still require the exact current
revision. A patch that produces identical canonical source skips validation,
disk write, and SSE emission.

## View state

`PUT /api/view` accepts `{ "clientId", "baseRevision", "patch" }`, where the
patch may contain `positions`, `collapsedIds`, `viewport`, or
`workflow: { collapsedIds?, viewport? }`. It updates only the non-authoritative
sibling `*.view.json`, merging position keys for stable IDs. Workflow navigation
is merged at both nested levels and remains independent of the legacy flat
collapse and viewport values. Old views omit `workflow` until it is explicitly
patched. Its `collapsedIds` and `viewport` fields remain independently optional;
writing one never materializes the other. Deleted or invalid node IDs are filtered
during reads and semantic mutations. View writes require the current source
revision and do not change it.

## Fresh reads, events, and Codex access

- `GET /api/events` is an SSE stream. Events are `snapshot` or `source-error`.
- `GET /api/subtree/:id?depth=2` returns a compact fresh structural slice. When
  map settings exist, the response includes them beside `revision` and `root`;
  absent settings remain absent.
- `GET /api/health` reports liveness, map path, revision, and source validity.
- `npm run map -- ...` is the CLI wrapper over the same API. It must expose at
  least `show`, `subtree`, `add`, `rename`, `move`, and `style`.

An external file change is parsed and Mermaid-validated before becoming a
snapshot. Invalid source emits `source-error`; the last valid snapshot remains
visible and the invalid file is never overwritten.
