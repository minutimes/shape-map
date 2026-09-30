import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { InlineText } from './WorkflowNode.jsx';
import { OPTIONAL_FIELDS, toggleOptionalField } from './mapScope.js';
import './mapScope.css';

const DETAIL_LABELS = { inputs: '입력 기록', outputs: '출력 기록', ui: '사용자에게 보여줄 내용', condition: '조건 기록', executor: '담당 기록', logic: '내용', reason: '변경 이유' };
const textValue = (value) => typeof value === 'object'
  ? [value.kind, value.model, value.effort, value.language].filter(Boolean).join(' · ') : value;

export function MapFieldPicker({ fields, busy, onChange }) {
  const [open, setOpen] = useState(false);
  const container = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (!container.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div className="map-fields" ref={container} onKeyDown={(event) => {
    event.stopPropagation(); if (event.key === 'Escape') setOpen(false);
  }}>
    <button className="map-fields__trigger" type="button" aria-expanded={open}
      onClick={() => setOpen(!open)}>선택 속성</button>
    {open && <section className="map-fields__popover" aria-label="이 지도의 선택 속성">
      <header><strong>이 지도에서 사용할 속성</strong><button type="button" aria-label="선택 속성 닫기" onClick={() => setOpen(false)}>×</button></header>
      <p>로직·입력·출력·UI에 필요한 속성을 더하세요.</p>
      {OPTIONAL_FIELDS.map(({ id, label, description }) => <label key={id}>
        <input type="checkbox" checked={fields.includes(id)} disabled={busy}
          onChange={(event) => onChange(toggleOptionalField(fields, id, event.target.checked))} />
        <span><b>{label}</b><small>{description}</small></span>
      </label>)}
      <p className="map-fields__note">선택은 자동 저장됩니다. 표시를 꺼도 작성한 값은 남습니다.</p>
    </section>}
  </div>;
}

function ReferenceItem({ node, children, editor, busy, onRestore, editingId, onEditingComplete, root = false }) {
  const subscribe = useCallback((listener) => editor.subscribe(node.id, listener), [editor, node.id]);
  const getState = useCallback(() => editor.getNodeState(node.id), [editor, node.id]);
  const { fields } = useSyncExternalStore(subscribe, getState, getState);
  const details = Object.entries(node.task || {}).filter(([key, value]) => key !== 'logic' && value);
  return <article className="reference-item" data-testid={`reference-${node.id}`}>
    <div className="reference-item__heading">
      <InlineText id={node.id} path="label" field={fields.label} fallback={node.label}
        editor={editor} label="참고 제목" placeholder="참고 제목…" title
        autoEdit={editingId === node.id} onAutoEditDone={onEditingComplete} />
      {root && <button type="button" className="reference-item__restore" disabled={busy}
        onClick={() => onRestore(node.id)} aria-label={`${node.label} 지도에 돌려놓기`}>지도에 돌려놓기</button>}
    </div>
    <InlineText id={node.id} path="task.logic" field={fields['task.logic']} fallback={node.task?.logic}
      editor={editor} label="참고 내용" placeholder="내용이나 근거를 적어 두세요…" />
    {(details.length > 0 || node.proposal) && <details className="reference-item__details">
      <summary>추가 기록</summary>
      {details.map(([key, value]) => <p key={key}><b>{DETAIL_LABELS[key] || key}</b>{textValue(value)}</p>)}
      {node.proposal && <div><b>변경안 기록</b>{Object.entries(node.proposal).map(([key, value]) =>
        <p key={key}><b>{DETAIL_LABELS[key] || key}</b>{textValue(value)}</p>)}</div>}
    </details>}
    {children.get(node.id)?.length > 0 && <div className="reference-item__children">
      {children.get(node.id).map((child) => <ReferenceItem key={child.id} {...{ node: child, children, editor, busy, onRestore, editingId, onEditingComplete }} />)}
    </div>}
  </article>;
}

export function MapReferences({ sections, graph, editor, busy, onRestore, onAdd, onReturn,
  editingId, onEditingComplete }) {
  const children = new Map(sections.references.map((node) => [node.id, []]));
  for (const node of sections.references) children.get(node.parentId)?.push(node);
  return <section className="map-references" aria-label="지도 참고 자료">
    <div className="map-references__content">
      <header className="map-references__header"><div><h2>참고 자료</h2>
        <p>지도 읽는 법, 근거와 문서 기록을 모아 둡니다.</p></div>
        <button type="button" className="quiet-button" disabled={busy} onClick={onAdd}>+ 참고 추가</button>
      </header>
      {!sections.roots.length && <p className="map-references__empty">아직 참고 자료가 없습니다. 카드 메뉴에서 ‘참고 자료로 옮기기’를 선택할 수 있습니다.</p>}
      {sections.roots.map((node) => <div key={node.id} className="reference-group">
        <div className="reference-group__context">관련 항목 <button type="button" onClick={() => onReturn(node.parentId)}>
          {graph.nodes.find((item) => item.id === node.parentId)?.label || '전체 지도'}</button></div>
        <ReferenceItem {...{ node, children, editor, busy, onRestore, editingId, onEditingComplete }} root />
      </div>)}
    </div>
  </section>;
}
