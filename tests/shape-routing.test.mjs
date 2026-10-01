import { describe, it, expect } from 'vitest';
import { shapeLayout, absoluteShapePosition } from '../src/shapeLayout.js';
import { routeShapeEdges, routeSegments, segmentHitsRect, roundedShapePath, shapeCanvasBounds } from '../src/shapeRouting.js';

function fixture() {
  return { categories: [], nodes: [{ id: 'product', label: '제품', parentId: null },
    ...['input', 'editing', 'delivery', 'engine', 'support'].flatMap((id) => [
      { id, label: id, parentId: 'product', block: { summary: '기능 설명' } },
      { id: `${id}_part`, label: '내부 기능', parentId: id },
    ])], links: [
    { id: 'start', source: 'input_part', target: 'editing_part', kind: 'flow', label: '입력 전달' },
    { id: 'finish', source: 'editing_part', target: 'delivery_part', kind: 'flow', label: '결과 전달' },
    { id: 'engine_connection', source: 'engine', target: 'editing', kind: 'dependency', label: '제작 엔진과 공통 기준' },
    { id: 'resume_connection', source: 'support', target: 'editing', kind: 'dependency', label: '현재본 보존·실패 구간 재개' },
    { id: 'storage', source: 'delivery_part', target: 'support_part', kind: 'flow', label: '결과 보관' },
  ] };
}

function overlap([a, b], [c, d]) {
  if (a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < .01) return Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
  if (a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < .01) return Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
  return 0;
}

function assertReadable(nodes, edges) {
  const boxes = nodes.filter((node) => !node.parentId).map((node) => ({ ...absoluteShapePosition(nodes, node.id), width: node.style.width, height: node.style.height }));
  for (const edge of edges) {
    expect(edge.data.route, edge.id).toBeDefined();
    const segments = routeSegments(edge.data.route.points);
    for (const segment of segments) {
      expect(segment[0].x === segment[1].x || segment[0].y === segment[1].y).toBe(true);
      for (const box of boxes) expect(segmentHitsRect(segment, box), `${edge.id} crosses a card`).toBe(false);
    }
    for (const other of edges.filter((item) => item.id !== edge.id)) {
      const otherSegments = routeSegments(other.data.route.points);
      for (const segment of segments) for (const second of otherSegments) expect(overlap(segment, second), `${edge.id} shares a line with ${other.id}`).toBeLessThanOrEqual(0);
      if (edge.data.route.label) for (const segment of otherSegments) expect(segmentHitsRect(segment, edge.data.route.label.rect, 2), `${other.id} covers ${edge.id}'s label`).toBe(false);
    }
    if (edge.data.route.label) {
      const a = edge.data.route.label.rect;
      for (const box of boxes) expect(a.x < box.x + box.width && a.x + a.width > box.x && a.y < box.y + box.height && a.y + a.height > box.y).toBe(false);
      for (const other of edges.filter((item) => item.id !== edge.id && item.data.route.label)) {
        const b = other.data.route.label.rect;
        expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
      }
    }
  }
}

