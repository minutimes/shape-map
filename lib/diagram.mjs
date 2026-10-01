import { validationError } from './errors.mjs';

const identifier = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const LINK_KINDS = new Set(['flow', 'data', 'dependency', 'activation']);
const assert = (value, message) => { if (!value) throw validationError(message); };
function object(value, keys, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object.`);
  Object.keys(value).forEach((key) => assert(keys.includes(key), `Unsupported ${name} field: ${key}`));
}
function id(value, name) { assert(typeof value === 'string' && identifier.test(value), `Invalid ${name}.`); return value; }
function text(value, name, limit = 4000) {
  assert(typeof value === 'string' && value.trim() && value.length <= limit, `${name} must contain 1-${limit} characters.`);
  return value.trim();
}
function ids(value, name) {
  assert(Array.isArray(value) && value.length <= 2000, `${name} must be an array of at most 2000 IDs.`);
  const result = value.map((entry) => id(entry, name));
  assert(new Set(result).size === result.length, `${name} contains duplicate IDs.`);
  return result;
}

export function normalizeLink(link) {
  object(link, ['id', 'source', 'target', 'label', 'kind', 'condition', 'sourcePort', 'targetPort'], 'feature link');
  const result = { id: id(link.id, 'link ID'), source: id(link.source, 'link source'),
    target: id(link.target, 'link target'), kind: link.kind, label: text(link.label, 'link label', 180) };
  assert(result.source !== result.target, 'A feature link cannot connect a node to itself.');
  assert(LINK_KINDS.has(result.kind), `Invalid feature link kind: ${result.kind}`);
  if (link.condition !== undefined) result.condition = text(link.condition, 'link condition');
  for (const field of ['sourcePort', 'targetPort']) if (link[field] !== undefined) {
    assert(['left', 'right', 'top', 'bottom'].includes(link[field]), `Invalid link ${field}.`); result[field] = link[field];
  }
  return result;
}

export function normalizeLinks(links) {
  assert(Array.isArray(links) && links.length <= 4000, 'Feature links must contain at most 4000 items.');
  const result = links.map(normalizeLink);
  assert(new Set(result.map((link) => link.id)).size === result.length, 'Duplicate feature link ID.');
  return result;
}

export function normalizeLens(lens) {
  object(lens, ['id', 'label', 'group', 'options'], 'reading lens');
  assert(Array.isArray(lens.options) && lens.options.length > 0 && lens.options.length <= 32, 'A reading lens needs 1-32 options.');
  const options = lens.options.map((option) => {
    object(option, ['id', 'label', 'description', 'roots', 'exclude', 'custom', 'pending'], 'lens option');
    const result = { id: id(option.id, 'option ID'), label: text(option.label, 'option label', 180), roots: ids(option.roots, 'option roots') };
    if (option.description !== undefined) result.description = text(option.description, 'option description');
    for (const field of ['exclude', 'custom', 'pending']) if (option[field] !== undefined) result[field] = ids(option[field], `option ${field}`);
    return result;
  });
  assert(new Set(options.map((option) => option.id)).size === options.length, 'Duplicate lens option ID.');
  return { id: id(lens.id, 'lens ID'), label: text(lens.label, 'lens label', 180), ...(lens.group !== undefined ? { group: text(lens.group, 'lens group', 180) } : {}), options };
}

export function normalizeLenses(lenses) {
  assert(Array.isArray(lenses) && lenses.length <= 20, 'Reading lenses must contain at most 20 items.');
  const result = lenses.map(normalizeLens);
  assert(new Set(result.map((lens) => lens.id)).size === result.length, 'Duplicate reading lens ID.');
  return result;
}

export function validateDiagram(graph) {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  if (graph.links !== undefined) {
    graph.links = normalizeLinks(graph.links);
    for (const link of graph.links) assert(nodeIds.has(link.source) && nodeIds.has(link.target), `Link ${link.id} references a missing feature.`);
    if (!graph.links.length) delete graph.links;
  }
  if (graph.lenses !== undefined) {
    graph.lenses = normalizeLenses(graph.lenses);
    for (const lens of graph.lenses) for (const option of lens.options) for (const key of ['roots', 'exclude', 'custom', 'pending'])
      for (const nodeId of option[key] || []) assert(nodeIds.has(nodeId), `Lens ${lens.id}/${option.id} references missing feature ${nodeId}.`);
    if (!graph.lenses.length) delete graph.lenses;
  }
  return graph;
}

export function pruneDiagram(graph) {
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (graph.links) graph.links = graph.links.filter((link) => ids.has(link.source) && ids.has(link.target));
  if (graph.lenses) graph.lenses = graph.lenses.map((lens) => ({ ...lens, options: lens.options.map((option) => ({ ...option,
    ...Object.fromEntries(['roots', 'exclude', 'custom', 'pending'].filter((key) => option[key]).map((key) => [key, option[key].filter((id) => ids.has(id))])) })) }));
}

/** Undo restores only references removed with these nodes, retaining newer edits. */
export function restoreDiagram(graph, links, lenses, restoredIds) {
  if (links !== undefined) {
    const saved = normalizeLinks(links);
    const merged = new Map((graph.links || []).map((link) => [link.id, link]));
    for (const link of saved) if (!merged.has(link.id) && (restoredIds.has(link.source) || restoredIds.has(link.target))) merged.set(link.id, link);
    const savedIds = new Set(saved.map((link) => link.id));
    graph.links = [...saved.map((link) => merged.get(link.id)).filter(Boolean), ...[...merged.values()].filter((link) => !savedIds.has(link.id))];
  }
  if (lenses !== undefined) {
    const saved = new Map(normalizeLenses(lenses).map((lens) => [lens.id, lens]));
    graph.lenses = (graph.lenses || []).map((lens) => ({ ...lens, options: lens.options.map((option) => {
      const before = saved.get(lens.id)?.options.find((item) => item.id === option.id);
      if (!before) return option;
      const result = { ...option };
      for (const key of ['roots', 'exclude', 'custom', 'pending']) {
        const missing = (before[key] || []).filter((id) => restoredIds.has(id));
        if (!missing.length) continue;
        const merged = new Set([...(option[key] || []), ...missing]);
        result[key] = [...(before[key] || []).filter((id) => merged.has(id)), ...(option[key] || []).filter((id) => !before[key].includes(id))];
      }
      return result;
    }) }));
  }
}

/** Optional reading conditions highlight saved design; they never change runtime configuration. */
export function readingStates(graph, selections = {}) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const ancestors = (node) => {
    const path = []; let current = node;
    while (current) { path.push(current.id); current = byId.get(current.parentId); }
    return path;
  };
  const selected = (graph.lenses || []).map((lens) => lens.options.find((option) => option.id === selections[lens.id])).filter(Boolean);
  const states = Object.fromEntries(graph.nodes.map((node) => {
    const path = ancestors(node);
    const matches = (roots) => (roots || []).some((id) => path.includes(id));
    return [node.id, { active: selected.every((option) => matches(option.roots) && !matches(option.exclude)),
      custom: selected.some((option) => matches(option.custom)), pending: selected.some((option) => matches(option.pending)) }];
  }));
  // A container remains readable when one of its contained features is relevant.
  graph.nodes.forEach((node) => { if (states[node.id].active) ancestors(node).forEach((id) => { states[id].active = true; }); });
  return states;
}
