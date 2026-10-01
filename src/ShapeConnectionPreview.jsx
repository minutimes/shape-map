import { getSmoothStepPath, useNodes, useViewport } from '@xyflow/react';
import { shapeConnectionAtPoint } from './shapeEditing.js';

/** Use the same whole-card target for the visible preview and the saved connection. */
export default function ShapeConnectionPreview({ fromNode, fromX, fromY, fromPosition, pointer, toNode, toHandle, connectionStatus }) {
  const nodes = useNodes(); const camera = useViewport();
  // The SVG lives inside React Flow's transformed viewport. fromX/fromY are
  // already flow coordinates; only pointer is in canvas pixels.
  const world = { x: (pointer.x - camera.x) / camera.zoom, y: (pointer.y - camera.y) / camera.zoom };
  const target = shapeConnectionAtPoint(nodes, fromNode.id, { x: fromX, y: fromY }, world, 14 / camera.zoom,
    connectionStatus === 'valid' && toNode ? { target: toNode.id, targetHandle: toHandle?.id } : null);
  const end = target?.point || world;
  const padding = 4 / camera.zoom;
  const path = getSmoothStepPath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition,
    targetX: end.x, targetY: end.y, targetPosition: target?.port || 'left', borderRadius: 7 })[0];
  return <g className="sm-connection-preview">
    {target && <rect data-testid="connection-card-target" data-target-id={target.node.id} x={target.rect.x - padding} y={target.rect.y - padding} width={target.rect.width + padding * 2} height={target.rect.height + padding * 2} rx={7 / camera.zoom} vectorEffect="non-scaling-stroke" />}
    <path d={path} vectorEffect="non-scaling-stroke" /><circle cx={end.x} cy={end.y} r={3 / camera.zoom} />
  </g>;
}