describe('composition connector routing', () => {
  it('keeps internal connections out of other sub-systems and their title bands', () => {
    const nodes = [
      { id: 'assembly', type: 'shapeGroup', position: { x: 0, y: 0 }, style: { width: 650, height: 400 }, data: { headerHeight: 60 } },
      { id: 'destination', type: 'shapeBlock', parentId: 'assembly', position: { x: 18, y: 78 }, style: { width: 220, height: 78 }, data: {} },
      { id: 'engine', type: 'shapeGroup', parentId: 'assembly', position: { x: 258, y: 78 }, style: { width: 370, height: 290 }, data: { headerHeight: 60 } },
    ];
    const input = [{ id: 'internal', type: 'shapeConnection', source: 'assembly', target: 'destination', sourceHandle: 'bottom', targetHandle: 'top', label: '내부 결과 전달', data: { link: { label: '내부 결과 전달' } } }];
    const [edge] = routeShapeEdges(nodes, input);
    const engine = { x: 258, y: 78, width: 370, height: 290 };
    for (const segment of routeSegments(edge.data.route.points)) expect(segmentHitsRect(segment, engine, 1)).toBe(false);
    const recolored = routeShapeEdges(nodes.map((node) => ({ ...node, selected: true })), input.map((item) => ({ ...item, style: { opacity: .2 }, data: { ...item.data, ownerNote: '새 메모' } })))[0];
    expect(recolored.data.route).toBe(edge.data.route);
    expect(recolored.style.opacity).toBe(.2); expect(recolored.data.ownerNote).toBe('새 메모');
    expect(input[0].data).not.toHaveProperty('route');
  });
  it.each([1237, 1072, 900])('separates shared ports, lanes, and explanations at a %i px canvas', (availableWidth) => {
    const graph = fixture(); const before = structuredClone(graph);
    const layout = shapeLayout(graph, { availableWidth });
    const edges = routeShapeEdges(layout.nodes, layout.edges);
    assertReadable(layout.nodes, edges);
    expect(edges.map((edge) => edge.id)).toEqual(graph.links.map((link) => link.id));
    expect(edges.filter((edge) => edge.label).map((edge) => edge.data.route.label.lines.join(''))).toEqual(['제작 엔진과 공통 기준', '현재본 보존·실패 구간 재개']);
    expect(graph).toEqual(before);
    expect(layout.edges.every((edge) => !edge.data.route)).toBe(true);
  });
  it.each([{ compact: true }, { singleColumn: true }])('uses separate return lanes around intervening cards: %o', (options) => {
    const layout = shapeLayout(fixture(), options);
    assertReadable(layout.nodes, routeShapeEdges(layout.nodes, layout.edges));
  });
  it('recalculates lanes and endpoints after a card is dragged', () => {
    const layout = shapeLayout(fixture(), { availableWidth: 1237 });
    const original = routeShapeEdges(layout.nodes, layout.edges);
    const moved = layout.nodes.map((node) => node.id === 'support' ? { ...node, position: { x: node.position.x + 95, y: node.position.y + 90 } } : node);
    const next = routeShapeEdges(moved, layout.edges);
    assertReadable(moved, next);
    const edge = next.find((item) => item.id === 'resume_connection');
    expect(edge.data.route.points[0].y).toBe(moved.find((node) => node.id === 'support').position.y - 3);
    expect(edge.data.route).not.toEqual(original.find((item) => item.id === edge.id).data.route);
    expect(routeShapeEdges(moved, [...layout.edges].reverse()).find((item) => item.id === edge.id).data.route).toEqual(edge.data.route);
  });
  it('keeps detail connections, nested coordinates, and complete wrapped labels', () => {
    const graph = fixture(); graph.links = [{ id: 'nested', source: 'input_part', target: 'editing_part', kind: 'data', label: '이미 확인한 근거를 보존하면서 다음 기능이 필요한 자료와 설명을 함께 전달합니다.' }];
    const layout = shapeLayout(graph, { collapsedIds: [], detailedLinks: true });
    const edge = routeShapeEdges(layout.nodes, layout.edges)[0];
    expect(edge.source).toBe('input_part'); expect(edge.target).toBe('editing_part');
    expect(edge.data.route.label.lines.length).toBeGreaterThan(1);
    expect(edge.data.route.label.lines.join('')).toBe(graph.links[0].label);
    expect(edge.data.route.points[0].x).toBe(absoluteShapePosition(layout.nodes, edge.source).x + layout.nodes.find((node) => node.id === edge.source).style.width + 3);
  });
  it('leaves hierarchy edges alone and draws a continuous rounded path', () => {
    const layout = shapeLayout(fixture(), { mode: 'function' });
    expect(routeShapeEdges(layout.nodes, layout.edges)).toBe(layout.edges);
    expect(roundedShapePath([{ x: 10, y: 20 }, { x: 10, y: 50 }, { x: 70, y: 50 }])).toBe('M 10,20 L 10,44 Q 10,50 16,50 L 70,50');
  });
  it('includes return lanes and label space when fitting the canvas', () => {
    const layout = shapeLayout(fixture(), { compact: true });
    const edges = routeShapeEdges(layout.nodes, layout.edges);
    const bounds = shapeCanvasBounds(layout.nodes, edges);
    expect(bounds.x).toBeLessThan(0);
    for (const edge of edges) for (const point of edge.data.route.points) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.x);
      expect(point.x).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(point.y).toBeGreaterThanOrEqual(bounds.y);
      expect(point.y).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
    expect(shapeCanvasBounds([], [])).toBeNull();
  });
  it('keeps geometry finite for a connection from a container into its own contents', () => {
    const graph = fixture(); graph.links = [{ id: 'inside', source: 'input', target: 'input_part', kind: 'data', label: 'WWW workspace input' }];
    const layout = shapeLayout(graph, { collapsedIds: [], detailedLinks: true, focusId: 'input' });
    // A focused leaf projection omits the enclosing card, so show both levels.
    const expanded = shapeLayout(graph, { collapsedIds: [], detailedLinks: true });
    const edge = routeShapeEdges(expanded.nodes, expanded.edges)[0];
    expect(edge.data.route.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(edge.data.route.label.lines.join('')).toBe(graph.links[0].label);
    expect(routeShapeEdges(layout.nodes, layout.edges)).toEqual([]);
  });
});
