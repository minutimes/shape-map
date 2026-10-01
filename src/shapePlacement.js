import { placementReferences } from '../lib/placement.mjs';

/** Remember the row and column a person placed a card beside, rather than
 * freezing the temporary space occupied by an expanded branch. */
export function shapePlacementAnchor(nodes, id, position, parentId, anchors = {}) {
  const dependsOn = (candidate, seen = new Set()) => {
    if (candidate === id) return true; if (seen.has(candidate)) return false; seen.add(candidate);
    return placementReferences(anchors[candidate]).some((ref) => dependsOn(ref, seen));
  };
  let candidates = nodes.filter((node) => node.id !== id && (node.parentId || null) === (parentId || null) && !dependsOn(node.id));
  // A floating note between two section rows does not define the section grid.
  if (nodes.find((node) => node.id === id)?.type === 'shapeGroup' && candidates.some((node) => node.type === 'shapeGroup')) candidates = candidates.filter((node) => node.type === 'shapeGroup');
  const siblings = candidates
    .map((node) => ({ id: node.id, ...node.position, ...node.style }));
  const result = {}; const rowTolerance = 24;
  const sameRow = siblings.filter((rect) => Math.abs(rect.y - position.y) <= rowTolerance);
  const left = sameRow.filter((rect) => rect.x + rect.width <= position.x + 1).sort((a, b) => b.x + b.width - a.x - a.width)[0];
  const column = siblings.filter((rect) => rect.y < position.y - rowTolerance)
    .sort((a, b) => Math.abs(a.x - position.x) - Math.abs(b.x - position.x) || b.y - a.y)[0];
  // A section aligned under a column follows that column when the only row
  // neighbor is far away, rather than preserving a large incidental blank gap.
  const alignedColumn = column && Math.abs(column.x - position.x) <= 60 && left && position.x - left.x - left.width > 96;
  if (left && !alignedColumn) result.x = { id: left.id, edge: 'right', offset: position.x - left.x - left.width };
  else if (column) result.x = { id: column.id, edge: 'left', offset: position.x - column.x };
  if (sameRow.length) result.y = { ids: sameRow.map((rect) => rect.id), edge: 'top', offset: position.y - Math.max(...sameRow.map((rect) => rect.y)) };
  else {
    const above = siblings.filter((rect) => rect.y + rect.height <= position.y + 1).sort((a, b) => b.y - a.y);
    if (above.length) {
      const row = (parentId ? above : siblings).filter((rect) => Math.abs(rect.y - above[0].y) <= rowTolerance);
      result.y = { ids: row.map((rect) => rect.id), edge: 'bottom', offset: position.y - Math.max(...row.map((rect) => rect.y + rect.height)) };
    }
  }
  return Object.keys(result).length ? result : null;
}

/** Existing automatic coordinates become relative when a manual edit needs a
 * stable frame. Initial references point backwards in reading order. */
export function captureShapePlacements(nodes, anchors = {}) {
  const result = { ...anchors }; const earlier = [];
  for (const node of nodes) {
    if (!Object.hasOwn(result, node.id)) result[node.id] = shapePlacementAnchor([...earlier, node], node.id, node.position, node.parentId, result);
    earlier.push(node);
  }
  return result;
}

export function shapePlacementPatch(nodes, id, position, parentId, anchors = {}) {
  const result = captureShapePlacements(nodes, anchors);
  result[id] = shapePlacementAnchor(nodes, id, position, parentId, result);
  return result;
}
