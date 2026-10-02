import { validationError } from './errors.mjs';
import { COLOR_PATTERN, ID_PATTERN } from './graph.mjs';
import { MAP_HEADER_RE, normalizeMapHeader, textLength } from './mapHeader.mjs';
import { BLOCK_STATUSES, normalizeComment } from './shape.mjs';
import { flowStepFingerprint, invalidateStaleFlowReviews } from './flowState.mjs';

/*
 * Flow maps: user flows (유저 플로우) and system flows (시스템 플로우) share one
 * grammar of lanes, steps, and arrows between steps. The grammar and canonical
 * layout are defined in docs/FORMAT.md "Flow maps". Unsupported source is
 * rejected with its line number and is never rewritten.
 */

export const FLOW_KINDS = Object.freeze(['user-flow', 'system-flow']);
export const FLOW_LIMITS = Object.freeze({
  lanes: 50, steps: 2_000, arrows: 4_000, tags: 64, sourceBytes: 16_777_216,
  label: 200, laneTitle: 80, arrowLabel: 120, summary: 4_000,
  comments: 1_000, features: 50, turns: 100, turnTitle: 200, blockBytes: 1_048_576, turnBytes: 1_048_576,
});
export const FLOW_DIRECTIONS = Object.freeze(['LR', 'TB', 'TD']);
export const LANE_DIRECTIONS = Object.freeze(['LR', 'RL', 'TB', 'TD', 'BT']);
export const STEP_SHAPES = Object.freeze(['action', 'milestone', 'decision']);
export const ARROW_STYLES = Object.freeze(['next', 'alternative', 'exchange']);
const ARROW_TOKENS = { '-->': 'next', '-.->': 'alternative', '==>': 'exchange' };
const STYLE_TOKENS = { next: '-->', alternative: '-.->', exchange: '==>' };
const KEYWORDS = new Set(['end', 'graph', 'flowchart', 'subgraph', 'class', 'classdef', 'click', 'style', 'linkstyle', 'direction']);
const NOTE_HINT = 'write notes as a step description: %% sm-block: ID|{"summary":"..."}';

const ID = '[A-Za-z][A-Za-z0-9_-]*';
const JSON_STRING = '"(?:\\\\.|[^"\\\\])*"';
const ARROW = '(?:-->|-\\.->|==>)';
const DECLARATION_RE = /^flowchart\s+(LR|TB|TD)$/;
const LANE_DIRECTION_RE = /^direction\s+(LR|RL|TB|TD|BT)$/;
const SUBGRAPH_RE = new RegExp(`^subgraph\\s+(${ID})\\s*\\[(${JSON_STRING})\\]$`);
const STEP_RE = new RegExp(`^(${ID})\\s*(?:\\(\\[(${JSON_STRING})\\]\\)|(?!\\(\\[)\\[(${JSON_STRING})\\]|\\{(${JSON_STRING})\\})$`);
const CHAIN_RE = new RegExp(`^(${ID})((?:\\s*${ARROW}\\s*(?:\\|${JSON_STRING}\\|\\s*)?${ID})+)$`);
const SEGMENT_RE = new RegExp(`\\s*(${ARROW})\\s*(?:\\|(${JSON_STRING})\\|\\s*)?(${ID})(?=\\s*${ARROW}|$)`, 'y');
const CLASS_DEF_RE = /^classDef\s+([A-Za-z][A-Za-z0-9_-]*)\s+fill:(#[0-9A-Fa-f]{6}),stroke:(#[0-9A-Fa-f]{6}),color:(#[0-9A-Fa-f]{6}),stroke-width:(\d+)px(?:,stroke-dasharray:(\d+) (\d+))?$/;
const CLASS_RE = /^class\s+([A-Za-z][A-Za-z0-9_-]*(?:,[A-Za-z][A-Za-z0-9_-]*)*)\s+([A-Za-z][A-Za-z0-9_-]*)$/;
const LEGEND_RE = /^%%\s*mlc-legend:\s*([A-Za-z][A-Za-z0-9_-]*)\|([^|\r\n]+)\|([^|\r\n]+)$/;
const BLOCK_RE = /^%%\s*sm-block:\s*([A-Za-z][A-Za-z0-9_-]*)\|([^\r\n]*)$/;
const PROPOSAL_RE = /^%%\s*mlc-proposal:\s*([A-Za-z][A-Za-z0-9_-]*)\|([^\r\n]*)$/;
const TURN_RE = /^%%\s*sm-turn:\s*([^\r\n]*)$/;
const FEATURE_MAP_RE = /^[^./\\][^/\\]*\.mmd$/;
const STEP_BLOCK_FIELDS = ['summary', 'features', 'status', 'review', 'comments'];
const PROPOSAL_FIELDS = ['reason', 'purpose', 'logic', 'successCriteria'];
const TURN_FIELDS = ['id', 'number', 'title', 'summary', 'createdAt', 'revision', 'lanes', 'steps', 'arrows', 'tags'];
const DASH_RE = /^(\d+) (\d+)$/;

function fail(message, line) {
  return validationError(line ? `Line ${line}: ${message}` : message, line ? { line } : undefined);
}

function assert(condition, message, line) {
  if (!condition) throw fail(message, line);
}

function checkId(id, name, line) {
  assert(typeof id === 'string' && ID_PATTERN.test(id), `Invalid ${name} ID: ${id ?? ''}`, line);
  assert(!KEYWORDS.has(id.toLowerCase()), `${id} is a Mermaid keyword and cannot be an ID.`, line);
  return id;
}

/** One line of text that Mermaid can show inside double quotes. */
function checkText(value, name, max, line) {
  assert(typeof value === 'string', `${name} must be text.`, line);
  assert(value.trim().length > 0, `${name} cannot be empty.`, line);
  assert(!value.includes('"'), `${name} cannot contain a double quote; use ‘ ’ or “ ” instead.`, line);
  // eslint-disable-next-line no-control-regex
  assert(!/[\u0000-\u001f\u007f]/.test(value), `${name} must be one line of text.`, line);
  assert(textLength(value) <= max, `${name} must be at most ${max} characters.`, line);
  return value;
}

function checkSummary(value, line) {
  assert(typeof value === 'string' && value.trim().length > 0, 'Summary must be non-empty text.', line);
  assert(textLength(value) <= FLOW_LIMITS.summary, `Summary must be at most ${FLOW_LIMITS.summary} characters.`, line);
  return value;
}

function checkDash(value, id, line) {
  const match = typeof value === 'string' ? value.match(DASH_RE) : null;
  assert(match && [match[1], match[2]].every((part) => Number(part) >= 1 && Number(part) <= 40),
    `Tag ${id} stroke-dasharray must be two numbers from 1 to 40, such as 4 3.`, line);
  return `${Number(match[1])} ${Number(match[2])}`;
}

const TAG_FIELDS = ['id', 'label', 'description', 'fill', 'stroke', 'textColor', 'strokeWidth', 'strokeDasharray'];

function checkTag(tag, line) {
  assert(tag && typeof tag === 'object' && !Array.isArray(tag), 'Tag must be an object.', line);
  for (const key of Object.keys(tag)) assert(TAG_FIELDS.includes(key), `Unsupported tag field: ${key}`, line);
  checkId(tag.id, 'tag', line);
  for (const field of ['label', 'description']) {
    assert(typeof tag[field] === 'string' && tag[field].trim(), `Tag ${tag.id} needs a ${field}.`, line);
    assert(!/[|\r\n]/.test(tag[field]), `Tag ${tag.id} ${field} cannot contain | or a newline.`, line);
  }
  for (const field of ['fill', 'stroke', 'textColor']) {
    assert(COLOR_PATTERN.test(tag[field] || ''), `Tag ${tag.id} has an invalid ${field} color.`, line);
  }
  assert(Number.isInteger(tag.strokeWidth) && tag.strokeWidth >= 0 && tag.strokeWidth <= 20, `Tag ${tag.id} has an invalid stroke width.`, line);
  const checked = { id: tag.id, label: tag.label, description: tag.description, fill: tag.fill, stroke: tag.stroke, textColor: tag.textColor, strokeWidth: tag.strokeWidth };
  if (tag.strokeDasharray !== undefined && tag.strokeDasharray !== null) checked.strokeDasharray = checkDash(tag.strokeDasharray, tag.id, line);
  return checked;
}

function decode(json, name, line) {
  try { return JSON.parse(json); }
  catch { throw fail(`invalid JSON-quoted ${name}.`, line); }
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

function plainObject(value, name, line) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be a JSON object.`, line);
  return value;
}

/** Explicit links from a step to features in the same project's features maps. */
function checkFeatureLinks(value, id, line) {
  assert(Array.isArray(value), `Step ${id} features must be a list.`, line);
  assert(value.length > 0, `Step ${id} features must list at least one feature; remove the field instead.`, line);
  assert(value.length <= FLOW_LIMITS.features, `Step ${id} can link at most ${FLOW_LIMITS.features} features.`, line);
  const seen = new Set();
  return value.map((link) => {
    plainObject(link, `Step ${id} feature link`, line);
    for (const key of Object.keys(link)) assert(key === 'map' || key === 'id', `Unsupported feature link field: ${key}`, line);
    assert(typeof link.map === 'string' && FEATURE_MAP_RE.test(link.map) && link.map.length <= 255
      // eslint-disable-next-line no-control-regex
      && !/[\u0000-\u001f]/.test(link.map), `Step ${id} feature link needs a map file name in docs/maps, such as features.mmd.`, line);
    assert(typeof link.id === 'string' && ID_PATTERN.test(link.id), `Step ${id} feature link has an invalid feature ID: ${link.id ?? ''}`, line);
    const key = `${link.map}#${link.id}`;
    assert(!seen.has(key), `Step ${id} links feature ${key} twice.`, line);
    seen.add(key);
    return { map: link.map, id: link.id };
  });
}

