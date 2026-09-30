import {
  normalizeMapSettings, normalizeNodeLayout, normalizeNodeProposal, normalizeNodeTask, normalizeNodeWorkflow,
  validateGraph,
} from './graph.mjs';
import { normalizeBlock, normalizeTurn } from './shape.mjs';
import { validationError } from './errors.mjs';

const JSON_STRING = '"(?:\\\\.|[^"\\\\])*"';
const NODE_RE = new RegExp(`^([A-Za-z][A-Za-z0-9_-]*)\\s*(?:\\(\\[(${JSON_STRING})\\]\\)|(?!\\(\\[)\\[(${JSON_STRING})\\])$`);
const EDGE_RE = /^([A-Za-z][A-Za-z0-9_-]*)\s*-->\s*([A-Za-z][A-Za-z0-9_-]*)$/;
const CLASS_DEF_RE = /^classDef\s+([A-Za-z][A-Za-z0-9_-]*)\s+fill:(#[0-9A-Fa-f]{6}),stroke:(#[0-9A-Fa-f]{6}),color:(#[0-9A-Fa-f]{6}),stroke-width:(\d+)px$/;
const CLASS_RE = /^class\s+([A-Za-z][A-Za-z0-9_-]*(?:,[A-Za-z][A-Za-z0-9_-]*)*)\s+([A-Za-z][A-Za-z0-9_-]*)$/;
const LEGEND_RE = /^%%\s*mlc-legend:\s*([A-Za-z][A-Za-z0-9_-]*)\|([^|\r\n]+)\|([^|\r\n]+)$/;
const NODE_LAYOUT_RE = /^%%\s*mlc-node-layout:\s*([A-Za-z][A-Za-z0-9_-]*)\|(fit|wrap|fixed)(?:\|(\d+))?(?:\|(\d+))?$/;
const NODE_TASK_RE = /^%%\s*mlc-task:\s*([A-Za-z][A-Za-z0-9_-]*)\|([^\r\n]*)$/;
const NODE_PROPOSAL_RE = /^%%\s*mlc-proposal:\s*([A-Za-z][A-Za-z0-9_-]*)\|([^\r\n]*)$/;
const NODE_WORKFLOW_RE = /^%%\s*mlc-workflow:\s*([A-Za-z][A-Za-z0-9_-]*)\|([^\r\n]*)$/;
const NODE_SECTION_RE = /^%%\s*mlc-section:\s*([A-Za-z][A-Za-z0-9_-]*)\|(reference)$/;
const MAP_SETTINGS_RE = /^%%\s*mlc-settings:\s*([^\r\n]*)$/;
const NODE_BLOCK_RE = /^%%\s*sm-block:\s*([A-Za-z][A-Za-z0-9_-]*)\|([^\r\n]*)$/;
const TURN_RE = /^%%\s*sm-turn:\s*([^\r\n]*)$/;
const METADATA_JSON_MAX_BYTES = 65_536;
const TURN_JSON_MAX_BYTES = 1_048_576;
const SOURCE_MAX_BYTES = 16_777_216;

function parseMetadataJson(json, lineNumber, kind, normalize, maxBytes = METADATA_JSON_MAX_BYTES) {
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw validationError(`Line ${lineNumber}: ${kind} metadata exceeds ${maxBytes} bytes.`);
  }
  let parsed;
  try { parsed = JSON.parse(json); }
  catch { throw validationError(`Line ${lineNumber}: invalid ${kind} metadata JSON.`); }
  try { return normalize(parsed); }
  catch (error) { throw validationError(`Line ${lineNumber}: ${error.message}`); }
}

