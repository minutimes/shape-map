import { getSmoothStepPath, useNodes, useViewport } from '@xyflow/react';
import { shapeConnectionTarget, targetShapePort, shapePortPoint, connectionPort } from './shapeEditing.js';

/** Use the same whole-card target for the visible preview and the saved connection. */
export default function ShapeConnectionPreview({ fromNode, fromX, fromY, fromPosition, toX, toY, pointer, toNode, toHandle, connectionStatus }) {
  const nodes = useNodes(); const camera = useViewport();
  const world = (point) => ({ x: (point.x - camera.x) / camera.zoom, y: (point.y - camera.y) / camera.zoom });
  const target = shapeConnectionTarget(nodes, fromNode.id, world(pointer), 14 / camera.zoom);
  const port = target && targetShapePort(target.rect, world({ x: fromX, y: fromY }), world(pointer),
    connectionStatus === 'valid' && toNode?.id === target.node.id ? connectionPort(toHandle.id) : null, 14 / camera.zoom);
  const point = target && shapePortPoint(target.rect, port);
  const end = point ? { x: point.x * camera.zoom + camera.x, y: point.y * camera.zoom + camera.y } : { x: toX, y: toY };
  const path = getSmoothStepPath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition,
    targetX: end.x, targetY: end.y, targetPosition: port || 'left', borderRadius: 7 })[0];
  return <g className="sm-connection-preview">
    {target && <rect data-testid="connection-card-target" data-target-id={target.node.id} x={target.rect.x * camera.zoom + camera.x - 4} y={target.rect.y * camera.zoom + camera.y - 4} width={target.rect.width * camera.zoom + 8} height={target.rect.height * camera.zoom + 8} rx="7" />}
    <path d={path} /><circle cx={end.x} cy={end.y} r="3" />
  </g>;
}