function checkStatus(value, id, line) {
  assert(BLOCK_STATUSES.has(value), `Step ${id} has an invalid status: ${value ?? ''}`, line);
  return value;
}

function checkReview(value, id, line) {
  plainObject(value, `Step ${id} review`, line);
  for (const key of Object.keys(value)) assert(key === 'at' || key === 'fingerprint', `Unsupported review field: ${key}`, line);
  assert(typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)), `Step ${id} review needs an ISO date.`, line);
  assert(typeof value.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(value.fingerprint), `Step ${id} review needs a SHA-256 fingerprint.`, line);
  return { at: new Date(value.at).toISOString(), fingerprint: value.fingerprint };
}

function checkComments(value, id, line) {
  assert(Array.isArray(value) && value.length <= FLOW_LIMITS.comments, `Step ${id} comments must be a list of at most ${FLOW_LIMITS.comments}.`, line);
  const ids = new Set();
  return value.map((comment) => {
    let normalized;
    try { normalized = normalizeComment(comment); } catch (error) { throw fail(error.message, line); }
    assert(!ids.has(normalized.id), `Step ${id} has a duplicate comment ID: ${normalized.id}`, line);
    ids.add(normalized.id);
    return normalized;
  });
}

/** Reason, purpose, desired change (`logic`), and success criteria for a step's next change. `{}` is kept. */
export function checkFlowProposal(value, id, line) {
  plainObject(value, `Step ${id} proposal`, line);
  for (const key of Object.keys(value)) assert(PROPOSAL_FIELDS.includes(key), `flow step proposals support ${PROPOSAL_FIELDS.join(', ')}, not ${key}.`, line);
  const normalized = {};
  for (const field of PROPOSAL_FIELDS) {
    const text = value[field];
    if (text === undefined || text === null) continue;
    assert(typeof text === 'string', `Step ${id} proposal ${field} must be text.`, line);
    if (!text.trim()) continue;
    assert(textLength(text.trim()) <= FLOW_LIMITS.summary, `Step ${id} proposal ${field} must be at most ${FLOW_LIMITS.summary} characters.`, line);
    normalized[field] = text.trim();
  }
  return normalized;
}

/** Collaboration records of one step, in canonical key order. */
function stepRecords(source, id, line) {
  const records = {};
  if (source.features !== undefined) records.features = checkFeatureLinks(source.features, id, line);
  if (source.status !== undefined) records.status = checkStatus(source.status, id, line);
  if (source.review !== undefined) records.review = checkReview(source.review, id, line);
  if (source.comments !== undefined) records.comments = checkComments(source.comments, id, line);
  if (source.proposal !== undefined) records.proposal = checkFlowProposal(source.proposal, id, line);
  return records;
}

/** The sm-block JSON of a step or lane; null when it has nothing to write. */
function blockOf(item) {
  const block = {};
  if (item.summary !== undefined) block.summary = item.summary;
  for (const field of ['features', 'status', 'review', 'comments']) if (item[field] !== undefined) block[field] = item[field];
  return Object.keys(block).length ? block : null;
}

