# Supported Mermaid contract (v1)

`maps/*.mmd` is the single authority for graph meaning and node presentation.
The editor deliberately supports a small Mermaid `flowchart` subset so every visual
operation has an honest text round trip.

## Authoritative syntax

- One `flowchart LR` declaration.
- Stable node identifiers matching `[A-Za-z][A-Za-z0-9_-]*`.
- Rectangles: `id["label"]`; rounded nodes: `id(["label"])`.
- Hierarchy only: `parent --> child`. Each non-root node has exactly one parent;
  cycles are invalid. Cross-feature relationships use `sm-link` metadata and are
  never inferred from spatial placement.
- Category presentation: `classDef name fill:#RRGGBB,stroke:#RRGGBB,color:#RRGGBB,stroke-width:Npx`
  and `class id1,id2 name`.
- Explicit legend copy: `%% mlc-legend: category|Korean label|description`.
- Optional per-node sizing presentation:
  - content fit (the default; omitted from source): `%% mlc-node-layout: id|fit`
  - fixed width with visible wrapped content: `%% mlc-node-layout: id|wrap|WIDTH`
  - fixed width and height with clipped content: `%% mlc-node-layout: id|fixed|WIDTH|HEIGHT`
  - width is an integer from 168–720; height is an integer from 72–480.
- Optional task semantics: `%% mlc-task: id|JSON`, where `JSON` follows this shape:
  ```json
  {
    "logic": "optional text",
    "inputs": "optional text",
    "outputs": "optional text",
    "ui": "optional text",
    "condition": "optional text",
    "executor": {
      "kind": "code|perception|llm|jev|human",
      "model": "optional descriptive design value",
      "effort": "optional descriptive design value for llm only",
      "language": "optional en"
    }
  }
  ```
  Empty optional strings are omitted. Each task text field is limited to 4,000
  characters, `model` to 160, `effort` to 80, and the complete JSON comment to
  64 KiB. A `jev` executor defaults to `"language":"en"`; other languages are
  rejected. These values describe intended execution only and do not invoke a
  model provider.
- Optional proposal semantics: `%% mlc-proposal: id|JSON`. A proposal accepts
  the same `logic`, `inputs`, `outputs`, `ui`, `condition`, and atomic `executor`
  fields as a task, plus optional `reason` text. `reason` has the same 4,000
  character limit. An empty proposal `{}` is meaningful and is preserved so a
  newly opened proposal can exist before its first field is filled. Proposal
  metadata is descriptive and does not change graph or view behavior.
- Optional child workflow semantics: `%% mlc-workflow: id|{"mode":"sequence"}`.
  The supported modes are `group`, `sequence`, `parallel`, and `conditional`.
  An absent workflow means `group`; writers preserve absence instead of adding
  redundant metadata.
- Optional reference-area semantics: `%% mlc-section: id|reference`. The tagged
  node starts a reference subtree; the UI treats that node and all descendants
  as reference material instead of normal system-flow items. Descendants keep
  their own stable IDs, parents, task data, proposals, workflows, and
  presentation. The single graph root cannot be tagged as a reference section.
- Optional map-level editor settings: one `%% mlc-settings: JSON` comment, where
  JSON has exactly this shape:
  ```json
  { "optionalFields": ["executor", "model", "effort", "condition", "workflow"] }
  ```
  `optionalFields` is required and may be empty. Every entry must be unique and
  drawn from that exact enum. The setting controls which optional authoring
  features the UI exposes for this map; it does not remove values already stored
  in task, proposal, or workflow metadata. An empty array deliberately hides all
  five optional features while preserving their data. If the comment is absent,
  readers and writers preserve that absence instead of materializing defaults.
- The marker `%% mlc-format: 1` is required.

Product metadata (`sm-block`, `sm-turn`, `sm-link`, and `sm-lens`) is documented
in [the Shape map contract](SHAPE-MAP.md). It lives in this same `.mmd` source;
Mermaid treats these lines as comments. Parent arrows remain an unambiguous tree.

Label text is JSON-quoted by the writer, so Korean, spaces, and punctuation survive.
Task, proposal, and workflow comments split at the first delimiter after the node ID, so `|`
inside valid JSON strings survives the round trip.
IDs never change during rename, move, shape, category, or card-size edits.
Sibling order is the order of node declarations among nodes with the same parent;
there is no separate child reference list.

## Non-authoritative view state

`maps/<name>.view.json` may store node positions, collapsed IDs, and viewport.
The product canvas also stores optional `shape.sizes` keyed by feature ID with
`{width,height}` (168×72 to 30000×30000). Coordinates inside a section are relative
to that section. A `null` entry in a shape position or size patch removes the
override for undo; deleted feature entries are filtered. Sizes are spatial view
state and never replace the canonical Mermaid hierarchy or feature meaning.

Shape positions are placement preferences. When an expanded card or section
would overlap a sibling, the canvas gives it room in reading order and grows its
container. This derived spacing does not overwrite saved positions. Folding or
undoing the expansion restores the arrangement from those same preferences.

Optional `shape.anchors` remembers manual placement relative to sibling cards:
`x: {id, edge: "left" | "right", offset}` aligns a column or follows a left
neighbor; `y: {ids, edge: "top" | "bottom", offset}` follows a row's top or
greatest bottom. Offsets use the same section-relative coordinates as positions.
References must be siblings and cannot contain cycles. Missing or stale references
are filtered on read. An anchor patch is merged by feature ID; `null` removes it.
Anchors participate in spatial undo and redo and never alter Mermaid hierarchy.

The view may also contain independent workflow navigation state:

```json
{
  "workflow": {
    "collapsedIds": ["planning"],
    "viewport": { "x": 0, "y": 0, "zoom": 1 }
  }
}
```

The workflow key remains absent in legacy views until workflow navigation is
written. Its `collapsedIds` and `viewport` fields are independently optional: a
first viewport write does not create an empty collapse list, and a first collapse
write does not create a viewport. Invalid or deleted node IDs are filtered from
both collapse lists.
Deleting it never changes the map meaning; the editor rebuilds a layout. External
semantic edits retain view entries for still-existing IDs.

## Safety boundary

Unknown Mermaid statements, duplicate IDs, duplicate section/settings metadata,
multiple parents, cycles, missing categories, unknown metadata properties,
invalid section/settings enum values, invalid metadata types or sizes, or invalid
Mermaid syntax are rejected. Unsupported source is never rewritten in a
way that could lose semantic metadata. The server keeps showing the last valid
snapshot and never overwrites the invalid file. A revision mismatch is returned
as a recoverable conflict, except for the field-guarded content patch described
in the API contract. That operation compares every field with the latest source
before it writes; a mismatch is returned as a recoverable field conflict.
