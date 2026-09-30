import { validationError } from './errors.mjs';
import { sha256Hex } from './sha256.mjs';

export const BLOCK_STATUSES = new Set(['neutral', 'planned', 'verified', 'concern']);
export const COMMENT_KINDS = new Set(['note', 'concern', 'change']);
const BLOCK_KEYS = new Set(['summary', 'files', 'status', 'review', 'comments']);
const COMMENT_KEYS = new Set(['id', 'body', 'kind', 'author', 'createdAt', 'resolved']);
const REVIEW_KEYS = new Set(['at', 'fingerprint']);
const TURN_KEYS = new Set(['id', 'number', 'title', 'summary', 'createdAt', 'revision', 'nodes', 'categories', 'settings']);
const MAX_TEXT = 4_000;
const MAX_FILES = 100;
const MAX_COMMENTS = 1_000;
const MAX_TURNS = 100;

function assert(condition, message) {
  if (!condition) throw validationError(message);
}

function plain(value, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object.`);
}

function known(value, allowed, name) {
  for (const key of Object.keys(value)) assert(allowed.has(key), `Unsupported ${name} field: ${key}`);
}

function text(value, name, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  assert(typeof value === 'string' && value.trim(), `${name} must be a non-empty string.`);
  const normalized = value.trim();
  assert(normalized.length <= MAX_TEXT, `${name} must be at most ${MAX_TEXT} characters.`);
  return normalized;
}

function timestamp(value, name) {
  assert(typeof value === 'string' && Number.isFinite(Date.parse(value)), `${name} must be an ISO date string.`);
  return new Date(value).toISOString();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function semanticNode(node) {
  const { block, ...semantic } = node;
  return {
    ...structuredClone(semantic),
    ...(block?.summary !== undefined || block?.files !== undefined
      ? { block: {
        ...(block.summary !== undefined ? { summary: block.summary } : {}),
        ...(block.files !== undefined ? { files: structuredClone(block.files) } : {}),
      } } : {}),
  };
}

export function nodeFingerprint(node, graph) {
  const value = graph
    ? { node: semanticNode(node), childIds: graph.nodes.filter((candidate) => candidate.parentId === node.id).map(({ id }) => id) }
    : semanticNode(node);
  return sha256Hex(JSON.stringify(stable(value)));
}

export function normalizeComment(comment) {
  plain(comment, 'Block comment');
  known(comment, COMMENT_KEYS, 'block comment');
  const normalized = {
    id: text(comment.id, 'Block comment id'),
    body: text(comment.body, 'Block comment body'),
    kind: comment.kind,
    author: text(comment.author, 'Block comment author'),
    createdAt: timestamp(comment.createdAt, 'Block comment createdAt'),
  };
  assert(COMMENT_KINDS.has(normalized.kind), `Invalid block comment kind: ${normalized.kind ?? ''}`);
  if (comment.resolved !== undefined) {
    assert(typeof comment.resolved === 'boolean', 'Block comment resolved must be a boolean.');
    normalized.resolved = comment.resolved;
  }
  return normalized;
}

export function normalizeBlock(block) {
  plain(block, 'Node block');
  known(block, BLOCK_KEYS, 'node block');
  const normalized = {};
  const summary = text(block.summary, 'Node block summary', { optional: true });
  if (summary !== undefined) normalized.summary = summary;
  if (block.files !== undefined) {
    assert(Array.isArray(block.files) && block.files.length <= MAX_FILES, `Node block files must contain at most ${MAX_FILES} paths.`);
    const seen = new Set();
    normalized.files = block.files.map((file) => {
      const path = text(file, 'Node block file');
      assert(!seen.has(path), `Duplicate node block file: ${path}`);
      seen.add(path);
      return path;
    });
  }
  if (block.status !== undefined) {
    assert(BLOCK_STATUSES.has(block.status), `Invalid node block status: ${block.status ?? ''}`);
    normalized.status = block.status;
  }
  if (block.review !== undefined) {
    plain(block.review, 'Node block review');
    known(block.review, REVIEW_KEYS, 'node block review');
    normalized.review = {
      at: timestamp(block.review.at, 'Node block review at'),
      fingerprint: text(block.review.fingerprint, 'Node block review fingerprint'),
    };
  }
  if (block.comments !== undefined) {
    assert(Array.isArray(block.comments) && block.comments.length <= MAX_COMMENTS,
      `Node block comments must contain at most ${MAX_COMMENTS} items.`);
    const ids = new Set();
    normalized.comments = block.comments.map((comment) => {
      const item = normalizeComment(comment);
      assert(!ids.has(item.id), `Duplicate block comment ID: ${item.id}`);
      ids.add(item.id);
      return item;
    });
  }
  return normalized;
}

function normalizeTurnNode(node, turnId) {
  plain(node, `Turn ${turnId} node`);
  const allowed = new Set(['id', 'label', 'parentId', 'shape', 'category', 'layout', 'section', 'task', 'proposal', 'workflow', 'block']);
  known(node, allowed, `turn ${turnId} node`);
  assert(typeof node.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(node.id), `Turn ${turnId} has invalid node ID.`);
  assert(typeof node.label === 'string' && node.label.trim(), `Turn ${turnId} node ${node.id} needs a label.`);
  return {
    ...structuredClone(node),
    ...(node.block !== undefined ? { block: normalizeBlock(node.block) } : {}),
  };
}

export function normalizeTurn(turn) {
  plain(turn, 'Shape turn');
  known(turn, TURN_KEYS, 'shape turn');
  const id = text(turn.id, 'Shape turn id');
  assert(Number.isInteger(turn.number) && turn.number > 0, 'Shape turn number must be a positive integer.');
  assert(Array.isArray(turn.nodes) && turn.nodes.length > 0, `Turn ${id} must contain nodes.`);
  assert(Array.isArray(turn.categories) && turn.categories.length > 0, `Turn ${id} must contain categories.`);
  const categoryKeys = new Set(['id', 'label', 'description', 'fill', 'stroke', 'textColor', 'strokeWidth']);
  for (const category of turn.categories) {
    plain(category, `Turn ${id} category`);
    known(category, categoryKeys, `turn ${id} category`);
  }
  const nodes = turn.nodes.map((node) => normalizeTurnNode(node, id));
  const ids = new Set();
  for (const node of nodes) {
    assert(!ids.has(node.id), `Turn ${id} has duplicate node ${node.id}.`);
    ids.add(node.id);
  }
  for (const node of nodes) {
    assert(node.parentId === null || ids.has(node.parentId), `Turn ${id} node ${node.id} has a missing parent.`);
  }
  const normalized = {
    id,
    number: turn.number,
    title: text(turn.title, 'Shape turn title'),
    createdAt: timestamp(turn.createdAt, 'Shape turn createdAt'),
    revision: text(turn.revision, 'Shape turn revision'),
    nodes,
    categories: structuredClone(turn.categories),
  };
  const summary = text(turn.summary, 'Shape turn summary', { optional: true });
  if (summary !== undefined) normalized.summary = summary;
  if (turn.settings !== undefined) normalized.settings = structuredClone(turn.settings);
  return normalized;
}

export function normalizeTurns(turns) {
  assert(Array.isArray(turns) && turns.length <= MAX_TURNS, `Shape turns must contain at most ${MAX_TURNS} items.`);
  const ids = new Set();
  const numbers = new Set();
  return turns.map((turn, index) => {
    const item = normalizeTurn(turn);
    assert(!ids.has(item.id), `Duplicate shape turn ID: ${item.id}`);
    assert(!numbers.has(item.number), `Duplicate shape turn number: ${item.number}`);
    ids.add(item.id);
    numbers.add(item.number);
    assert(item.number === index + 1, `Shape turn number must be ${index + 1} at position ${index + 1}.`);
    return item;
  });
}

export function captureTurn(graph, { id, title, summary, createdAt, revision }) {
  return normalizeTurn({
    id,
    number: Math.max(0, ...(graph.turns || []).map((turn) => turn.number)) + 1,
    title,
    ...(summary ? { summary } : {}),
    createdAt,
    revision,
    nodes: structuredClone(graph.nodes),
    categories: structuredClone(graph.categories),
    ...(graph.settings !== undefined ? { settings: structuredClone(graph.settings) } : {}),
  });
}

function comparableGraph(graph) {
  return {
    nodes: (graph.nodes || []).map(semanticNode),
    categories: structuredClone(graph.categories || []),
    ...(graph.settings !== undefined ? { settings: structuredClone(graph.settings) } : {}),
  };
}

export function compareTurnGraphs(before, after) {
  const beforeNodes = new Map((before.nodes || []).map((node) => [node.id, node]));
  const afterNodes = new Map((after.nodes || []).map((node) => [node.id, node]));
  const addedIds = [...afterNodes.keys()].filter((id) => !beforeNodes.has(id));
  const removedIds = [...beforeNodes.keys()].filter((id) => !afterNodes.has(id));
  const beforeCategories = new Map((before.categories || []).map((category) => [category.id, category]));
  const afterCategories = new Map((after.categories || []).map((category) => [category.id, category]));
  const changedCategories = new Set([...new Set([...beforeCategories.keys(), ...afterCategories.keys()])]
    .filter((id) => JSON.stringify(stable(beforeCategories.get(id))) !== JSON.stringify(stable(afterCategories.get(id)))));
  const changedIds = [...afterNodes.keys()].filter((id) => beforeNodes.has(id)
    && (nodeFingerprint(beforeNodes.get(id)) !== nodeFingerprint(afterNodes.get(id))
      || changedCategories.has(beforeNodes.get(id).category)
      || changedCategories.has(afterNodes.get(id).category)));
  return { addedIds, changedIds, removedIds };
}

export function getBlockState(graph, node, baselineGraph) {
  const block = node.block || {};
  const comments = block.comments || [];
  const unresolved = comments.filter((comment) => !comment.resolved);
  const validReview = block.review?.fingerprint === nodeFingerprint(node, graph);
  const turns = graph.turns || [];
  const latest = turns.at(-1)?.nodes?.find((candidate) => candidate.id === node.id);
  const baseline = baselineGraph?.nodes?.find((candidate) => candidate.id === node.id)
    || turns.at(-2)?.nodes?.find((candidate) => candidate.id === node.id);
  const currentMatchesLatest = latest !== undefined && nodeFingerprint(latest, { nodes: turns.at(-1).nodes }) === nodeFingerprint(node, graph);
  const changedSinceBaseline = baselineGraph
    ? Boolean(!baseline || nodeFingerprint(baseline, baselineGraph) !== nodeFingerprint(node, graph))
    : Boolean(turns.length >= 2 && latest && currentMatchesLatest
      && (!baseline || nodeFingerprint(baseline, { nodes: turns.at(-2).nodes }) !== nodeFingerprint(latest, { nodes: turns.at(-1).nodes })));
  let status = 'neutral';
  if (node.proposal !== undefined || block.status === 'planned') status = 'planned';
  else if (block.status === 'concern' || unresolved.some((comment) => comment.kind === 'concern')) status = 'concern';
  else if (block.status === 'verified' && validReview) status = 'verified';
  else if (changedSinceBaseline) status = 'changed';
  return {
    status,
    commentCount: comments.length,
    unresolvedCount: unresolved.length,
    concernCount: unresolved.filter((comment) => comment.kind === 'concern').length,
    hasProposal: node.proposal !== undefined,
    changedSinceBaseline,
  };
}

export function invalidateStaleReviews(graph) {
  for (const node of graph.nodes) {
    if (!node.block?.review || node.block.review.fingerprint === nodeFingerprint(node, graph)) continue;
    delete node.block.review;
    if (node.block.status === 'verified') node.block.status = 'neutral';
  }
  return graph;
}

export function graphWithoutTurns(graph) {
  return comparableGraph(graph);
}