export function parseSource(source) {
  if (typeof source !== 'string') throw validationError('Source must be text.');
  if (Buffer.byteLength(source, 'utf8') > SOURCE_MAX_BYTES) {
    throw validationError(`Source exceeds ${SOURCE_MAX_BYTES} bytes.`);
  }
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let declarationCount = 0;
  let markerCount = 0;
  const declarations = new Map();
  const edges = [];
  const categoryDefs = new Map();
  const assignments = new Map();
  const legends = new Map();
  const nodeLayouts = new Map();
  const nodeTasks = new Map();
  const nodeProposals = new Map();
  const nodeWorkflows = new Map();
  const nodeSections = new Map();
  const nodeBlocks = new Map();
  const turns = [];
  let mapSettings;
  let mapSettingsLine;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line === 'flowchart LR') { declarationCount += 1; continue; }
    if (line === '%% mlc-format: 1') { markerCount += 1; continue; }

    let match = line.match(NODE_RE);
    if (match) {
      const [, id, roundedLabel, rectangleLabel] = match;
      if (declarations.has(id)) throw validationError(`Line ${index + 1}: duplicate node ${id}.`);
      let label;
      try { label = JSON.parse(roundedLabel || rectangleLabel); }
      catch { throw validationError(`Line ${index + 1}: invalid JSON-quoted label.`); }
      declarations.set(id, { id, label, shape: roundedLabel ? 'rounded' : 'rectangle' });
      continue;
    }
    match = line.match(EDGE_RE);
    if (match) { edges.push({ parentId: match[1], childId: match[2], line: index + 1 }); continue; }
    match = line.match(CLASS_DEF_RE);
    if (match) {
      const [, id, fill, stroke, textColor, width] = match;
      if (categoryDefs.has(id)) throw validationError(`Line ${index + 1}: duplicate classDef ${id}.`);
      categoryDefs.set(id, { id, fill, stroke, textColor, strokeWidth: Number(width) });
      continue;
    }
    match = line.match(CLASS_RE);
    if (match) {
      for (const id of match[1].split(',')) {
        if (assignments.has(id)) throw validationError(`Line ${index + 1}: node ${id} has multiple categories.`);
        assignments.set(id, match[2]);
      }
      continue;
    }
    match = line.match(LEGEND_RE);
    if (match) {
      const [, id, label, description] = match;
      if (legends.has(id)) throw validationError(`Line ${index + 1}: duplicate legend ${id}.`);
      legends.set(id, { label, description });
      continue;
    }
    match = line.match(NODE_LAYOUT_RE);
    if (match) {
      const [, id, mode, width, height] = match;
      if (nodeLayouts.has(id)) throw validationError(`Line ${index + 1}: duplicate node layout ${id}.`);
      const invalidFields = (mode === 'fit' && (width !== undefined || height !== undefined))
        || (mode === 'wrap' && (width === undefined || height !== undefined))
        || (mode === 'fixed' && (width === undefined || height === undefined));
      if (invalidFields) throw validationError(`Line ${index + 1}: invalid ${mode} node layout fields.`);
      const layout = mode === 'fit'
        ? { mode }
        : mode === 'wrap'
          ? { mode, width: Number(width) }
          : { mode, width: Number(width), height: Number(height) };
      try { nodeLayouts.set(id, normalizeNodeLayout(layout)); }
      catch (error) { throw validationError(`Line ${index + 1}: ${error.message}`); }
      continue;
    }
    match = line.match(NODE_TASK_RE);
    if (match) {
      const [, id, json] = match;
      if (nodeTasks.has(id)) throw validationError(`Line ${index + 1}: duplicate node task ${id}.`);
      nodeTasks.set(id, parseMetadataJson(json, index + 1, 'node task', normalizeNodeTask));
      continue;
    }
    match = line.match(NODE_PROPOSAL_RE);
    if (match) {
      const [, id, json] = match;
      if (nodeProposals.has(id)) throw validationError(`Line ${index + 1}: duplicate node proposal ${id}.`);
      nodeProposals.set(id, parseMetadataJson(json, index + 1, 'node proposal', normalizeNodeProposal));
      continue;
    }
    match = line.match(NODE_WORKFLOW_RE);
    if (match) {
      const [, id, json] = match;
      if (nodeWorkflows.has(id)) throw validationError(`Line ${index + 1}: duplicate node workflow ${id}.`);
      nodeWorkflows.set(id, parseMetadataJson(json, index + 1, 'node workflow', normalizeNodeWorkflow));
      continue;
    }
    match = line.match(NODE_SECTION_RE);
    if (match) {
      const [, id, section] = match;
      if (nodeSections.has(id)) throw validationError(`Line ${index + 1}: duplicate node section ${id}.`);
      nodeSections.set(id, section);
      continue;
    }
    match = line.match(MAP_SETTINGS_RE);
    if (match) {
      if (mapSettingsLine !== undefined) throw validationError(`Line ${index + 1}: duplicate map settings.`);
      mapSettingsLine = index + 1;
      mapSettings = parseMetadataJson(match[1], index + 1, 'map settings', normalizeMapSettings);
      continue;
    }
    match = line.match(NODE_BLOCK_RE);
    if (match) {
      const [, id, json] = match;
      if (nodeBlocks.has(id)) throw validationError(`Line ${index + 1}: duplicate node block ${id}.`);
      nodeBlocks.set(id, parseMetadataJson(json, index + 1, 'node block', normalizeBlock));
      continue;
    }
    match = line.match(TURN_RE);
    if (match) {
      turns.push(parseMetadataJson(match[1], index + 1, 'shape turn', normalizeTurn, TURN_JSON_MAX_BYTES));
      continue;
    }
    throw validationError(`Line ${index + 1}: unsupported statement: ${line}`);
  }

  if (declarationCount !== 1) throw validationError(`Expected exactly one flowchart LR declaration; found ${declarationCount}.`);
  if (markerCount !== 1) throw validationError(`Expected exactly one %% mlc-format: 1 marker; found ${markerCount}.`);

  const parents = new Map();
  for (const edge of edges) {
    if (!declarations.has(edge.parentId) || !declarations.has(edge.childId)) {
      throw validationError(`Line ${edge.line}: edge references an undeclared node.`);
    }
    if (parents.has(edge.childId)) throw validationError(`Line ${edge.line}: node ${edge.childId} has multiple parents.`);
    parents.set(edge.childId, edge.parentId);
  }
  for (const id of assignments.keys()) {
    if (!declarations.has(id)) throw validationError(`Class assignment references undeclared node ${id}.`);
  }
  for (const id of categoryDefs.keys()) {
    if (!legends.has(id)) throw validationError(`Category ${id} is missing its legend.`);
  }
  for (const id of legends.keys()) {
    if (!categoryDefs.has(id)) throw validationError(`Legend ${id} is missing its classDef.`);
  }
  for (const id of nodeLayouts.keys()) {
    if (!declarations.has(id)) throw validationError(`Node layout references undeclared node ${id}.`);
  }
  for (const id of nodeTasks.keys()) {
    if (!declarations.has(id)) throw validationError(`Node task references undeclared node ${id}.`);
  }
  for (const id of nodeProposals.keys()) {
    if (!declarations.has(id)) throw validationError(`Node proposal references undeclared node ${id}.`);
  }
  for (const id of nodeWorkflows.keys()) {
    if (!declarations.has(id)) throw validationError(`Node workflow references undeclared node ${id}.`);
  }
  for (const id of nodeSections.keys()) {
    if (!declarations.has(id)) throw validationError(`Node section references undeclared node ${id}.`);
  }
  for (const id of nodeBlocks.keys()) {
    if (!declarations.has(id)) throw validationError(`Node block references undeclared node ${id}.`);
  }

  const categories = [...categoryDefs.values()].map((category) => ({ ...category, ...legends.get(category.id) }));
  const nodes = [...declarations.values()].map((node) => ({
    ...node,
    parentId: parents.get(node.id) ?? null,
    category: assignments.get(node.id),
    layout: nodeLayouts.get(node.id) || { mode: 'fit' },
    ...(nodeTasks.has(node.id) ? { task: nodeTasks.get(node.id) } : {}),
    ...(nodeProposals.has(node.id) ? { proposal: nodeProposals.get(node.id) } : {}),
    ...(nodeWorkflows.has(node.id) ? { workflow: nodeWorkflows.get(node.id) } : {}),
    ...(nodeSections.has(node.id) ? { section: nodeSections.get(node.id) } : {}),
    ...(nodeBlocks.has(node.id) ? { block: nodeBlocks.get(node.id) } : {}),
  }));
  return validateGraph({
    direction: 'LR', nodes, categories,
    ...(mapSettings !== undefined ? { settings: mapSettings } : {}),
    ...(turns.length ? { turns } : {}),
  });
}

