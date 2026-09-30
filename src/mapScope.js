export const OPTIONAL_FIELDS = [
  { id: 'workflow', label: '진행 방식', description: '순차 · 병렬 · 조건 분기' },
  { id: 'condition', label: '조건', description: '분기나 실행에 필요한 조건' },
  { id: 'executor', label: '실행 담당', description: '코드 · 모델 · 사용자' },
  { id: 'model', label: '모델', description: '사용할 모델의 이름' },
  { id: 'effort', label: 'Effort', description: '추론 깊이를 정하는 작업에만 사용' },
];

/** Section membership is explicit and inherited, never inferred from a label. */
export function splitMapSections(graph) {
  const nodes = graph?.nodes || [];
  const children = new Map(nodes.map((node) => [node.id, []]));
  for (const node of nodes) children.get(node.parentId)?.push(node);
  const referenceIds = new Set();
  const visit = (node) => {
    if (referenceIds.has(node.id)) return;
    referenceIds.add(node.id);
    children.get(node.id)?.forEach(visit);
  };
  nodes.filter((node) => node.section === 'reference').forEach(visit);
  const references = nodes.filter((node) => referenceIds.has(node.id));
  return {
    system: { ...graph, nodes: nodes.filter((node) => !referenceIds.has(node.id)) },
    references,
    roots: references.filter((node) => !referenceIds.has(node.parentId)),
    referenceIds,
  };
}

export function mapOptionalFields(graph) {
  if (graph?.settings?.optionalFields) return graph.settings.optionalFields;
  const found = new Set();
  for (const node of splitMapSections(graph).system.nodes) {
    if (node.workflow) found.add('workflow');
    for (const content of [node.task, node.proposal]) {
      if (content?.condition) found.add('condition');
      if (content?.executor) found.add('executor');
      if (content?.executor?.model) found.add('model');
      if (content?.executor?.effort) found.add('effort');
    }
  }
  return OPTIONAL_FIELDS.map(({ id }) => id).filter((id) => found.has(id));
}

export function toggleOptionalField(fields, id, enabled) {
  const next = new Set(fields);
  if (enabled) next.add(id); else next.delete(id);
  if (enabled && ['model', 'effort'].includes(id)) next.add('executor');
  if (!enabled && id === 'executor') { next.delete('model'); next.delete('effort'); }
  return OPTIONAL_FIELDS.map(({ id: key }) => key).filter((key) => next.has(key));
}
