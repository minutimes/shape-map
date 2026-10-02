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

Product connections and reading lenses also accept `upsertLink`, `removeLink`,
`setMapLinks`, and `setMapLenses`; see their schemas in
[the Shape map contract](SHAPE-MAP.md). `restoreNodes` may include `links` and
`lenses` to restore pruned relationship metadata when undoing a subtree deletion.

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
  `proposal.logic|inputs|outputs|ui|condition|executor|reason|purpose|successCriteria`; whole `proposal`;
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
same fields as task plus optional `reason`, `purpose`, and `successCriteria`; `{}` is valid and remains present.
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
patch may contain `positions`, `collapsedIds`, `viewport`,
`workflow: { collapsedIds?, viewport? }`, or
`shape: { layoutVersion?: 2 | 3, positions?, sizes?, anchors?, collapsedIds?, viewport? }`.
It updates only the non-authoritative
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

## Compact AI discussion requests

`GET /api/brief?focus=NODE_ID` references the map and returns the relevant changed
intent and memo excerpts. `POST /api/brief` accepts:

```json
{"focus":"planning","problem":"People cannot find the right feature","purpose":"Understand the product","successCriteria":"Find the feature in one step","approved":false}
```

`focus` is optional; text fields are optional and at most 4,000 characters each.
`approved` defaults to false and requires a nonempty problem and success criteria
when true. The response is `{text,mapPath,revision,targetCount,approved}`.
This read-only export performs no model call, map mutation, or implementation.
See the [facilitation workflow](../skills/shape-map-facilitation/SKILL.md).

`PUT /api/view` also accepts `patch.shape.sizes` keyed by existing IDs with finite
`{width,height}` in the 168×72 to 30000×30000 range. `null` removes a shape position
or size override. `patch.shape.anchors` merges placement relationships by ID;
`null` removes an anchor. Each anchor can contain `x: {id,edge,offset}` (left/right)
and `y: {ids,edge,offset}` (top/bottom), with finite offsets and existing sibling
references. Cyclic or cross-parent references return `422` without writing.
Spatial changes preserve the source revision and `.mmd` bytes.

## Projects

