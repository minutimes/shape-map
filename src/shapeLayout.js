import { splitMapSections } from './mapScope.js';

export const SHAPE_VIEWS = [
  { id: 'system', label: '시스템 구성도', description: '어떤 기능이 모여 제품을 이루는지 봅니다.' },
  { id: 'function', label: '기능 계통도', description: '큰 기능에서 작은 기능으로 한 단계씩 따라갑니다.' },
  { id: 'product', label: '최종 형상', description: '사용자가 무엇을 하고 어떤 결과를 받는지 봅니다.' },
];

export function shapeAncestors(graph, id) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const path = [];
  const visited = new Set();
  let node = byId.get(id);
  while (node && !visited.has(node.id)) {
    path.unshift(node); visited.add(node.id); node = byId.get(node.parentId);
  }
  return path;
}

export function defaultShapeCollapsed(graph, focusId) {
  const focusDepth = shapeAncestors(graph, focusId).length;
  const parents = new Set(graph.nodes.map((node) => node.parentId));
  const wholeSystem = !graph.nodes.find((node) => node.id === focusId)?.parentId;
  return graph.nodes.filter((node) => parents.has(node.id) && (wholeSystem ? shapeAncestors(graph, node.id).length >= focusDepth + 1 : shapeAncestors(graph, node.id).length > focusDepth + 2)).map((node) => node.id);
}

export function absoluteShapePosition(nodes, id) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const position = { x: 0, y: 0 };
  const seen = new Set();
  let node = byId.get(id);
  while (node && !seen.has(node.id)) {
    seen.add(node.id); position.x += node.position.x; position.y += node.position.y; node = byId.get(node.parentId);
  }
  return position;
}

function lines(text, width, size) {
  const units = Array.from(text || '').reduce((sum, character) => sum + (/[^\u0000-\u00ff]/.test(character) ? 1 : .56), 0);
  return Math.max(1, Math.ceil(units * size / width));
}

