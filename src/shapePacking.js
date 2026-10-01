export function shapeCardTitle(node, depth) {
  if (!depth || node.label.length <= 28) return node.label;
  return node.label.split(/\s+[·—]\s+/)[0];
}

function titleLines(text, width, fontSize) {
  // Leave room for word wrapping as well as full-width Korean characters.
  const units = Array.from(text || '').reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 1 : .58), 0);
  return Math.max(1, Math.ceil(units * fontSize / Math.max(80, width - 16)));
}

function rows(sizes, limit, gap) {
  let x = 0; let y = 0; let rowHeight = 0; let width = 0;
  const slots = sizes.map((size) => {
    if (x && x + size.width > limit + 1) { y += rowHeight + gap; x = 0; rowHeight = 0; }
    const slot = { x, y };
    x += size.width + gap; rowHeight = Math.max(rowHeight, size.height);
    width = Math.max(width, x - gap);
    return slot;
  });
  return { slots, width, height: y + rowHeight };
}

/** Ordered, two-dimensional packing. A deep branch grows its container instead
 * of squeezing every descendant into a progressively narrower vertical list. */
export function measureShapeCard(node, children, collapsed, depth = 0, compact = false) {
  const all = children.get(node.id) || [];
  const items = collapsed.has(node.id) ? [] : all;
  const inset = depth ? 12 : 18;
  const gap = depth ? 12 : 18;
  const tileWidth = compact ? 288 : 220;
  const group = all.length > 0;
  if (!items.length) {
    const width = depth ? tileWidth : compact ? 340 : 340;
    const titleHeight = Math.min(depth ? 2 : Infinity, titleLines(shapeCardTitle(node, depth), width - 28, depth ? 14 : 18)) * (depth ? 20 : 24);
    const header = (depth ? 32 : 44) + titleHeight;
    return { width, height: header + 6, header, group, items: [], sizes: [], slots: [] };
  }
  const sizes = items.map((child) => measureShapeCard(child, children, collapsed, depth + 1, compact));
  const widest = Math.max(...sizes.map((size) => size.width));
  const area = sizes.reduce((sum, size) => sum + size.width * size.height, 0);
  const tiles = sizes.every((size) => !size.items.length);
  const sequence = node.workflow?.mode === 'sequence';
  let limit;
  if (compact) limit = widest;
  else if (sequence && !tiles) limit = sizes.reduce((sum, size) => sum + size.width + gap, -gap);
  else if (tiles) {
    const columns = Math.min(depth ? 4 : 2, Math.ceil(Math.sqrt(sizes.length * 1.3)));
    limit = columns * widest + (columns - 1) * gap;
  } else {
    const broadest = [...sizes].sort((a, b) => b.width - a.width);
    // A fixed width cap must not force two large sub-systems back into one
    // vertical column. Reserve room for the two broadest children together.
    const pair = broadest[0].width + (broadest[1] ? broadest[1].width + gap : 0);
    limit = Math.max(pair, Math.min(depth ? 1100 : 1600, Math.sqrt(area * 2.2)));
  }
  const packed = rows(sizes, limit, gap);
  const width = Math.max(compact && !depth ? 340 : 0, packed.width + inset * 2);
  const titleHeight = titleLines(shapeCardTitle(node, depth), width - inset * 2, depth ? 14 : 18) * (depth ? 20 : 24);
  const description = !depth && Boolean(node.block?.summary || node.task?.logic);
  const header = (depth ? 40 : 46) + titleHeight + (description ? 30 : 0);
  return { width, height: header + packed.height + inset * 2, header, group: true,
    items, sizes, slots: packed.slots.map((slot) => ({ x: slot.x + inset, y: slot.y + header + inset })), description };
}
