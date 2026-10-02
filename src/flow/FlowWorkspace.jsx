import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './flow.css';
import { ARROW_STYLES, NEW_STEP_LABEL, SHARED_BAND_ID, flowVocabulary } from './flowConstants.js';
import {
  arrowKey, connectOperation, describeError, emphasisFor, insertOnArrowOperation, laneStepOperation, newIdAfter, nextStepOperation, pushHistory,
} from './flowEditing.js';
import { layoutFlow } from './flowLayout.js';
import FlowCanvas, { viewportKey } from './FlowCanvas.jsx';
import { ArrowPanel, LanePanel, MapPanel, StepPanel, TagsPanel } from './FlowPanels.jsx';
import FlowSourcePanel from './FlowSourcePanel.jsx';
import { TagChip } from './FlowElements.jsx';
import FlowIcon from './FlowIcon.jsx';

const EMPTY_GRAPH = { map: {}, lanes: [], steps: [], arrows: [], tags: [] };
const isTextTarget = (target) => Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));

function readPreference(key) {
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
}
function writePreference(key, value) {
  try { window.localStorage.setItem(key, value ? '1' : '0'); } catch { /* the toggle still works for this visit */ }
}

function SaveState({ pending, connection, invalid, editable }) {
  const text = invalid ? '원문 확인 필요' : !editable ? '읽기 전용' : pending ? '저장 중…' : connection === 'online' ? '저장됨' : connection === 'offline' ? '연결 확인 중' : '여는 중';
  const issue = invalid || connection === 'offline';
  return <span className={`fm-save${issue ? ' is-issue' : ''}${pending ? ' is-pending' : ''}`} role="status" data-testid="fm-save-state"><i aria-hidden="true" /><span>{text}</span></span>;
}

function ArrowLegend() {
  return <span className="fm-legend" aria-label="화살표 보는 법">
    {ARROW_STYLES.map((style) => <span key={style.id} className="fm-legend__item" title={style.hint}>
      <svg width="26" height="10" aria-hidden="true" className={`fm-arrow-sample fm-arrow-sample--${style.id}`}>
        {style.id === 'exchange' && <path d="M1 5 H19" className="casing" />}<path d="M1 5 H19" className="line" /><path d="M18 1.5 L25 5 L18 8.5 Z" className="head" />
      </svg>{style.label}</span>)}
  </span>;
}

