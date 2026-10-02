import { isDeepStrictEqual } from 'node:util';
import { validationError } from './errors.mjs';
import { flowStepChanges } from './flowState.mjs';

const short = (text, length = 220) => {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
};

function requestLines(request) {
  return [`문제: ${request.problem?.trim() || '아래 의견에서 문제를 확인하고, 모호한 점만 질문해 주세요.'}`,
    `목적: ${request.purpose?.trim() || '사용자가 원하는 결과를 기획문답으로 확인해 주세요.'}`,
    `성공 기준: ${request.successCriteria?.trim() || '무엇이 달라지면 해결인지 사용자와 정해 주세요.'}`];
}

function closingLines(request, keepIds) {
  return ['원본 지도와 관련 레포를 먼저 읽으세요. 기획문답(decision-interview) 스킬을 적용하세요. 없으면 skills/shape-map-facilitation/SKILL.md를 사용하세요.',
    '자료에서 답을 찾을 수 없는 의도·우선순위만 질문하세요. 선택이 필요하면 가능한 대안과 장단점, 추천 이유를 짧게 설명하세요.',
    '문제·목적·성공 기준을 정리해 최종 수정안을 확정하세요. 구현 방법은 수행하는 AI가 판단하세요.',
    request.approved ? '사용자가 위 요청을 승인했습니다. 해결 기준이 명확하면 실제로 구현하고 검증하세요. 새로 드러난 중요한 결정만 다시 물으세요.'
      : '아직 실행 승인 전입니다. 필요한 문답을 마친 뒤 최종 수정안을 보여주고, 사용자가 승인하면 실제로 구현·검증하세요.',
    `구현 결과와 근거를 지도에 반영하고 ${keepIds} 사람 검수 완료는 사용자의 실제 확인 뒤에만 표시하세요.`];
}