Set `SHAPE_MAP_WORKSPACE_ROOT` to a folder that holds product repositories.
Shape map then opens with a project list instead of a single map. Without it,
the single-map behavior above is unchanged. Project maps follow
[the project map contract](FORMAT.md#project-maps).

- `GET /api/projects` returns `{ "workspace": true, "projects": [...] }`, or
  `{ "workspace": false }` when no workspace root is configured. Each project is
  `{ "key", "name", "branch", "worktree", "mapCount" }`. Projects are the Git
  repositories directly inside the workspace root, plus their Git worktrees that
  are inside the root and contain `docs/maps/*.mmd`. `key` is the project's path
  relative to the workspace root, with `/` separators.
- `GET /api/project?project=KEY` returns `{ "project", "maps": [...] }`. Each map
  is `{ "file", "path", "kind", "title", "description?", "editable", "declaredKind?", "error?", "line?" }`.
  `kind` is `features`, `user-flow`, `system-flow`, or `other`; `declaredKind` keeps a header kind
  this version does not know. A map that cannot be edited explains why in
  `error`, with `line` when one line is at fault.
- `GET /api/project/events?project=KEY` is an SSE stream of `maps` events carrying
  that list whenever a map file is added, removed, or renamed, or changes kind,
  title, or validity.

Every existing route (`/api/map`, `/api/events`, `/api/mutations`, `/api/view`,
`/api/brief`, `/api/subtree/:id`, `/api/health`, and `/api/repository`) accepts
`project` and `map` query parameters together; `map` is a file name inside
`docs/maps/`. Without them, the routes serve the configured single map. Only
listed projects and maps can be opened. Traversal, other folders, and symlinks
that resolve outside the project are rejected with 404 `project_not_found` or
`map_not_found`. For a project map, `/api/repository` reads that project's Git
history, and `/api/view` keeps canvas state in Shape map's local state directory
(`SHAPE_MAP_STATE_DIR`, default `.state/` in the Shape map checkout) instead of
the project.

Snapshots carry `kind`. A `features` snapshot is the v1 snapshot above; its
`graph.map` holds the header when the source has one. A flow map snapshot
(`user-flow` or `system-flow`) is:

```json
{
  "revision": "sha256-prefix",
  "updatedAt": "ISO-8601",
  "origin": "startup|external|<clientId>",
  "mapPath": "docs/maps/rooms.mmd",
  "kind": "user-flow",
  "editable": true,
  "source": "flowchart LR\n  %% sm-map: {\"kind\":\"user-flow\",\"title\":\"방 들어가기\"}\n  ...",
  "graph": {
    "map": { "kind": "user-flow", "title": "방 들어가기" },
    "direction": "LR",
    "lanes": [{ "id": "player", "title": "플레이어", "tags": [], "summary": "처음 온 사람이에요." }],
    "steps": [{ "id": "player_enter", "label": "게임에 들어오기", "shape": "milestone", "lane": "player", "tags": ["plaza"] }],
    "arrows": [{ "source": "player_enter", "target": "player_quick", "style": "next" }],
    "tags": [{ "id": "plaza", "label": "광장", "description": "모두가 처음 들어오는 공개 서버", "fill": "#E6EAFB", "stroke": "#3550C8", "textColor": "#1A2A6B", "strokeWidth": 1 }]
  },
  "sourceStatus": { "valid": true, "error": null }
}
```

`steps` follow canonical declaration order. `direction` is `LR`, `TB`, or `TD`
as written. `shape` is `action`, `milestone`, or `decision`. `style` is `next`
(`-->`), `alternative` (`-.->`), or `exchange` (`==>`). Optional values are
absent when empty: `summary`, a lane `direction`, an arrow `label`, a tag
`strokeDasharray` (such as `"4 3"`), and the map `title` and `description`.

A map that cannot be edited is served with `"editable": false`, its `source`, and
`sourceStatus: { "valid": false, "error": "...", "line": 12 }`, and `graph: null`
unless an earlier valid version is still shown. Its `kind` is the declared kind
when it is known and `other` otherwise. Mutations on it return 422
`read_only_map`; a map that became invalid after opening keeps the v1 behavior
and returns `invalid_source`, with `sourceStatus.line` when one line is at fault.
A kind this version does not know is also kept as `declaredKind` in the snapshot.
`/api/brief` and `/api/subtree/:id` serve only `features` maps, and `/api/view`
keeps canvas state only for `features` maps; other kinds return 422
`unsupported_map_kind`, and a read-only map returns 422 `read_only_map`.

### Flow map operations

User flow and system flow maps use `POST /api/mutations?project=KEY&map=FILE` with
`{ "baseRevision", "clientId", "operation" }`. Every flow map operation needs the
exact current revision.

| Operation | Fields |
| --- | --- |
| `addStep` | `lane` (lane ID, or `null` for a shared step), `label`, optional `id`, `shape`, `tags`, `summary`, `after` or `before` (a step in the same lane), `connectFrom` (also adds `connectFrom --> new`), and `splice` (`{source,target}`: replaces that arrow with source → new → target; the first arrow keeps the old style and label) |
| `updateStep` | `id`, optional `label`, `shape`, `tags` (the complete list), `summary` (`null` removes) |
| `moveStep` | `id`, `lane` (`null` for shared), optional `after` or `before`; arrows are unchanged |
| `deleteSteps` | `ids`, optional `bridge` (default `true`): a deleted step with exactly one incoming and one outgoing arrow is replaced by one arrow from its predecessor to its successor, keeping the incoming style and label, unless that pair is already connected |
| `addArrow` | `source`, `target`, optional `style` (default `next`) and `label` |
| `updateArrow` | `source`, `target`, optional `style`, `label` (`null` removes), `newSource`, `newTarget` |
| `removeArrow` | `source`, `target` |
| `addLane` | `title`, optional `id`, `after` (lane ID, or `null` to be first), `tags`, `summary`; without `after`, the lane is last |
| `updateLane` | `id`, optional `title`, `tags`, `summary` (`null` removes) |
| `moveLane` | `id`, `after` (lane ID, or `null` to be first) |
| `deleteLane` | `id`, optional `withSteps`; required when the lane has steps, which are then deleted without bridging |
| `upsertTag` | `tag`: `{ id, label, description, fill, stroke, textColor, strokeWidth, strokeDasharray? }` |
| `deleteTag` | `id`; removes the tag from every lane and step |
| `setMapHeader` | optional `title` and `description` (`null` removes) |
| `replaceSource` | `source`: complete text that must parse as a flow map (either flow kind; changing the kind moves the map to the other tab); used by the source editor and by undo and redo |

Generated IDs are the smallest unused `step-N` or `lane-N`. Validation failures
return 422 `validation_error`; source errors include `details.line`. A stale
revision returns 409 `revision_conflict` with a fresh snapshot. An operation whose
canonical result equals the current source skips the write and the SSE event.
`replaceSource` writes its text as given once it parses and passes Mermaid
validation, so undo can restore a file exactly; it is not reordered.
`features` maps in a project use the v1 operations above.

`npm run map -- check PATH` validates one map file or a `docs/maps` folder without
a running server. It prints each file's kind, title, and first error with its
line, and exits with status 1 when a file that declares `features`, `user-flow`, or
`system-flow` is not valid.
