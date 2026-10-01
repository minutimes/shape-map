import { historyEntryForOperation, deletionHistoryEntry } from './history.js';
import { absoluteShapePosition } from './shapeLayout.js';

const clone = (value) => structuredClone(value);
const fresh = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '_')}`;

export function shapeHistoryEntry(operation, snapshot) {
  const op = clone(operation); delete op.expectedFingerprint;
  const node = snapshot.graph.nodes.find((item) => item.id === op.id);
  if (op.type === 'deleteSubtrees') return deletionHistoryEntry(snapshot, op.ids);
  let undo;
  if (op.type === 'setBlock' && node) undo = { type: 'setBlock', id: node.id, ...(op.label !== undefined ? { label: node.label } : {}),
    block: Object.fromEntries(Object.keys(op.block || {}).map((key) => [key, node.block?.[key] ?? (key === 'files' ? [] : key === 'status' ? 'neutral' : '')])) };
  if (op.type === 'setProposal' && node) undo = { type: 'setProposal', id: node.id, proposal: node.proposal ? clone(node.proposal) : null };
  if (op.type === 'resolveComment' && node) {
    const comment = node.block?.comments?.find((item) => item.id === op.commentId);
    if (comment) undo = { ...op, resolved: comment.resolved };
  }
  if (op.type === 'upsertLink') {
    const before = snapshot.graph.links?.find((link) => link.id === op.link.id);
    undo = before ? { type: 'upsertLink', link: clone(before) } : { type: 'removeLink', id: op.link.id };
  }
  if (op.type === 'removeLink') { const link = snapshot.graph.links?.find((item) => item.id === op.id); if (link) undo = { type: 'upsertLink', link: clone(link) }; }
  if (op.type === 'setMapLenses') undo = { type: 'setMapLenses', lenses: snapshot.graph.lenses ? clone(snapshot.graph.lenses) : null };
  if (op.type === 'restoreNodes') undo = { type: 'deleteSubtrees', ids: op.nodes.map((item) => item.id) };
  return undo ? { label: op.type, undo, redo: op } : historyEntryForOperation(op, snapshot);
}

export function branchClipboard(graph, ids) {
  const selected = new Set(ids.filter((id) => graph.nodes.find((node) => node.id === id)?.parentId));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const roots = [...selected].filter((id) => { let parent = byId.get(id)?.parentId; while (parent) { if (selected.has(parent)) return false; parent = byId.get(parent)?.parentId; } return true; });
  const included = new Set(roots); let changed = true;
  while (changed) { changed = false; graph.nodes.forEach((node) => { if (included.has(node.parentId) && !included.has(node.id)) { included.add(node.id); changed = true; } }); }
  return { kind: 'shape-map-clipboard', version: 1, roots, nodes: clone(graph.nodes.filter((node) => included.has(node.id))),
    links: clone((graph.links || []).filter((link) => included.has(link.source) && included.has(link.target))),
    lenses: clone((graph.lenses || []).map((lens) => ({ ...lens, options: lens.options.map((option) => ({ ...option,
      ...Object.fromEntries(['roots', 'exclude', 'custom', 'pending'].filter((field) => option[field]).map((field) => [field, option[field].filter((id) => included.has(id))])),
    })) }))) };
}

export function pasteBranch(graph, payload, parentId) {
  if (payload?.kind !== 'shape-map-clipboard' || payload.version !== 1 || !Array.isArray(payload.nodes) || !payload.nodes.length || !Array.isArray(payload.roots)) return null;
  const ids = new Map(payload.nodes.map((node) => [node.id, fresh('block')]));
  const categories = new Set(graph.categories.map((category) => category.id));
  const parent = graph.nodes.find((node) => node.id === parentId); if (!parent) return null;
  const nodes = payload.nodes.map((node) => {
    const copied = clone(node); copied.id = ids.get(node.id); copied.parentId = payload.roots.includes(node.id) ? parentId : ids.get(node.parentId);
    copied.category = categories.has(node.category) ? node.category : parent.category;
    if (payload.roots.includes(node.id)) copied.label = `${node.label} 복사`;
    if (copied.block) { delete copied.block.review; if (copied.block.status === 'verified') copied.block.status = 'neutral'; }
    return copied;
  });
  const links = (payload.links || []).map((link) => ({ ...link, id: fresh('link'), source: ids.get(link.source), target: ids.get(link.target) }));
  const lenses = (graph.lenses || []).map((lens) => ({ ...lens, options: lens.options.map((option) => {
    const copied = payload.lenses?.find((item) => item.id === lens.id)?.options.find((item) => item.id === option.id);
    return { ...option, ...Object.fromEntries(['roots', 'exclude', 'custom', 'pending'].filter((field) => copied?.[field]?.some((id) => ids.has(id))).map((field) => [field, [...new Set([...(option[field] || []), ...copied[field].filter((id) => ids.has(id)).map((id) => ids.get(id))])]])) };
  }) }));
  return { type: 'restoreNodes', nodes, order: [...graph.nodes.map((node) => node.id), ...nodes.map((node) => node.id)], ...(links.length ? { links } : {}), ...(lenses.length ? { lenses } : {}) };
}

/** Prefer the smallest containing section; descendants can never become parents. */
export function shapeDropTarget(graph, nodes, draggedId, point) {
  const excluded = new Set([draggedId]); let changed = true;
  while (changed) { changed = false; graph.nodes.forEach((node) => { if (excluded.has(node.parentId) && !excluded.has(node.id)) { excluded.add(node.id); changed = true; } }); }
  return nodes.filter((node) => node.type === 'shapeGroup' && !excluded.has(node.id)).map((node) => {
    const position = absoluteShapePosition(nodes, node.id);
    return { node, position, area: node.style.width * node.style.height };
  }).filter(({ node, position }) => point.x >= position.x && point.x <= position.x + node.style.width && point.y >= position.y && point.y <= position.y + node.style.height)
    .sort((a, b) => a.area - b.area)[0]?.node || null;
}

export function assignLensOption(lenses, lensId, optionId, nodeId, enabled) {
  return lenses.map((lens) => lens.id !== lensId ? lens : { ...lens, options: lens.options.map((option) => option.id !== optionId ? option : {
    ...option, roots: enabled ? [...new Set([...option.roots, nodeId])] : option.roots.filter((id) => id !== nodeId),
    ...(option.exclude?.includes(nodeId) && enabled ? { exclude: option.exclude.filter((id) => id !== nodeId) } : {}),
  }) });
}

export function connectionPort(handle) {
  if (handle?.includes('top')) return 'top'; if (handle?.includes('bottom')) return 'bottom';
  return handle === 'in' || handle?.includes('left') ? 'left' : 'right';
}

/** A drop retains its horizontal location and clears sibling cards vertically. */
export function settleShapePosition(nodes, id, position, parentId) {
  const moving = nodes.find((node) => node.id === id); if (!moving) return position;
  const origin = parentId ? absoluteShapePosition(nodes, parentId) : { x: 0, y: 0 };
  const obstacles = nodes.filter((node) => node.id !== id && (node.parentId || null) === (parentId || null)).map((node) => {
    const absolute = absoluteShapePosition(nodes, node.id);
    return { x: absolute.x - origin.x, y: absolute.y - origin.y, width: node.style.width, height: node.style.height };
  });
  const result = { ...position }; const gap = 12;
  for (let step = 0; step <= obstacles.length; step++) {
    const collisions = obstacles.filter((rect) => result.x < rect.x + rect.width + gap && result.x + moving.style.width + gap > rect.x && result.y < rect.y + rect.height + gap && result.y + moving.style.height + gap > rect.y);
    if (!collisions.length) break;
    result.y = Math.max(...collisions.map((rect) => rect.y + rect.height + gap));
  }
  return result;
}
