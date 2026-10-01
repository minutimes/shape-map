import { describe, expect, it } from 'vitest';
import { shapeLayout } from '../src/shapeLayout.js';
import { shapePlacementPatch } from '../src/shapePlacement.js';
import { normalizePlacementAnchors } from '../lib/placement.mjs';
import { shapeViewHistoryEntry } from '../src/shapeEditing.js';

const fixture = () => ({ direction: 'LR', categories: [], nodes: [
  { id: 'root', label: '제품', parentId: null },
  ...['area', 'next', 'third', 'moved', 'tail'].map((id) => ({ id, label: id, parentId: 'root', workflow: { mode: 'group' } })),
  ...['first', 'branch', 'following'].map((id) => ({ id, label: id, parentId: 'area' })),
  ...Array.from({ length: 9 }, (_, i) => ({ id: `part${i}`, label: '세부 기능', parentId: 'branch' })),
] });

describe('responsive manual placements', () => {
  it.each([true, false])('keeps manual row and column gaps when moved in expanded=%s state, folded, reopened and undone', (expanded) => {
    const graph = fixture(); const original = structuredClone(graph);
    const collapsedIds = expanded ? [] : ['branch'];
    const frame = shapeLayout(graph, { collapsedIds }).nodes;
    const byId = (nodes, id) => nodes.find((node) => node.id === id);
    const next = byId(frame, 'next'); const height = Math.max(...frame.filter((node) => ['area', 'next', 'third'].includes(node.id)).map((node) => node.style.height));
    const position = { x: next.position.x + 25, y: height + 110 };
    const positions = Object.fromEntries(frame.map((node) => [node.id, node.id === 'moved' ? position : { ...node.position }]));
    const anchors = shapePlacementPatch(frame, 'moved', position, undefined);
    expect(normalizePlacementAnchors(anchors, graph)).toMatchObject({ moved: { x: { id: 'next' }, y: { edge: 'bottom' } } });
    const entry = shapeViewHistoryEntry({ positions: { moved: position }, anchors }, { positions: { moved: null }, anchors: Object.fromEntries(Object.keys(anchors).map((id) => [id, null])) });
    const placement = { positions, anchors: normalizePlacementAnchors(anchors, graph) };
    for (const folded of [false, true, false, true]) {
      const nodes = shapeLayout(graph, { ...placement, collapsedIds: folded ? ['branch'] : [] }).nodes;
      const moved = byId(nodes, 'moved'); const reference = byId(nodes, 'next');
      const bottom = Math.max(...nodes.filter((node) => ['area', 'next', 'third'].includes(node.id)).map((node) => node.position.y + node.style.height));
      expect(moved.position.x - reference.position.x).toBeCloseTo(25);
      expect(moved.position.y - bottom).toBeCloseTo(110);
    }
    expect(entry.undoView.shape.anchors.moved).toBeNull();
    expect(entry.redoView.shape.anchors.moved).toEqual(anchors.moved);
    expect(graph).toEqual(original);
  });
  it('rejects cyclic or cross-parent references and drops stale references after source edits', () => {
    const graph = fixture(); const x = (id) => ({ x: { id, edge: 'right', offset: 12 } });
    expect(() => normalizePlacementAnchors({ area: x('next'), next: x('area') }, graph, true)).toThrow(/cycle/);
    expect(() => normalizePlacementAnchors({ part0: x('area') }, graph, true)).toThrow();
    expect(normalizePlacementAnchors({ moved: x('deleted') }, graph)).toEqual({});
    expect(() => normalizePlacementAnchors({ moved: { y: { ids: ['area'], edge: 'bottom', offset: NaN } } }, graph, true)).toThrow();
  });
  it('keeps two manually moved sections together after folding, expanding and resizing the top row', () => {
    const graph = fixture(); const frame = shapeLayout(graph, { collapsedIds: [] }).nodes;
    const bottom = Math.max(...frame.filter((node) => ['area', 'next', 'third'].includes(node.id)).map((node) => node.style.height));
    const firstPosition = { x: frame.find((node) => node.id === 'next').position.x + 25, y: bottom + 110 };
    const positions = Object.fromEntries(frame.map((node) => [node.id, node.id === 'moved' ? firstPosition : node.position]));
    let anchors = normalizePlacementAnchors(shapePlacementPatch(frame, 'moved', firstPosition, undefined), graph);
    const secondFrame = shapeLayout(graph, { positions, anchors, collapsedIds: [] }).nodes;
    const secondPosition = { x: secondFrame.find((node) => node.id === 'third').position.x + 10, y: bottom + 104 };
    positions.tail = secondPosition;
    anchors = normalizePlacementAnchors(shapePlacementPatch(secondFrame, 'tail', secondPosition, undefined, anchors), graph);
    for (const options of [{ collapsedIds: ['branch'] }, { collapsedIds: [] }, { collapsedIds: ['branch'], sizes: { area: { width: 1800, height: 1000 } } }]) {
      const nodes = shapeLayout(graph, { positions, anchors, ...options }).nodes;
      const moved = nodes.find((node) => node.id === 'moved'); const tail = nodes.find((node) => node.id === 'tail');
      expect(tail.position.y - moved.position.y).toBeCloseTo(-6);
      expect(tail.position.x - moved.position.x - moved.style.width).toBeCloseTo(45);
      expect(moved.position.x - nodes.find((node) => node.id === 'next').position.x).toBeCloseTo(25);
    }
  });
  it('keeps a moved child below its own column without binding it to a taller overlapping column', () => {
    const nodes = [
      { id: 'a', parentId: 'parent', position: { x: 12, y: 80 }, style: { width: 220, height: 60 } },
      { id: 'b', parentId: 'parent', position: { x: 244, y: 80 }, style: { width: 600, height: 300 } },
      { id: 'c', parentId: 'parent', position: { x: 12, y: 160 }, style: { width: 220, height: 60 } },
    ];
    expect(shapePlacementPatch(nodes, 'c', { x: 12, y: 165 }, 'parent').c.y).toEqual({ ids: ['a'], edge: 'bottom', offset: 25 });
  });
  it('keeps children inside their section when a reference shrinks past the saved offset', () => {
    const graph = fixture();
    const nodes = shapeLayout(graph, { collapsedIds: ['branch'], anchors: {
      following: { x: { id: 'first', edge: 'left', offset: -100 }, y: { ids: ['branch'], edge: 'bottom', offset: -300 } },
    } }).nodes;
    const area = nodes.find((node) => node.id === 'area'); const child = nodes.find((node) => node.id === 'following');
    expect(child.position.x).toBeGreaterThanOrEqual(18);
    expect(child.position.y).toBeGreaterThanOrEqual(area.data.headerHeight + 18);
  });
  it('follows the aligned upper column when the right section is moved before its distant row neighbor', () => {
    const graph = fixture(); let frame = shapeLayout(graph, { collapsedIds: [] }).nodes;
    const bottom = Math.max(...frame.filter(node => ['area', 'next', 'third'].includes(node.id)).map(node => node.style.height));
    const positions = Object.fromEntries(frame.map(node => [node.id, node.position]));
    const tailPosition = { x: frame.find(node => node.id === 'third').position.x + 10, y: bottom + 104 };
    let anchors = normalizePlacementAnchors(shapePlacementPatch(frame, 'tail', tailPosition, undefined), graph);
    positions.tail = tailPosition;
    expect(anchors.tail.x).toMatchObject({ id: 'third', edge: 'left', offset: 10 });
    frame = shapeLayout(graph, { positions, anchors, collapsedIds: [] }).nodes;
    const movedPosition = { x: frame.find(node => node.id === 'next').position.x + 25, y: bottom + 110 };
    anchors = normalizePlacementAnchors(shapePlacementPatch(frame, 'moved', movedPosition, undefined, anchors), graph);
    positions.moved = movedPosition;
    for (const collapsedIds of [['branch'], [], ['branch']]) {
      const nodes = shapeLayout(graph, { positions, anchors, collapsedIds }).nodes;
      expect(nodes.find(node => node.id === 'tail').position.x - nodes.find(node => node.id === 'third').position.x).toBeCloseTo(10);
      expect(nodes.find(node => node.id === 'moved').position.x - nodes.find(node => node.id === 'next').position.x).toBeCloseTo(25);
    }
  });
});
