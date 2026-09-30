import { describe, expect, it } from 'vitest';
import { absoluteShapePosition, shapeAncestors, shapeLayout, turnGraph } from '../src/shapeLayout.js';
import { blocksForFiles } from '../lib/repository.mjs';

const fixture = () => ({ direction: 'LR', categories: [], nodes: [
  { id: 'root', label: '제품', parentId: null },
  { id: 'map', label: '지도', parentId: 'root' },
  { id: 'discussion', label: '논의', parentId: 'root' },
  { id: 'canvas', label: '캔버스', parentId: 'map', task: { ui: '기능을 누릅니다' }, block: { files: ['src/canvas.jsx'] } },
  { id: 'deep', label: '깊은 기능', parentId: 'canvas' },
  { id: 'note', label: '의견', parentId: 'discussion', block: { files: ['lib/'] } },
  { id: 'reference', label: '참고', parentId: 'root', section: 'reference' },
] });

describe('three projections of one product map', () => {
  it('groups by saved parent IDs and preserves deep branches and references in the source', () => {
    const graph = fixture(); const before = structuredClone(graph);
    const system = shapeLayout(graph, { collapsedIds: [] });
    expect(system.nodes.filter((node) => node.type === 'shapeGroup').map((node) => node.id)).toEqual(['map', 'canvas', 'discussion']);
    expect(system.nodes.find((node) => node.id === 'canvas')).toMatchObject({ parentId: 'map', extent: 'parent' });
    expect(system.nodes.find((node) => node.id === 'deep').parentId).toBe('canvas');
    expect(shapeLayout(graph, { focusId: 'canvas' }).nodes.map((node) => node.id)).toEqual(['deep']);
    expect(graph).toEqual(before);
  });
  it('starts with a readable whole-system overview and opens deeper parts on entering an area', () => {
    const graph = fixture();
    expect(shapeLayout(graph).nodes.some((node) => node.id === 'deep')).toBe(false);
    expect(shapeLayout(graph).nodes.find((node) => node.id === 'map').data.collapsed).toBe(true);
    expect(shapeLayout(graph, { focusId: 'map' }).nodes.some((node) => node.id === 'deep')).toBe(true);
  });
  it('uses the same IDs and actual parent edges for hierarchy and experience views', () => {
    const graph = fixture(); const hierarchy = shapeLayout(graph, { mode: 'function', focusId: 'map' });
    expect(hierarchy.edges.find((edge) => edge.target === 'canvas').source).toBe('map');
    expect(shapeLayout(graph, { mode: 'product', collapsedIds: [] }).nodes.find((node) => node.id === 'canvas').data.node.task.ui).toBe('기능을 누릅니다');
    expect(shapeAncestors(graph, 'deep').map((node) => node.id)).toEqual(['root', 'map', 'canvas', 'deep']);
    const compact = shapeLayout(graph, { compact: true });
    expect(compact.nodes.find((node) => node.id === 'map').style.width).toBe(340);
    expect(compact.nodes.find((node) => node.id === 'discussion').position.x).toBe(0);
    const tablet = shapeLayout(graph, { singleColumn: true });
    expect(tablet.nodes.find((node) => node.id === 'map').style.width).toBe(650);
    expect(tablet.nodes.find((node) => node.id === 'discussion').position.x).toBe(0);
    expect(tablet.nodes.find((node) => node.id === 'discussion').position.y).toBeGreaterThan(tablet.nodes.find((node) => node.id === 'map').style.height);
    const mobileHierarchy = shapeLayout(graph, { mode: 'function', compact: true });
    expect(mobileHierarchy.nodes.every((node) => node.position.x + node.style.width <= 340)).toBe(true);
    expect(mobileHierarchy.edges.map((edge) => edge.target)).toEqual(['map', 'discussion']);
  });
  it('keeps nested cards inside their containers and projects a hidden connection to a folded card', () => {
    const graph = fixture();
    graph.links = [{ id: 'input', source: 'note', target: 'deep', kind: 'data', label: '입력' }];
    const expanded = shapeLayout(graph, { collapsedIds: [], compact: true });
    for (const node of expanded.nodes.filter((item) => item.parentId)) {
      const parent = expanded.nodes.find((item) => item.id === node.parentId);
      expect(node.position.x + node.style.width).toBeLessThanOrEqual(parent.style.width);
      expect(node.position.y + node.style.height).toBeLessThanOrEqual(parent.style.height);
    }
    const deep = expanded.nodes.find((node) => node.id === 'deep');
    const canvas = expanded.nodes.find((node) => node.id === 'canvas');
    const map = expanded.nodes.find((node) => node.id === 'map');
    expect(absoluteShapePosition(expanded.nodes, 'deep')).toEqual({ x: map.position.x + canvas.position.x + deep.position.x, y: map.position.y + canvas.position.y + deep.position.y });
    const folded = shapeLayout(graph, { collapsedIds: ['canvas'], detailedLinks: true });
    expect(folded.nodes.some((node) => node.id === 'deep')).toBe(false);
    expect(folded.edges[0]).toMatchObject({ source: 'note', target: 'canvas' });
    expect(shapeLayout(graph, { focusId: 'map' }).edges).toEqual([]);
    expect(shapeLayout(graph, { detailedLinks: true }).edges[0]).toMatchObject({ source: 'discussion', target: 'map' });
  });
  it('keeps area handoffs readable and exposes smaller data connections on demand', () => {
    const graph = fixture();
    graph.links = [
      { id: 'handoff', source: 'deep', target: 'note', kind: 'flow', label: '전달' },
      { id: 'return', source: 'discussion', target: 'map', kind: 'dependency', label: '공통 기준' },
      { id: 'detail', source: 'note', target: 'canvas', kind: 'data', label: '자료' },
    ];
    const overview = shapeLayout(graph);
    expect(overview.edges.map((edge) => edge.id)).toEqual(['handoff', 'return']);
    expect(overview.edges[0]).toMatchObject({ source: 'map', target: 'discussion', sourceHandle: 'out', targetHandle: 'in' });
    expect(overview.edges[1]).toMatchObject({ sourceHandle: 'left-source', targetHandle: 'right-target' });
    expect(shapeLayout(graph, { detailedLinks: true }).edges.map((edge) => edge.id)).toContain('detail');
    const vertical = shapeLayout(graph, { singleColumn: true });
    expect(vertical.edges[1]).toMatchObject({ sourceHandle: 'top-source', targetHandle: 'bottom-target' });
  });
  it('routes a connection around an intervening area instead of through its text', () => {
    const graph = fixture();
    graph.nodes.splice(3, 0, { id: 'middle', label: '중간 영역', parentId: 'root' });
    graph.links = [
      { id: 'skip', source: 'map', target: 'middle', kind: 'flow', label: '다른 제작 경로' },
      { id: 'back', source: 'middle', target: 'map', kind: 'dependency', label: '공통 기준' },
    ];
    const vertical = shapeLayout(graph, { singleColumn: true });
    expect(vertical.edges[0]).toMatchObject({ sourceHandle: 'out', targetHandle: 'right-target' });
    expect(vertical.edges[1]).toMatchObject({ sourceHandle: 'left-source', targetHandle: 'in' });
    const horizontal = shapeLayout(graph, { availableWidth: 1500 });
    expect(horizontal.edges[0]).toMatchObject({ sourceHandle: 'top-source', targetHandle: 'top' });
  });
  it('matches real changed file paths to explicit feature links and keeps turn snapshots separate', () => {
    expect(blocksForFiles(fixture(), ['src/canvas.jsx', 'lib/save.mjs'])).toEqual([{ id: 'canvas', label: '캔버스' }, { id: 'note', label: '의견' }]);
    expect(blocksForFiles(fixture(), ['unrelated.txt'])).toEqual([]);
    const turn = { nodes: fixture().nodes, categories: [], title: '첫 기록', number: 1 };
    expect(turnGraph(turn)).not.toHaveProperty('turns');
    expect(turnGraph(turn).nodes).toBe(turn.nodes);
  });
});
