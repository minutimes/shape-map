const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

/** Screen-space placement; selection never resizes or moves the diagram. */
export function shapeInspectorPosition(anchor, stage, panel = {}) {
  const margin = 12; const gap = 18;
  const width = Math.min(panel.width || 390, Math.max(0, stage.width - margin * 2));
  const height = Math.min(panel.height || 640, Math.max(0, stage.height - margin * 2));
  if (!anchor || stage.width < 560) return { x: margin, y: stage.height - height - margin, width, height, side: 'sheet', leader: null };
  const rightSpace = stage.width - anchor.x - anchor.width;
  const leftSpace = anchor.x;
  const side = rightSpace >= width + gap ? 'right' : leftSpace >= width + gap ? 'left' : rightSpace >= leftSpace ? 'right' : 'left';
  const x = clamp(side === 'right' ? anchor.x + anchor.width + gap : anchor.x - width - gap, margin, stage.width - width - margin);
  const y = clamp(anchor.y - 12, margin, stage.height - height - margin);
  const anchorX = clamp(side === 'right' ? anchor.x + anchor.width : anchor.x, margin, stage.width - margin);
  const anchorY = clamp(anchor.y + Math.min(anchor.height / 2, 48), margin, stage.height - margin);
  const panelX = side === 'right' ? x : x + width;
  const panelY = clamp(anchorY, y + 20, y + height - 20);
  return { x, y, width, height, side, leader: { from: { x: anchorX, y: anchorY }, to: { x: panelX, y: panelY } } };
}
