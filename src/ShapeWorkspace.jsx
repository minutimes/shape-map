import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, MiniMap, ReactFlow, applyNodeChanges, getViewportForBounds, useReactFlow } from '@xyflow/react';
import { mutateMap, readMap, saveView } from './api.js';
import { compareTurnGraphs, getBlockState, nodeFingerprint } from '../lib/shape.mjs';
import { readingStates } from '../lib/diagram.mjs';
import { absoluteShapePosition, defaultShapeCollapsed, shapeAncestors, shapeLayout, SHAPE_VIEWS, turnGraph } from './shapeLayout.js';
import { ShapeBlock, ShapeGroup, ShapeIcon, StateBadge, SHAPE_STATES } from './ShapeNode.jsx';
import { ShapeConnection } from './ShapeEdge.jsx';
import { routeShapeEdges, shapeCanvasBounds } from './shapeRouting.js';
import { blockDraftValues, BLOCK_DRAFT_FIELDS, draftConflicts, reconcileDraft } from './shapeDraft.js';
import CanvasOverview from './CanvasNavigation.jsx';
import ScopeReader, { FeatureHistory } from './ScopeReader.jsx';
import { areaReading, featureHistory } from './systemReading.js';
import './shapeWorkspace.css';

const nodeTypes = { shapeBlock: ShapeBlock, shapeGroup: ShapeGroup };
const edgeTypes = { shapeConnection: ShapeConnection };
const EMPTY_DIFF = { addedIds: [], changedIds: [], removedIds: [] };
const EMPTY_TURNS = [];
const dateText = (date) => new Date(date).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' });
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

