import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, ConnectionMode, MiniMap, ReactFlow, applyNodeChanges, getViewportForBounds, useReactFlow, useViewport } from '@xyflow/react';
import { mutateMap, readMap, saveView } from './api.js';
import { compareTurnGraphs, getBlockState, nodeFingerprint } from '../lib/shape.mjs';
import { readingStates } from '../lib/diagram.mjs';
import { absoluteShapePosition, defaultShapeCollapsed, shapeAncestors, shapeLayout, SHAPE_VIEWS, turnGraph } from './shapeLayout.js';
import { ShapeBlock, ShapeGroup, ShapeIcon, StateBadge, SHAPE_STATES } from './ShapeNode.jsx';
import { ShapeConnection } from './ShapeEdge.jsx';
import { routeShapeEdges, shapeCanvasBounds } from './shapeRouting.js';
import { blockDraftValues, BLOCK_DRAFT_FIELDS, draftConflicts, reconcileDraft } from './shapeDraft.js';
import ShapeInspectorAnchor from './ShapeInspectorAnchor.jsx';
import ScopeReader, { FeatureHistory } from './ScopeReader.jsx';
import { areaReading, featureHistory } from './systemReading.js';
import ShapeLayers from './ShapeLayers.jsx';
import ShapeSectionTitles from './ShapeSectionTitles.jsx';
import ShapeContextMenu from './ShapeContextMenu.jsx';
import ShapeConnectionPreview from './ShapeConnectionPreview.jsx';
import TaskFields from './TaskFields.jsx';
import { useCenteredZoom } from './useCenteredZoom.js';
import { readableNodeViewport } from './viewport.js';
import { shapeHistoryEntry, branchClipboard, pasteBranch, shapeDropTarget, settleShapePosition, assignLensOption, connectionPort, shapeConnectionTarget, targetShapePort, shapePortPoint, reparentShapePreview } from './shapeEditing.js';
import './shapeWorkspace.css';

const nodeTypes = { shapeBlock: ShapeBlock, shapeGroup: ShapeGroup };
const edgeTypes = { shapeConnection: ShapeConnection };
const EMPTY_DIFF = { addedIds: [], changedIds: [], removedIds: [] };
const EMPTY_TURNS = [];
const dateText = (date) => new Date(date).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' });
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function ShapeZoomControls({ centeredZoom, fitDiagram, expandedCanvas, onExpand, minimap, onMinimap }) {
  const { zoom } = useViewport();
  return <div className="sm-canvas-bottom"><div className="sm-zoom"><button aria-label="지도 축소" onClick={() => centeredZoom.zoomOut()}><ShapeIcon name="minus" size={14} /></button><button className="sm-zoom-value" aria-label="지도 100%로 보기" onClick={() => centeredZoom.zoomTo(1)}>{Math.round(zoom * 100)}%</button><button aria-label="지도 확대" onClick={() => centeredZoom.zoomIn()}><ShapeIcon name="plus" size={14} /></button><span /><button aria-label="지도 화면에 맞추기" onClick={fitDiagram}><ShapeIcon name="expand" size={14} /></button><button aria-label={expandedCanvas ? '지도 크게 보기 닫기' : '지도 크게 보기'} aria-pressed={expandedCanvas} onClick={onExpand}><ShapeIcon name={expandedCanvas ? 'close' : 'screen'} size={14} /></button><button aria-label="미니맵 보기" aria-pressed={minimap} onClick={onMinimap}><ShapeIcon name="grid" size={14} /></button></div></div>;
}

function localDraft(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}

function Dialog({ title, subtitle, children, onClose, wide = false }) {
  const dialogRef = useRef(null);
  const returnFocus = useRef(document.activeElement);
  useEffect(() => {
    (dialogRef.current?.querySelector('input, textarea') || dialogRef.current?.querySelector('button'))?.focus();
    return () => returnFocus.current?.focus?.();
  }, []);
  return <div className="sm-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className={`sm-dialog${wide ? ' sm-dialog--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="sm-dialog-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key === 'Tab') {
          const items = [...dialogRef.current.querySelectorAll('button:not(:disabled), input, textarea, select, a[href]')];
          const first = items[0]; const last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="sm-dialog__header"><div><h2 id="sm-dialog-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="sm-icon-button" aria-label="닫기" onClick={onClose}><ShapeIcon name="close" /></button></header>
      {children}
    </section>
  </div>;
}

const LINK_KINDS = { flow: '처리 순서', data: '자료 전달', dependency: '필요한 기능', activation: '모델 역할' };
const EXECUTORS = { code: '코드로 처리', perception: '음성·문자 인식', llm: '추론·생성 모델', jev: '구조화 판단 모델', human: '사람이 판단' };

function groupedLenses(lenses) {
  return Object.entries((lenses || []).reduce((groups, lens) => { const name = lens.group || lens.label; groups[name] = [...(groups[name] || []), lens]; return groups; }, {}));
}

