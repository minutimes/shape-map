import { MlcError, validationError } from './errors.mjs';
import {
  captureTurn, invalidateStaleReviews, nodeFingerprint, normalizeBlock, normalizeComment, normalizeTurns,
} from './shape.mjs';
import { normalizeLink, normalizeLinks, normalizeLenses, pruneDiagram, restoreDiagram, validateDiagram } from './diagram.mjs';

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
export const SHAPES = new Set(['rectangle', 'rounded']);
export const NODE_LAYOUT_MODES = new Set(['fit', 'wrap', 'fixed']);
export const NODE_MIN_WIDTH = 168;
export const NODE_MAX_WIDTH = 720;
export const NODE_MIN_HEIGHT = 72;
export const NODE_MAX_HEIGHT = 480;
export const TASK_EXECUTOR_KINDS = new Set(['code', 'perception', 'llm', 'jev', 'human']);
export const WORKFLOW_MODES = new Set(['group', 'sequence', 'parallel', 'conditional']);
export const OPTIONAL_MAP_FIELDS = new Set(['executor', 'model', 'effort', 'condition', 'workflow']);
export const TASK_TEXT_MAX_LENGTH = 4_000;
export const TASK_MODEL_MAX_LENGTH = 160;
export const TASK_EFFORT_MAX_LENGTH = 80;

function assert(condition, message) {
  if (!condition) throw validationError(message);
}

