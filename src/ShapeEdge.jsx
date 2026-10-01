import { memo } from 'react';
import { BaseEdge, getSmoothStepPath } from '@xyflow/react';
import { roundedShapePath } from './shapeRouting.js';

export const ShapeConnection = memo(function ShapeConnection(props) {
  const { id, style, markerEnd, markerStart, data, interactionWidth, label } = props;
  const route = data?.route;
  const path = route ? roundedShapePath(route.points) : getSmoothStepPath(props)[0];
  const text = route?.label;
  return <g><title>{data?.link?.label || label}</title>
    <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} markerStart={markerStart} interactionWidth={interactionWidth} />
    {text && <g className="sm-connection-label" transform={`translate(${text.x},${text.y})`} style={{ opacity: style?.opacity }} aria-label={label}>
      <rect x={-text.width / 2} y={-text.height / 2} width={text.width} height={text.height} rx="4" />
      <text textAnchor="middle">{text.lines.map((line, index) => <tspan key={index} x="0" y={(index - (text.lines.length - 1) / 2) * 15 + 4}>{line}</tspan>)}</text>
    </g>}
  </g>;
});