function BlockInspector({ node, graph, baselineNode, state, turns, readOnly, mapPath, send, busy, onClose, onOpen, onRepository }) {
  const [tab, setTab] = useState('overview');
  const draftKey = `shape-map:draft:${mapPath}:${node.id}`;
  const initial = blockDraftValues(node);
  const restored = useRef(readOnly ? null : localDraft(draftKey, null));
  const [draft, setDraft] = useState(() => restored.current?.values || { ...initial, comment: '', kind: 'note' });
  const [base, setBase] = useState(() => restored.current?.base || initial);
  const currentFingerprint = nodeFingerprint(node, graph);
  const [expectedFingerprint, setExpectedFingerprint] = useState(() => restored.current?.fingerprint || currentFingerprint);
  const conflicts = draftConflicts(draft, base, initial);
  const [editing, setEditing] = useState(false);
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
    const proposal = { ...node.proposal, reason: draft.reason.trim(), ...(draft.logic.trim() ? { logic: draft.logic.trim() } : {}) };
    if (await send({ type: 'setProposal', id: node.id, proposal, expectedFingerprint })) setTab('overview');
  }
  const comments = node.block?.comments || [];
  const children = graph.nodes.filter((item) => item.parentId === node.id && item.section !== 'reference');
  const links = (graph.links || []).filter((link) => link.source === node.id || link.target === node.id);
  const records = featureHistory(turns, node.id);
  return <aside className="sm-inspector" aria-label="기능 블록 상세" data-testid="shape-inspector">
    <header className="sm-inspector__heading"><span className="sm-eyebrow">기능 블록</span><button className="sm-icon-button" aria-label="기능 상세 닫기" onClick={onClose}><ShapeIcon name="close" /></button></header>
    <h2>{node.label}</h2><StateBadge status={state.status} />
    <div className="sm-inspector-tabs" role="tablist" aria-label="기능 정보">
      {[['overview', '개요'], ['links', `연결${links.length ? ` ${links.length}` : ''}`], ['history', '변경 기록'], ['comments', `의견${comments.length ? ` ${comments.length}` : ''}`], ['proposal', '다음 변경안']].map(([id, label]) =>
        <button key={id} role="tab" aria-selected={tab === id} aria-controls={`sm-inspector-panel-${id}`} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    <div className="sm-inspector__body" role="tabpanel" id={`sm-inspector-panel-${tab}`}>
      {readOnly && <p className="sm-history-note"><ShapeIcon name="history" size={14} />당시 기록을 보고 있습니다.</p>}
      {draftWarning && <p role="alert" className="sm-field-warning">초안을 이 브라우저에 보관하지 못했습니다.</p>}
      {!readOnly && conflicts.length > 0 && <section className="sm-draft-conflict" role="alert"><h3>다른 곳에서도 이 내용을 고쳤습니다.</h3><p>두 내용을 비교한 뒤 이어서 작성해 주세요.</p>{conflicts.map((field) => <div key={field}><strong>{{ label: '기능 이름', summary: '하는 일', reason: '변경 이유', logic: '바뀐 뒤의 동작', files: '관련 파일' }[field]}</strong><small>새 원본</small><p>{initial[field] || '작성한 내용 없음'}</p><small>내 초안</small><p>{draft[field]}</p></div>)}<button className="sm-button" onClick={() => { setBase(initial); setExpectedFingerprint(currentFingerprint); }}>내 초안으로 이어 쓰기</button><button className="sm-text-button" onClick={() => { setDraft((value) => ({ ...value, ...initial })); setBase(initial); setExpectedFingerprint(currentFingerprint); }}>새 원본으로 바꾸기</button></section>}
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
        {readOnly ? <div className="sm-readonly-proposal"><h3>변경 이유</h3><p>{node.proposal?.reason || '이 턴에는 변경안이 없습니다.'}</p>{node.proposal?.logic && <><h3>바뀐 뒤의 동작</h3><p>{node.proposal.logic}</p></>}</div> : <form className="sm-form" onSubmit={saveProposal}>
          <label>왜 바꾸나요?<textarea value={draft.reason} onChange={(event) => update('reason', event.target.value)} rows={3} placeholder="예: 무엇이 어디에 있는지 한눈에 찾기 어렵습니다." maxLength={4000} required /></label>
          <label>바꾼 뒤 어떻게 동작하나요?<textarea value={draft.logic} onChange={(event) => update('logic', event.target.value)} rows={5} placeholder="예: 기능을 누르면 역할과 남은 논의를 함께 보여줍니다." maxLength={4000} /></label>
          <button className="sm-button sm-button--planned" disabled={busy || !draft.reason.trim() || Boolean(conflicts.length)}><ShapeIcon name="arrow" size={15} />변경안 저장</button>
          {node.proposal && <button className="sm-text-button" type="button" disabled={busy || Boolean(conflicts.length)} onClick={async () => { if (await send({ type: 'setProposal', id: node.id, proposal: null, expectedFingerprint })) { update('reason', ''); update('logic', ''); } }}>이 변경안 철회</button>}
        </form>}
      </>}
    </div>
    <footer className="sm-inspector__footer"><ShapeIcon name="box" size={13} /><span>{shapeAncestors(graph, node.id).slice(0, -1).map((item) => item.label).join(' / ') || '제품 전체'}</span></footer>
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [filter, setFilter] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [brief, setBrief] = useState(null);
  const [repository, setRepository] = useState(null);
  const [repositoryScopeId, setRepositoryScopeId] = useState(null);
  const [copied, setCopied] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSummary, setNewSummary] = useState('');
  const [newParent, setNewParent] = useState('');
  const [minimap, setMinimap] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 540px)').matches);
  const [singleColumn, setSingleColumn] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  const [nodes, setNodes] = useState([]);
  const [zoom, setZoom] = useState(1);
  const [viewPositions, setViewPositions] = useState({});
  const [collapsedIds, setCollapsedIds] = useState(null);
  const [lensSelections, setLensSelections] = useState({});
  const [showActivation, setShowActivation] = useState(false);
  const [detailedLinks, setDetailedLinks] = useState(false);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const clientId = useRef(`shape-${crypto.randomUUID()}`);
  const viewTimer = useRef(null);
  const canvasRef = useRef(null);
  const restoredMap = useRef(null);
  const flow = useReactFlow();
  const accept = useCallback((next) => { snapshotRef.current = next; setSnapshot(next); }, []);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 540px)');
    const tablet = window.matchMedia('(max-width: 900px)');
    const change = () => { setCompact(media.matches); setSingleColumn(tablet.matches); setViewPositions({}); };
    media.addEventListener('change', change); tablet.addEventListener('change', change);
    return () => { media.removeEventListener('change', change); tablet.removeEventListener('change', change); };
  }, []);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    let disposed = false;
    readMap().then((next) => { if (!disposed) { accept(next); setConnection('online'); } }).catch(() => { if (!disposed) setConnection('offline'); });
    const events = new EventSource('/api/events');
    events.addEventListener('snapshot', (event) => { if (!disposed) { accept(JSON.parse(event.data)); setConnection('online'); } });
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
  async function send(operation) {
    if (busyRef.current || !snapshotRef.current || turnId) return false;
    busyRef.current = true; setBusy(true);
    try {
      const next = await mutateMap({ baseRevision: snapshotRef.current.revision, clientId: clientId.current, operation });
      accept(next); setToast({ text: operation.type === 'createTurn' ? '현재 형상을 턴으로 기록했습니다.' : '지도에 저장했습니다.' });
      return next;
    } catch (error) {
      if (error.body?.snapshot) accept(error.body.snapshot);
      setToast({ error: true, text: error.status === 409 ? '다른 곳에서 바뀐 내용이 있습니다. 초안은 보관했습니다. 현재 내용을 확인한 뒤 다시 저장해 주세요.' : connection === 'offline' ? '연결이 끊겼습니다. 입력한 초안은 이 브라우저에 남아 있습니다.' : '저장하지 못했습니다. 입력한 내용을 확인해 주세요.' });
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }
  const turns = snapshot?.graph.turns || EMPTY_TURNS;
  const selectedTurn = turns.find((turn) => turn.id === turnId);
  const graph = useMemo(() => selectedTurn ? turnGraph(selectedTurn) : snapshot?.graph, [selectedTurn, snapshot?.graph]);
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
  const openNode = useCallback((id) => { setSelectedId(id); setSidebarOpen(false); }, []);
  const focusNode = useCallback((id) => {
    setFocusId(id); setSelectedId(null); setViewPositions({}); setCollapsedIds(null); setSidebarOpen(false);
    const url = new URL(window.location.href);
    const rootId = snapshotRef.current?.graph.nodes.find((node) => !node.parentId)?.id;
    id === rootId ? url.searchParams.delete('focus') : url.searchParams.set('focus', id);
    window.history.replaceState(null, '', url);
  }, []);
  const toggleNode = useCallback((id) => {
    const collapsed = new Set(collapsedIds || defaultShapeCollapsed(graph, currentFocus.id));
    collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
    const next = [...collapsed]; setCollapsedIds(next); persistView({ collapsedIds: next });
  }, [collapsedIds, graph, currentFocus?.id, turnId]);
  function showDepth(levels) {
    const depth = shapeAncestors(graph, currentFocus.id).length;
    const parents = new Set(graph.nodes.map((node) => node.parentId));
    const next = graph.nodes.filter((node) => parents.has(node.id) && shapeAncestors(graph, node.id).length >= depth + levels).map((node) => node.id);
    setCollapsedIds(next); persistView({ collapsedIds: next });
  }
  const layout = useMemo(() => graph ? shapeLayout(graph, { focusId: currentFocus?.id, mode,
    positions: mode === 'function' || singleColumn ? {} : viewPositions, states, onOpen: openNode, onFocus: focusNode, onToggle: toggleNode, collapsedIds, reading, showActivation, detailedLinks,
    availableWidth: windowWidth - (windowWidth > 1400 ? 225 : windowWidth > 1080 ? 208 : windowWidth > 850 ? 183 : 0), compact, singleColumn }) : { nodes: [], edges: [] },
  [graph, currentFocus?.id, mode, viewPositions, states, openNode, focusNode, toggleNode, collapsedIds, reading, showActivation, detailedLinks, compact, singleColumn, windowWidth]);
  useEffect(() => setNodes(layout.nodes.map((node) => ({ ...node, selected: node.id === selectedId,
    className: (filter && node.data.state.status !== filter) || reading[node.id]?.active === false ? 'sm-node-muted' : '' }))), [layout, selectedId, filter, reading]);
  const canvasEdges = useMemo(() => routeShapeEdges(nodes, layout.edges), [nodes, layout.edges]);
  const diagramGeometry = useRef(null);
  diagramGeometry.current = { nodes, edges: canvasEdges };
  const fitDiagram = useCallback(() => {
    const bounds = shapeCanvasBounds(diagramGeometry.current.nodes, diagramGeometry.current.edges);
    const canvas = canvasRef.current;
    if (bounds && canvas) flow.setViewport(getViewportForBounds(bounds, canvas.clientWidth, canvas.clientHeight, .2, 1.15, .09));
  }, [flow]);
  const layoutKey = `${snapshot?.mapPath}:${turnId || 'current'}:${currentFocus?.id}:${mode}:${compact}:${singleColumn}:${detailedLinks}:${showActivation}`;
  const overviewNodes = useMemo(() => nodes.map((node) => {
    return { ...node, position: absoluteShapePosition(nodes, node.id),
      data: { ...node.data, label: node.data.node.label, parentId: node.data.node.parentId,
        depth: shapeAncestors(graph, node.id).length - 1, path: shapeAncestors(graph, node.id).map((item) => item.label),
        layout: { width: node.style.width, height: node.style.height } } };
  }), [nodes, graph]);
  useEffect(() => {
    if (!snapshot || restoredMap.current === snapshot.mapPath) return;
    restoredMap.current = snapshot.mapPath;
    if (!focusId && snapshot.view?.shape?.layoutVersion === 2) {
      setViewPositions(snapshot.view.shape.positions || {});
      setCollapsedIds(snapshot.view.shape.collapsedIds || null);
    }
  }, [snapshot]);
  useEffect(() => {
    if (!graph) return;
    const timer = setTimeout(() => {
      const view = snapshotRef.current?.view?.shape;
      const saved = view?.layoutVersion === 2 && !focusId && !singleColumn && !turnId && !detailedLinks && !showActivation && mode === 'system' && currentFocus?.id === root?.id ? view.viewport : null;
      if (compact || (singleColumn && mode !== 'function')) {
        const bounds = shapeCanvasBounds(diagramGeometry.current.nodes, diagramGeometry.current.edges);
        const canvasWidth = canvasRef.current?.clientWidth || window.innerWidth;
        if (bounds) {
          const zoom = Math.min(1, (canvasWidth - 40) / Math.max(1, bounds.width));
          flow.setViewport({ x: (canvasWidth - bounds.width * zoom) / 2 - bounds.x * zoom, y: 25 - bounds.y * zoom, zoom });
        }
      }
      else if (saved) flow.setViewport(saved);
      else if (mode === 'function' || currentFocus?.id === root?.id) fitDiagram();
      else flow.setViewport({ x: 28, y: 28, zoom: .9 });
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
      if (dialog || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && ['+', '=', '-'].includes(event.key)) { event.preventDefault(); event.key === '-' ? flow.zoomOut() : flow.zoomIn(); }
      if (command && event.key === '0') { event.preventDefault(); flow.fitView({ padding: .09, maxZoom: 1.15, duration: 0 }); }
      if (event.key === 'Escape') { setSelectedId(null); setFilter(null); setSidebarOpen(false); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [flow, dialog]);
  async function persistView(patch) {
    if (turnId || !snapshotRef.current?.sourceStatus.valid) return;
    try {
      const next = await saveView({ baseRevision: snapshotRef.current.revision, clientId: clientId.current, patch: { shape: { layoutVersion: 2, ...patch } } });
      // A view save must not replace newer semantic edits delivered by SSE.
      if (next.revision === snapshotRef.current.revision) accept(next);
    } catch { /* Navigation remains usable; semantic drafts are saved separately. */ }
  }
  async function openBrief() {
    setDialog('brief'); setBrief(null); setCopied(false);
    try { const response = await fetch('/api/brief'); if (!response.ok) throw new Error(); const body = await response.json(); setBrief(body.text); }
    catch { setBrief('논의 내용을 불러오지 못했습니다. 연결을 확인한 뒤 다시 열어 주세요.'); }
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
  function openCreate(type) {
    setNewTitle(''); setNewSummary(''); setNewParent(selectedId || currentFocus?.id || root.id); setDialog(type);
  }
  async function create(event) {
    event.preventDefault();
    let saved; let createdId;
    if (dialog === 'turn') saved = await send({ type: 'createTurn', title: newTitle.trim(), summary: newSummary.trim() });
    else {
      const parent = graph.nodes.find((node) => node.id === newParent) || root;
      createdId = `block-${crypto.randomUUID().slice(0, 8)}`;
      saved = await send({ type: 'addNode', id: createdId, parentId: parent.id,
        shape: 'rectangle', category: parent.category, label: newTitle.trim(),
        block: { summary: newSummary.trim() } });
    }
    if (saved) { setDialog(null); if (dialog === 'block') { focusNode(newParent); openNode(createdId); } }
  }
  function chooseTurn(id) { setTurnId(id); setPlaying(false); setSelectedId(null); setViewPositions({}); setCollapsedIds(null); }
  const results = search.trim() ? graph?.nodes.filter((node) => productArea.ids.has(node.id) && `${node.label} ${node.block?.summary || ''} ${node.task?.logic || ''}`.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 25) : [];
  if (!snapshot) return <main className="sm-loading"><span className="sm-logo" /><h1>shape map</h1><p>{connection === 'offline' ? '지도를 불러오지 못했습니다.' : '제품 지도를 펼치고 있습니다.'}</p>{connection === 'offline' && <button className="sm-button" onClick={() => window.location.reload()}>다시 연결</button>}</main>;
  return <main className={`shape-workspace${selected ? ' has-inspector' : ''}${selectedTurn ? ' is-history' : ''}`}>
    <header className="sm-topbar">
      <a className="sm-brand" href="/" aria-label="Shape map 홈"><span className="sm-logo" /><span>shape map<span className="sm-brand__dot">.</span></span></a>
      <span className="sm-topbar__divider" /><span className="sm-project-name"><ShapeIcon name="code" size={16} />{root.label}</span>
      <div className="sm-topbar__actions"><span className={`sm-save-state${connection !== 'online' || !snapshot.sourceStatus.valid ? ' is-offline' : ''}`} role="status"><span />{!snapshot.sourceStatus.valid ? '원본 확인 필요' : busy ? '저장 중' : connection === 'online' ? '로컬 저장됨' : '연결 확인 중'}</span>
        <a className="sm-button sm-button--subtle sm-detail-link" href="?editor=1"><ShapeIcon name="code" size={15} />세부 편집</a>
        <button className="sm-button sm-button--dark" disabled={Boolean(turnId)} onClick={openBrief}><ShapeIcon name="mail" size={15} /><span>AI와 논의</span></button>
      </div>
    </header>
    {!snapshot.sourceStatus.valid && <div className="sm-error-banner" role="alert">원본 지도에 읽을 수 없는 내용이 있습니다. 마지막으로 읽은 지도를 보여줍니다. 세부 편집에서 원본을 확인해 주세요.</div>}
    {connection === 'offline' && <div className="sm-error-banner" role="alert">연결을 확인하고 있습니다. 입력한 의견과 변경안은 이 브라우저에 보관됩니다.</div>}
    <div className="sm-main">
      <aside className={`sm-sidebar${sidebarOpen ? ' is-open' : ''}`} aria-label="제품 지도 탐색">
        <div className="sm-sidebar__project"><div className="sm-project-glyph"><ShapeIcon name="box" size={19} /></div><div><strong>{root.label}</strong><small>제품을 함께 이해하는 지도</small></div><button className="sm-icon-button sm-sidebar__close" aria-label="탐색 닫기" onClick={() => setSidebarOpen(false)}><ShapeIcon name="close" /></button></div>
        <label className="sm-search"><ShapeIcon name="search" size={15} /><input placeholder="기능 찾기" aria-label="기능 찾기" value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>/</kbd></label>
        {search.trim() ? <nav className="sm-search-results" aria-label="검색 결과">{results?.length ? results.map((node) => <button key={node.id} onClick={() => { focusNode(node.parentId || node.id); openNode(node.id); setSearch(''); }}><ShapeIcon name="box" size={14} /><span>{node.label}</span></button>) : <p>일치하는 기능이 없습니다.</p>}</nav> : <>
          <p className="sm-nav-heading">제품 지도</p>
          <nav className="sm-view-nav" aria-label="지도 읽는 방식">{SHAPE_VIEWS.map((view) => <button key={view.id} aria-pressed={mode === view.id} onClick={() => { setMode(view.id); setViewPositions({}); setSidebarOpen(false); }}><ShapeIcon name={view.id === 'system' ? 'grid' : view.id === 'function' ? 'branch' : 'box'} size={17} /><span>{view.label}</span>{mode === view.id && <span className="sm-nav-current" />}</button>)}</nav>
          <div className="sm-sidebar__separator" /><p className="sm-nav-heading">구성하는 기능 <span>{area.total}</span></p>
          <nav className="sm-outline" aria-label="제품 기능">{graph.nodes.filter((node) => node.parentId === root.id && node.section !== 'reference').map((node) => <button key={node.id} aria-current={currentFocus?.id === node.id ? 'location' : undefined} onClick={() => focusNode(node.id)}><span className={`sm-outline-dot sm-outline-dot--${states[node.id].status}`} /><span>{node.label}</span><ShapeIcon name="chevron" size={12} /></button>)}
            {focusId && focusId !== root.id && <button className="sm-outline__all" onClick={() => focusNode(root.id)}><ShapeIcon name="back" size={13} />전체 지도</button>}
          </nav>
        </>}
        <div className="sm-sidebar__bottom"><button onClick={openRepository}><ShapeIcon name="history" size={14} />레포 변경 기록<ShapeIcon name="arrow" size={13} /></button><span className="sm-local-file"><ShapeIcon name="code" size={14} />{snapshot.mapPath.split('/').at(-1)}</span><button onClick={() => setDialog('help')}><ShapeIcon name="help" size={14} />지도 읽는 법<ShapeIcon name="arrow" size={13} /></button></div>
      </aside>
      <section className="sm-stage" aria-label="무한 캔버스 제품 지도">
        <div className="sm-stage-heading"><div className="sm-stage-heading__title"><button className="sm-icon-button sm-mobile-menu" aria-label="제품 탐색 열기" onClick={() => setSidebarOpen(true)}><ShapeIcon name="menu" /></button><div><nav className="sm-breadcrumb" aria-label="지도 경로">{shapeAncestors(graph, currentFocus.id).map((node, itemIndex) => <span key={node.id}>{itemIndex > 0 && <ShapeIcon name="chevron" size={10} />}<button onClick={() => focusNode(node.id)} aria-current={node.id === currentFocus.id ? 'location' : undefined}>{itemIndex === 0 ? '제품 전체' : node.label}</button></span>)}</nav><h1>{currentFocus.label}<span>{SHAPE_VIEWS.find((view) => view.id === mode).label}</span></h1></div></div><button className="sm-button" disabled={Boolean(turnId) || busy} onClick={() => openCreate('block')}><ShapeIcon name="plus" size={15} /><span>기능 추가</span></button></div>
        <div className="sm-area-reading" aria-label="전체 시스템과 현재 영역">
          <button className="sm-area-home" onClick={() => focusNode(root.id)}><ShapeIcon name="grid" size={14} />전체 구성</button>
          <span>{currentFocus.id === root.id ? `전체 ${area.total}개 기능 · 큰 영역 ${area.children.length}개` : `전체 ${area.total}개 중 이 영역 ${area.count}개`}</span>
          <button className="sm-area-explain" onClick={() => setDialog('reading')}><ShapeIcon name="help" size={14} />구성·변경 설명<ShapeIcon name="chevron" size={11} /></button>
        </div>
        <div className="sm-status-legend" aria-label="상태별 기능 필터"><span className="sm-legend-label">색으로 읽기</span>{Object.entries(SHAPE_STATES).filter(([status]) => status !== 'neutral').map(([status, state]) => <button key={status} className={`sm-legend-item sm-legend-item--${status}`} aria-pressed={filter === status} onClick={() => setFilter(filter === status ? null : status)}><span className="sm-state__dot" />{state.label}<b>{totals[status]}</b></button>)}{filter && <button className="sm-filter-clear" onClick={() => setFilter(null)}><ShapeIcon name="close" size={12} />필터 해제</button>}</div>
        <div className="sm-diagram-tools" aria-label="기능 구성과 조건">
          <div className="sm-depth-tools"><span>구성 깊이</span><button onClick={() => showDepth(1)}>큰 기능</button><button onClick={() => showDepth(3)}>세부 기능</button><button onClick={() => showDepth(Infinity)}>모두 펼치기</button></div>
          {(graph.lenses || []).map((lens) => <label className="sm-lens-select" key={lens.id}><span>{lens.label}</span><select aria-label={lens.label} value={lensSelections[lens.id] || ''} onChange={(event) => setLensSelections((value) => ({ ...value, [lens.id]: event.target.value }))}><option value="">전체</option>{lens.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>)}
          {(graph.links || []).some((link) => link.kind === 'activation') && <button className="sm-model-lines" aria-pressed={showActivation} onClick={() => setShowActivation(!showActivation)}><ShapeIcon name="branch" size={13} />모델 연결선</button>}
          {(graph.links || []).length > 0 && <button className="sm-model-lines" aria-pressed={detailedLinks} onClick={() => setDetailedLinks(!detailedLinks)}><ShapeIcon name="branch" size={13} />세부 연결선</button>}
          <span className="sm-connection-key"><i />흐름<span>┄</span>자료·조건</span>
        </div>
        {(graph.lenses || []).some((lens) => lensSelections[lens.id]) && <div className="sm-lens-description" role="status"><ShapeIcon name="branch" size={13} /><span>{graph.lenses.map((lens) => lens.options.find((option) => option.id === lensSelections[lens.id])?.description).filter(Boolean).join(' · ')}<small>지도에 기록된 관련 기능을 강조합니다.</small></span><button onClick={() => setLensSelections({})}>선택 해제</button></div>}
        <div className="sm-canvas" data-testid="shape-canvas" ref={canvasRef}>
          <ReactFlow nodes={nodes} edges={canvasEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} minZoom={.2} maxZoom={2} panOnScroll zoomOnScroll={false} zoomOnPinch zoomActivationKeyCode="Meta" panOnDrag selectionOnDrag={false} nodesConnectable={false} deleteKeyCode={null} colorMode="light"
            onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
            onNodeClick={(_event, node) => openNode(node.id)} onPaneClick={() => setSelectedId(null)}
            onNodeDragStop={(_event, node) => {
              if (turnId || node.parentId || mode === 'function') return;
              const positions = { ...viewPositions, [node.id]: node.position }; setViewPositions(positions); persistView({ positions });
            }}
            onMove={(_event, viewport) => setZoom(viewport.zoom)}
            onMoveEnd={(_event, viewport) => {
              if (singleColumn || turnId || mode !== 'system' || currentFocus.id !== root.id) return;
              clearTimeout(viewTimer.current); viewTimer.current = setTimeout(() => persistView({ viewport }), 450);
            }}
            fitViewOptions={{ padding: .09, maxZoom: 1.15 }}>
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d7d7dc" />
            <CanvasOverview nodes={overviewNodes} selectedId={selectedId} canvasRef={canvasRef} busy={busy} onNavigate={(id) => openNode(id)} actionLabel="상세 보기" />
            {minimap && <MiniMap pannable zoomable nodeColor={(node) => ({ planned: '#e36a69', verified: '#6baf86', changed: '#719ddc', concern: '#d3af5a' }[node.data.state?.status] || '#dedee2')} />}
          </ReactFlow>
          {selectedTurn && <div className="sm-replay-badge"><ShapeIcon name="history" size={14} />턴 {selectedTurn.number} · {selectedTurn.title}<button onClick={() => chooseTurn(null)}>현재로 돌아가기<ShapeIcon name="arrow" size={13} /></button></div>}
          <div className="sm-canvas-bottom"><span className="sm-canvas-tip">{mode === 'function' ? '선은 기능의 소속을 나타냅니다' : '카드 안은 소속 · 화살표는 연결 · +로 내부 펼치기'}</span><div className="sm-zoom"><button aria-label="지도 축소" onClick={() => flow.zoomOut({ duration: reducedMotion() ? 0 : 140 })}><ShapeIcon name="minus" size={14} /></button><button className="sm-zoom-value" aria-label="지도 100%로 보기" onClick={() => flow.zoomTo(1)}>{Math.round(zoom * 100)}%</button><button aria-label="지도 확대" onClick={() => flow.zoomIn({ duration: reducedMotion() ? 0 : 140 })}><ShapeIcon name="plus" size={14} /></button><span /><button aria-label="지도 화면에 맞추기" onClick={fitDiagram}><ShapeIcon name="expand" size={14} /></button><button aria-label="미니맵 보기" aria-pressed={minimap} onClick={() => setMinimap(!minimap)}><ShapeIcon name="grid" size={14} /></button></div></div>
        </div>
        <footer className="sm-timeline" aria-label="개발 턴 타임라인">
          <div className="sm-timeline__heading"><div><ShapeIcon name="history" size={16} /><strong>{selectedTurn ? `턴 ${selectedTurn.number}` : '현재 형상'}</strong><span>{selectedTurn ? selectedTurn.summary || selectedTurn.title : turns.length ? '지난 개선을 돌아보고, 다음 변화를 계획하세요.' : '첫 형상을 기록하면 개발 과정을 되짚을 수 있습니다.'}</span></div>{previousTurn && <button className="sm-turn-diff" onClick={() => setDialog('changes')}>변경 {diff.changedIds.length} · 추가 {diff.addedIds.length} · 제거 {diff.removedIds.length}</button>}<button className="sm-button sm-button--small" disabled={Boolean(turnId) || busy} onClick={() => openCreate('turn')}><ShapeIcon name="plus" size={13} />턴 기록</button></div>
          <div className="sm-timeline__track"><button className="sm-play" aria-label={playing ? '턴 재생 멈추기' : '개발 턴 재생'} disabled={!turns.length} onClick={() => { if (!playing) { setTurnId(turns[0].id); setSelectedId(null); setViewPositions({}); } setPlaying(!playing); }}><ShapeIcon name={playing ? 'pause' : 'play'} size={15} /></button><div className="sm-turns">{turns.map((turn) => <button key={turn.id} className={`sm-turn${turnId === turn.id ? ' is-selected' : ''}`} onClick={() => chooseTurn(turn.id)}><span className="sm-turn__dot" /><span className="sm-turn__text"><b>턴 {turn.number}</b><span>{turn.title}</span></span><small>{dateText(turn.createdAt)}</small></button>)}<button className={`sm-turn sm-turn--current${!turnId ? ' is-selected' : ''}`} onClick={() => chooseTurn(null)}><span className="sm-turn__dot" /><span className="sm-turn__text"><b>현재</b><span>다음 변화를 준비 중</span></span></button></div>
            <div className="sm-turn-position">{turns.length ? `${index + 1} / ${turns.length + 1}` : '기록 시작'}</div>
          </div>
          {turns.length > 0 && <label className="sm-timeline-slider"><span className="sm-sr-only">보고 있는 개발 턴</span><input type="range" min="0" max={turns.length} value={index} onChange={(event) => chooseTurn(turns[Number(event.target.value)]?.id || null)} aria-valuetext={selectedTurn ? `턴 ${selectedTurn.number}: ${selectedTurn.title}` : '현재 형상'} /></label>}
        </footer>
      </section>
      {selected && <BlockInspector key={`${turnId || 'current'}:${selected.id}`} node={selected} graph={graph} baselineNode={previousTurn?.nodes.find((node) => node.id === selected.id)} state={states[selected.id]} turns={visibleTurns} mapPath={snapshot.mapPath} readOnly={Boolean(selectedTurn)} send={send} busy={busy} onClose={() => setSelectedId(null)} onOpen={openNode} onRepository={openRepository} />}
    </div>
    {toast && <div className={`sm-toast${toast.error ? ' is-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{!toast.error && <ShapeIcon name="check" size={15} />}<span>{toast.text}</span><button className="sm-icon-button" aria-label="알림 닫기" onClick={() => setToast(null)}><ShapeIcon name="close" size={14} /></button></div>}
    {dialog === 'reading' && <Dialog wide title={currentFocus.id === root.id ? '전체 시스템의 구성과 개선' : `${currentFocus.label} · 구성과 개선`} subtitle="큰 기능의 역할부터 세부 구성, 지난 변경, 다음 개선까지 읽습니다." onClose={() => setDialog(null)}>
      <ScopeReader graph={graph} focusId={currentFocus.id} turns={visibleTurns} onFocus={(id) => { focusNode(id); setDialog(null); }} onOpen={(id) => { openNode(id); setDialog(null); }} onRepository={() => openRepository(currentFocus.id)} />
    </Dialog>}
    {(dialog === 'block' || dialog === 'turn') && <Dialog title={dialog === 'turn' ? '현재 형상을 턴으로 기록' : '새 기능 블록'} subtitle={dialog === 'turn' ? '지금의 설명·변경안·의견을 함께 남깁니다.' : '제품에서 하는 일을 쉬운 말로 적어 주세요.'} onClose={() => setDialog(null)}>
      <form className="sm-form" onSubmit={create}><label>{dialog === 'turn' ? '이번 턴의 이름' : '기능 이름'}<input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder={dialog === 'turn' ? '예: 첫 형상 · 기능을 한눈에' : '예: 가입 없이 시작하기'} maxLength={180} required /></label>
        {dialog === 'block' && <label>어느 기능에 속하나요?<select value={newParent} onChange={(event) => setNewParent(event.target.value)}>{graph.nodes.filter((node) => node.section !== 'reference').map((node) => <option key={node.id} value={node.id}>{shapeAncestors(graph, node.id).map((item) => item.label).join(' / ')}</option>)}</select></label>}
        <label>{dialog === 'turn' ? '무엇을 어떻게 바꿨나요?' : '어떤 일을 하나요?'}<textarea value={newSummary} onChange={(event) => setNewSummary(event.target.value)} rows={4} maxLength={4000} placeholder={dialog === 'turn' ? '바뀐 이유와 결과를 적습니다. 기록이 실제 개발 완료를 대신하지는 않습니다.' : '사용자가 무엇을 할 수 있는지 설명합니다.'} /></label>
        <div className="sm-form-actions"><button className="sm-button" type="button" onClick={() => setDialog(null)}>돌아가기</button><button className="sm-button sm-button--dark" disabled={busy || !newTitle.trim()}><ShapeIcon name={dialog === 'turn' ? 'history' : 'plus'} size={15} />{dialog === 'turn' ? '이 형상 기록' : '기능 추가'}</button></div>
      </form>
    </Dialog>}
    {dialog === 'brief' && <Dialog wide title="이 지도로 AI와 논의하기" subtitle="기능별 의견과 변경안을 지금 사용하는 AI에게 건네세요." onClose={() => setDialog(null)}>
      <div className="sm-brief-summary"><ShapeIcon name="mail" size={20} /><p>AI가 읽을 글을 현재 지도에서 만들었습니다.<br /><span>AI가 원본 지도를 고치면 열린 화면에도 반영됩니다.</span></p></div>
      <label className="sm-sr-only" htmlFor="sm-ai-brief">AI에게 전달할 지도와 논의 내용</label><textarea id="sm-ai-brief" className="sm-brief-text" value={brief || '현재 지도의 논의를 모으고 있습니다…'} readOnly />
      <div className="sm-form-actions"><button className="sm-button" disabled={!brief} onClick={downloadBrief}><ShapeIcon name="download" size={15} />글로 저장</button><button className="sm-button sm-button--dark" disabled={!brief} onClick={copyBrief}><ShapeIcon name={copied ? 'check' : 'copy'} size={15} />{copied ? '복사했습니다' : '논의 내용 복사'}</button></div>
    </Dialog>}
    {dialog === 'help' && <Dialog title="지도를 함께 읽는 법" onClose={() => setDialog(null)}>
      <p className="sm-dialog-copy">기능을 누르면 역할과 의견을 볼 수 있습니다. 같은 기능을 세 가지 관점으로 살펴보세요.</p>
      <div className="sm-help-views">{SHAPE_VIEWS.map((view) => <div key={view.id}><strong>{view.label}</strong><p>{view.description}</p></div>)}</div>
      <div className="sm-help-colors">{Object.entries(SHAPE_STATES).filter(([status]) => status !== 'neutral').map(([status]) => <div key={status}><StateBadge status={status} /><p>{{ planned: '작성한 다음 변경안이 있습니다.', verified: '사람이 직접 확인했습니다. 내용이 바뀌면 해제됩니다.', changed: '직전에 기록한 턴에서 달라진 기능입니다.', concern: '아직 논의가 끝나지 않은 걱정이 있습니다.' }[status]}</p></div>)}</div>
      <p className="sm-help-tip">스크롤로 이동 · 두 손가락으로 확대 · ⌘/Ctrl + 0으로 화면 맞춤</p>
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
