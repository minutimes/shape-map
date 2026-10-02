// Pure helpers for cards placed by hand on the flow canvas. A placement is view
// state ({x, y} from the top-left corner of the card's lane band); only a move
// to another lane changes the map file, through `moveStep`.

export const EMPTY_PLACEMENTS = Object.freeze({});

/** Saved placements with unsaved local changes on top; `null` in `overlay` removes one. */
export function mergePlacements(saved, overlay) {
  if (!overlay || !Object.keys(overlay).length) return saved || EMPTY_PLACEMENTS;
  const result = { ...(saved || {}) };
  for (const [id, spot] of Object.entries(overlay)) {
    if (spot) result[id] = spot; else delete result[id];
  }
  return result;
}

export const sameSpot = (a, b) => (!a && !b) || Boolean(a && b && Math.abs(a.x - b.x) < .5 && Math.abs(a.y - b.y) < .5);

/** The placements a content edit removes, so undo can put them back with the steps. */
export function removedPlacements(beforeGraph, afterGraph, placements) {
  if (!placements || !beforeGraph || !afterGraph) return null;
  const remaining = new Set(afterGraph.steps.map((step) => step.id));
  const removed = Object.entries(placements).filter(([id]) => !remaining.has(id) && beforeGraph.steps.some((step) => step.id === id));
  if (!removed.length) return null;
  return { before: Object.fromEntries(removed), after: Object.fromEntries(removed.map(([id]) => [id, null])) };
}

/** Keeps the patch entries for steps that exist in `graph`. */
export function placementPatchFor(graph, patch) {
  const ids = new Set((graph?.steps || []).map((step) => step.id));
  return Object.fromEntries(Object.entries(patch || {}).filter(([id]) => ids.has(id)));
}

/**
 * Moves a step to another lane, in reading order: before the first step of
 * that lane that sits to the right of (or below, for a vertical flowchart) the
 * drop point. Arrows stay as they are.
 */
export function laneMoveOperation(graph, layout, stepId, laneId, at) {
  const step = graph.steps.find((item) => item.id === stepId);
  if (!step || (step.lane ?? null) === (laneId ?? null)) return null;
  const rows = layout.orientation !== 'columns';
  const position = new Map(layout.cards.map((card) => [card.id, rows ? card.x : card.y]));
  const members = graph.steps.filter((item) => item.id !== stepId && (item.lane ?? null) === (laneId ?? null));
  const operation = { type: 'moveStep', id: stepId, lane: laneId ?? null };
  const where = (item) => position.get(item.id) ?? Infinity;
  const sorted = [...members].sort((a, b) => where(a) - where(b));
  const next = sorted.find((item) => where(item) > at);
  if (next) operation.before = next.id;
  else if (sorted.length) operation.after = sorted.at(-1).id;
  return operation;
}
