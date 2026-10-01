import { validationError } from './errors.mjs';

export const placementReferences = (anchor) => [anchor?.x?.id, ...(anchor?.y?.ids || [])].filter(Boolean);

/** Spatial references stay in the view and may only refer to sibling cards. */
export function normalizePlacementAnchors(input, graph, strict = false) {
  const fail = (message) => { if (strict) throw validationError(message); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) { fail('shape.anchors must be an object.'); return {}; }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node])); const result = {};
  for (const [id, value] of Object.entries(input)) {
    const node = nodes.get(id);
    if (!node || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['x', 'y'].includes(key))) { fail(`Invalid placement anchor: ${id}`); continue; }
    const anchor = {};
    for (const axis of ['x', 'y']) {
      const part = value[axis]; if (part === undefined) continue;
      const refs = axis === 'x' ? [part?.id] : part?.ids;
      const allowed = axis === 'x' ? ['id', 'edge', 'offset'] : ['ids', 'edge', 'offset'];
      if (!part || typeof part !== 'object' || Array.isArray(part) || Object.keys(part).some((key) => !allowed.includes(key))
        || !Array.isArray(refs) || !refs.length || new Set(refs).size !== refs.length || !Number.isFinite(part.offset)
        || !(axis === 'x' ? ['left', 'right'] : ['top', 'bottom']).includes(part.edge)
        || refs.some((ref) => ref === id || !nodes.has(ref) || nodes.get(ref).parentId !== node.parentId)) {
        fail(`Invalid ${axis} placement anchor: ${id}`); continue;
      }
      anchor[axis] = axis === 'x' ? { id: part.id, edge: part.edge, offset: part.offset } : { ids: [...refs], edge: part.edge, offset: part.offset };
    }
    if (Object.keys(anchor).length) result[id] = anchor;
  }
  const reaches = (id, target, seen = new Set()) => {
    if (seen.has(id)) return false; seen.add(id);
    return placementReferences(result[id]).some((ref) => ref === target || reaches(ref, target, seen));
  };
  for (const id of Object.keys(result)) if (reaches(id, id)) { fail('Placement anchors cannot contain a cycle.'); delete result[id]; }
  return result;
}