/** All three views project the same saved nodes. Position never changes parentage. */
export function shapeLayout(graph, { focusId, mode = 'system', positions = {}, states = {}, onOpen, onFocus, onToggle, collapsedIds, reading = {}, showActivation = false, detailedLinks = false, availableWidth = 1500, compact = false, singleColumn = false } = {}) {
  const system = splitMapSections(graph).system;
  const nodes = system.nodes;
  const root = nodes.find((node) => node.id === focusId) || nodes.find((node) => !node.parentId);
  if (!root) return { nodes: [], edges: [], root: null };
  const children = new Map(nodes.map((node) => [node.id, []]));
  nodes.forEach((node) => children.get(node.parentId)?.push(node));
  const data = (node) => ({ node, state: states[node.id] || { status: 'neutral', commentCount: 0 },
    childCount: children.get(node.id)?.length || 0, onOpen, onFocus, onToggle, mode, reading: reading[node.id], verticalHierarchy: compact && mode === 'function' });
  const place = (node, type, x, y, width, height, extras = {}) => ({
    id: node.id, type, position: { x, y },
    data: data(node), style: { width, height }, ...extras,
  });
  if (mode === 'function') {
    const result = [];
    const edges = [];
    const height = (node, width) => 48 + lines(node.label, width - 26, 14) * 22 + ((node.block?.summary || node.task?.logic) ? 34 : 0) + (children.get(node.id).length ? 12 : 0);
    if (compact) {
      const rootHeight = height(root, 304);
      result.push(place(root, 'shapeBlock', 0, 0, 304, rootHeight));
      let childY = rootHeight + 46;
      children.get(root.id).forEach((child) => {
        const childHeight = height(child, 304);
        result.push(place(child, 'shapeBlock', 36, childY, 304, childHeight));
        childY += childHeight + 22;
        edges.push({ id: `${root.id}-${child.id}`, source: root.id, target: child.id,
          sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep', style: { stroke: '#b4b5b8', strokeWidth: 1.2 } });
      });
      return { nodes: result, edges, root };
    }
    let cursor = 0;
    const walk = (node, depth) => {
      const start = cursor;
      const cardHeight = height(node, 278);
      const visible = depth < 1 ? children.get(node.id) : [];
      if (visible.length) visible.forEach((child) => walk(child, depth + 1));
      else cursor += cardHeight + 22;
      const y = visible.length ? Math.max(start, (start + cursor - cardHeight) / 2) : start;
      result.push(place(node, 'shapeBlock', depth * 340, y, 278, cardHeight));
      if (depth) edges.push({ id: `${node.parentId}-${node.id}`, source: node.parentId, target: node.id,
        sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep', style: { stroke: '#b4b5b8', strokeWidth: 1.2 } });
    };
    walk(root, 0);
    return { nodes: result.reverse(), edges, root };
  }
  const groups = children.get(root.id).length ? children.get(root.id) : [root];
  const collapsed = new Set(collapsedIds || defaultShapeCollapsed(graph, root.id));
  const result = [];
  const wholeSystem = !root.parentId;
  const columns = compact || singleColumn || groups.length === 1 || root.workflow?.mode === 'sequence' ? 1 : wholeSystem && availableWidth >= 1000 ? 3 : 2;
  const width = compact ? 340 : columns === 1 ? 650 : wholeSystem ? Math.max(300, Math.min(500, (availableWidth - 120) / columns)) : Math.max(340, Math.min(650, (availableWidth - 150) / 2));
  const columnGap = wholeSystem ? 45 : 100;
  const inset = (cardWidth) => cardWidth > 300 ? 20 : cardWidth > 200 ? 8 : 0;
  const measure = (node, cardWidth, depth) => {
    const titleHeight = lines(node.label, Math.max(100, cardWidth - 42), depth ? 14 : 16) * 22;
    const header = (children.get(node.id).length ? 60 : 32) + titleHeight + ((node.block?.summary || node.task?.logic) ? 34 : 0);
    const items = collapsed.has(node.id) ? [] : children.get(node.id);
    if (!items.length) return { height: header + 8, header, items: [], group: children.get(node.id).length > 0 };
    const sizes = items.map((child) => measure(child, cardWidth - inset(cardWidth) * 2, depth + 1));
    return { height: header + 18 + sizes.reduce((sum, size) => sum + size.height + 18, 0), header, items, sizes, group: true };
  };
  const draw = (node, cardWidth, x, y, depth, parentId, size) => {
    const card = place(node, size.group ? 'shapeGroup' : 'shapeBlock', x, y, cardWidth, size.height,
      { ...(parentId ? { parentId, extent: 'parent' } : {}), draggable: !parentId, zIndex: depth + 1 });
    card.data = { ...card.data, depth, collapsed: collapsed.has(node.id), headerHeight: size.header,
      index: groups.indexOf(node) + 1, nested: true };
    result.push(card);
    let childY = size.header + 8;
    size.items.forEach((child, index) => {
      draw(child, cardWidth - inset(cardWidth) * 2, inset(cardWidth), childY, depth + 1, node.id, size.sizes[index]);
      childY += size.sizes[index].height + 18;
    });
  };
  let rowY = 0;
  for (let row = 0; row < Math.ceil(groups.length / columns); row += 1) {
    let rowHeight = 0;
    groups.slice(row * columns, (row + 1) * columns).forEach((group, column) => {
      const size = measure(group, width, 0);
      rowHeight = Math.max(rowHeight, size.height);
      const position = positions[group.id] || { x: column * (width + columnGap), y: rowY };
      draw(group, width, position.x, position.y, 0, null, size);
    });
    rowY += rowHeight + (wholeSystem ? 76 : 86);
  }
  const visible = new Map(result.map((node) => [node.id, node]));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const project = (id) => { let node = byId.get(id); while (node && !visible.has(node.id)) node = byId.get(node.parentId); return node?.id; };
  const path = (id) => { const result = []; let node = visible.get(id); while (node) { result.unshift(node.id); node = visible.get(node.parentId); } return result; };
  const boundaries = (source, target) => {
    if (detailedLinks) return [source, target];
    const from = path(source); const to = path(target);
    let shared = 0;
    while (from[shared] && from[shared] === to[shared]) shared += 1;
    // Interfaces between containers stay outside their contents. The inspector
    // retains the original endpoints, and detailed mode exposes every port.
    return [from[Math.min(shared, from.length - 1)], to[Math.min(shared, to.length - 1)]];
  };
  const edges = [];
  const pairs = new Set();
  const groupIds = new Set(groups.map((node) => node.id));
  const addEdge = (link) => {
    if (link.kind === 'activation' && !showActivation) return;
    // The whole-system overview shows the main handoffs and explicitly authored
    // area relationships. Detail mode retains every saved data connection.
    if (wholeSystem && !detailedLinks && link.kind !== 'flow' && link.kind !== 'activation'
      && !(groupIds.has(link.source) && groupIds.has(link.target))) return;
    let source = project(link.source); let target = project(link.target);
    if (!source || !target || source === target) return;
    [source, target] = boundaries(source, target);
    const key = `${source}:${target}${detailedLinks ? `:${link.kind}` : ''}`;
    if (pairs.has(key)) return;
    pairs.add(key);
    const from = absoluteShapePosition(result, source); const to = absoluteShapePosition(result, target);
    const vertical = Math.abs(from.y - to.y) > 5 || Math.abs(from.x - to.x) < 5;
    const fromNode = visible.get(source); const toNode = visible.get(target);
    const siblings = result.filter((node) => node.id !== source && node.id !== target
      && node.parentId === fromNode.parentId && fromNode.parentId === toNode.parentId);
    const columnDetour = Math.abs(from.x - to.x) < 5 && siblings.some((node) => {
      const point = absoluteShapePosition(result, node.id);
      return point.y > Math.min(from.y, to.y) && point.y < Math.max(from.y, to.y)
        && point.x <= from.x + fromNode.style.width / 2 && point.x + node.style.width >= from.x + fromNode.style.width / 2;
    });
    const rowDetour = Math.abs(from.y - to.y) < 5 && siblings.some((node) => {
      const point = absoluteShapePosition(result, node.id);
      return point.x > Math.min(from.x, to.x) && point.x < Math.max(from.x, to.x)
        && point.y <= from.y + fromNode.style.height / 2 && point.y + node.style.height >= from.y + fromNode.style.height / 2;
    });
    let sourceHandle = vertical ? (from.y <= to.y ? 'bottom' : 'top-source') : (from.x <= to.x ? 'out' : 'left-source');
    let targetHandle = vertical ? (from.y <= to.y ? 'top' : 'bottom-target') : (from.x <= to.x ? 'in' : 'right-target');
    if (columnDetour) {
      sourceHandle = from.y < to.y ? 'out' : 'left-source';
      targetHandle = from.y < to.y ? 'right-target' : 'in';
    } else if (rowDetour) { sourceHandle = 'top-source'; targetHandle = 'top'; }
    const label = wholeSystem && !detailedLinks && (columnDetour || rowDetour
      || !(groupIds.has(link.source) && groupIds.has(link.target))) ? undefined : link.label;
    edges.push({ id: link.id, source, target, sourceHandle, targetHandle,
      type: 'smoothstep', label, labelStyle: { fontSize: 11, fill: '#676773' }, labelBgStyle: { fill: '#fafafa', fillOpacity: .98 }, labelBgPadding: [6, 3],
      markerEnd: { type: 'arrowclosed', color: '#8d8d99', width: 14, height: 14 }, zIndex: 100,
      style: { stroke: '#8d8d99', strokeWidth: 1.3, ...(link.kind !== 'flow' ? { strokeDasharray: '4 4' } : {}),
        opacity: reading[source]?.active === false || reading[target]?.active === false ? .15 : .8 }, data: { link } });
  };
  (graph.links || []).forEach(addEdge);
  for (const node of nodes) if (node.workflow?.mode === 'sequence') {
    const items = children.get(node.id);
    items.slice(1).forEach((child, index) => addEdge({ id: `sequence-${node.id}-${index}`, source: items[index].id, target: child.id, label: '다음', kind: 'flow' }));
  }
  return { nodes: result, edges, root };
}

export function turnGraph(turn) {
  return turn ? { direction: 'LR', nodes: turn.nodes, categories: turn.categories,
    ...(turn.links !== undefined ? { links: turn.links } : {}),
    ...(turn.lenses !== undefined ? { lenses: turn.lenses } : {}),
    ...(turn.settings !== undefined ? { settings: turn.settings } : {}) } : null;
}
