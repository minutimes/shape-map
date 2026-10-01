import { useLayoutEffect, useRef, useState } from 'react';
import { useViewport } from '@xyflow/react';
import { absoluteShapePosition } from './shapeLayout.js';
import { shapeInspectorPosition } from './shapeInspectorPosition.js';

export default function ShapeInspectorAnchor({ nodes, selectedId, anchorId = selectedId, canvasRef, children }) {
  const viewport = useViewport();
  const frameRef = useRef(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0, canvasTop: 0 });
  useLayoutEffect(() => {
    const stage = frameRef.current?.parentElement; const canvas = canvasRef.current;
    if (!stage || !canvas) return undefined;
    const update = () => {
      const rect = stage.getBoundingClientRect(); const map = canvas.getBoundingClientRect();
      setBounds({ width: rect.width, height: rect.height, canvasTop: map.top - rect.top });
    };
    const observer = new ResizeObserver(update); observer.observe(stage); observer.observe(canvas); update();
    return () => observer.disconnect();
  }, [canvasRef]);
  const node = nodes.find((item) => item.id === anchorId);
  const point = node && absoluteShapePosition(nodes, anchorId);
  const anchor = node && { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y + bounds.canvasTop,
    width: node.style.width * viewport.zoom, height: (node.data.headerHeight || node.style.height) * viewport.zoom };
  const placement = shapeInspectorPosition(anchor, bounds);
  return <div ref={frameRef} className="sm-inspector-anchor" data-anchor-id={selectedId} data-placement={placement.side}>
    {placement.leader && <svg className="sm-inspector-leader" aria-hidden="true"><path d={`M${placement.leader.from.x},${placement.leader.from.y} L${placement.leader.to.x},${placement.leader.to.y}`} /><circle cx={placement.leader.from.x} cy={placement.leader.from.y} r="3" /></svg>}
    <div className="sm-inspector-popup" style={{ left: placement.x, top: placement.y, width: placement.width, height: placement.height }}>{children}</div>
  </div>;
}
