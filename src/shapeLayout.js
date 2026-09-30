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

/** All three views project the same saved nodes. Position never changes parentage. */
export function shapeLayout(graph, { focusId, mode = 'system', positions = {}, states = {}, onOpen, onFocus, compact = false, singleColumn = false } = {}) {
  const system = splitMapSections(graph).system;
  const nodes = system.nodes;
  const root = nodes.find((node) => node.id === focusId) || nodes.find((node) => !node.parentId);
  if (!root) return { nodes: [], edges: [], root: null };
  const children = new Map(nodes.map((node) => [node.id, []]));
  nodes.forEach((node) => children.get(node.parentId)?.push(node));
  const data = (node) => ({ node, state: states[node.id] || { status: 'neutral', commentCount: 0 },
    childCount: children.get(node.id)?.length || 0, onOpen, onFocus, mode, verticalHierarchy: compact && mode === 'function' });
  const place = (node, type, x, y, width, height, extras = {}) => ({
    id: node.id, type, position: positions[node.id] || { x, y },
    data: data(node), style: { width, height }, ...extras,
  });
  if (mode === 'function') {
    const result = [];
    const edges = [];
    if (compact) {
      result.push(place(root, 'shapeBlock', 0, 0, 304, 108));
      children.get(root.id).forEach((child, index) => {
        result.push(place(child, 'shapeBlock', 36, 154 + index * 122, 304, 108));
        edges.push({ id: `${root.id}-${child.id}`, source: root.id, target: child.id,
          type: 'smoothstep', style: { stroke: '#b4b5b8', strokeWidth: 1.2 } });
      });
      return { nodes: result, edges, root };
    }
    let cursor = 0;
    const walk = (node, depth) => {
      const start = cursor;
      const visible = depth < 1 ? children.get(node.id) : [];
      if (visible.length) visible.forEach((child) => walk(child, depth + 1));
      else cursor += 116;
      const y = visible.length ? (start + cursor - 116) / 2 : start;
      result.push(place(node, 'shapeBlock', depth * 340, y, 278, 108));
      if (depth) edges.push({ id: `${node.parentId}-${node.id}`, source: node.parentId, target: node.id,
        type: 'smoothstep', style: { stroke: '#b4b5b8', strokeWidth: 1.2 } });
    };
    walk(root, 0);
    return { nodes: result.reverse(), edges, root };
  }
  const groups = children.get(root.id).length ? children.get(root.id) : [root];
  const result = [];
  let rowY = 0;
  const columns = compact || singleColumn || groups.length === 1 ? 1 : 2;
  for (let row = 0; row < Math.ceil(groups.length / columns); row += 1) {
    let rowHeight = 0;
    groups.slice(row * columns, (row + 1) * columns).forEach((group, column) => {
      const items = children.get(group.id);
      const height = 86 + Math.max(1, Math.ceil(items.length / (compact ? 1 : 2))) * 122;
      rowHeight = Math.max(rowHeight, height);
      const board = place(group, 'shapeGroup', column * 508, rowY, compact ? 340 : 476, height, { zIndex: 0 });
      board.data = { ...board.data, index: row * columns + column + 1 };
      result.push(board);
      items.forEach((item, index) => {
        result.push({ ...place(item, 'shapeBlock', compact ? 18 : 18 + (index % 2) * 228, 76 + Math.floor(index / (compact ? 1 : 2)) * 122, compact ? 304 : 212, 108),
          parentId: group.id, extent: 'parent', draggable: false, zIndex: 1 });
      });
    });
    rowY += rowHeight + 32;
  }
  return { nodes: result, edges: [], root };
}

export function turnGraph(turn) {
  return turn ? { direction: 'LR', nodes: turn.nodes, categories: turn.categories,
    ...(turn.settings !== undefined ? { settings: turn.settings } : {}) } : null;
}
