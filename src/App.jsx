import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  PanOnScrollMode,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react';
import { legacyMapApi } from './api.js';
import GraphNode from './GraphNode.jsx';
import WorkflowNode from './WorkflowNode.jsx';
import TaskFields from './TaskFields.jsx';
import WorkflowSettings from './WorkflowSettings.jsx';
import { InlineEditor } from './inlineEditor.js';
import InlineSaveStatus from './InlineSaveStatus.jsx';
import { MapFieldPicker, MapReferences } from './MapScopePanels.jsx';
import { mapOptionalFields, splitMapSections } from './mapScope.js';
import CanvasOverview, { CanvasZoomControls } from './CanvasNavigation.jsx';
import { OVERVIEW_ZOOM } from './overviewLabels.js';
import { useCenteredZoom } from './useCenteredZoom.js';
import { readableNodeViewport } from './viewport.js';
import { compactWorkflowViewport, nestedWorkflowLayout, workflowAncestors, workflowCollapsedIds } from './workflowLayout.js';
import './workflow.css';
import './workflowWorkspace.css';
import { SelectionCountContext } from './SelectionContext.js';
import {
  allBranchVisibilityPositions,
  branchVisibilityPositions,
  centeredRankRepairPositions,
  descendantsOf,
  hiddenNodeIds,
  mergeSnapshotPositions,
  overlappingNodePairs,
  reflowSiblingBranches,
  reparentBranchPositions,
  reparentBranchesPositions,
  resizeReflowPositions,
  resolveNodeLayout,
  visibleLayoutPositions,
} from './layout.js';
import { deletionHistoryEntry, historyEntryForOperation, viewHistoryEntry } from './history.js';

const nodeTypes = { mapNode: GraphNode, workflowNode: WorkflowNode };

function layoutValue(mode, width = 208, height = 88) {
  const normalizedWidth = Math.min(720, Math.max(168, Math.round(Number(width) || 208)));
  const normalizedHeight = Math.min(480, Math.max(72, Math.round(Number(height) || 88)));
  if (mode === 'fit') return { mode: 'fit' };
  if (mode === 'wrap') return { mode: 'wrap', width: normalizedWidth };
  return { mode: 'fixed', width: normalizedWidth, height: normalizedHeight };
}

function positionsFor(ids, positions) {
  return Object.fromEntries(ids
    .filter((id) => positions[id])
    .map((id) => [id, { ...positions[id] }]));
}

function sameSelection(left, right) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function topLevelSelectedNodeIds(nodes, selectedIds) {
  const selected = new Set(selectedIds);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => {
    if (!selected.has(node.id)) return false;
    let parent = nodesById.get(node.parentId);
    while (parent) {
      if (selected.has(parent.id)) return false;
      parent = nodesById.get(parent.parentId);
    }
    return true;
  }).map((node) => node.id);
}

function clientPoint(event) {
  const pointer = event?.touches?.[0] || event?.changedTouches?.[0] || event;
  return Number.isFinite(pointer?.clientX) && Number.isFinite(pointer?.clientY)
    ? { x: pointer.clientX, y: pointer.clientY }
    : null;
}

function dropCandidateAt(event, excludedIds) {
  const point = clientPoint(event);
  if (!point || typeof document === 'undefined') return null;
  for (const element of document.elementsFromPoint(point.x, point.y)) {
    const wrapper = element.closest?.('.react-flow__node[data-id]');
    const id = wrapper?.dataset?.id;
    if (id && !excludedIds.has(id)) return id;
  }
  return null;
}

function validReparentDropTarget(event, drag, nodes) {
  if (!drag?.semanticRootIds?.length) return null;
  const candidateId = dropCandidateAt(event, drag.movingIds);
  if (!candidateId) return null;
  const candidate = nodes.find((node) => node.id === candidateId);
  if (!candidate) return null;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return drag.semanticRootIds.some((id) => nodesById.get(id)?.parentId !== candidateId)
    ? candidateId
    : null;
}

function arrangementIfOverlapping(snapshot, positions, nodeLayouts = {}) {
  if (!overlappingNodePairs(
    snapshot.graph.nodes,
    positions,
    snapshot.view?.collapsedIds || [],
    nodeLayouts,
  ).length) return null;
  return visibleLayoutPositions(
    snapshot.graph.nodes,
    snapshot.view?.collapsedIds || [],
    snapshot.graph.direction,
    nodeLayouts,
  );
}

function resizePreview(snapshot, basePositions, id, nextLayout, anchor) {
  return resizeReflowPositions(snapshot, basePositions, id, nextLayout, anchor);
}

function makeClientId() {
  const storageKey = 'final-shape-map-client-id';
  const existing = sessionStorage.getItem(storageKey) || sessionStorage.getItem('mlc-client-id');
  if (existing) {
    sessionStorage.setItem(storageKey, existing);
    return existing;
  }
  const id = `canvas-${crypto.randomUUID()}`;
  sessionStorage.setItem(storageKey, id);
  return id;
}

function makeNodeId() {
  return `node_${crypto.randomUUID().replaceAll('-', '')}`;
}

function messageOf(error) {
  return error?.body?.message || error?.message || '변경을 저장하지 못했습니다.';
}

function storedBoolean(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved === null ? fallback : saved === 'true';
  } catch {
    return fallback;
  }
}

async function writeClipboardText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the local document copy path.
    }
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('클립보드에 복사하지 못했습니다.');
}

