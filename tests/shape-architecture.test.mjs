import { describe, expect, it } from 'vitest';
import { shapeLayout } from '../src/shapeLayout.js';
import { shapeInspectorPosition } from '../src/shapeInspectorPosition.js';

function fixture() {
  const nodes = [{ id: 'root', parentId: null, label: '서비스' }, { id: 'dense', parentId: 'root', label: '제작' }, { id: 'rough', parentId: 'root', label: '공개' }];
  for (let group = 0; group < 6; group += 1) {
    const id = `group_${group}`; nodes.push({ id, parentId: 'dense', label: `기능 ${group} · 사용자가 원하는 변경과 여러 조건에 따라 결과를 준비하는 기능` });
    for (let part = 0; part < 8; part += 1) nodes.push({ id: `${id}_part_${part}`, parentId: id, label: `세부 기능 ${part}`, proposal: part === 0 ? { reason: '읽기 개선' } : undefined });
  }
  nodes.push({ id: 'public', parentId: 'rough', label: '결과 확인' });
  let parentId = 'group_0_part_0';
  for (let depth = 0; depth < 12; depth += 1) { const id = `depth_${depth}`; nodes.push({ id, parentId, label: `깊은 기능 ${depth}` }); parentId = id; }
  return { nodes, categories: [] };
}

function assertContained(layout) {
  for (const node of layout.nodes.filter((item) => item.parentId)) {
    const parent = layout.nodes.find((item) => item.id === node.parentId);
    expect(node.position.y).toBeGreaterThanOrEqual(parent.data.headerHeight);
    expect(node.position.x + node.style.width).toBeLessThanOrEqual(parent.style.width);
    expect(node.position.y + node.style.height).toBeLessThanOrEqual(parent.style.height);
  }
  for (const node of layout.nodes) for (const other of layout.nodes) {
    if (node.id >= other.id || node.parentId !== other.parentId) continue;
    const a = { ...node.position, ...node.style }; const b = { ...other.position, ...other.style };
    expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y, `${node.id} overlaps ${other.id}`).toBe(false);
  }
}

describe('horizontal system composition', () => {
  it('shows real subgroups in the overview and packs expanded dense and rough branches without overlap', () => {
    const graph = fixture(); const original = structuredClone(graph);
    const overview = shapeLayout(graph);
    expect(overview.nodes.filter((node) => node.parentId === 'dense')).toHaveLength(6);
    expect(overview.nodes.find((node) => node.id === 'group_0').data.title).toBe('기능 0');
    const full = shapeLayout(graph, { collapsedIds: [] });
    expect(full.nodes.map((node) => node.id)).toContain('depth_11');
    expect(full.nodes).toHaveLength(graph.nodes.length - 1);
    expect(new Set(full.nodes.filter((node) => node.parentId === 'group_1').map((node) => node.position.x)).size).toBeGreaterThan(1);
    expect(full.nodes.find((node) => node.id === 'dense').style.width).toBeGreaterThan(full.nodes.find((node) => node.id === 'rough').style.width);
    assertContained(full); assertContained(overview);
    expect(graph).toEqual(original);
  });
  it('keeps an authored sequence horizontal and preserves arbitrary hierarchy on phones', () => {
    const graph = fixture(); graph.nodes[1].workflow = { mode: 'sequence' };
    const desktop = shapeLayout(graph, { collapsedIds: [] });
    const parts = desktop.nodes.filter((node) => node.parentId === 'dense');
    expect(new Set(parts.map((node) => node.position.y)).size).toBe(1);
    expect(parts.map((node) => node.position.x)).toEqual([...parts.map((node) => node.position.x)].sort((a, b) => a - b));
    const mobile = shapeLayout(graph, { collapsedIds: [], compact: true });
    assertContained(mobile); expect(mobile.nodes).toHaveLength(graph.nodes.length - 1);
    expect(graph.nodes.find((node) => node.id === 'depth_11').parentId).toBe('depth_10');
  });
});

describe('object-attached editor placement', () => {
  it.each([390, 768, 1280])('keeps the editor entirely reachable at %i px without changing its anchor', (width) => {
    const anchor = { x: width * .4, y: 500, width: 180, height: 60 }; const original = { ...anchor };
    const result = shapeInspectorPosition(anchor, { width, height: 720 });
    expect(result.x).toBeGreaterThanOrEqual(12); expect(result.y).toBeGreaterThanOrEqual(12);
    expect(result.x + result.width).toBeLessThanOrEqual(width - 12); expect(result.y + result.height).toBeLessThanOrEqual(708);
    expect(anchor).toEqual(original);
    if (width === 390) expect(result.side).toBe('sheet'); else expect(result.leader).not.toBeNull();
  });
  it('changes sides with the object and handles an offscreen or hidden selection', () => {
    const stage = { width: 1280, height: 800 };
    expect(shapeInspectorPosition({ x: 20, y: 80, width: 200, height: 80 }, stage).side).toBe('right');
    expect(shapeInspectorPosition({ x: 1050, y: 80, width: 200, height: 80 }, stage).side).toBe('left');
    expect(shapeInspectorPosition(null, stage).side).toBe('sheet');
    const moved = shapeInspectorPosition({ x: -400, y: -200, width: 120, height: 80 }, stage);
    expect(moved.x).toBe(12); expect(moved.leader.from.x).toBe(12); expect(moved.leader.from.y).toBe(12);
  });
});
