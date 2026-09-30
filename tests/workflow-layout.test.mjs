import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSource } from '../lib/format.mjs';
import { applyOperation } from '../lib/graph.mjs';
import { compactWorkflowViewport, nestedWorkflowLayout, workflowCollapsedIds, workflowAncestors } from '../src/workflowLayout.js';

const fixture = () => parseSource(fs.readFileSync(new URL('../maps/workflow-example.mmd', import.meta.url), 'utf8'));

describe('nested workflow', () => {
  it('keeps the focused mobile card visible through hidden-panel resize widths', () => {
    const position = { x: 492, y: -120 };
    for (const width of [0, 1, 36, NaN, 320, 390, 480]) {
      const viewport = compactWorkflowViewport(width, position);
      expect(viewport.zoom).toBeGreaterThan(0);
      expect(viewport.zoom).toBeLessThanOrEqual(.9);
      expect(viewport.x + position.x * viewport.zoom).toBeCloseTo(18);
      expect(viewport.y + position.y * viewport.zoom).toBeCloseTo(40);
      if (width >= 240) expect(18 + 360 * viewport.zoom).toBeLessThanOrEqual(width - 18);
    }
  });

  it('opens one level of legacy and new maps, independently of the structure view', () => {
    const graph = fixture();
    const view = { collapsedIds: ['video'], positions: { video: { x: 700, y: 900 } } };
    const collapsedIds = workflowCollapsedIds(graph, view);
    expect(collapsedIds).toContain('edit');
    const layout = nestedWorkflowLayout(graph, { collapsedIds });
    expect(layout.nodes.map((node) => node.id)).toEqual(['video', 'prepare', 'edit', 'review', 'deliver']);
    expect(view).toEqual({ collapsedIds: ['video'], positions: { video: { x: 700, y: 900 } } });
    expect(workflowCollapsedIds(graph, { workflow: { collapsedIds: [] } })).toEqual([]);
  });

  it('keeps every card fixed width, children to the right and siblings separated vertically', () => {
    const layout = nestedWorkflowLayout(fixture());
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    for (const node of layout.nodes) {
      expect(node.width).toBe(360);
      expect(node.parentId).toBeUndefined();
      if (!node.data.parentId) continue;
      const parent = byId.get(node.data.parentId);
      expect(node.position.x).toBeGreaterThan(parent.position.x + parent.width);
    }
    for (const parent of layout.nodes) {
      const siblings = layout.nodes.filter((node) => node.data.parentId === parent.id);
      for (let index = 1; index < siblings.length; index += 1) {
        expect(siblings[index].position.y).toBeGreaterThan(siblings[index - 1].position.y + siblings[index - 1].height);
        expect(siblings[index].position.x).toBe(siblings[index - 1].position.x);
      }
    }
    expect(byId.get('route').data.expanded).toBe(true);
    expect(byId.get('owner').data.task.condition).toBe('Action ID = REVIEW');
  });

  it('compacts sibling subtrees by column contours instead of reserving every descendant row', () => {
    const source = fixture();
    const included = new Set(['video', 'edit', 'state', 'choose', 'review']);
    const graph = { ...source, nodes: source.nodes.filter((node) => included.has(node.id)) };
    const layout = nestedWorkflowLayout(graph);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const edit = byId.get('edit');
    const review = byId.get('review');
    const state = byId.get('state');
    const choose = byId.get('choose');
    const video = byId.get('video');

    expect(review.position.y).toBe(edit.position.y + edit.height + 54);
    expect(choose.position.y).toBeGreaterThanOrEqual(state.position.y + state.height + 54);
    expect(review.position.y).toBeLessThan(choose.position.y + choose.height);
    expect(video.position.y + video.height / 2).toBe(
      ((edit.position.y + edit.height / 2) + (review.position.y + review.height / 2)) / 2,
    );
  });

  it('keeps deep uneven branches from overlapping within any column', () => {
    const layout = nestedWorkflowLayout(fixture());
    const columns = Map.groupBy(layout.nodes, (node) => node.position.x);
    for (const column of columns.values()) {
      const ordered = column.toSorted((left, right) => left.position.y - right.position.y);
      for (let index = 1; index < ordered.length; index += 1) {
        expect(ordered[index].position.y)
          .toBeGreaterThanOrEqual(ordered[index - 1].position.y + ordered[index - 1].height + 54);
      }
    }
  });

  it('uses branches only for hierarchy, and numbers explicit sequences in saved child order', () => {
    const graph = fixture();
    const layout = nestedWorkflowLayout(graph);
    expect(layout.edges.length).toBe(layout.nodes.length - 1);
    for (const edge of layout.edges) {
      expect(graph.nodes.find((node) => node.id === edge.target).parentId).toBe(edge.source);
      expect(edge.markerEnd).toBeUndefined();
    }
    expect(layout.nodes.find((node) => node.id === 'edit').data.sequenceIndex).toBe(2);
    const reordered = applyOperation(graph, { type: 'setChildOrder', id: 'video', childIds: ['prepare', 'review', 'edit', 'deliver'] });
    const next = nestedWorkflowLayout(reordered);
    expect(next.nodes.find((node) => node.id === 'review').data.sequenceIndex).toBe(2);
    expect(next.nodes.find((node) => node.id === 'edit').data.sequenceIndex).toBe(3);
    const grouped = applyOperation(graph, { type: 'setNodeWorkflow', id: 'video', workflow: null });
    expect(nestedWorkflowLayout(grouped).nodes.find((node) => node.id === 'edit').data.sequenceIndex).toBeNull();
  });

  it('focuses a branch with its original IDs and can recover the full breadcrumb', () => {
    const graph = fixture();
    const layout = nestedWorkflowLayout(graph, { focusId: 'route' });
    expect(layout.nodes.map((node) => node.id)).toEqual(['route', 'keep', 'retry', 'owner']);
    expect(layout.nodes[0].parentId).toBeUndefined();
    expect(workflowAncestors(graph.nodes, 'route').map((node) => node.id)).toEqual(['video', 'edit', 'route']);
    expect(nestedWorkflowLayout(graph, { focusId: 'deleted' }).rootId).toBe('video');
  });

  it('fits actual text wrapping and invalidates old measurements after content changes', () => {
    const graph = fixture();
    const before = nestedWorkflowLayout(graph);
    const edit = before.nodes.find((node) => node.id === 'edit');
    const measuredHeaders = { edit: { key: edit.data.headerKey, height: edit.data.headerHeight + 180 } };
    const next = nestedWorkflowLayout(graph, { measuredHeaders });
    expect(next.nodes.find((node) => node.id === 'edit').height).toBe(edit.height + 180);
    expect(next.nodes.find((node) => node.id === 'video').height).toBe(before.nodes[0].height);
    expect(next.nodes.every((node) => node.width === 360)).toBe(true);
    const changed = applyOperation(graph, { type: 'setNodeTask', id: 'edit', task: { logic: '짧은 설명' } });
    expect(nestedWorkflowLayout(changed, { measuredHeaders }).nodes.find((node) => node.id === 'edit').data.headerHeight)
      .toBe(nestedWorkflowLayout(changed).nodes.find((node) => node.id === 'edit').data.headerHeight);
  });

  it('expanding a card does not change its shape or move the root coordinate', () => {
    const graph = fixture();
    const folded = nestedWorkflowLayout(graph, { collapsedIds: ['edit'] });
    const expanded = nestedWorkflowLayout(graph);
    const editBefore = folded.nodes.find((node) => node.id === 'edit');
    const editAfter = expanded.nodes.find((node) => node.id === 'edit');
    expect(editBefore.width).toBe(editAfter.width);
    expect(editBefore.height).toBe(editAfter.height);
    expect(folded.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(expanded.nodes[0].position).toEqual({ x: 0, y: 0 });
    const anchored = nestedWorkflowLayout(graph, { anchor: { id: 'edit', x: 123, y: 456 } });
    expect(anchored.nodes.find((node) => node.id === 'edit').position).toEqual({ x: 123, y: 456 });
  });
});
