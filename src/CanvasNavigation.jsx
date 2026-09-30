import { memo, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ControlButton, Controls, useStore } from '@xyflow/react';
import { layoutOverviewLabels, OVERVIEW_ZOOM } from './overviewLabels.js';
import './canvasNavigation.css';

export const CanvasZoomControls = memo(function CanvasZoomControls({ onZoomIn, onZoomOut, onZoomTo, onFit }) {
  const zoom = useStore((state) => state.transform[2]);
  return <Controls showZoom={false} showFitView={false} showInteractive={false} position="bottom-left" aria-label="지도 확대와 축소">
    <ControlButton onClick={() => onZoomIn()} aria-label="지도 확대" title="확대"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></ControlButton>
    <ControlButton className="canvas-zoom-value" onClick={() => onZoomTo(1)} aria-label={`현재 ${Math.round(zoom * 100)}%, 100%로 보기`} title="100%로 보기">{Math.round(zoom * 100)}%</ControlButton>
    <ControlButton onClick={() => onZoomOut()} aria-label="지도 축소" title="축소"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg></ControlButton>
    <ControlButton onClick={onFit} aria-label="지도 화면에 맞추기" title="화면에 맞추기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5" /></svg></ControlButton>
  </Controls>;
});

/** Screen-space titles subscribe to camera changes without re-rendering the graph. */
export default memo(function CanvasOverview({ nodes, selectedId, canvasRef, onNavigate, busy }) {
  const transform = useStore((state) => state.transform);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const [hoveredId, setHoveredId] = useState(null);
  const [focusedId, setFocusedId] = useState(null);
  const [excludeRects, setExcludeRects] = useState([]);
  const overview = transform[2] < OVERVIEW_ZOOM;

  useEffect(() => {
    if (!overview) { setHoveredId(null); setFocusedId(null); }
  }, [overview]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !overview) return undefined;
    const hover = (event) => {
      const item = event.target.closest?.('[data-overview-id], .react-flow__node[data-id]');
      setHoveredId(item?.dataset.overviewId || item?.dataset.id || null);
    };
    const leave = () => setHoveredId(null);
    canvas.addEventListener('pointerover', hover);
    canvas.addEventListener('pointerleave', leave);
    return () => { canvas.removeEventListener('pointerover', hover); canvas.removeEventListener('pointerleave', leave); };
  }, [canvasRef, overview]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !overview) { setExcludeRects([]); return undefined; }
    let frame;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const origin = canvas.getBoundingClientRect();
        const next = [...canvas.querySelectorAll('.react-flow__controls, .react-flow__minimap, .canvas-dock-button, .legend')]
          .filter((element) => element.getClientRects().length)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { x: rect.left - origin.left - 6, y: rect.top - origin.top - 6, width: rect.width + 12, height: rect.height + 12 };
          });
        canvas.querySelectorAll('.react-flow__minimap, .legend, .canvas-dock-button').forEach((element) => resize.observe(element));
        setExcludeRects((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      });
    };
    const resize = new ResizeObserver(update);
    resize.observe(canvas);
    const changes = new MutationObserver(update);
    // Observe only navigation surfaces; camera transforms must not schedule DOM measurements.
    const flow = canvas.querySelector('.react-flow');
    if (flow) changes.observe(flow, { childList: true });
    canvas.querySelectorAll('.react-flow__minimap, .legend, .canvas-dock-button').forEach((element) => resize.observe(element));
    update();
    return () => { resize.disconnect(); changes.disconnect(); cancelAnimationFrame(frame); };
  }, [canvasRef, overview, width, height]);

  const labels = useMemo(() => layoutOverviewLabels(nodes,
    { x: transform[0], y: transform[1], zoom: transform[2] }, { width, height },
    { selectedId: focusedId || selectedId, hoveredId, excludeRects }),
  [nodes, transform, width, height, focusedId, selectedId, hoveredId, excludeRects]);

  if (!overview) return null;
  const tooltipWidth = Math.max(120, Math.min(340, width - 24));
  return <div className="canvas-overview" data-testid="canvas-overview" aria-label="축소한 지도의 제목">
    {labels.map((item) => <button key={item.id} type="button" className={`overview-label nodrag nopan${item.id === selectedId ? ' is-selected' : ''}`}
      data-overview-id={item.id} data-testid={`overview-label-${item.id}`} disabled={busy}
      data-tooltip-above={height - item.y - item.height < 140 && item.y > height - item.y - item.height || undefined}
      style={{ left: item.x, top: item.y, width: item.width, height: item.height,
        '--overview-tooltip-width': `${tooltipWidth}px`,
        '--overview-tooltip-left': `${Math.min(0, width - item.x - tooltipWidth - 12)}px`,
        '--overview-tooltip-height': `${Math.max(80, Math.min(280, height - item.y - item.height < 140 ? Math.max(item.y - 20, height - item.y - item.height - 20) : height - item.y - item.height - 20))}px` }}
      aria-label={`${item.label} 확대해서 보기`} aria-describedby={`overview-description-${item.id}`}
      onFocus={() => setFocusedId(item.id)} onBlur={() => setFocusedId(null)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
      onClick={(event) => { event.stopPropagation(); onNavigate(item.id); }}>
      <span className="overview-label__text">{item.label}</span>
      {item.childCount > 0 && <span className="overview-label__count" aria-hidden="true">{item.childCount}</span>}
      <span className="overview-label__tooltip nowheel" id={`overview-description-${item.id}`} role="tooltip"><span>{item.path || item.label}</span></span>
    </button>)}
  </div>;
});
