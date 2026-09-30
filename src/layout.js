import dagre from '@dagrejs/dagre';

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 88;
export const NODE_MIN_WIDTH = 168;
export const NODE_MAX_WIDTH = 720;
export const NODE_MIN_HEIGHT = 72;
export const NODE_MAX_HEIGHT = 480;
export const NODE_LAYOUT_MODES = new Set(['fit', 'wrap', 'fixed']);

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function weightedLabelLength(label = '') {
  return [...label].reduce((length, character) => (
    length + (/^[\u0000-\u00ff]$/.test(character) ? 0.58 : 1)
  ), 0);
}

export function resolveNodeLayout(node, saved = node?.layout || {}) {
  const mode = NODE_LAYOUT_MODES.has(saved?.mode) ? saved.mode : 'fit';
  const labelLength = weightedLabelLength(node?.label || '');
  const fittedWidth = clamp(Math.round(116 + labelLength * 7.2), NODE_WIDTH, 360);
  const width = mode === 'fit'
    ? fittedWidth
    : clamp(Number(saved?.width) || NODE_WIDTH, NODE_MIN_WIDTH, NODE_MAX_WIDTH);
  const lineCapacity = Math.max(7, Math.floor((width - 50) / 13.5));
  const lines = Math.max(1, Math.ceil(labelLength / lineCapacity));
  const contentHeight = clamp(62 + lines * 20, NODE_HEIGHT, NODE_MAX_HEIGHT);
  const height = mode === 'fixed'
    ? clamp(Number(saved?.height) || NODE_HEIGHT, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT)
    : contentHeight;
  return { mode, width, height };
}

export function descendantsOf(id, nodes) {
  const hidden = new Set();
  const queue = nodes.filter((node) => node.parentId === id).map((node) => node.id);
  while (queue.length) {
    const next = queue.shift();
    if (hidden.has(next)) continue;
    hidden.add(next);
    nodes.filter((node) => node.parentId === next).forEach((node) => queue.push(node.id));
  }
  return hidden;
}

export function hiddenNodeIds(nodes, collapsedIds) {
  const result = new Set();
  collapsedIds.forEach((id) => descendantsOf(id, nodes).forEach((child) => result.add(child)));
  return result;
}

function hierarchyDepths(nodes) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map();

  function depthOf(id, visiting = new Set()) {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    const node = nodesById.get(id);
    if (!node?.parentId || !nodesById.has(node.parentId)) {
      memo.set(id, 0);
      return 0;
    }
    const nextVisiting = new Set(visiting).add(id);
    const depth = depthOf(node.parentId, nextVisiting) + 1;
    memo.set(id, depth);
    return depth;
  }

  nodes.forEach((node) => depthOf(node.id));
  return memo;
}

function alignRanksToLeadingEdge(nodes, positions, direction, dimensionsById, ranksep) {
  const depths = hierarchyDepths(nodes);
  const ranks = new Map();
  nodes.forEach((node) => {
    const depth = depths.get(node.id) || 0;
    if (!ranks.has(depth)) ranks.set(depth, []);
    ranks.get(depth).push(node);
  });
  const orderedDepths = [...ranks.keys()].sort((left, right) => left - right);
  const result = Object.fromEntries(Object.entries(positions).map(([id, position]) => [id, { ...position }]));

  if (direction === 'LR' || direction === 'RL') {
    let cursor = 24;
    const depthsInCanvasOrder = direction === 'LR' ? orderedDepths : [...orderedDepths].reverse();
    depthsInCanvasOrder.forEach((depth) => {
      const rank = ranks.get(depth);
      const rankWidth = Math.max(...rank.map((node) => dimensionsById[node.id].width));
      rank.forEach((node) => {
        result[node.id].x = direction === 'LR'
          ? cursor
          : cursor + rankWidth - dimensionsById[node.id].width;
      });
      cursor += rankWidth + ranksep;
    });
    return result;
  }

  let cursor = 24;
  const depthsInCanvasOrder = direction === 'TB' ? orderedDepths : [...orderedDepths].reverse();
  depthsInCanvasOrder.forEach((depth) => {
    const rank = ranks.get(depth);
    const rankHeight = Math.max(...rank.map((node) => dimensionsById[node.id].height));
    rank.forEach((node) => {
      result[node.id].y = direction === 'TB'
        ? cursor
        : cursor + rankHeight - dimensionsById[node.id].height;
    });
    cursor += rankHeight + ranksep;
  });
  return result;
}