/** A handoff references the canonical map instead of serializing it again. */
export function discussionBrief(snapshot, focusId, request = {}) {
  const graph = snapshot.graph;
  const focus = focusId && graph.nodes.find((node) => node.id === focusId);
  if (focusId && !focus) throw validationError('The requested feature does not exist.');
  const scoped = new Set(focus ? [focus.id] : graph.nodes.map((node) => node.id));
  if (focus) {
    let changed = true;
    while (changed) {
      changed = false;
      graph.nodes.forEach((node) => { if (scoped.has(node.parentId) && !scoped.has(node.id)) { scoped.add(node.id); changed = true; } });
    }
  }
  const lastTurn = graph.turns?.at(-1);
  const baseline = new Map((lastTurn?.nodes || []).map((node) => [node.id, node]));
  const currentIds = new Set(graph.nodes.map((node) => node.id));
  const childIds = (nodes) => {
    const children = new Map();
    (nodes || []).forEach((node) => { if (!children.has(node.parentId)) children.set(node.parentId, []); children.get(node.parentId).push(node.id); });
    return children;
  };
  const currentChildren = childIds(graph.nodes); const previousChildren = childIds(lastTurn?.nodes);
  const incident = (links, id) => (links || []).filter((link) => link.source === id || link.target === id);
  const pending = graph.nodes.filter((node) => scoped.has(node.id)).map((node) => {
    const previous = baseline.get(node.id);
    const proposal = node.proposal && (focus || !isDeepStrictEqual(node.proposal, previous?.proposal)) ? node.proposal : null;
    const previousComments = new Map((previous?.block?.comments || []).map((comment) => [comment.id, comment]));
    const comments = (node.block?.comments || []).filter((comment) => !comment.resolved && (focus || !isDeepStrictEqual(comment, previousComments.get(comment.id))));
    const fields = ['label', 'parentId', 'task', 'workflow'].filter((field) => previous && !isDeepStrictEqual(node[field], previous[field]));
    if (previous && !isDeepStrictEqual(node.block?.summary, previous.block?.summary)) fields.push('설명');
    if (previous && !isDeepStrictEqual(node.block?.status, previous.block?.status)) fields.push('상태');
    if (previous && !isDeepStrictEqual(incident(graph.links, node.id), incident(lastTurn.links, node.id))) fields.push('연결');
    if (previous && !isDeepStrictEqual(currentChildren.get(node.id), previousChildren.get(node.id))) fields.push('내부 구성');
    return { node, proposal, comments, fields, added: baseline.size > 0 && !previous };
  }).filter((item) => item.proposal || item.comments.length || item.fields.length || item.added);
  const lines = [`Shape map · ${short(graph.nodes.find((node) => !node.parentId)?.label, 100)}`,
    `지도: ${snapshot.mapPath} (버전 ${snapshot.revision})`,
    focus ? `범위: [${focus.id}] ${short(focus.label, 140)}와 내부 기능` : '범위: 마지막 기록 이후의 변경·새 메모·수정안', '',
    ...requestLines(request), ''];
  for (const { node, proposal, comments, fields, added } of pending.slice(0, 12)) {
    lines.push(`[${node.id}] ${short(node.label, 100)}`);
    if (added) lines.push('- 지도에 새로 추가됨');
    if (fields.length) lines.push(`- 지도에서 바뀐 항목: ${fields.join(', ')}. 원본에서 확인하세요.`);
    if (proposal) for (const [field, label, requestField] of [['reason', '문제', 'problem'], ['purpose', '목적', 'purpose'], ['logic', '원하는 변화'], ['successCriteria', '성공 기준', 'successCriteria']]) {
      if (proposal[field] && (!requestField || proposal[field].trim() !== request[requestField]?.trim())) lines.push(`- ${label}: ${short(proposal[field], 180)}`);
    }
    comments.slice(-2).forEach((comment) => lines.push(`- 사람 메모: ${short(comment.body, 180)}`));
    if (comments.length > 2) lines.push(`- 나머지 메모 ${comments.length - 2}개는 원본에서 읽으세요.`);
    lines.push('');
  }
  if (pending.length > 12) lines.push(`나머지 대상 ${pending.length - 12}개는 원본 지도의 변경·메모·수정안에서 확인하세요.`, '');
  const removed = [...baseline.values()].filter((node) => scoped.has(node.parentId) && !currentIds.has(node.id));
  if (removed.length) lines.push(`지도에서 제거된 기능 ${removed.length}개: ${removed.slice(0, 12).map((node) => `[${node.id}]`).join(' ')}${removed.length > 12 ? ' …' : ''}. 이전 턴과 비교하세요.`, '');
  if (lastTurn && !isDeepStrictEqual(graph.lenses, lastTurn.lenses)) lines.push('지도에 정의된 특성·필터가 바뀌었습니다. 원본과 마지막 턴을 비교하세요.', '');
  if (!pending.length && !removed.length) lines.push(lastTurn ? '이 범위에서 내보낼 새 기능 변경이나 미해결 의견이 없습니다. 위 요청을 기준으로 논의하세요.' : '기록된 턴이 없어 구조 변경은 비교하지 않았습니다. 원본과 위 요청을 기준으로 논의하세요.', '');
  lines.push(...closingLines(request, '기능 ID를 유지하세요.'));
  return { text: lines.join('\n').trimEnd(), mapPath: snapshot.mapPath, revision: snapshot.revision, targetCount: pending.length + removed.length, approved: request.approved === true };
}

const FLOW_FIELD_NAMES = { label: '이름', shape: '모양', lane: '줄', tags: '표시', summary: '설명', proposal: '수정안', features: '연결된 기능', arrows: '화살표' };
const FLOW_KIND_NAMES = { 'user-flow': '유저 플로우', 'system-flow': '시스템 플로우' };

/**
 * A flow map handoff: the request, then only the steps that changed since the
 * last turn or carry a proposal or a new memo (or the one focused step). It names
 * the canonical file, each step's ID, and the features each step links to, so an
 * agent can find the real code without reading a copy of the whole map.
 * `featureLabel(map, id)` returns a label, null when the feature no longer
 * exists, or undefined when it is unknown.
 */
