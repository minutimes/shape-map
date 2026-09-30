import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import { Handle, Position, useStore } from '@xyflow/react';
import { WORKFLOW_CARD_WIDTH } from './workflowCardMetrics.js';
import { OVERVIEW_ZOOM } from './overviewLabels.js';
import './workflow.css';

const EMPTY_EDITOR_STATE = Object.freeze({ fields: Object.freeze({}) });
const EXECUTOR_KINDS = [['code', '일반 코드'], ['perception', '로컬 인식'], ['llm', '생성·추론 모델'], ['jev', 'Jev 후보'], ['human', '사용자']];
const EXECUTOR_LABELS = { code: '코드', perception: '인식', llm: 'LLM', jev: 'Jev', human: '사용자' };
const WORKFLOW_MODES = [['group', '그룹'], ['sequence', '순차'], ['parallel', '병렬'], ['conditional', '조건 분기']];

function Icon({ name }) {
  if (name === 'focus') return <path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5M8 8l-5-5m13 5 5-5M8 16l-5 5m13-5 5 5" />;
  if (name === 'copy') return <path d="M9 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Zm6 0V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />;
  if (name === 'plus') return <path d="M12 5v14M5 12h14" />;
  if (name === 'more') return <path d="M5 12h.01M12 12h.01M19 12h.01" />;
  if (name === 'fold') return <path d="m8 10 4 4 4-4" />;
  return <path d="M5 12h14" />;
}