export function layoutPositions(nodes, direction = 'LR', { nodesep = 34, ranksep = 88, nodeLayouts = {} } = {}) {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: direction, nodesep, ranksep, marginx: 24, marginy: 24 });
  nodes.forEach((node) => graph.setNode(node.id, resolveNodeLayout(node, nodeLayouts[node.id])));
  nodes.forEach((node) => {
    if (node.parentId && graph.hasNode(node.parentId)) graph.setEdge(node.parentId, node.id);
  });
  dagre.layout(graph);
  const dimensionsById = Object.fromEntries(nodes.map((node) => [
    node.id,
    resolveNodeLayout(node, nodeLayouts[node.id]),
  ]));
  const dagrePositions = Object.fromEntries(
    nodes.map((node) => {
      const position = graph.node(node.id) || { x: 0, y: 0 };
      const dimensions = dimensionsById[node.id];
      return [node.id, { x: position.x - dimensions.width / 2, y: position.y - dimensions.height / 2 }];
    }),
  );
  return alignRanksToLeadingEdge(nodes, dagrePositions, direction, dimensionsById, ranksep);
}

function moveBranch(nodes, positions, rootId, axis, delta, visibleIds, includeHidden = false) {
  if (!delta) return;
  const moving = descendantsOf(rootId, nodes);
  moving.add(rootId);
  moving.forEach((id) => {
    if ((!includeHidden && !visibleIds.has(id)) || !positions[id]) return;
    positions[id][axis] += delta;
  });
}

function branchBounds(nodes, positions, rootId, axis, size, dimensions, visibleIds) {
  const ids = descendantsOf(rootId, nodes);
  ids.add(rootId);
  const visible = [...ids].filter((id) => visibleIds.has(id) && positions[id]);
  return {
    start: Math.min(...visible.map((id) => positions[id][axis])),
    end: Math.max(...visible.map((id) => positions[id][axis] + dimensions[id][size])),
  };
}

/**
 * Keeps a dragged subtree fixed and packs only its sibling subtrees around it.
 * This preserves the exact parent/descendant drag delta while preventing the
 * moved branch from covering its neighbors.
 */
export function reflowSiblingBranches(
  snapshot,
  projectedPositions,
  rootId,
  gap = 24,
  { compact = false, moveHidden = false } = {},
) {
  const nodes = snapshot?.graph?.nodes || [];
  const root = nodes.find((node) => node.id === rootId);
  if (!root || !projectedPositions[rootId]) {
    return { arranged: false, positions: projectedPositions };
  }

  const hidden = hiddenNodeIds(nodes, new Set(snapshot.view?.collapsedIds || []));
  const visibleIds = new Set(nodes
    .filter((node) => !hidden.has(node.id) && projectedPositions[node.id])
    .map((node) => node.id));
  const dimensions = Object.fromEntries(nodes.map((node) => [node.id, resolveNodeLayout(node)]));
  const direction = snapshot.graph?.direction || 'LR';
  const axis = direction === 'LR' || direction === 'RL' ? 'y' : 'x';
  const size = axis === 'y' ? 'height' : 'width';
  const positions = Object.fromEntries(Object.entries(projectedPositions).map(([id, position]) => [
    id,
    { ...position },
  ]));
  const siblings = nodes
    .filter((node) => visibleIds.has(node.id) && node.parentId === root.parentId)
    .sort((left, right) => positions[left.id][axis] - positions[right.id][axis]);
  const rootIndex = siblings.findIndex((node) => node.id === rootId);
  if (rootIndex < 0) return { arranged: false, positions };

  let nextBounds = branchBounds(nodes, positions, rootId, axis, size, dimensions, visibleIds);
  for (let index = rootIndex - 1; index >= 0; index -= 1) {
    const sibling = siblings[index];
    const bounds = branchBounds(nodes, positions, sibling.id, axis, size, dimensions, visibleIds);
    const requiredDelta = nextBounds.start - gap - bounds.end;
    const delta = compact ? requiredDelta : Math.min(0, requiredDelta);
    moveBranch(nodes, positions, sibling.id, axis, delta, visibleIds, moveHidden);
    nextBounds = branchBounds(nodes, positions, sibling.id, axis, size, dimensions, visibleIds);
  }

  let previousBounds = branchBounds(nodes, positions, rootId, axis, size, dimensions, visibleIds);
  for (let index = rootIndex + 1; index < siblings.length; index += 1) {
    const sibling = siblings[index];
    const bounds = branchBounds(nodes, positions, sibling.id, axis, size, dimensions, visibleIds);
    const requiredDelta = previousBounds.end + gap - bounds.start;
    const delta = compact ? requiredDelta : Math.max(0, requiredDelta);
    moveBranch(nodes, positions, sibling.id, axis, delta, visibleIds, moveHidden);
    previousBounds = branchBounds(nodes, positions, sibling.id, axis, size, dimensions, visibleIds);
  }

  const fixedIds = descendantsOf(rootId, nodes);
  fixedIds.add(rootId);
  const arranged = Object.keys(positions).some((id) => !fixedIds.has(id) && (
    positions[id].x !== projectedPositions[id]?.x
    || positions[id].y !== projectedPositions[id]?.y
  ));
  return { arranged, positions };
}