function assertPlainObject(value, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object.`);
}

function assertKnownKeys(value, allowed, name) {
  for (const key of Object.keys(value)) assert(allowed.has(key), `Unsupported ${name} field: ${key}`);
}

function optionalBoundedString(value, name, maxLength = TASK_TEXT_MAX_LENGTH) {
  if (value === undefined || value === null || value === '') return undefined;
  assert(typeof value === 'string', `${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  assert(normalized.length <= maxLength, `${name} must be at most ${maxLength} characters.`);
  return normalized;
}

export function normalizeNodeTask(task) {
  assertPlainObject(task, 'Node task');
  assertKnownKeys(task, new Set(['logic', 'inputs', 'outputs', 'ui', 'condition', 'executor']), 'node task');
  const normalized = {};
  for (const field of ['logic', 'inputs', 'outputs', 'ui', 'condition']) {
    const value = optionalBoundedString(task[field], `Node task ${field}`);
    if (value !== undefined) normalized[field] = value;
  }
  if (task.executor !== undefined && task.executor !== null) {
    assertPlainObject(task.executor, 'Node task executor');
    assertKnownKeys(task.executor, new Set(['kind', 'model', 'effort', 'language']), 'node task executor');
    assert(TASK_EXECUTOR_KINDS.has(task.executor.kind),
      `Invalid node task executor kind: ${task.executor.kind ?? ''}`);
    const executor = { kind: task.executor.kind };
    const model = optionalBoundedString(task.executor.model, 'Node task executor model', TASK_MODEL_MAX_LENGTH);
    const effort = optionalBoundedString(task.executor.effort, 'Node task executor effort', TASK_EFFORT_MAX_LENGTH);
    if (model !== undefined) executor.model = model;
    if (effort !== undefined) {
      assert(task.executor.kind === 'llm', 'Node task executor effort is supported only for llm executors.');
      executor.effort = effort;
    }
    assert(task.executor.language === undefined || task.executor.language === null
      || task.executor.language === '' || task.executor.language === 'en',
    'Node task executor language must be en.');
    if (task.executor.language === 'en' || task.executor.kind === 'jev') executor.language = 'en';
    normalized.executor = executor;
  }
  return normalized;
}

export function normalizeNodeProposal(proposal) {
  assertPlainObject(proposal, 'Node proposal');
  assertKnownKeys(proposal, new Set(['logic', 'inputs', 'outputs', 'ui', 'condition', 'executor', 'reason', 'purpose', 'successCriteria']), 'node proposal');
  const { reason, purpose, successCriteria, ...taskFields } = proposal;
  const normalized = normalizeNodeTask(taskFields);
  const normalizedReason = optionalBoundedString(reason, 'Node proposal reason');
  if (normalizedReason !== undefined) normalized.reason = normalizedReason;
  for (const [field, value] of Object.entries({ purpose, successCriteria })) {
    const result = optionalBoundedString(value, `Node proposal ${field}`);
    if (result !== undefined) normalized[field] = result;
  }
  return normalized;
}

export function normalizeNodeWorkflow(workflow) {
  assertPlainObject(workflow, 'Node workflow');
  assertKnownKeys(workflow, new Set(['mode']), 'node workflow');
  assert(WORKFLOW_MODES.has(workflow.mode), `Invalid node workflow mode: ${workflow.mode ?? ''}`);
  return { mode: workflow.mode };
}

export function normalizeMapSettings(settings) {
  assertPlainObject(settings, 'Map settings');
  assertKnownKeys(settings, new Set(['optionalFields']), 'map settings');
  assert(Array.isArray(settings.optionalFields), 'Map settings optionalFields must be an array.');
  const seen = new Set();
  const optionalFields = settings.optionalFields.map((field) => {
    assert(typeof field === 'string' && OPTIONAL_MAP_FIELDS.has(field),
      `Invalid map settings optional field: ${field ?? ''}`);
    assert(!seen.has(field), `Duplicate map settings optional field: ${field}`);
    seen.add(field);
    return field;
  });
  return { optionalFields };
}

export function normalizeNodeLayout(layout = { mode: 'fit' }) {
  assert(layout && typeof layout === 'object' && !Array.isArray(layout), 'Node layout must be an object.');
  assert(NODE_LAYOUT_MODES.has(layout.mode), `Invalid node layout mode: ${layout.mode ?? ''}`);
  if (layout.mode === 'fit') return { mode: 'fit' };
  assert(Number.isInteger(layout.width)
    && layout.width >= NODE_MIN_WIDTH
    && layout.width <= NODE_MAX_WIDTH,
  `Node layout width must be an integer from ${NODE_MIN_WIDTH} to ${NODE_MAX_WIDTH}.`);
  if (layout.mode === 'wrap') return { mode: 'wrap', width: layout.width };
  assert(Number.isInteger(layout.height)
    && layout.height >= NODE_MIN_HEIGHT
    && layout.height <= NODE_MAX_HEIGHT,
  `Node layout height must be an integer from ${NODE_MIN_HEIGHT} to ${NODE_MAX_HEIGHT}.`);
  return { mode: 'fixed', width: layout.width, height: layout.height };
}

export function validateCategory(category) {
  assert(category && typeof category === 'object', 'Category must be an object.');
  assert(ID_PATTERN.test(category.id || ''), `Invalid category ID: ${category.id ?? ''}`);
  for (const field of ['label', 'description']) {
    assert(typeof category[field] === 'string' && category[field].trim(), `Category ${category.id} needs ${field}.`);
    assert(!/[|\r\n]/.test(category[field]), `Category ${category.id} ${field} cannot contain | or a newline.`);
  }
  for (const field of ['fill', 'stroke', 'textColor']) {
    assert(COLOR_PATTERN.test(category[field] || ''), `Category ${category.id} has invalid ${field}.`);
  }
  assert(Number.isInteger(category.strokeWidth) && category.strokeWidth >= 0 && category.strokeWidth <= 20,
    `Category ${category.id} has invalid strokeWidth.`);
}

export function validateGraph(graph) {
  assert(graph?.direction === 'LR', 'Only flowchart LR is supported.');
  assert(Array.isArray(graph.nodes) && graph.nodes.length > 0, 'Graph must contain at least one node.');
  assert(Array.isArray(graph.categories) && graph.categories.length > 0, 'Graph must contain categories.');
  if (graph.settings !== undefined) graph.settings = normalizeMapSettings(graph.settings);
  if (graph.turns !== undefined) {
    graph.turns = normalizeTurns(graph.turns);
    for (const turn of graph.turns) {
      validateGraph({
        direction: 'LR', nodes: turn.nodes, categories: turn.categories,
        ...(turn.settings !== undefined ? { settings: turn.settings } : {}),
        ...(turn.links !== undefined ? { links: turn.links } : {}),
        ...(turn.lenses !== undefined ? { lenses: turn.lenses } : {}),
      });
    }
  }

  const categories = new Map();
  for (const category of graph.categories) {
    validateCategory(category);
    assert(!categories.has(category.id), `Duplicate category ID: ${category.id}`);
    categories.set(category.id, category);
  }

  const nodes = new Map();
  for (const node of graph.nodes) {
    assert(ID_PATTERN.test(node?.id || ''), `Invalid node ID: ${node?.id ?? ''}`);
    assert(!nodes.has(node.id), `Duplicate node ID: ${node.id}`);
    assert(typeof node.label === 'string' && node.label.trim(), `Node ${node.id} needs a label.`);
    assert(SHAPES.has(node.shape), `Node ${node.id} has invalid shape.`);
    assert(categories.has(node.category), `Node ${node.id} uses missing category ${node.category}.`);
    assert(node.parentId === null || ID_PATTERN.test(node.parentId || ''), `Node ${node.id} has invalid parentId.`);
    node.layout = normalizeNodeLayout(node.layout);
    if (node.task !== undefined) node.task = normalizeNodeTask(node.task);
    if (node.proposal !== undefined) node.proposal = normalizeNodeProposal(node.proposal);
    if (node.workflow !== undefined) node.workflow = normalizeNodeWorkflow(node.workflow);
    if (node.block !== undefined) node.block = normalizeBlock(node.block);
    assert(node.section === undefined || node.section === 'reference',
      `Node ${node.id} has invalid section: ${node.section ?? ''}`);
    nodes.set(node.id, node);
  }

  const roots = graph.nodes.filter((node) => node.parentId === null);
  assert(roots.length === 1, `Graph must have exactly one root; found ${roots.length}.`);
  assert(roots[0].section === undefined, 'The root node cannot be a reference section.');
  for (const node of graph.nodes) {
    if (node.parentId !== null) assert(nodes.has(node.parentId), `Node ${node.id} has missing parent ${node.parentId}.`);
  }

  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) throw validationError(`Cycle detected at node ${id}.`);
    if (state.get(id) === 2) return;
    state.set(id, 1);
    const parentId = nodes.get(id).parentId;
    if (parentId !== null) visit(parentId);
    state.set(id, 2);
  };
  for (const id of nodes.keys()) visit(id);
  return validateDiagram(graph);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw validationError(`${name} must be a non-empty string.`);
  return value;
}