function FlowStudio({ api, map }) {
  const [snapshot, setSnapshot] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [pending, setPending] = useState(0);
  const [toast, setToast] = useState(null);
  const [selection, setSelection] = useState(null);
  const [panel, setPanel] = useState(null);
  const [focusLabel, setFocusLabel] = useState(null);
  const [highlightTag, setHighlightTag] = useState(null);
  const [focusLane, setFocusLane] = useState(null);
  const notesKey = `shape-map:flow-notes:${map?.project ?? ''}/${map?.file ?? ''}`;
  const [notes, setNotes] = useState(() => readPreference(notesKey));
  const [history, setHistory] = useState({ undo: [], redo: [] });
  const [revealId, setRevealId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const snapshotRef = useRef(null);
  const historyRef = useRef(history); historyRef.current = history;
  const queue = useRef(Promise.resolve());
  const clientId = useRef(`flow-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`);
  const rootRef = useRef(null);

  const updateHistory = useCallback((next) => { historyRef.current = next; setHistory(next); }, []);
  const accept = useCallback((next) => {
    if (!next) return;
    const previous = snapshotRef.current;
    if (previous && next.updatedAt && previous.updatedAt && Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) return;
    if (previous && previous.revision === next.revision && previous.sourceStatus?.valid === next.sourceStatus?.valid
      && previous.editable === next.editable) return;
    if (previous && next.revision !== previous.revision && next.origin !== clientId.current) updateHistory({ undo: [], redo: [] });
    snapshotRef.current = next;
    setSnapshot(next);
  }, [updateHistory]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setLoadError(null);
    api.readMap(controller.signal).then((next) => { if (!disposed) { accept(next); setConnection('online'); } })
      .catch((error) => { if (!disposed && error?.name !== 'AbortError') { setLoadError(describeError(error)); setConnection('offline'); } });
    let events = null;
    if (api.eventsUrl && typeof EventSource !== 'undefined') {
      events = new EventSource(api.eventsUrl);
      events.addEventListener('snapshot', (event) => { if (!disposed) { try { accept(JSON.parse(event.data)); } catch { /* ignore a broken event */ } setConnection('online'); } });
      events.addEventListener('source-error', (event) => { if (!disposed) { try { const payload = JSON.parse(event.data); accept(payload.snapshot); } catch { /* ignore */ } } });
      events.onopen = () => { if (!disposed) setConnection('online'); };
      events.onerror = () => { if (!disposed) setConnection('offline'); };
    }
    return () => { disposed = true; controller.abort(); events?.close(); };
  }, [api, accept, reloadKey]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), toast.error ? 8000 : 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const kind = snapshot?.kind && snapshot.kind !== 'other' ? snapshot.kind : snapshot?.graph?.map?.kind || map?.kind;
  const words = flowVocabulary(kind);
  const graph = snapshot?.graph || null;
  const safeGraph = graph || EMPTY_GRAPH;
  const invalid = snapshot && snapshot.sourceStatus?.valid === false ? snapshot.sourceStatus : null;
  const editable = Boolean(snapshot && graph && map?.editable !== false && snapshot.editable !== false && !invalid);
  const editableRef = useRef(editable); editableRef.current = editable;

  const notify = useCallback((text, error = false) => setToast({ text, error }), []);

  const run = useCallback(async (operation, label, options = {}) => {
    const before = snapshotRef.current;
    if (!before || (!editableRef.current && !options.force)) return { ok: false, message: '지금은 고칠 수 없어요.' };
    setPending((count) => count + 1);
    try {
      const next = await api.mutateMap({ baseRevision: before.revision, clientId: clientId.current, operation });
      accept(next);
      if (options.record !== false && next.revision !== before.revision && before.source != null && next.source != null) {
        updateHistory({ undo: pushHistory(historyRef.current.undo, { before: before.source, after: next.source, label }), redo: [] });
      }
      if (options.select !== undefined) setSelection(options.select);
      return { ok: true, snapshot: next, before };
    } catch (error) {
      const info = describeError(error);
      if (error?.body?.snapshot) accept(error.body.snapshot);
      if (!options.quiet) notify(info.kind === 'validation' && info.detail ? `${info.text} ${info.detail}` : info.text, true);
      return { ok: false, ...info, message: info.text };
    } finally {
      setPending((count) => count - 1);
    }
  }, [api, accept, notify, updateHistory]);

  const send = useCallback((operation, label, options) => {
    if (!operation) return Promise.resolve({ ok: false });
    const task = queue.current.then(() => run(operation, label, options));
    queue.current = task.catch(() => {});
    return task;
  }, [run]);

  const travel = useCallback((direction) => {
    const task = queue.current.then(async () => {
      const stacks = historyRef.current;
      const entry = direction === 'undo' ? stacks.undo.at(-1) : stacks.redo.at(-1);
      if (!entry) return;
      const result = await run({ type: 'replaceSource', source: direction === 'undo' ? entry.before : entry.after }, entry.label, { record: false });
      if (!result.ok) return;
      const now = historyRef.current;
      updateHistory(direction === 'undo'
        ? { undo: now.undo.slice(0, -1), redo: [...now.redo, entry] }
        : { undo: [...now.undo, entry], redo: now.redo.slice(0, -1) });
      notify(direction === 'undo' ? `되돌렸어요: ${entry.label}` : `다시 했어요: ${entry.label}`);
    });
    queue.current = task.catch(() => {});
    return task;
  }, [run, updateHistory, notify]);

  // Keep the selection while the selected thing still exists.
  useEffect(() => {
    if (!graph || !selection) return;
    const exists = selection.kind === 'step' ? graph.steps.some((step) => step.id === selection.id)
      : selection.kind === 'lane' ? graph.lanes.some((lane) => lane.id === selection.id)
        : graph.arrows.some((arrow) => arrowKey(arrow) === selection.id);
    if (!exists) { setSelection(null); if (panel === 'inspect') setPanel(null); }
  }, [graph, selection, panel]);
  useEffect(() => {
    if (!graph) return;
    if (highlightTag && !graph.tags.some((tag) => tag.id === highlightTag)) setHighlightTag(null);
    if (focusLane && focusLane !== SHARED_BAND_ID && !graph.lanes.some((lane) => lane.id === focusLane)) setFocusLane(null);
  }, [graph, highlightTag, focusLane]);
  useEffect(() => { if (snapshot && !graph) setPanel('source'); }, [snapshot, graph]);

  const select = useCallback((next) => {
    setSelection(next);
    setFocusLabel(null);
    setPanel(next ? 'inspect' : (current) => (current === 'inspect' ? null : current));
    if (next?.kind === 'step') setRevealId({ id: next.id, at: Date.now() });
  }, []);
  const openCreated = useCallback((result, collection, kindName) => {
    if (!result.ok) return;
    const id = newIdAfter(result.before.graph, result.snapshot.graph, collection);
    if (!id) return;
    setSelection({ kind: kindName, id }); setPanel('inspect'); setFocusLabel(id);
    if (kindName === 'step') setRevealId({ id, at: Date.now() });
  }, []);

  const act = useMemo(() => ({
    send: (operation, label, options) => send(operation, label, options),
    select,
    close: () => { setPanel(null); setSelection(null); },
    notify,
    copy: async (text, message = '복사했어요.') => {
      try { await navigator.clipboard.writeText(text); notify(message); } catch { notify('복사하지 못했어요. 직접 골라서 복사해 주세요.', true); }
    },
    openTags: () => setPanel('tags'),
    focusLane: (laneId) => setFocusLane(laneId),
    addNext: async (stepId) => openCreated(await send(nextStepOperation(snapshotRef.current.graph, stepId, NEW_STEP_LABEL), '다음 단계 추가'), 'steps', 'step'),
    addInLane: async (laneId) => openCreated(await send(laneStepOperation(snapshotRef.current.graph, laneId, NEW_STEP_LABEL), '단계 추가'), 'steps', 'step'),
    insertOnArrow: async (key) => {
      const arrow = snapshotRef.current.graph.arrows.find((item) => arrowKey(item) === key);
      if (arrow) openCreated(await send(insertOnArrowOperation(snapshotRef.current.graph, arrow, NEW_STEP_LABEL), '사이에 단계 넣기'), 'steps', 'step');
    },
    addLane: async () => openCreated(await send({ type: 'addLane', title: words.laneNew }, words.laneAdd), 'lanes', 'lane'),
    connect: async (source, target, style = 'next') => {
      const plan = connectOperation(snapshotRef.current.graph, source, target, style);
      if (plan.error) { notify(plan.error, true); return { ok: false }; }
      const result = await send(plan.operation, '화살표 잇기', { select: { kind: 'arrow', id: `${source}->${target}` } });
      if (result.ok) { setPanel('inspect'); notify('화살표를 이었어요. 종류와 글자를 고를 수 있어요.'); }
      return result;
    },
    deleteSteps: async (ids) => {
      const result = await send({ type: 'deleteSteps', ids }, '단계 지우기', { select: null });
      if (result.ok) { setPanel(null); notify('단계를 지웠어요. ⌘Z로 되돌릴 수 있어요.'); }
    },
    removeArrow: async (arrow) => {
      const result = await send({ type: 'removeArrow', source: arrow.source, target: arrow.target }, '화살표 지우기', { select: null });
      if (result.ok) { setPanel(null); notify('화살표를 지웠어요.'); }
    },
  }), [send, select, notify, openCreated, words]);

  useEffect(() => {
    const onKey = (event) => {
      const root = rootRef.current;
      if (!root || !(root.contains(event.target) || event.target === document.body)) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && (key === 'z' || key === 'y')) {
        if (isTextTarget(event.target)) return;
        event.preventDefault();
        if (key === 'y' || event.shiftKey) travel('redo'); else travel('undo');
        return;
      }
      if (event.key === 'Escape') {
        if (panel) { event.preventDefault(); setPanel(null); if (panel === 'inspect') setSelection(null); return; }
        if (selection) { setSelection(null); return; }
        if (highlightTag || focusLane) { setHighlightTag(null); setFocusLane(null); }
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !isTextTarget(event.target) && editableRef.current && selection) {
        event.preventDefault();
        if (selection.kind === 'step') act.deleteSteps([selection.id]);
        else if (selection.kind === 'arrow') {
          const arrow = snapshotRef.current.graph.arrows.find((item) => arrowKey(item) === selection.id);
          if (arrow) act.removeArrow(arrow);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [travel, panel, selection, highlightTag, focusLane, act]);

  const layout = useMemo(() => (graph ? layoutFlow(graph, { notes }) : null), [graph, notes]);
  const emphasis = useMemo(() => emphasisFor(graph, { tagId: highlightTag, laneId: focusLane }), [graph, highlightTag, focusLane]);
  const canvasSelect = useCallback((next) => select(next), [select]);
  const onConnect = useCallback((source, target) => { act.connect(source, target); }, [act]);
  const onAddNext = useCallback((id) => act.addNext(id), [act]);
  const onInsert = useCallback((key) => act.insertOnArrow(key), [act]);
  const onAddInLane = useCallback((laneId) => act.addInLane(laneId), [act]);
  const onSelectLane = useCallback((id) => select({ kind: 'lane', id }), [select]);

  if (!snapshot) {
    return <div className="fm-workspace fm-workspace--empty" ref={rootRef}>
      {loadError ? <div className="fm-empty"><FlowIcon name="alert" size={18} /><p>{loadError.text}</p>
        <button type="button" className="fm-button" onClick={() => setReloadKey((value) => value + 1)}>다시 시도</button></div>
        : <div className="fm-empty" role="status"><span className="fm-spinner" aria-hidden="true" /><p>지도를 펼치고 있어요.</p></div>}
    </div>;
  }

  const fallbackTitle = map?.title || map?.file?.replace(/\.mmd$/, '') || words.kindLabel;
  const title = safeGraph.map?.title || fallbackTitle;
  const description = safeGraph.map?.description || map?.description;
  const selectedStep = selection?.kind === 'step' ? safeGraph.steps.find((step) => step.id === selection.id) : null;
  const selectedArrow = selection?.kind === 'arrow' ? safeGraph.arrows.find((arrow) => arrowKey(arrow) === selection.id) : null;
  const selectedLane = selection?.kind === 'lane' ? safeGraph.lanes.find((lane) => lane.id === selection.id) : null;
  const toggleNotes = () => { setNotes((value) => { writePreference(notesKey, !value); return !value; }); };
  const hasNotes = safeGraph.steps.some((step) => step.summary);

  return <div className={`fm-workspace${panel ? ' has-panel' : ''}`} ref={rootRef} data-testid="fm-workspace" data-kind={kind}>
    <header className="fm-header">
      <div className="fm-header__title">
        <span className="fm-kind">{words.kindLabel}</span>
        <div className="fm-header__text"><h1 title={title}>{title}</h1>{description && <p title={description}>{description}</p>}</div>
        {graph && <button type="button" className="fm-icon-button" aria-label="지도 이름과 설명 보기" title="지도 정보" onClick={() => { setSelection(null); setPanel('map'); }}><FlowIcon name={editable ? 'pencil' : 'info'} size={14} /></button>}
      </div>
      <div className="fm-header__actions">
        <SaveState pending={pending} connection={connection} invalid={Boolean(invalid)} editable={editable} />
        {editable && <>
          <button type="button" className="fm-icon-button" aria-label="되돌리기" title="되돌리기 (⌘Z)" disabled={!history.undo.length} onClick={() => travel('undo')} data-testid="fm-undo"><FlowIcon name="undo" size={15} /></button>
          <button type="button" className="fm-icon-button" aria-label="다시 하기" title="다시 하기 (⇧⌘Z)" disabled={!history.redo.length} onClick={() => travel('redo')} data-testid="fm-redo"><FlowIcon name="redo" size={15} /></button>
        </>}
        <button type="button" className={`fm-button fm-button--small${notes ? ' is-on' : ''}`} aria-pressed={notes} disabled={!hasNotes} title={hasNotes ? '카드에 설명 첫 줄 보이기' : '설명이 있는 단계가 없어요'} onClick={toggleNotes}><FlowIcon name="comment" size={13} /><span>설명 보기</span></button>
        <button type="button" className={`fm-button fm-button--small${panel === 'source' ? ' is-on' : ''}`} aria-pressed={panel === 'source'} onClick={() => setPanel(panel === 'source' ? null : 'source')} data-testid="fm-open-source"><FlowIcon name="code" size={13} /><span>원문</span></button>
      </div>
    </header>
    {graph && <div className="fm-toolbar" role="toolbar" aria-label="보기">
      <div className="fm-toolbar__tags">
        <span className="fm-toolbar__label">표시</span>
        {safeGraph.tags.map((tag) => <button key={tag.id} type="button" className="fm-toolbar__tag" aria-pressed={highlightTag === tag.id} title={`${tag.description || tag.label} · 이것만 밝게 보기`}
          onClick={() => setHighlightTag(highlightTag === tag.id ? null : tag.id)} data-testid={`fm-highlight-${tag.id}`}><TagChip tag={tag} small /></button>)}
        <button type="button" className="fm-text-button" onClick={() => { setSelection(null); setPanel('tags'); }}>{safeGraph.tags.length ? '관리' : '표시 만들기'}</button>
      </div>
      <div className="fm-toolbar__side">
        <ArrowLegend />
        {safeGraph.lanes.length > 0 && <label className="fm-select fm-select--small"><span className="fm-sr-only">{words.laneFocus}</span>
          <select value={focusLane ?? ''} onChange={(event) => setFocusLane(event.target.value || null)} data-testid="fm-focus-lane">
            <option value="">{words.allLanes}</option>
            {safeGraph.lanes.map((lane) => <option key={lane.id} value={lane.id}>{words.laneOnly(lane.title)}</option>)}
          </select></label>}
        {editable && safeGraph.lanes.length === 0 && <button type="button" className="fm-text-button" onClick={act.addLane}>{words.laneAdd}</button>}
      </div>
    </div>}
    {invalid && <div className="fm-banner" role="alert" data-testid="fm-invalid-banner"><FlowIcon name="alert" size={15} />
      <div><strong>원문에 고칠 곳이 있어요{invalid.line ? ` (${invalid.line}번째 줄)` : ''}.</strong> 파일을 고칠 때까지 편집을 잠시 멈췄어요. 그림은 마지막으로 읽은 내용이에요.</div>
      <button type="button" className="fm-button fm-button--small" onClick={() => setPanel('source')}>원문 보기</button></div>}
    {!invalid && snapshot.editable === false && <div className="fm-banner is-quiet" role="status"><FlowIcon name="info" size={15} /><div>이 지도는 읽기만 할 수 있어요.</div></div>}
    {(highlightTag || focusLane) && <div className="fm-filter-note" role="status">
      {highlightTag && <span>{safeGraph.tags.find((tag) => tag.id === highlightTag)?.label} 표시만 밝게 보는 중</span>}
      {focusLane && <span>{words.laneOnly(focusLane === SHARED_BAND_ID ? words.shared : safeGraph.lanes.find((lane) => lane.id === focusLane)?.title ?? '')} 중</span>}
      <button type="button" className="fm-text-button" onClick={() => { setHighlightTag(null); setFocusLane(null); }}>모두 보기</button>
    </div>}
    <div className="fm-body">
      {layout ? <FlowCanvas graph={safeGraph} layout={layout} words={words} storageKey={viewportKey(map)} emphasis={emphasis} selection={selection} focusLane={focusLane} editable={editable} revealId={revealId}
        onSelect={canvasSelect} onConnect={onConnect} onAddNext={onAddNext} onInsert={onInsert} onAddInLane={onAddInLane} onSelectLane={onSelectLane}
        onFocusLane={setFocusLane} onAddLane={act.addLane} /> : <div className="fm-empty"><p>그림을 그릴 수 없어요. 원문을 확인해 주세요.</p></div>}
      {graph && !safeGraph.steps.length && !safeGraph.lanes.length && <div className="fm-start">
        <strong>아직 단계가 없어요</strong><p>첫 단계를 놓고, 다음 단계를 이어 가세요.</p>
        {editable && <div className="fm-row"><button type="button" className="fm-button fm-button--dark" onClick={() => act.addInLane(null)}><FlowIcon name="plus" size={14} />첫 단계 추가</button>
          <button type="button" className="fm-button" onClick={act.addLane}>{words.laneAdd}</button></div>}
      </div>}
      {panel && <aside className={`fm-panel${panel === 'source' ? ' fm-panel--wide' : ''}`} aria-label="자세히 보기" data-testid="fm-panel">
        {panel === 'inspect' && selectedStep && <StepPanel step={selectedStep} graph={safeGraph} words={words} editable={editable} act={act} focusLabel={focusLabel === selectedStep.id} />}
        {panel === 'inspect' && selectedArrow && <ArrowPanel arrow={selectedArrow} graph={safeGraph} editable={editable} act={act} />}
        {panel === 'inspect' && selectedLane && <LanePanel lane={selectedLane} graph={safeGraph} words={words} editable={editable} act={act} focusLane={focusLane} focusLabel={focusLabel === selectedLane.id} />}
        {panel === 'map' && <MapPanel graph={safeGraph} fallbackTitle={fallbackTitle} words={words} editable={editable} act={act} />}
        {panel === 'tags' && <TagsPanel graph={safeGraph} editable={editable} act={act} highlight={highlightTag} onHighlight={setHighlightTag} />}
        {panel === 'source' && <FlowSourcePanel source={snapshot.source} editable={editable} invalid={invalid}
          onClose={() => setPanel(null)} onCopy={(text) => act.copy(text, '원문을 복사했어요.')}
          onApply={(text) => send({ type: 'replaceSource', source: text }, '원문 고치기', { quiet: true })} />}
      </aside>}
    </div>
    {toast && <div className={`fm-toast${toast.error ? ' is-error' : ''}`} role={toast.error ? 'alert' : 'status'} data-testid="fm-toast">
      <span>{toast.text}</span><button type="button" className="fm-icon-button" aria-label="알림 닫기" onClick={() => setToast(null)}><FlowIcon name="close" size={13} /></button>
    </div>}
  </div>;
}

/** Flow map canvas for `user-flow` and `system-flow` maps. Fills its parent box. */
export default function FlowWorkspace({ api, map }) {
  return <ReactFlowProvider>
    <FlowStudio key={`${map?.project ?? ''}/${map?.file ?? ''}`} api={api} map={map} />
  </ReactFlowProvider>;
}