function normalizeFlowTurn(turn, line) {
  plainObject(turn, 'Turn', line);
  for (const key of Object.keys(turn)) assert(TURN_FIELDS.includes(key), `Unsupported turn field: ${key}`, line);
  assert(typeof turn.id === 'string' && turn.id.trim() && turn.id.length <= 200, 'Turn needs an id.', line);
  assert(Number.isInteger(turn.number) && turn.number > 0, `Turn ${turn.id} number must be a positive integer.`, line);
  assert(typeof turn.title === 'string' && turn.title.trim() && textLength(turn.title) <= FLOW_LIMITS.turnTitle,
    `Turn ${turn.id} needs a title of at most ${FLOW_LIMITS.turnTitle} characters.`, line);
  assert(typeof turn.createdAt === 'string' && Number.isFinite(Date.parse(turn.createdAt)), `Turn ${turn.id} needs an ISO createdAt date.`, line);
  assert(typeof turn.revision === 'string' && turn.revision.trim(), `Turn ${turn.id} needs a source revision.`, line);
  for (const field of ['lanes', 'steps', 'arrows', 'tags']) assert(Array.isArray(turn[field]), `Turn ${turn.id} ${field} must be a list.`, line);
  let snapshot;
  try { snapshot = validateFlowMap({ map: { kind: FLOW_KINDS[0] }, direction: 'LR', lanes: turn.lanes, steps: turn.steps, arrows: turn.arrows, tags: turn.tags }); }
  catch (error) { throw fail(`Turn ${turn.id}: ${error.message.replace(/^Line \d+: /, '')}`, line); }
  const normalized = { id: turn.id, number: turn.number, title: turn.title.trim() };
  if (turn.summary !== undefined && turn.summary !== null && String(turn.summary).trim()) {
    assert(typeof turn.summary === 'string' && textLength(turn.summary.trim()) <= FLOW_LIMITS.summary, `Turn ${turn.id} summary must be at most ${FLOW_LIMITS.summary} characters.`, line);
    normalized.summary = turn.summary.trim();
  }
  normalized.createdAt = new Date(turn.createdAt).toISOString();
  normalized.revision = turn.revision;
  normalized.lanes = snapshot.lanes; normalized.steps = snapshot.steps; normalized.arrows = snapshot.arrows; normalized.tags = snapshot.tags;
  return normalized;
}

/** Turns are numbered 1, 2, 3… in source order. `lines` gives each turn's line when parsing. */
function normalizeFlowTurns(turns, lines = []) {
  assert(Array.isArray(turns), 'Turns must be a list.');
  assert(turns.length <= FLOW_LIMITS.turns, `a flow map can have at most ${FLOW_LIMITS.turns} turns.`, lines[FLOW_LIMITS.turns]);
  const ids = new Set();
  return turns.map((turn, index) => {
    const line = lines[index];
    const normalized = normalizeFlowTurn(turn, line);
    assert(!ids.has(normalized.id), `duplicate turn ${normalized.id}.`, line);
    ids.add(normalized.id);
    assert(normalized.number === index + 1, `turn number must be ${index + 1} here; turns are numbered in order from 1.`, line);
    return normalized;
  });
}

function shapeOf(match) {
  if (match[2] !== undefined) return ['milestone', match[2]];
  if (match[3] !== undefined) return ['action', match[3]];
  return ['decision', match[4]];
}

/** Arrow segments of `A --> B -->|"label"| C`, or null when the line is not an arrow line. */
function arrowSegments(text, line) {
  const match = text.match(CHAIN_RE);
  if (!match) return null;
  const segments = [];
  let source = match[1];
  SEGMENT_RE.lastIndex = 0;
  for (;;) {
    const segment = SEGMENT_RE.exec(match[2]);
    if (!segment) break;
    const arrow = { source, target: segment[3], style: ARROW_TOKENS[segment[1]] };
    if (segment[2] !== undefined) arrow.label = checkText(decode(segment[2], 'arrow label', line), 'Arrow label', FLOW_LIMITS.arrowLabel, line);
    segments.push(arrow);
    source = segment[3];
    if (SEGMENT_RE.lastIndex >= match[2].length) break;
  }
  assert(segments.length && SEGMENT_RE.lastIndex === match[2].length, `unsupported arrow: ${text}`, line);
  return segments;
}