function IconButton({ label, name, onClick, expanded, disabled = false, className = '' }) {
  return <button type="button" className={`wf-icon-button nodrag nopan ${className}`} aria-label={label} title={label} aria-expanded={expanded} disabled={disabled} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClick?.(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><Icon name={name} /></svg></button>;
}

function useNodeEditor(editor, id) {
  const subscribe = useCallback((listener) => (editor?.subscribe ? editor.subscribe(id, listener) : () => {}), [editor, id]);
  const getSnapshot = useCallback(() => editor?.getNodeState?.(id) || EMPTY_EDITOR_STATE, [editor, id]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function isImeEvent(event) {
  return Boolean(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229);
}

function fieldValue(fields, path, fallback) {
  return Object.prototype.hasOwnProperty.call(fields[path] || {}, 'value') ? fields[path].value : fallback;
}

function noticeValue(value) {
  if (value == null || value === '') return '비어 있음';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function FieldNotice({ id, path, field, editor }) {
  if (!field || !['conflict', 'error'].includes(field.status)) return null;
  if (field.status === 'error') {
    return <div className="wf-field-notice wf-field-notice--error" role="status"><span>{field.message || '저장하지 못했습니다.'}</span><button type="button" onClick={(event) => { event.stopPropagation(); editor?.retry?.(id); }}>다시 시도</button></div>;
  }
  return <div className="wf-field-notice wf-field-notice--conflict" role="alert"><p>{field.message || '다른 곳에서 같은 내용을 바꿨습니다.'}</p><div className="wf-conflict-copy"><span><b>내 초안</b>{noticeValue(field.value)}</span><span><b>새 내용</b>{noticeValue(field.remote)}</span></div><div className="wf-field-notice__actions"><button type="button" onClick={(event) => { event.stopPropagation(); editor?.resolve?.(id, path, 'local'); }}>내 초안 유지</button><button type="button" onClick={(event) => { event.stopPropagation(); editor?.resolve?.(id, path, 'remote'); }}>새 내용 사용</button></div></div>;
}

export function InlineText({ id, path, field, fallback, editor, label, placeholder, title = false, autoEdit = false, onAutoEditDone, legacyCommit }) {
  const canonical = fieldValue({ [path]: field }, path, fallback);
  const resolved = canonical == null ? '' : String(canonical);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(resolved);
  const textareaRef = useRef(null);
  const finishingRef = useRef(false);

  useEffect(() => { if (!editing) setDraft(resolved); }, [editing, resolved]);
  useEffect(() => { if (autoEdit) setEditing(true); }, [autoEdit]);
  useLayoutEffect(() => {
    if (!editing || !textareaRef.current) return;
    textareaRef.current.style.height = '0px';
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight + 2}px`;
  }, [draft, editing]);

  const finish = useCallback(async (flush = true) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    try {
      if (editor) {
        if (flush) editor.flush?.(id);
      } else if (legacyCommit && draft.trim() && draft.trim() !== resolved) {
        const saved = await legacyCommit(draft.trim());
        if (saved === false) return;
      }
      setEditing(false);
      if (autoEdit) onAutoEditDone?.();
    } finally { finishingRef.current = false; }
  }, [autoEdit, draft, editor, id, legacyCommit, onAutoEditDone, resolved]);

  if (editing) return <div className={`wf-inline-field is-editing${title ? ' wf-inline-field--title' : ''}`}><textarea ref={textareaRef} className="wf-inline-field__editor nodrag nopan nowheel" data-testid={path === 'label' ? `node-label-input-${id}` : undefined} aria-label={label} autoFocus rows={1} value={draft} placeholder={placeholder} onPointerDown={(event) => event.stopPropagation()} onCompositionStart={() => editor?.setComposing?.(id, path, true)} onCompositionEnd={() => editor?.setComposing?.(id, path, false)} onChange={(event) => { setDraft(event.target.value); editor?.change?.(id, path, event.target.value); }} onBlur={() => finish(true)} onKeyDown={(event) => { event.stopPropagation(); if (isImeEvent(event)) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finish(true); } else if (event.key === 'Escape') { event.preventDefault(); finish(false); } }} /><FieldNotice id={id} path={path} field={field} editor={editor} /></div>;

  return <div className={`wf-inline-field${title ? ' wf-inline-field--title' : ''}${resolved ? '' : ' is-empty'}`}><button type="button" className="wf-inline-field__read nodrag nopan" aria-label={`${label} 편집`} title={`${label} 편집`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setEditing(true); }}>{resolved || placeholder}</button><FieldNotice id={id} path={path} field={field} editor={editor} /></div>;
}

function TextFact({ id, path, field, fallback, editor, label, placeholder, autoEdit, onAutoEditDone }) {
  return <div className="wf-fact"><dt>{label}</dt><dd><InlineText {...{ id, path, field, fallback, editor, label, placeholder, autoEdit, onAutoEditDone }} /></dd></div>;
}

function ExecutorEditor({
  id, path, field, fallback, editor, proposal = false, autoOpen = false,
  modelEnabled = true, effortEnabled = true,
}) {
  const value = fieldValue({ [path]: field }, path, fallback) || {};
  const executor = typeof value === 'object' ? value : {};
  const [open, setOpen] = useState(false);
  useEffect(() => { if (autoOpen) setOpen(true); }, [autoOpen]);
  const kind = executor.kind || '';
  const showModel = modelEnabled && ['perception', 'llm', 'jev'].includes(kind);
  const update = (patch) => {
    const nextKind = patch.kind ?? kind;
    if (!nextKind) {
      editor?.change?.(id, path, null);
      return;
    }
    const next = { ...executor, ...patch, ...(nextKind === 'jev' ? { language: 'en' } : {}) };
    if (!['perception', 'llm', 'jev'].includes(nextKind)) delete next.model;
    if (nextKind !== 'llm') delete next.effort;
    if (nextKind !== 'jev') delete next.language;
    editor?.change?.(id, path, next);
  };
  const effortListId = `wf-effort-options-${id}-${proposal ? 'proposal' : 'current'}`;
  return <div className={`wf-executor${proposal ? ' wf-executor--proposal' : ''}`}><button type="button" className="wf-executor__summary nodrag nopan" aria-label={`${proposal ? '변경안 ' : ''}실행 담당 편집`} aria-expanded={open} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setOpen((current) => !current); }}><span className={`wf-executor__kind wf-executor__kind--${kind || 'unknown'}`}>{EXECUTOR_LABELS[kind] || '담당…'}</span>{modelEnabled && executor.model && <span>{executor.model}</span>}{effortEnabled && kind === 'llm' && executor.effort && <span>{executor.effort}</span>}{kind === 'jev' && <span>EN</span>}</button>{open && <div className="wf-executor__popover nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><label><span>담당</span><select value={kind} onChange={(event) => update({ kind: event.target.value })} onBlur={() => editor?.flush?.(id)}><option value="">미정</option>{EXECUTOR_KINDS.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>{showModel && <label><span>모델</span><input value={executor.model || ''} placeholder="모델…" onCompositionStart={() => editor?.setComposing?.(id, path, true)} onCompositionEnd={() => editor?.setComposing?.(id, path, false)} onChange={(event) => update({ model: event.target.value })} onBlur={() => editor?.flush?.(id)} /></label>}{effortEnabled && kind === 'llm' && <label><span>노력</span><input list={effortListId} value={executor.effort || ''} placeholder="effort…" onCompositionStart={() => editor?.setComposing?.(id, path, true)} onCompositionEnd={() => editor?.setComposing?.(id, path, false)} onChange={(event) => update({ effort: event.target.value })} onBlur={() => editor?.flush?.(id)} /><datalist id={effortListId}><option value="low" /><option value="medium" /><option value="high" /><option value="xhigh" /><option value="max" /><option value="ultra" /></datalist></label>}{kind === 'jev' && <p>언어는 EN으로 고정됩니다.</p>}</div>}<FieldNotice id={id} path={path} field={field} editor={editor} /></div>;
}

function WorkflowMode({ id, field, fallback, editor }) {
  const workflow = fieldValue({ workflow: field }, 'workflow', fallback) || {};
  return <div className="wf-workflow-control"><label className="wf-workflow-mode nodrag nopan" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><span className="sr-only">하위 작업 흐름</span><select aria-label="하위 작업 흐름" value={workflow.mode || 'group'} onChange={(event) => editor?.change?.(id, 'workflow', { ...workflow, mode: event.target.value })} onBlur={() => editor?.flush?.(id)}>{WORKFLOW_MODES.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label><FieldNotice id={id} path="workflow" field={field} editor={editor} /></div>;
}

function Proposal({ id, proposal, fields, editor, onRemove, enabledFields }) {
  const content = proposal || {};
  const options = [['logic', '로직'], ['inputs', '입력'], ['outputs', '출력'], ['ui', 'UI'],
    ...(enabledFields.has('condition') ? [['condition', '조건']] : [])];
  const [opened, setOpened] = useState(() => new Set(Object.keys(content)));
  const [activeField, setActiveField] = useState(null);
  const [executorOpen, setExecutorOpen] = useState(false);
  const visible = options.filter(([key]) => content[key] || fields[`proposal.${key}`] || opened.has(key));
  const remaining = options.filter(([key]) => !visible.some(([shown]) => shown === key));
  const proposalExecutor = fieldValue(fields, 'proposal.executor', content.executor);
  const executorNotice = ['conflict', 'error'].includes(fields['proposal.executor']?.status);
  const showExecutor = enabledFields.has('executor')
    && (proposalExecutor?.kind || executorOpen || executorNotice);
  return <section className="wf-proposal" aria-label="변경안">
    <header className="wf-proposal__header"><span>변경안</span><button type="button" className="wf-proposal__remove nodrag nopan" onClick={(event) => { event.stopPropagation(); onRemove(); }}>삭제</button></header>
    <FieldNotice id={id} path="proposal" field={fields.proposal} editor={editor} />
    <InlineText id={id} path="proposal.reason" field={fields['proposal.reason']} fallback={content.reason} editor={editor} label="변경 이유" placeholder="바꾸려는 이유…" />
    {showExecutor && <ExecutorEditor id={id} path="proposal.executor" field={fields['proposal.executor']} fallback={content.executor} editor={editor} proposal autoOpen={executorOpen} modelEnabled={enabledFields.has('model')} effortEnabled={enabledFields.has('effort')} />}
    {visible.length > 0 && <dl className="wf-facts wf-facts--proposal">{visible.map(([key, label]) =>
      <TextFact key={key} id={id} path={`proposal.${key}`} field={fields[`proposal.${key}`]} fallback={content[key]} editor={editor} label={label} placeholder={`${label}…`} autoEdit={activeField === key} onAutoEditDone={() => setActiveField(null)} />
    )}</dl>}
    {(remaining.length > 0 || (enabledFields.has('executor') && !showExecutor)) && <div className="wf-proposal__add-fields" aria-label="변경할 내용 추가">
      {remaining.map(([key, label]) => <button type="button" key={key} className="nodrag nopan" aria-label={`변경안 ${label} 작성`} onClick={(event) => { event.stopPropagation(); setOpened((current) => new Set([...current, key])); setActiveField(key); }}>+ {label}</button>)}
      {enabledFields.has('executor') && !showExecutor && <button type="button" className="nodrag nopan" onClick={(event) => { event.stopPropagation(); setExecutorOpen(true); }}>+ 담당</button>}
    </div>}
  </section>;
}

function WorkflowNode({ id, data, selected }) {
  const cardRef = useRef(null);
  const overviewZoom = useStore((state) => state.transform[2] < OVERVIEW_ZOOM);
  const [focusWithin, setFocusWithin] = useState(false);
  const overview = overviewZoom && !focusWithin;
  const editorState = useNodeEditor(data.editor, id);
  const fields = editorState.fields || EMPTY_EDITOR_STATE.fields;
  const task = data.task || {};
  const [proposalDraftOpen, setProposalDraftOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [conditionOpen, setConditionOpen] = useState(false);
  const [executorOpen, setExecutorOpen] = useState(false);
  const enabledFields = useMemo(() => new Set(Array.isArray(data.optionalFields)
    ? data.optionalFields
    : ['executor', 'model', 'effort', 'condition', 'workflow']), [data.optionalFields]);
  const expanded = Boolean(data.expanded && data.childCount > 0);
  const proposalFromDraft = Object.keys(fields).some((path) => path.startsWith('proposal.'));
  const proposalAtomicDraft = Object.prototype.hasOwnProperty.call(fields.proposal || {}, 'value');
  const proposal = proposalAtomicDraft ? fields.proposal.value : data.proposal;
  const hasProposal = data.proposal !== undefined && data.proposal !== null;
  const proposalNotice = ['conflict', 'error'].includes(fields.proposal?.status);
  const showProposal = proposalAtomicDraft ? proposal !== null || proposalNotice : hasProposal || proposalFromDraft || proposalDraftOpen;

  useEffect(() => {
    const card = cardRef.current;
    if (!card || !data.onHeaderMeasure) return undefined;
    let frame;
    const report = () => data.onHeaderMeasure(id, data.headerKey, card.offsetHeight);
    if (typeof ResizeObserver === 'undefined') { report(); return undefined; }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(report);
    });
    observer.observe(card); report();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [id, data.headerKey, data.onHeaderMeasure]);

  const activeStatuses = useMemo(() => Object.values(fields).map((field) => field?.status).filter(Boolean), [fields]);
  const saveStatus = activeStatuses.includes('error') ? '저장 오류' : activeStatuses.includes('conflict') ? '충돌 확인 필요' : activeStatuses.includes('saving') ? '저장 중…' : activeStatuses.includes('pending') ? '저장 대기…' : '';
  const label = fieldValue(fields, 'label', data.label) || '';
  const executor = fieldValue(fields, 'task.executor', task.executor);
  const executorNotice = ['conflict', 'error'].includes(fields['task.executor']?.status);
  const showExecutor = enabledFields.has('executor') && (executor?.kind || executorOpen || executorNotice);
  const showCondition = enabledFields.has('condition')
    && (conditionOpen || task.condition || fields['task.condition']);
  const style = { '--wf-accent': data.category?.stroke || '#155b49', '--wf-text': '#17251f', width: `${WORKFLOW_CARD_WIDTH}px` };

  return <article className={`wf-node${selected ? ' is-selected' : ''}`} style={style} data-testid={`wf-node-${id}`} data-depth={data.depth || 0} data-overview={overview || undefined} role="group" aria-expanded={data.childCount > 0 ? expanded : undefined} aria-label={`${label || '이름 없음'}, ${data.category?.label || '분류 없음'}`} aria-busy={data.busy || undefined}
    onFocusCapture={() => setFocusWithin(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false); }}>
    <Handle type="target" position={Position.Left} className="wf-handle" />
    <div ref={cardRef} className={`wf-card wf-card--${data.shape || 'rounded'}`} inert={overview || undefined}>
      <header className="wf-card__header"><div className="wf-card__eyebrow"><span>{data.category?.label || '분류 없음'}</span>{enabledFields.has('workflow') && Number.isFinite(data.sequenceIndex) && <span className="wf-sequence-index">{String(data.sequenceIndex).padStart(2, '0')}</span>}{enabledFields.has('workflow') && data.childCount > 0 && <WorkflowMode id={id} field={fields.workflow} fallback={data.workflow} editor={data.editor} />}{showExecutor && <ExecutorEditor id={id} path="task.executor" field={fields['task.executor']} fallback={task.executor} editor={data.editor} autoOpen={executorOpen} modelEnabled={enabledFields.has('model')} effortEnabled={enabledFields.has('effort')} />}</div><div className="wf-card__controls"><IconButton name="focus" disabled={data.busy} label={`${label}에 초점 맞추기`} onClick={() => data.onFocus?.(id)} /><IconButton name="plus" disabled={data.busy} label={`${label} 하위 항목 추가`} onClick={() => data.onAddChild?.(id)} /><IconButton name="more" disabled={data.busy} label={`${label} 메뉴`} expanded={menuOpen} onClick={() => setMenuOpen((current) => !current)} /></div>{menuOpen && <div className="wf-card__menu nodrag nopan" onPointerDown={(event) => event.stopPropagation()}><button type="button" onClick={() => { setMenuOpen(false); data.onAddSibling?.(id); }}>같은 단계 추가</button><button type="button" onClick={() => { setMenuOpen(false); data.onCopyKey?.(id); }}>키 복사</button>{data.onMoveToReference && <button type="button" onClick={() => { setMenuOpen(false); data.onMoveToReference(id); }}>참고 자료로 옮기기</button>}{data.onEditTask && <button type="button" onClick={() => { setMenuOpen(false); data.onEditTask(id); }}>고급 편집</button>}</div>}</header>
      <InlineText id={id} path="label" field={fields.label} fallback={data.label} editor={data.editor} label="제목" placeholder="제목…" title autoEdit={Boolean(data.editing)} onAutoEditDone={() => data.onEditingComplete?.(id)} legacyCommit={(next) => data.onRename?.(id, next)} />
      <dl className="wf-facts"><TextFact id={id} path="task.logic" field={fields['task.logic']} fallback={task.logic} editor={data.editor} label="로직" placeholder="로직…" /><TextFact id={id} path="task.inputs" field={fields['task.inputs']} fallback={task.inputs} editor={data.editor} label="입력" placeholder="입력…" /><TextFact id={id} path="task.outputs" field={fields['task.outputs']} fallback={task.outputs} editor={data.editor} label="출력" placeholder="출력…" /><TextFact id={id} path="task.ui" field={fields['task.ui']} fallback={task.ui} editor={data.editor} label="UI" placeholder="UI…" />{showCondition && <TextFact id={id} path="task.condition" field={fields['task.condition']} fallback={task.condition} editor={data.editor} label="조건" placeholder="조건…" />}</dl>
      {showProposal && <Proposal id={id} proposal={proposal} fields={fields} editor={data.editor} enabledFields={enabledFields} onRemove={() => { setProposalDraftOpen(false); data.editor?.change?.(id, 'proposal', null); data.editor?.flush?.(id); }} />}
      <footer className="wf-card__footer"><span className={`wf-save-state${saveStatus ? ' is-active' : ''}`} role="status">{editorState.storageError || saveStatus || (data.childCount > 0 ? `하위 ${data.childCount}개` : '단일 작업')}</span><div className="wf-card__footer-actions">{enabledFields.has('executor') && !showExecutor && <button type="button" className="wf-optional-add nodrag nopan" onClick={(event) => { event.stopPropagation(); setExecutorOpen(true); }}>+ 담당</button>}{enabledFields.has('condition') && !showCondition && <button type="button" className="wf-optional-add nodrag nopan" onClick={(event) => { event.stopPropagation(); setConditionOpen(true); }}>조건 추가</button>}{!showProposal && <button type="button" className="wf-add-proposal nodrag nopan" onClick={(event) => { event.stopPropagation(); setProposalDraftOpen(true); data.editor?.change?.(id, 'proposal', {}); }}><svg viewBox="0 0 24 24" aria-hidden="true"><Icon name="plus" /></svg>변경안 추가</button>}{editorState.storageError && <button type="button" className="wf-retry nodrag nopan" onClick={(event) => { event.stopPropagation(); data.editor?.retry?.(id); }}>다시 시도</button>}</div></footer>
    </div>
    {data.childCount > 0 && <IconButton name="fold" className="wf-expand-button" label={`${label} 하위 작업 ${expanded ? '접기' : '펼치기'}`} expanded={expanded} disabled={data.busy} onClick={() => data.onToggleCollapse?.(id)} />}
    <Handle type="source" position={Position.Right} className="wf-handle" />
  </article>;
}

export default memo(WorkflowNode);
