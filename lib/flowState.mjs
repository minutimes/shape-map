import { sha256Hex } from './sha256.mjs';

/*
 * Collaboration state of flow map steps, shared by the server and the browser.
 * A step's fingerprint covers what the step says and how it connects; memos and
 * review markers do not count. Colors are derived exactly as for features maps
 * (docs/SHAPE-MAP.md "Derived colors"): red proposal, yellow unresolved concern,
 * green review that still matches, blue difference between the last two turns.
 */

export const FLOW_STEP_STATUSES = Object.freeze(['planned', 'concern', 'verified', 'changed']);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function arrowContent(arrow) {
  return { source: arrow.source, target: arrow.target, style: arrow.style, ...(arrow.label !== undefined ? { label: arrow.label } : {}) };
}

/** The parts of a step that its review vouches for. `graph` supplies its arrows. */
export function flowStepContent(step, graph) {
  const arrows = (graph?.arrows || []).filter((arrow) => arrow.source === step.id || arrow.target === step.id).map(arrowContent);
  return {
    label: step.label,
    shape: step.shape,
    lane: step.lane ?? null,
    tags: [...(step.tags || [])],
    ...(step.summary !== undefined ? { summary: step.summary } : {}),
    ...(step.proposal !== undefined ? { proposal: step.proposal } : {}),
    ...(step.features !== undefined ? { features: step.features } : {}),
    ...(arrows.length ? { arrows } : {}),
  };
}

export function flowStepFingerprint(step, graph) {
  return sha256Hex(JSON.stringify(stable(flowStepContent(step, graph))));
}

/** Names of the content parts that differ between two versions of one step. */
export function flowStepChanges(before, beforeGraph, after, afterGraph) {
  const a = flowStepContent(before, beforeGraph);
  const b = flowStepContent(after, afterGraph);
  return ['label', 'shape', 'lane', 'tags', 'summary', 'proposal', 'features', 'arrows']
    .filter((field) => JSON.stringify(stable(a[field])) !== JSON.stringify(stable(b[field])));
}

export function hasValidReview(step, graph) {
  return step.status === 'verified' && Boolean(step.review) && step.review.fingerprint === flowStepFingerprint(step, graph);
}

/** Derived state of one step; `status` is neutral, planned, concern, verified, or changed. */
export function flowStepState(graph, step) {
  const comments = step.comments || [];
  const unresolved = comments.filter((comment) => !comment.resolved);
  const turns = graph.turns || [];
  const latestTurn = turns.at(-1);
  const previousTurn = turns.at(-2);
  const latest = latestTurn?.steps?.find((candidate) => candidate.id === step.id);
  const baseline = previousTurn?.steps?.find((candidate) => candidate.id === step.id);
  const fingerprint = flowStepFingerprint(step, graph);
  const currentMatchesLatest = latest !== undefined && flowStepFingerprint(latest, latestTurn) === fingerprint;
  const changedSinceBaseline = Boolean(turns.length >= 2 && latest && currentMatchesLatest
    && (!baseline || flowStepFingerprint(baseline, previousTurn) !== flowStepFingerprint(latest, latestTurn)));
  let status = 'neutral';
  if (step.proposal !== undefined || step.status === 'planned') status = 'planned';
  else if (step.status === 'concern' || unresolved.some((comment) => comment.kind === 'concern')) status = 'concern';
  else if (step.status === 'verified' && step.review?.fingerprint === fingerprint) status = 'verified';
  else if (changedSinceBaseline) status = 'changed';
  return {
    status,
    fingerprint,
    commentCount: comments.length,
    unresolvedCount: unresolved.length,
    concernCount: unresolved.filter((comment) => comment.kind === 'concern').length,
    hasProposal: step.proposal !== undefined,
    changedSinceBaseline,
    addedInLastTurn: changedSinceBaseline && !baseline,
    lastTurnChanges: changedSinceBaseline && baseline ? flowStepChanges(baseline, previousTurn, latest, latestTurn) : [],
  };
}

export function flowStepStates(graph) {
  return new Map((graph?.steps || []).map((step) => [step.id, flowStepState(graph, step)]));
}

/** Removes reviews whose step content changed; verified becomes the default (absent) status. */
export function invalidateStaleFlowReviews(graph) {
  for (const step of graph.steps) {
    if (!step.review || step.review.fingerprint === flowStepFingerprint(step, graph)) continue;
    delete step.review;
    if (step.status === 'verified') delete step.status;
  }
  return graph;
}

/** `map#id` key of a feature link. */
export const featureLinkKey = (link) => `${link.map}#${link.id}`;

/** Lanes take memos only: an unresolved concern makes a lane yellow (needs attention). */
export function flowLaneState(lane) {
  const comments = lane.comments || [];
  const unresolved = comments.filter((comment) => !comment.resolved);
  const concernCount = unresolved.filter((comment) => comment.kind === 'concern').length;
  return { status: concernCount ? 'concern' : 'neutral', commentCount: comments.length, unresolvedCount: unresolved.length, concernCount };
}

export function flowLaneStates(graph) {
  return new Map((graph?.lanes || []).map((lane) => [lane.id, flowLaneState(lane)]));
}

/**
 * Reading one recorded turn. Red, yellow, and green are what that turn itself
 * recorded. With `compare: 'previous'`, blue marks steps that differ from the
 * previous recorded turn; the first turn has nothing to compare with. With
 * `compare: 'current'`, nothing turns blue (the live map is not a recorded
 * turn): a neutral mark names steps that differ from the live map instead.
 * `removed` lists base steps missing from the turn: removed in this turn, or
 * added to the live map since.
 */
export function flowTurnView(turn, { previous = null, live = null, compare = 'previous', map = {}, direction = 'LR' } = {}) {
  const graph = { map, direction, lanes: turn.lanes, steps: turn.steps, arrows: turn.arrows, tags: turn.tags };
  const base = compare === 'current' ? live : previous;
  const baseSteps = new Map((base?.steps || []).map((step) => [step.id, step]));
  const states = new Map();
  for (const step of graph.steps) {
    const recorded = flowStepState(graph, step);
    const before = base ? baseSteps.get(step.id) : undefined;
    const changes = !base ? [] : before
      ? (compare === 'current' ? flowStepChanges(step, graph, before, base) : flowStepChanges(before, base, step, graph))
      : null;
    const differs = Boolean(base) && (!before || changes.length > 0);
    const status = compare === 'previous' && differs && recorded.status === 'neutral' ? 'changed' : recorded.status;
    states.set(step.id, { ...recorded, status, compare, base: Boolean(base), before: before || null, differs, added: Boolean(base) && !before, changes: changes || [],
      mark: compare === 'current' && differs ? (before ? '지금과 다름' : '지금은 없음') : null });
  }
  const ids = new Set(graph.steps.map((step) => step.id));
  const removed = base ? base.steps.filter((step) => !ids.has(step.id)) : [];
  return { graph, states, laneStates: flowLaneStates(graph), base: Boolean(base), removed };
}