export function flowDiscussionBrief(snapshot, focusId, request = {}, { featureLabel = () => undefined } = {}) {
  const graph = snapshot.graph;
  const focus = focusId ? graph.steps.find((step) => step.id === focusId) : null;
  const focusLane = focusId && !focus ? graph.lanes.find((lane) => lane.id === focusId) : null;
  if (focusId && !focus && !focusLane) throw validationError('The requested step or lane does not exist.');
  const lastTurn = graph.turns?.at(-1);
  const baseline = new Map((lastTurn?.steps || []).map((step) => [step.id, step]));
  const laneTitle = (laneId) => (laneId == null ? '공통 단계' : graph.lanes.find((lane) => lane.id === laneId)?.title || laneId);
  const labelOf = (id) => graph.steps.find((step) => step.id === id)?.label || id;
  const pending = (focus ? [focus] : focusLane ? [] : graph.steps).map((step) => {
    const previous = baseline.get(step.id);
    const proposal = step.proposal && (focus || !isDeepStrictEqual(step.proposal, previous?.proposal)) ? step.proposal : null;
    const previousComments = new Map((previous?.comments || []).map((comment) => [comment.id, comment]));
    const comments = (step.comments || []).filter((comment) => !comment.resolved && (focus || !isDeepStrictEqual(comment, previousComments.get(comment.id))));
    const fields = previous ? flowStepChanges(previous, lastTurn, step, graph).filter((field) => field !== 'proposal').map((field) => FLOW_FIELD_NAMES[field]) : [];
    return { step, proposal, comments, fields, added: Boolean(lastTurn) && !previous };
  }).filter((item) => focus || item.proposal || item.comments.length || item.fields.length || item.added);
  // Lanes carry memos only: list a lane when it has new unresolved memos, or when it is the focus.
  const previousLanes = new Map((lastTurn?.lanes || []).map((lane) => [lane.id, lane]));
  const laneTargets = (focusLane ? [focusLane] : focus ? [] : graph.lanes).map((lane) => {
    const previousComments = new Map((previousLanes.get(lane.id)?.comments || []).map((comment) => [comment.id, comment]));
    const comments = (lane.comments || []).filter((comment) => !comment.resolved && (focusLane || !isDeepStrictEqual(comment, previousComments.get(comment.id))));
    return { lane, comments };
  }).filter((item) => focusLane || item.comments.length);
  const title = graph.map?.title || snapshot.mapPath.split('/').pop().replace(/\.mmd$/, '');
  const lines = [`Shape map · ${short(title, 100)} (${FLOW_KIND_NAMES[graph.map?.kind] || '플로우'})`,
    `지도: ${snapshot.mapPath} (버전 ${snapshot.revision})`,
    focus ? `범위: 단계 [${focus.id}] ${short(focus.label, 140)}` : focusLane ? `범위: 줄 [${focusLane.id}] ${short(focusLane.title, 80)}`
      : '범위: 마지막 기록 이후의 변경·새 메모·수정안', '',
    ...requestLines(request), ''];
  for (const { step, proposal, comments, fields, added } of pending.slice(0, 12)) {
    lines.push(`[${step.id}] ${short(step.label, 100)} · ${short(laneTitle(step.lane), 40)}`);
    if (focus) {
      const near = (ids) => `${ids.slice(0, 6).map((id) => `[${id}] ${short(labelOf(id), 40)}`).join(', ')}${ids.length > 6 ? ' …' : ''}`;
      const before = graph.arrows.filter((arrow) => arrow.target === step.id).map((arrow) => arrow.source);
      const after = graph.arrows.filter((arrow) => arrow.source === step.id).map((arrow) => arrow.target);
      if (before.length) lines.push(`- 앞 단계: ${near(before)}`);
      if (after.length) lines.push(`- 다음 단계: ${near(after)}`);
      if (step.summary) lines.push(`- 설명: ${short(step.summary, 180)}`);
    }
    if (added) lines.push('- 지도에 새로 추가됨');
    if (fields.length) lines.push(`- 지도에서 바뀐 항목: ${fields.join(', ')}. 원본에서 확인하세요.`);
    if (proposal) for (const [field, name, requestField] of [['reason', '문제', 'problem'], ['purpose', '목적', 'purpose'], ['logic', '원하는 변화'], ['successCriteria', '성공 기준', 'successCriteria']]) {
      if (proposal[field] && (!requestField || proposal[field].trim() !== request[requestField]?.trim())) lines.push(`- ${name}: ${short(proposal[field], 180)}`);
    }
    comments.slice(-2).forEach((comment) => lines.push(`- 사람 메모: ${short(comment.body, 180)}`));
    if (comments.length > 2) lines.push(`- 나머지 메모 ${comments.length - 2}개는 원본에서 읽으세요.`);
    const links = step.features || [];
    if (links.length) {
      const named = links.slice(0, 6).map((link) => {
        const found = featureLabel(link.map, link.id);
        return `docs/maps/${link.map} [${link.id}]${found ? ` ${short(found, 60)}` : found === null ? ' (찾을 수 없는 기능)' : ''}`;
      });
      lines.push(`- 연결된 기능: ${named.join(', ')}${links.length > 6 ? ` 외 ${links.length - 6}개` : ''}`);
    }
    lines.push('');
  }
  if (pending.length > 12) lines.push(`나머지 대상 ${pending.length - 12}개는 원본 지도의 변경·메모·수정안에서 확인하세요.`, '');
  for (const { lane, comments } of laneTargets.slice(0, 12)) {
    lines.push(`[${lane.id}] ${short(lane.title, 80)} · 줄`);
    if (focusLane) {
      const steps = graph.steps.filter((step) => step.lane === lane.id);
      if (steps.length) lines.push(`- 이 줄의 단계: ${steps.slice(0, 8).map((step) => `[${step.id}] ${short(step.label, 40)}`).join(', ')}${steps.length > 8 ? ' …' : ''}`);
      if (lane.summary) lines.push(`- 설명: ${short(lane.summary, 180)}`);
    }
    comments.slice(-2).forEach((comment) => lines.push(`- 사람 메모: ${short(comment.body, 180)}`));
    if (comments.length > 2) lines.push(`- 나머지 메모 ${comments.length - 2}개는 원본에서 읽으세요.`);
    lines.push('');
  }
  const currentIds = new Set(graph.steps.map((step) => step.id));
  const removed = focus || focusLane ? [] : [...baseline.values()].filter((step) => !currentIds.has(step.id));
  if (removed.length) lines.push(`지도에서 제거된 단계 ${removed.length}개: ${removed.slice(0, 12).map((step) => `[${step.id}]`).join(' ')}${removed.length > 12 ? ' …' : ''}. 이전 턴과 비교하세요.`, '');
  const laneShape = (lanes) => lanes.map(({ id, title: laneName }) => ({ id, title: laneName }));
  if (!focus && !focusLane && lastTurn && !isDeepStrictEqual(laneShape(graph.lanes), laneShape(lastTurn.lanes))) {
    lines.push('지도의 줄(참여자·영역) 구성이 바뀌었습니다. 원본과 마지막 턴을 비교하세요.', '');
  }
  if (!pending.length && !removed.length && !laneTargets.length) {
    lines.push(lastTurn ? '이 범위에서 내보낼 새 단계 변경이나 미해결 의견이 없습니다. 위 요청을 기준으로 논의하세요.'
      : '기록된 턴이 없어 흐름 변경은 비교하지 않았습니다. 원본과 위 요청을 기준으로 논의하세요.', '');
  }
  lines.push(...closingLines(request, '단계 ID를 유지하세요. 단계에 연결된 기능의 지도(기능 계통도)도 실제 변경에 맞게 고치세요.'));
  return { text: lines.join('\n').trimEnd(), mapPath: snapshot.mapPath, revision: snapshot.revision, targetCount: pending.length + laneTargets.length + removed.length, approved: request.approved === true };
}