function cloneGraph(graph) {
  return {
    direction: graph.direction,
    ...(graph.settings !== undefined ? { settings: structuredClone(graph.settings) } : {}),
    ...(graph.turns !== undefined ? { turns: structuredClone(graph.turns) } : {}),
    ...(graph.links !== undefined ? { links: structuredClone(graph.links) } : {}),
    ...(graph.lenses !== undefined ? { lenses: structuredClone(graph.lenses) } : {}),
    nodes: graph.nodes.map((node) => ({
      ...node,
      layout: { ...(node.layout || { mode: 'fit' }) },
      ...(node.task !== undefined ? { task: structuredClone(node.task) } : {}),
      ...(node.proposal !== undefined ? { proposal: structuredClone(node.proposal) } : {}),
      ...(node.workflow !== undefined ? { workflow: { ...node.workflow } } : {}),
      ...(node.block !== undefined ? { block: structuredClone(node.block) } : {}),
    })),
    categories: graph.categories.map((c) => ({ ...c })),
  };
}

const PATCH_CONTENT_PATHS = new Set([
  'label',
  'section',
  'task.logic', 'task.inputs', 'task.outputs', 'task.ui', 'task.condition', 'task.executor',
  'proposal', 'proposal.logic', 'proposal.inputs', 'proposal.outputs', 'proposal.ui',
  'proposal.condition', 'proposal.executor', 'proposal.reason', 'proposal.purpose', 'proposal.successCriteria',
  'workflow',
]);

