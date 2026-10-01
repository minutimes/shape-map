import { memo } from 'react';
import { useViewport, useStore } from '@xyflow/react';
import { ShapeIcon } from './ShapeNode.jsx';

/** Only the largest visible sections get screen-sized titles, like a canvas section. */
export default memo(function ShapeSectionTitles({ nodes, onSelect, onFocus }) {
  const camera = useViewport(); const width = useStore((state) => state.width); const height = useStore((state) => state.height);
  if (camera.zoom >= .72) return null;
  const placed = [];
  return <div className="sm-section-titles" aria-label="현재 계위의 큰 섹션 제목">{nodes.filter((node) => !node.parentId).map((node) => {
    const x = node.position.x * camera.zoom + camera.x; const y = node.position.y * camera.zoom + camera.y;
    const end = x + node.style.width * camera.zoom;
    if (end < 0 || x > width || y > height || y + node.style.height * camera.zoom < 0) return null;
    const left = Math.max(8, x); const available = Math.min(430, width - left - 8, Math.max(150, end - left));
    let top = Math.max(54, y - 31);
    while (placed.some((item) => left < item.x + item.width + 8 && left + available + 8 > item.x && Math.abs(top - item.y) < 29)) top += 29;
    if (top > height - 58) return null;
    placed.push({ x: left, y: top, width: available });
    return <button key={node.id} className="sm-section-title-label nodrag nopan" style={{ left, top, maxWidth: available }} title={node.data.node.label} onClick={() => onSelect(node.id)} onDoubleClick={() => onFocus(node.id)}><ShapeIcon name={node.type === 'shapeGroup' ? 'grid' : 'box'} size={13} /><span>{node.data.node.label}</span></button>;
  })}</div>;
});