export function writeSource(graph) {
  validateGraph(graph);
  const lines = ['flowchart LR', '  %% mlc-format: 1'];
  if (graph.settings !== undefined) lines.push(`  %% mlc-settings: ${JSON.stringify(graph.settings)}`);
  for (const node of graph.nodes) {
    const label = JSON.stringify(node.label);
    lines.push(`  ${node.id}${node.shape === 'rounded' ? `([${label}])` : `[${label}]`}`);
  }
  lines.push('');
  for (const node of graph.nodes) if (node.parentId !== null) lines.push(`  ${node.parentId} --> ${node.id}`);
  lines.push('');
  for (const category of graph.categories) {
    lines.push(`  classDef ${category.id} fill:${category.fill},stroke:${category.stroke},color:${category.textColor},stroke-width:${category.strokeWidth}px`);
  }
  const idsByCategory = new Map(graph.categories.map(({ id }) => [id, []]));
  for (const node of graph.nodes) idsByCategory.get(node.category).push(node.id);
  for (const category of graph.categories) {
    const ids = idsByCategory.get(category.id);
    if (ids.length) lines.push(`  class ${ids.join(',')} ${category.id}`);
  }
  const customLayouts = graph.nodes.filter((node) => node.layout.mode !== 'fit');
  if (customLayouts.length) {
    lines.push('');
    for (const node of customLayouts) {
      const fields = [node.id, node.layout.mode, node.layout.width];
      if (node.layout.mode === 'fixed') fields.push(node.layout.height);
      lines.push(`  %% mlc-node-layout: ${fields.join('|')}`);
    }
  }
  const semanticMetadata = graph.nodes.filter((node) => (
    node.task !== undefined || node.proposal !== undefined || node.workflow !== undefined || node.section !== undefined
  ));
  if (semanticMetadata.length) {
    lines.push('');
    for (const node of semanticMetadata) {
      if (node.task !== undefined) lines.push(`  %% mlc-task: ${node.id}|${JSON.stringify(node.task)}`);
      if (node.proposal !== undefined) lines.push(`  %% mlc-proposal: ${node.id}|${JSON.stringify(node.proposal)}`);
      if (node.workflow !== undefined) lines.push(`  %% mlc-workflow: ${node.id}|${JSON.stringify(node.workflow)}`);
      if (node.section !== undefined) lines.push(`  %% mlc-section: ${node.id}|${node.section}`);
    }
  }
  const blockMetadata = graph.nodes.filter((node) => node.block !== undefined);
  if (blockMetadata.length) {
    lines.push('');
    for (const node of blockMetadata) lines.push(`  %% sm-block: ${node.id}|${JSON.stringify(node.block)}`);
  }
  if (graph.turns?.length) {
    lines.push('');
    for (const turn of graph.turns) lines.push(`  %% sm-turn: ${JSON.stringify(turn)}`);
  }
  lines.push('');
  for (const category of graph.categories) {
    lines.push(`  %% mlc-legend: ${category.id}|${category.label}|${category.description}`);
  }
  return `${lines.join('\n')}\n`;
}