function normalizedPatchValue(path, value, side) {
  if (value === undefined) throw validationError(`patchNodeContent ${side} is required for ${path}.`);
  if (path === 'label') {
    if (value === null) {
      if (side === 'after') throw validationError('label cannot be removed.');
      return null;
    }
    if (typeof value !== 'string' || !value.trim()) throw validationError('label must be a non-empty string.');
    return value;
  }
  if (path === 'section') {
    assert(value === null || value === 'reference', 'section must be null or reference.');
    return value;
  }
  if (path === 'proposal') return value === null ? null : normalizeNodeProposal(value);
  if (path === 'workflow') return value === null ? null : normalizeNodeWorkflow(value);
  if (path.endsWith('.executor')) {
    if (value === null) return null;
    const owner = path.startsWith('proposal.') ? normalizeNodeProposal({ executor: value }) : normalizeNodeTask({ executor: value });
    return owner.executor;
  }
  if (value === null || value === '') return null;
  const owner = path.startsWith('proposal.')
    ? normalizeNodeProposal({ [path.slice('proposal.'.length)]: value })
    : normalizeNodeTask({ [path.slice('task.'.length)]: value });
  return owner[path.split('.')[1]] ?? null;
}

function currentPatchValue(node, path) {
  if (path === 'label') return node.label;
  if (path === 'section') return node.section ?? null;
  if (path === 'proposal') return node.proposal === undefined ? null : structuredClone(node.proposal);
  if (path === 'workflow') return node.workflow === undefined ? null : { ...node.workflow };
  const [owner, field] = path.split('.');
  return node[owner]?.[field] === undefined ? null : structuredClone(node[owner][field]);
}

function samePatchValue(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => samePatchValue(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && samePatchValue(left[key], right[key]));
}

function applyPatchValue(node, path, value) {
  if (path === 'label') {
    node.label = value;
    return;
  }
  if (path === 'section') {
    if (value === null) delete node.section;
    else node.section = value;
    return;
  }
  if (path === 'proposal' || path === 'workflow') {
    if (value === null) delete node[path];
    else node[path] = structuredClone(value);
    return;
  }
  const [owner, field] = path.split('.');
  if (value === null) {
    if (node[owner] !== undefined) delete node[owner][field];
    return;
  }
  if (node[owner] === undefined) node[owner] = {};
  node[owner][field] = structuredClone(value);
}

function normalizeContentChanges(changes) {
  assert(Array.isArray(changes) && changes.length > 0, 'changes must contain at least one guarded field change.');
  const normalized = [];
  const paths = [];
  for (const change of changes) {
    assert(change && typeof change === 'object' && !Array.isArray(change), 'Each content change must be an object.');
    assertKnownKeys(change, new Set(['path', 'before', 'after']), 'content change');
    assert(typeof change.path === 'string' && PATCH_CONTENT_PATHS.has(change.path),
      `Unsupported content change path: ${change.path ?? ''}`);
    assert(Object.hasOwn(change, 'before'), `patchNodeContent before is required for ${change.path}.`);
    assert(Object.hasOwn(change, 'after'), `patchNodeContent after is required for ${change.path}.`);
    for (const existing of paths) {
      assert(existing !== change.path, `Duplicate content change path: ${change.path}`);
      assert(!(existing.startsWith(`${change.path}.`) || change.path.startsWith(`${existing}.`)),
        `Overlapping content change paths: ${existing} and ${change.path}`);
    }
    paths.push(change.path);
    normalized.push({
      path: change.path,
      before: normalizedPatchValue(change.path, change.before, 'before'),
      after: normalizedPatchValue(change.path, change.after, 'after'),
    });
  }
  return normalized;
}

function nextId(graph) {
  const used = new Set(graph.nodes.map(({ id }) => id));
  let index = 1;
  while (used.has(index === 1 ? 'node' : `node-${index}`)) index += 1;
  return index === 1 ? 'node' : `node-${index}`;
}

function applyCompleteNodeOrder(graph, order) {
  assert(Array.isArray(order) && order.length === graph.nodes.length,
    'order must list every node exactly once.');
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const orderedIds = new Set();
  for (const id of order) {
    assert(typeof id === 'string' && nodes.has(id), `order contains an unknown node: ${id ?? ''}`);
    assert(!orderedIds.has(id), `order contains a duplicate node: ${id}`);
    orderedIds.add(id);
  }
  graph.nodes = order.map((id) => nodes.get(id));
}

