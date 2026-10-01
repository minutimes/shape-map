import { describe, expect, it } from 'vitest';
import { parseSource, writeSource } from '../lib/format.mjs';
import { applyOperation } from '../lib/graph.mjs';
import { captureTurn } from '../lib/shape.mjs';
import { shapeLayout, absoluteShapePosition } from '../src/shapeLayout.js';
import { shapeHistoryEntry, shapeViewHistoryEntry, branchClipboard, pasteBranch, shapeDropTarget, settleShapePosition, assignLensOption, shapeConnectionTarget, facingShapePort, shapePortPoint, targetShapePort, reparentShapePreview } from '../src/shapeEditing.js';

const fixture = () => parseSource(`flowchart LR
%% mlc-format: 1
root["제품"]
a["제작"]
child["장면"]
b["검수"]
root --> a
a --> child
root --> b
classDef part fill:#FFFFFF,stroke:#BBBBBB,color:#222222,stroke-width:1px
class root,a,child,b part
%% mlc-legend: part|기능|기능
%% sm-link: {"id":"next","source":"a","target":"child","kind":"flow","label":"장면 전달","sourcePort":"bottom","targetPort":"left"}
%% sm-lens: {"id":"format","label":"형식","group":"영상 형식","options":[{"id":"short","label":"숏폼","roots":["a"],"custom":["child"]}]}
`);

