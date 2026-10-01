import { placementReferences } from '../lib/placement.mjs';

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

/** Saved positions are preferences, not permission for siblings to overlap.
 * Resolve collisions in reading order without changing the saved coordinates,
 * so folding or undo restores the original arrangement. */
export function settleShapeSlots(sizes, desired, { gap = 12, columnGap = gap, rowGap = gap, ids = [], anchors = {}, minimum } = {}) {
  const placed = []; const slots = []; const byId = new Map(ids.map((id, index) => [id, index])); const visiting = new Set();
  const settle = (index) => {
    if (slots[index] || visiting.has(index)) return;
    visiting.add(index);
    const anchor = anchors[ids[index]];
    placementReferences(anchor).forEach((id) => { if (byId.has(id)) settle(byId.get(id)); });
    const position = { ...desired[index] }; const size = sizes[index];
    const x = anchor?.x && byId.get(anchor.x.id); const xSlot = slots[x];
    if (xSlot) position.x = xSlot.x + (anchor.x.edge === 'right' ? sizes[x].width : 0) + anchor.x.offset;
    const yRefs = (anchor?.y?.ids || []).map((id) => byId.get(id)).filter((ref) => slots[ref]);
    if (yRefs.length) position.y = Math.max(...yRefs.map((ref) => slots[ref].y + (anchor.y.edge === 'bottom' ? sizes[ref].height : 0))) + anchor.y.offset;
    if (minimum) { position.x = Math.max(minimum.x, position.x); position.y = Math.max(minimum.y, position.y); }
    const slot = { ...position };
    for (let step = 0; step < placed.length; step += 1) {
      const obstacle = placed.find((rect) => position.x < rect.x + rect.width + gap && position.x + size.width + gap > rect.x
        && position.y < rect.y + rect.height + gap && position.y + size.height + gap > rect.y);
      if (!obstacle) break;
      if (Math.abs(slot.y - obstacle.desired.y) <= gap && slot.x > obstacle.desired.x) position.x = obstacle.x + obstacle.width + columnGap;
      else position.y = obstacle.y + obstacle.height + rowGap;
    }
    placed.push({ ...position, width: size.width, height: size.height, desired: slot });
    slots[index] = position; visiting.delete(index);
  };
  desired.forEach((_, index) => settle(index));
  return slots;
}

/** Ordered, two-dimensional packing. A deep branch grows its container instead
 * of squeezing every descendant into a progressively narrower vertical list. */
export function measureShapeCard(node, children, collapsed, depth = 0, compact = false, custom = {}) {
  const all = children.get(node.id) || [];
  const items = collapsed.has(node.id) ? [] : all;
  const inset = depth ? 12 : 18;
  const gap = depth ? 12 : 18;
  const tileWidth = compact ? 288 : 220;
  const group = all.length > 0 || Boolean(node.workflow);
  if (!items.length) {
    const emptySection = group && !all.length;
    // A folded section is a compact card. Its authored open size remains saved
    // and is restored on expansion instead of leaving a large empty rectangle.
    const requested = all.length && collapsed.has(node.id) ? {} : custom.sizes?.[node.id];
    const width = Math.max(depth ? tileWidth : 340, emptySection ? 480 : 0, requested?.width || 0);
    const titleHeight = Math.min(depth ? 2 : Infinity, titleLines(shapeCardTitle(node, depth), width - 28, depth ? 14 : 18)) * (depth ? 20 : 24);
    const header = (depth ? 32 : 44) + titleHeight;
    return { width, height: Math.max(header + 6, emptySection ? 240 : 0, requested?.height || 0), minimumWidth: Math.max(depth ? tileWidth : 340, emptySection ? 480 : 0), minimumHeight: Math.max(header + 6, emptySection ? 240 : 0), header, group, items: [], sizes: [], slots: [] };
  }
  const sizes = items.map((child) => measureShapeCard(child, children, collapsed, depth + 1, compact, custom));
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
  let width = Math.max(compact && !depth ? 340 : 0, packed.width + inset * 2, custom.sizes?.[node.id]?.width || 0);
  const titleHeight = titleLines(shapeCardTitle(node, depth), width - inset * 2, depth ? 14 : 18) * (depth ? 20 : 24);
  const description = !depth && Boolean(node.block?.summary || node.task?.logic);
  const header = (depth ? 40 : 46) + titleHeight + (description ? 30 : 0);
  const desired = packed.slots.map((slot, index) => {
    const saved = custom.positions?.[items[index].id];
    return { x: Math.max(inset, saved?.x ?? slot.x + inset), y: Math.max(header + inset, saved?.y ?? slot.y + header + inset) };
  });
  const slots = settleShapeSlots(sizes, desired, { gap, ids: items.map((item) => item.id), anchors: custom.anchors, minimum: { x: inset, y: header + inset } });
  width = Math.max(width, ...slots.map((slot, index) => slot.x + sizes[index].width + inset));
  const height = Math.max(header + packed.height + inset * 2, custom.sizes?.[node.id]?.height || 0, ...slots.map((slot, index) => slot.y + sizes[index].height + inset));
  const minimumWidth = Math.max(packed.width + inset * 2, ...slots.map((slot, index) => slot.x + sizes[index].width + inset));
  const minimumHeight = Math.max(header + packed.height + inset * 2, ...slots.map((slot, index) => slot.y + sizes[index].height + inset));
  return { width, height, minimumWidth, minimumHeight, header, group: true, items, sizes, slots, description };
}
