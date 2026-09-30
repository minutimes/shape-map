import { describe, expect, it } from 'vitest';
import { splitMapSections, mapOptionalFields, toggleOptionalField } from '../src/mapScope.js';
import { nestedWorkflowLayout } from '../src/workflowLayout.js';
import { applyOperation } from '../lib/graph.mjs';
import { historyEntryForOperation } from '../src/history.js';

const fixture = () => ({
  direction: 'LR',
  categories: [{ id: 'work', label: '작업', description: '설계', fill: '#FFFFFF', stroke: '#123456', textColor: '#123456', strokeWidth: 1 }],
  nodes: [
    { id: 'root', parentId: null, label: '시스템', workflow: { mode: 'sequence' } },
    { id: 'step', parentId: 'root', label: '근거를 분석하는 실제 작업', task: { logic: '원문 유지' } },
    { id: 'guide', parentId: 'root', label: '읽는 법', section: 'reference' },
    { id: 'evidence', parentId: 'guide', label: '문서 버전', task: { executor: { kind: 'llm', model: 'example', effort: 'high' } } },
    { id: 'next', parentId: 'root', label: '다음 작업' },
  ].map((node) => ({ shape: 'rounded', category: 'work', layout: { mode: 'fit' }, ...node })),
});

describe('map-specific reference sections and optional fields', () => {
  it('separates only explicitly marked subtrees and keeps original IDs, content and parent links', () => {
    const graph = fixture();
    const original = structuredClone(graph);
    const sections = splitMapSections(graph);
    expect(sections.system.nodes.map((node) => node.id)).toEqual(['root', 'step', 'next']);
    expect(sections.references.map((node) => node.id)).toEqual(['guide', 'evidence']);
    expect(sections.roots.map((node) => node.id)).toEqual(['guide']);
    expect(sections.references[1].parentId).toBe('guide');
    expect(graph).toEqual(original);
  });

  it('excludes reference branches from layout and sequence numbering, including stale focus', () => {
    const result = nestedWorkflowLayout(fixture(), { focusId: 'evidence' });
    expect(result.nodes.map((node) => node.id)).toEqual(['root', 'step', 'next']);
    expect(result.nodes.find((node) => node.id === 'next').data.sequenceIndex).toBe(2);
    expect(result.nodes.find((node) => node.id === 'root').data.childCount).toBe(2);
    expect(result.edges).toHaveLength(2);
  });

  it('uses only existing system metadata as legacy defaults and respects an explicit empty selection', () => {
    const graph = fixture();
    expect(mapOptionalFields(graph)).toEqual(['workflow']);
    graph.nodes[1].task.executor = { kind: 'llm', model: 'example', effort: 'high' };
    expect(mapOptionalFields(graph)).toEqual(['workflow', 'executor', 'model', 'effort']);
    const hidden = applyOperation(graph, { type: 'setMapSettings', settings: { optionalFields: [] } });
    expect(mapOptionalFields(hidden)).toEqual([]);
    expect(hidden.nodes).toEqual(graph.nodes);
    const restored = applyOperation(hidden, { type: 'setMapSettings', settings: null });
    expect(mapOptionalFields(restored)).toContain('effort');
  });

  it('restores section and per-map settings through ordinary undo without deleting content', () => {
    const graph = fixture();
    for (const operation of [
      { type: 'patchNodeContent', id: 'guide', changes: [{ path: 'section', before: 'reference', after: null }] },
      { type: 'setMapSettings', settings: { optionalFields: [] } },
    ]) {
      const history = historyEntryForOperation(operation, { graph });
      expect(applyOperation(applyOperation(graph, operation), history.undo)).toEqual(graph);
    }
  });

  it('keeps model-specific settings under the executor option without affecting other choices', () => {
    const fields = toggleOptionalField(['condition'], 'effort', true);
    expect(fields).toEqual(['condition', 'executor', 'effort']);
    expect(toggleOptionalField(fields, 'executor', false)).toEqual(['condition']);
  });
});
