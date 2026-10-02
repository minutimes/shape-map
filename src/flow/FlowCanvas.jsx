import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, ConnectionMode, ReactFlow, useReactFlow, useViewport } from '@xyflow/react';
import { useCenteredZoom } from '../useCenteredZoom.js';
import { SHARED_BAND_ID } from './flowConstants.js';
import { FLOW_METRICS } from './flowLayout.js';
import { FlowArrow, LaneAdd, StepCard } from './FlowElements.jsx';
import FlowIcon from './FlowIcon.jsx';

const nodeTypes = { step: StepCard, laneAdd: LaneAdd };
const edgeTypes = { flow: FlowArrow };
export const MIN_ZOOM = .08;
export const MAX_ZOOM = 2;
const FIT_PADDING = 28;

/** Fits the whole map, never above 100%, from the top and centered across. */
export function fitViewport(bounds, width, height) {
  if (!bounds || !width || !height) return { x: FIT_PADDING, y: FIT_PADDING, zoom: 1 };
  const zoom = Math.max(MIN_ZOOM, Math.min(1, (width - FIT_PADDING * 2) / bounds.width, (height - FIT_PADDING * 2) / bounds.height));
  const x = Math.max(FIT_PADDING, (width - bounds.width * zoom) / 2) - bounds.x * zoom;
  const y = FIT_PADDING - bounds.y * zoom;
  return { x: Math.round(x), y: Math.round(y), zoom };
}

function BandLayer({ layout, emphasis }) {
  const { y, zoom } = useViewport();
  return <div className="fm-bands" aria-hidden="true">
    {layout.bands.map((band) => <div key={band.id} className={`fm-band${band.index % 2 ? ' is-odd' : ''}${band.id === SHARED_BAND_ID ? ' is-shared' : ''}${emphasis?.lanes && band.laneId ? ` is-${emphasis.lanes.get(band.laneId)}` : ''}`}
      style={{ top: y + band.y * zoom, height: band.height * zoom }} />)}
  </div>;
}