function appendIncomingSequenceChildren(graph, moves) {
  const incomingByParent = new Map();
  for (const move of moves) {
    if (move.previousParentId === move.parentId) continue;
    const parent = graph.nodes.find(({ id }) => id === move.parentId);
    if (parent?.workflow?.mode !== 'sequence') continue;
    incomingByParent.set(move.parentId, [...(incomingByParent.get(move.parentId) || []), move.node]);
  }
  for (const [parentId, incoming] of incomingByParent) {
    const incomingIds = new Set(incoming.map(({ id }) => id));
    const childIndexes = [];
    const existing = [];
    graph.nodes.forEach((node, index) => {
      if (node.parentId !== parentId) return;
      childIndexes.push(index);
      if (!incomingIds.has(node.id)) existing.push(node);
    });
    const ordered = [...existing, ...incoming];
    childIndexes.forEach((index, orderIndex) => { graph.nodes[index] = ordered[orderIndex]; });
  }
}

function assertExpectedNodeFingerprint(graph, nodes, operation) {
  if (operation.expectedFingerprint === undefined) return;
  assert(typeof operation.expectedFingerprint === 'string' && /^[0-9a-f]{64}$/.test(operation.expectedFingerprint),
    'expectedFingerprint must be a lowercase SHA-256 digest.');
  const node = nodes.get(operation.id);
  if (!node) throw validationError(`Node does not exist: ${operation.id}`);
  if (nodeFingerprint(node, graph) !== operation.expectedFingerprint) {
    throw new MlcError('field_conflict', 'Node changed since editing began.', {
      id: operation.id,
      currentNode: structuredClone(node),
    });
  }
}