/**
 * Reconciles the footprint of one branch after its visibility changes. The
 * toggled card remains fixed, newly visible descendants are repaired only
 * when they overlap, and the resulting branch band is propagated through
 * every ancestor so lower branches make room as one unit.
 */
export function branchVisibilityPositions(
  snapshot,
  basePositions,
  rootId,
  collapsedIds,
  { compact = false } = {},
) {
  const nodes = snapshot?.graph?.nodes || [];
  const root = nodes.find((node) => node.id === rootId);
  if (!root || !basePositions[rootId]) {
    return { arranged: false, positions: basePositions };
  }

  const nextSnapshot = {
    ...snapshot,
    view: { ...snapshot.view, collapsedIds: [...collapsedIds] },
  };
  const positions = Object.fromEntries(Object.entries(basePositions).map(([id, position]) => [
    id,
    { ...position },
  ]));
  const collapsed = new Set(collapsedIds);
  const hidden = hiddenNodeIds(nodes, collapsed);
  const branchIds = descendantsOf(rootId, nodes);
  branchIds.add(rootId);
  const visibleBranchNodes = nodes.filter((node) => branchIds.has(node.id) && !hidden.has(node.id));
  let internalLayout = null;
  let compactDetachedBranch = false;
  if (!collapsed.has(rootId) && visibleBranchNodes.length > 1) {
    const missingPosition = visibleBranchNodes.some((node) => !positions[node.id]);
    const overlaps = !missingPosition
      && overlappingNodePairs(visibleBranchNodes, positions, collapsedIds).length > 0;
    const compactLayout = visibleLayoutPositions(
      visibleBranchNodes,
      collapsedIds,
      snapshot.graph?.direction || 'LR',
    );
    const direction = snapshot.graph?.direction || 'LR';
    const secondaryAxis = direction === 'LR' || direction === 'RL' ? 'y' : 'x';
    const secondarySize = secondaryAxis === 'y' ? 'height' : 'width';
    const spanOf = (candidatePositions) => {
      const extents = visibleBranchNodes
        .filter((node) => candidatePositions[node.id])
        .map((node) => ({
          start: candidatePositions[node.id][secondaryAxis],
          end: candidatePositions[node.id][secondaryAxis]
            + resolveNodeLayout(node)[secondarySize],
        }));
      if (!extents.length) return 0;
      return Math.max(...extents.map(({ end }) => end))
        - Math.min(...extents.map(({ start }) => start));
    };
    const currentSpan = spanOf(positions);
    const compactSpan = spanOf(compactLayout);
    const excessiveSlack = !missingPosition
      && compactSpan > 0
      && currentSpan - compactSpan > 160
      && currentSpan > compactSpan * 1.75;
    if (missingPosition || overlaps || excessiveSlack) internalLayout = compactLayout;
    compactDetachedBranch = excessiveSlack;
  }

  if (internalLayout) {
    const arranged = internalLayout;
    const direction = snapshot.graph?.direction || 'LR';
    const secondaryAxis = direction === 'LR' || direction === 'RL' ? 'y' : 'x';
    const anchorDelta = positions[rootId][secondaryAxis] - arranged[rootId][secondaryAxis];
    const secondaryDeltas = new Map();
    visibleBranchNodes.forEach((node) => {
      if (!arranged[node.id]) return;
      const previous = positions[node.id] || arranged[node.id];
      const nextSecondary = arranged[node.id][secondaryAxis] + anchorDelta;
      secondaryDeltas.set(node.id, nextSecondary - previous[secondaryAxis]);
      positions[node.id] = {
        ...previous,
        [secondaryAxis]: nextSecondary,
      };
    });
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    nodes.filter((node) => branchIds.has(node.id) && hidden.has(node.id)).forEach((node) => {
      if (!positions[node.id]) return;
      let anchor = nodesById.get(node.parentId);
      while (anchor && hidden.has(anchor.id)) anchor = nodesById.get(anchor.parentId);
      const delta = secondaryDeltas.get(anchor?.id) || 0;
      positions[node.id][secondaryAxis] += delta;
    });
  }

  let preview = reflowSiblingBranches(
    nextSnapshot,
    positions,
    rootId,
    24,
    { compact: compact || compactDetachedBranch, moveHidden: true },
  );
  let ancestor = nodes.find((node) => node.id === root.parentId);
  while (ancestor?.parentId) {
    const packed = reflowSiblingBranches(
      nextSnapshot,
      preview.positions,
      ancestor.id,
      24,
      { compact: compact || compactDetachedBranch, moveHidden: true },
    );
    preview = {
      arranged: preview.arranged || packed.arranged,
      positions: packed.positions,
    };
    ancestor = nodes.find((node) => node.id === ancestor.parentId);
  }

  const arranged = Object.keys(preview.positions).some((id) => (
    preview.positions[id].x !== basePositions[id]?.x
    || preview.positions[id].y !== basePositions[id]?.y
  ));
  return { arranged, positions: preview.positions };
}

