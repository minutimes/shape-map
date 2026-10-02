// Development-only model of flow map sources (user-flow and system-flow): a reader, a canonical writer,
// and the operations from docs/API.md. The real server owns the authoritative
// implementation; this one lets the canvas run before that server exists.

const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const KEYWORDS = new Set(['end', 'graph', 'flowchart', 'subgraph', 'class', 'classdef', 'click', 'style', 'linkstyle', 'direction']);
const ARROWS = { '-->': 'next', '-.->': 'alternative', '==>': 'exchange' };
const ARROW_TEXT = { next: '-->', alternative: '-.->', exchange: '==>' };

export class SourceError extends Error {
  constructor(message, line) { super(message); this.line = line; }
}

const quoted = (text, line) => {
  try { const value = JSON.parse(text); if (typeof value === 'string') return value; } catch { /* fall through */ }
  throw new SourceError('글자는 큰따옴표로 감싸야 해요.', line);
};

function checkId(id, line) {
  if (!ID.test(id) || KEYWORDS.has(id.toLowerCase())) throw new SourceError(`쓸 수 없는 이름이에요: ${id}`, line);
}

const STEP = /^([A-Za-z][A-Za-z0-9_-]*)(\(\[("(?:[^"\\]|\\.)*")\]\)|\[("(?:[^"\\]|\\.)*")\]|\{("(?:[^"\\]|\\.)*")\})$/;
const ARROW_LINK = /^\s+(-->|-\.->|==>)(?:\|("(?:[^"\\]|\\.)*")\|)?\s+([A-Za-z][A-Za-z0-9_-]*)/;
const KINDS = ['user-flow', 'system-flow'];

export function parseFlow(source) {
  const model = { direction: 'LR', header: null, lanes: [], steps: [], arrows: [], tags: [], tagsOf: new Map(), summaries: new Map() };
  const lines = String(source).split('\n');
  let declared = false; let lane = null;
  const ids = new Set(); const legends = new Map(); const classLines = [];
  lines.forEach((raw, position) => {
    const line = position + 1; const text = raw.trim();
    if (!text) return;
    const declaration = text.match(/^flowchart (LR|TB|TD)$/);
    if (declaration) { if (declared) throw new SourceError('flowchart 선언은 한 번만 쓸 수 있어요.', line); declared = true; model.direction = declaration[1]; return; }
    if (!declared) throw new SourceError('첫 줄은 flowchart LR, TB, TD 중 하나여야 해요.', line);
    if (text.startsWith('%% sm-map:')) {
      if (model.header) throw new SourceError('지도 머리말은 한 번만 쓸 수 있어요.', line);
      let header; try { header = JSON.parse(text.slice(10)); } catch { throw new SourceError('지도 머리말을 읽을 수 없어요.', line); }
      if (!KINDS.includes(header.kind)) throw new SourceError('플로우 지도가 아니에요.', line);
      for (const key of Object.keys(header)) if (!['kind', 'title', 'description'].includes(key)) throw new SourceError(`모르는 항목이에요: ${key}`, line);
      model.header = header; return;
    }
    let match = text.match(/^subgraph ([A-Za-z][A-Za-z0-9_-]*)\[("(?:[^"\\]|\\.)*")\]$/);
    if (match) {
      if (lane) throw new SourceError('참여자 줄 안에 다른 줄을 넣을 수 없어요.', line);
      checkId(match[1], line); if (ids.has(match[1])) throw new SourceError(`같은 이름이 두 번 있어요: ${match[1]}`, line);
      ids.add(match[1]); lane = { id: match[1], title: quoted(match[2], line) }; model.lanes.push(lane); return;
    }
    if (text === 'end') { if (!lane) throw new SourceError('짝이 없는 end예요.', line); lane = null; return; }
    const laneDirection = text.match(/^direction (LR|RL|TB|TD|BT)$/);
    if (laneDirection && lane && !lane.direction && !model.steps.some((step) => step.lane === lane.id)) { lane.direction = laneDirection[1]; return; }
    match = text.match(STEP);
    if (match) {
      checkId(match[1], line); if (ids.has(match[1])) throw new SourceError(`같은 이름이 두 번 있어요: ${match[1]}`, line);
      ids.add(match[1]);
      const shape = match[3] ? 'milestone' : match[4] ? 'action' : 'decision';
      const label = quoted(match[3] || match[4] || match[5], line);
      if (!label || label.length > 200 || label.includes('"')) throw new SourceError('단계 이름은 1~200자이고 큰따옴표를 쓸 수 없어요.', line);
      model.steps.push({ id: match[1], label, shape, lane: lane?.id ?? null, line }); return;
    }
    match = text.match(/^([A-Za-z][A-Za-z0-9_-]*)(?=\s+(?:-->|-\.->|==>))/);
    if (match) {
      let rest = text.slice(match[1].length); let from = match[1];
      const chain = [];
      while (rest.length) {
        const link = rest.match(ARROW_LINK);
        if (!link) throw new SourceError('화살표를 읽을 수 없어요.', line);
        const arrow = { source: from, target: link[3], style: ARROWS[link[1]], line };
        if (link[2]) arrow.label = quoted(link[2], line);
        chain.push(arrow); from = link[3]; rest = rest.slice(link[0].length);
      }
      if (lane) for (const arrow of chain) for (const end of [arrow.source, arrow.target]) {
        if (!model.steps.some((step) => step.id === end && step.lane === lane.id)) throw new SourceError('줄 안의 화살표는 그 줄에 먼저 적은 단계끼리만 이을 수 있어요.', line);
      }
      model.arrows.push(...chain); return;
    }
    if (lane) throw new SourceError('줄 안에는 단계와 화살표만 쓸 수 있어요.', line);
    match = text.match(/^classDef ([A-Za-z][A-Za-z0-9_-]*) fill:(#[0-9A-Fa-f]{6}),stroke:(#[0-9A-Fa-f]{6}),color:(#[0-9A-Fa-f]{6}),stroke-width:(\d+)px(?:,stroke-dasharray:(\d{1,2}) (\d{1,2}))?$/);
    if (match) {
      if (model.tags.some((tag) => tag.id === match[1])) throw new SourceError(`같은 표시가 두 번 있어요: ${match[1]}`, line);
      model.tags.push({ id: match[1], fill: match[2].toUpperCase(), stroke: match[3].toUpperCase(), textColor: match[4].toUpperCase(), strokeWidth: Number(match[5]), ...(match[6] ? { strokeDasharray: `${match[6]} ${match[7]}` } : {}), line }); return;
    }
    match = text.match(/^class ([A-Za-z0-9_,-]+) ([A-Za-z][A-Za-z0-9_-]*)$/);
    if (match) { classLines.push({ ids: match[1].split(','), tag: match[2], line }); return; }
    match = text.match(/^%% sm-block: ([A-Za-z][A-Za-z0-9_-]*)\|(.*)$/);
    if (match) {
      let block; try { block = JSON.parse(match[2]); } catch { throw new SourceError('설명을 읽을 수 없어요.', line); }
      if (Object.keys(block).some((key) => key !== 'summary') || typeof block.summary !== 'string') throw new SourceError('설명에는 summary만 쓸 수 있어요.', line);
      model.summaries.set(match[1], { summary: block.summary, line }); return;
    }
    match = text.match(/^%% mlc-legend: ([A-Za-z][A-Za-z0-9_-]*)\|([^|]*)\|(.*)$/);
    if (match) { if (legends.has(match[1])) throw new SourceError(`표시 설명이 두 번 있어요: ${match[1]}`, line); legends.set(match[1], { label: match[2], description: match[3], line }); return; }
    if (text === '%% mlc-format: 1') return;
    throw new SourceError('읽을 수 없는 줄이에요.', line);
  });
  if (!declared) throw new SourceError('flowchart LR이 없어요.', 1);
  if (lane) throw new SourceError('참여자 줄이 end로 닫히지 않았어요.', lines.length);
  if (!model.header) throw new SourceError('지도 머리말(sm-map)이 없어요.', 1);
  const stepIds = new Set(model.steps.map((step) => step.id));
  const pairs = new Set();
  for (const arrow of model.arrows) {
    if (!stepIds.has(arrow.source) || !stepIds.has(arrow.target)) throw new SourceError('화살표 양 끝은 단계여야 해요.', arrow.line);
    if (arrow.source === arrow.target) throw new SourceError('화살표가 자기 자신을 가리킬 수 없어요.', arrow.line);
    const key = `${arrow.source}->${arrow.target}`;
    if (pairs.has(key)) throw new SourceError('같은 두 단계를 잇는 화살표가 이미 있어요.', arrow.line);
    pairs.add(key);
  }
  for (const tag of model.tags) {
    const legend = legends.get(tag.id);
    if (!legend) throw new SourceError(`표시 설명(mlc-legend)이 없어요: ${tag.id}`, tag.line);
    tag.label = legend.label; tag.description = legend.description;
  }
  for (const [id, legend] of legends) if (!model.tags.some((tag) => tag.id === id)) throw new SourceError(`정의되지 않은 표시예요: ${id}`, legend.line);
  for (const { ids: targets, tag, line } of classLines) {
    if (!model.tags.some((item) => item.id === tag)) throw new SourceError(`정의되지 않은 표시예요: ${tag}`, line);
    for (const id of targets) {
      if (!ids.has(id)) throw new SourceError(`없는 단계나 줄이에요: ${id}`, line);
      const list = model.tagsOf.get(id) || [];
      if (list.includes(tag)) throw new SourceError(`표시가 두 번 붙었어요: ${id}`, line);
      model.tagsOf.set(id, [...list, tag]);
    }
  }
  for (const [id, { line }] of model.summaries) if (!ids.has(id)) throw new SourceError(`없는 단계나 줄의 설명이에요: ${id}`, line);
  for (const item of [...model.steps, ...model.arrows, ...model.tags]) delete item.line;
  model.summaries = new Map([...model.summaries].map(([id, { summary }]) => [id, summary]));
  return model;
}

const q = (text) => JSON.stringify(text);
const tagOrder = (model, tagId) => model.tags.findIndex((tag) => tag.id === tagId);

export function serializeFlow(model) {
  const out = [`flowchart ${model.direction || 'LR'}`];
  const header = { kind: model.header?.kind || 'user-flow' };
  if (model.header?.title) header.title = model.header.title;
  if (model.header?.description) header.description = model.header.description;
  out.push(`  %% sm-map: ${JSON.stringify(header)}`);
  const shapeText = (step) => (step.shape === 'milestone' ? `([${q(step.label)}])` : step.shape === 'decision' ? `{${q(step.label)}}` : `[${q(step.label)}]`);
  for (const lane of model.lanes) {
    out.push(`  subgraph ${lane.id}[${q(lane.title)}]`);
    if (lane.direction) out.push(`    direction ${lane.direction}`);
    for (const step of model.steps.filter((item) => item.lane === lane.id)) out.push(`    ${step.id}${shapeText(step)}`);
    out.push('  end');
  }
  for (const step of model.steps.filter((item) => item.lane == null)) out.push(`  ${step.id}${shapeText(step)}`);
  if (model.arrows.length) out.push('');
  for (const arrow of model.arrows) out.push(`  ${arrow.source} ${ARROW_TEXT[arrow.style]}${arrow.label ? `|${q(arrow.label)}|` : ''} ${arrow.target}`);
  if (model.tags.length) out.push('');
  for (const tag of model.tags) out.push(`  classDef ${tag.id} fill:${tag.fill},stroke:${tag.stroke},color:${tag.textColor},stroke-width:${tag.strokeWidth}px${tag.strokeDasharray ? `,stroke-dasharray:${tag.strokeDasharray}` : ''}`);
  const declarationOrder = [...model.lanes.map((lane) => lane.id),
    ...model.lanes.flatMap((lane) => model.steps.filter((step) => step.lane === lane.id).map((step) => step.id)),
    ...model.steps.filter((step) => step.lane == null).map((step) => step.id)];
  for (const tag of model.tags) {
    const users = declarationOrder.filter((id) => (model.tagsOf.get(id) || []).includes(tag.id));
    if (users.length) out.push(`  class ${users.join(',')} ${tag.id}`);
  }
  const summaryIds = declarationOrder.filter((id) => model.summaries.get(id));
  if (summaryIds.length) out.push('');
  for (const id of summaryIds) out.push(`  %% sm-block: ${id}|${JSON.stringify({ summary: model.summaries.get(id) })}`);
  if (model.tags.length) out.push('');
  for (const tag of model.tags) out.push(`  %% mlc-legend: ${tag.id}|${tag.label}|${tag.description}`);
  return `${out.join('\n')}\n`;
}

export function graphOf(model) {
  const tagsOf = (id) => [...(model.tagsOf.get(id) || [])].sort((a, b) => tagOrder(model, a) - tagOrder(model, b));
  const withSummary = (id, value) => (model.summaries.get(id) ? { ...value, summary: model.summaries.get(id) } : value);
  const map = { kind: model.header?.kind || 'user-flow' };
  if (model.header?.title) map.title = model.header.title;
  if (model.header?.description) map.description = model.header.description;
  return {
    map,
    direction: model.direction || 'LR',
    lanes: model.lanes.map((lane) => withSummary(lane.id, { id: lane.id, title: lane.title, ...(lane.direction ? { direction: lane.direction } : {}), tags: tagsOf(lane.id) })),
    steps: [...model.lanes.flatMap((lane) => model.steps.filter((step) => step.lane === lane.id)), ...model.steps.filter((step) => step.lane == null)]
      .map((step) => withSummary(step.id, { id: step.id, label: step.label, shape: step.shape, lane: step.lane, tags: tagsOf(step.id) })),
    arrows: model.arrows.map((arrow) => ({ source: arrow.source, target: arrow.target, style: arrow.style, ...(arrow.label ? { label: arrow.label } : {}) })),
    tags: model.tags.map(({ id, label, description, fill, stroke, textColor, strokeWidth, strokeDasharray }) => ({ id, label, description, fill, stroke, textColor, strokeWidth, ...(strokeDasharray ? { strokeDasharray } : {}) })),
  };
}

export class OperationError extends Error {
  constructor(message, line) { super(message); this.line = line; }
}

const fail = (message) => { throw new OperationError(message); };
const clone = (model) => ({ ...model, header: model.header ? { ...model.header } : null, lanes: model.lanes.map((lane) => ({ ...lane })),
  steps: model.steps.map((step) => ({ ...step })), arrows: model.arrows.map((arrow) => ({ ...arrow })), tags: model.tags.map((tag) => ({ ...tag })),
  tagsOf: new Map([...model.tagsOf].map(([id, list]) => [id, [...list]])), summaries: new Map(model.summaries) });

function nextId(model, prefix) {
  const used = new Set([...model.lanes.map((lane) => lane.id), ...model.steps.map((step) => step.id)]);
  let n = 1; while (used.has(`${prefix}-${n}`)) n += 1; return `${prefix}-${n}`;
}
const cleanText = (value, limit, name) => {
  const text = String(value ?? '').trim();
  if (!text) fail(`${name}을 입력해 주세요.`);
  if (text.length > limit) fail(`${name}은 ${limit}자까지 쓸 수 있어요.`);
  if (text.includes('"')) fail(`${name}에는 큰따옴표를 쓸 수 없어요.`);
  return text;
};
function setTags(model, id, tags) {
  if (!Array.isArray(tags)) return;
  for (const tag of tags) if (!model.tags.some((item) => item.id === tag)) fail('없는 표시예요.');
  if (new Set(tags).size !== tags.length) fail('같은 표시를 두 번 붙일 수 없어요.');
  if (tags.length) model.tagsOf.set(id, [...tags]); else model.tagsOf.delete(id);
}
function setSummary(model, id, summary) {
  if (summary === undefined) return;
  if (summary === null || !String(summary).trim()) { model.summaries.delete(id); return; }
  if (String(summary).length > 4000) fail('설명은 4,000자까지 쓸 수 있어요.');
  model.summaries.set(id, String(summary).trim());
}
function placeStep(model, step, { after, before }) {
  model.steps = model.steps.filter((item) => item.id !== step.id);
  const anchor = after ?? before;
  if (anchor != null) {
    const index = model.steps.findIndex((item) => item.id === anchor);
    if (index < 0 || model.steps[index].lane !== step.lane) fail('같은 줄에 있는 단계 옆에만 둘 수 있어요.');
    model.steps.splice(after != null ? index + 1 : index, 0, step);
    return;
  }
  const last = model.steps.findLastIndex((item) => item.lane === step.lane);
  model.steps.splice(last < 0 ? model.steps.length : last + 1, 0, step);
}
const findStep = (model, id) => model.steps.find((step) => step.id === id) || fail('없는 단계예요.');
const findLane = (model, id) => model.lanes.find((lane) => lane.id === id) || fail('없는 참여자예요.');
const findArrow = (model, source, target) => model.arrows.find((arrow) => arrow.source === source && arrow.target === target) || fail('없는 화살표예요.');

export function applyOperation(input, operation) {
  const model = clone(input);
  switch (operation.type) {
    case 'addStep': {
      if (operation.lane != null) findLane(model, operation.lane);
      const id = operation.id || nextId(model, 'step');
      if (model.steps.some((step) => step.id === id) || model.lanes.some((lane) => lane.id === id)) fail('이미 있는 이름이에요.');
      const step = { id, label: cleanText(operation.label, 200, '단계 이름'), shape: operation.shape || 'action', lane: operation.lane ?? null };
      placeStep(model, step, operation);
      setTags(model, id, operation.tags); setSummary(model, id, operation.summary);
      if (operation.splice) {
        const old = findArrow(model, operation.splice.source, operation.splice.target);
        const index = model.arrows.indexOf(old);
        model.arrows.splice(index, 1, { ...old, target: id }, { source: id, target: old.target, style: 'next' });
      } else if (operation.connectFrom) {
        findStep(model, operation.connectFrom);
        model.arrows.push({ source: operation.connectFrom, target: id, style: 'next' });
      }
      return model;
    }
    case 'updateStep': {
      const step = findStep(model, operation.id);
      if (operation.label !== undefined) step.label = cleanText(operation.label, 200, '단계 이름');
      if (operation.shape !== undefined) { if (!['action', 'decision', 'milestone'].includes(operation.shape)) fail('모양을 고를 수 없어요.'); step.shape = operation.shape; }
      setTags(model, step.id, operation.tags); setSummary(model, step.id, operation.summary);
      return model;
    }
    case 'moveStep': {
      const step = findStep(model, operation.id);
      if (operation.lane != null) findLane(model, operation.lane);
      step.lane = operation.lane ?? null;
      placeStep(model, step, operation);
      return model;
    }
    case 'deleteSteps': {
      const ids = new Set(operation.ids || []);
      for (const id of ids) findStep(model, id);
      for (const id of ids) {
        const incoming = model.arrows.filter((arrow) => arrow.target === id);
        const outgoing = model.arrows.filter((arrow) => arrow.source === id);
        model.arrows = model.arrows.filter((arrow) => arrow.source !== id && arrow.target !== id);
        if (operation.bridge !== false && incoming.length === 1 && outgoing.length === 1) {
          const [from] = incoming; const [to] = outgoing;
          if (from.source !== to.target && !model.arrows.some((arrow) => arrow.source === from.source && arrow.target === to.target)) {
            model.arrows.push({ source: from.source, target: to.target, style: from.style, ...(from.label ? { label: from.label } : {}) });
          }
        }
        model.steps = model.steps.filter((step) => step.id !== id);
        model.tagsOf.delete(id); model.summaries.delete(id);
      }
      return model;
    }
    case 'addArrow': {
      findStep(model, operation.source); findStep(model, operation.target);
      if (operation.source === operation.target) fail('같은 단계끼리는 이을 수 없어요.');
      if (model.arrows.some((arrow) => arrow.source === operation.source && arrow.target === operation.target)) fail('이미 이어져 있어요.');
      const arrow = { source: operation.source, target: operation.target, style: operation.style || 'next' };
      if (operation.label) arrow.label = cleanText(operation.label, 120, '화살표 글자');
      model.arrows.push(arrow);
      return model;
    }
    case 'updateArrow': {
      const arrow = findArrow(model, operation.source, operation.target);
      if (operation.style !== undefined) arrow.style = operation.style;
      if (operation.label === null || operation.label === '') delete arrow.label;
      else if (operation.label !== undefined) arrow.label = cleanText(operation.label, 120, '화살표 글자');
      if (operation.newSource) { findStep(model, operation.newSource); arrow.source = operation.newSource; }
      if (operation.newTarget) { findStep(model, operation.newTarget); arrow.target = operation.newTarget; }
      if (arrow.source === arrow.target) fail('같은 단계끼리는 이을 수 없어요.');
      if (model.arrows.filter((item) => item.source === arrow.source && item.target === arrow.target).length > 1) fail('이미 이어져 있어요.');
      return model;
    }
    case 'removeArrow': {
      const arrow = findArrow(model, operation.source, operation.target);
      model.arrows = model.arrows.filter((item) => item !== arrow);
      return model;
    }
    case 'addLane': {
      const id = operation.id || nextId(model, 'lane');
      if (model.steps.some((step) => step.id === id) || model.lanes.some((lane) => lane.id === id)) fail('이미 있는 이름이에요.');
      const lane = { id, title: cleanText(operation.title, 80, '참여자 이름') };
      if (operation.after === undefined) model.lanes.push(lane);
      else if (operation.after === null) model.lanes.unshift(lane);
      else model.lanes.splice(model.lanes.indexOf(findLane(model, operation.after)) + 1, 0, lane);
      setTags(model, id, operation.tags); setSummary(model, id, operation.summary);
      return model;
    }
    case 'updateLane': {
      const lane = findLane(model, operation.id);
      if (operation.title !== undefined) lane.title = cleanText(operation.title, 80, '참여자 이름');
      setTags(model, lane.id, operation.tags); setSummary(model, lane.id, operation.summary);
      return model;
    }
    case 'moveLane': {
      const lane = findLane(model, operation.id);
      model.lanes = model.lanes.filter((item) => item !== lane);
      if (operation.after === null) model.lanes.unshift(lane);
      else model.lanes.splice(model.lanes.indexOf(findLane(model, operation.after)) + 1, 0, lane);
      return model;
    }
    case 'deleteLane': {
      const lane = findLane(model, operation.id);
      const owned = model.steps.filter((step) => step.lane === lane.id).map((step) => step.id);
      if (owned.length && !operation.withSteps) fail('단계가 있는 참여자는 단계와 함께 지워야 해요.');
      model.steps = model.steps.filter((step) => step.lane !== lane.id);
      model.arrows = model.arrows.filter((arrow) => !owned.includes(arrow.source) && !owned.includes(arrow.target));
      for (const id of [...owned, lane.id]) { model.tagsOf.delete(id); model.summaries.delete(id); }
      model.lanes = model.lanes.filter((item) => item !== lane);
      return model;
    }
    case 'upsertTag': {
      const tag = operation.tag || fail('표시가 없어요.');
      if (!ID.test(tag.id || '')) fail('표시 이름을 쓸 수 없어요.');
      const value = { id: tag.id, label: cleanText(tag.label, 40, '표시 이름'), description: String(tag.description || '').replace(/\|/g, '/'), fill: tag.fill, stroke: tag.stroke, textColor: tag.textColor, strokeWidth: tag.strokeWidth ?? 1, ...(tag.strokeDasharray ? { strokeDasharray: tag.strokeDasharray } : {}) };
      const index = model.tags.findIndex((item) => item.id === tag.id);
      if (index < 0) model.tags.push(value); else model.tags[index] = value;
      return model;
    }
    case 'deleteTag': {
      if (!model.tags.some((tag) => tag.id === operation.id)) fail('없는 표시예요.');
      model.tags = model.tags.filter((tag) => tag.id !== operation.id);
      for (const [id, list] of model.tagsOf) { const next = list.filter((tag) => tag !== operation.id); if (next.length) model.tagsOf.set(id, next); else model.tagsOf.delete(id); }
      return model;
    }
    case 'setMapHeader': {
      model.header = { ...(model.header || { kind: 'user-flow' }) };
      for (const key of ['title', 'description']) {
        if (operation[key] === null || operation[key] === '') delete model.header[key];
        else if (operation[key] !== undefined) model.header[key] = cleanText(operation[key], key === 'title' ? 80 : 400, key === 'title' ? '지도 이름' : '지도 설명');
      }
      return model;
    }
    case 'replaceSource': {
      try { return parseFlow(operation.source); } catch (error) {
        if (error instanceof SourceError) throw new OperationError(error.message, error.line);
        throw error;
      }
    }
    default: return fail('지원하지 않는 작업이에요.');
  }
}