function BlockInspector({ node, graph, baselineNode, state, turns, readOnly, mapPath, send, busy, onClose, onOpen, onRepository, onBrief, onDuplicate, onDelete, initialTab = 'overview', initialEditing = false }) {
  const [tab, setTab] = useState(initialTab);
  const [idCopied, setIdCopied] = useState(false);
  const inspectorRef = useRef(null);
  const returnFocus = useRef(document.activeElement);
  useEffect(() => { inspectorRef.current?.focus(); return () => { if (returnFocus.current?.isConnected) returnFocus.current.focus?.(); }; }, []);
  const draftKey = `shape-map:draft:${mapPath}:${node.id}`;
  const initial = blockDraftValues(node);
  const restored = useRef(readOnly ? null : localDraft(draftKey, null));
  const [draft, setDraft] = useState(() => restored.current?.values || { ...initial, comment: '', kind: 'note' });
  const [base, setBase] = useState(() => restored.current?.base || initial);
  const currentFingerprint = nodeFingerprint(node, graph);
  const [expectedFingerprint, setExpectedFingerprint] = useState(() => restored.current?.fingerprint || currentFingerprint);
  const conflicts = draftConflicts(draft, base, initial);
  const [editing, setEditing] = useState(initialEditing);
  const [reviewing, setReviewing] = useState(false);
  const [draftWarning, setDraftWarning] = useState(false);
  const [linkDraft, setLinkDraft] = useState({ id: `link_${crypto.randomUUID().replaceAll('-', '_')}`, target: '', kind: 'data', label: '', condition: '' });
  const [targetSearch, setTargetSearch] = useState('');
  const dirty = draft.comment || BLOCK_DRAFT_FIELDS.some((field) => draft[field] !== base[field]);
  useEffect(() => {
    const next = reconcileDraft(draft, base, initial);
    setDraft(next.draft); setBase(next.base);
    if (!next.conflicts.length) setExpectedFingerprint(currentFingerprint);
  }, [currentFingerprint]);
  useEffect(() => {
    if (readOnly) return;
    try {
      if (dirty) localStorage.setItem(draftKey, JSON.stringify({ values: draft, base, fingerprint: expectedFingerprint })); else localStorage.removeItem(draftKey);
      setDraftWarning(false);
    } catch { setDraftWarning(true); }
  }, [draft, base, expectedFingerprint, draftKey, dirty, readOnly]);
  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  async function saveOverview(event) {
    event.preventDefault();
    if (conflicts.length) return;
    const saved = await send({ type: 'setBlock', id: node.id,
      label: draft.label.trim(), expectedFingerprint,
      block: { summary: draft.summary, files: draft.files.split('\n').map((file) => file.trim()).filter(Boolean) } });
    if (saved) setEditing(false);
  }
  async function addComment(event) {
    event.preventDefault();
    if (await send({ type: 'addComment', id: node.id, body: draft.comment.trim(), kind: draft.kind, author: '사람' })) update('comment', '');
  }
  async function saveProposal(event) {
    event.preventDefault();
    if (conflicts.length) return;
    const proposal = { ...node.proposal, reason: draft.reason.trim(), purpose: draft.purpose || '', successCriteria: draft.successCriteria || '', logic: draft.logic.trim() };
    if (await send({ type: 'setProposal', id: node.id, proposal, expectedFingerprint })) setTab('overview');
  }
  const comments = node.block?.comments || [];
  const children = graph.nodes.filter((item) => item.parentId === node.id && item.section !== 'reference');
  const links = (graph.links || []).filter((link) => link.source === node.id || link.target === node.id);
  const records = featureHistory(turns, node.id);
  return <aside ref={inspectorRef} className="sm-inspector" role="dialog" aria-modal="false" aria-labelledby="sm-inspector-title" tabIndex={-1} data-testid="shape-inspector" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <header className="sm-inspector__heading"><span className="sm-eyebrow">기능 블록</span><button className="sm-icon-button" aria-label="기능 상세 닫기" onClick={onClose}><ShapeIcon name="close" /></button></header>
    <h2 id="sm-inspector-title">{node.label}</h2><StateBadge status={state.status} />
    <div className="sm-object-key"><code>{node.id}</code><button aria-label="기능 ID 복사" onClick={async () => { try { await navigator.clipboard.writeText(node.id); setIdCopied(true); } catch { setIdCopied(false); } }}><ShapeIcon name={idCopied ? 'check' : 'copy'} size={13} />{idCopied ? '복사됨' : 'ID 복사'}</button></div>
    <div className="sm-inspector-tabs" role="tablist" aria-label="기능 정보">
      {[['overview', '개요'], ['properties', '속성'], ['links', `연결${links.length ? ` ${links.length}` : ''}`], ['history', '기록'], ['comments', `메모${comments.length ? ` ${comments.length}` : ''}`], ['proposal', '수정안']].map(([id, label]) =>
        <button key={id} role="tab" aria-selected={tab === id} aria-controls={`sm-inspector-panel-${id}`} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    <div className="sm-inspector__body" role="tabpanel" id={`sm-inspector-panel-${tab}`}>
      {readOnly && <p className="sm-history-note"><ShapeIcon name="history" size={14} />당시 기록을 보고 있습니다.</p>}
      {draftWarning && <p role="alert" className="sm-field-warning">초안을 이 브라우저에 보관하지 못했습니다.</p>}
      {!readOnly && conflicts.length > 0 && <section className="sm-draft-conflict" role="alert"><h3>다른 곳에서도 이 내용을 고쳤습니다.</h3><p>두 내용을 비교한 뒤 이어서 작성해 주세요.</p>{conflicts.map((field) => <div key={field}><strong>{{ label: '기능 이름', summary: '하는 일', reason: '변경 이유', purpose: '목적', successCriteria: '성공 기준', logic: '바뀐 뒤의 동작', files: '관련 파일' }[field]}</strong><small>새 원본</small><p>{initial[field] || '작성한 내용 없음'}</p><small>내 초안</small><p>{draft[field]}</p></div>)}<button className="sm-button" onClick={() => { setBase(initial); setExpectedFingerprint(currentFingerprint); }}>내 초안으로 이어 쓰기</button><button className="sm-text-button" onClick={() => { setDraft((value) => ({ ...value, ...initial })); setBase(initial); setExpectedFingerprint(currentFingerprint); }}>새 원본으로 바꾸기</button></section>}
      {tab === 'overview' && <>
        {editing && !readOnly ? <form className="sm-form" onSubmit={saveOverview}>
          <label>기능 이름<input value={draft.label} onChange={(event) => update('label', event.target.value)} maxLength={180} required /></label>
          <label>이 기능이 하는 일<textarea value={draft.summary} onChange={(event) => update('summary', event.target.value)} rows={4} maxLength={4000} /></label>
          <label>관련 파일 <span className="sm-field-optional">한 줄에 하나</span><textarea value={draft.files} onChange={(event) => update('files', event.target.value)} rows={2} /></label>
          <div className="sm-form-actions"><button className="sm-button" type="button" onClick={() => setEditing(false)}>돌아가기</button><button className="sm-button sm-button--dark" disabled={busy || Boolean(conflicts.length)}>설명 저장</button></div>
        </form> : <>
          <div className="sm-section-title"><h3>어떤 일을 하나요?</h3>{!readOnly && <button onClick={() => setEditing(true)}>설명 수정</button>}</div>
          <p className="sm-inspector__description">{node.block?.summary || node.task?.logic || '아직 설명을 쓰지 않았습니다. 이 기능의 역할을 한 문장으로 남겨 보세요.'}</p>
          {state.status === 'changed' && <section className="sm-change-comparison"><h3><ShapeIcon name="history" size={13} />직전 턴에서 달라진 점</h3>
            {baselineNode ? <><small>이전 형상</small><p>{baselineNode.block?.summary || baselineNode.task?.logic || baselineNode.label}</p><small>이번 형상</small><p>{node.block?.summary || node.task?.logic || node.label}</p></> : <p>이 턴에 새로 추가한 기능입니다.</p>}
          </section>}
          {(node.task?.inputs || node.task?.outputs || node.task?.ui || node.task?.condition || node.task?.executor) && <dl className="sm-io">
            {node.task.inputs && <div><dt>들어오는 것</dt><dd>{node.task.inputs}</dd></div>}
            {node.task.outputs && <div><dt>만들어지는 것</dt><dd>{node.task.outputs}</dd></div>}
            {node.task.ui && <div><dt>사용자 경험</dt><dd>{node.task.ui}</dd></div>}
            {node.task.condition && <div><dt>언제 사용하는 기능인가요?</dt><dd>{node.task.condition}</dd></div>}
            {node.task.executor && <div><dt>누가 처리하나요?</dt><dd>{EXECUTORS[node.task.executor.kind]}{node.task.executor.model && <small className="sm-executor-model">지도에 기록된 모델 · {node.task.executor.model}{node.task.executor.effort ? ` / ${node.task.executor.effort}` : ''}</small>}</dd></div>}
          </dl>}
          {node.proposal && <button className="sm-proposal-preview" onClick={() => setTab('proposal')}><span><ShapeIcon name="arrow" size={14} />다음에 바꿀 내용</span><strong>{node.proposal.reason || node.proposal.logic || '작성한 변경안을 확인하세요.'}</strong><ShapeIcon name="chevron" size={14} /></button>}
          {children.length > 0 && <section className="sm-inspector__children"><h3>이 안에 들어있는 기능</h3>{children.map((child) => <button key={child.id} onClick={() => onOpen(child.id)}><ShapeIcon name="box" size={14} /><span>{child.label}</span><ShapeIcon name="chevron" size={13} /></button>)}</section>}
          {links.length > 0 && <button className="sm-button sm-inspector-link-button" onClick={() => setTab('links')}><ShapeIcon name="branch" size={14} />이 기능과 연결된 기능 {links.length}개</button>}
          {node.block?.files?.length > 0 && <details className="sm-file-details"><summary><ShapeIcon name="code" size={14} />연결된 코드 {node.block.files.length}개</summary>{node.block.files.map((file) => <code key={file}>{file}</code>)}</details>}
          {!readOnly && <section className="sm-review-section"><h3>직접 확인했나요?</h3><p>확인한 내용이 바뀌면 검수를 다시 요청합니다.</p>
            {state.status === 'verified' ? <button className="sm-button sm-button--verified" disabled={busy} onClick={() => send({ type: 'setBlock', id: node.id, block: { status: 'neutral' } })}><ShapeIcon name="check" size={15} />검수 완료 · 되돌리기</button>
              : <button className="sm-button" disabled={busy || Boolean(node.proposal)} onClick={() => setReviewing(true)}><ShapeIcon name="check" size={15} />사람 검수 완료로 표시</button>}
            {node.proposal && <small>변경안을 정리한 뒤 검수할 수 있습니다.</small>}
          </section>}
        </>}
      </>}
      {tab === 'properties' && <>
        {!readOnly && <>
          <section className="sm-property-status"><h3>지도에 표시할 상태</h3><div>{['neutral', 'planned', 'concern'].map((status) => <button className={`sm-button sm-status-choice--${status}`} key={status} disabled={busy} aria-pressed={state.status === status} onClick={() => send({ type: 'setBlock', id: node.id, block: { status } })}><StateBadge status={status} /></button>)}<button className="sm-button" disabled={busy || Boolean(node.proposal)} onClick={() => setReviewing(true)}><StateBadge status="verified" /></button></div><small>파란색은 실제로 기록된 직전 턴의 차이를 보여줍니다.</small></section>
          <label className="sm-property-category">블록 분류<select value={node.category} onChange={(event) => send({ type: 'setNodePresentation', id: node.id, shape: node.shape, category: event.target.value })}>{graph.categories.map((category) => <option value={category.id} key={category.id}>{category.label}</option>)}</select></label>
          {(node.workflow || children.length > 0) && (!graph.settings || graph.settings.optionalFields.includes('workflow')) && <label className="sm-property-category">내부 기능의 관계<select value={node.workflow?.mode || 'group'} disabled={busy} onChange={(event) => send({ type: 'setNodeWorkflow', id: node.id, workflow: { mode: event.target.value } })}>{[['group', '기능 그룹'], ['sequence', '차례대로 진행'], ['parallel', '여러 작업 함께'], ['conditional', '조건에 따라 분기']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
          {(graph.lenses || []).length > 0 && <details className="sm-property-lenses"><summary>이 지도에 정의된 특성 부여</summary><p>직접 적용할 값을 고릅니다. 상위 섹션의 특성도 이어받습니다.</p>{groupedLenses(graph.lenses).map(([name, lenses]) => <fieldset key={name}><legend>{name}</legend>{lenses.flatMap((lens) => lens.options.map((option) => <label key={`${lens.id}:${option.id}`}><input type="checkbox" checked={option.roots.includes(node.id)} disabled={busy} onChange={(event) => send({ type: 'setMapLenses', lenses: assignLensOption(graph.lenses, lens.id, option.id, node.id, event.target.checked) })} />{option.label}</label>))}</fieldset>)}</details>}
          <TaskFields node={node} busy={busy} optionalFields={graph.settings?.optionalFields || ['executor', 'model', 'effort', 'condition']} onCancel={() => setTab('overview')} onSave={(task) => send({ type: 'setNodeTask', id: node.id, task, expectedFingerprint: currentFingerprint })} />
          <div className="sm-object-actions"><button className="sm-button" onClick={onDuplicate}><ShapeIcon name="copy" size={14} />복제</button><button className="sm-text-button is-danger" disabled={!node.parentId} onClick={onDelete}><ShapeIcon name="trash" size={14} />삭제</button></div>
        </>}
        {readOnly && <p className="sm-tab-intro">기록된 턴의 속성은 변경하지 않습니다.</p>}
      </>}
      {tab === 'links' && <>
        <p className="sm-tab-intro">큰 카드 안의 카드는 소속입니다. 화살표는 기능 사이에 오가는 자료와 처리 순서를 보여줍니다.</p>
        <div className="sm-connection-list">{links.length ? links.map((link) => {
          const outgoing = link.source === node.id;
          const other = graph.nodes.find((item) => item.id === (outgoing ? link.target : link.source));
          return <article key={link.id}><header><span>{LINK_KINDS[link.kind]}</span><small>{outgoing ? '이 기능에서 전달' : '이 기능으로 전달'}</small></header><button onClick={() => onOpen(other.id)}><ShapeIcon name={outgoing ? 'arrow' : 'back'} size={14} /><strong>{other.label}</strong></button><p>{link.label}</p>{link.condition && <small className="sm-connection-condition">{link.condition}</small>}{!readOnly && <button className="sm-text-button" disabled={busy} onClick={() => send({ type: 'removeLink', id: link.id })}>연결 해제</button>}</article>;
        }) : <p className="sm-tab-intro">아직 연결을 기록하지 않았습니다.</p>}</div>
        {!readOnly && <form className="sm-form sm-link-composer" onSubmit={async (event) => {
          event.preventDefault();
          const { condition, ...link } = linkDraft;
          if (await send({ type: 'upsertLink', link: { ...link, source: node.id, label: linkDraft.label.trim(), ...(condition.trim() ? { condition: condition.trim() } : {}) } })) setLinkDraft({ id: `link_${crypto.randomUUID().replaceAll('-', '_')}`, target: '', kind: 'data', label: '', condition: '' });
        }}><h3>다른 기능과 연결하기</h3><label>연결할 기능 찾기<input value={targetSearch} onChange={(event) => setTargetSearch(event.target.value)} placeholder="기능 이름으로 좁혀 보세요" /></label><label>어느 기능으로 이어지나요?<select required value={linkDraft.target} onChange={(event) => setLinkDraft((value) => ({ ...value, target: event.target.value }))}><option value="">기능 선택</option>{graph.nodes.filter((item) => item.id !== node.id && item.section !== 'reference' && (item.id === linkDraft.target || item.label.toLowerCase().includes(targetSearch.trim().toLowerCase()))).map((item) => <option key={item.id} value={item.id}>{item.label}{item.parentId ? ` · ${graph.nodes.find((parent) => parent.id === item.parentId)?.label}` : ''}</option>)}</select></label><label>어떤 관계인가요?<select value={linkDraft.kind} onChange={(event) => setLinkDraft((value) => ({ ...value, kind: event.target.value }))}>{Object.entries(LINK_KINDS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label>무엇을 전달하거나 함께 하나요?<input value={linkDraft.label} onChange={(event) => setLinkDraft((value) => ({ ...value, label: event.target.value }))} placeholder="예: 확인한 컷 목록을 편집 단계로 전달" maxLength={180} required /></label><label>언제 연결되나요? <span className="sm-field-optional">선택</span><textarea rows={2} value={linkDraft.condition} onChange={(event) => setLinkDraft((value) => ({ ...value, condition: event.target.value }))} maxLength={4000} /></label><button className="sm-button sm-button--dark" disabled={busy || !linkDraft.target || !linkDraft.label.trim()}><ShapeIcon name="plus" size={14} />연결 저장</button></form>}
      </>}
      {tab === 'history' && <>
        <p className="sm-tab-intro">이 기능의 설명·내부 구성·연결이 어느 지도 턴에서 어떻게 달라졌는지 보여줍니다. 수정 대상에도 이전 기록이 남습니다.</p>
        <FeatureHistory records={records} />
        {node.block?.files?.length > 0 && <button className="sm-button" onClick={() => onRepository(node.id)}><ShapeIcon name="code" size={14} />이 기능의 실제 코드 변경</button>}
      </>}
      {tab === 'comments' && <>
        <p className="sm-tab-intro">이 기능을 보며 든 생각을 남겨 주세요. 걱정되는 점은 지도에 노란색으로 표시됩니다.</p>
        <div className="sm-comments">{comments.length ? comments.map((comment) => <article className={`sm-comment${comment.resolved ? ' is-resolved' : ''}`} key={comment.id}>
          <header><span className={`sm-comment-kind sm-comment-kind--${comment.kind}`}>{comment.kind === 'concern' ? '검토 필요' : comment.kind === 'change' ? '개선 의견' : '의견'}</span><small>{comment.author} · {dateText(comment.createdAt)}</small></header>
          <p>{comment.body}</p>{!readOnly && <footer>{comment.kind === 'change' && !comment.resolved && <button onClick={() => { update('reason', comment.body); setTab('proposal'); }}>변경안으로 옮기기<ShapeIcon name="arrow" size={12} /></button>}
            <button disabled={busy} onClick={() => send({ type: 'resolveComment', id: node.id, commentId: comment.id, resolved: !comment.resolved })}>{comment.resolved ? '다시 열기' : '논의 마침'}</button></footer>}
        </article>) : <div className="sm-empty-comments"><ShapeIcon name="comment" size={27} /><p>첫 의견을 남겨 주세요.</p></div>}</div>
        {!readOnly && <form className="sm-comment-composer sm-form" onSubmit={addComment}>
          <fieldset><legend className="sm-sr-only">의견 종류</legend>{[['note', '의견'], ['concern', '걱정되는 점'], ['change', '개선 의견']].map(([id, label]) => <label key={id} className={draft.kind === id ? `is-selected is-${id}` : ''}><input type="radio" name="comment-kind" value={id} checked={draft.kind === id} onChange={() => update('kind', id)} />{label}</label>)}</fieldset>
          <label className="sm-sr-only" htmlFor="sm-comment-body">이 기능에 남길 의견</label><textarea id="sm-comment-body" placeholder="어떤 점을 함께 살펴볼까요?" value={draft.comment} onChange={(event) => update('comment', event.target.value)} rows={4} maxLength={4000} required />
          <div className="sm-form-actions"><span className="sm-draft-label">{draft.comment ? '입력 중인 의견 보관됨' : '기능과 함께 저장됩니다'}</span><button className="sm-button sm-button--dark" disabled={busy || !draft.comment.trim()}><ShapeIcon name="plus" size={14} />의견 남기기</button></div>
        </form>}
      </>}
      {tab === 'proposal' && <>
        <div className="sm-proposal-intro"><span className="sm-state sm-state--planned"><span className="sm-state__dot" />다음 턴에 바꿀 내용</span><p>왜 바꾸는지, 바꾼 뒤 어떻게 동작해야 하는지 적습니다. 지도에는 빨간색으로 남습니다.</p></div>
        {readOnly ? <div className="sm-readonly-proposal"><h3>변경 이유</h3><p>{node.proposal?.reason || '이 턴에는 변경안이 없습니다.'}</p>{node.proposal?.logic && <><h3>바뀐 뒤의 동작</h3><p>{node.proposal.logic}</p></>}{node.proposal?.purpose && <><h3>목적</h3><p>{node.proposal.purpose}</p></>}{node.proposal?.successCriteria && <><h3>성공 기준</h3><p>{node.proposal.successCriteria}</p></>}</div> : <form className="sm-form" onSubmit={saveProposal}>
          <label>지금 풀고 싶은 문제<textarea value={draft.reason} onChange={(event) => update('reason', event.target.value)} rows={2} placeholder="예: 기능이 어디에 있는지 찾기 어렵습니다." maxLength={4000} required /></label>
          <label>목적<textarea value={draft.purpose || ''} onChange={(event) => update('purpose', event.target.value)} rows={2} placeholder="무엇을 더 쉽게 하려는 건가요?" maxLength={4000} /></label>
          <label>원하는 변화<textarea value={draft.logic} onChange={(event) => update('logic', event.target.value)} rows={3} placeholder="사용자가 경험할 결과를 적어 주세요." maxLength={4000} /></label>
          <label>해결 성공 기준<textarea value={draft.successCriteria || ''} onChange={(event) => update('successCriteria', event.target.value)} rows={2} placeholder="무엇을 확인하면 문제가 해결된 건가요?" maxLength={4000} /></label>
          <button className="sm-button sm-button--planned" disabled={busy || !draft.reason.trim() || Boolean(conflicts.length)}><ShapeIcon name="arrow" size={15} />변경안 저장</button>
          {node.proposal && <button className="sm-text-button" type="button" disabled={busy || Boolean(conflicts.length)} onClick={async () => { if (await send({ type: 'setProposal', id: node.id, proposal: null, expectedFingerprint })) { update('reason', ''); update('logic', ''); } }}>이 변경안 철회</button>}
        </form>}
      </>}
    </div>
    <footer className="sm-inspector__footer"><ShapeIcon name="box" size={13} /><span>{shapeAncestors(graph, node.id).slice(0, -1).map((item) => item.label).join(' / ') || '제품 전체'}</span><button disabled={readOnly} onClick={onBrief}><ShapeIcon name="mail" size={13} />AI에 전달</button></footer>
    {reviewing && <Dialog title="이 기능을 직접 확인했나요?" subtitle="초록색은 사람이 확인한 기능에만 표시됩니다." onClose={() => setReviewing(false)}>
      <p className="sm-dialog-copy">“{node.label}”의 설명과 실제 동작이 맞는지 확인한 뒤 표시해 주세요.</p><div className="sm-form-actions"><button className="sm-button" onClick={() => setReviewing(false)}>돌아가기</button><button className="sm-button sm-button--verified" disabled={busy} onClick={async () => { if (await send({ type: 'setBlock', id: node.id, block: { status: 'verified' } })) setReviewing(false); }}><ShapeIcon name="check" size={15} />직접 확인했습니다</button></div>
    </Dialog>}
  </aside>;
}

export default function ShapeWorkspace() {
  const [snapshot, setSnapshot] = useState(null);
  const snapshotRef = useRef(null);
  const [connection, setConnection] = useState('connecting');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [toast, setToast] = useState(null);
  const [mode, setMode] = useState('system');
  const [focusId, setFocusId] = useState(() => new URLSearchParams(window.location.search).get('focus'));
  const [selectedId, setSelectedId] = useState(null);
  const [turnId, setTurnId] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 900);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [selectionIds, setSelectionIds] = useState([]);
  const [menu, setMenu] = useState(null);
  const [toolPopover, setToolPopover] = useState(null);
  const [edgeDraft, setEdgeDraft] = useState(null);
  const [inspectorIntent, setInspectorIntent] = useState(null);
  const [revealId, setRevealId] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [dropId, setDropId] = useState(null);
  const [viewSizes, setViewSizes] = useState({});
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const undoRef = useRef([]); const redoRef = useRef([]);
  const dragBefore = useRef(null); const resizeBefore = useRef(null); const clipboardRef = useRef(null);
  const [requestDraft, setRequestDraft] = useState({ problem: '', purpose: '', successCriteria: '', approved: false });
  const [creationPoint, setCreationPoint] = useState(null);
  const [newSection, setNewSection] = useState(false);
  const [filter, setFilter] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [brief, setBrief] = useState(null);
  const [briefFocusId, setBriefFocusId] = useState(null);
  const [expandedCanvas, setExpandedCanvas] = useState(false);
  const [repository, setRepository] = useState(null);
  const [repositoryScopeId, setRepositoryScopeId] = useState(null);
  const [copied, setCopied] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSummary, setNewSummary] = useState('');
  const [newParent, setNewParent] = useState('');
  const [minimap, setMinimap] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [optimisticGraph, setOptimisticGraph] = useState(null);
  const [viewPositions, setViewPositions] = useState({});
  const [collapsedIds, setCollapsedIds] = useState(null);
  const [lensSelections, setLensSelections] = useState({});
  const [showActivation, setShowActivation] = useState(false);
  const [detailedLinks, setDetailedLinks] = useState(false);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [windowHeight, setWindowHeight] = useState(window.innerHeight);
  const clientId = useRef(`shape-${crypto.randomUUID()}`);
  const viewTimer = useRef(null);
  const canvasRef = useRef(null);
  const searchRef = useRef(null);
  const restoredMap = useRef(null);
  const foldAnchor = useRef(null);
  const completedConnection = useRef(null);
  const pointerGrab = useRef(null);
  const flow = useReactFlow();
  const accept = useCallback((next) => {
    const previous = snapshotRef.current;
    if (previous && Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) return;
    if (previous && next.revision !== previous.revision && next.origin !== clientId.current) {
      undoRef.current = []; redoRef.current = []; setUndoStack([]); setRedoStack([]);
    }
    const installed = previous?.revision === next.revision ? { ...next, graph: previous.graph } : next;
    snapshotRef.current = installed; setSnapshot(installed);
    setSelectedId((id) => next.graph.nodes.some((node) => node.id === id) ? id : null);
    setSelectionIds((ids) => ids.filter((id) => next.graph.nodes.some((node) => node.id === id)));
    if (next.view?.shape?.layoutVersion === 3) {
      const positions = next.view.shape.positions || {}; const sizes = next.view.shape.sizes || {};
      setViewPositions((current) => JSON.stringify(current) === JSON.stringify(positions) ? current : positions);
      setViewSizes((current) => JSON.stringify(current) === JSON.stringify(sizes) ? current : sizes);
    }
  }, []);
  const centeredZoom = useCenteredZoom({ canvasRef, minZoom: .06, maxZoom: 2, enabled: Boolean(snapshot) });
  function historyStacks(undo, redo) { undoRef.current = undo; redoRef.current = redo; setUndoStack(undo); setRedoStack(redo); }

  useEffect(() => {
    const resize = () => { setWindowWidth(window.innerWidth); setWindowHeight(window.innerHeight); };
    window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    let disposed = false;
    readMap().then((next) => { if (!disposed) { accept(next); setConnection('online'); } }).catch(() => { if (!disposed) setConnection('offline'); });
    const events = new EventSource('/api/events');
    events.addEventListener('snapshot', (event) => { if (!disposed) {
      const next = JSON.parse(event.data);
      // Install our final response once. The semantic write and its view save
      // must not briefly render two different parents/positions during a drop.
      if (!(busyRef.current && next.origin === clientId.current)) accept(next);
      setConnection('online');
    } });
    events.addEventListener('source-error', (event) => { if (!disposed) { const error = JSON.parse(event.data); if (error.snapshot) accept(error.snapshot); } });
    events.onopen = () => { if (!disposed) setConnection('online'); };
    events.onerror = () => { if (!disposed) setConnection('offline'); };
    return () => { disposed = true; events.close(); clearTimeout(viewTimer.current); };
  }, [accept]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 10000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  async function send(operation, options = {}) {
    if (busyRef.current || !snapshotRef.current || turnId) return false;
    const before = snapshotRef.current;
    const entry = options.record === false ? null : shapeHistoryEntry(operation, before);
    busyRef.current = true; setBusy(true);
    try {
      let viewFailed = false;
      let next = await mutateMap({ baseRevision: snapshotRef.current.revision, clientId: clientId.current, operation });
      if (options.viewPatch) {
        try { next = await saveView({ baseRevision: next.revision, clientId: clientId.current, patch: options.viewPatch }); }
        catch { viewFailed = true; }
      }
      accept(next);
      if (entry && next.revision !== before.revision) {
        if (options.undoView) entry.undoView = options.undoView;
        if (options.viewPatch) entry.redoView = options.viewPatch;
        if (operation.type === 'deleteSubtrees') entry.undoView = { shape: {
          positions: Object.fromEntries(entry.deletedIds.map((id) => [id, before.view?.shape?.positions?.[id] || null])),
          sizes: Object.fromEntries(entry.deletedIds.map((id) => [id, before.view?.shape?.sizes?.[id] || null])),
          collapsedIds: collapsedIds || defaultShapeCollapsed(before.graph, currentFocus.id),
        } };
        historyStacks([...undoRef.current, entry].slice(-100), []);
      }
      setToast(viewFailed ? { error: true, text: '내용은 저장했지만 위치는 저장하지 못했습니다.' } : { text: operation.type === 'createTurn' ? '현재 형상을 턴으로 기록했습니다.' : '지도에 저장했습니다.' });
      return next;
    } catch (error) {
      if (error.body?.snapshot) accept(error.body.snapshot);
      setToast({ error: true, text: error.status === 409 ? '다른 곳에서 바뀐 내용이 있습니다. 초안은 보관했습니다. 현재 내용을 확인한 뒤 다시 저장해 주세요.' : connection === 'offline' ? '연결이 끊겼습니다. 입력한 초안은 이 브라우저에 남아 있습니다.' : '저장하지 못했습니다. 입력한 내용을 확인해 주세요.' });
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }
  const turns = snapshot?.graph.turns || EMPTY_TURNS;
  const selectedTurn = turns.find((turn) => turn.id === turnId);
  const graph = useMemo(() => selectedTurn ? turnGraph(selectedTurn) : optimisticGraph || snapshot?.graph, [selectedTurn, optimisticGraph, snapshot?.graph]);
  const root = graph?.nodes.find((node) => !node.parentId);
  const selected = graph?.nodes.find((node) => node.id === selectedId);
  const index = turnId ? turns.findIndex((turn) => turn.id === turnId) : turns.length;
  const previousTurn = selectedTurn ? turns[index - 1] : turns.at(-2);
  const latestTurnGraph = useMemo(() => turnGraph(turns.at(-1)), [turns]);
  const diff = useMemo(() => {
    if (!graph || !previousTurn) return EMPTY_DIFF;
    return compareTurnGraphs(turnGraph(previousTurn), selectedTurn ? graph : latestTurnGraph);
  }, [graph, previousTurn, selectedTurn, latestTurnGraph]);
  const states = useMemo(() => {
    if (!graph) return {};
    return Object.fromEntries(graph.nodes.map((node) => {
      const state = getBlockState(graph, node, selectedTurn && previousTurn ? turnGraph(previousTurn) : undefined);
      return [node.id, state];
    }));
  }, [graph, previousTurn, selectedTurn]);
  const productArea = useMemo(() => graph ? areaReading(graph, root?.id) : null, [graph, root?.id]);
  const productStates = Object.entries(states).filter(([id]) => id !== root?.id && productArea.ids.has(id)).map(([, state]) => state);
  const totals = Object.keys(SHAPE_STATES).reduce((result, status) => ({ ...result, [status]: productStates.filter((state) => state.status === status).length }), {});
  const currentFocus = graph?.nodes.find((node) => node.id === focusId) || root;
  const area = useMemo(() => graph ? areaReading(graph, currentFocus?.id) : null, [graph, currentFocus?.id]);
  const visibleTurns = selectedTurn ? turns.slice(0, index + 1) : turns;
  const repositoryScope = repositoryScopeId && snapshot?.graph.nodes.some((node) => node.id === repositoryScopeId) ? areaReading(snapshot.graph, repositoryScopeId) : null;
  const repositoryCommits = repository?.commits?.filter((commit) => !repositoryScope || commit.blocks.some((block) => repositoryScope.ids.has(block.id))) || [];
  const reading = useMemo(() => graph ? readingStates(graph, lensSelections) : {}, [graph, lensSelections]);
  const openNode = useCallback((id) => { setSelectedId(id); setSelectionIds([id]); setInspectorIntent(null); if (window.innerWidth <= 900) setSidebarOpen(false); }, []);
  const focusNode = useCallback((id) => {
    setFocusId(id); setSelectedId(null); setSelectionIds([]); setCollapsedIds(null); if (window.innerWidth <= 900) setSidebarOpen(false);
    const url = new URL(window.location.href);
    const rootId = snapshotRef.current?.graph.nodes.find((node) => !node.parentId)?.id;
    id === rootId ? url.searchParams.delete('focus') : url.searchParams.set('focus', id);
    window.history.replaceState(null, '', url);
  }, []);
  const toggleNode = useCallback((id) => {
    if (busyRef.current) return;
    const visible = flow.getNodes();
    if (visible.some((node) => node.id === id)) foldAnchor.current = { id, position: absoluteShapePosition(visible, id), viewport: flow.getViewport() };
    const collapsed = new Set(collapsedIds || defaultShapeCollapsed(graph, currentFocus.id));
    collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
    const next = [...collapsed]; setCollapsedIds(next); persistView({ collapsedIds: next });
  }, [collapsedIds, graph, currentFocus?.id, turnId, flow]);
  const activateNode = useCallback((id) => {
    setSelectedId(null); setSelectionIds([id]);
    if (graph.nodes.some((node) => node.parentId === id)) toggleNode(id);
  }, [graph, toggleNode]);
  function showDepth(levels) {
    const depth = shapeAncestors(graph, currentFocus.id).length;
    const parents = new Set(graph.nodes.map((node) => node.parentId));
    const next = graph.nodes.filter((node) => parents.has(node.id) && shapeAncestors(graph, node.id).length >= depth + levels).map((node) => node.id);
    setCollapsedIds(next); persistView({ collapsedIds: next });
  }
  const layout = useMemo(() => graph ? shapeLayout(graph, { focusId: currentFocus?.id, mode,
    positions: viewPositions, sizes: viewSizes, states, onOpen: openNode, onActivate: activateNode, onFocus: focusNode, onToggle: toggleNode, onResize: turnId ? undefined : resizeSection, collapsedIds, reading, showActivation, detailedLinks,
    compact: false }) : { nodes: [], edges: [] },
  [graph, currentFocus?.id, mode, viewPositions, viewSizes, states, openNode, activateNode, focusNode, toggleNode, collapsedIds, reading, showActivation, detailedLinks, turnId]);
  useLayoutEffect(() => setNodes(layout.nodes.map((node) => ({ ...node, selected: selectionIds.includes(node.id),
    className: (filter && node.data.state.status !== filter) || reading[node.id]?.active === false ? 'sm-node-muted' : '' }))), [layout, filter, reading]);
  useLayoutEffect(() => {
    const anchor = foldAnchor.current;
    if (!anchor || !layout.nodes.some((node) => node.id === anchor.id)) return;
    const position = absoluteShapePosition(layout.nodes, anchor.id);
    const { viewport } = anchor; foldAnchor.current = null;
    flow.setViewport({ ...viewport, x: viewport.x + (anchor.position.x - position.x) * viewport.zoom,
      y: viewport.y + (anchor.position.y - position.y) * viewport.zoom }, { duration: 0 });
  }, [layout, flow]);
  useEffect(() => setNodes((current) => current.every((node) => node.selected === selectionIds.includes(node.id)) ? current : current.map((node) => ({ ...node, selected: selectionIds.includes(node.id) }))), [selectionIds]);
  const displayNodes = useMemo(() => nodes.map((node) => ({ ...node, draggable: !turnId, className: `${node.className || ''}${node.id === dropId ? ' sm-drop-target' : ''}` })), [nodes, turnId, dropId]);
  const changeNodes = useCallback((changes) => {
    setNodes((current) => applyNodeChanges(changes, current));
    const selections = changes.filter((change) => change.type === 'select');
    if (selections.length) setSelectionIds((current) => {
      const next = new Set(current); selections.forEach((change) => change.selected ? next.add(change.id) : next.delete(change.id));
      return current.length === next.size && current.every((id) => next.has(id)) ? current : [...next];
    });
  }, []);
  const canvasEdges = useMemo(() => routeShapeEdges(draggingId ? layout.nodes : nodes, layout.edges), [nodes, layout.edges, layout.nodes, draggingId]);
  const diagramGeometry = useRef(null);
  diagramGeometry.current = { nodes, edges: canvasEdges };
  const fitDiagram = useCallback(() => {
    const bounds = shapeCanvasBounds(diagramGeometry.current.nodes, diagramGeometry.current.edges);
    const canvas = canvasRef.current;
    if (bounds && canvas) flow.setViewport(getViewportForBounds(bounds, canvas.clientWidth, canvas.clientHeight, .06, 1.15,
      { left: '4%', right: '4%', top: '80px', bottom: '70px' }));
  }, [flow]);
  // Only deliberate navigation or canvas resizing changes the camera. Folding,
  // connections, source updates and reparenting keep the current reading position.
  const layoutKey = `${snapshot?.mapPath}:${turnId || 'current'}:${currentFocus?.id}:${mode}:${windowWidth}:${windowHeight}:${expandedCanvas}`;
  useEffect(() => {
    if (!snapshot || restoredMap.current === snapshot.mapPath) return;
    restoredMap.current = snapshot.mapPath;
    if (!focusId && snapshot.view?.shape?.layoutVersion === 3) {
      setViewPositions(snapshot.view.shape.positions || {}); setViewSizes(snapshot.view.shape.sizes || {});
      setCollapsedIds(snapshot.view.shape.collapsedIds || null);
    }
  }, [snapshot]);
  useEffect(() => {
    if (!graph) return;
    const timer = setTimeout(() => {
      const view = snapshotRef.current?.view?.shape;
      const saved = view?.layoutVersion === 3 && !focusId && windowWidth > 900 && !expandedCanvas && !turnId && !detailedLinks && !showActivation && mode === 'system' && currentFocus?.id === root?.id ? view.viewport : null;
      if (saved) flow.setViewport(saved);
      else if (currentFocus?.id === root?.id || mode === 'function' || expandedCanvas) fitDiagram();
      else flow.setViewport({ x: 28, y: 80, zoom: .8 });
    }, 80);
    return () => clearTimeout(timer);
  }, [layoutKey, Boolean(graph), fitDiagram]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setTurnId((current) => {
        const nextIndex = turns.findIndex((turn) => turn.id === current) + 1;
        if (nextIndex >= turns.length) { setPlaying(false); return null; }
        return turns[nextIndex].id;
      });
    }, 1800);
    return () => clearInterval(timer);
  }, [playing, turns]);
  useEffect(() => {
    const onKey = (event) => {
      if (dialog || menu || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable) return;
      const command = event.metaKey || event.ctrlKey;
      if (!command && event.key === '/') { event.preventDefault(); setSidebarOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }
      if (command && ['+', '=', '-'].includes(event.key)) { event.preventDefault(); event.key === '-' ? centeredZoom.zoomOut() : centeredZoom.zoomIn(); }
      if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); changeHistory(event.shiftKey ? 'redo' : 'undo'); }
      if (command && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelected(); }
      if (command && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelected(); }
      if (command && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteSelected(); }
      if (!command && ['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); deleteSelected(); }
      if (command && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelectionIds(nodes.filter((node) => graph.nodes.find((item) => item.id === node.id)?.parentId).map((node) => node.id)); setSelectedId(null); }
      if (command && event.key === '0') { event.preventDefault(); fitDiagram(); }
      if (event.key === 'Escape') { setSelectedId(null); setFilter(null); setToolPopover(null); setSidebarOpen(false); setExpandedCanvas(false); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [flow, dialog, menu, fitDiagram, selectionIds, undoStack, redoStack, graph, nodes, edgeDraft, centeredZoom]);
  async function persistView(patch) {
    if (turnId || !snapshotRef.current?.sourceStatus.valid) return;
    try {
      const next = await saveView({ baseRevision: snapshotRef.current.revision, clientId: clientId.current, patch: { shape: { layoutVersion: 3, ...patch } } });
      // A view save must not replace newer semantic edits delivered by SSE.
      if (next.revision === snapshotRef.current.revision) accept(next);
    } catch { /* Navigation remains usable; semantic drafts are saved separately. */ }
  }
  async function openBrief(id) {
    const focus = typeof id === 'string' ? id : null;
    setBriefFocusId(focus); setCopied(false); setBrief(null);
    const node = snapshotRef.current.graph.nodes.find((item) => item.id === focus);
    const draft = localDraft(`shape-map:discussion:${snapshotRef.current.mapPath}:${focus || 'all'}`, null)
      || { problem: node?.proposal?.reason || '', purpose: node?.proposal?.purpose || '', successCriteria: node?.proposal?.successCriteria || '' };
    setRequestDraft({ ...draft, approved: false }); setDialog('brief');
    await generateBrief(focus, { ...draft, approved: false });
  }
  async function generateBrief(focus, request) {
    setCopied(false);
    try { const response = await fetch('/api/brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ focus, ...request }) }); if (!response.ok) throw new Error(); const body = await response.json(); setBrief(body.text); }
    catch { setBrief('논의 내용을 불러오지 못했습니다. 연결과 요청 내용을 확인해 주세요.'); }
  }
  function updateRequest(field, value) {
    const next = { ...requestDraft, [field]: value, approved: false }; setRequestDraft(next); setBrief(null); setCopied(false);
    try { localStorage.setItem(`shape-map:discussion:${snapshotRef.current.mapPath}:${briefFocusId || 'all'}`, JSON.stringify(next)); } catch { /* The visible text remains editable. */ }
  }
  async function openRepository(id) {
    setRepositoryScopeId(typeof id === 'string' ? id : null);
    setDialog('repository'); setRepository(null);
    try { const response = await fetch('/api/repository'); if (!response.ok) throw new Error(); setRepository(await response.json()); }
    catch { setRepository({ connected: false, error: '변경 기록을 불러오지 못했습니다.' }); }
  }
  async function copyBrief() {
    try { await navigator.clipboard.writeText(brief); setCopied(true); }
    catch { setToast({ error: true, text: '자동 복사를 사용할 수 없습니다. 열린 글을 선택해 복사하거나 파일로 저장해 주세요.' }); }
  }
  function downloadBrief() {
    const url = URL.createObjectURL(new Blob([brief], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'shape-map-discussion.md'; link.click(); URL.revokeObjectURL(url);
  }
  function openCreate(type, point = null, parentId = null) {
    setNewTitle(''); setNewSummary(''); setNewSection(type === 'section'); setCreationPoint(point);
    setNewParent(parentId || (graph.nodes.some((node) => node.parentId === selectedId) ? selectedId : currentFocus?.id) || root.id); setDialog(type === 'section' ? 'block' : type);
  }
  async function create(event) {
    event.preventDefault();
    let saved; let createdId;
    if (dialog === 'turn') saved = await send({ type: 'createTurn', title: newTitle.trim(), summary: newSummary.trim() });
    else {
      const parent = graph.nodes.find((node) => node.id === newParent) || root;
      const parentOrigin = nodes.some((node) => node.id === parent.id) ? absoluteShapePosition(nodes, parent.id) : { x: 0, y: 0 };
      const point = creationPoint && { x: Math.max(12, creationPoint.x - parentOrigin.x), y: Math.max(12, creationPoint.y - parentOrigin.y) };
      createdId = `block-${crypto.randomUUID().slice(0, 8)}`;
      saved = await send({ type: 'addNode', id: createdId, parentId: parent.id,
        shape: 'rectangle', category: parent.category, label: newTitle.trim(),
        block: { summary: newSummary.trim() }, ...(newSection ? { workflow: { mode: 'group' } } : {}) }, point ? { viewPatch: { shape: { layoutVersion: 3, positions: { [createdId]: point } } }, undoView: { shape: { positions: { [createdId]: null } } } } : {});
    }
    if (saved) { setDialog(null); if (dialog === 'block') { const folded = new Set(collapsedIds || defaultShapeCollapsed(saved.graph, currentFocus.id)); folded.delete(newParent); setCollapsedIds([...folded]); openNode(createdId); setRevealId(createdId); } }
  }
  function chooseTurn(id) { setTurnId(id); setPlaying(false); setSelectedId(null); setSelectionIds([]); setCollapsedIds(null); }
  async function changeHistory(direction) {
    if (turnId || busyRef.current) return;
    const entry = (direction === 'undo' ? undoRef.current : redoRef.current).at(-1); if (!entry) return;
    busyRef.current = true; setBusy(true);
    try {
      let next = snapshotRef.current;
      const operations = Array.isArray(entry[direction]) ? entry[direction] : [entry[direction]].filter(Boolean);
      for (const operation of operations) next = await mutateMap({ baseRevision: next.revision, clientId: clientId.current, operation });
      let viewFailed = false;
      if (entry[`${direction}View`]) {
        try { next = await saveView({ baseRevision: next.revision, clientId: clientId.current, patch: entry[`${direction}View`] }); }
        catch (error) { if (!operations.length) throw error; viewFailed = true; }
      }
      accept(next);
      if (entry[`${direction}View`]?.shape?.collapsedIds) setCollapsedIds(entry[`${direction}View`].shape.collapsedIds);
      direction === 'undo' ? historyStacks(undoRef.current.slice(0, -1), [...redoRef.current, entry]) : historyStacks([...undoRef.current, entry], redoRef.current.slice(0, -1));
      setToast(viewFailed ? { error: true, text: '내용은 되돌렸지만 위치는 저장하지 못했습니다.' } : { text: direction === 'undo' ? '실행을 취소했습니다.' : '다시 실행했습니다.' });
    } catch (error) { if (error.body?.snapshot) accept(error.body.snapshot); setToast({ error: true, text: '다른 변경이 있어 되돌리지 못했습니다. 현재 지도를 확인해 주세요.' }); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function commitCanvasView(patch, before) {
    if (busyRef.current || turnId) return;
    busyRef.current = true; setBusy(true);
    try { const next = await saveView({ baseRevision: snapshotRef.current.revision, clientId: clientId.current, patch: { shape: { layoutVersion: 3, ...patch } } }); accept(next); historyStacks([...undoRef.current, { label: 'canvas', undoView: { shape: before }, redoView: { shape: { layoutVersion: 3, ...patch } } }].slice(-100), []); }
    catch (error) { if (error.body?.snapshot) accept(error.body.snapshot); setToast({ error: true, text: '위치를 저장하지 못했습니다.' }); setNodes(layout.nodes); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function copySelected(ids = selectionIds) {
    const payload = branchClipboard(snapshotRef.current.graph, ids); if (!payload.nodes.length) return;
    clipboardRef.current = payload;
    setToast({ text: '선택한 블록과 내부 기능을 복사했습니다.' });
    navigator.clipboard.writeText(JSON.stringify(payload)).catch(() => { /* Same-tab paste still works. */ });
  }
  async function pasteSelected(parentId = null, point = null, payload = null) {
    if (turnId) return;
    let content = payload || clipboardRef.current;
    if (!content) { try { const text = await navigator.clipboard.readText(); if (text.length < 1048576) { const read = JSON.parse(text); if (read.kind === 'shape-map-clipboard') content = read; } } catch { /* Use the in-app copy when clipboard access is unavailable. */ } }
    const selected = snapshotRef.current.graph.nodes.find((node) => node.id === selectedId);
    const parent = parentId || (selected && (selected.workflow || graph.nodes.some((node) => node.parentId === selected.id)) ? selected.id : currentFocus.id);
    const operation = pasteBranch(snapshotRef.current.graph, content, parent); if (!operation) { setToast({ text: '복사한 기능 블록이 없습니다.' }); return; }
    const createdRoots = operation.nodes.filter((node) => node.parentId === parent);
    const positions = point ? Object.fromEntries(createdRoots.map((node, i) => [node.id, { x: point.x + i * 24, y: point.y + i * 24 }])) : {};
    if (await send(operation, Object.keys(positions).length ? { viewPatch: { shape: { positions, layoutVersion: 3 } }, undoView: { shape: { positions: Object.fromEntries(createdRoots.map((node) => [node.id, null])) } } } : {})) {
      const folded = new Set(collapsedIds || defaultShapeCollapsed(graph, currentFocus.id)); folded.delete(parent); setCollapsedIds([...folded]); setSelectedId(null); setSelectionIds(createdRoots.map((node) => node.id));
    }
  }
  async function duplicateSelected(ids = selectionIds) {
    const payload = branchClipboard(snapshotRef.current.graph, ids); if (!payload.nodes.length) return;
    const original = snapshotRef.current.graph.nodes.find((node) => node.id === payload.roots[0]);
    const position = snapshotRef.current.view?.shape?.positions?.[original.id];
    await pasteSelected(original.parentId, position ? { x: position.x + 32, y: position.y + 32 } : null, payload);
  }
  async function deleteSelected(ids = selectionIds) {
    if (turnId) return;
    const deletable = ids.filter((id) => snapshotRef.current.graph.nodes.find((node) => node.id === id)?.parentId);
    if (deletable.length && await send({ type: 'deleteSubtrees', ids: deletable })) { setSelectedId(null); setSelectionIds([]); }
  }
  function menuAt(event, id = null, edgeId = null) {
    event.preventDefault(); event.stopPropagation(); if (turnId) return;
    setToolPopover(null);
    if (id && !selectionIds.includes(id)) setSelectionIds([id]);
    setMenu({ x: event.clientX, y: event.clientY, id, edgeId, point: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }) });
  }
  function showNode(id) {
    const node = graph.nodes.find((item) => item.id === id); if (!node) return;
    if (!nodes.some((item) => item.id === id)) focusNode(node.parentId || node.id);
    openNode(id); setRevealId(id);
  }
  function selectLayer(id) {
    const node = graph.nodes.find((item) => item.id === id); if (!node) return;
    if (!nodes.some((item) => item.id === id)) focusNode(node.parentId || node.id);
    setSelectedId(null); setSelectionIds([id]); setRevealId(id);
  }
  useEffect(() => {
    if (!revealId) return; const node = nodes.find((item) => item.id === revealId); if (!node) return;
    flow.setViewport(readableNodeViewport({ ...node, positionAbsolute: absoluteShapePosition(nodes, node.id) }, canvasRef.current?.getBoundingClientRect(), { zoom: .85 })); setRevealId(null);
  }, [nodes, revealId, flow]);
  function editNode(id, tab = 'overview') { nodes.some((node) => node.id === id) ? openNode(id) : showNode(id); setInspectorIntent({ id, tab, edit: tab === 'overview', key: crypto.randomUUID() }); }
  function resizeSection(id, params, phase) {
    if (turnId) return;
    if (phase === 'start') { setDraggingId(id); resizeBefore.current = { positions: { [id]: snapshotRef.current.view?.shape?.positions?.[id] || null }, sizes: { [id]: snapshotRef.current.view?.shape?.sizes?.[id] || null } }; }
    else {
      const live = flow.getNodes().map((node) => node.id === id ? { ...node, style: { ...node.style, width: params.width, height: params.height } } : node);
      const parentId = live.find((node) => node.id === id)?.parentId;
      const position = settleShapePosition(live, id, { x: params.x, y: params.y }, parentId);
      setDraggingId(null); commitCanvasView({ positions: { [id]: position }, sizes: { [id]: { width: params.width, height: params.height } } }, resizeBefore.current);
    }
  }
  function captureGrab(event) {
    const id = event.target.closest?.('.react-flow__node')?.dataset.id;
    if (!id) { pointerGrab.current = null; return; }
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const position = absoluteShapePosition(flow.getNodes(), id);
    pointerGrab.current = { id, offset: { x: point.x - position.x, y: point.y - position.y } };
  }
  function startDrag(_event, node) { clearTimeout(viewTimer.current); dragBefore.current = { id: node.id, position: snapshotRef.current.view?.shape?.positions?.[node.id] || null, grab: pointerGrab.current?.id === node.id ? pointerGrab.current.offset : null }; setSelectedId(null); setSelectionIds([node.id]); setDraggingId(node.id); }
  function dragNode(event, node) { const target = shapeDropTarget(graph, flow.getNodes(), node.id, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })); setDropId(target?.id || null); }
  async function finishDrag(event, node) {
    setDraggingId(null); setDropId(null);
    if (turnId) return;
    // The controlled store and callback can still contain the previous frame.
    // Recover the final position from the release pointer and original grab offset.
    const live = flow.getNodes().map((item) => item.id === node.id ? node : item); const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const target = shapeDropTarget(graph, live, node.id, point);
    const savedNode = graph.nodes.find((item) => item.id === node.id); const parentId = target?.id || currentFocus.id;
    const grab = dragBefore.current?.grab;
    const absolute = grab ? { x: point.x - grab.x, y: point.y - grab.y } : absoluteShapePosition(live, node.id); const origin = target ? absoluteShapePosition(live, target.id) : { x: 0, y: 0 };
    const desired = target ? { x: Math.max(12, absolute.x - origin.x), y: Math.max((target.data.headerHeight || 40) + 12, absolute.y - origin.y) } : absolute;
    const position = settleShapePosition(live, node.id, desired, target?.id || null);
    const patch = { positions: { [node.id]: position } }; const before = { positions: { [node.id]: dragBefore.current?.position || null } };
    if (parentId !== savedNode.parentId && parentId !== savedNode.id) {
      const oldCollapsed = collapsedIds || defaultShapeCollapsed(graph, currentFocus.id);
      const preview = reparentShapePreview(graph, live, node.id, parentId, position, oldCollapsed);
      const undoPositions = Object.fromEntries(Object.keys(preview.positions).map((id) => [id, snapshotRef.current.view?.shape?.positions?.[id] || null]));
      setOptimisticGraph(preview.graph); setViewPositions((current) => ({ ...current, ...preview.positions })); setCollapsedIds(preview.collapsedIds);
      const saved = await send({ type: 'moveNode', id: node.id, parentId }, {
        viewPatch: { shape: { layoutVersion: 3, positions: preview.positions, collapsedIds: preview.collapsedIds } },
        undoView: { shape: { positions: undoPositions, collapsedIds: oldCollapsed } },
      });
      setOptimisticGraph(null);
      if (!saved) { setCollapsedIds(oldCollapsed); setViewPositions(snapshotRef.current.view?.shape?.positions || {}); }
    } else await commitCanvasView(patch, before);
  }
  function finishConnection(event, state) {
    const precise = completedConnection.current; completedConnection.current = null;
    if (turnId || !state.fromNode) return;
    const pointer = event.changedTouches?.[0] || event;
    if (!Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return;
    const world = flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
    const target = shapeConnectionTarget(flow.getNodes(), state.fromNode.id, world, 14 / flow.getViewport().zoom);
    if (target) {
      const sourceNode = flow.getNodes().find((node) => node.id === state.fromNode.id);
      const source = shapePortPoint({ ...absoluteShapePosition(flow.getNodes(), state.fromNode.id), ...sourceNode.style }, connectionPort(state.fromHandle.id));
      const port = targetShapePort(target.rect, source, world,
        target.node.id === precise?.target ? connectionPort(precise.targetHandle) : null, 14 / flow.getViewport().zoom);
      beginConnection({ source: state.fromNode.id, sourceHandle: state.fromHandle.id, target: target.node.id,
        targetHandle: { left: 'in', right: 'out', top: 'top', bottom: 'bottom' }[port] });
    } else if (precise) beginConnection(precise);
  }
  function beginConnection(connection) {
    if (turnId || !connection.source || !connection.target || connection.source === connection.target) return;
    setSelectedId(null); setDetailedLinks(true); setEdgeDraft({ id: `link_${crypto.randomUUID().replaceAll('-', '_')}`, source: connection.source, target: connection.target,
      sourcePort: connectionPort(connection.sourceHandle), targetPort: connectionPort(connection.targetHandle), kind: 'data', label: '', condition: '' }); setDialog('edge');
  }
  function editEdge(id) {
    const link = graph.links?.find((item) => item.id === id);
    if (link) { setEdgeDraft({ ...link, condition: link.condition || '' }); setDialog('edge'); setSelectedId(null); }
    else {
      const parentId = canvasEdges.find((edge) => edge.id === id)?.data?.link?.workflowParentId;
      if (parentId) editNode(parentId, 'properties');
    }
  }
  const lensGroups = groupedLenses(graph?.lenses);
  const effectiveCollapsed = collapsedIds || (graph && currentFocus ? defaultShapeCollapsed(graph, currentFocus.id) : []);
  const menuItems = menu?.edgeId ? graph.links?.some((link) => link.id === menu.edgeId) ? [
    { label: '연결 내용·속성 수정', icon: 'branch', action: () => editEdge(menu.edgeId) },
    { label: '연결 삭제', icon: 'trash', danger: true, action: () => send({ type: 'removeLink', id: menu.edgeId }) },
  ] : [{ label: '섹션 진행 순서 수정', icon: 'branch', action: () => editEdge(menu.edgeId) }] : menu?.id ? [
    { label: '이름·설명 수정', icon: 'code', action: () => editNode(menu.id) },
    { label: '속성·색·특성 수정', icon: 'grid', action: () => editNode(menu.id, 'properties') },
    { label: '내부에 기능 추가', icon: 'plus', action: () => openCreate('block', null, menu.id) },
    { label: '내부에 섹션 추가', icon: 'grid', action: () => openCreate('section', null, menu.id) },
    { separator: true },
    { label: '복사', icon: 'copy', key: 'Ctrl C', action: () => copySelected(selectionIds.includes(menu.id) ? selectionIds : [menu.id]) },
    { label: '복제', icon: 'copy', key: 'Ctrl D', action: () => duplicateSelected(selectionIds.includes(menu.id) ? selectionIds : [menu.id]) },
    { label: '삭제', icon: 'trash', key: 'Delete', danger: true, disabled: !graph.nodes.find((node) => node.id === menu.id)?.parentId, action: () => deleteSelected(selectionIds.includes(menu.id) ? selectionIds : [menu.id]) },
  ] : [
    { label: '기능 블록 추가', icon: 'plus', action: () => openCreate('block', menu.point) },
    { label: '섹션 추가', icon: 'grid', action: () => openCreate('section', menu.point) },
    { label: '붙여넣기', icon: 'copy', key: 'Ctrl V', action: () => pasteSelected(currentFocus.id, menu.point) },
    { separator: true },
    { label: '실행 취소', icon: 'undo', key: 'Ctrl Z', disabled: !undoStack.length, action: () => changeHistory('undo') },
    { label: '다시 실행', icon: 'redo', key: 'Ctrl ⇧ Z', disabled: !redoStack.length, action: () => changeHistory('redo') },
    { label: '화면에 맞추기', icon: 'expand', action: fitDiagram },
  ];
  const results = search.trim() ? graph?.nodes.filter((node) => productArea.ids.has(node.id) && `${node.label} ${node.block?.summary || ''} ${node.task?.logic || ''}`.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 25) : [];
  if (!snapshot) return <main className="sm-loading"><span className="sm-logo" /><h1>shape map</h1><p>{connection === 'offline' ? '지도를 불러오지 못했습니다.' : '제품 지도를 펼치고 있습니다.'}</p>{connection === 'offline' && <button className="sm-button" onClick={() => window.location.reload()}>다시 연결</button>}</main>;
  return <main className={`shape-workspace sm-studio${sidebarOpen ? ' layers-open' : ''}${selectedTurn ? ' is-history' : ''}`}>
    <header className="sm-topbar">
      <button className="sm-icon-button sm-layer-toggle" aria-label={sidebarOpen ? '레이어 패널 숨기기' : '레이어 패널 열기'} aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><ShapeIcon name="menu" size={17} /></button>
      <a className="sm-brand" href="/" aria-label="Shape map 홈"><span className="sm-logo" /><span>shape map<span className="sm-brand__dot">.</span></span></a>
      <span className="sm-project-name" title={snapshot.mapPath}>{root.label}</span>
      <div className="sm-topbar-legend" aria-label="상태별 기능 필터">{Object.entries(SHAPE_STATES).filter(([status]) => status !== 'neutral').map(([status, state]) => <button key={status} className={`sm-legend-item sm-legend-item--${status}`} aria-label={`${state.label} ${totals[status]}`} aria-pressed={filter === status} onClick={() => setFilter(filter === status ? null : status)}><span className="sm-state__dot" /><span>{state.short}</span><b>{totals[status]}</b></button>)}</div>
      <div className="sm-topbar__actions">
        <span className={`sm-save-state${connection !== 'online' || !snapshot.sourceStatus.valid ? ' is-offline' : ''}`} role="status"><span /><span>{!snapshot.sourceStatus.valid ? '원본 확인 필요' : busy ? '저장 중' : connection === 'online' ? '저장됨' : '연결 확인'}</span></span>
        <button className="sm-icon-button" aria-label="색상과 연결선 범례" onClick={() => setDialog('help')}><ShapeIcon name="help" size={16} /></button>
        <button className="sm-button sm-button--subtle sm-timeline-toggle" aria-label="턴 타임라인 보기" aria-pressed={timelineOpen} onClick={() => { setTimelineOpen(!timelineOpen); if (timelineOpen) setPlaying(false); }}><ShapeIcon name="history" size={15} /><span>턴 {turns.length}</span></button>
        <button className="sm-button sm-button--dark" disabled={Boolean(turnId)} onClick={openBrief}><ShapeIcon name="mail" size={15} /><span>AI와 논의</span></button>
      </div>
    </header>
    {!snapshot.sourceStatus.valid && <div className="sm-error-banner" role="alert">원본을 확인해 주세요. 마지막으로 읽은 지도를 보여줍니다.</div>}
    {connection === 'offline' && <div className="sm-error-banner" role="alert">연결을 확인하고 있습니다. 입력한 초안은 이 브라우저에 남습니다.</div>}
    <div className="sm-main">
      {sidebarOpen && <aside className="sm-sidebar is-open" aria-label="기능 레이어 패널">
        <div className="sm-layer-heading"><button onClick={() => focusNode(root.id)}><ShapeIcon name="grid" size={14} /><strong>레이어</strong><span>{productStates.length}</span></button><button className="sm-icon-button" aria-label="레이어 패널 닫기" onClick={() => setSidebarOpen(false)}><ShapeIcon name="close" size={14} /></button></div>
        <div className="sm-search"><ShapeIcon name="search" size={13} /><input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="기능·ID 찾기" aria-label="기능 찾기" /><kbd>/</kbd></div>
        <ShapeLayers graph={graph} rootId={root.id} states={states} collapsedIds={effectiveCollapsed} selectedIds={selectionIds} onToggle={toggleNode} onSelect={selectLayer} onEdit={showNode} onFocus={focusNode} onMenu={menuAt} search={search} />
        <div className="sm-sidebar__bottom"><button onClick={openRepository}><ShapeIcon name="history" size={14} />레포 변경 기록<ShapeIcon name="arrow" size={13} /></button><span className="sm-local-file" title={snapshot.mapPath}><ShapeIcon name="code" size={13} />{snapshot.mapPath.split('/').at(-1)}</span><a className="sm-legacy-editor" href="?editor=1">원본·고급 편집<ShapeIcon name="code" size={12} /></a></div>
      </aside>}
      <section aria-label="무한 캔버스 제품 지도" className={`sm-stage${expandedCanvas ? ' is-expanded' : ''}`}>
        <h1 className="sm-sr-only">{currentFocus.label} 구성도</h1>
        <div className="sm-canvas" data-testid="shape-canvas" ref={canvasRef}>
          <ReactFlow nodes={displayNodes} edges={canvasEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} minZoom={.06} maxZoom={2} panOnScroll zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} zoomActivationKeyCode={null} autoPanOnNodeFocus={false} panOnDrag selectionOnDrag selectionKeyCode="Shift" multiSelectionKeyCode={['Control', 'Meta']} nodesConnectable={!turnId} connectionMode={ConnectionMode.Loose} connectionRadius={40} connectionLineComponent={ShapeConnectionPreview} deleteKeyCode={null} colorMode="light"
            onPointerDownCapture={captureGrab}
            onNodesChange={changeNodes}
            onNodeClick={(event, node) => { if (event.shiftKey || event.ctrlKey || event.metaKey) setSelectedId(null); else activateNode(node.id); }}
            onPaneClick={() => { setSelectedId(null); setSelectionIds([]); setToolPopover(null); }} onPaneContextMenu={(event) => menuAt(event)} onNodeContextMenu={(event, node) => menuAt(event, node.id)} onEdgeContextMenu={(event, edge) => menuAt(event, null, edge.data?.link?.id)}
            onNodeDragStart={startDrag} onNodeDrag={dragNode} onNodeDragStop={finishDrag} onConnectStart={() => { completedConnection.current = null; }} onConnect={(connection) => { completedConnection.current = connection; }} onConnectEnd={finishConnection} onEdgeClick={(_event, edge) => editEdge(edge.data?.link?.id)}
            onMoveEnd={(_event, viewport) => { if (turnId || currentFocus.id !== root.id) return; clearTimeout(viewTimer.current); viewTimer.current = setTimeout(() => persistView({ viewport }), 450); }}>
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d7d7dc" />
            <ShapeSectionTitles nodes={nodes} onSelect={activateNode} onFocus={focusNode} />
            {minimap && <MiniMap pannable zoomable nodeColor={(node) => ({ planned: '#e36a69', verified: '#6baf86', changed: '#719ddc', concern: '#d3af5a' }[node.data.state?.status] || '#dedee2')} />}
          </ReactFlow>
          <div className="sm-canvas-toolbar" aria-label="지도 도구">
            <nav className="sm-breadcrumb" aria-label="지도 경로">{shapeAncestors(graph, currentFocus.id).map((node, itemIndex) => <span key={node.id}>{itemIndex > 0 && <ShapeIcon name="chevron" size={10} />}<button onClick={() => focusNode(node.id)} aria-current={node.id === currentFocus.id ? 'location' : undefined}>{itemIndex === 0 ? '전체' : node.label}</button></span>)}</nav>
            <div className="sm-toolbar-actions">
              <div className="sm-popover-control"><button className="sm-button sm-button--small" aria-expanded={toolPopover === 'depth'} onClick={() => setToolPopover(toolPopover === 'depth' ? null : 'depth')}><ShapeIcon name="grid" size={13} /><span>구성 깊이</span></button>{toolPopover === 'depth' && <div className="sm-toolbar-popover sm-depth-popover">{[[1, '큰 기능'], [2, '내부 기능'], [3, '세부 기능'], [Infinity, '모두 펼치기']].map(([level, label]) => <button key={label} onClick={() => { showDepth(level); setToolPopover(null); }}>{label}</button>)}</div>}</div>
              {lensGroups.map(([name, lenses]) => <div className="sm-popover-control" key={name}><button className="sm-button sm-button--small" aria-expanded={toolPopover === name} onClick={() => setToolPopover(toolPopover === name ? null : name)}>{name}{lenses.some((lens) => lensSelections[lens.id]) && <i className="sm-filter-dot" />}</button>{toolPopover === name && <div className="sm-toolbar-popover sm-lens-popover"><strong>{name}</strong>{lenses.map((lens) => <div className="sm-lens-options" key={lens.id}>{lens.options.map((option) => <button key={option.id} role="checkbox" aria-checked={lensSelections[lens.id] === option.id} onClick={() => setLensSelections((value) => ({ ...value, [lens.id]: value[lens.id] === option.id ? '' : option.id }))}><span>{lensSelections[lens.id] === option.id ? <ShapeIcon name="check" size={13} /> : <i />}</span>{option.label}</button>)}</div>)}<button className="sm-lens-clear" onClick={() => { setLensSelections((value) => ({ ...value, ...Object.fromEntries(lenses.map((lens) => [lens.id, ''])) })); setToolPopover(null); }}>전체 보기</button></div>}</div>)}
              <div className="sm-popover-control"><button className="sm-button sm-button--small" aria-expanded={toolPopover === 'lines'} onClick={() => setToolPopover(toolPopover === 'lines' ? null : 'lines')}><ShapeIcon name="branch" size={13} /><span>연결선</span></button>{toolPopover === 'lines' && <div className="sm-toolbar-popover sm-line-popover"><button aria-pressed={detailedLinks} onClick={() => setDetailedLinks(!detailedLinks)}>세부 연결선 {detailedLinks ? '✓' : ''}</button><button aria-pressed={showActivation} onClick={() => setShowActivation(!showActivation)}>모델 연결선 {showActivation ? '✓' : ''}</button><div className="sm-line-legend">{Object.entries(LINK_KINDS).map(([kind, label]) => <span key={kind}><i className={`sm-line-swatch--${kind}`} />{label}</span>)}</div></div>}</div>
              <button className="sm-icon-button" aria-label="구성·변경 설명" onClick={() => setDialog('reading')}><ShapeIcon name="help" size={15} /></button>
            </div>
          </div>
          {Object.values(lensSelections).some(Boolean) && <button className="sm-active-conditions" onClick={() => setLensSelections({})}>{graph.lenses.map((lens) => lens.options.find((option) => option.id === lensSelections[lens.id])?.label).filter(Boolean).join(' · ')}<ShapeIcon name="close" size={12} /></button>}
          {selectedTurn && <div className="sm-replay-badge"><ShapeIcon name="history" size={14} />턴 {selectedTurn.number} · {selectedTurn.title}<button onClick={() => chooseTurn(null)}>현재로 돌아가기<ShapeIcon name="arrow" size={13} /></button></div>}
          <div className="sm-bottom-tools"><div className="sm-creation-dock" aria-label="캔버스 편집 도구"><button aria-label="기능 블록 추가" disabled={Boolean(turnId) || busy} onClick={() => openCreate('block')}><ShapeIcon name="plus" size={18} /><span>블록</span></button><button aria-label="섹션 추가" disabled={Boolean(turnId) || busy} onClick={() => openCreate('section')}><ShapeIcon name="grid" size={17} /><span>섹션</span></button><i /><button aria-label="실행 취소" disabled={!undoStack.length || busy || Boolean(turnId)} onClick={() => changeHistory('undo')}><ShapeIcon name="undo" size={16} /></button><button aria-label="다시 실행" disabled={!redoStack.length || busy || Boolean(turnId)} onClick={() => changeHistory('redo')}><ShapeIcon name="redo" size={16} /></button></div>
          <ShapeZoomControls centeredZoom={centeredZoom} fitDiagram={fitDiagram} expandedCanvas={expandedCanvas} onExpand={() => { setExpandedCanvas(!expandedCanvas); setSidebarOpen(false); }} minimap={minimap} onMinimap={() => setMinimap(!minimap)} />
          </div>
        </div>
        {timelineOpen && <footer className="sm-timeline" aria-label="개발 턴 타임라인">
          <div className="sm-timeline__heading"><div><ShapeIcon name="history" size={15} /><strong>{selectedTurn ? `턴 ${selectedTurn.number}` : '현재 형상'}</strong><span>{selectedTurn ? selectedTurn.title : `기록된 턴 ${turns.length}개`}</span></div><button className="sm-button sm-button--small" onClick={() => setDialog('changes')} disabled={!previousTurn}>지난 변경 {diff.changedIds.length}</button><button className="sm-button sm-button--small" disabled={Boolean(turnId) || busy} onClick={() => openCreate('turn')}>턴 기록</button><button className="sm-icon-button" aria-label="턴 타임라인 닫기" onClick={() => { setTimelineOpen(false); setPlaying(false); }}><ShapeIcon name="close" size={14} /></button></div>
          <div className="sm-timeline__track"><button className="sm-play" aria-label={playing ? '턴 재생 멈추기' : '개발 턴 재생'} disabled={!turns.length} onClick={() => { if (!playing) { setTurnId(turns[0].id); setSelectedId(null); } setPlaying(!playing); }}><ShapeIcon name={playing ? 'pause' : 'play'} size={15} /></button><div className="sm-turns">{turns.map((turn) => <button key={turn.id} className={`sm-turn${turnId === turn.id ? ' is-selected' : ''}`} onClick={() => chooseTurn(turn.id)}><span className="sm-turn__dot" /><span className="sm-turn__text"><b>턴 {turn.number}</b><span>{turn.title}</span></span><small>{dateText(turn.createdAt)}</small></button>)}<button className={`sm-turn sm-turn--current${!turnId ? ' is-selected' : ''}`} onClick={() => chooseTurn(null)}><span className="sm-turn__dot" /><span className="sm-turn__text"><b>현재</b><span>다음 변화를 준비 중</span></span></button></div></div>
          {turns.length > 0 && <label className="sm-timeline-slider"><span className="sm-sr-only">보고 있는 개발 턴</span><input type="range" min="0" max={turns.length} value={index} onChange={(event) => chooseTurn(turns[Number(event.target.value)]?.id || null)} aria-valuetext={selectedTurn ? `턴 ${selectedTurn.number}: ${selectedTurn.title}` : '현재 형상'} /></label>}
        </footer>}
        {selected && <ShapeInspectorAnchor nodes={nodes} selectedId={selected.id} anchorId={shapeAncestors(graph, selected.id).reverse().find((item) => nodes.some((node) => node.id === item.id))?.id} canvasRef={canvasRef}><BlockInspector key={`${turnId || 'current'}:${selected.id}:${inspectorIntent?.key || ''}`} initialTab={inspectorIntent?.id === selected.id ? inspectorIntent.tab : 'overview'} initialEditing={inspectorIntent?.id === selected.id && inspectorIntent.edit} node={selected} graph={graph} baselineNode={previousTurn?.nodes.find((node) => node.id === selected.id)} state={states[selected.id]} turns={visibleTurns} mapPath={snapshot.mapPath} readOnly={Boolean(selectedTurn)} send={send} busy={busy} onClose={() => setSelectedId(null)} onOpen={showNode} onRepository={openRepository} onBrief={() => openBrief(selected.id)} onDuplicate={() => duplicateSelected([selected.id])} onDelete={() => deleteSelected([selected.id])} /></ShapeInspectorAnchor>}
      </section>
    </div>
    {menu && <ShapeContextMenu menu={menu} items={menuItems} onClose={() => setMenu(null)} />}
    {toast && <div className={`sm-toast${toast.error ? ' is-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{!toast.error && <ShapeIcon name="check" size={15} />}<span>{toast.text}</span><button className="sm-icon-button" aria-label="알림 닫기" onClick={() => setToast(null)}><ShapeIcon name="close" size={14} /></button></div>}
    {dialog === 'reading' && <Dialog wide title={currentFocus.id === root.id ? '전체 시스템의 구성과 개선' : `${currentFocus.label} · 구성과 개선`} subtitle="큰 기능의 역할부터 세부 구성, 지난 변경, 다음 개선까지 읽습니다." onClose={() => setDialog(null)}>
      <ScopeReader graph={graph} focusId={currentFocus.id} turns={visibleTurns} onFocus={(id) => { focusNode(id); setDialog(null); }} onOpen={(id) => { openNode(id); setDialog(null); }} onRepository={() => openRepository(currentFocus.id)} />
    </Dialog>}
    {(dialog === 'block' || dialog === 'turn') && <Dialog title={dialog === 'turn' ? '현재 형상을 턴으로 기록' : newSection ? '새 섹션' : '새 기능 블록'} subtitle={dialog === 'turn' ? '지금의 설명·변경안·의견을 함께 남깁니다.' : '제품에서 하는 일을 쉬운 말로 적어 주세요.'} onClose={() => setDialog(null)}>
      <form className="sm-form" onSubmit={create}><label>{dialog === 'turn' ? '이번 턴의 이름' : '기능 이름'}<input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder={dialog === 'turn' ? '예: 첫 형상 · 기능을 한눈에' : '예: 가입 없이 시작하기'} maxLength={180} required /></label>
        {dialog === 'block' && <label>어느 기능에 속하나요?<select value={newParent} onChange={(event) => setNewParent(event.target.value)}>{graph.nodes.filter((node) => node.section !== 'reference').map((node) => <option key={node.id} value={node.id}>{shapeAncestors(graph, node.id).map((item) => item.label).join(' / ')}</option>)}</select></label>}
        <label>{dialog === 'turn' ? '무엇을 어떻게 바꿨나요?' : '어떤 일을 하나요?'}<textarea value={newSummary} onChange={(event) => setNewSummary(event.target.value)} rows={4} maxLength={4000} placeholder={dialog === 'turn' ? '바뀐 이유와 결과를 적습니다. 기록이 실제 개발 완료를 대신하지는 않습니다.' : '사용자가 무엇을 할 수 있는지 설명합니다.'} /></label>
        <div className="sm-form-actions"><button className="sm-button" type="button" onClick={() => setDialog(null)}>돌아가기</button><button className="sm-button sm-button--dark" disabled={busy || !newTitle.trim()}><ShapeIcon name={dialog === 'turn' ? 'history' : 'plus'} size={15} />{dialog === 'turn' ? '이 형상 기록' : newSection ? '섹션 추가' : '기능 추가'}</button></div>
      </form>
    </Dialog>}
    {dialog === 'brief' && <Dialog wide title="AI와 기획문답" subtitle={briefFocusId ? `[${briefFocusId}] ${graph.nodes.find((node) => node.id === briefFocusId)?.label}` : '원본 지도는 참조하고, 바뀐 내용과 이번 요청만 전달합니다.'} onClose={() => setDialog(null)}>
      <p className="sm-discussion-path">필요한 문답 → 수정안 확정 → 사용자 승인 → 실제 개선</p>
      <div className="sm-discussion-fields sm-form"><label>풀고 싶은 문제<textarea rows={2} value={requestDraft.problem} maxLength={4000} onChange={(event) => updateRequest('problem', event.target.value)} placeholder="지금 무엇이 어렵거나 잘못되었나요?" /></label><label>목적<textarea rows={2} value={requestDraft.purpose} maxLength={4000} onChange={(event) => updateRequest('purpose', event.target.value)} placeholder="사용자가 얻을 결과" /></label><label>해결 성공 기준<textarea rows={2} value={requestDraft.successCriteria} maxLength={4000} onChange={(event) => updateRequest('successCriteria', event.target.value)} placeholder="무엇을 확인하면 해결된 건가요?" /></label></div>
      <label className="sm-approval-choice"><input type="checkbox" checked={requestDraft.approved} disabled={!requestDraft.problem.trim() || !requestDraft.successCriteria.trim()} onChange={(event) => { setRequestDraft((value) => ({ ...value, approved: event.target.checked })); setBrief(null); }} />위 요청을 확정했고 실행을 승인합니다</label>
      <div className="sm-form-actions"><button className="sm-button" onClick={() => generateBrief(briefFocusId, requestDraft)}><ShapeIcon name="mail" size={14} />{requestDraft.approved ? '승인한 요청 만들기' : '문답용 글 만들기'}</button><small>모호한 내용은 AI가 먼저 질문합니다.</small></div>
      {brief && <><label className="sm-sr-only" htmlFor="sm-ai-brief">AI에게 전달할 요청</label><textarea id="sm-ai-brief" className="sm-brief-text" value={brief} readOnly /><div className="sm-form-actions"><button className="sm-button" onClick={downloadBrief}><ShapeIcon name="download" size={15} />글로 저장</button><button className="sm-button sm-button--dark" onClick={copyBrief}><ShapeIcon name={copied ? 'check' : 'copy'} size={15} />{copied ? '복사했습니다' : '요청 복사'}</button></div></>}
    </Dialog>}
    {dialog === 'edge' && edgeDraft && <Dialog title="연결 내용과 속성" onClose={() => setDialog(null)}><form className="sm-form" onSubmit={async (event) => { event.preventDefault(); const { condition, ...link } = edgeDraft; if (await send({ type: 'upsertLink', link: { ...link, label: link.label.trim(), ...(condition.trim() ? { condition: condition.trim() } : {}) } })) setDialog(null); }}>
      <p className="sm-edge-endpoints"><code>{edgeDraft.source}</code><ShapeIcon name="arrow" size={14} /><code>{edgeDraft.target}</code></p>
      <label>연결선에 쓸 내용<input required maxLength={180} value={edgeDraft.label} onChange={(event) => setEdgeDraft((value) => ({ ...value, label: event.target.value }))} placeholder="무엇을 전달하거나 함께 하나요?" /></label>
      <label>선의 관계<select value={edgeDraft.kind} onChange={(event) => setEdgeDraft((value) => ({ ...value, kind: event.target.value }))}>{Object.entries(LINK_KINDS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
      <label>연결 조건<textarea rows={2} maxLength={4000} value={edgeDraft.condition} onChange={(event) => setEdgeDraft((value) => ({ ...value, condition: event.target.value }))} /></label>
      <div className="sm-form-actions">{graph.links?.some((link) => link.id === edgeDraft.id) && <button type="button" className="sm-text-button is-danger" onClick={async () => { if (await send({ type: 'removeLink', id: edgeDraft.id })) setDialog(null); }}>연결 삭제</button>}<button className="sm-button sm-button--dark" disabled={busy}>연결 저장</button></div>
    </form></Dialog>}
    {dialog === 'help' && <Dialog title="지도를 함께 읽는 법" onClose={() => setDialog(null)}>
      <p className="sm-dialog-copy">기능을 누르면 역할과 의견을 볼 수 있습니다. 왼쪽 레이어에서 기능을 접고 펼치고, 지도에서 위치와 연결을 편집하세요.</p>
      <div className="sm-help-colors">{Object.entries(SHAPE_STATES).filter(([status]) => status !== 'neutral').map(([status]) => <div key={status}><StateBadge status={status} /><p>{{ planned: '작성한 다음 변경안이 있습니다.', verified: '사람이 직접 확인했습니다. 내용이 바뀌면 해제됩니다.', changed: '직전에 기록한 턴에서 달라진 기능입니다.', concern: '아직 논의가 끝나지 않은 걱정이 있습니다.' }[status]}</p></div>)}</div>
      <p className="sm-help-tip">Ctrl/⌘ + 휠로 확대 · 휠로 이동 · Ctrl/⌘ + Z로 취소 · Ctrl/⌘ + Shift + Z로 다시 실행 · Delete로 삭제</p>
    </Dialog>}
    {dialog === 'changes' && <Dialog title="이 턴에서 달라진 기능" subtitle={selectedTurn?.title || turns.at(-1)?.title} onClose={() => setDialog(null)}>
      <div className="sm-turn-change-list">{[['changedIds', '개선한 기능'], ['addedIds', '추가한 기능'], ['removedIds', '제거한 기능']].map(([key, label]) => <section key={key}><h3>{label} <span>{diff[key].length}</span></h3>{diff[key].length ? diff[key].map((id) => {
        const node = graph.nodes.find((item) => item.id === id) || previousTurn?.nodes.find((item) => item.id === id);
        return <button key={id} disabled={key === 'removedIds'} onClick={() => { focusNode(node.parentId || node.id); openNode(id); setDialog(null); }}><ShapeIcon name={key === 'addedIds' ? 'plus' : key === 'removedIds' ? 'minus' : 'history'} size={14} />{node?.label || id}<ShapeIcon name="arrow" size={13} /></button>;
      }) : <p>해당하는 기능이 없습니다.</p>}</section>)}</div>
    </Dialog>}
    {dialog === 'repository' && <Dialog wide title="레포에서 실제로 바뀐 것" subtitle="현재 지도에 연결한 파일을 기준으로 실제 코드 변경을 보여줍니다." onClose={() => setDialog(null)}>
      {!repository ? <p className="sm-dialog-copy">레포의 변경 기록을 읽고 있습니다…</p> : !repository.connected ? <p className="sm-dialog-copy">{repository.error || '이 지도에는 레포가 연결되어 있지 않습니다. 지도 파일과 논의는 그대로 사용할 수 있습니다.'}</p> : <>
        <div className="sm-repo-heading"><ShapeIcon name="code" size={16} /><strong>{repository.name}</strong><span>{repository.branch}</span></div>
        {repositoryScope && <p className="sm-reader-note">보고 있는 기능: {repositoryScope.focus.label} · 이 안의 세부 기능과 연결된 변경을 함께 보여줍니다.</p>}
        {repository.working.files.length > 0 && <div className="sm-repo-working"><span>작업 중 · 아직 기록 전</span><p>파일 {repository.working.files.length}개 · 연결된 기능 {repository.working.blocks.length}개</p></div>}
        <div className="sm-repo-commits">{repositoryCommits.map((commit) => <article key={commit.sha}><header><code>{commit.shortSha}</code><small>{dateText(commit.createdAt)}</small></header><h3>{commit.title}</h3><div className="sm-repo-blocks">{commit.blocks.length ? commit.blocks.filter((block) => !repositoryScope || repositoryScope.ids.has(block.id)).map((block) => <button key={block.id} onClick={() => { const node = graph.nodes.find((item) => item.id === block.id); if (node) { focusNode(node.parentId || node.id); openNode(node.id); setDialog(null); } }}>{block.label}<ShapeIcon name="arrow" size={11} /></button>) : <span>지도에 연결된 기능 없음</span>}</div><details><summary>변경 파일 {commit.files.length}개</summary>{commit.files.map((file) => <code key={file}>{file}</code>)}</details></article>)}</div>
        {!repositoryCommits.length && <p className="sm-tab-intro">최근 코드 기록에서 이 기능과 연결된 변경을 찾지 못했습니다.</p>}
      </>}
    </Dialog>}
  </main>;
}
