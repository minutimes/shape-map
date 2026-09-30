const MODES = [
  ['group', '항목 모음', '실행 순서를 정하지 않은 하위 항목입니다.'],
  ['sequence', '순차 진행', '표시된 순서대로 작업을 진행합니다.'],
  ['parallel', '병렬 진행', '서로 기다리지 않고 진행할 수 있는 작업입니다.'],
  ['conditional', '조건 분기', '각 하위 카드의 조건에 맞는 경로를 선택합니다.'],
];

export default function WorkflowSettings({ node, children, allChildren = children, busy, onExecute, onSelect }) {
  const mode = node.workflow?.mode || 'group';
  async function move(index, delta) {
    const childIds = children.map((child) => child.id);
    [childIds[index], childIds[index + delta]] = [childIds[index + delta], childIds[index]];
    const visibleIds = new Set(childIds);
    let cursor = 0;
    await onExecute({ type: 'setChildOrder', id: node.id,
      childIds: allChildren.map((child) => visibleIds.has(child.id) ? childIds[cursor++] : child.id) });
  }
  return (
    <section className="editor-section workflow-settings" aria-label="하위 작업 흐름">
      <h3>하위 작업 흐름</h3>
      <label htmlFor={`workflow-mode-${node.id}`}>진행 방식</label>
      <select id={`workflow-mode-${node.id}`} value={mode} disabled={busy}
        data-testid="workflow-mode"
        onChange={(event) => onExecute({ type: 'setNodeWorkflow', id: node.id, workflow: { mode: event.target.value } })}>
        {MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <p className="field-help">{MODES.find(([value]) => value === mode)?.[2]}</p>
      {children.length > 0 ? (
        <ol className="workflow-order" aria-label="하위 카드 배치 순서">
          {children.map((child, index) => (
            <li key={child.id}>
              <span className="workflow-order__number">{index + 1}</span>
              <button type="button" className="workflow-order__label" onClick={() => onSelect(child.id)}>
                {child.label}
                {mode === 'conditional' && <small>{child.task?.condition || '조건 미정'}</small>}
              </button>
              <button type="button" disabled={busy || index === 0} aria-label={`${child.label} 왼쪽으로`} onClick={() => move(index, -1)}>←</button>
              <button type="button" disabled={busy || index === children.length - 1} aria-label={`${child.label} 오른쪽으로`} onClick={() => move(index, 1)}>→</button>
            </li>
          ))}
        </ol>
      ) : <p className="field-help">하위 항목을 추가하면 이곳에서 순서를 정할 수 있습니다.</p>}
    </section>
  );
}