export function applyOperation(current, operation) {
  if (!operation || typeof operation !== 'object') throw validationError('operation must be an object.');
  const graph = cloneGraph(current);
  const byId = () => new Map(graph.nodes.map((node) => [node.id, node]));
  let nodes = byId();

  switch (operation.type) {
    case 'setMapLinks': {
      if (operation.links === null) delete graph.links;
      else graph.links = normalizeLinks(operation.links);
      break;
    }
    case 'setMapLenses': {
      if (operation.lenses === null) delete graph.lenses;
      else graph.lenses = normalizeLenses(operation.lenses);
      break;
    }
    case 'upsertLink': {
      const link = normalizeLink(operation.link);
      const existing = (graph.links || []).findIndex((item) => item.id === link.id);
      if (existing < 0) graph.links = [...(graph.links || []), link];
      else graph.links[existing] = link;
      break;
    }
    case 'removeLink': {
      assert((graph.links || []).some((link) => link.id === operation.id), 'Feature link does not exist.');
      graph.links = graph.links.filter((link) => link.id !== operation.id);
      break;
    }
    case 'addNode': {
      const id = operation.id ?? nextId(graph);
      if (!ID_PATTERN.test(id)) throw validationError(`Invalid node ID: ${id}`);
      if (nodes.has(id)) throw validationError(`Node already exists: ${id}`);
      if (!nodes.has(operation.parentId)) throw validationError(`Parent does not exist: ${operation.parentId}`);
      if (operation.block !== undefined && operation.block !== null) {
        assert(operation.block && typeof operation.block === 'object' && !Array.isArray(operation.block),
          'addNode block must be an object.');
        const allowed = new Set(['summary', 'files', 'status']);
        for (const key of Object.keys(operation.block)) assert(allowed.has(key), `Unsupported addNode block field: ${key}`);
      }
      const added = {
        id,
        label: requiredString(operation.label, 'label'),
        parentId: operation.parentId,
        shape: operation.shape,
        category: operation.category,
        layout: normalizeNodeLayout(operation.layout),
        ...(operation.section !== undefined && operation.section !== null ? { section: operation.section } : {}),
        ...(operation.task !== undefined && operation.task !== null ? { task: normalizeNodeTask(operation.task) } : {}),
        ...(operation.proposal !== undefined && operation.proposal !== null
          ? { proposal: normalizeNodeProposal(operation.proposal) } : {}),
        ...(operation.workflow !== undefined && operation.workflow !== null
          ? { workflow: normalizeNodeWorkflow(operation.workflow) } : {}),
        ...(operation.block !== undefined && operation.block !== null
          ? { block: normalizeBlock(operation.block) } : {}),
      };
      graph.nodes.push(added);
      if (added.block?.status === 'verified') {
        added.block.review = { at: operation.at, fingerprint: nodeFingerprint(added, graph) };
      }
      break;
    }
    case 'renameNode': {
      assertExpectedNodeFingerprint(graph, nodes, operation);
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      node.label = requiredString(operation.label, 'label');
      break;
    }
    case 'moveNode': {
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      if (node.parentId === null) throw validationError('The root node cannot be moved.');
      if (!nodes.has(operation.parentId)) throw validationError(`Parent does not exist: ${operation.parentId}`);
      if (operation.id === operation.parentId) throw validationError('A node cannot be its own parent.');
      const previousParentId = node.parentId;
      node.parentId = operation.parentId;
      if (operation.order !== undefined) applyCompleteNodeOrder(graph, operation.order);
      else appendIncomingSequenceChildren(graph, [{ node, parentId: operation.parentId, previousParentId }]);
      break;
    }
    case 'moveNodes': {
      assert(Array.isArray(operation.items) && operation.items.length > 0,
        'items must contain at least one node move.');
      const seen = new Set();
      const moves = operation.items.map((item) => {
        assert(item && typeof item === 'object', 'Each node move item must be an object.');
        assert(typeof item.id === 'string' && ID_PATTERN.test(item.id), `Invalid node ID: ${item.id ?? ''}`);
        assert(!seen.has(item.id), `Duplicate node move ID: ${item.id}`);
        const node = nodes.get(item.id);
        assert(node, `Node does not exist: ${item.id}`);
        assert(node.parentId !== null, 'The root node cannot be moved.');
        assert(typeof item.parentId === 'string' && nodes.has(item.parentId),
          `Parent does not exist: ${item.parentId ?? ''}`);
        assert(item.id !== item.parentId, 'A node cannot be its own parent.');
        seen.add(item.id);
        return { node, parentId: item.parentId, previousParentId: node.parentId };
      });
      moves.forEach(({ node, parentId }) => { node.parentId = parentId; });
      if (operation.order !== undefined) applyCompleteNodeOrder(graph, operation.order);
      else appendIncomingSequenceChildren(graph, moves);
      break;
    }
    case 'setNodePresentation': {
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      node.shape = operation.shape;
      node.category = operation.category;
      break;
    }
    case 'setNodeLayouts': {
      assert(Array.isArray(operation.items) && operation.items.length > 0,
        'items must contain at least one node layout.');
      const seen = new Set();
      const normalized = operation.items.map((item) => {
        assert(item && typeof item === 'object', 'Each node layout item must be an object.');
        assert(typeof item.id === 'string' && ID_PATTERN.test(item.id), `Invalid node ID: ${item.id ?? ''}`);
        assert(!seen.has(item.id), `Duplicate node layout ID: ${item.id}`);
        assert(nodes.has(item.id), `Node does not exist: ${item.id}`);
        seen.add(item.id);
        return { id: item.id, layout: normalizeNodeLayout(item.layout) };
      });
      normalized.forEach(({ id, layout }) => { nodes.get(id).layout = layout; });
      break;
    }
    case 'setNodeTask': {
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      if (operation.task === null) delete node.task;
      else node.task = normalizeNodeTask(operation.task);
      break;
    }
    case 'setProposal': {
      assertExpectedNodeFingerprint(graph, nodes, operation);
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      if (operation.proposal === null) delete node.proposal;
      else node.proposal = normalizeNodeProposal(operation.proposal);
      break;
    }
    case 'applyProposal': {
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      assert(node.proposal !== undefined, `Node ${operation.id} has no proposal.`);
      const { reason: _reason, purpose: _purpose, successCriteria: _successCriteria, ...task } = node.proposal;
      node.task = normalizeNodeTask({ ...(node.task || {}), ...task });
      delete node.proposal;
      break;
    }
    case 'setBlock': {
      assertExpectedNodeFingerprint(graph, nodes, operation);
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      assert(operation.block && typeof operation.block === 'object' && !Array.isArray(operation.block),
        'setBlock block must be an object.');
      const allowed = new Set(['summary', 'files', 'status']);
      for (const key of Object.keys(operation.block)) {
        assert(allowed.has(key), `Unsupported setBlock field: ${key}`);
      }
      if (operation.label !== undefined) node.label = requiredString(operation.label, 'label');
      const merged = { ...(node.block || {}) };
      for (const field of ['summary', 'files', 'status']) {
        if (!Object.hasOwn(operation.block, field)) continue;
        if (operation.block[field] === null) delete merged[field];
        else merged[field] = operation.block[field];
      }
      node.block = normalizeBlock(merged);
      if (operation.block.status === 'verified') {
        node.block.review = { at: operation.at, fingerprint: nodeFingerprint(node, graph) };
      } else if (Object.hasOwn(operation.block, 'status')) {
        delete node.block.review;
      }
      break;
    }
    case 'addComment': {
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      const comment = normalizeComment({
        id: operation.commentId, body: operation.body, kind: operation.kind,
        author: operation.author, createdAt: operation.createdAt,
      });
      node.block = normalizeBlock({ ...(node.block || {}), comments: [...(node.block?.comments || []), comment] });
      break;
    }
    case 'resolveComment': {
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      const comments = node.block?.comments || [];
      const index = comments.findIndex(({ id }) => id === operation.commentId);
      assert(index !== -1, `Comment does not exist: ${operation.commentId}`);
      comments[index] = normalizeComment({ ...comments[index], resolved: operation.resolved ?? true });
      break;
    }
    case 'createTurn': {
      const turn = captureTurn(graph, {
        id: operation.turnId, title: operation.title, summary: operation.summary,
        createdAt: operation.createdAt, revision: operation.revision,
      });
      graph.turns = [...(graph.turns || []), turn];
      break;
    }
    case 'setNodeWorkflow': {
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      if (operation.workflow === null) delete node.workflow;
      else node.workflow = normalizeNodeWorkflow(operation.workflow);
      break;
    }
    case 'setMapSettings': {
      if (operation.settings === null) delete graph.settings;
      else graph.settings = normalizeMapSettings(operation.settings);
      break;
    }
    case 'patchNodeContent': {
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      const changes = normalizeContentChanges(operation.changes);
      const conflicts = changes.filter(({ path, before, after }) => {
        const currentValue = currentPatchValue(node, path);
        return !samePatchValue(currentValue, before) && !samePatchValue(currentValue, after);
      }).map(({ path }) => path);
      if (conflicts.length) {
        throw new MlcError('field_conflict', 'One or more node fields changed since editing began.', { fields: conflicts });
      }
      for (const { path, after } of changes) applyPatchValue(node, path, after);
      break;
    }
    case 'setChildOrder': {
      const parent = nodes.get(operation.id);
      if (!parent) throw validationError(`Node does not exist: ${operation.id}`);
      assert(Array.isArray(operation.childIds), 'childIds must be an array.');
      const childIndexes = [];
      const directChildIds = [];
      graph.nodes.forEach((node, index) => {
        if (node.parentId === parent.id) {
          childIndexes.push(index);
          directChildIds.push(node.id);
        }
      });
      assert(operation.childIds.length === directChildIds.length,
        'childIds must list every direct child exactly once.');
      const expected = new Set(directChildIds);
      const seen = new Set();
      for (const id of operation.childIds) {
        assert(typeof id === 'string' && expected.has(id), `childIds contains a non-child node: ${id ?? ''}`);
        assert(!seen.has(id), `childIds contains a duplicate node: ${id}`);
        seen.add(id);
      }
      const requested = operation.childIds.map((id) => nodes.get(id));
      childIndexes.forEach((index, orderIndex) => { graph.nodes[index] = requested[orderIndex]; });
      break;
    }
    case 'deleteLeaf': {
      const node = nodes.get(operation.id);
      if (!node) throw validationError(`Node does not exist: ${operation.id}`);
      if (node.parentId === null) throw validationError('The root node cannot be deleted.');
      if (graph.nodes.some((candidate) => candidate.parentId === node.id)) throw validationError(`Node ${node.id} is not a leaf.`);
      graph.nodes = graph.nodes.filter((candidate) => candidate.id !== node.id);
      pruneDiagram(graph);
      break;
    }
    case 'deleteSubtrees': {
      assert(Array.isArray(operation.ids) && operation.ids.length > 0, 'ids must contain at least one node ID.');
      const requested = new Set();
      for (const id of operation.ids) {
        assert(typeof id === 'string' && ID_PATTERN.test(id), `Invalid node ID: ${id ?? ''}`);
        const node = nodes.get(id);
        assert(node, `Node does not exist: ${id}`);
        assert(node.parentId !== null, 'The root node cannot be deleted.');
        requested.add(id);
      }
      const removed = new Set(requested);
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of graph.nodes) {
          if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) {
            removed.add(node.id);
            changed = true;
          }
        }
      }
      graph.nodes = graph.nodes.filter((node) => !removed.has(node.id));
      pruneDiagram(graph);
      break;
    }
    case 'restoreNodes': {
      assert(Array.isArray(operation.nodes) && operation.nodes.length > 0, 'nodes must contain at least one node.');
      const restored = [];
      const restoredIds = new Set();
      for (const candidate of operation.nodes) {
        assert(candidate && typeof candidate === 'object', 'Each restored node must be an object.');
        assert(typeof candidate.id === 'string' && ID_PATTERN.test(candidate.id), `Invalid node ID: ${candidate.id ?? ''}`);
        assert(!nodes.has(candidate.id) && !restoredIds.has(candidate.id), `Node already exists: ${candidate.id}`);
        restoredIds.add(candidate.id);
        restored.push({
          id: candidate.id,
          label: requiredString(candidate.label, 'label'),
          parentId: candidate.parentId,
          shape: candidate.shape,
          category: candidate.category,
          layout: normalizeNodeLayout(candidate.layout),
          ...(candidate.section !== undefined ? { section: candidate.section } : {}),
          ...(candidate.task !== undefined ? { task: normalizeNodeTask(candidate.task) } : {}),
          ...(candidate.proposal !== undefined ? { proposal: normalizeNodeProposal(candidate.proposal) } : {}),
          ...(candidate.workflow !== undefined ? { workflow: normalizeNodeWorkflow(candidate.workflow) } : {}),
          ...(candidate.block !== undefined ? { block: normalizeBlock(candidate.block) } : {}),
        });
      }
      graph.nodes.push(...restored);
      restoreDiagram(graph, operation.links, operation.lenses, restoredIds);
      applyCompleteNodeOrder(graph, operation.order);
      break;
    }
    case 'upsertCategory': {
      validateCategory(operation.category);
      const index = graph.categories.findIndex(({ id }) => id === operation.category.id);
      if (index === -1) graph.categories.push({ ...operation.category });
      else graph.categories[index] = { ...operation.category };
      break;
    }
    default:
      throw validationError(`Unsupported operation type: ${operation.type ?? ''}`);
  }
  return validateGraph(invalidateStaleReviews(graph));
}

export function getSubtree(graph, rootId, depth = 2) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 100) throw validationError('depth must be an integer from 0 to 100.');
  const root = graph.nodes.find(({ id }) => id === rootId);
  if (!root) throw validationError(`Node does not exist: ${rootId}`);
  const children = new Map();
  for (const node of graph.nodes) {
    if (node.parentId !== null) children.set(node.parentId, [...(children.get(node.parentId) || []), node]);
  }
  const build = (node, remaining) => ({
    id: node.id,
    label: node.label,
    shape: node.shape,
    category: node.category,
    layout: { ...node.layout },
    ...(node.section !== undefined ? { section: node.section } : {}),
    ...(node.task !== undefined ? { task: structuredClone(node.task) } : {}),
    ...(node.proposal !== undefined ? { proposal: structuredClone(node.proposal) } : {}),
    ...(node.workflow !== undefined ? { workflow: { ...node.workflow } } : {}),
    ...(node.block !== undefined ? { block: structuredClone(node.block) } : {}),
    ...(remaining > 0 ? { children: (children.get(node.id) || []).map((child) => build(child, remaining - 1)) } : {}),
  });
  return build(root, depth);
}