function Icon({ name }) {
  const paths = {
    undo: 'M9 7H4v-5M4 7l5-5M5 7h8a6 6 0 0 1 0 12h-2',
    redo: 'M15 7h5v-5M20 7l-5-5M19 7h-8a6 6 0 0 0 0 12h2',
    plus: 'M12 5v14M5 12h14',
    close: 'M6 6l12 12M18 6L6 18',
    layers: 'm12 3-9 5 9 5 9-5-9-5Zm-9 10 9 5 9-5M3 18l9 5 9-5',
    arrange: 'M4 6h4M4 12h4M4 18h4M11 6h9M11 12h9M11 18h9',
    expand: 'M9 4H4v5M4 4l6 6M15 20h5v-5M20 20l-6-6',
    collapse: 'M4 9h5V4M9 9 4 4M20 15h-5v5M15 15l5 5',
    copy: 'M9 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Zm6 0V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2',
    map: 'm4 6 5-2 6 2 5-2v14l-5 2-6-2-5 2V6Zm5-2v14M15 6v14',
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

export default function App({ api = legacyMapApi }) {
  const { readMap, mutateMap, saveView } = api;
  const clientId = useRef(makeClientId()).current;
  const { setViewport, getViewport, fitView } = useReactFlow();
  const canvasRef = useRef(null);
  const initializedViewport = useRef(false);
  const pendingInitialViewportRef = useRef(null);
  const snapshotRef = useRef(null);
  const positionsRef = useRef({});
  const flowNodesRef = useRef([]);
  const draggedBranchRef = useRef(null);
  const dropTargetIdRef = useRef(null);
  const resizedNodeRef = useRef(null);
  const autoArrangeRef = useRef(null);
  const shortcutContextRef = useRef({});
  const busyRef = useRef(false);
  const historyInProgressRef = useRef(false);
  const idleWaitersRef = useRef([]);
  const positionSyncRef = useRef(null);
  const pendingCreateIdRef = useRef(null);
  const revealCreatedIdRef = useRef(null);
  const selectedIdsRef = useRef([]);
  const selectionRequestRef = useRef(null);
  const editorBridgeRef = useRef(null);
  const createNodeBridgeRef = useRef(null);
  const workflowAnchorRef = useRef(null);
  const viewportTimerRef = useRef(null);
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const inlineEditor = useMemo(() => {
    let storage;
    try { storage = window.localStorage; } catch { /* Visible recovery warning when editing. */ }
    return new InlineEditor({ storage, scope: api.storagePrefix, send: (operation) => editorBridgeRef.current(operation) });
  }, []);
  const [snapshot, setSnapshot] = useState(null);
  const sections = useMemo(() => splitMapSections(snapshot?.graph), [snapshot?.graph]);
  const optionalFields = useMemo(() => mapOptionalFields(snapshot?.graph), [snapshot?.graph]);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referenceEditingId, setReferenceEditingId] = useState(null);
  const [positions, setPositions] = useState({});
  const [flowNodes, setFlowNodes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [editingNodeId, setEditingNodeId] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [undoStack, renderUndoStack] = useState([]);
  const [redoStack, renderRedoStack] = useState([]);
  const setUndoStack = useCallback((update) => {
    undoStackRef.current = typeof update === 'function' ? update(undoStackRef.current) : update;
    renderUndoStack(undoStackRef.current);
  }, []);
  const setRedoStack = useCallback((update) => {
    redoStackRef.current = typeof update === 'function' ? update(redoStackRef.current) : update;
    renderRedoStack(redoStackRef.current);
  }, []);
  const [conflict, setConflict] = useState(null);
  const [sourceError, setSourceError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [busy, setBusy] = useState(false);
  const [clipboard, setClipboard] = useState(null);
  const [workflowMode, setWorkflowMode] = useState(() => storedBoolean('final-shape-map-workflow-mode', true));
  const workflowModeRef = useRef(workflowMode);
  const { zoomIn, zoomOut, zoomTo } = useCenteredZoom({
    canvasRef, minZoom: workflowMode ? 0.08 : 0.2, maxZoom: 2,
    enabled: Boolean(snapshot) && !referenceOpen,
  });
  workflowModeRef.current = workflowMode;
  const [workflowFocusId, setWorkflowFocusId] = useState(null);
  const [workflowLegendOpen, setWorkflowLegendOpen] = useState(false);
  const [workflowMeasurements, setWorkflowMeasurements] = useState({});
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const [legendOpen, setLegendOpen] = useState(() => (
    storedBoolean('final-shape-map-legend-open', true)
  ));
  const [desktopMinimapOpen, setDesktopMinimapOpen] = useState(() => (
    storedBoolean(
      'final-shape-map-minimap-open',
      typeof window === 'undefined' || !window.matchMedia('(max-width: 480px)').matches,
    )
  ));
  const [compactCanvas, setCompactCanvas] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 480px)').matches
  ));
  const [mobileMinimapOpen, setMobileMinimapOpen] = useState(false);
  const minimapOpen = compactCanvas ? mobileMinimapOpen : desktopMinimapOpen;
  const setMinimapOpen = compactCanvas ? setMobileMinimapOpen : setDesktopMinimapOpen;

  const selectOnly = useCallback((id) => {
    const next = id ? [id] : [];
    if (!sameSelection(selectedIdsRef.current, next)) {
      selectionRequestRef.current = { ids: next, expiresAt: Date.now() + 1000 };
    }
    selectedIdsRef.current = next;
    setSelectedId(id || null);
    setSelectedIds(next);
    setFlowNodes((items) => items.map((node) => ({ ...node, selected: Boolean(id) && node.id === id })));
  }, []);

  const showDropTarget = useCallback((id, branchCount = 0) => {
    if (dropTargetIdRef.current === id) return;
    dropTargetIdRef.current = id;
    setFlowNodes((items) => items.map((item) => {
      const active = item.id === id;
      if (Boolean(item.data.dropTarget) === active
        && (!active || item.data.dropTargetCount === branchCount)) return item;
      return {
        ...item,
        data: {
          ...item.data,
          dropTarget: active,
          dropTargetCount: active ? branchCount : 0,
        },
      };
    }));
  }, []);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    flowNodesRef.current = flowNodes;
  }, [flowNodes]);

  useEffect(() => {
    try {
      localStorage.setItem('final-shape-map-legend-open', String(legendOpen));
    } catch {
      // UI preferences may remain session-only when storage is unavailable.
    }
  }, [legendOpen]);

  useEffect(() => {
    try {
      localStorage.setItem('final-shape-map-minimap-open', String(desktopMinimapOpen));
    } catch {
      // UI preferences may remain session-only when storage is unavailable.
    }
  }, [desktopMinimapOpen]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 480px)');
    const update = () => {
      if (window.innerWidth >= 240) setCompactCanvas(media.matches);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!compactCanvas || window.innerWidth < 240 || !workflowModeRef.current || !flowNodesRef.current.length) return;
    const node = flowNodesRef.current.find((item) => item.id === selectedIdsRef.current[0]) || flowNodesRef.current[0];
    setViewport(compactWorkflowViewport(window.innerWidth, node.position), { duration: 0 });
  }, [compactCanvas, setViewport]);

  useEffect(() => {
    if (!editingNodeId || !snapshot) return;
    const exists = snapshot.graph.nodes.some((node) => node.id === editingNodeId);
    if (pendingCreateIdRef.current === editingNodeId) {
      if (exists) pendingCreateIdRef.current = null;
      return;
    }
    if (!exists) setEditingNodeId(null);
  }, [editingNodeId, snapshot]);

  useEffect(() => {
    if (!editingNodeId) return undefined;
    let secondFrame;
    const focusEditor = () => {
      const input = document.querySelector(
        `[data-testid="node-${editingNodeId}"] [data-testid="inline-rename-input"], [data-testid="node-label-input-${editingNodeId}"]`,
      );
      input?.focus({ preventScroll: true });
      if (input && workflowModeRef.current && revealCreatedIdRef.current === editingNodeId) {
        const card = input.closest('.react-flow__node')?.getBoundingClientRect();
        const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
        if (card && canvas) {
          const viewport = getViewport();
          const dx = card.left < canvas.left + 24 ? canvas.left + 24 - card.left
            : card.right > canvas.right - 40 ? canvas.right - 40 - card.right : 0;
          const dy = card.top < canvas.top + 32 || card.bottom > canvas.bottom - 80
            ? canvas.top + 40 - card.top : 0;
          if (dx || dy) setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy }, { duration: 0 });
          inlineEditor.lastEditedId = editingNodeId;
          revealCreatedIdRef.current = null;
        }
      }
    };
    const firstFrame = requestAnimationFrame(() => {
      focusEditor();
      secondFrame = requestAnimationFrame(focusEditor);
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [editingNodeId, flowNodes, getViewport, inlineEditor, setViewport]);

  const installSnapshot = useCallback(
    (incoming, channel = 'read') => {
      if (!incoming?.graph?.nodes) return;
      if (channel === 'event' && historyInProgressRef.current && incoming.origin === clientId) return;
      const previous = snapshotRef.current;
      const incomingTime = Date.parse(incoming.updatedAt);
      const previousTime = Date.parse(previous?.updatedAt);
      if (previous && Number.isFinite(incomingTime) && Number.isFinite(previousTime)
        && incomingTime < previousTime) return;
      if (channel === 'event' && incoming.origin === clientId
        && Number.isFinite(incomingTime) && Number.isFinite(previousTime)
        && incomingTime <= previousTime) return;
      if (
        previous?.revision === incoming.revision
        && previous?.updatedAt === incoming.updatedAt
        && channel === 'event'
      ) return;
      const external = previous
        && incoming.updatedAt !== previous.updatedAt
        && incoming.origin !== clientId
        && incoming.origin !== 'startup';
      if (external && (undoStackRef.current.length || redoStackRef.current.length)) {
        setUndoStack([]);
        setRedoStack([]);
        setNotice({ kind: 'info', text: '다른 곳의 변경을 반영해 실행 취소 기록을 정리했습니다.' });
      }
      setPositions((current) => {
        return mergeSnapshotPositions(incoming, current, Boolean(previous));
      });
      setSnapshot(incoming);
      snapshotRef.current = incoming;
      inlineEditor.refresh(incoming);
      setSourceError(incoming.sourceStatus?.valid === false ? incoming.sourceStatus.error : null);
      setSelectedId((id) => (incoming.graph.nodes.some((node) => node.id === id) ? id : null));
      const retainedSelection = selectedIdsRef.current
        .filter((id) => incoming.graph.nodes.some((node) => node.id === id));
      selectedIdsRef.current = retainedSelection;
      setSelectedIds(retainedSelection);

      if (!initializedViewport.current) pendingInitialViewportRef.current = workflowModeRef.current
        ? incoming.view?.workflow?.viewport || null
        : incoming.view?.viewport || null;
    },
    [clientId, inlineEditor, setRedoStack, setUndoStack],
  );

  useEffect(() => {
    inlineEditor.disposed = false;
    const onLeaving = (event) => {
      inlineEditor.persist();
      if (inlineEditor.hasDrafts()) { event.preventDefault(); event.returnValue = ''; }
    };
    const onHidden = () => { if (document.visibilityState === 'hidden') { inlineEditor.persist(); inlineEditor.flush(); } };
    const onOnline = () => inlineEditor.retry(undefined, true);
    window.addEventListener('beforeunload', onLeaving);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('beforeunload', onLeaving);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('online', onOnline);
      inlineEditor.dispose();
      clearTimeout(viewportTimerRef.current);
    };
  }, [inlineEditor]);

  const onFlowInit = useCallback((instance) => {
    if (initializedViewport.current) return;
    initializedViewport.current = true;
    let savedViewport = pendingInitialViewportRef.current || (workflowModeRef.current
      ? snapshotRef.current?.view?.workflow?.viewport
      : snapshotRef.current?.view?.viewport);
    if (workflowModeRef.current) {
      // Old nested-container coordinates do not describe the fixed-card map.
      try {
        const key = `final-shape-map:branch-layout:v1:${api.storagePrefix}${snapshotRef.current?.mapPath}`;
        if (!localStorage.getItem(key)) { savedViewport = null; localStorage.setItem(key, 'true'); }
      } catch { savedViewport = null; }
    }
    if (workflowModeRef.current && window.innerWidth <= 480) instance.setViewport(compactWorkflowViewport(window.innerWidth), { duration: 0 });
    else if (savedViewport) instance.setViewport(savedViewport, { duration: 0 });
    else if (workflowModeRef.current) instance.setViewport({ x: 40, y: 180, zoom: 0.9 }, { duration: 0 });
    else instance.fitView({ padding: 0.25, duration: 0 });
  }, []);

  useEffect(() => {
    try { localStorage.setItem('final-shape-map-workflow-mode', String(workflowMode)); } catch { /* Optional preference. */ }
    const view = snapshotRef.current?.view;
    if (!view) return;
    const viewport = workflowMode ? view.workflow?.viewport : view.viewport;
    requestAnimationFrame(() => {
      if (workflowMode && window.innerWidth <= 480) setViewport(compactWorkflowViewport(window.innerWidth), { duration: 0 });
      else if (viewport) setViewport(viewport, { duration: 0 });
      else if (workflowMode) setViewport({ x: 24, y: 24, zoom: 0.85 }, { duration: 0 });
      else fitView({ padding: 0.2, duration: 0 });
    });
  }, [workflowMode, setViewport, fitView]);

  useEffect(() => {
    if (workflowMode || !snapshot || editingNodeId || historyInProgressRef.current) return;
    const missingPositions = Object.fromEntries(snapshot.graph.nodes
      .filter((node) => !snapshot.view?.positions?.[node.id] && positions[node.id])
      .map((node) => [node.id, positions[node.id]]));
    const ids = Object.keys(missingPositions);
    if (!ids.length) return;
    const key = `${snapshot.revision}:${ids.sort().join(',')}`;
    if (positionSyncRef.current === key) return;
    positionSyncRef.current = key;
    saveView({
      clientId,
      baseRevision: snapshot.revision,
      patch: { positions: missingPositions },
    }).catch((error) => {
      if (error.status === 409 && error.body?.snapshot) installSnapshot(error.body.snapshot, 'conflict');
      else setNotice({ kind: 'error', text: `새 항목 위치를 저장하지 못했습니다. ${messageOf(error)}` });
    }).finally(() => {
      if (positionSyncRef.current === key) positionSyncRef.current = null;
    });
  }, [clientId, editingNodeId, installSnapshot, positions, snapshot, workflowMode]);

  useEffect(() => {
    const controller = new AbortController();
    readMap(controller.signal)
      .then((data) => installSnapshot(data, 'read'))
      .catch((error) => {
        if (error.name !== 'AbortError') setNotice({ kind: 'error', text: messageOf(error) });
      });

    const events = new EventSource(api.eventsUrl);
    const onSnapshot = (event) => {
      try {
        installSnapshot(JSON.parse(event.data), 'event');
        setConnection('online');
      } catch {
        setConnection('offline');
      }
    };
    const onSourceError = (event) => {
      try {
        const payload = JSON.parse(event.data);
        setSourceError(payload.error || payload.message || '원본 파일을 읽을 수 없습니다.');
      } catch {
        setSourceError('원본 파일을 읽을 수 없습니다.');
      }
    };
    events.addEventListener('snapshot', onSnapshot);
    events.addEventListener('source-error', onSourceError);
    events.onopen = () => { setConnection('online'); inlineEditor.retry(undefined, true); };
    events.onerror = () => setConnection('offline');
    return () => {
      controller.abort();
      events.close();
    };
  }, [installSnapshot]);

  const waitForIdle = useCallback(() => {
    if (!busyRef.current) return Promise.resolve();
    return new Promise((resolve) => idleWaitersRef.current.push(resolve));
  }, []);

  const releaseBusy = useCallback(() => {
    busyRef.current = false;
    setBusy(false);
    const waiters = idleWaitersRef.current.splice(0);
    waiters.forEach((resolve) => resolve());
  }, []);

  useEffect(() => {
    if (workflowMode || !snapshot || editingNodeId || busyRef.current) return;
    if (!['startup', 'external'].includes(snapshot.origin)) return;
    if (snapshot.graph.nodes.some((node) => !positions[node.id])) return;
    const alignmentPatch = centeredRankRepairPositions(
      snapshot.graph.nodes,
      positions,
      snapshot.view?.collapsedIds || [],
      snapshot.graph.direction,
    );
    const projectedPositions = alignmentPatch
      ? { ...positions, ...alignmentPatch }
      : positions;
    const pairs = overlappingNodePairs(
      snapshot.graph.nodes,
      projectedPositions,
      snapshot.view?.collapsedIds || [],
    );
    if (!pairs.length && !alignmentPatch) return;
    const key = `${snapshot.revision}:${Object.keys(alignmentPatch || {}).sort().join(',')}:${pairs.map((pair) => pair.join(':')).join(',')}`;
    if (autoArrangeRef.current === key) return;
    autoArrangeRef.current = key;
    const arranged = pairs.length
      ? visibleLayoutPositions(
        snapshot.graph.nodes,
        snapshot.view?.collapsedIds || [],
        snapshot.graph.direction,
      )
      : alignmentPatch;
    busyRef.current = true;
    setBusy(true);
    setPositions((current) => ({ ...current, ...arranged }));
    saveView({
      clientId,
      baseRevision: snapshot.revision,
      patch: { positions: arranged },
    }).then((incoming) => {
      installSnapshot(incoming, 'mutation');
      setNotice({
        kind: 'info',
        text: pairs.length
          ? `겹친 카드 ${pairs.length}쌍을 자동으로 정리했습니다.`
          : '같은 계위의 카드 기준선을 정리했습니다.',
      });
    }).catch((error) => {
      if (error.status === 409 && error.body?.snapshot) installSnapshot(error.body.snapshot, 'conflict');
      else setNotice({ kind: 'error', text: `겹친 카드를 정리하지 못했습니다. ${messageOf(error)}` });
    }).finally(releaseBusy);
  }, [clientId, editingNodeId, installSnapshot, positions, releaseBusy, snapshot, workflowMode]);

  const execute = useCallback(
    async (operation, { record = true, viewChange = null } = {}) => {
      while (busyRef.current) await waitForIdle();
      const base = snapshotRef.current;
      if (!base || busyRef.current) return false;
      let historyEntry = historyEntryForOperation(operation, base);
      busyRef.current = true;
      setBusy(true);
      setNotice(null);
      try {
        let incoming = await mutateMap({ baseRevision: base.revision, clientId, operation });
        let pendingView = typeof viewChange === 'function' ? viewChange(incoming) : viewChange;
        if (!pendingView && workflowModeRef.current && operation.type === 'addNode' && operation.section !== 'reference') {
          const collapsedIds = workflowCollapsedIds(base.graph, base.view);
          pendingView = {
            undoView: { workflow: { collapsedIds } },
            redoView: { workflow: { collapsedIds: collapsedIds.filter((id) => id !== operation.parentId) } },
          };
        }
        const reparentedIds = operation.type === 'moveNode'
          ? [operation.id]
          : operation.type === 'moveNodes'
            ? operation.items.map((item) => item.id)
            : [];
        if (!workflowModeRef.current && !pendingView && reparentedIds.length) {
          const renderedPositions = Object.fromEntries(flowNodesRef.current.map((node) => [
            node.id,
            { ...node.position },
          ]));
          const beforePositions = { ...positionsRef.current, ...renderedPositions };
          const preview = reparentBranchesPositions(incoming, beforePositions, reparentedIds);
          const changedIds = Object.keys(preview.positions).filter((id) => (
            preview.positions[id].x !== beforePositions[id]?.x
            || preview.positions[id].y !== beforePositions[id]?.y
          ));
          if (changedIds.length) {
            pendingView = {
              undoView: { positions: positionsFor(changedIds, beforePositions) },
              redoView: { positions: positionsFor(changedIds, preview.positions) },
            };
          }
        }
        if (!workflowModeRef.current && !pendingView && operation.type === 'renameNode') {
          const arranged = arrangementIfOverlapping(incoming, positionsRef.current);
          if (arranged) {
            pendingView = {
              undoView: { positions: positionsFor(Object.keys(arranged), positionsRef.current) },
              redoView: { positions: arranged },
            };
          }
        }
        let viewWarning = null;
        if (pendingView?.redoView) {
          try {
            incoming = await saveView({
              clientId,
              baseRevision: incoming.revision,
              patch: pendingView.redoView,
            });
            if (historyEntry) {
              historyEntry = {
                ...historyEntry,
                undoView: pendingView.undoView,
                redoView: pendingView.redoView,
              };
            }
          } catch (error) {
            viewWarning = messageOf(error);
            if (error.status === 409 && error.body?.snapshot) incoming = error.body.snapshot;
          }
        }
        installSnapshot(incoming, 'mutation');
        if (record) {
          if (historyEntry) setUndoStack((items) => [...items, historyEntry]);
          setRedoStack([]);
        }
        setConflict(null);
        if (viewWarning) setNotice({ kind: 'error', text: `내용은 저장했지만 배치를 저장하지 못했습니다. ${viewWarning}` });
        return true;
      } catch (error) {
        if (error.status === 409 && error.body?.snapshot) {
          installSnapshot(error.body.snapshot, 'conflict');
          setConflict({ operation, message: messageOf(error) });
        } else {
          setNotice({ kind: 'error', text: messageOf(error) });
        }
        return false;
      } finally {
        releaseBusy();
      }
    },
    [clientId, installSnapshot, releaseBusy, waitForIdle],
  );

  editorBridgeRef.current = async (operation) => {
    while (busyRef.current) await waitForIdle();
    const base = snapshotRef.current;
    if (!base) throw new Error('지도를 불러온 뒤 다시 저장합니다.');
    busyRef.current = true;
    // Typing stays enabled while this one bounded request is in flight.
    try {
      const incoming = await mutateMap({ baseRevision: base.revision, clientId, operation });
      installSnapshot(incoming, 'mutation');
      if (incoming.revision !== base.revision) {
        const entry = historyEntryForOperation(operation, base);
        if (entry) setUndoStack((items) => [...items, entry]);
        setRedoStack([]);
      }
      return snapshotRef.current;
    } catch (error) {
      if (error.body?.snapshot) installSnapshot(error.body.snapshot, 'conflict');
      throw error;
    } finally { releaseBusy(); }
  };

  const applyHistoryEntry = useCallback(async (entry, direction) => {
    const operations = Array.isArray(entry?.[direction]) ? entry[direction] : [entry?.[direction]].filter(Boolean);
    const viewPatch = entry?.[`${direction}View`];
    let current = snapshotRef.current;
    if (!current || (!operations.length && !viewPatch) || busyRef.current) return false;
    busyRef.current = true;
    historyInProgressRef.current = true;
    setBusy(true);
    setNotice(null);
    let completed = 0;
    try {
      for (const operation of operations) {
        // History groups are already ordered so each revision-checked operation stays valid.
        // eslint-disable-next-line no-await-in-loop
        current = await mutateMap({ baseRevision: current.revision, clientId, operation });
        snapshotRef.current = current;
        completed += 1;
      }

      let viewWarning = null;
      if (viewPatch) {
        try {
          current = await saveView({
            clientId,
            baseRevision: current.revision,
            patch: viewPatch,
          });
        } catch (error) {
          if (!completed) throw error;
          viewWarning = messageOf(error);
          if (error.status === 409 && error.body?.snapshot) current = error.body.snapshot;
        }
      }

      installSnapshot(current, 'mutation');
      setConflict(null);
      if (viewWarning) {
        setNotice({ kind: 'error', text: `항목은 복원했지만 위치를 되돌리지 못했습니다. ${viewWarning}` });
      }
      return true;
    } catch (error) {
      if (completed) installSnapshot(current, 'mutation');
      if (error.status === 409 && error.body?.snapshot) installSnapshot(error.body.snapshot, 'conflict');
      setNotice({ kind: 'error', text: `${direction === 'undo' ? '실행 취소' : '다시 실행'}에 실패했습니다. ${messageOf(error)}` });
      return false;
    } finally {
      historyInProgressRef.current = false;
      releaseBusy();
    }
  }, [clientId, installSnapshot, releaseBusy]);

  const commitViewChange = useCallback(async ({ label, undoView, redoView }) => {
    const current = snapshotRef.current;
    if (!current || busyRef.current) return false;
    busyRef.current = true;
    historyInProgressRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const incoming = await saveView({
        clientId,
        baseRevision: current.revision,
        patch: redoView,
      });
      installSnapshot(incoming, 'mutation');
      setUndoStack((items) => [...items, viewHistoryEntry(label, undoView, redoView)]);
      setRedoStack([]);
      return true;
    } catch (error) {
      if (error.status === 409 && error.body?.snapshot) installSnapshot(error.body.snapshot, 'conflict');
      setNotice({ kind: 'error', text: messageOf(error) });
      return false;
    } finally {
      historyInProgressRef.current = false;
      releaseBusy();
    }
  }, [clientId, installSnapshot, releaseBusy]);

  const toggleCollapse = useCallback(async (id) => {
    while (busyRef.current) await waitForIdle();
    const current = snapshotRef.current;
    if (!current || busyRef.current) return false;
    if (workflowModeRef.current) {
      workflowAnchorRef.current = id;
      inlineEditor.lastEditedId = null;
      const before = workflowCollapsedIds(current.graph, current.view);
      const collapsed = new Set(before);
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      return commitViewChange({
        label: 'workflow-fold',
        undoView: { workflow: { collapsedIds: before } },
        redoView: { workflow: { collapsedIds: [...collapsed] } },
      });
    }
    const beforeCollapsedIds = [...(current.view?.collapsedIds || [])];
    const nextCollapsed = new Set(beforeCollapsedIds);
    const expanding = nextCollapsed.has(id);
    if (expanding) nextCollapsed.delete(id);
    else nextCollapsed.add(id);
    const collapsedIds = current.graph.nodes
      .map((node) => node.id)
      .filter((nodeId) => nextCollapsed.has(nodeId));
    const preview = branchVisibilityPositions(
      current,
      positionsRef.current,
      id,
      collapsedIds,
      { compact: !expanding },
    );
    const changedIds = Object.keys(preview.positions).filter((nodeId) => (
      preview.positions[nodeId].x !== positionsRef.current[nodeId]?.x
      || preview.positions[nodeId].y !== positionsRef.current[nodeId]?.y
    ));
    return commitViewChange({
      label: expanding ? 'expand-branch' : 'collapse-branch',
      undoView: {
        collapsedIds: beforeCollapsedIds,
        ...(changedIds.length ? { positions: positionsFor(changedIds, positionsRef.current) } : {}),
      },
      redoView: {
        collapsedIds,
        ...(changedIds.length ? { positions: positionsFor(changedIds, preview.positions) } : {}),
      },
    });
  }, [commitViewChange, inlineEditor, waitForIdle]);

  const undo = useCallback(async () => {
    await inlineEditor.flush();
    if (inlineEditor.hasDrafts()) {
      setNotice({ kind: 'info', text: '보관 중인 초안을 먼저 저장하거나 변경을 확인해 주세요.' });
      return;
    }
    while (busyRef.current) await waitForIdle();
    const latest = undoStackRef.current.at(-1);
    if (!latest || !(await applyHistoryEntry(latest, 'undo'))) return;
    setUndoStack((items) => items.slice(0, -1));
    setRedoStack((items) => [...items, latest]);
  }, [applyHistoryEntry, inlineEditor, setRedoStack, setUndoStack, waitForIdle]);

  const redo = useCallback(async () => {
    await inlineEditor.flush();
    if (inlineEditor.hasDrafts()) return;
    while (busyRef.current) await waitForIdle();
    const latest = redoStackRef.current.at(-1);
    if (!latest || !(await applyHistoryEntry(latest, 'redo'))) return;
    setRedoStack((items) => items.slice(0, -1));
    setUndoStack((items) => [...items, latest]);
  }, [applyHistoryEntry, inlineEditor, setRedoStack, setUndoStack, waitForIdle]);

  const deleteSelected = useCallback(async () => {
    await inlineEditor.flush();
    if (inlineEditor.hasDrafts()) {
      setNotice({ kind: 'info', text: '보관 중인 초안을 먼저 저장하거나 변경을 확인해 주세요.' });
      return;
    }
    while (busyRef.current) await waitForIdle();
    const current = snapshotRef.current;
    if (!current || busyRef.current) return;
    const selectedIds = flowNodesRef.current.filter((node) => node.selected).map((node) => node.id);
    if (!selectedIds.length && selectedId) selectedIds.push(selectedId);
    const entry = deletionHistoryEntry(current, selectedIds);
    if (!entry) {
      setNotice({ kind: 'info', text: selectedIds.length ? '최상위 항목은 삭제할 수 없습니다.' : '삭제할 항목을 먼저 선택해 주세요.' });
      return;
    }
    if (!(await execute(entry.redo, { record: false }))) return;
    setUndoStack((items) => [...items, entry]);
    setRedoStack([]);
    const deleted = new Set(entry.deletedIds);
    if (selectedId && deleted.has(selectedId)) {
      setSelectedId(null);
      selectedIdsRef.current = [];
      setSelectedIds([]);
      setEditingNodeId(null);
      setPanelOpen(false);
    }
    setClipboard((currentClipboard) => (
      currentClipboard && deleted.has(currentClipboard.rootId) ? null : currentClipboard
    ));
    setNotice({
      kind: 'info',
      text: entry.rootCount === 1
        ? entry.deletedIds.length === 1
          ? '선택한 항목을 삭제했습니다.'
          : `선택한 가지와 하위 항목을 포함해 ${entry.deletedIds.length}개를 삭제했습니다.`
        : `선택한 가지 ${entry.rootCount}개와 하위 항목, 총 ${entry.deletedIds.length}개를 삭제했습니다.`,
    });
  }, [execute, inlineEditor, selectedId, waitForIdle]);

  const renameNode = useCallback(
    (id, label) => execute({ type: 'renameNode', id, label }),
    [execute],
  );

  const onNodeResizeStart = useCallback((id) => {
    const current = snapshotRef.current;
    if (!current) return;
    const renderedPositions = Object.fromEntries(flowNodesRef.current.map((node) => [
      node.id,
      { ...node.position },
    ]));
    const livePositions = { ...positionsRef.current, ...renderedPositions };
    resizedNodeRef.current = {
      id,
      layout: structuredClone(current.graph.nodes.find((node) => node.id === id)?.layout || { mode: 'fit' }),
      position: { ...(livePositions[id] || { x: 0, y: 0 }) },
      positions: structuredClone(livePositions),
    };
  }, []);

  const onNodeResize = useCallback((id, dimensions) => {
    const current = snapshotRef.current;
    const before = resizedNodeRef.current;
    if (!current || before?.id !== id) return;
    const nextLayout = layoutValue('fixed', dimensions.width, dimensions.height);
    const preview = resizePreview(current, before.positions, id, nextLayout, {
      x: dimensions.x,
      y: dimensions.y,
    });
    setFlowNodes((items) => applyNodeChanges([
      ...Object.entries(preview.positions).map(([nodeId, position]) => ({
        id: nodeId,
        type: 'position',
        position,
      })),
      {
        id,
        type: 'dimensions',
        dimensions: { width: dimensions.width, height: dimensions.height },
        resizing: true,
        setAttributes: true,
      },
    ], items));
  }, []);

  const onNodeResizeCancel = useCallback((id) => {
    if (resizedNodeRef.current?.id === id) resizedNodeRef.current = null;
  }, []);

  const onNodeResizeEnd = useCallback(async (id, dimensions) => {
    const current = snapshotRef.current;
    const before = resizedNodeRef.current;
    resizedNodeRef.current = null;
    if (!current || before?.id !== id) return;
    const nextLayout = layoutValue('fixed', dimensions.width, dimensions.height);
    const anchor = {
      x: Number.isFinite(dimensions.x) ? dimensions.x : before.position.x,
      y: Number.isFinite(dimensions.y) ? dimensions.y : before.position.y,
    };
    const preview = resizePreview(current, before.positions, id, nextLayout, anchor);
    const changedIds = Object.keys(preview.positions).filter((nodeId) => {
      const previous = before.positions[nodeId];
      const next = preview.positions[nodeId];
      return !previous || previous.x !== next.x || previous.y !== next.y;
    });
    const nextPositions = positionsFor(changedIds, preview.positions);
    const viewChange = changedIds.length ? {
      undoView: { positions: positionsFor(changedIds, before.positions) },
      redoView: { positions: nextPositions },
    } : null;
    await execute({
      type: 'setNodeLayouts',
      items: [{ id, layout: nextLayout }],
    }, {
      viewChange,
    });
  }, [execute]);

  const updateNodeLayouts = useCallback(async (ids, draft) => {
    const current = snapshotRef.current;
    if (!current || !ids.length) return false;
    const nodeLayouts = {};
    const items = [];
    ids.forEach((id) => {
      const layout = layoutValue(draft.mode, draft.width, draft.height);
      items.push({ id, layout });
      nodeLayouts[id] = layout;
    });
    const arranged = arrangementIfOverlapping(current, positionsRef.current, nodeLayouts);
    const changedIds = arranged ? Object.keys(arranged) : [];
    return execute({ type: 'setNodeLayouts', items }, {
      viewChange: arranged ? {
        undoView: { positions: positionsFor(changedIds, positionsRef.current) },
        redoView: { positions: arranged },
      } : null,
    });
  }, [execute]);

  const copyNodeKey = useCallback(async (id) => {
    try {
      await writeClipboardText(id);
      setNotice({ kind: 'info', text: `항목 키 ${id}를 복사했습니다.` });
      return true;
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) });
      return false;
    }
  }, []);

  const editTask = useCallback((id) => {
    selectOnly(id);
    setPanelOpen(true);
    requestAnimationFrame(() => document.querySelector('[data-testid="task-fields"]')?.scrollIntoView({ block: 'nearest' }));
  }, [selectOnly]);

  const focusWorkflow = useCallback(async (id) => {
    const current = snapshotRef.current;
    if (!current || busyRef.current) return;
    if (workflowCollapsedIds(current.graph, current.view).includes(id)) await toggleCollapse(id);
    setWorkflowFocusId(id);
    workflowAnchorRef.current = null;
    inlineEditor.lastEditedId = null;
    selectOnly(id);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setViewport(window.innerWidth <= 480 ? compactWorkflowViewport(window.innerWidth) : { x: 40, y: 180, zoom: 0.9 }, { duration: 0 });
    }));
  }, [inlineEditor, selectOnly, setViewport, toggleCollapse]);

  const navigateOverview = useCallback(async (id) => {
    const node = flowNodesRef.current.find((item) => item.id === id);
    const canvas = canvasRef.current;
    if (!node || !canvas || busyRef.current) return;
    selectOnly(id);
    setEditingNodeId(null);
    inlineEditor.lastEditedId = null;
    const bounds = canvas.getBoundingClientRect();
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
    await setViewport(readableNodeViewport(node, bounds), { duration });
    const wrapper = [...canvas.querySelectorAll('.react-flow__node[data-id]')].find((element) => element.dataset.id === id);
    wrapper?.querySelector('.wf-inline-field--title button')?.focus({ preventScroll: true });
  }, [inlineEditor, selectOnly, setViewport]);

  const measureWorkflowHeader = useCallback((id, key, height) => {
    if (!Number.isFinite(height) || height <= 0) return;
    setWorkflowMeasurements((current) => current[id]?.key === key && current[id]?.height === height
      ? current
      : { ...current, [id]: { key, height } });
  }, []);

  const setReferenceSection = useCallback(async (id, section) => {
    await inlineEditor.flush();
    const node = snapshotRef.current?.graph.nodes.find((item) => item.id === id);
    if (!node || node.parentId === null) return;
    const saved = await execute({ type: 'patchNodeContent', id,
      changes: [{ path: 'section', before: node.section ?? null, after: section }] });
    if (saved) {
      selectOnly(null);
      setEditingNodeId(null);
      setPanelOpen(false);
      setNotice({ kind: 'info', text: section ? '이 가지를 참고 자료로 옮겼습니다. 원문과 연결은 그대로 유지됩니다.' : '이 가지를 지도에 돌려놓았습니다.' });
    }
  }, [execute, inlineEditor, selectOnly]);

  const addReference = useCallback(async () => {
    await inlineEditor.flush();
    const root = snapshotRef.current?.graph.nodes.find((node) => node.parentId === null);
    if (!root) return;
    const id = `reference_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const saved = await execute({ type: 'addNode', id, parentId: root.id,
      label: '새 참고 자료', shape: 'rectangle', category: root.category, section: 'reference' });
    if (saved) setReferenceEditingId(id);
  }, [execute, inlineEditor]);

  const setOptionalFields = useCallback(async (fields) => {
    await inlineEditor.flush();
    await execute({ type: 'setMapSettings', settings: { optionalFields: fields } });
  }, [execute, inlineEditor]);

  const graphState = useMemo(() => {
    if (!snapshot) return { nodes: [], edges: [] };
    const rawNodes = sections.system.nodes;
    const nodesById = new Map(rawNodes.map((node) => [node.id, node]));
    const categories = Object.fromEntries(snapshot.graph.categories.map((category) => [category.id, category]));
    if (workflowMode) {
      const layout = nestedWorkflowLayout(snapshot.graph, {
        collapsedIds: workflowCollapsedIds(snapshot.graph, snapshot.view),
        focusId: workflowFocusId,
        measuredHeaders: workflowMeasurements,
      });
      return {
        ...layout,
        nodes: layout.nodes.map((node) => ({
          ...node,
          data: {
            ...node.data,
            category: categories[node.data.category],
            busy,
            editor: inlineEditor,
            editing: editingNodeId === node.id,
            onToggleCollapse: toggleCollapse,
            onFocus: focusWorkflow,
            onEditTask: editTask,
            onCopyKey: copyNodeKey,
            onRename: renameNode,
            onAddChild: (id) => createNodeBridgeRef.current('child', id),
            onAddSibling: (id) => createNodeBridgeRef.current('sibling', id),
            onHeaderMeasure: measureWorkflowHeader,
            onMoveToReference: node.data.parentId ? (id) => setReferenceSection(id, 'reference') : undefined,
            onEditingComplete: (id) => setEditingNodeId((current) => current === id ? null : current),
          },
        })),
      };
    }
    const depths = new Map(rawNodes.map((node) => {
      let depth = 0;
      let cursor = node;
      while (cursor.parentId && nodesById.has(cursor.parentId)) {
        depth += 1;
        cursor = nodesById.get(cursor.parentId);
      }
      return [node.id, depth];
    }));
    const collapsed = new Set(snapshot.view?.collapsedIds || []);
    const hidden = hiddenNodeIds(rawNodes, collapsed);
    const visible = new Set(rawNodes.filter((node) => !hidden.has(node.id)).map((node) => node.id));
    const nodes = rawNodes
      .filter((node) => visible.has(node.id))
      .map((node) => {
        const layout = resolveNodeLayout(node);
        return {
          id: node.id,
          type: 'mapNode',
          position: positions[node.id] || { x: 0, y: 0 },
          width: layout.width,
          ...(layout.mode === 'fixed' ? { height: layout.height } : {}),
          data: {
          ...node,
          layout,
          category: categories[node.category] || {
            label: node.category,
            fill: '#fffdf7',
            stroke: '#66736c',
            textColor: '#1f2925',
            strokeWidth: 1,
          },
          childCount: rawNodes.filter((child) => child.parentId === node.id).length,
          depth: depths.get(node.id) || 0,
          collapsed: collapsed.has(node.id),
          cut: clipboard?.mode === 'cut' && clipboard.rootId === node.id,
          editing: editingNodeId === node.id,
          canvasPosition: positions[node.id] || { x: 0, y: 0 },
          onToggleCollapse: toggleCollapse,
          onCopyKey: copyNodeKey,
          onRename: renameNode,
          onResizeStart: onNodeResizeStart,
          onResize: onNodeResize,
          onResizeCancel: onNodeResizeCancel,
          onResizeEnd: onNodeResizeEnd,
          onEditingComplete: (id) => setEditingNodeId((current) => (current === id ? null : current)),
        },
        };
      });
    const edges = rawNodes
      .filter((node) => node.parentId && visible.has(node.id) && visible.has(node.parentId))
      .map((node) => ({
        id: `${node.parentId}-${node.id}`,
        source: node.parentId,
        target: node.id,
        type: 'smoothstep',
        style: {
          stroke: categories[node.category]?.stroke || '#6f7f78',
          strokeWidth: 2,
        },
      }));
    return { nodes, edges };
  }, [busy, clipboard, copyNodeKey, editingNodeId, editTask, focusWorkflow, inlineEditor, measureWorkflowHeader, onNodeResize, onNodeResizeCancel, onNodeResizeEnd, onNodeResizeStart, positions, renameNode, sections, setReferenceSection, snapshot, toggleCollapse, workflowMode, workflowFocusId, workflowMeasurements]);

  useLayoutEffect(() => {
    const selected = new Set(selectedIdsRef.current);
    const next = graphState.nodes.map((node) => ({ ...node, selected: selected.has(node.id) }));
    if (workflowMode && initializedViewport.current) {
      const previous = flowNodesRef.current;
      const rootId = graphState.rootId;
      const anchorId = inlineEditor.lastEditedId || workflowAnchorRef.current || selectedIdsRef.current[0] || rootId;
      const before = previous.find((node) => node.id === anchorId);
      const after = next.find((node) => node.id === anchorId);
      if (previous.find((node) => node.data.depth === 0)?.id === rootId && before && after) {
        const dx = before.position.x - after.position.x;
        const dy = before.position.y - after.position.y;
        if (dx || dy) {
          const viewport = getViewport();
          setViewport({ ...viewport, x: viewport.x + dx * viewport.zoom, y: viewport.y + dy * viewport.zoom }, { duration: 0 });
        }
      }
    }
    flowNodesRef.current = next;
    setFlowNodes(next);
  }, [getViewport, graphState, inlineEditor, setViewport, workflowMode]);

  const selectedNodes = snapshot?.graph.nodes.filter((node) => selectedIds.includes(node.id)) || [];
  const selected = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const selectedCategory = selected
    ? snapshot.graph.categories.find((category) => category.id === selected.category)
    : null;
  const collapsedIdSet = new Set(snapshot && workflowMode
    ? workflowCollapsedIds(snapshot.graph, snapshot.view)
    : snapshot?.view?.collapsedIds || []);
  const childParentIds = new Set(snapshot?.graph?.nodes.map((node) => node.parentId).filter(Boolean) || []);
  const collapsibleBranchIds = snapshot?.graph?.nodes
    .filter((node) => node.parentId && childParentIds.has(node.id))
    .map((node) => node.id) || [];
  const canExpandAll = collapsedIdSet.size > 0;
  const canCollapseAll = collapsedIdSet.size !== collapsibleBranchIds.length
    || collapsibleBranchIds.some((id) => !collapsedIdSet.has(id));
  const minimapSize = compactCanvas
    ? { width: 152, height: 104 }
    : { width: 200, height: 150 };
  const minimapToggleStyle = minimapOpen ? {
    right: 15 + minimapSize.width - 48,
    bottom: 15 + minimapSize.height - 48,
  } : undefined;

  const onNodeDragStart = useCallback((_, node) => {
    const current = snapshotRef.current;
    if (!current) return;
    const rememberedSelection = selectedIdsRef.current;
    const selectedForDrag = rememberedSelection.includes(node.id)
      ? rememberedSelection
      : [node.id];
    const rootIds = topLevelSelectedNodeIds(current.graph.nodes, selectedForDrag);
    const movingIds = new Set();
    rootIds.forEach((rootId) => {
      movingIds.add(rootId);
      descendantsOf(rootId, current.graph.nodes).forEach((id) => movingIds.add(id));
    });
    const semanticRootIds = rootIds.filter((id) => (
      current.graph.nodes.find((candidate) => candidate.id === id)?.parentId !== null
    ));
    const basePositions = {};
    const renderedPositions = new Map(flowNodesRef.current.map((item) => [item.id, item.position]));
    const allPositions = {
      ...positionsRef.current,
      ...Object.fromEntries([...renderedPositions].map(([id, position]) => [id, { ...position }])),
    };
    movingIds.forEach((id) => {
      const position = renderedPositions.get(id) || positionsRef.current[id];
      if (position) basePositions[id] = { ...position };
    });
    basePositions[node.id] = { ...node.position };
    showDropTarget(null);
    draggedBranchRef.current = {
      rootId: node.id,
      rootIds,
      semanticRootIds,
      start: { ...node.position },
      movingIds,
      basePositions,
      allPositions,
      dropTargetId: null,
    };
  }, [showDropTarget]);

  const onNodeDrag = useCallback((event, node) => {
    const drag = draggedBranchRef.current;
    if (!drag || drag.rootId !== node.id) return;
    const delta = {
      x: node.position.x - drag.start.x,
      y: node.position.y - drag.start.y,
    };
    setFlowNodes((items) => items.map((item) => {
      if (!drag.movingIds.has(item.id) || item.id === node.id) return item;
      const base = drag.basePositions[item.id];
      if (!base) return item;
      return { ...item, position: { x: base.x + delta.x, y: base.y + delta.y } };
    }));
    const current = snapshotRef.current;
    const targetId = validReparentDropTarget(event, drag, current?.graph.nodes || []);
    drag.dropTargetId = targetId;
    showDropTarget(targetId, drag.semanticRootIds.length);
  }, [showDropTarget]);

  const onNodeDragStop = useCallback(
    async (event, node) => {
      const current = snapshotRef.current;
      if (!current) return;
      const drag = draggedBranchRef.current;
      if (!drag || drag.rootId !== node.id) return;
      const targetId = validReparentDropTarget(event, drag, current.graph.nodes);
      draggedBranchRef.current = null;
      showDropTarget(null);
      const baseline = drag.allPositions || positionsRef.current;

      if (targetId) {
        const items = drag.semanticRootIds.map((id) => ({ id, parentId: targetId }));
        const collapsedIds = (current.view?.collapsedIds || []).filter((id) => id !== targetId);
        const projectedSnapshot = {
          ...current,
          graph: {
            ...current.graph,
            nodes: current.graph.nodes.map((candidate) => {
              const move = items.find((item) => item.id === candidate.id);
              return move ? { ...candidate, parentId: move.parentId } : candidate;
            }),
          },
          view: { ...current.view, collapsedIds },
        };
        const optimistic = reparentBranchesPositions(
          projectedSnapshot,
          baseline,
          drag.semanticRootIds,
        );
        setFlowNodes((itemsInView) => itemsInView.map((item) => (
          optimistic.positions[item.id]
            ? { ...item, position: optimistic.positions[item.id] }
            : item
        )));
        const moved = await execute({ type: 'moveNodes', items }, {
          viewChange: (incoming) => {
            const layoutSnapshot = {
              ...incoming,
              view: { ...incoming.view, collapsedIds },
            };
            const preview = reparentBranchesPositions(
              layoutSnapshot,
              baseline,
              drag.semanticRootIds,
            );
            const changedIds = Object.keys(preview.positions).filter((id) => (
              preview.positions[id].x !== baseline[id]?.x
              || preview.positions[id].y !== baseline[id]?.y
            ));
            const revealsTarget = collapsedIds.length !== (current.view?.collapsedIds || []).length;
            if (!changedIds.length && !revealsTarget) return null;
            return {
              undoView: {
                positions: positionsFor(changedIds, baseline),
                ...(revealsTarget ? { collapsedIds: [...(current.view?.collapsedIds || [])] } : {}),
              },
              redoView: {
                positions: positionsFor(changedIds, preview.positions),
                ...(revealsTarget ? { collapsedIds } : {}),
              },
            };
          },
        });
        if (!moved) {
          setFlowNodes((itemsInView) => itemsInView.map((item) => (
            baseline[item.id] ? { ...item, position: baseline[item.id] } : item
          )));
        }
        return;
      }

      const delta = {
        x: node.position.x - drag.start.x,
        y: node.position.y - drag.start.y,
      };
      const patch = {};
      drag.movingIds.forEach((id) => {
        const base = drag.basePositions[id];
        if (base) patch[id] = { x: base.x + delta.x, y: base.y + delta.y };
      });
      patch[node.id] = { ...node.position };
      const packingRootId = drag.rootIds.find((id) => (
        id === node.id || descendantsOf(id, current.graph.nodes).has(node.id)
      )) || node.id;
      const preview = reflowSiblingBranches(current, { ...baseline, ...patch }, packingRootId);
      const changedIds = Object.keys(preview.positions).filter((id) => (
        preview.positions[id].x !== baseline[id]?.x || preview.positions[id].y !== baseline[id]?.y
      ));
      const nextPositions = positionsFor(changedIds, preview.positions);
      const beforePositions = positionsFor(changedIds, baseline);
      const unchanged = changedIds.every((id) => (
        beforePositions[id]?.x === nextPositions[id].x && beforePositions[id]?.y === nextPositions[id].y
      ));
      if (unchanged) return;
      setPositions((value) => ({ ...value, ...nextPositions }));
      await commitViewChange({
        label: 'move-branch',
        undoView: { positions: beforePositions },
        redoView: { positions: nextPositions },
      });
    },
    [commitViewChange, execute, showDropTarget],
  );

  const onMoveEnd = useCallback(
    (_, viewport) => {
      clearTimeout(viewportTimerRef.current);
      const workflow = workflowModeRef.current;
      viewportTimerRef.current = setTimeout(async () => {
        const current = snapshotRef.current;
        if (!current) return;
        try {
          await saveView({ clientId, baseRevision: current.revision, patch: workflow
            ? { workflow: { viewport } } : { viewport } });
        } catch { /* View navigation can be repeated; content uses guarded saves. */ }
      }, 500);
    },
    [clientId],
  );

  const arrangeVisible = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current || busyRef.current) return;
    if (workflowModeRef.current) {
      fitView({ padding: 0.12, duration: 0, minZoom: 0.08 });
      return;
    }
    const arranged = visibleLayoutPositions(
      current.graph.nodes,
      current.view?.collapsedIds || [],
      current.graph.direction,
    );
    setPositions((value) => ({ ...value, ...arranged }));
    setFlowNodes((items) => items.map((node) => (
      arranged[node.id] ? { ...node, position: arranged[node.id] } : node
    )));
    const saved = await commitViewChange({
      label: 'arrange-visible',
      undoView: { positions: positionsFor(Object.keys(arranged), positionsRef.current) },
      redoView: { positions: arranged },
    });
    if (saved) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        fitView({ padding: 0.16, duration: 220 });
      }));
    }
  }, [commitViewChange, fitView]);

  const setAllBranchesVisibility = useCallback(async (expanded) => {
    const current = snapshotRef.current;
    if (!current || busyRef.current) return false;
    const childParentIds = new Set(current.graph.nodes.map((node) => node.parentId).filter(Boolean));
    const collapsedIds = expanded
      ? []
      : current.graph.nodes
        .filter((node) => node.parentId && childParentIds.has(node.id))
        .map((node) => node.id);
    const beforeCollapsedIds = [...(current.view?.collapsedIds || [])];
    if (workflowModeRef.current) {
      return commitViewChange({
        label: expanded ? 'workflow-expand-all' : 'workflow-collapse-all',
        undoView: { workflow: { collapsedIds: workflowCollapsedIds(current.graph, current.view) } },
        redoView: { workflow: { collapsedIds } },
      });
    }
    const arranged = allBranchVisibilityPositions(current, positionsRef.current, collapsedIds);
    const changedIds = Object.keys(arranged).filter((nodeId) => (
      arranged[nodeId].x !== positionsRef.current[nodeId]?.x
      || arranged[nodeId].y !== positionsRef.current[nodeId]?.y
    ));
    return commitViewChange({
      label: expanded ? 'expand-all-branches' : 'collapse-all-branches',
      undoView: {
        collapsedIds: beforeCollapsedIds,
        ...(changedIds.length ? { positions: positionsFor(changedIds, positionsRef.current) } : {}),
      },
      redoView: {
        collapsedIds,
        ...(changedIds.length ? { positions: positionsFor(changedIds, arranged) } : {}),
      },
    });
  }, [commitViewChange]);

  const expandAllBranches = useCallback(
    () => setAllBranchesVisibility(true),
    [setAllBranchesVisibility],
  );

  const collapseAllBranches = useCallback(
    () => setAllBranchesVisibility(false),
    [setAllBranchesVisibility],
  );

  const cloneBranch = useCallback(async (targetId) => {
    const base = snapshotRef.current;
    if (!base || !clipboard?.nodes?.length || busyRef.current) return;
    const renderedPositions = Object.fromEntries(flowNodesRef.current.filter(() => !workflowModeRef.current).map((node) => [
      node.id,
      { ...node.position },
    ]));
    const beforeClonePositions = { ...positionsRef.current, ...renderedPositions };
    const stamp = Date.now().toString(36);
    const idMap = new Map(clipboard.nodes.map((node, index) => [node.id, `node_${stamp}_${index.toString(36)}`]));
    const operations = clipboard.nodes.map((node, index) => ({
      type: 'addNode',
      id: idMap.get(node.id),
      parentId: index === 0 ? targetId : idMap.get(node.parentId),
      label: node.label,
      shape: node.shape,
      category: node.category,
      ...(node.layout ? { layout: structuredClone(node.layout) } : {}),
      ...(node.task ? { task: structuredClone(node.task) } : {}),
      ...(node.workflow ? { workflow: structuredClone(node.workflow) } : {}),
      ...(node.proposal !== undefined ? { proposal: structuredClone(node.proposal) } : {}),
      ...(node.section ? { section: node.section } : {}),
    }));
    let current = base;
    const completed = [];
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    for (let index = 0; index < operations.length; index += 1) {
      try {
        // Each successful response is the base for the next node in the branch.
        // eslint-disable-next-line no-await-in-loop
        current = await mutateMap({ baseRevision: current.revision, clientId, operation: operations[index] });
        snapshotRef.current = current;
        completed.push(operations[index]);
      } catch (error) {
        if (error.status === 409 && error.body?.snapshot) {
          installSnapshot(error.body.snapshot, 'conflict');
          setConflict({ operation: operations[index], message: `${index}/${operations.length}개를 복제한 뒤 충돌했습니다. ${messageOf(error)}` });
        } else {
          setNotice({ kind: 'error', text: `${index}/${operations.length}개만 복제했습니다. ${messageOf(error)}` });
        }
        if (completed.length) {
          setUndoStack((items) => [...items, {
            label: 'branch-copy',
            undo: [...completed].reverse().map((operation) => ({ type: 'deleteLeaf', id: operation.id })),
            redo: [...completed],
          }]);
          setRedoStack([]);
        }
        releaseBusy();
        return;
      }
    }
    if (workflowModeRef.current) {
      const beforeCollapsed = workflowCollapsedIds(base.graph, base.view);
      const collapsedIds = [
        ...beforeCollapsed.filter((id) => id !== targetId),
        ...beforeCollapsed.filter((id) => idMap.has(id)).map((id) => idMap.get(id)),
      ];
      try {
        current = await saveView({ clientId, baseRevision: current.revision, patch: { workflow: {
          collapsedIds,
        } } });
      } catch (error) {
        setNotice({ kind: 'error', text: `가지는 복제했지만 펼침 상태를 저장하지 못했습니다. ${messageOf(error)}` });
      }
      installSnapshot(current, 'mutation');
      setUndoStack((items) => [...items, {
        label: 'branch-copy',
        undo: [...completed].reverse().map((operation) => ({ type: 'deleteLeaf', id: operation.id })),
        redo: [...completed],
        undoView: { workflow: { collapsedIds: beforeCollapsed } },
        redoView: { workflow: { collapsedIds } },
      }]);
      setRedoStack([]);
      selectOnly(operations[0].id);
      releaseBusy();
      return;
    }
    const mergedPositions = mergeSnapshotPositions(current, beforeClonePositions, true);
    const preview = reparentBranchPositions(current, mergedPositions, operations[0].id);
    const newIds = new Set(operations.map((operation) => operation.id));
    const changedExistingIds = Object.keys(preview.positions).filter((id) => (
      !newIds.has(id)
      && (preview.positions[id].x !== beforeClonePositions[id]?.x
        || preview.positions[id].y !== beforeClonePositions[id]?.y)
    ));
    const redoPositionIds = [...newIds, ...changedExistingIds];
    let viewSaved = false;
    try {
      current = await saveView({
        clientId,
        baseRevision: current.revision,
        patch: { positions: positionsFor(redoPositionIds, preview.positions) },
      });
      viewSaved = true;
    } catch (error) {
      setNotice({ kind: 'error', text: `가지는 복제했지만 배치를 저장하지 못했습니다. ${messageOf(error)}` });
    }
    installSnapshot(current, 'mutation');
    const historyEntry = {
      label: 'branch-copy',
      undo: [...completed].reverse().map((operation) => ({ type: 'deleteLeaf', id: operation.id })),
      redo: [...completed],
      ...(viewSaved ? {
        undoView: { positions: positionsFor(changedExistingIds, beforeClonePositions) },
        redoView: { positions: positionsFor(redoPositionIds, preview.positions) },
      } : {}),
    };
    setUndoStack((items) => [...items, historyEntry]);
    setRedoStack([]);
    selectOnly(operations[0].id);
    releaseBusy();
  }, [clientId, clipboard, installSnapshot, releaseBusy, selectOnly]);

  const createKeyboardNode = useCallback(async (kind, anchorId) => {
    while (busyRef.current) await waitForIdle();
    let current = snapshotRef.current;
    const anchor = current?.graph.nodes.find((node) => node.id === anchorId);
    if (!current || !anchor || busyRef.current) return;

    const currentCollapsed = workflowModeRef.current
      ? workflowCollapsedIds(current.graph, current.view)
      : current.view?.collapsedIds || [];
    if (kind === 'child' && currentCollapsed.includes(anchor.id)) {
      const collapsedIds = currentCollapsed.filter((id) => id !== anchor.id);
      try {
        const expanded = await saveView({
          clientId,
          baseRevision: current.revision,
          patch: workflowModeRef.current ? { workflow: { collapsedIds } } : { collapsedIds },
        });
        installSnapshot(expanded, 'mutation');
        current = expanded;
      } catch (error) {
        setNotice({ kind: 'error', text: `하위 가지를 펼치지 못했습니다. ${messageOf(error)}` });
        return;
      }
    }

    const id = makeNodeId();
    const parentId = kind === 'child' || !anchor.parentId ? anchor.id : anchor.parentId;
    pendingCreateIdRef.current = id;
    revealCreatedIdRef.current = id;
    workflowAnchorRef.current = anchorId;
    inlineEditor.lastEditedId = null;
    const ok = await execute({
      type: 'addNode',
      id,
      parentId,
      label: '새 항목',
      shape: anchor.shape,
      category: anchor.category,
    });
    if (!ok) {
      pendingCreateIdRef.current = null;
      revealCreatedIdRef.current = null;
      setEditingNodeId(null);
      return;
    }
    selectOnly(id);
    setPanelOpen(!workflowModeRef.current);
    requestAnimationFrame(() => setEditingNodeId(id));
  }, [clientId, execute, inlineEditor, installSnapshot, selectOnly, waitForIdle]);

  createNodeBridgeRef.current = createKeyboardNode;

  const executeAfterIdle = useCallback(async (operation) => {
    while (busyRef.current) await waitForIdle();
    return execute(operation);
  }, [execute, waitForIdle]);

  shortcutContextRef.current = {
    clipboard,
    cloneBranch,
    createKeyboardNode,
    deleteSelected,
    execute,
    executeAfterIdle,
    fitView,
    flowNodes,
    redo,
    selectedId,
    shortcutHelp,
    referenceOpen,
    undo,
    zoomIn,
    zoomOut,
  };

  useEffect(() => {
    function isEditingTarget(target) {
      return target instanceof HTMLElement
        && (target.matches('input, textarea, select') || target.isContentEditable);
    }

    async function onKeyDown(event) {
      if (event.defaultPrevented || isEditingTarget(event.target)) return;
      if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element
        && event.target.closest('button, a')) return;
      const context = shortcutContextRef.current;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const current = snapshotRef.current;
      const selectedNode = current?.graph.nodes.find((node) => node.id === context.selectedId);

      if (context.shortcutHelp) return;
      if (command && !event.altKey && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) await context.redo();
        else await context.undo();
        return;
      }
      if (context.referenceOpen) return;
      if (!command && !event.altKey && (key === 'delete' || key === 'backspace')) {
        event.preventDefault();
        await context.deleteSelected();
        return;
      }

      if (command && key === 'c' && selectedNode) {
        event.preventDefault();
        const subtreeIds = descendantsOf(selectedNode.id, current.graph.nodes);
        subtreeIds.add(selectedNode.id);
        const ordered = [];
        const visit = (id) => {
          const node = current.graph.nodes.find((item) => item.id === id);
          if (!node) return;
          ordered.push(node);
          current.graph.nodes.filter((item) => item.parentId === id).forEach((item) => visit(item.id));
        };
        visit(selectedNode.id);
        setClipboard({ mode: 'copy', rootId: selectedNode.id, nodes: ordered.filter((node) => subtreeIds.has(node.id)) });
        setNotice({ kind: 'info', text: `“${selectedNode.label}” 가지를 복사했습니다.` });
        return;
      }
      if (command && key === 'x' && selectedNode?.parentId) {
        event.preventDefault();
        setClipboard({ mode: 'cut', rootId: selectedNode.id, nodes: [selectedNode] });
        setNotice({ kind: 'info', text: `“${selectedNode.label}” 가지를 옮길 준비가 됐습니다.` });
        return;
      }
      if (command && key === 'v' && selectedNode && context.clipboard) {
        event.preventDefault();
        if (context.clipboard.mode === 'cut') {
          const blocked = descendantsOf(context.clipboard.rootId, current.graph.nodes);
          blocked.add(context.clipboard.rootId);
          if (blocked.has(selectedNode.id)) {
            setNotice({ kind: 'error', text: '선택한 가지 자신이나 그 아래로는 옮길 수 없습니다.' });
            return;
          }
          const ok = await context.executeAfterIdle({
            type: 'moveNode',
            id: context.clipboard.rootId,
            parentId: selectedNode.id,
          });
          if (ok) setClipboard(null);
        } else {
          await context.cloneBranch(selectedNode.id);
        }
        return;
      }
      if (command && key === 'a') {
        event.preventDefault();
        setFlowNodes((items) => items.map((node) => ({ ...node, selected: true })));
        selectionRequestRef.current = {
          ids: context.flowNodes.map((node) => node.id),
          expiresAt: Date.now() + 1000,
        };
        selectedIdsRef.current = selectionRequestRef.current.ids;
        setSelectedIds(selectedIdsRef.current);
        setSelectedId(null);
        return;
      }
      if (command && (event.key === '+' || event.key === '=')) {
        event.preventDefault();
        context.zoomIn({ duration: 140 });
        return;
      }
      if (command && event.key === '-') {
        event.preventDefault();
        context.zoomOut({ duration: 140 });
        return;
      }
      if (command && event.key === '0') {
        event.preventDefault();
        context.fitView({ padding: 0.24, duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180 });
        return;
      }
      if (!command && !event.altKey && !event.shiftKey && event.key === 'Enter' && selectedNode) {
        event.preventDefault();
        await context.createKeyboardNode('sibling', selectedNode.id);
        return;
      }
      if (!command && !event.altKey && event.key === 'Tab' && selectedNode) {
        event.preventDefault();
        if (event.shiftKey) {
          const parent = current.graph.nodes.find((node) => node.id === selectedNode.parentId);
          if (parent?.parentId) {
            await context.executeAfterIdle({ type: 'moveNode', id: selectedNode.id, parentId: parent.parentId });
          }
          else setNotice({ kind: 'info', text: '더 바깥 단계로 옮길 수 없습니다.' });
        } else {
          await context.createKeyboardNode('child', selectedNode.id);
        }
        return;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!snapshot) {
    return (
      <main className="loading-screen" data-testid="loading">
        <div className="loading-mark"><span /><span /><span /></div>
        <p>지도를 펼치고 있습니다</p>
      </main>
    );
  }

  return (
    <main className={`app-shell${workflowMode ? ' app-shell--workflow' : ''}${referenceOpen ? ' app-shell--references' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true"><Icon name="layers" /></span>
          <div>
            <h1>Shape map</h1>
            <p>{snapshot.mapPath?.split('/').at(-1) || '현재 지도'} · 로컬 전용</p>
          </div>
        </div>
        <div className="topbar__actions">
          <a href={api.workspaceHref} className="quiet-button" style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}>제품 지도</a>
          {workflowMode ? <InlineSaveStatus editor={inlineEditor} connection={connection} onCopy={writeClipboardText} /> : <span className={`sync-state sync-state--${connection}`} data-testid="connection-status">
            <span aria-hidden="true" />{connection === 'online' ? '동기화됨' : connection === 'offline' ? '연결 확인 중' : '연결 중'}
          </span>}
          <button
            type="button"
            className="quiet-button history-button undo-button"
            aria-label="마지막 편집 실행 취소"
            title="실행 취소 (⌘/Ctrl+Z)"
            data-testid="undo-button"
            disabled={!undoStack.length || busy}
            onClick={undo}
          >
            <Icon name="undo" />
            <span>실행 취소</span>
          </button>
          <button
            type="button"
            className="quiet-button history-button redo-button"
            aria-label="되돌린 편집 다시 실행"
            title="다시 실행 (⌘/Ctrl+Shift+Z)"
            data-testid="redo-button"
            disabled={!redoStack.length || busy}
            onClick={redo}
          >
            <Icon name="redo" />
            <span>다시 실행</span>
          </button>
          <button
            type="button"
            className="shortcut-button"
            aria-label="단축키 보기"
            data-testid="shortcut-help-button"
            onClick={() => setShortcutHelp(true)}
          >
            <span aria-hidden="true">?</span><span className="shortcut-button__label">단축키</span>
          </button>
          <div className="branch-visibility-group" role="group" aria-label="전체 가지 표시">
            <button
              type="button"
              className="quiet-button branch-action-button"
              aria-label="모든 하위 가지 펼치기"
              title="모두 펼치기"
              data-testid="expand-all-button"
              disabled={busy || !canExpandAll}
              onClick={expandAllBranches}
            >
              <Icon name="expand" />
              <span>모두 펼치기</span>
            </button>
            <button
              type="button"
              className="quiet-button branch-action-button"
              aria-label="모든 하위 가지 접기"
              title="모두 접기"
              data-testid="collapse-all-button"
              disabled={busy || !canCollapseAll}
              onClick={collapseAllBranches}
            >
              <Icon name="collapse" />
              <span>모두 접기</span>
            </button>
          </div>
          <button
            type="button"
            className="quiet-button arrange-button"
            aria-label="현재 보이는 가지 정리"
            data-testid="arrange-visible-button"
            disabled={busy}
            onClick={arrangeVisible}
          >
            <Icon name="arrange" />
            <span>{workflowMode ? '한눈에 보기' : '보이는 가지 정리'}</span>
          </button>
          {selectedNodes.length > 0 && (
            <button
              type="button"
              className="quiet-button property-button"
              aria-label={selectedNodes.length === 1 ? '선택한 항목 세부 편집' : `선택한 항목 ${selectedNodes.length}개 일괄 편집`}
              aria-pressed={panelOpen}
              data-testid="properties-button"
              onClick={() => setPanelOpen(true)}
            >
              <span>{selectedNodes.length === 1 ? (workflowMode ? '구조·표현' : '편집') : `${selectedNodes.length}개 편집`}</span>
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            data-testid="add-root-child-button"
            onClick={() => {
              const root = workflowMode
                ? snapshot.graph.nodes.find((node) => node.id === graphState.rootId)
                : snapshot.graph.nodes.find((node) => !node.parentId);
              selectOnly(root?.id || snapshot.graph.nodes[0]?.id);
              if (workflowMode) { createKeyboardNode('child', root?.id || snapshot.graph.nodes[0]?.id); return; }
              setPanelOpen(true);
              requestAnimationFrame(() => document.querySelector('[data-testid="new-child-input"]')?.focus());
            }}
          >
            <Icon name="plus" /> 항목 추가
          </button>
        </div>
      </header>

      <div className="workflow-navigation">
        <div className="view-switch" role="group" aria-label="지도 보기 방식">
          <button type="button" aria-pressed={workflowMode && !referenceOpen} onClick={() => { setReferenceOpen(false); setWorkflowMode(true); setNotice(null); }}>마인드맵</button>
          <button type="button" aria-pressed={!workflowMode && !referenceOpen} onClick={() => { setReferenceOpen(false); setWorkflowMode(false); setNotice(null); }}>구조 보기</button>
          <button type="button" aria-pressed={referenceOpen} onClick={() => { setReferenceOpen(true); selectOnly(null); setEditingNodeId(null); setPanelOpen(false); setNotice(null); }}>참고 자료{sections.references.length > 0 ? ` ${sections.references.length}` : ''}</button>
        </div>
        {workflowMode && !referenceOpen ? (
          <>
            <nav className="workflow-breadcrumb" aria-label="현재 작업 경로">
              {workflowAncestors(snapshot.graph.nodes, graphState.rootId).map((node, index, path) => (
                <span key={node.id}>
                  {index > 0 && <span aria-hidden="true">/</span>}
                  <button type="button" title={node.label} aria-current={index === path.length - 1 ? 'location' : undefined}
                    disabled={busy} onClick={() => focusWorkflow(node.id)}>{node.label}</button>
                </span>
              ))}
            </nav>
            <span className="workflow-guide">내용을 눌러 바로 수정 · 자동 저장</span>
          </>
        ) : <span className="workflow-guide">연결선은 상위·하위 관계를 나타냅니다</span>}
        {!referenceOpen && <MapFieldPicker fields={optionalFields} busy={busy} onChange={setOptionalFields} />}
      </div>

      {sourceError && (
        <div className="status-banner status-banner--error" role="alert" data-testid="source-error-banner">
          <strong>원본 파일을 확인해 주세요.</strong>
          <span>{sourceError}</span>
          <em>마지막으로 정상인 지도를 유지하고 있습니다.</em>
        </div>
      )}
      {conflict && (
        <div className="status-banner status-banner--conflict" role="alertdialog" aria-label="변경 충돌" data-testid="conflict-banner">
          <div><strong>다른 변경이 먼저 저장됐습니다.</strong><span>{conflict.message}</span></div>
          <div className="status-banner__actions">
            <button type="button" data-testid="conflict-cancel" onClick={() => setConflict(null)}>취소</button>
            <button type="button" data-testid="conflict-retry" disabled={busy} onClick={() => execute(conflict.operation)}>새 지도에 다시 적용</button>
          </div>
        </div>
      )}
      {notice && (
        <div className={`toast toast--${notice.kind}`} role="status" data-testid="notice">
          <span>{notice.text}</span>
          <button type="button" aria-label="알림 닫기" onClick={() => setNotice(null)}><Icon name="close" /></button>
        </div>
      )}

      <section className={`workspace${panelOpen && !referenceOpen ? ' workspace--panel' : ''}${referenceOpen ? ' workspace--references' : ''}`}>
        <div
          ref={canvasRef}
          className="canvas"
          data-testid="map-canvas"
          aria-hidden={referenceOpen || undefined}
          inert={referenceOpen || undefined}
          onContextMenu={(event) => event.preventDefault()}
        >
          <SelectionCountContext.Provider value={selectedIds.length}>
            <ReactFlow
              nodes={flowNodes}
              edges={graphState.edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => setFlowNodes((items) => applyNodeChanges(changes, items))}
            onSelectionChange={({ nodes }) => {
              const ids = nodes.map((node) => node.id);
              const requested = selectionRequestRef.current;
              if (requested && requested.expiresAt >= Date.now() && !sameSelection(requested.ids, ids)) {
                const requestedIds = new Set(requested.ids);
                setFlowNodes((items) => items.map((node) => ({ ...node, selected: requestedIds.has(node.id) })));
                return;
              }
              selectionRequestRef.current = null;
              selectedIdsRef.current = ids;
              setSelectedIds((current) => (
                current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids
              ));
              const nextSelectedId = ids.length === 1 ? ids[0] : null;
              setSelectedId((current) => (current === nextSelectedId ? current : nextSelectedId));
            }}
            onNodeClick={(_, node) => {
              if (workflowMode && getViewport().zoom < OVERVIEW_ZOOM) {
                navigateOverview(node.id);
                return;
              }
              selectOnly(node.id);
              setEditingNodeId(null);
            }}
            onNodeDoubleClick={workflowMode ? (event, node) => {
              if (busy || !event.target.closest('.wf-card') || event.target.closest('button,input,textarea,select')) return;
              setEditingNodeId(node.id);
            } : undefined}
            onPaneClick={() => {
              selectOnly(null);
              setEditingNodeId(null);
              setPanelOpen(false);
            }}
            onNodeDragStart={workflowMode ? undefined : onNodeDragStart}
            onNodeDrag={workflowMode ? undefined : onNodeDrag}
            onNodeDragStop={workflowMode ? undefined : onNodeDragStop}
            onMoveEnd={onMoveEnd}
            onInit={onFlowInit}
            minZoom={workflowMode ? 0.08 : 0.2}
            maxZoom={2}
            nodesConnectable={false}
            deleteKeyCode={null}
            selectionOnDrag={!compactCanvas}
            panOnScroll
            panOnScrollMode={PanOnScrollMode.Free}
            panOnDrag={compactCanvas ? true : [1, 2]}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            fitView={!workflowMode && !snapshot.view?.viewport}
            >
            <Background variant={BackgroundVariant.Dots} gap={28} size={1.15} color="#c8c7bc" />
            <CanvasZoomControls onZoomIn={zoomIn} onZoomOut={zoomOut} onZoomTo={zoomTo}
              onFit={() => fitView({ padding: 0.16, minZoom: workflowMode ? 0.08 : 0.2, duration: 0 })} />
            {workflowMode && <CanvasOverview nodes={flowNodes} selectedId={selectedId} canvasRef={canvasRef} onNavigate={navigateOverview} busy={busy} />}
            {minimapOpen && (
              <MiniMap
                className="map-minimap"
                style={minimapSize}
                position="bottom-right"
                pannable
                ariaLabel="전체 지도 미리보기"
                nodeColor={(node) => node.data.category.fill}
                nodeStrokeColor={(node) => node.data.category.stroke}
                maskColor="rgba(239, 236, 225, 0.76)"
              />
            )}
            <button
              type="button"
              className={`canvas-dock-button minimap-dock-button nodrag nopan${minimapOpen ? ' is-open' : ''}`}
              style={minimapToggleStyle}
              aria-label={minimapOpen ? '미니맵 접기' : '미니맵 펼치기'}
              aria-expanded={minimapOpen}
              title={minimapOpen ? '미니맵 접기' : '미니맵 펼치기'}
              data-testid={minimapOpen ? 'minimap-collapse-button' : 'minimap-expand-button'}
              onClick={(event) => {
                event.stopPropagation();
                setMinimapOpen((open) => !open);
              }}
            >
              <Icon name={minimapOpen ? 'collapse' : 'map'} />
            </button>
            {(workflowMode ? workflowLegendOpen : legendOpen) ? (
              <div className="legend" aria-label="범례" data-testid="legend">
                <div className="legend__header">
                  <div className="legend__title">지도 구분</div>
                  <button
                    type="button"
                    className="overlay-collapse-button nodrag nopan"
                    aria-label="범례 접기"
                    aria-expanded="true"
                    title="범례 접기"
                    data-testid="legend-collapse-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      (workflowMode ? setWorkflowLegendOpen : setLegendOpen)(false);
                    }}
                  >
                    <Icon name="collapse" />
                  </button>
                </div>
                {snapshot.graph.categories.map((category) => (
                  <div className="legend__item" key={category.id}>
                    <span style={{ background: category.fill, borderColor: category.stroke }} aria-hidden="true" />
                    <div><strong>{category.label}</strong><small>{category.description}</small></div>
                  </div>
                ))}
              </div>
            ) : (
              <button
                type="button"
                className="canvas-dock-button legend-dock-button nodrag nopan"
                aria-label="범례 펼치기"
                aria-expanded="false"
                title="범례 펼치기"
                data-testid="legend-expand-button"
                onClick={(event) => {
                  event.stopPropagation();
                  (workflowMode ? setWorkflowLegendOpen : setLegendOpen)(true);
                }}
              >
                <Icon name="layers" />
              </button>
            )}
            <div className="canvas-guide" aria-label="빠른 입력 안내">
              <span><kbd>Enter</kbd> 같은 계위</span>
              <span><kbd>Tab</kbd> 하위 항목</span>
              <span><kbd>우클릭 드래그</kbd> 화면 이동</span>
            </div>
            </ReactFlow>
          </SelectionCountContext.Provider>
        </div>

        {referenceOpen && <MapReferences sections={sections} graph={snapshot.graph} editor={inlineEditor}
          busy={busy} onRestore={(id) => setReferenceSection(id, null)} onAdd={addReference}
          onReturn={(id) => { setReferenceOpen(false); setWorkflowMode(true); focusWorkflow(id); }}
          editingId={referenceEditingId} onEditingComplete={() => setReferenceEditingId(null)} />}
        {panelOpen && !referenceOpen && (
          <Inspector
            snapshot={snapshot}
            selected={selected}
            selectedNodes={selectedNodes}
            selectedCategory={selectedCategory}
            busy={busy}
            workflowMode={workflowMode}
            optionalFields={optionalFields}
            onClose={() => {
              setPanelOpen(false);
            }}
            onExecute={execute}
            onSelect={selectOnly}
            onToggleCollapse={toggleCollapse}
            onCopyKey={copyNodeKey}
            onUpdateNodeLayouts={updateNodeLayouts}
          />
        )}
      </section>

      {shortcutHelp && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setShortcutHelp(false)}>
          <section
            className="shortcut-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcut-title"
            data-testid="shortcut-dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button type="button" className="inspector__close" aria-label="단축키 닫기" onClick={() => setShortcutHelp(false)}><Icon name="close" /></button>
            <p className="eyebrow">빠른 편집</p>
            <h2 id="shortcut-title">키보드로 가지 다루기</h2>
            <dl>
              <div><dt>Enter</dt><dd>같은 계위에 새 항목을 만들고 바로 입력</dd></div>
              <div><dt>Tab</dt><dd>선택한 항목 아래에 새 항목을 만들고 바로 입력</dd></div>
              <div><dt>Shift + Tab</dt><dd>선택한 가지를 한 단계 바깥으로 이동</dd></div>
              <div><dt>⌘/Ctrl + C · X · V</dt><dd>가지 복사 · 옮길 준비 · 붙이기</dd></div>
              <div><dt>⌘/Ctrl + A</dt><dd>보이는 항목 모두 선택</dd></div>
              <div><dt>Delete · ⌫</dt><dd>선택한 가지와 그 하위 항목 삭제</dd></div>
              <div><dt>⌘/Ctrl + Z</dt><dd>마지막 편집 실행 취소</dd></div>
              <div><dt>⌘/Ctrl + Shift + Z</dt><dd>되돌린 편집 다시 실행</dd></div>
              <div><dt>⌘/Ctrl + + · − · 0</dt><dd>확대 · 축소 · 화면에 맞추기</dd></div>
              <div><dt>트랙패드 · 오른쪽 드래그</dt><dd>지도를 자유롭게 이동</dd></div>
            </dl>
            <p className="shortcut-dialog__note">먼저 지도에서 기준 항목을 선택하세요.</p>
          </section>
        </div>
      )}
    </main>
  );
}

