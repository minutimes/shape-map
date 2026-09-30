export const OVERVIEW_ZOOM = 0.65;

const LABEL_HEIGHT = 32;
const MIN_LABEL_WIDTH = 140;
const MAX_LABEL_WIDTH = 240;
const SAFE_INSET = 8;
const LABEL_GAP = 6;
const CARD_LABEL_GAP = 8;
const MAX_LABELS = 80;

const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);

function finiteNumber(...values) {
  return values.find((value) => Number.isFinite(value));
}

function textWidth(label) {
  // Count wide scripts (including Hangul) at their approximate rendered width.
  const units = Array.from(label).reduce((total, character) => (
    total + (/[^\u0000-\u00ff]/u.test(character) ? 2 : 1)
  ), 0);
  return clamp(Math.ceil(24 + units * 7), MIN_LABEL_WIDTH, MAX_LABEL_WIDTH);
}

function overlapsWithGap(left, right, gap = LABEL_GAP) {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y;
}

function candidatePositions(card, labelWidth, canvasWidth, canvasHeight) {
  const maxX = Math.max(SAFE_INSET, canvasWidth - SAFE_INSET - labelWidth);
  const anchorX = clamp(card.x, SAFE_INSET, maxX);
  const centeredX = clamp(card.x + (card.width - labelWidth) / 2, SAFE_INSET, maxX);
  const rightX = clamp(card.x + card.width - labelWidth, SAFE_INSET, maxX);
  const rawAboveY = card.y - LABEL_HEIGHT - CARD_LABEL_GAP;
  const belowY = card.y + card.height + CARD_LABEL_GAP;
  const maxY = canvasHeight - SAFE_INSET - LABEL_HEIGHT;
  const aboveY = clamp(rawAboveY, SAFE_INSET, maxY);
  const candidates = [];
  const seen = new Set();
  const add = (x, y) => {
    const position = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
    const key = `${position.x}:${position.y}`;
    if (!seen.has(key)) { seen.add(key); candidates.push(position); }
  };

  // Keep the label attached to the card whenever the preferred slot is free.
  [anchorX, centeredX, rightX].forEach((x) => add(x, aboveY));
  if (belowY <= maxY) [anchorX, centeredX, rightX].forEach((x) => add(x, belowY));
  return candidates;
}

function readablePath(node, sourceById) {
  if (Array.isArray(node.data?.path)) return node.data.path.map(String).join(' › ');
  if (node.data?.path != null) return String(node.data.path);
  const labels = [];
  const visited = new Set();
  let current = node;
  while (current && !visited.has(String(current.id))) {
    visited.add(String(current.id));
    labels.unshift(String(current.data?.label ?? current.label ?? current.id ?? ''));
    const parentId = current.data?.parentId ?? current.parentId;
    current = parentId == null ? null : sourceById.get(String(parentId));
  }
  return labels.join(' › ');
}

/**
 * Return fixed-size screen-space labels for a zoomed-out React Flow canvas.
 * The function is pure: node geometry and data are only read, never normalized in place.
 */
export function layoutOverviewLabels(
  nodes,
  viewport,
  bounds,
  { selectedId = null, hoveredId = null, excludeRects = [] } = {},
) {
  const zoom = finiteNumber(viewport?.zoom, 1);
  const canvasWidth = finiteNumber(bounds?.width, 0);
  const canvasHeight = finiteNumber(bounds?.height, 0);
  if (!Array.isArray(nodes) || zoom >= OVERVIEW_ZOOM || zoom <= 0 || canvasWidth <= 0 || canvasHeight <= 0) return [];

  const viewportX = finiteNumber(viewport?.x, 0);
  const viewportY = finiteNumber(viewport?.y, 0);
  const sourceById = new Map(nodes.map((node) => [String(node.id), node]));
  const exclusions = Array.isArray(excludeRects) ? excludeRects.flatMap((rect) => {
    const x = finiteNumber(rect?.x);
    const y = finiteNumber(rect?.y);
    const width = finiteNumber(rect?.width);
    const height = finiteNumber(rect?.height);
    return Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0
      ? [{ x, y, width, height }]
      : [];
  }) : [];
  const visible = nodes.flatMap((node) => {
    const position = node?.position || {};
    const sourceWidth = finiteNumber(node?.width, node?.measured?.width, node?.style?.width, 360);
    const sourceHeight = finiteNumber(node?.height, node?.measured?.height, node?.style?.height, 88);
    const card = {
      x: viewportX + finiteNumber(position.x, 0) * zoom,
      y: viewportY + finiteNumber(position.y, 0) * zoom,
      width: Math.max(0, sourceWidth * zoom),
      height: Math.max(0, sourceHeight * zoom),
    };
    if (card.x >= canvasWidth || card.y >= canvasHeight || card.x + card.width <= 0 || card.y + card.height <= 0) return [];
    const data = node?.data || {};
    const label = String(data.label ?? node?.label ?? node?.id ?? '');
    return [{
      id: String(node.id), label, card,
      depth: finiteNumber(data.depth, 0),
      parentId: data.parentId ?? node.parentId ?? null,
      childCount: finiteNumber(data.childCount, 0),
      path: readablePath(node, sourceById),
    }];
  });

  const visibleIds = new Set(visible.map(({ id }) => id));
  const visibleAncestorIds = new Set();
  const byId = new Map(visible.map((node) => [node.id, node]));
  for (const node of visible) {
    const visited = new Set();
    let parentId = node.parentId;
    while (parentId != null && visibleIds.has(String(parentId)) && !visited.has(String(parentId))) {
      parentId = String(parentId);
      visited.add(parentId);
      visibleAncestorIds.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
  }

  visible.sort((left, right) => {
    const selectedOrder = Number(right.id === String(selectedId)) - Number(left.id === String(selectedId));
    if (selectedOrder) return selectedOrder;
    const hoveredOrder = Number(right.id === String(hoveredId)) - Number(left.id === String(hoveredId));
    if (hoveredOrder) return hoveredOrder;
    const ancestorOrder = Number(visibleAncestorIds.has(right.id)) - Number(visibleAncestorIds.has(left.id));
    if (ancestorOrder) return ancestorOrder;
    const branchOrder = Number(right.childCount > 0) - Number(left.childCount > 0);
    if (branchOrder) return branchOrder;
    if (left.depth !== right.depth) return left.depth - right.depth;
    return left.id.localeCompare(right.id, 'en');
  });

  const placed = [];
  for (const node of visible) {
    if (placed.length >= MAX_LABELS) break;
    const width = textWidth(node.label);
    if (canvasWidth < SAFE_INSET * 2 + width || canvasHeight < SAFE_INSET * 2 + LABEL_HEIGHT) continue;
    const position = candidatePositions(node.card, width, canvasWidth, canvasHeight)
      .find((candidate) => {
        const rectangle = { ...candidate, width, height: LABEL_HEIGHT };
        return !exclusions.some((excluded) => overlapsWithGap(rectangle, excluded, 0))
          && !placed.some((label) => overlapsWithGap(rectangle, label));
      });
    if (!position) continue;
    const label = {
      id: node.id,
      label: node.label,
      ...position,
      width,
      height: LABEL_HEIGHT,
      depth: node.depth,
      childCount: node.childCount,
    };
    if (node.path) label.path = node.path;
    placed.push(label);
  }
  return placed;
}
