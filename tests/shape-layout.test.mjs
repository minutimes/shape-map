import { describe, expect, it } from 'vitest';
import { shapeAncestors, shapeLayout, turnGraph } from '../src/shapeLayout.js';
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
    const system = shapeLayout(graph);
    expect(system.nodes.filter((node) => node.type === 'shapeGroup').map((node) => node.id)).toEqual(['map', 'discussion']);
    expect(system.nodes.find((node) => node.id === 'canvas')).toMatchObject({ parentId: 'map', extent: 'parent' });
    expect(system.nodes.some((node) => node.id === 'deep')).toBe(false);
    expect(shapeLayout(graph, { focusId: 'canvas' }).nodes.map((node) => node.id)).toEqual(['deep']);
    expect(graph).toEqual(before);
  });
  it('uses the same IDs and actual parent edges for hierarchy and experience views', () => {
    const graph = fixture(); const hierarchy = shapeLayout(graph, { mode: 'function', focusId: 'map' });
    expect(hierarchy.edges.find((edge) => edge.target === 'canvas').source).toBe('map');
    expect(shapeLayout(graph, { mode: 'product' }).nodes.find((node) => node.id === 'canvas').data.node.task.ui).toBe('기능을 누릅니다');
    expect(shapeAncestors(graph, 'deep').map((node) => node.id)).toEqual(['root', 'map', 'canvas', 'deep']);
    const compact = shapeLayout(graph, { compact: true });
    expect(compact.nodes.find((node) => node.id === 'map').style.width).toBe(340);
    expect(compact.nodes.find((node) => node.id === 'discussion').position.x).toBe(0);
    const tablet = shapeLayout(graph, { singleColumn: true });
    expect(tablet.nodes.find((node) => node.id === 'map').style.width).toBe(476);
    expect(tablet.nodes.find((node) => node.id === 'discussion').position.x).toBe(0);
    expect(tablet.nodes.find((node) => node.id === 'discussion').position.y).toBeGreaterThan(200);
    const mobileHierarchy = shapeLayout(graph, { mode: 'function', compact: true });
    expect(mobileHierarchy.nodes.every((node) => node.position.x + node.style.width <= 340)).toBe(true);
    expect(mobileHierarchy.edges.map((edge) => edge.target)).toEqual(['map', 'discussion']);
  });
  it('matches real changed file paths to explicit feature links and keeps turn snapshots separate', () => {
    expect(blocksForFiles(fixture(), ['src/canvas.jsx', 'lib/save.mjs'])).toEqual([{ id: 'canvas', label: '캔버스' }, { id: 'note', label: '의견' }]);
    expect(blocksForFiles(fixture(), ['unrelated.txt'])).toEqual([]);
    const turn = { nodes: fixture().nodes, categories: [], title: '첫 기록', number: 1 };
    expect(turnGraph(turn)).not.toHaveProperty('turns');
    expect(turnGraph(turn).nodes).toBe(turn.nodes);
  });
});