function AutoGrowTextarea({ value, className = '', ...props }) {
  const textareaRef = useRef(null);
  useLayoutEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = '0px';
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight + 2}px`;
  }, [value]);
  return <textarea ref={textareaRef} rows={1} className={className} value={value} {...props} />;
}

function LayoutControls({ nodes, busy, onApply }) {
  const firstResolved = resolveNodeLayout(nodes[0]);
  const selectionKey = nodes.map((node) => `${node.id}:${JSON.stringify(node.layout || { mode: 'fit' })}`).join('|');
  const [mode, setMode] = useState(nodes[0]?.layout?.mode || 'fit');
  const [width, setWidth] = useState(firstResolved.width);
  const [height, setHeight] = useState(firstResolved.height);
  const mixed = nodes.some((node) => JSON.stringify(node.layout || { mode: 'fit' }) !== JSON.stringify(nodes[0]?.layout || { mode: 'fit' }));
  const dimensionsValid = mode === 'fit' || (
    Number.isFinite(width) && width >= 168 && width <= 720
    && (mode !== 'fixed' || (Number.isFinite(height) && height >= 72 && height <= 480))
  );

  useEffect(() => {
    const layout = resolveNodeLayout(nodes[0]);
    setMode(nodes[0]?.layout?.mode || 'fit');
    setWidth(layout.width);
    setHeight(layout.height);
  }, [selectionKey]);

  return (
    <section className="editor-section layout-editor" aria-labelledby="layout-title">
      <div className="section-heading">
        <h3 id="layout-title">카드 표시</h3>
        {mixed && <span>혼합됨</span>}
      </div>
      <div className="layout-modes" aria-label="카드 크기 방식">
        {[
          ['fit', '내용 맞춤', '내용에 따라 가로·세로가 늘어납니다.'],
          ['wrap', '너비 고정', '정한 너비에서 줄바꿈하고 높이는 늘어납니다.'],
          ['fixed', '크기 고정', '정한 크기를 우선하고 넘치는 글은 …로 줄입니다.'],
        ].map(([value, label, help]) => (
          <button
            type="button"
            key={value}
            className="layout-mode"
            aria-pressed={mode === value}
            data-testid={`layout-mode-${value}`}
            onClick={() => setMode(value)}
          >
            <strong>{label}</strong>
            <small>{help}</small>
          </button>
        ))}
      </div>
      {mode !== 'fit' && (
        <div className="dimension-grid">
          <label>
            <span>W</span>
            <input
              type="number"
              min="168"
              max="720"
              step="1"
              data-testid="layout-width"
              value={width}
              onChange={(event) => setWidth(Number(event.target.value))}
            />
          </label>
          <label className={mode === 'fixed' ? '' : 'is-disabled'}>
            <span>H</span>
            <input
              type="number"
              min="72"
              max="480"
              step="1"
              disabled={mode !== 'fixed'}
              data-testid="layout-height"
              value={height}
              onChange={(event) => setHeight(Number(event.target.value))}
            />
          </label>
        </div>
      )}
      <button
        type="button"
        className="full-button full-button--accent"
        data-testid="apply-layout"
        disabled={busy || !dimensionsValid}
        onClick={() => onApply(nodes.map((node) => node.id), { mode, width, height })}
      >
        {nodes.length > 1 ? `${nodes.length}개 카드에 적용` : '카드 표시에 적용'}
      </button>
      {nodes.length === 1 && <p className="field-help layout-editor__tip">선택한 카드의 테두리나 모서리를 끌면 바로 ‘크기 고정’으로 바뀝니다.</p>}
    </section>
  );
}

function Inspector({
  snapshot,
  selected,
  selectedNodes,
  selectedCategory,
  busy,
  workflowMode,
  optionalFields,
  onClose,
  onExecute,
  onSelect,
  onToggleCollapse,
  onCopyKey,
  onUpdateNodeLayouts,
}) {
  const [label, setLabel] = useState(selected?.label || '');
  const [childLabel, setChildLabel] = useState('');
  const [parentId, setParentId] = useState(selected?.parentId || '');
  const [categoryDraft, setCategoryDraft] = useState(selectedCategory || null);

  useEffect(() => {
    setLabel(selected?.label || '');
    setParentId(selected?.parentId || '');
    setCategoryDraft(selectedCategory || null);
  }, [selected, selectedCategory]);

  if (selectedNodes.length > 1) {
    return (
      <aside className="inspector" aria-label={`선택한 항목 ${selectedNodes.length}개 편집기`} data-testid="inspector">
        <button className="inspector__close" type="button" aria-label="편집기 닫기" data-testid="inspector-close" onClick={onClose}><Icon name="close" /></button>
        <p className="eyebrow">여러 항목 편집</p>
        <h2>{selectedNodes.length}개 카드 선택됨</h2>
        <p className="selection-summary">표시 방식을 한 번에 적용합니다. 카드 내용과 가지 구조는 그대로 유지됩니다.</p>
        {!workflowMode && <LayoutControls nodes={selectedNodes} busy={busy} onApply={onUpdateNodeLayouts} />}
      </aside>
    );
  }

  if (!selected) {
    return (
      <aside className="inspector inspector--empty" aria-label="항목 편집기" data-testid="inspector">
        <button className="inspector__close" type="button" aria-label="편집기 닫기" data-testid="inspector-close" onClick={onClose}><Icon name="close" /></button>
        <p className="eyebrow">편집</p>
        <h2>항목을 선택해 주세요</h2>
        <p>지도에서 항목을 누르면 이름, 위치와 표현을 바꿀 수 있습니다.</p>
      </aside>
    );
  }

  const blockedParents = descendantsOf(selected.id, snapshot.graph.nodes);
  blockedParents.add(selected.id);
  const parentChoices = snapshot.graph.nodes.filter((node) => !blockedParents.has(node.id));
  const childCount = snapshot.graph.nodes.filter((node) => node.parentId === selected.id).length;

  async function addChild(event) {
    event.preventDefault();
    const value = childLabel.trim();
    if (!value) return;
    const id = `node_${Date.now().toString(36)}`;
    const ok = await onExecute({
      type: 'addNode',
      id,
      parentId: selected.id,
      label: value,
      shape: selected.shape,
      category: selected.category,
    });
    if (ok) {
      setChildLabel('');
      onSelect(id);
    }
  }

  function saveCategory(nextCategory) {
    setCategoryDraft(nextCategory);
    onExecute({ type: 'upsertCategory', category: nextCategory });
  }

  return (
    <aside className="inspector" aria-label={`${selected.label} 편집기`} data-testid="inspector">
      <button className="inspector__close" type="button" aria-label="편집기 닫기" data-testid="inspector-close" onClick={onClose}><Icon name="close" /></button>
      <p className="eyebrow">선택한 항목</p>
      <h2>{selected.label}</h2>
      <div className="node-key-row">
        <code className="node-id">{selected.id}</code>
        <button
          type="button"
          className="node-key-copy"
          aria-label={`${selected.label} 키 복사`}
          title="AI 대화에 사용할 항목 키 복사"
          data-testid="inspector-copy-key"
          onClick={() => onCopyKey(selected.id)}
        >
          <Icon name="copy" />
          <span>키 복사</span>
        </button>
      </div>

      <form
        className="editor-section"
        onSubmit={(event) => {
          event.preventDefault();
          const value = label.trim();
          if (value && value !== selected.label) onExecute({ type: 'renameNode', id: selected.id, label: value });
        }}
      >
        <label htmlFor="node-label">이름</label>
        <div className="inline-field">
          <AutoGrowTextarea
            id="node-label"
            data-testid="rename-input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <button type="submit" disabled={busy || !label.trim() || label.trim() === selected.label}>저장</button>
        </div>
      </form>

      <div className="workflow-task-section">
        <TaskFields key={selected.id} node={selected} busy={busy} optionalFields={optionalFields}
          onSave={(task) => onExecute({ type: 'setNodeTask', id: selected.id, task })}
          onCancel={onClose} />
      </div>

      {optionalFields.includes('workflow') && <WorkflowSettings node={selected}
        children={splitMapSections(snapshot.graph).system.nodes.filter((node) => node.parentId === selected.id)}
        allChildren={snapshot.graph.nodes.filter((node) => node.parentId === selected.id)}
        busy={busy} onExecute={onExecute} onSelect={onSelect} />}

      <section className="editor-section" aria-labelledby="presentation-title">
        <h3 id="presentation-title">모양과 구분</h3>
        <div className="segmented" aria-label="항목 모양">
          {[
            ['rectangle', '직선'],
            ['rounded', '둥근'],
          ].map(([value, text]) => (
            <button
              type="button"
              key={value}
              aria-pressed={selected.shape === value}
              data-testid={`shape-${value}`}
              onClick={() => onExecute({ type: 'setNodePresentation', id: selected.id, shape: value, category: selected.category })}
            >{text}</button>
          ))}
        </div>
        <label htmlFor="node-category">범례 구분</label>
        <select
          id="node-category"
          data-testid="category-select"
          value={selected.category}
          onChange={(event) => onExecute({ type: 'setNodePresentation', id: selected.id, shape: selected.shape, category: event.target.value })}
        >
          {snapshot.graph.categories.map((category) => <option value={category.id} key={category.id}>{category.label}</option>)}
        </select>
      </section>

      {!workflowMode && <LayoutControls nodes={[selected]} busy={busy} onApply={onUpdateNodeLayouts} />}

      {categoryDraft && (
        <details className="category-editor">
          <summary>현재 범례 색상 다듬기</summary>
          <div className="palette-actions">
            <button
              type="button"
              data-testid="style-filled"
              onClick={() => saveCategory({ ...categoryDraft, fill: categoryDraft.stroke, textColor: '#FFFFFF', strokeWidth: 2 })}
            >채움</button>
            <button
              type="button"
              data-testid="style-outline"
              onClick={() => saveCategory({ ...categoryDraft, fill: '#FFFDF7', textColor: categoryDraft.stroke, strokeWidth: 2 })}
            >윤곽</button>
          </div>
          <div className="color-grid">
            <label>바탕<input aria-label="범례 바탕색" type="color" value={categoryDraft.fill} onChange={(event) => setCategoryDraft({ ...categoryDraft, fill: event.target.value.toUpperCase() })} /></label>
            <label>선<input aria-label="범례 선 색" type="color" value={categoryDraft.stroke} onChange={(event) => setCategoryDraft({ ...categoryDraft, stroke: event.target.value.toUpperCase() })} /></label>
            <label>글자<input aria-label="범례 글자색" type="color" value={categoryDraft.textColor} onChange={(event) => setCategoryDraft({ ...categoryDraft, textColor: event.target.value.toUpperCase() })} /></label>
          </div>
          <button type="button" className="full-button" data-testid="save-category" onClick={() => saveCategory(categoryDraft)}>범례 색상 저장</button>
        </details>
      )}

      {selected.parentId && (
        <section className="editor-section" aria-labelledby="parent-title">
          <h3 id="parent-title">상위 항목</h3>
          <p className="field-help">캔버스에서 움직이는 것과 별개로 가지의 소속을 바꿉니다.</p>
          <select aria-label="새 상위 항목" data-testid="parent-select" value={parentId} onChange={(event) => setParentId(event.target.value)}>
            {parentChoices.map((node) => <option value={node.id} key={node.id}>{node.label}</option>)}
          </select>
          <button
            type="button"
            className="full-button"
            data-testid="reparent-button"
            disabled={!parentId || parentId === selected.parentId || busy}
            onClick={() => onExecute({ type: 'moveNode', id: selected.id, parentId })}
          >이 상위 항목으로 옮기기</button>
        </section>
      )}

      <form className="editor-section add-child" onSubmit={addChild}>
        <h3>하위 항목 추가</h3>
        <input
          aria-label="새 하위 항목 이름"
          data-testid="new-child-input"
          placeholder="예: 전달 방식"
          value={childLabel}
          onChange={(event) => setChildLabel(event.target.value)}
        />
        <button type="submit" className="full-button full-button--accent" data-testid="add-child-button" disabled={!childLabel.trim() || busy}>
          <Icon name="plus" /> 추가하기
        </button>
      </form>

      {childCount > 0 && (
        <button className="fold-button" type="button" data-testid="inspector-toggle-collapse" onClick={() => onToggleCollapse(selected.id)}>
          {(workflowMode ? workflowCollapsedIds(snapshot.graph, snapshot.view) : snapshot.view?.collapsedIds || []).includes(selected.id) ? '하위 항목 펼치기' : `하위 항목 ${childCount}개 접기`}
        </button>
      )}
    </aside>
  );
}