/**
 * Creates a coherent global expand/collapse layout. Hidden descendants follow
 * their nearest visible ancestor so reopening one branch later never reveals
 * a subtree stranded at its pre-collapse coordinates.
 */
export function allBranchVisibilityPositions(snapshot, basePositions, collapsedIds) {
  const nodes = snapshot?.graph?.nodes || [];
  const direction = snapshot?.graph?.direction || 'LR';
  const fallback = layoutPositions(nodes, direction);
  const sourcePositions = Object.fromEntries(nodes.map((node) => [
    node.id,
    { ...(basePositions[node.id] || fallback[node.id]) },
  ]));
  const arrangedVisible = visibleLayoutPositions(nodes, collapsedIds, direction);
  const hidden = hiddenNodeIds(nodes, new Set(collapsedIds));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const positions = { ...sourcePositions };

  nodes.forEach((node) => {
    if (!hidden.has(node.id) && arrangedVisible[node.id]) {
      positions[node.id] = { ...arrangedVisible[node.id] };
      return;
    }
    if (!hidden.has(node.id)) return;
    let anchor = nodesById.get(node.parentId);
    while (anchor && hidden.has(anchor.id)) anchor = nodesById.get(anchor.parentId);
    if (!anchor || !arrangedVisible[anchor.id]) return;
    const anchorSource = sourcePositions[anchor.id];
    positions[node.id] = {
      x: sourcePositions[node.id].x + arrangedVisible[anchor.id].x - anchorSource.x,
      y: sourcePositions[node.id].y + arrangedVisible[anchor.id].y - anchorSource.y,
    };
  });

  return positions;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** Places a reparented subtree in its new hierarchy rank before sibling packing. */
export function reparentBranchPositions(snapshot, basePositions, rootId) {
  const nodes = snapshot?.graph?.nodes || [];
  const root = nodes.find((node) => node.id === rootId);
  const parent = nodes.find((node) => node.id === root?.parentId);
  if (!root || !parent || !basePositions[rootId] || !basePositions[parent.id]) {
    return { arranged: false, positions: basePositions };
  }

  const hidden = hiddenNodeIds(nodes, new Set(snapshot.view?.collapsedIds || []));
  const visibleNodes = nodes.filter((node) => !hidden.has(node.id) && basePositions[node.id]);
  const depths = hierarchyDepths(nodes);
  const rootDepth = depths.get(rootId) || 0;
  const movingIds = descendantsOf(rootId, nodes);
  movingIds.add(rootId);
  const rankPeers = visibleNodes.filter((node) => (
    !movingIds.has(node.id) && (depths.get(node.id) || 0) === rootDepth
  ));
  const dimensions = Object.fromEntries(nodes.map((node) => [node.id, resolveNodeLayout(node)]));
  const direction = snapshot.graph?.direction || 'LR';
  const target = { ...basePositions[rootId] };

  if (direction === 'LR') {
    target.x = rankPeers.length
      ? median(rankPeers.map((node) => basePositions[node.id].x))
      : basePositions[parent.id].x + dimensions[parent.id].width + 88;
    target.y = basePositions[parent.id].y;
  } else if (direction === 'RL') {
    target.x = rankPeers.length
      ? median(rankPeers.map((node) => basePositions[node.id].x + dimensions[node.id].width))
        - dimensions[rootId].width
      : basePositions[parent.id].x - 88 - dimensions[rootId].width;
    target.y = basePositions[parent.id].y;
  } else if (direction === 'TB') {
    target.y = rankPeers.length
      ? median(rankPeers.map((node) => basePositions[node.id].y))
      : basePositions[parent.id].y + dimensions[parent.id].height + 88;
    target.x = basePositions[parent.id].x;
  } else {
    target.y = rankPeers.length
      ? median(rankPeers.map((node) => basePositions[node.id].y + dimensions[node.id].height))
        - dimensions[rootId].height
      : basePositions[parent.id].y - 88 - dimensions[rootId].height;
    target.x = basePositions[parent.id].x;
  }

  const delta = {
    x: target.x - basePositions[rootId].x,
    y: target.y - basePositions[rootId].y,
  };
  const projected = Object.fromEntries(Object.entries(basePositions).map(([id, position]) => [
    id,
    { ...position },
  ]));
  movingIds.forEach((id) => {
    if (!projected[id]) return;
    projected[id].x += delta.x;
    projected[id].y += delta.y;
  });
  let preview = reflowSiblingBranches(snapshot, projected, rootId);
  let ancestor = parent;
  while (ancestor?.parentId) {
    const packed = reflowSiblingBranches(snapshot, preview.positions, ancestor.id);
    preview = {
      arranged: preview.arranged || packed.arranged,
      positions: packed.positions,
    };
    ancestor = nodes.find((node) => node.id === ancestor.parentId);
  }
  return preview;
}

/**
 * Places several independently selected branches beneath their new parents
 * without resetting unrelated branches. Source canvas order is kept stable so
 * a multi-card reparent feels like one move and produces one view-history step.
 */
export function reparentBranchesPositions(snapshot, basePositions, rootIds) {
  const nodes = snapshot?.graph?.nodes || [];
  const direction = snapshot?.graph?.direction || 'LR';
  const secondaryAxis = direction === 'LR' || direction === 'RL' ? 'y' : 'x';
  const orderedRoots = [...new Set(rootIds)]
    .filter((id) => nodes.some((node) => node.id === id) && basePositions[id])
    .sort((left, right) => (
      basePositions[left][secondaryAxis] - basePositions[right][secondaryAxis]
      || nodes.findIndex((node) => node.id === left) - nodes.findIndex((node) => node.id === right)
    ));
  let positions = Object.fromEntries(Object.entries(basePositions).map(([id, position]) => [
    id,
    { ...position },
  ]));
  let arranged = false;
  orderedRoots.forEach((id) => {
    const preview = reparentBranchPositions(snapshot, positions, id);
    positions = preview.positions;
    arranged = arranged || preview.arranged;
  });
  return { arranged, positions };
}

/**
 * Produces a stable live-resize preview from the positions at pointer-down.
 * The selected card follows the pointer, deeper ranks move only by the changed
 * rank boundary, and adjacent sibling branches make room without a full Dagre
 * re-layout.
 */
export function resizeReflowPositions(snapshot, basePositions, id, nextLayout, anchor) {
  const nodes = snapshot?.graph?.nodes || [];
  const selected = nodes.find((node) => node.id === id);
  if (!selected || !basePositions[id]) {
    return { arranged: false, positions: { ...basePositions, [id]: anchor } };
  }

  const hidden = hiddenNodeIds(nodes, new Set(snapshot.view?.collapsedIds || []));
  const visibleNodes = nodes.filter((node) => !hidden.has(node.id) && basePositions[node.id]);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const depths = hierarchyDepths(nodes);
  const selectedDepth = depths.get(id) || 0;
  const baseDimensions = Object.fromEntries(nodes.map((node) => [node.id, resolveNodeLayout(node)]));
  const nextDimensions = { ...baseDimensions, [id]: resolveNodeLayout(selected, nextLayout) };
  const positions = Object.fromEntries(Object.entries(basePositions).map(([nodeId, position]) => [
    nodeId,
    { ...position },
  ]));
  positions[id] = { ...anchor };
  const sameRank = visibleNodes.filter((node) => (depths.get(node.id) || 0) === selectedDepth);
  const direction = snapshot.graph?.direction || 'LR';

  if (direction === 'LR') {
    const beforeEdge = Math.max(...sameRank.map((node) => (
      basePositions[node.id].x + baseDimensions[node.id].width
    )));
    const nextEdge = Math.max(...sameRank.map((node) => (
      positions[node.id].x + nextDimensions[node.id].width
    )));
    const delta = nextEdge - beforeEdge;
    visibleNodes.forEach((node) => {
      if ((depths.get(node.id) || 0) > selectedDepth) positions[node.id].x += delta;
    });
  } else if (direction === 'RL') {
    const beforeEdge = Math.min(...sameRank.map((node) => basePositions[node.id].x));
    const nextEdge = Math.min(...sameRank.map((node) => positions[node.id].x));
    const delta = nextEdge - beforeEdge;
    visibleNodes.forEach((node) => {
      if ((depths.get(node.id) || 0) > selectedDepth) positions[node.id].x += delta;
    });
  } else if (direction === 'TB') {
    const beforeEdge = Math.max(...sameRank.map((node) => (
      basePositions[node.id].y + baseDimensions[node.id].height
    )));
    const nextEdge = Math.max(...sameRank.map((node) => (
      positions[node.id].y + nextDimensions[node.id].height
    )));
    const delta = nextEdge - beforeEdge;
    visibleNodes.forEach((node) => {
      if ((depths.get(node.id) || 0) > selectedDepth) positions[node.id].y += delta;
    });
  } else {
    const beforeEdge = Math.min(...sameRank.map((node) => basePositions[node.id].y));
    const nextEdge = Math.min(...sameRank.map((node) => positions[node.id].y));
    const delta = nextEdge - beforeEdge;
    visibleNodes.forEach((node) => {
      if ((depths.get(node.id) || 0) > selectedDepth) positions[node.id].y += delta;
    });
  }

  const secondaryAxis = direction === 'LR' || direction === 'RL' ? 'y' : 'x';
  const secondarySize = secondaryAxis === 'y' ? 'height' : 'width';
  const siblings = visibleNodes
    .filter((node) => node.parentId === selected.parentId)
    .sort((left, right) => basePositions[left.id][secondaryAxis] - basePositions[right.id][secondaryAxis]);
  const selectedIndex = siblings.findIndex((node) => node.id === id);

  if (selectedIndex >= 0) {
    let previous = selected;
    for (let index = selectedIndex + 1; index < siblings.length; index += 1) {
      const sibling = siblings[index];
      const baseGap = Math.max(0,
        basePositions[sibling.id][secondaryAxis]
        - basePositions[previous.id][secondaryAxis]
        - baseDimensions[previous.id][secondarySize]);
      const required = positions[previous.id][secondaryAxis]
        + nextDimensions[previous.id][secondarySize]
        + baseGap;
      const delta = Math.max(0, required - positions[sibling.id][secondaryAxis]);
      moveBranch(nodes, positions, sibling.id, secondaryAxis, delta, visibleIds);
      previous = sibling;
    }

    let next = selected;
    for (let index = selectedIndex - 1; index >= 0; index -= 1) {
      const sibling = siblings[index];
      const baseGap = Math.max(0,
        basePositions[next.id][secondaryAxis]
        - basePositions[sibling.id][secondaryAxis]
        - baseDimensions[sibling.id][secondarySize]);
      const availableEnd = positions[next.id][secondaryAxis] - baseGap;
      const siblingEnd = positions[sibling.id][secondaryAxis] + nextDimensions[sibling.id][secondarySize];
      const delta = Math.min(0, availableEnd - siblingEnd);
      moveBranch(nodes, positions, sibling.id, secondaryAxis, delta, visibleIds);
      next = sibling;
    }
  }

  const arranged = Object.keys(positions).some((nodeId) => nodeId !== id && (
    positions[nodeId].x !== basePositions[nodeId]?.x
    || positions[nodeId].y !== basePositions[nodeId]?.y
  ));
  return { arranged, positions };
}

/**
 * Repairs positions written by the previous center-aligned rank layout. The
 * signature is intentionally narrow: at least one rank must share a center
 * line while its leading edges differ. Secondary-axis positions are preserved.
 */
export function centeredRankRepairPositions(nodes, positions, collapsedIds = [], direction = 'LR') {
  const hidden = hiddenNodeIds(nodes, new Set(collapsedIds));
  const visibleNodes = nodes.filter((node) => !hidden.has(node.id) && positions[node.id]);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const depths = hierarchyDepths(nodes);
  const dimensions = Object.fromEntries(nodes.map((node) => [node.id, resolveNodeLayout(node)]));
  const ranks = new Map();
  visibleNodes.forEach((node) => {
    const depth = depths.get(node.id) || 0;
    if (!ranks.has(depth)) ranks.set(depth, []);
    ranks.get(depth).push(node);
  });

  const horizontal = direction === 'LR' || direction === 'RL';
  const axis = horizontal ? 'x' : 'y';
  const size = horizontal ? 'width' : 'height';
  const repairedRanks = new Set();
  const result = Object.fromEntries(Object.entries(positions).map(([id, position]) => [id, { ...position }]));

  ranks.forEach((rank, depth) => {
    if (rank.length < 2) return;
    const centers = rank.map((node) => positions[node.id][axis] + dimensions[node.id][size] / 2);
    const edges = rank.map((node) => positions[node.id][axis]);
    if (Math.max(...centers) - Math.min(...centers) > 1
      || Math.max(...edges) - Math.min(...edges) <= 1) return;
    repairedRanks.add(depth);
    if (direction === 'LR' || direction === 'TB') {
      const leadingEdge = Math.max(...edges);
      rank.forEach((node) => { result[node.id][axis] = leadingEdge; });
    } else {
      const trailingEdge = Math.max(...rank.map((node) => (
        positions[node.id][axis] + dimensions[node.id][size]
      )));
      rank.forEach((node) => {
        result[node.id][axis] = trailingEdge - dimensions[node.id][size];
      });
    }
  });

  if (!repairedRanks.size) return null;

  const orderedDepths = [...ranks.keys()].sort((left, right) => left - right);
  for (let index = 1; index < orderedDepths.length; index += 1) {
    const previousRank = ranks.get(orderedDepths[index - 1]);
    const rank = ranks.get(orderedDepths[index]);
    let delta = 0;
    if (direction === 'LR' || direction === 'TB') {
      const previousEnd = Math.max(...previousRank.map((node) => (
        result[node.id][axis] + dimensions[node.id][size]
      )));
      const rankStart = Math.min(...rank.map((node) => result[node.id][axis]));
      delta = Math.max(0, previousEnd + 88 - rankStart);
    } else {
      const previousStart = Math.min(...previousRank.map((node) => result[node.id][axis]));
      const rankEnd = Math.max(...rank.map((node) => (
        result[node.id][axis] + dimensions[node.id][size]
      )));
      delta = Math.min(0, previousStart - 88 - rankEnd);
    }
    if (!delta) continue;
    rank.forEach((node) => { result[node.id][axis] += delta; });
  }

  return Object.fromEntries(Object.entries(result)
    .filter(([id]) => visibleIds.has(id))
    .filter(([id, position]) => (
      position.x !== positions[id].x || position.y !== positions[id].y
    )));
}

function collides(position, dimensions, occupied) {
  const horizontalGap = 30;
  const verticalGap = 24;
  return occupied.some(({ position: other, dimensions: otherDimensions }) => (
    position.x < other.x + otherDimensions.width + horizontalGap
    && position.x + dimensions.width + horizontalGap > other.x
    && position.y < other.y + otherDimensions.height + verticalGap
    && position.y + dimensions.height + verticalGap > other.y
  ));
}

function openChildSlot(parentPosition, parentDimensions, dimensions, occupied) {
  const start = {
    x: parentPosition.x + parentDimensions.width + 88,
    y: parentPosition.y,
  };
  if (!collides(start, dimensions, occupied)) return start;
  const step = dimensions.height + 34;
  for (let slot = 1; slot < 500; slot += 1) {
    const offset = Math.ceil(slot / 2) * step * (slot % 2 ? 1 : -1);
    const candidate = { x: start.x, y: start.y + offset };
    if (!collides(candidate, dimensions, occupied)) return candidate;
  }
  return { x: start.x, y: start.y + occupied.length * step };
}

export function visibleLayoutPositions(nodes, collapsedIds, direction = 'LR', nodeLayouts = {}) {
  const hidden = hiddenNodeIds(nodes, new Set(collapsedIds));
  const visibleNodes = nodes.filter((node) => !hidden.has(node.id));
  return layoutPositions(visibleNodes, direction, {
    nodesep: visibleNodes.length <= 12 ? 18 : 30,
    ranksep: 88,
    nodeLayouts,
  });
}

export function overlappingNodePairs(nodes, positions, collapsedIds = [], nodeLayouts = {}) {
  const hidden = hiddenNodeIds(nodes, new Set(collapsedIds));
  const visible = nodes.filter((node) => !hidden.has(node.id) && positions[node.id]);
  const pairs = [];
  for (let left = 0; left < visible.length; left += 1) {
    for (let right = left + 1; right < visible.length; right += 1) {
      const a = visible[left];
      const b = visible[right];
      const aPosition = positions[a.id];
      const bPosition = positions[b.id];
      const aSize = resolveNodeLayout(a, nodeLayouts[a.id]);
      const bSize = resolveNodeLayout(b, nodeLayouts[b.id]);
      if (
        aPosition.x < bPosition.x + bSize.width
        && aPosition.x + aSize.width > bPosition.x
        && aPosition.y < bPosition.y + bSize.height
        && aPosition.y + aSize.height > bPosition.y
      ) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}

export function mergeSnapshotPositions(incoming, current, hasPreviousSnapshot) {
  const nodes = incoming.graph.nodes;
  const allFallback = layoutPositions(nodes, incoming.graph.direction);
  const visibleFallback = visibleLayoutPositions(
    nodes,
    incoming.view?.collapsedIds || [],
    incoming.graph.direction,
    {},
  );
  const preservedFor = (id) => incoming.view?.positions?.[id] || current[id];
  const hasPreservedPositions = nodes.some((node) => preservedFor(node.id));

  if (!hasPreviousSnapshot && !hasPreservedPositions) {
    return Object.fromEntries(nodes.map((node) => [
      node.id,
      visibleFallback[node.id] || allFallback[node.id],
    ]));
  }

  const merged = {};
  const occupied = [];
  nodes.forEach((node) => {
    const preserved = preservedFor(node.id);
    if (!preserved) return;
    merged[node.id] = preserved;
    occupied.push({
      position: preserved,
      dimensions: resolveNodeLayout(node),
    });
  });

  nodes.forEach((node) => {
    if (merged[node.id]) return;
    const parentPosition = merged[node.parentId]
      || visibleFallback[node.parentId]
      || allFallback[node.parentId]
      || visibleFallback[node.id]
      || allFallback[node.id];
    const parent = nodes.find((candidate) => candidate.id === node.parentId) || node;
    const dimensions = resolveNodeLayout(node);
    merged[node.id] = openChildSlot(
      parentPosition,
      resolveNodeLayout(parent),
      dimensions,
      occupied,
    );
    occupied.push({ position: merged[node.id], dimensions });
  });
  return merged;
}