describe('studio editing contracts', () => {
  it('ignores unchanged canvas choices and keeps independent fold and placement history snapshots', () => {
    const before = { collapsedIds: ['a', 'b'], positions: { child: null } };
    expect(shapeViewHistoryEntry({ collapsedIds: ['b', 'a', 'a'], positions: { child: null }, sizes: { a: null } }, before)).toBeNull();
    const patch = { collapsedIds: ['b'], positions: { child: { x: 45, y: 180 } } };
    const entry = shapeViewHistoryEntry(patch, before, 'a');
    before.collapsedIds.length = 0; patch.positions.child.x = 900;
    expect(entry.undoView.shape.collapsedIds).toEqual(['a', 'b']);
    expect(entry.undoView.shape.positions.child).toBeNull();
    expect(entry.redoView.shape.positions.child).toEqual({ x: 45, y: 180 });
    expect(entry.anchorId).toBe('a');
  });
  it('preserves ports, map-defined menu grouping, and proposal goals through source and recorded turns', () => {
    const graph = applyOperation(fixture(), { type: 'setProposal', id: 'a', proposal: { reason: '찾기 어렵다', purpose: '빠르게 찾는다', successCriteria: '장면을 한 번에 찾는다', logic: '장면 구성 표시' } });
    expect(parseSource(writeSource(graph))).toEqual(graph);
    const turn = captureTurn(graph, { id: 'turn', title: '기록', createdAt: '2026-10-01T00:00:00Z', revision: 'revision' });
    expect(turn.links[0]).toMatchObject({ sourcePort: 'bottom', targetPort: 'left' });
    expect(turn.lenses[0].group).toBe('영상 형식');
    const applied = applyOperation(graph, { type: 'applyProposal', id: 'a' }).nodes.find((node) => node.id === 'a');
    expect(applied.task).toEqual({ logic: '장면 구성 표시' });
    expect(applied.proposal).toBeUndefined();
    expect(() => applyOperation(graph, { type: 'upsertLink', link: { ...graph.links[0], sourcePort: 'diagonal' } })).toThrow();
  });
  it('copies a whole branch with fresh IDs, internal connections and custom attributes, without inventing review', () => {
    let graph = applyOperation(fixture(), { type: 'setBlock', id: 'child', block: { status: 'verified' }, at: '2026-10-01T00:00:00Z' });
    const payload = branchClipboard(graph, ['a', 'child']);
    const operation = pasteBranch(graph, payload, 'b');
    graph = applyOperation(graph, operation);
    const [parent, child] = operation.nodes;
    expect(payload.roots).toEqual(['a']);
    expect(parent.parentId).toBe('b'); expect(child.parentId).toBe(parent.id);
    expect(graph.links.find((link) => link.source === parent.id)).toMatchObject({ source: parent.id, target: child.id, sourcePort: 'bottom' });
    expect(graph.lenses[0].options[0].roots).toContain(parent.id);
    expect(graph.lenses[0].options[0].custom).toContain(child.id);
    expect(child.block.review).toBeUndefined(); expect(child.block.status).toBe('neutral');
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
  });
  it('undoes branch deletion with exact IDs, links, lenses and authored proposals', () => {
    const before = fixture(); const entry = shapeHistoryEntry({ type: 'deleteSubtrees', ids: ['a', 'child'] }, { graph: before, view: {} });
    const deleted = applyOperation(before, entry.redo);
    expect(deleted.nodes.some((node) => node.id === 'a')).toBe(false);
    expect(applyOperation(deleted, entry.undo)).toEqual(before);
  });
  it('undoes proposal and edge edits without replaying an obsolete fingerprint', () => {
    const before = fixture();
    for (const op of [{ type: 'setProposal', id: 'a', proposal: { reason: '새 계획' }, expectedFingerprint: 'old' },
      { type: 'upsertLink', link: { ...before.links[0], label: '다시 전달', targetPort: 'top' } }]) {
      const history = shapeHistoryEntry(op, { graph: before });
      const next = applyOperation(before, history.redo);
      expect(history.redo.expectedFingerprint).toBeUndefined();
      expect(applyOperation(next, history.undo)).toEqual(before);
    }
  });
  it('finds the smallest containing section and rejects parenting a section into its descendant', () => {
    let graph = applyOperation(fixture(), { type: 'setNodeWorkflow', id: 'b', workflow: { mode: 'group' } });
    graph = applyOperation(graph, { type: 'setNodeWorkflow', id: 'child', workflow: { mode: 'group' } });
    const nodes = shapeLayout(graph, { collapsedIds: [] }).nodes;
    const parent = nodes.find((node) => node.id === 'a'); const inner = nodes.find((node) => node.id === 'child');
    const point = { x: parent.position.x + inner.position.x + 20, y: parent.position.y + inner.position.y + 50 };
    expect(shapeDropTarget(graph, nodes, 'b', point).id).toBe('child');
    expect(shapeDropTarget(graph, nodes, 'a', point)).toBeNull();
  });
  it('assigns attributes declared by the map without inventing options or losing their grouping', () => {
    const graph = fixture(); const lenses = assignLensOption(graph.lenses, 'format', 'short', 'b', true);
    expect(lenses[0]).toMatchObject({ group: '영상 형식', options: [{ roots: ['a', 'b'], custom: ['child'] }] });
    expect(assignLensOption(lenses, 'format', 'short', 'b', false)).toEqual(graph.lenses);
  });
  it('drops clear of siblings without moving their authored coordinates', () => {
    const nodes = [
      { id: 'section', position: { x: 300, y: 200 }, style: { width: 800, height: 500 } },
      { id: 'existing', parentId: 'section', position: { x: 18, y: 88 }, style: { width: 220, height: 58 } },
      { id: 'moving', position: { x: 0, y: 0 }, style: { width: 220, height: 58 } },
    ];
    const before = structuredClone(nodes);
    expect(settleShapePosition(nodes, 'moving', { x: 17, y: 129 }, 'section')).toEqual({ x: 17, y: 158 });
    expect(nodes).toEqual(before);
  });
  it('persists manual sizes and nested placement while keeping children within their sections', () => {
    const graph = fixture(); const sizes = { a: { width: 900, height: 600 } }; const positions = { child: { x: 610, y: 300 } };
    const result = shapeLayout(graph, { collapsedIds: [], sizes, positions });
    const parent = result.nodes.find((node) => node.id === 'a'); const child = result.nodes.find((node) => node.id === 'child');
    expect(parent.style.width).toBeGreaterThanOrEqual(900); expect(parent.style.height).toBeGreaterThanOrEqual(600);
    expect(child.position).toEqual({ x: 610, y: 300 });
    expect(child.position.x + child.style.width).toBeLessThanOrEqual(parent.style.width);
  });
  it('connects to the body of the deepest card, its surrounding section, and the nearby outer border', () => {
    const nodes = [
      { id: 'source', position: { x: 0, y: 0 }, style: { width: 220, height: 80 } },
      { id: 'section', position: { x: 400, y: 0 }, style: { width: 600, height: 400 } },
      { id: 'child', parentId: 'section', position: { x: 30, y: 100 }, style: { width: 220, height: 80 } },
    ];
    expect(shapeConnectionTarget(nodes, 'source', { x: 530, y: 140 }).node.id).toBe('child');
    expect(shapeConnectionTarget(nodes, 'source', { x: 800, y: 300 }).node.id).toBe('section');
    expect(shapeConnectionTarget(nodes, 'source', { x: 1010, y: 300 }, 14).node.id).toBe('section');
    expect(shapeConnectionTarget(nodes, 'source', { x: 1040, y: 300 }, 14)).toBeNull();
    expect(shapeConnectionTarget(nodes, 'source', { x: 110, y: 40 })).toBeNull();
    expect(shapeConnectionTarget(nodes, 'child', { x: 530, y: 140 })).toBeNull();
    expect(shapeConnectionTarget(nodes, 'section', { x: 530, y: 140 }).node.id).toBe('child');
    const rect = { x: 400, y: 100, width: 220, height: 80 };
    expect(facingShapePort(rect, { x: 100, y: 140 })).toBe('left');
    expect(facingShapePort(rect, { x: 510, y: 0 })).toBe('top');
    expect(shapePortPoint(rect, 'left')).toEqual({ x: 400, y: 140 });
    expect(targetShapePort(rect, { x: 100, y: 140 }, { x: 510, y: 140 }, 'top')).toBe('left');
    expect(targetShapePort(rect, { x: 100, y: 140 }, { x: 510, y: 105 }, 'top')).toBe('top');
  });
  it('previews a reparent at the dropped position while preserving the target and neighboring area positions', () => {
    const graph = applyOperation(fixture(), { type: 'setNodeWorkflow', id: 'b', workflow: { mode: 'group' } });
    const before = structuredClone(graph);
    const nodes = shapeLayout(graph, { collapsedIds: [] }).nodes;
    const preview = reparentShapePreview(graph, nodes, 'child', 'b', { x: 50, y: 130 }, ['b']);
    const next = shapeLayout(preview.graph, { positions: preview.positions, collapsedIds: preview.collapsedIds }).nodes;
    expect(next.find((node) => node.id === 'child')).toMatchObject({ parentId: 'b', position: { x: 50, y: 130 } });
    for (const id of ['a', 'b']) expect(absoluteShapePosition(next, id)).toEqual(absoluteShapePosition(nodes, id));
    expect(preview.collapsedIds).toEqual([]);
    expect(graph).toEqual(before);
  });
  it('folds a resized section into a small card and restores its open size without losing the saved size', () => {
    const graph = fixture(); const sizes = { a: { width: 900, height: 600 } };
    const folded = shapeLayout(graph, { sizes, collapsedIds: ['a'] }).nodes.find((node) => node.id === 'a');
    expect(folded.style.width).toBe(340); expect(folded.style.height).toBeLessThan(100);
    expect(shapeLayout(graph, { sizes, collapsedIds: [] }).nodes.find((node) => node.id === 'a').style).toEqual({ width: 900, height: 600 });
    expect(sizes).toEqual({ a: { width: 900, height: 600 } });
  });
});
