import { describe, expect, it } from 'vitest';
import { applyOperation } from '../lib/graph.mjs';
import { deletionHistoryEntry, historyEntryForOperation } from '../src/history.js';

const category = {
  id: 'stage', label: '단계', description: '검증', fill: '#FFFFFF', stroke: '#123456', textColor: '#111111', strokeWidth: 1,
};

function fixture() {
  return {
    revision: 'one',
    graph: {
      direction: 'LR',
      categories: [category],
      nodes: [
        { id: 'root', label: '루트', parentId: null, shape: 'rounded', category: 'stage', layout: { mode: 'fit' } },
        { id: 'a', label: 'A', parentId: 'root', shape: 'rectangle', category: 'stage', layout: { mode: 'fit' } },
        { id: 'a1', label: 'A1', parentId: 'a', shape: 'rectangle', category: 'stage', layout: { mode: 'fit' } },
        { id: 'a2', label: 'A2', parentId: 'a', shape: 'rounded', category: 'stage', layout: { mode: 'fit' } },
        { id: 'b', label: 'B', parentId: 'root', shape: 'rectangle', category: 'stage', layout: { mode: 'fit' } },
        { id: 'b1', label: 'B1', parentId: 'b', shape: 'rectangle', category: 'stage', layout: { mode: 'fit' } },
        { id: 'c', label: 'C', parentId: 'root', shape: 'rectangle', category: 'stage', layout: { mode: 'fit' } },
      ],
    },
    view: {
      positions: {
        a: { x: 10, y: 20 }, a1: { x: 30, y: 40 }, a2: { x: 50, y: 60 },
        b: { x: 70, y: 80 }, b1: { x: 90, y: 100 },
      },
      collapsedIds: ['a', 'b'],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  };
}

describe('delete and history operations', () => {
  it('restores the original declaration order after appending into a sequence', () => {
    const before = fixture();
    before.graph.nodes.find((node) => node.id === 'b').workflow = { mode: 'sequence' };
    const operation = { type: 'moveNode', id: 'a', parentId: 'b' };
    const entry = historyEntryForOperation(operation, before);
    const moved = applyOperation(before.graph, operation);
    expect(moved.nodes.filter((node) => node.parentId === 'b').map((node) => node.id)).toEqual(['b1', 'a']);
    expect(applyOperation(moved, entry.undo)).toEqual(before.graph);
  });
  it('undoes task settings, flow kind and sibling order without changing other facts', () => {
    const before = fixture();
    before.graph.nodes[1].task = { logic: '승인 조건', executor: { kind: 'jev', language: 'en' } };
    for (const operation of [
      { type: 'setNodeTask', id: 'a', task: { logic: '새 조건', executor: { kind: 'llm', effort: 'high' } } },
      { type: 'setNodeWorkflow', id: 'root', workflow: { mode: 'sequence' } },
      { type: 'setChildOrder', id: 'root', childIds: ['c', 'a', 'b'] },
    ]) {
      const history = historyEntryForOperation(operation, before);
      expect(applyOperation(applyOperation(before.graph, operation), history.undo)).toEqual(before.graph);
    }
    before.view.workflow = { collapsedIds: ['a'], viewport: { x: 1, y: 2, zoom: 0.8 } };
    const deletion = deletionHistoryEntry(before, ['a']);
    expect(deletion.undoView.workflow).toEqual(before.view.workflow);
    expect(applyOperation(applyOperation(before.graph, deletion.redo), deletion.undo)).toEqual(before.graph);
  });
  it('deletes multiple selected subtrees atomically and restores exact node order', () => {
    const before = fixture();
    const entry = deletionHistoryEntry(before, ['a', 'a1', 'b']);
    expect(entry.redo).toEqual({ type: 'deleteSubtrees', ids: ['a', 'b'] });
    expect(entry.deletedIds).toEqual(['a', 'a1', 'a2', 'b', 'b1']);

    const deleted = applyOperation(before.graph, entry.redo);
    expect(deleted.nodes.map((node) => node.id)).toEqual(['root', 'c']);
    const restored = applyOperation(deleted, entry.undo);
    expect(restored).toEqual(before.graph);
    expect(entry.undoView).toEqual({
      positions: before.view.positions,
      collapsedIds: ['a', 'b'],
    });
  });

  it('protects the root and rejects invalid restore order', () => {
    const before = fixture();
    expect(deletionHistoryEntry(before, ['root'])).toBeNull();
    expect(() => applyOperation(before.graph, { type: 'deleteSubtrees', ids: ['root'] })).toThrow(/root node cannot be deleted/i);
    const entry = deletionHistoryEntry(before, ['a']);
    const deleted = applyOperation(before.graph, entry.redo);
    expect(() => applyOperation(deleted, { ...entry.undo, order: ['root', 'b', 'c'] })).toThrow(/order must list every node/i);
  });

  it('records both inverse and replay operations for ordinary edits', () => {
    const before = fixture();
    const operation = { type: 'renameNode', id: 'a', label: '새 이름' };
    expect(historyEntryForOperation(operation, before)).toEqual({
      label: 'renameNode',
      undo: { type: 'renameNode', id: 'a', label: 'A' },
      redo: operation,
    });
  });

  it('uses swapped field guards for content undo and preserves unrelated newer edits', () => {
    const before = fixture();
    before.graph.nodes.find(({ id }) => id === 'a').task = { logic: '이전 로직' };
    const operation = {
      type: 'patchNodeContent', id: 'a',
      changes: [
        { path: 'label', before: 'A', after: '새 이름' },
        { path: 'task.logic', before: '이전 로직', after: '새 로직' },
      ],
    };
    const entry = historyEntryForOperation(operation, before);
    expect(entry.undo).toEqual({
      type: 'patchNodeContent', id: 'a',
      changes: [
        { path: 'label', before: '새 이름', after: 'A' },
        { path: 'task.logic', before: '새 로직', after: '이전 로직' },
      ],
    });
    const changed = applyOperation(before.graph, operation);
    changed.nodes.find(({ id }) => id === 'a').proposal = { reason: '나중의 무관한 수정' };
    const undone = applyOperation(changed, entry.undo);
    expect(undone.nodes.find(({ id }) => id === 'a')).toMatchObject({
      label: 'A', task: { logic: '이전 로직' }, proposal: { reason: '나중의 무관한 수정' },
    });
    expect(() => applyOperation(changed, {
      ...entry.undo,
      changes: [{ path: 'task.logic', before: '다른 값', after: '이전 로직' }],
    })).toThrowError(expect.objectContaining({ code: 'field_conflict' }));
  });

  it('records canonical post-save values in guarded history', () => {
    const before = fixture();
    const operation = {
      type: 'patchNodeContent', id: 'a',
      changes: [
        { path: 'task.logic', before: null, after: '  정리된 로직  ' },
        { path: 'proposal.executor', before: null, after: { model: 'reviewer', kind: 'jev' } },
      ],
    };
    const entry = historyEntryForOperation(operation, before);
    expect(entry.redo.changes).toEqual([
      { path: 'task.logic', before: null, after: '정리된 로직' },
      {
        path: 'proposal.executor', before: null,
        after: { kind: 'jev', model: 'reviewer', language: 'en' },
      },
    ]);
    expect(entry.undo.changes).toEqual([
      { path: 'task.logic', before: '정리된 로직', after: null },
      {
        path: 'proposal.executor', before: { kind: 'jev', model: 'reviewer', language: 'en' },
        after: null,
      },
    ]);
  });

  it('records one atomic inverse for a multi-card layout edit', () => {
    const before = fixture();
    before.graph.nodes.find((node) => node.id === 'b').layout = { mode: 'wrap', width: 320 };
    const operation = {
      type: 'setNodeLayouts',
      items: [
        { id: 'a', layout: { mode: 'fixed', width: 280, height: 120 } },
        { id: 'b', layout: { mode: 'fixed', width: 280, height: 120 } },
      ],
    };
    const entry = historyEntryForOperation(operation, before);
    expect(entry.undo).toEqual({
      type: 'setNodeLayouts',
      items: [
        { id: 'a', layout: { mode: 'fit' } },
        { id: 'b', layout: { mode: 'wrap', width: 320 } },
      ],
    });
    expect(applyOperation(applyOperation(before.graph, operation), entry.undo)).toEqual(before.graph);
  });

  it('moves several branches atomically and restores each original parent in one undo', () => {
    const before = fixture();
    const operation = {
      type: 'moveNodes',
      items: [
        { id: 'a1', parentId: 'c' },
        { id: 'b1', parentId: 'c' },
      ],
    };
    const entry = historyEntryForOperation(operation, before);

    expect(entry.undo).toEqual({
      type: 'moveNodes',
      items: [
        { id: 'a1', parentId: 'a' },
        { id: 'b1', parentId: 'b' },
      ],
    });
    const moved = applyOperation(before.graph, operation);
    expect(moved.nodes.filter((node) => ['a1', 'b1'].includes(node.id)).map((node) => node.parentId))
      .toEqual(['c', 'c']);
    expect(applyOperation(moved, entry.undo)).toEqual(before.graph);
  });

  it('rejects a multi-branch move as a whole when it would create a cycle', () => {
    const before = fixture();
    expect(() => applyOperation(before.graph, {
      type: 'moveNodes',
      items: [
        { id: 'b1', parentId: 'c' },
        { id: 'a', parentId: 'a1' },
      ],
    })).toThrow(/cycle/i);
    expect(before.graph.nodes.find((node) => node.id === 'b1').parentId).toBe('b');
  });
});
