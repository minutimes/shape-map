// Pure helpers that turn canvas intentions into flow map operations.
import { sourceProblemReason } from '../mapKinds.js';
import { DASHED_PATTERN, NEW_STEP_LABEL, SHARED_BAND_ID, TAG_PALETTE, TEXT_LIMITS } from './flowConstants.js';

export const arrowKey = (arrow) => `${arrow.source}->${arrow.target}`;

/** One-line text that Mermaid can store: no double quotes, no line breaks. */
export function cleanLabel(text, limit = TEXT_LIMITS.step) {
  let open = true;
  const value = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, () => { const mark = open ? '“' : '”'; open = !open; return mark; }).trim();
  return value.slice(0, limit);
}

/** Free text such as a description: line breaks stay, quotes become typographic. */
export function cleanSummary(text) {
  let open = true;
  return String(text ?? '').replace(/"/g, () => { const mark = open ? '“' : '”'; open = !open; return mark; }).trim().slice(0, TEXT_LIMITS.summary);
}

export function laneSteps(graph, laneId) {
  return graph.steps.filter((step) => (step.lane ?? null) === (laneId ?? null));
}

export function laneTitle(graph, laneId, sharedTitle) {
  if (laneId == null) return sharedTitle;
  return graph.lanes.find((lane) => lane.id === laneId)?.title ?? sharedTitle;
}

export function newIdAfter(before, after, collection = 'steps') {
  const known = new Set((before?.[collection] || []).map((item) => item.id));
  return (after?.[collection] || []).find((item) => !known.has(item.id))?.id ?? null;
}

export function nextStepOperation(graph, stepId, label = NEW_STEP_LABEL) {
  const step = graph.steps.find((item) => item.id === stepId);
  if (!step) return null;
  return { type: 'addStep', lane: step.lane ?? null, label, after: step.id, connectFrom: step.id };
}

export function laneStepOperation(graph, laneId, label = NEW_STEP_LABEL) {
  const operation = { type: 'addStep', lane: laneId ?? null, label };
  const last = laneSteps(graph, laneId).at(-1);
  if (last) operation.after = last.id;
  return operation;
}

/** Inserts a step on an arrow; it joins the source's participant, right after the source. */
export function insertOnArrowOperation(graph, arrow, label = NEW_STEP_LABEL) {
  const source = graph.steps.find((step) => step.id === arrow.source);
  if (!source) return null;
  return { type: 'addStep', lane: source.lane ?? null, label, after: source.id, splice: { source: arrow.source, target: arrow.target } };
}

/** Moves a step one place earlier or later among its participant's steps. */
export function reorderStepOperation(graph, stepId, direction) {
  const step = graph.steps.find((item) => item.id === stepId);
  if (!step) return null;
  const list = laneSteps(graph, step.lane);
  const index = list.findIndex((item) => item.id === stepId);
  if (direction === 'earlier' && index > 0) return { type: 'moveStep', id: stepId, lane: step.lane ?? null, before: list[index - 1].id };
  if (direction === 'later' && index < list.length - 1) return { type: 'moveStep', id: stepId, lane: step.lane ?? null, after: list[index + 1].id };
  return null;
}

export function changeLaneOperation(graph, stepId, laneId) {
  const step = graph.steps.find((item) => item.id === stepId);
  if (!step || (step.lane ?? null) === (laneId ?? null)) return null;
  const operation = { type: 'moveStep', id: stepId, lane: laneId ?? null };
  const last = laneSteps(graph, laneId).at(-1);
  if (last) operation.after = last.id;
  return operation;
}

export function moveLaneOperation(graph, laneId, direction) {
  const index = graph.lanes.findIndex((lane) => lane.id === laneId);
  if (index < 0) return null;
  if (direction === 'up' && index > 0) return { type: 'moveLane', id: laneId, after: index > 1 ? graph.lanes[index - 2].id : null };
  if (direction === 'down' && index < graph.lanes.length - 1) return { type: 'moveLane', id: laneId, after: graph.lanes[index + 1].id };
  return null;
}

export function addLaneOperation(graph, afterLaneId, title) {
  const operation = { type: 'addLane', title };
  if (afterLaneId !== undefined) operation.after = afterLaneId;
  return operation;
}

export function deleteLanePlan(graph, laneId) {
  const count = laneSteps(graph, laneId).length;
  return { needsConfirmation: count > 0, stepCount: count, operation: { type: 'deleteLane', id: laneId, ...(count ? { withSteps: true } : {}) } };
}

export function connectOperation(graph, source, target, style = 'next') {
  if (!source || !target || source === target) return { error: '같은 단계끼리는 이을 수 없어요.' };
  if (!graph.steps.some((step) => step.id === source) || !graph.steps.some((step) => step.id === target)) return { error: '없는 단계예요.' };
  if (graph.arrows.some((arrow) => arrow.source === source && arrow.target === target)) return { error: '이미 이어져 있어요.' };
  return { operation: { type: 'addArrow', source, target, style } };
}

export function reverseArrowOperation(graph, arrow) {
  if (graph.arrows.some((item) => item.source === arrow.target && item.target === arrow.source)) return { error: '반대 방향 화살표가 이미 있어요.' };
  return { operation: { type: 'updateArrow', source: arrow.source, target: arrow.target, newSource: arrow.target, newTarget: arrow.source } };
}

export function toggleTag(tags = [], tagId, order = []) {
  const next = tags.includes(tagId) ? tags.filter((id) => id !== tagId) : [...tags, tagId];
  const rank = (id) => { const index = order.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  return next.sort((a, b) => rank(a) - rank(b));
}

export function newTagId(graph) {
  const used = new Set((graph.tags || []).map((tag) => tag.id));
  let n = 1;
  while (used.has(`tag-${n}`)) n += 1;
  return `tag-${n}`;
}

export function paletteIndexFor(tag) {
  const index = TAG_PALETTE.findIndex((entry) => entry.fill.toUpperCase() === String(tag?.fill).toUpperCase() && entry.stroke.toUpperCase() === String(tag?.stroke).toUpperCase());
  return index;
}

export function tagOperation({ id, label, description = '', paletteIndex = 0, strokeWidth = 1, dashed = false, base = null }) {
  const color = TAG_PALETTE[paletteIndex] || (base ? { fill: base.fill, stroke: base.stroke, textColor: base.textColor } : TAG_PALETTE[0]);
  const tag = { id, label: cleanLabel(label, TEXT_LIMITS.tag), description: cleanLabel(description, TEXT_LIMITS.description).replace(/\|/g, '/'),
    fill: color.fill, stroke: color.stroke, textColor: color.textColor, strokeWidth };
  if (dashed) tag.strokeDasharray = base?.strokeDasharray || DASHED_PATTERN;
  return { type: 'upsertTag', tag };
}

export function tagUsage(graph, tagId) {
  return graph.steps.filter((step) => step.tags?.includes(tagId)).length + graph.lanes.filter((lane) => lane.tags?.includes(tagId)).length;
}

/**
 * What to emphasize when one tag is highlighted or one participant is focused.
 * Returns null when nothing is emphasized. Values are 'on', 'near', or 'off'.
 */
export function emphasisFor(graph, { tagId = null, laneId = null } = {}) {
  if (!graph || (!tagId && laneId == null)) return null;
  const laneById = new Map(graph.lanes.map((lane) => [lane.id, lane]));
  const steps = new Map();
  for (const step of graph.steps) {
    let on = true;
    if (tagId) on = step.tags?.includes(tagId) || Boolean(step.lane && laneById.get(step.lane)?.tags?.includes(tagId));
    if (laneId != null) on = on && (step.lane ?? null) === (laneId === SHARED_BAND_ID ? null : laneId);
    steps.set(step.id, on ? 'on' : 'off');
  }
  const arrows = new Map();
  for (const arrow of graph.arrows) {
    const a = steps.get(arrow.source); const b = steps.get(arrow.target);
    arrows.set(arrowKey(arrow), a === 'on' && b === 'on' ? 'on' : a === 'on' || b === 'on' ? 'near' : 'off');
  }
  // Steps one arrow away from a focused participant stay readable.
  if (laneId != null) for (const arrow of graph.arrows) {
    if (steps.get(arrow.source) === 'on' && steps.get(arrow.target) === 'off') steps.set(arrow.target, 'near');
    if (steps.get(arrow.target) === 'on' && steps.get(arrow.source) === 'off') steps.set(arrow.source, 'near');
  }
  const lanes = new Map(graph.lanes.map((lane) => [lane.id, laneId != null ? (lane.id === laneId ? 'on' : 'off')
    : (lane.tags?.includes(tagId) || graph.steps.some((step) => step.lane === lane.id && steps.get(step.id) === 'on') ? 'on' : 'off')]));
  return { steps, arrows, lanes };
}

export function stepRelations(graph, stepId) {
  const label = (id) => graph.steps.find((step) => step.id === id)?.label ?? id;
  return {
    incoming: graph.arrows.filter((arrow) => arrow.target === stepId).map((arrow) => ({ arrow, other: arrow.source, label: label(arrow.source) })),
    outgoing: graph.arrows.filter((arrow) => arrow.source === stepId).map((arrow) => ({ arrow, other: arrow.target, label: label(arrow.target) })),
  };
}

export function connectableTargets(graph, sourceId) {
  const linked = new Set(graph.arrows.filter((arrow) => arrow.source === sourceId).map((arrow) => arrow.target));
  return graph.steps.filter((step) => step.id !== sourceId && !linked.has(step.id));
}

export function pushHistory(stack, entry, limit = 100) {
  if (!entry || entry.before === entry.after) return stack;
  return [...stack, entry].slice(-limit);
}

/** Plain Korean for a failed save; the server's own words stay in `detail`. */
export function describeError(error, kind) {
  const code = error?.body?.code;
  const line = error?.body?.details?.line ?? error?.body?.line;
  if (error?.status === 409 || code === 'revision_conflict') return { kind: 'conflict', text: '다른 곳에서 지도가 바뀌었어요. 쓰던 내용은 그대로 두었으니 확인하고 다시 저장해 주세요.' };
  if (code === 'invalid_source') return { kind: 'invalid', text: '원문에 고칠 곳이 있어서 지금은 저장할 수 없어요.' };
  if (code === 'read_only_map') return { kind: 'readonly', text: '이 지도는 읽기만 할 수 있어요.' };
  if (error?.status === 422) {
    const { reason, detail } = sourceProblemReason(error?.body?.message || error?.message, kind);
    const text = line ? `${line}번째 줄: ${reason || '지도 형식에 맞지 않는 내용이 있어요.'}` : reason || '입력한 내용을 저장할 수 없어요.';
    return { kind: 'validation', line, text, reason, detail };
  }
  if (error?.status === 404) return { kind: 'missing', text: '지도를 찾을 수 없어요.' };
  return { kind: 'offline', text: '연결이 끊겨 저장하지 못했어요. 쓰던 내용은 그대로 있어요.' };
}