/** A plain-language reason for a line this grammar does not accept. */
function unsupported(text, line) {
  if (text.startsWith('%%')) return fail(`other comments are not supported; ${NOTE_HINT}`, line);
  if (/(^|[^-.=])(---|-\.-(?!>)|===)/.test(text) && !/(-->|-\.->|==>)/.test(text)) {
    return fail(`links need an arrowhead: use -->, -.->, or ==> instead of ${text.match(/---|-\.-|===/)[0]}.`, line);
  }
  if (/(-->|-\.->|==>|---|-\.-)/.test(text)) {
    if (/&/.test(text)) return fail(`use one arrow per pair of steps instead of &: ${text}`, line);
    if (/[[({]/.test(text.replace(/\|"(?:\\.|[^"\\])*"\|/g, ''))) return fail(`declare each step on its own line, then connect the IDs: ${text}`, line);
  }
  return fail(`unsupported statement: ${text}`, line);
}

/** Canonical step order: lanes in order, each lane's steps, then shared steps. */
function sortSteps(graph) {
  const laneIndex = new Map(graph.lanes.map((lane, index) => [lane.id, index]));
  const indexed = graph.steps.map((step, index) => ({ step, index }));
  indexed.sort((a, b) => ((laneIndex.get(a.step.lane) ?? graph.lanes.length) - (laneIndex.get(b.step.lane) ?? graph.lanes.length)) || a.index - b.index);
  graph.steps = indexed.map(({ step }) => step);
}

function sortTags(graph, tags) {
  const order = new Map(graph.tags.map((tag, index) => [tag.id, index]));
  return [...tags].sort((a, b) => order.get(a) - order.get(b));
}

export function parseFlowMap(source) {
  if (typeof source !== 'string') throw validationError('Source must be text.');
  if (Buffer.byteLength(source, 'utf8') > FLOW_LIMITS.sourceBytes) throw validationError(`Source exceeds ${FLOW_LIMITS.sourceBytes} bytes.`);
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let direction;
  let header;
  let headerLine;
  let lane = null;
  let laneLine;
  let laneStatements = 0;
  const elements = new Map();
  const lanes = [];
  const steps = [];
  const arrows = [];
  const arrowPairs = new Set();
  const tagDefs = new Map();
  const legends = new Map();
  const assignments = [];
  const blocks = new Map();
  const proposals = new Map();
  const turns = [];
  const turnLines = [];

  const declareStep = (match, laneId, line) => {
    checkId(match[1], 'step', line);
    assert(!elements.has(match[1]), `duplicate ID ${match[1]}.`, line);
    const [shape, json] = shapeOf(match);
    const step = { id: match[1], label: checkText(decode(json, 'label', line), 'Step label', FLOW_LIMITS.label, line), shape, lane: laneId, tags: [] };
    assert(steps.length < FLOW_LIMITS.steps, `a flow map can have at most ${FLOW_LIMITS.steps} steps.`, line);
    steps.push(step); elements.set(step.id, { type: 'step', item: step, line });
  };
  const addArrows = (segments, line) => {
    for (const arrow of segments) {
      assert(arrow.source !== arrow.target, 'an arrow must join two different steps.', line);
      const pair = `${arrow.source}\u0000${arrow.target}`;
      assert(!arrowPairs.has(pair), `duplicate arrow ${arrow.source} → ${arrow.target}.`, line);
      assert(arrows.length < FLOW_LIMITS.arrows, `a flow map can have at most ${FLOW_LIMITS.arrows} arrows.`, line);
      arrowPairs.add(pair); arrows.push({ arrow, line });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const text = lines[index].trim();
    if (!text) continue;
    let match;
    if (lane) {
      if (text === 'end') { lane = null; continue; }
      laneStatements += 1;
      match = text.match(LANE_DIRECTION_RE);
      if (match) {
        assert(laneStatements === 1, 'direction must be the first statement in a lane.', line);
        lane.direction = match[1];
        continue;
      }
      match = text.match(STEP_RE);
      if (match) { declareStep(match, lane.id, line); continue; }
      const segments = arrowSegments(text, line);
      if (segments) {
        for (const arrow of segments) {
          for (const end of [arrow.source, arrow.target]) {
            const element = elements.get(end);
            assert(element?.type === 'step' && element.item.lane === lane.id,
              `an arrow inside a lane must join steps already declared in that lane; move it below the lanes: ${text}`, line);
          }
        }
        addArrows(segments, line);
        continue;
      }
      if (text.startsWith('subgraph')) throw fail('lanes cannot be nested.', line);
      const reason = unsupported(text, line);
      if (/unsupported statement/.test(reason.message)) throw fail(`only steps and arrows between them may appear inside a lane: ${text}`, line);
      throw reason;
    }
    match = text.match(DECLARATION_RE);
    if (match) { assert(direction === undefined, 'duplicate flowchart declaration.', line); direction = match[1]; continue; }
    match = text.match(MAP_HEADER_RE);
    if (match) {
      assert(headerLine === undefined, 'duplicate map header.', line);
      headerLine = line;
      try { header = normalizeMapHeader(decode(match[1], 'map header', line), FLOW_KINDS); }
      catch (error) { throw fail(error.message.replace(/^Line \d+: /, ''), line); }
      continue;
    }
    if (text === 'end') throw fail('end without an open lane.', line);
    match = text.match(SUBGRAPH_RE);
    if (match) {
      checkId(match[1], 'lane', line);
      assert(!elements.has(match[1]), `duplicate ID ${match[1]}.`, line);
      assert(lanes.length < FLOW_LIMITS.lanes, `a flow map can have at most ${FLOW_LIMITS.lanes} lanes.`, line);
      lane = { id: match[1], title: checkText(decode(match[2], 'lane title', line), 'Lane title', FLOW_LIMITS.laneTitle, line), tags: [] };
      laneLine = line; laneStatements = 0;
      lanes.push(lane); elements.set(lane.id, { type: 'lane', item: lane, line });
      continue;
    }
    match = text.match(STEP_RE);
    if (match) { declareStep(match, null, line); continue; }
    const segments = arrowSegments(text, line);
    if (segments) { addArrows(segments, line); continue; }
    match = text.match(CLASS_DEF_RE);
    if (match) {
      const [, id, fill, stroke, textColor, width, dashA, dashB] = match;
      checkId(id, 'tag', line);
      assert(!tagDefs.has(id), `duplicate classDef ${id}.`, line);
      assert(tagDefs.size < FLOW_LIMITS.tags, `a flow map can have at most ${FLOW_LIMITS.tags} tags.`, line);
      tagDefs.set(id, { id, fill, stroke, textColor, strokeWidth: Number(width), ...(dashA !== undefined ? { strokeDasharray: `${dashA} ${dashB}` } : {}), line });
      continue;
    }
    match = text.match(CLASS_RE);
    if (match) { assignments.push({ ids: match[1].split(','), tag: match[2], line }); continue; }
    match = text.match(LEGEND_RE);
    if (match) {
      assert(!legends.has(match[1]), `duplicate legend ${match[1]}.`, line);
      legends.set(match[1], { label: match[2], description: match[3], line });
      continue;
    }
    match = text.match(BLOCK_RE);
    if (match) {
      const [, id, json] = match;
      assert(!blocks.has(id), `duplicate description for ${id}.`, line);
      assert(byteLength(json) <= FLOW_LIMITS.blockBytes, `description metadata exceeds ${FLOW_LIMITS.blockBytes} bytes.`, line);
      const block = decode(json, 'description', line);
      assert(block && typeof block === 'object' && !Array.isArray(block), 'description must be a JSON object.', line);
      for (const key of Object.keys(block)) assert(STEP_BLOCK_FIELDS.includes(key), `flow map step blocks support ${STEP_BLOCK_FIELDS.join(', ')}, not ${key}.`, line);
      blocks.set(id, { ...(block.summary !== undefined ? { summary: checkSummary(block.summary, line) } : {}), ...stepRecords(block, id, line), line });
      continue;
    }
    match = text.match(PROPOSAL_RE);
    if (match) {
      const [, id, json] = match;
      assert(!proposals.has(id), `duplicate proposal for ${id}.`, line);
      assert(byteLength(json) <= 65_536, 'proposal metadata exceeds 65536 bytes.', line);
      proposals.set(id, { proposal: checkFlowProposal(decode(json, 'proposal', line), id, line), line });
      continue;
    }
    match = text.match(TURN_RE);
    if (match) {
      assert(byteLength(match[1]) <= FLOW_LIMITS.turnBytes, `turn metadata exceeds ${FLOW_LIMITS.turnBytes} bytes.`, line);
      turns.push(decode(match[1], 'turn', line)); turnLines.push(line);
      continue;
    }
    throw unsupported(text, line);
  }

  if (lane) throw fail(`lane ${lane.id} is missing its end line.`, laneLine);
  assert(direction !== undefined, 'A flow map needs one flowchart LR, TB, or TD declaration.');
  assert(header !== undefined, 'A flow map needs a %% sm-map: header with "kind":"user-flow" or "kind":"system-flow".');

  for (const { arrow, line } of arrows) {
    for (const end of [arrow.source, arrow.target]) {
      const element = elements.get(end);
      assert(element, `arrow references undeclared step ${end}.`, line);
      assert(element.type === 'step', `arrows join steps, not lanes: ${end}.`, line);
    }
  }
  for (const [id, legend] of legends) assert(tagDefs.has(id), `legend ${id} is missing its classDef.`, legend.line);
  for (const [id, def] of tagDefs) assert(legends.has(id), `tag ${id} is missing its legend (%% mlc-legend: ${id}|label|description).`, def.line);
  const tags = [...tagDefs.values()].map(({ line, ...def }) => {
    const legend = legends.get(def.id);
    return checkTag({ ...def, label: legend.label, description: legend.description }, line);
  });
  for (const { ids, tag, line } of assignments) {
    assert(tagDefs.has(tag), `class uses undefined tag ${tag}.`, line);
    for (const id of ids) {
      const element = elements.get(id);
      assert(element, `class references undeclared ${id}.`, line);
      assert(!element.item.tags.includes(tag), `${id} already has tag ${tag}.`, line);
      element.item.tags.push(tag);
    }
  }
  for (const [id, { line, ...block }] of blocks) {
    const element = elements.get(id);
    assert(element, `description references undeclared ${id}.`, line);
    if (element.type === 'lane') {
      for (const key of Object.keys(block)) assert(key === 'summary', `lane descriptions support only summary, not ${key}.`, line);
      assert(block.summary !== undefined, `lane description for ${id} needs a summary.`, line);
    }
    Object.assign(element.item, block);
  }
  for (const [id, { proposal, line }] of proposals) {
    const element = elements.get(id);
    assert(element, `proposal references undeclared ${id}.`, line);
    assert(element.type === 'step', `proposals belong to steps, not lanes: ${id}.`, line);
    element.item.proposal = proposal;
  }
  const checkedTurns = normalizeFlowTurns(turns, turnLines);
  return validateFlowMap({ map: header, direction, lanes, steps, arrows: arrows.map(({ arrow }) => arrow), tags,
    ...(checkedTurns.length ? { turns: checkedTurns } : {}) });
}

/** Full structural validation of a flow model; used after every operation. */
export function validateFlowMap(input) {
  assert(input && typeof input === 'object', 'Flow map graph must be an object.');
  const graph = { map: normalizeMapHeader(input.map, FLOW_KINDS), direction: input.direction };
  assert(FLOW_DIRECTIONS.includes(graph.direction), `Flow map direction must be ${FLOW_DIRECTIONS.join(', ')}.`);
  for (const [field, max] of [['lanes', FLOW_LIMITS.lanes], ['steps', FLOW_LIMITS.steps], ['arrows', FLOW_LIMITS.arrows], ['tags', FLOW_LIMITS.tags]]) {
    assert(Array.isArray(input[field]) && input[field].length <= max, `A flow map can have at most ${max} ${field}.`);
  }
  const tagIds = new Set();
  graph.tags = input.tags.map((tag) => {
    const checked = checkTag(tag);
    assert(!tagIds.has(checked.id), `Duplicate tag ${checked.id}.`);
    tagIds.add(checked.id);
    return checked;
  });
  const ids = new Map();
  const tagsOf = (item) => {
    assert(Array.isArray(item.tags), `${item.id} tags must be a list.`);
    const seen = new Set();
    for (const tag of item.tags) {
      assert(tagIds.has(tag), `${item.id} uses undefined tag ${tag}.`);
      assert(!seen.has(tag), `${item.id} lists tag ${tag} twice.`);
      seen.add(tag);
    }
    return sortTags(graph, item.tags);
  };
  graph.lanes = input.lanes.map((lane) => {
    checkId(lane.id, 'lane');
    assert(!ids.has(lane.id), `Duplicate ID ${lane.id}.`);
    const normalized = { id: lane.id, title: checkText(lane.title, 'Lane title', FLOW_LIMITS.laneTitle) };
    if (lane.direction !== undefined) {
      assert(LANE_DIRECTIONS.includes(lane.direction), `Lane ${lane.id} has an invalid direction.`);
      normalized.direction = lane.direction;
    }
    normalized.tags = tagsOf(lane);
    if (lane.summary !== undefined) normalized.summary = checkSummary(lane.summary);
    for (const field of ['features', 'status', 'review', 'comments', 'proposal']) {
      assert(lane[field] === undefined, `Lanes cannot have ${field}; only steps can.`);
    }
    ids.set(lane.id, 'lane');
    return normalized;
  });
  graph.steps = input.steps.map((step) => {
    checkId(step.id, 'step');
    assert(!ids.has(step.id), `Duplicate ID ${step.id}.`);
    assert(STEP_SHAPES.includes(step.shape), `Step ${step.id} has an invalid shape.`);
    assert(step.lane === null || ids.get(step.lane) === 'lane', `Step ${step.id} uses a missing lane ${step.lane}.`);
    const normalized = { id: step.id, label: checkText(step.label, 'Step label', FLOW_LIMITS.label), shape: step.shape, lane: step.lane, tags: tagsOf(step) };
    if (step.summary !== undefined) normalized.summary = checkSummary(step.summary);
    Object.assign(normalized, stepRecords(step, step.id));
    const block = blockOf(normalized);
    assert(!block || byteLength(JSON.stringify(block)) <= FLOW_LIMITS.blockBytes, `Step ${step.id} has too many memos to store on one line.`);
    ids.set(step.id, 'step');
    return normalized;
  });
  sortSteps(graph);
  const pairs = new Set();
  graph.arrows = input.arrows.map((arrow) => {
    assert(ids.get(arrow.source) === 'step' && ids.get(arrow.target) === 'step', `Arrow ${arrow.source} → ${arrow.target} must join two declared steps.`);
    assert(arrow.source !== arrow.target, 'An arrow must join two different steps.');
    assert(ARROW_STYLES.includes(arrow.style), `Arrow ${arrow.source} → ${arrow.target} has an invalid style.`);
    const pair = `${arrow.source}\u0000${arrow.target}`;
    assert(!pairs.has(pair), `Steps ${arrow.source} and ${arrow.target} are already connected.`);
    pairs.add(pair);
    const normalized = { source: arrow.source, target: arrow.target, style: arrow.style };
    if (arrow.label !== undefined) normalized.label = checkText(arrow.label, 'Arrow label', FLOW_LIMITS.arrowLabel);
    return normalized;
  });
  const result = { map: graph.map, direction: graph.direction, lanes: graph.lanes, steps: graph.steps, arrows: graph.arrows, tags: graph.tags };
  if (input.turns !== undefined) {
    const turns = normalizeFlowTurns(input.turns);
    if (turns.length) result.turns = turns;
  }
  return result;
}

function stepLine(step) {
  const label = JSON.stringify(step.label);
  if (step.shape === 'milestone') return `${step.id}([${label}])`;
  if (step.shape === 'decision') return `${step.id}{${label}}`;
  return `${step.id}[${label}]`;
}

export function writeFlowMap(input) {
  const graph = validateFlowMap(input);
  const head = [`flowchart ${graph.direction}`, `  %% sm-map: ${JSON.stringify(graph.map)}`];
  for (const lane of graph.lanes) {
    head.push(`  subgraph ${lane.id}[${JSON.stringify(lane.title)}]`);
    if (lane.direction) head.push(`    direction ${lane.direction}`);
    for (const step of graph.steps) if (step.lane === lane.id) head.push(`    ${stepLine(step)}`);
    head.push('  end');
  }
  for (const step of graph.steps) if (step.lane === null) head.push(`  ${stepLine(step)}`);
  const arrows = graph.arrows.map((arrow) => `  ${arrow.source} ${STYLE_TOKENS[arrow.style]}${arrow.label !== undefined ? `|${JSON.stringify(arrow.label)}|` : ''} ${arrow.target}`);
  const tags = graph.tags.map((tag) => `  classDef ${tag.id} fill:${tag.fill},stroke:${tag.stroke},color:${tag.textColor},stroke-width:${tag.strokeWidth}px${tag.strokeDasharray ? `,stroke-dasharray:${tag.strokeDasharray}` : ''}`);
  for (const tag of graph.tags) {
    const ids = [...graph.lanes, ...graph.steps].filter((item) => item.tags.includes(tag.id)).map(({ id }) => id);
    if (ids.length) tags.push(`  class ${ids.join(',')} ${tag.id}`);
  }
  const blocks = [...graph.lanes, ...graph.steps].map((item) => [item.id, blockOf(item)]).filter(([, block]) => block)
    .map(([id, block]) => `  %% sm-block: ${id}|${JSON.stringify(block)}`);
  const proposals = graph.steps.filter((step) => step.proposal !== undefined)
    .map((step) => `  %% mlc-proposal: ${step.id}|${JSON.stringify(step.proposal)}`);
  const legends = graph.tags.map((tag) => `  %% mlc-legend: ${tag.id}|${tag.label}|${tag.description}`);
  const turns = (graph.turns || []).map((turn) => `  %% sm-turn: ${JSON.stringify(turn)}`);
  return `${[head, arrows, tags, blocks, proposals, legends, turns].filter((section) => section.length).map((section) => section.join('\n')).join('\n\n')}\n`;
}

/* ---------------------------------------------------------------- operations */

const OPERATION_FIELDS = {
  addStep: ['lane', 'label', 'id', 'shape', 'tags', 'summary', 'after', 'before', 'connectFrom', 'splice'],
  updateStep: ['id', 'label', 'shape', 'tags', 'summary', 'features'],
  moveStep: ['id', 'lane', 'after', 'before'],
  deleteSteps: ['ids', 'bridge'],
  addArrow: ['source', 'target', 'style', 'label'],
  updateArrow: ['source', 'target', 'style', 'label', 'newSource', 'newTarget'],
  removeArrow: ['source', 'target'],
  addLane: ['title', 'id', 'after', 'tags', 'summary'],
  updateLane: ['id', 'title', 'tags', 'summary'],
  moveLane: ['id', 'after'],
  deleteLane: ['id', 'withSteps'],
  upsertTag: ['tag'],
  deleteTag: ['id'],
  setMapHeader: ['title', 'description'],
  replaceSource: ['source'],
  addComment: ['id', 'body', 'kind', 'author'],
  resolveComment: ['id', 'commentId', 'resolved'],
  setProposal: ['id', 'proposal'],
  setBlock: ['id', 'block'],
  createTurn: ['title', 'summary'],
};
/** Operations whose IDs, dates, fingerprints, or revision come from the map store (`context`). */
export const FLOW_RECORD_OPERATIONS = Object.freeze(['addComment', 'resolveComment', 'setProposal', 'setBlock', 'createTurn']);
export const FLOW_OPERATIONS = Object.freeze(Object.keys(OPERATION_FIELDS));

function nextId(graph, prefix) {
  const used = new Set([...graph.lanes, ...graph.steps].map(({ id }) => id));
  let index = 1;
  while (used.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function newId(graph, id, prefix) {
  if (id === undefined || id === null) return nextId(graph, prefix);
  checkId(id, prefix);
  assert(![...graph.lanes, ...graph.steps].some((item) => item.id === id), `ID ${id} is already used.`);
  return id;
}

function findStep(graph, id, name = 'Step') {
  const step = graph.steps.find((item) => item.id === id);
  assert(step, `${name} does not exist: ${id ?? ''}`);
  return step;
}

function findLane(graph, id) {
  const lane = graph.lanes.find((item) => item.id === id);
  assert(lane, `Lane does not exist: ${id ?? ''}`);
  return lane;
}

function laneValue(graph, value) {
  assert(value !== undefined, 'lane is required; use null for a shared step.');
  if (value === null) return null;
  return findLane(graph, value).id;
}

function tagList(graph, tags) {
  assert(Array.isArray(tags), 'tags must be a list.');
  const known = new Set(graph.tags.map(({ id }) => id));
  const seen = new Set();
  for (const tag of tags) {
    assert(known.has(tag), `Tag does not exist: ${tag ?? ''}`);
    assert(!seen.has(tag), `Tag listed twice: ${tag}`);
    seen.add(tag);
  }
  return sortTags(graph, tags);
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function applySummary(item, value) {
  if (value === undefined) return;
  if (value === null || (typeof value === 'string' && !value.trim())) delete item.summary;
  else item.summary = checkSummary(trimmed(value));
}

function placeStep(graph, step, { after, before }) {
  assert(after === undefined || before === undefined, 'Use after or before, not both.');
  const anchorId = after ?? before;
  let index = graph.steps.length;
  if (anchorId !== undefined && anchorId !== null) {
    const anchor = findStep(graph, anchorId, 'Anchor step');
    assert(anchor.lane === step.lane, `${anchorId} is not in the same lane.`);
    index = graph.steps.indexOf(anchor) + (after !== undefined ? 1 : 0);
  }
  graph.steps.splice(index, 0, step);
  sortSteps(graph);
}

function arrowIndex(graph, source, target) {
  return graph.arrows.findIndex((arrow) => arrow.source === source && arrow.target === target);
}

function findArrow(graph, source, target) {
  const index = arrowIndex(graph, source, target);
  assert(index >= 0, `Arrow does not exist: ${source ?? ''} → ${target ?? ''}`);
  return index;
}

function styleValue(value, fallback = 'next') {
  if (value === undefined) return fallback;
  assert(ARROW_STYLES.includes(value), `Invalid arrow style: ${value ?? ''}`);
  return value;
}

function deleteStep(graph, id, bridge) {
  const incoming = graph.arrows.filter((arrow) => arrow.target === id);
  const outgoing = graph.arrows.filter((arrow) => arrow.source === id);
  let replacement = null;
  if (bridge && incoming.length === 1 && outgoing.length === 1) {
    const [before] = incoming; const [after] = outgoing;
    if (before.source !== after.target && arrowIndex(graph, before.source, after.target) < 0) {
      replacement = { source: before.source, target: after.target, style: before.style, ...(before.label !== undefined ? { label: before.label } : {}) };
    }
  }
  const arrows = [];
  for (const arrow of graph.arrows) {
    if (arrow.source !== id && arrow.target !== id) arrows.push(arrow);
    else if (replacement && arrow === incoming[0]) arrows.push(replacement);
  }
  graph.arrows = arrows;
  graph.steps = graph.steps.filter((step) => step.id !== id);
}

/** Applies one flow map operation (except replaceSource) to a copy of the graph. */
/**
 * `context` is supplied by the map store, never by a client: `now` (ISO date),
 * `commentId`, `turnId`, and the current source `revision`.
 */
export function applyFlowOperation(current, operation, context = {}) {
  assert(operation && typeof operation === 'object' && !Array.isArray(operation), 'operation must be an object.');
  const fields = OPERATION_FIELDS[operation.type];
  assert(fields, `Unsupported flow map operation: ${operation.type ?? ''}`);
  for (const key of Object.keys(operation)) assert(key === 'type' || fields.includes(key), `Unsupported ${operation.type} field: ${key}`);
  assert(operation.type !== 'replaceSource', 'replaceSource is applied by the map store.');
  const graph = structuredClone(current);

  switch (operation.type) {
    case 'addStep': {
      assert(!(operation.connectFrom !== undefined && operation.splice !== undefined), 'Use connectFrom or splice, not both.');
      const lane = laneValue(graph, operation.lane);
      const shape = operation.shape ?? 'action';
      assert(STEP_SHAPES.includes(shape), `Invalid step shape: ${shape}`);
      const step = { id: newId(graph, operation.id, 'step'), label: checkText(trimmed(operation.label), 'Step label', FLOW_LIMITS.label), shape, lane,
        tags: operation.tags === undefined ? [] : tagList(graph, operation.tags) };
      applySummary(step, operation.summary);
      assert(graph.steps.length < FLOW_LIMITS.steps, `A flow map can have at most ${FLOW_LIMITS.steps} steps.`);
      placeStep(graph, step, operation);
      if (operation.connectFrom !== undefined) {
        findStep(graph, operation.connectFrom, 'connectFrom step');
        assert(operation.connectFrom !== step.id, 'A step cannot connect to itself.');
        graph.arrows.push({ source: operation.connectFrom, target: step.id, style: 'next' });
      }
      if (operation.splice !== undefined) {
        const { source, target } = operation.splice || {};
        const index = findArrow(graph, source, target);
        const old = graph.arrows[index];
        graph.arrows.splice(index, 1,
          { source, target: step.id, style: old.style, ...(old.label !== undefined ? { label: old.label } : {}) },
          { source: step.id, target, style: 'next' });
      }
      break;
    }
    case 'updateStep': {
      const step = findStep(graph, operation.id);
      if (operation.label !== undefined) step.label = checkText(trimmed(operation.label), 'Step label', FLOW_LIMITS.label);
      if (operation.shape !== undefined) { assert(STEP_SHAPES.includes(operation.shape), `Invalid step shape: ${operation.shape}`); step.shape = operation.shape; }
      if (operation.tags !== undefined) step.tags = tagList(graph, operation.tags);
      applySummary(step, operation.summary);
      if (operation.features === null || (Array.isArray(operation.features) && !operation.features.length)) delete step.features;
      else if (operation.features !== undefined) step.features = checkFeatureLinks(operation.features, step.id);
      break;
    }
    case 'moveStep': {
      const step = findStep(graph, operation.id);
      const lane = laneValue(graph, operation.lane);
      assert(operation.after !== step.id && operation.before !== step.id, 'A step cannot be placed next to itself.');
      graph.steps = graph.steps.filter((item) => item !== step);
      step.lane = lane;
      placeStep(graph, step, operation);
      break;
    }
    case 'deleteSteps': {
      assert(Array.isArray(operation.ids) && operation.ids.length > 0, 'ids must list at least one step.');
      assert(operation.bridge === undefined || typeof operation.bridge === 'boolean', 'bridge must be true or false.');
      assert(new Set(operation.ids).size === operation.ids.length, 'ids lists a step twice.');
      for (const id of operation.ids) findStep(graph, id);
      for (const id of operation.ids) deleteStep(graph, id, operation.bridge !== false);
      break;
    }
    case 'addArrow': {
      findStep(graph, operation.source, 'Source step');
      findStep(graph, operation.target, 'Target step');
      assert(operation.source !== operation.target, 'An arrow must join two different steps.');
      assert(arrowIndex(graph, operation.source, operation.target) < 0, 'These steps are already connected.');
      const arrow = { source: operation.source, target: operation.target, style: styleValue(operation.style) };
      if (operation.label !== undefined && operation.label !== null && trimmed(operation.label) !== '') arrow.label = checkText(trimmed(operation.label), 'Arrow label', FLOW_LIMITS.arrowLabel);
      assert(graph.arrows.length < FLOW_LIMITS.arrows, `A flow map can have at most ${FLOW_LIMITS.arrows} arrows.`);
      graph.arrows.push(arrow);
      break;
    }
    case 'updateArrow': {
      const index = findArrow(graph, operation.source, operation.target);
      const arrow = { ...graph.arrows[index] };
      if (operation.newSource !== undefined) arrow.source = findStep(graph, operation.newSource, 'Source step').id;
      if (operation.newTarget !== undefined) arrow.target = findStep(graph, operation.newTarget, 'Target step').id;
      assert(arrow.source !== arrow.target, 'An arrow must join two different steps.');
      const other = arrowIndex(graph, arrow.source, arrow.target);
      assert(other < 0 || other === index, 'These steps are already connected.');
      arrow.style = styleValue(operation.style, arrow.style);
      if (operation.label === null || (typeof operation.label === 'string' && !operation.label.trim())) delete arrow.label;
      else if (operation.label !== undefined) arrow.label = checkText(trimmed(operation.label), 'Arrow label', FLOW_LIMITS.arrowLabel);
      graph.arrows[index] = arrow;
      break;
    }
    case 'removeArrow': {
      graph.arrows.splice(findArrow(graph, operation.source, operation.target), 1);
      break;
    }
    case 'addLane': {
      assert(graph.lanes.length < FLOW_LIMITS.lanes, `A flow map can have at most ${FLOW_LIMITS.lanes} lanes.`);
      const lane = { id: newId(graph, operation.id, 'lane'), title: checkText(trimmed(operation.title), 'Lane title', FLOW_LIMITS.laneTitle),
        tags: operation.tags === undefined ? [] : tagList(graph, operation.tags) };
      applySummary(lane, operation.summary);
      if (operation.after === undefined) graph.lanes.push(lane);
      else if (operation.after === null) graph.lanes.unshift(lane);
      else graph.lanes.splice(graph.lanes.indexOf(findLane(graph, operation.after)) + 1, 0, lane);
      break;
    }
    case 'updateLane': {
      const lane = findLane(graph, operation.id);
      if (operation.title !== undefined) lane.title = checkText(trimmed(operation.title), 'Lane title', FLOW_LIMITS.laneTitle);
      if (operation.tags !== undefined) lane.tags = tagList(graph, operation.tags);
      applySummary(lane, operation.summary);
      break;
    }
    case 'moveLane': {
      const lane = findLane(graph, operation.id);
      assert(operation.after !== undefined, 'after is required; use null to move the lane first.');
      assert(operation.after !== lane.id, 'A lane cannot be placed after itself.');
      if (operation.after !== null) findLane(graph, operation.after);
      graph.lanes = graph.lanes.filter((item) => item !== lane);
      if (operation.after === null) graph.lanes.unshift(lane);
      else graph.lanes.splice(graph.lanes.findIndex((item) => item.id === operation.after) + 1, 0, lane);
      sortSteps(graph);
      break;
    }
    case 'deleteLane': {
      const lane = findLane(graph, operation.id);
      assert(operation.withSteps === undefined || typeof operation.withSteps === 'boolean', 'withSteps must be true or false.');
      const laneSteps = graph.steps.filter((step) => step.lane === lane.id).map(({ id }) => id);
      assert(!laneSteps.length || operation.withSteps === true, 'This lane has steps; set withSteps to delete them too.');
      for (const id of laneSteps) deleteStep(graph, id, false);
      graph.lanes = graph.lanes.filter((item) => item !== lane);
      break;
    }
    case 'upsertTag': {
      const tag = checkTag(operation.tag);
      const index = graph.tags.findIndex((item) => item.id === tag.id);
      if (index >= 0) graph.tags[index] = tag;
      else {
        assert(graph.tags.length < FLOW_LIMITS.tags, `A flow map can have at most ${FLOW_LIMITS.tags} tags.`);
        graph.tags.push(tag);
      }
      break;
    }
    case 'deleteTag': {
      assert(graph.tags.some((tag) => tag.id === operation.id), `Tag does not exist: ${operation.id ?? ''}`);
      graph.tags = graph.tags.filter((tag) => tag.id !== operation.id);
      for (const item of [...graph.lanes, ...graph.steps]) item.tags = item.tags.filter((tag) => tag !== operation.id);
      break;
    }
    case 'setMapHeader': {
      const header = { ...graph.map };
      for (const field of ['title', 'description']) {
        const value = operation[field];
        if (value === undefined) continue;
        if (value === null || (typeof value === 'string' && !value.trim())) delete header[field];
        else header[field] = trimmed(value);
      }
      graph.map = normalizeMapHeader(header, FLOW_KINDS);
      break;
    }
    case 'addComment': {
      const step = findStep(graph, operation.id);
      assert(context.commentId && context.now, 'addComment is applied by the map store.');
      const comments = step.comments || [];
      assert(comments.length < FLOW_LIMITS.comments, `A step can have at most ${FLOW_LIMITS.comments} memos.`);
      let comment;
      try {
        comment = normalizeComment({ id: context.commentId, body: operation.body, kind: operation.kind, author: operation.author, createdAt: context.now });
      } catch (error) { throw fail(error.message); }
      step.comments = [...comments, comment];
      break;
    }
    case 'resolveComment': {
      const step = findStep(graph, operation.id);
      assert(operation.resolved === undefined || typeof operation.resolved === 'boolean', 'resolved must be true or false.');
      const index = (step.comments || []).findIndex((comment) => comment.id === operation.commentId);
      assert(index >= 0, `Comment does not exist: ${operation.commentId ?? ''}`);
      step.comments[index] = { ...step.comments[index], resolved: operation.resolved ?? true };
      break;
    }
    case 'setProposal': {
      const step = findStep(graph, operation.id);
      assert(operation.proposal !== undefined, 'proposal is required; use null to withdraw it.');
      if (operation.proposal === null) delete step.proposal;
      else step.proposal = checkFlowProposal(operation.proposal, step.id);
      break;
    }
    case 'setBlock': {
      const step = findStep(graph, operation.id);
      const block = plainObject(operation.block, 'setBlock block');
      for (const key of Object.keys(block)) assert(key === 'status', `Unsupported flow setBlock field: ${key}; edit the description with updateStep.`);
      assert(block.status !== undefined, 'setBlock needs a status.');
      checkStatus(block.status, step.id);
      if (block.status === 'verified') {
        assert(context.now, 'A review is recorded by the map store.');
        step.status = 'verified';
        step.review = { at: context.now, fingerprint: flowStepFingerprint(step, graph) };
      } else {
        delete step.review;
        if (block.status === 'neutral') delete step.status;
        else step.status = block.status;
      }
      break;
    }
    case 'createTurn': {
      assert(context.turnId && context.now && context.revision, 'createTurn is applied by the map store.');
      const turns = graph.turns || [];
      assert(turns.length < FLOW_LIMITS.turns, `A flow map can have at most ${FLOW_LIMITS.turns} turns.`);
      assert(typeof operation.title === 'string' && operation.title.trim(), 'A turn needs a title.');
      const turn = { id: context.turnId, number: turns.length + 1, title: operation.title.trim() };
      if (typeof operation.summary === 'string' && operation.summary.trim()) turn.summary = operation.summary.trim();
      else assert(operation.summary === undefined || operation.summary === null || typeof operation.summary === 'string', 'Turn summary must be text.');
      Object.assign(turn, { createdAt: context.now, revision: context.revision,
        lanes: structuredClone(graph.lanes), steps: structuredClone(graph.steps), arrows: structuredClone(graph.arrows), tags: structuredClone(graph.tags) });
      const normalized = normalizeFlowTurn(turn);
      assert(byteLength(JSON.stringify(normalized)) <= FLOW_LIMITS.turnBytes, `A turn can be at most ${FLOW_LIMITS.turnBytes} bytes.`);
      graph.turns = [...turns, normalized];
      break;
    }
    default:
      break;
  }
  return validateFlowMap(invalidateStaleFlowReviews(graph));
}
