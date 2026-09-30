import { workflowCardHeight, WORKFLOW_CARD_WIDTH } from './workflowCardMetrics.js';
import { mapOptionalFields, splitMapSections } from './mapScope.js';

export { WORKFLOW_CARD_WIDTH };
const COLUMN_GAP = 132;
const SIBLING_GAP = 54;

export function compactWorkflowViewport(width, position = { x: 0, y: 0 }) {
  // Hidden browser panels can briefly report 0–1px during a resize.
  const usableWidth = Number.isFinite(width) && width >= 240 ? width : 390;
  const zoom = Math.min(.9, (usableWidth - 36) / WORKFLOW_CARD_WIDTH);
  return { x: 18 - position.x * zoom, y: 40 - position.y * zoom, zoom };
}

export function workflowCollapsedIds(graph, view) {
  if (Array.isArray(view?.workflow?.collapsedIds)) return view.workflow.collapsedIds;
  const parents = new Set(graph.nodes.map((node) => node.parentId).filter(Boolean));
  return graph.nodes.filter((node) => node.parentId && parents.has(node.id)).map((node) => node.id);
}

export function workflowAncestors(nodes, id) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path = [];
  let node = byId.get(id);
  while (node) { path.unshift(node); node = byId.get(node.parentId); }
  return path;
}

/** Fixed cards; edges mean containment, never guessed execution dependencies. */
export function nestedWorkflowLayout(graph, { collapsedIds = [], focusId = null, measuredHeaders = {}, anchor = null } = {}) {
  graph = splitMapSections(graph).system;
  const optionalFields = mapOptionalFields(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = new Map(graph.nodes.map((node) => [node.id, []]));
  graph.nodes.forEach((node) => children.get(node.parentId)?.push(node));
  const categories = new Map(graph.categories.map((category) => [category.id, category]));
  const collapsed = new Set(collapsedIds);
  const root = byId.get(focusId) || graph.nodes.find((node) => node.parentId === null);
  if (!root) return { nodes: [], edges: [], rootId: null };
  const sizes = new Map();
  function measure(node) {
    const visibleChildren = collapsed.has(node.id) ? [] : children.get(node.id);
    visibleChildren.forEach(measure);
    const headerKey = JSON.stringify([node.label, node.task, node.proposal, node.workflow,
      node.category, children.get(node.id).length, WORKFLOW_CARD_WIDTH, optionalFields]);
    const measured = measuredHeaders[node.id];
    const height = measured?.key === headerKey ? measured.height
      : workflowCardHeight({ ...node, optionalFields, category: categories.get(node.category) });
    const size = { height, headerKey, expanded: visibleChildren.length > 0 };
    sizes.set(node.id, size);
    return size;
  }
  measure(root);

  function subtree(node, siblingIndex = 0, siblingMode = 'group') {
    const size = sizes.get(node.id);
    const visibleChildren = size.expanded ? children.get(node.id) : [];
    if (!visibleChildren.length) {
      return {
        placements: [{ node, depth: 0, y: 0, siblingIndex, siblingMode }],
        contours: new Map([[0, { top: 0, bottom: size.height }]]),
        rootCenter: size.height / 2,
      };
    }

    const childMode = node.workflow?.mode || 'group';
    const mergedContours = new Map();
    const placements = [];
    const childCenters = [];
    visibleChildren.forEach((child, index) => {
      const layout = subtree(child, index, childMode);
      let offset = 0;
      for (const [depth, contour] of layout.contours) {
        const existing = mergedContours.get(depth);
        if (existing) offset = Math.max(offset, existing.bottom + SIBLING_GAP - contour.top);
      }
      childCenters.push(layout.rootCenter + offset);
      for (const placement of layout.placements) {
        placements.push({ ...placement, depth: placement.depth + 1, y: placement.y + offset });
      }
      for (const [depth, contour] of layout.contours) {
        const shifted = { top: contour.top + offset, bottom: contour.bottom + offset };
        const existing = mergedContours.get(depth);
        mergedContours.set(depth, existing
          ? { top: Math.min(existing.top, shifted.top), bottom: Math.max(existing.bottom, shifted.bottom) }
          : shifted);
      }
    });

    const rootCenter = (childCenters[0] + childCenters.at(-1)) / 2;
    const rootTop = rootCenter - size.height / 2;
    const contours = new Map([[0, { top: rootTop, bottom: rootTop + size.height }]]);
    for (const [depth, contour] of mergedContours) contours.set(depth + 1, contour);
    return {
      placements: [{ node, depth: 0, y: rootTop, siblingIndex, siblingMode }, ...placements],
      contours,
      rootCenter,
    };
  }

  const arranged = subtree(root);
  const nodes = arranged.placements.map(({ node, depth, y, siblingIndex, siblingMode }) => {
    const size = sizes.get(node.id);
    return {
      id: node.id, type: 'workflowNode',
      position: { x: depth * (WORKFLOW_CARD_WIDTH + COLUMN_GAP), y },
      width: WORKFLOW_CARD_WIDTH, height: size.height,
      style: { width: WORKFLOW_CARD_WIDTH, height: size.height },
      draggable: false,
      data: { ...node, optionalFields, childCount: children.get(node.id).length, depth,
        expanded: size.expanded, headerHeight: size.height, headerKey: size.headerKey,
        sequenceIndex: siblingMode === 'sequence' ? siblingIndex + 1 : null,
        siblingMode },
    };
  });
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = nodes.flatMap(({ data: node }) => (
    node.parentId && visibleIds.has(node.parentId)
      ? [{ id: `hierarchy:${node.parentId}:${node.id}`, source: node.parentId, target: node.id,
        type: 'default', style: { stroke: '#587b6e', strokeWidth: 1.5 },
        ariaLabel: `${byId.get(node.parentId).label}의 하위 작업 ${node.label}` }]
      : []
  ));
  const anchored = anchor && nodes.find((node) => node.id === anchor.id);
  const offset = anchored
    ? { x: anchor.x - anchored.position.x, y: anchor.y - anchored.position.y }
    : { x: 0, y: -nodes[0].position.y };
  nodes.forEach((node) => { node.position.x += offset.x; node.position.y += offset.y; });
  return { nodes, edges, rootId: root.id };
}