function LaneRail({ layout, graph, words, tagsById, selectedLane, focusLane, emphasis, editable, onSelectLane, onFocusLane, onAddLane }) {
  const { y, zoom } = useViewport();
  const railRef = useRef(null);
  const [railHeight, setRailHeight] = useState(800);
  useEffect(() => {
    const element = railRef.current; if (!element) return undefined;
    const observer = new ResizeObserver(() => setRailHeight(element.clientHeight));
    observer.observe(element); setRailHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);
  const laneById = new Map(graph.lanes.map((lane) => [lane.id, lane]));
  return <nav className="fm-rail" ref={railRef} aria-label={words.lanes}>
    {layout.bands.map((band) => {
      const top = y + band.y * zoom; const height = band.height * zoom;
      if (top > railHeight || top + height < 0) return null;
      const lane = band.laneId ? laneById.get(band.laneId) : null;
      const compact = height < 58;
      const inner = compact ? 0 : Math.max(6, Math.min(-top + 8, height - 58));
      const key = band.laneId ?? SHARED_BAND_ID;
      const title = lane?.title ?? words.shared;
      const state = emphasis?.lanes && band.laneId ? emphasis.lanes.get(band.laneId) : null;
      return <div key={band.id} className={`fm-rail__band${band.index % 2 ? ' is-odd' : ''}${compact ? ' is-compact' : ''}${height < 11 ? ' is-tiny' : ''}${selectedLane === key ? ' is-selected' : ''}${state ? ` is-${state}` : ''}`}
        style={{ top, height, '--fm-compact-size': `${Math.max(8, Math.min(11, height * .62))}px` }} data-testid={`fm-lane-${key}`}>
        <div className="fm-rail__inner" style={{ transform: `translateY(${inner}px)` }}>
          {lane ? <button type="button" className="fm-rail__title" title={lane.title} aria-pressed={selectedLane === key} onClick={() => onSelectLane(lane.id)}>{lane.title}</button>
            : <span className="fm-rail__title is-shared" title={words.sharedHint}>{title}</span>}
          {!compact && <span className="fm-rail__meta">
            {(lane?.tags || []).slice(0, 3).map((id) => tagsById.get(id) && <i key={id} title={tagsById.get(id).label} style={{ background: tagsById.get(id).stroke }} />)}
            <span>단계 {band.stepCount}</span>
            <button type="button" className={`fm-rail__focus${focusLane === key ? ' is-on' : ''}`} aria-pressed={focusLane === key}
              aria-label={words.laneOnly(title)} title={words.laneFocus} onClick={() => onFocusLane(focusLane === key ? null : key)}>
              <FlowIcon name="eye" size={13} />
            </button>
          </span>}
        </div>
      </div>;
    })}
    {editable && <button type="button" className="fm-rail__add" onClick={onAddLane}><FlowIcon name="plus" size={13} />{words.laneAdd}</button>}
  </nav>;
}

function ZoomControls({ canvasRef, onFit }) {
  const { zoom } = useViewport();
  const { zoomIn, zoomOut, zoomTo } = useCenteredZoom({ canvasRef, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM });
  return <div className="fm-zoom" role="group" aria-label="확대와 축소">
    <button type="button" onClick={() => zoomOut()} aria-label="축소"><FlowIcon name="minus" size={14} /></button>
    <button type="button" className="fm-zoom__value" onClick={() => zoomTo(1)} title="실제 크기로 보기" aria-label={`지금 ${Math.round(zoom * 100)}%, 실제 크기로 보기`}>{Math.round(zoom * 100)}%</button>
    <button type="button" onClick={() => zoomIn()} aria-label="확대"><FlowIcon name="plus" size={14} /></button>
    <button type="button" onClick={onFit} aria-label="지도 전체 보기" title="전체 보기"><FlowIcon name="fit" size={14} /></button>
  </div>;
}

export default function FlowCanvas({ graph, layout, words, emphasis, selection, focusLane, editable, revealId, onSelect, onConnect, onAddNext, onInsert, onAddInLane, onSelectLane, onFocusLane, onAddLane }) {
  const canvasRef = useRef(null);
  const flow = useReactFlow();
  const fitted = useRef(false);
  const tagsById = useMemo(() => new Map(graph.tags.map((tag) => [tag.id, tag])), [graph.tags]);
  const selectedStep = selection?.kind === 'step' ? selection.id : null;
  const selectedArrow = selection?.kind === 'arrow' ? selection.id : null;
  const columns = layout.orientation === 'columns';
  const showRail = !columns && graph.lanes.length > 0;

  const nodes = useMemo(() => {
    const bandOrder = new Map(layout.bands.map((band, index) => [band.id, index]));
    const cards = [...layout.cards].sort((a, b) => bandOrder.get(a.band) - bandOrder.get(b.band) || a.rank - b.rank || a.row - b.row);
    const result = cards.map((card) => ({
      id: card.id, type: 'step', position: { x: card.x, y: card.y }, width: card.width, height: card.height,
      selected: card.id === selectedStep, draggable: false, connectable: editable, ariaLabel: `${card.step.label} 단계`,
      data: { step: card.step, card, point: FLOW_METRICS.decisionPoint, editable, columns, emphasis: emphasis?.steps.get(card.id) ?? null,
        tags: (card.step.tags || []).map((id) => tagsById.get(id)).filter(Boolean), onAddNext },
    }));
    if (editable) for (const band of layout.bands) if (!band.stepCount) {
      const first = layout.ranks[0]?.start ?? 40;
      result.push({ id: `__add-${band.id}`, type: 'laneAdd', width: 136, height: 34, draggable: false, selectable: false, connectable: false, focusable: false,
        position: columns ? { x: band.x + band.width / 2 - 68, y: first } : { x: first, y: band.y + band.height / 2 - 17 },
        data: { laneId: band.laneId, text: '첫 단계 추가', onAdd: onAddInLane } });
    }
    return result;
  }, [layout, selectedStep, editable, emphasis, tagsById, onAddNext, onAddInLane, columns]);

  const labelOf = useMemo(() => new Map(graph.steps.map((step) => [step.id, step.label])), [graph.steps]);
  const edges = useMemo(() => layout.arrows.map((arrow) => ({
    id: arrow.key, type: 'flow', source: arrow.source, target: arrow.target, sourceHandle: 'out', targetHandle: 'in',
    selected: arrow.key === selectedArrow, focusable: true, interactionWidth: 0,
    ariaLabel: `화살표: ${labelOf.get(arrow.source)}에서 ${labelOf.get(arrow.target)}${arrow.label ? `, ${arrow.label}` : ''}`,
    zIndex: arrow.key === selectedArrow ? 2 : arrow.style === 'exchange' ? 1 : 0,
    data: { arrow, editable, emphasis: emphasis?.arrows.get(arrow.key) ?? null, onSelect: (key) => onSelect({ kind: 'arrow', id: key }), onInsert },
  })), [layout.arrows, selectedArrow, emphasis, editable, labelOf, onSelect, onInsert]);

  const fit = useCallback((duration = 0) => {
    const element = canvasRef.current; if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    flow.setViewport(fitViewport(layout.bounds, width, height), { duration });
  }, [flow, layout.bounds]);

  useEffect(() => {
    if (fitted.current) return undefined;
    const frame = requestAnimationFrame(() => { fit(0); fitted.current = true; });
    return () => cancelAnimationFrame(frame);
  }, [fit]);

  // Keep a newly added or chosen step in view without changing the zoom.
  useEffect(() => {
    if (!revealId?.id || !fitted.current) return;
    const card = layout.cards.find((item) => item.id === revealId.id);
    const element = canvasRef.current;
    if (!card || !element) return;
    const { width, height } = element.getBoundingClientRect();
    const { x, y, zoom } = flow.getViewport();
    const left = card.x * zoom + x; const top = card.y * zoom + y;
    if (left >= 16 && top >= 16 && left + card.width * zoom <= width - 16 && top + card.height * zoom <= height - 16) return;
    flow.setCenter(card.x + card.width / 2, card.y + card.height / 2, { zoom, duration: 220 });
  }, [revealId, layout, flow]);

  const onNodesChange = useCallback((changes) => {
    for (const change of changes) if (change.type === 'select' && change.selected && !change.id.startsWith('__')) onSelect({ kind: 'step', id: change.id });
  }, [onSelect]);
  const onEdgesChange = useCallback((changes) => {
    for (const change of changes) if (change.type === 'select' && change.selected) onSelect({ kind: 'arrow', id: change.id });
  }, [onSelect]);
  const handleConnect = useCallback((connection) => { if (connection.source && connection.target) onConnect(connection.source, connection.target); }, [onConnect]);
  const handleConnectEnd = useCallback((event, state) => {
    if (state?.isValid || !state?.fromNode) return;
    const point = event.changedTouches?.[0] || event;
    const target = document.elementFromPoint(point.clientX, point.clientY)?.closest?.('[data-step-id]')?.getAttribute('data-step-id');
    if (target && target !== state.fromNode.id) onConnect(state.fromNode.id, target);
  }, [onConnect]);

  return <div className={`fm-stage${showRail ? ' has-rail' : ''}`}>
    {showRail && <LaneRail layout={layout} graph={graph} words={words} tagsById={tagsById} selectedLane={selection?.kind === 'lane' ? selection.id : null} focusLane={focusLane}
      emphasis={emphasis} editable={editable} onSelectLane={onSelectLane} onFocusLane={onFocusLane} onAddLane={onAddLane} />}
    <div className={`fm-canvas${columns ? ' is-columns' : ''}`} ref={canvasRef} data-testid="fm-canvas">
      {showRail && <BandLayer layout={layout} emphasis={emphasis} />}
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onPaneClick={() => onSelect(null)} onConnect={handleConnect} onConnectEnd={handleConnectEnd}
        nodesDraggable={false} nodesConnectable={editable} elementsSelectable nodesFocusable edgesFocusable
        minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} panOnScroll zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} zoomActivationKeyCode={null}
        panOnDrag selectionOnDrag={false} selectionKeyCode={null} multiSelectionKeyCode={null} deleteKeyCode={null}
        connectionMode={ConnectionMode.Strict} connectionRadius={34} connectionLineStyle={{ stroke: '#28282c', strokeWidth: 1.5, strokeDasharray: '4 4' }}
        onlyRenderVisibleElements={layout.cards.length > 160} colorMode="light" defaultViewport={{ x: 0, y: 0, zoom: .5 }}>
        {!showRail && <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d7d7dc" />}
      </ReactFlow>
      <ZoomControls canvasRef={canvasRef} onFit={() => fit(180)} />
    </div>
  </div>;
}
