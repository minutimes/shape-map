import { splitMapSections } from './mapScope.js';
import { nodeFingerprint } from '../lib/shape.mjs';

/** Counts only the product area being read, including arbitrarily deep parts. */
export function areaReading(graph, focusId) {
  const system = splitMapSections(graph).system;
  const root = system.nodes.find((node) => !node.parentId);
  const focus = system.nodes.find((node) => node.id === focusId) || root;
  const children = new Map(system.nodes.map((node) => [node.id, []]));
  system.nodes.forEach((node) => children.get(node.parentId)?.push(node));
  const ids = new Set(); let depth = 0;
  const visit = (node, level) => {
    if (!node || ids.has(node.id)) return;
    ids.add(node.id); depth = Math.max(depth, level);
    children.get(node.id)?.forEach((child) => visit(child, level + 1));
  };
  visit(focus, 0);
  return { root, focus, ids, total: Math.max(0, system.nodes.length - 1),
    count: Math.max(0, ids.size - 1), depth, children: children.get(focus?.id) || [],
    parts: system.nodes.filter((node) => ids.has(node.id)), referenceCount: graph.nodes.length - system.nodes.length };
}

const value = (entry) => entry === undefined || entry === null || entry === '' ? '기록 없음' : entry;
const executor = (entry) => entry ? [({ code: '코드', perception: '음성·문자 인식', llm: '생성·추론 모델', human: '사람', jev: '구조화 판단 모델' })[entry.kind], entry.model, entry.effort].filter(Boolean).join(' · ') : undefined;
function connections(graph, id) {
  return (graph.links || []).filter((link) => link.source === id || link.target === id)
    .map((link) => `${link.source === id ? '전달 →' : '입력 ←'} ${graph.nodes.find((node) => node.id === (link.source === id ? link.target : link.source))?.label}: ${link.label}${link.condition ? ` (${link.condition})` : ''}`).join('\n');
}

export function describeFeatureChange(before, after, beforeGraph, afterGraph) {
  if (!before) return [{ label: '새로 추가한 기능', after: after.block?.summary || after.task?.logic || after.label }];
  if (!after) return [{ label: '지도에서 제거한 기능', before: before.label }];
  const result = [];
  const compare = (label, from, to) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) result.push({ label, before: value(from), after: value(to) });
  };
  compare('기능 이름', before.label, after.label);
  if (before.parentId !== after.parentId) compare('어느 큰 기능에 속하나요?', beforeGraph.nodes.find((node) => node.id === before.parentId)?.label, afterGraph.nodes.find((node) => node.id === after.parentId)?.label);
  compare('쉽게 읽는 설명', before.block?.summary, after.block?.summary);
  for (const [key, label] of [['logic', '기능이 하는 일'], ['inputs', '들어오는 것'], ['outputs', '만들어지는 것'], ['ui', '사용자가 보는 결과'], ['condition', '사용하는 조건']]) compare(label, before.task?.[key], after.task?.[key]);
  compare('처리 담당', executor(before.task?.executor), executor(after.task?.executor));
  compare('다음 개선의 이유', before.proposal?.reason, after.proposal?.reason);
  compare('개선 뒤의 동작', before.proposal?.logic, after.proposal?.logic);
  compare('내부 구성', beforeGraph.nodes.filter((node) => node.parentId === before.id).map((node) => node.label).join('\n'), afterGraph.nodes.filter((node) => node.parentId === after.id).map((node) => node.label).join('\n'));
  compare('다른 기능과의 연결', connections(beforeGraph, before.id), connections(afterGraph, after.id));
  compare('관련 코드', before.block?.files?.join('\n'), after.block?.files?.join('\n'));
  if (!result.length) result.push({ label: '세부 설계', before: '이전 턴의 저장된 구성', after: '이번 턴의 저장된 구성' });
  return result;
}

/** The first snapshot is a baseline, never fabricated prior development. */
export function featureHistory(turns, id, limit = 5) {
  const records = [];
  for (let index = 1; index < turns.length; index += 1) {
    const beforeGraph = turns[index - 1]; const afterGraph = turns[index];
    const before = beforeGraph.nodes.find((node) => node.id === id);
    const after = afterGraph.nodes.find((node) => node.id === id);
    if (!before && !after) continue;
    if (before && after && nodeFingerprint(before, beforeGraph) === nodeFingerprint(after, afterGraph)) continue;
    records.push({ turn: afterGraph, type: !before ? 'added' : !after ? 'removed' : 'changed',
      facts: describeFeatureChange(before, after, beforeGraph, afterGraph) });
  }
  return records.reverse().slice(0, limit);
}
