import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseSource, writeSource } from '../lib/format.mjs';
import { applyOperation, getSubtree } from '../lib/graph.mjs';

const demoUrl = new URL('../maps/demo.mmd', import.meta.url);

describe('supported Mermaid source format', () => {
  it('round-trips IDs, Korean labels, shapes, categories, and legends', async () => {
    const graph = parseSource(await fs.readFile(demoUrl, 'utf8'));
    const updated = applyOperation(graph, { type: 'renameNode', id: 'planning', label: '기획: "왜"와 방법' });
    const reparsed = parseSource(writeSource(updated));

    expect(reparsed).toEqual(updated);
    expect(reparsed.nodes.find(({ id }) => id === 'direction')).toMatchObject({ label: '영상 설계 지도', shape: 'rounded' });
    expect(reparsed.categories.find(({ id }) => id === 'focus')).toMatchObject({ label: '구체화 대상', strokeWidth: 2 });
  });

  it.each([
    ['unknown statement', '  click direction "https://example.com"'],
    ['duplicate node', '  direction["중복"]'],
    ['multiple parents', '  shortform --> stage1'],
    ['cycle', '  stage1 --> direction'],
  ])('rejects %s', async (_name, extra) => {
    const source = `${await fs.readFile(demoUrl, 'utf8')}\n${extra}\n`;
    expect(() => parseSource(source)).toThrow();
  });

  it('rejects a missing category assignment and an orphan legend', async () => {
    const source = await fs.readFile(demoUrl, 'utf8');
    expect(() => parseSource(source.replace('  class planning,stage1,stage15,original focus\n', ''))).toThrow(/missing category/);
    expect(() => parseSource(source.replace(/^\s*classDef focus.*\n/m, ''))).toThrow(/missing its classDef/);
  });

  it('preserves sibling/source order and appends a new child deterministically', async () => {
    const original = parseSource(await fs.readFile(demoUrl, 'utf8'));
    const added = applyOperation(original, { type: 'addNode', id: 'stage2', parentId: 'stages', label: '2. 편집', shape: 'rectangle', category: 'focus' });
    expect(added.nodes.filter(({ parentId }) => parentId === 'stages').map(({ id }) => id)).toEqual(['stage1', 'stage15', 'stage2']);

    const moved = applyOperation(added, { type: 'moveNode', id: 'planning', parentId: 'shortform' });
    expect(moved.nodes.map(({ id }) => id)).toEqual(added.nodes.map(({ id }) => id));
    expect(moved.nodes.filter(({ parentId }) => parentId === 'stages').map(({ id }) => id)).toEqual(['stage1', 'stage15', 'stage2']);
    expect(parseSource(writeSource(moved))).toEqual(moved);
  });

  it('round-trips per-node fit, wrapped, and fixed presentation in the Mermaid source', async () => {
    const original = parseSource(await fs.readFile(demoUrl, 'utf8'));
    const updated = applyOperation(original, {
      type: 'setNodeLayouts',
      items: [
        { id: 'planning', layout: { mode: 'wrap', width: 340 } },
        { id: 'stage1', layout: { mode: 'fixed', width: 310, height: 132 } },
      ],
    });
    const source = writeSource(updated);
    expect(source).toContain('%% mlc-node-layout: planning|wrap|340');
    expect(source).toContain('%% mlc-node-layout: stage1|fixed|310|132');
    expect(parseSource(source)).toEqual(updated);
  });

  it('rejects malformed or orphaned node layout metadata', async () => {
    const source = await fs.readFile(demoUrl, 'utf8');
    expect(() => parseSource(`${source}\n  %% mlc-node-layout: planning|fixed|100|20\n`)).toThrow(/width/i);
    expect(() => parseSource(`${source}\n  %% mlc-node-layout: absent|wrap|280\n`)).toThrow(/undeclared node/i);
    expect(() => parseSource(`${source}\n  %% mlc-node-layout: planning|fit|280\n`)).toThrow(/invalid fit/i);
    expect(() => parseSource(`${source}\n  %% mlc-node-layout: planning|wrap|280|120\n`)).toThrow(/invalid wrap/i);
  });

  it('round-trips task and workflow metadata with Unicode and JSON delimiters', async () => {
    const original = parseSource(await fs.readFile(demoUrl, 'utf8'));
    const withTask = applyOperation(original, {
      type: 'setNodeTask',
      id: 'planning',
      task: {
        logic: '기획 | 기준을 비교한다',
        inputs: '원본 영상과 {"선택":"A|B"}',
        outputs: '검토 가능한 설계',
        ui: '',
        executor: { kind: 'jev', model: 'judgment-v1' },
      },
    });
    const updated = applyOperation(withTask, {
      type: 'setNodeWorkflow', id: 'planning', workflow: { mode: 'conditional' },
    });
    const source = writeSource(updated);
    const reparsed = parseSource(source);

    expect(source).toContain('%% mlc-task: planning|');
    expect(reparsed).toEqual(updated);
    expect(reparsed.nodes.find(({ id }) => id === 'planning')).toMatchObject({
      task: {
        logic: '기획 | 기준을 비교한다',
        inputs: '원본 영상과 {"선택":"A|B"}',
        executor: { kind: 'jev', model: 'judgment-v1', language: 'en' },
      },
      workflow: { mode: 'conditional' },
    });
  });

  it('round-trips proposal metadata, including an intentionally empty proposal', async () => {
    const original = parseSource(await fs.readFile(demoUrl, 'utf8'));
    const empty = applyOperation(original, {
      type: 'patchNodeContent', id: 'planning',
      changes: [{ path: 'proposal', before: null, after: {} }],
    });
    const enriched = applyOperation(empty, {
      type: 'patchNodeContent', id: 'stage1',
      changes: [{
        path: 'proposal',
        before: null,
        after: {
          logic: '더 작은 단계로 | 나눈다', reason: '현재 단계의 책임이 너무 넓다',
          executor: { kind: 'jev', model: 'review-model' },
        },
      }],
    });
    const source = writeSource(enriched);
    expect(source).toContain('%% mlc-proposal: planning|{}');
    expect(parseSource(source)).toEqual(enriched);
    expect(parseSource(source).nodes.find(({ id }) => id === 'stage1').proposal).toEqual({
      logic: '더 작은 단계로 | 나눈다',
      executor: { kind: 'jev', model: 'review-model', language: 'en' },
      reason: '현재 단계의 책임이 너무 넓다',
    });
  });

  it('round-trips reference sections and explicit optional map fields', async () => {
    const original = parseSource(await fs.readFile(demoUrl, 'utf8'));
    const withReference = applyOperation(original, {
      type: 'patchNodeContent', id: 'planning',
      changes: [{ path: 'section', before: null, after: 'reference' }],
    });
    const updated = applyOperation(withReference, {
      type: 'setMapSettings',
      settings: { optionalFields: ['executor', 'model', 'effort', 'condition', 'workflow'] },
    });
    const source = writeSource(updated);
    const reparsed = parseSource(source);

    expect(source).toContain('%% mlc-section: planning|reference');
    expect(source).toContain('%% mlc-settings: {"optionalFields":["executor","model","effort","condition","workflow"]}');
    expect(reparsed).toEqual(updated);
    expect(getSubtree(reparsed, 'live', 1).children.find(({ id }) => id === 'planning').section).toBe('reference');
  });

  it('keeps absent settings absent and preserves all metadata through unrelated edits', async () => {
    const original = parseSource(await fs.readFile(demoUrl, 'utf8'));
    expect(original).not.toHaveProperty('settings');
    expect(parseSource(writeSource(applyOperation(original, {
      type: 'renameNode', id: 'stage1', label: '1. 분석 수정',
    })))).not.toHaveProperty('settings');

    const enriched = applyOperation(applyOperation(original, {
      type: 'setMapSettings', settings: { optionalFields: [] },
    }), {
      type: 'patchNodeContent', id: 'planning',
      changes: [{ path: 'section', before: null, after: 'reference' }],
    });
    enriched.nodes.find(({ id }) => id === 'planning').task = { logic: '근거를 정리한다' };
    enriched.nodes.find(({ id }) => id === 'planning').proposal = { reason: '참고 자료 보강' };
    const renamed = applyOperation(enriched, { type: 'renameNode', id: 'stage1', label: '1. 분석 수정' });
    const reparsed = parseSource(writeSource(renamed));
    expect(reparsed.settings).toEqual({ optionalFields: [] });
    expect(reparsed.nodes.find(({ id }) => id === 'planning')).toMatchObject({
      section: 'reference', task: { logic: '근거를 정리한다' }, proposal: { reason: '참고 자료 보강' },
    });
  });

  it('strictly validates reference and settings metadata and supports guarded section undo', async () => {
    const source = await fs.readFile(demoUrl, 'utf8');
    expect(() => parseSource(`${source}\n  %% mlc-section: absent|reference\n`)).toThrow(/undeclared node/);
    expect(() => parseSource(`${source}\n  %% mlc-section: planning|reference\n  %% mlc-section: planning|reference\n`))
      .toThrow(/duplicate node section/);
    expect(() => parseSource(`${source}\n  %% mlc-section: planning|notes\n`)).toThrow(/unsupported statement/);
    expect(() => parseSource(`${source}\n  %% mlc-section: direction|reference\n`)).toThrow(/root node cannot be a reference/);
    expect(() => parseSource(`${source}\n  %% mlc-settings: {"optionalFields":[]}\n  %% mlc-settings: {"optionalFields":[]}\n`))
      .toThrow(/duplicate map settings/);
    expect(() => parseSource(`${source}\n  %% mlc-settings: {"optionalFields":[],"unknown":true}\n`))
      .toThrow(/Unsupported map settings field/);
    expect(() => parseSource(`${source}\n  %% mlc-settings: {"optionalFields":["executor","executor"]}\n`))
      .toThrow(/Duplicate map settings optional field/);
    expect(() => parseSource(`${source}\n  %% mlc-settings: {"optionalFields":["temperature"]}\n`))
      .toThrow(/Invalid map settings optional field/);

    const original = parseSource(source);
    const tagged = applyOperation(original, {
      type: 'patchNodeContent', id: 'planning',
      changes: [{ path: 'section', before: null, after: 'reference' }],
    });
    const retried = applyOperation(tagged, {
      type: 'patchNodeContent', id: 'planning',
      changes: [{ path: 'section', before: null, after: 'reference' }],
    });
    const undone = applyOperation(retried, {
      type: 'patchNodeContent', id: 'planning',
      changes: [{ path: 'section', before: 'reference', after: null }],
    });
    expect(retried).toEqual(tagged);
    expect(undone).toEqual(original);
    expect(() => applyOperation(original, {
      type: 'patchNodeContent', id: 'direction',
      changes: [{ path: 'section', before: null, after: 'reference' }],
    })).toThrow(/root node cannot be a reference/);
  });

  it('strictly rejects malformed, duplicate, orphaned, and invalid proposal metadata', async () => {
    const source = await fs.readFile(demoUrl, 'utf8');
    expect(() => parseSource(`${source}\n  %% mlc-proposal: planning|not-json\n`)).toThrow(/invalid node proposal metadata JSON/);
    expect(() => parseSource(`${source}\n  %% mlc-proposal: planning|{}\n  %% mlc-proposal: planning|{}\n`))
      .toThrow(/duplicate node proposal/);
    expect(() => parseSource(`${source}\n  %% mlc-proposal: absent|{}\n`)).toThrow(/undeclared node/);
    expect(() => parseSource(`${source}\n  %% mlc-proposal: planning|{"unknown":true}\n`))
      .toThrow(/Unsupported node proposal field/);
    expect(() => parseSource(`${source}\n  %% mlc-proposal: planning|{"executor":{"kind":"jev","language":"ko"}}\n`))
      .toThrow(/must be en/);
    expect(() => applyOperation(parseSource(source), {
      type: 'patchNodeContent', id: 'planning',
      changes: [{ path: 'proposal.reason', before: null, after: 'x'.repeat(4_001) }],
    })).toThrow(/at most 4000/);
    expect(() => applyOperation(parseSource(source), {
      type: 'patchNodeContent', id: 'planning',
      changes: [
        { path: 'proposal', before: null, after: {} },
        { path: 'proposal.logic', before: null, after: '겹침' },
      ],
    })).toThrow(/Overlapping content change paths/);
    expect(() => applyOperation(parseSource(source), {
      type: 'patchNodeContent', id: 'planning',
      changes: [{ path: 'task.logic', after: 'before 누락' }],
    })).toThrow(/before is required/);
    expect(() => applyOperation(parseSource(source), {
      type: 'patchNodeContent', id: 'planning',
      changes: [{ path: 'task.executor.kind', before: null, after: 'code' }],
    })).toThrow(/Unsupported content change path/);
  });

  it('rejects invalid, unknown, orphaned, and oversized semantic metadata', async () => {
    const source = await fs.readFile(demoUrl, 'utf8');
    expect(() => parseSource(`${source}\n  %% mlc-task: planning|{"unknown":true}\n`)).toThrow(/Unsupported node task field/);
    expect(() => parseSource(`${source}\n  %% mlc-task: planning|{"executor":{"kind":"human","effort":"high"}}\n`))
      .toThrow(/only for llm/);
    expect(() => parseSource(`${source}\n  %% mlc-task: planning|{"executor":{"kind":"jev","language":"ko"}}\n`))
      .toThrow(/must be en/);
    expect(() => parseSource(`${source}\n  %% mlc-workflow: absent|{"mode":"sequence"}\n`))
      .toThrow(/undeclared node/);
    expect(() => parseSource(`${source}\n  %% mlc-workflow: planning|{"mode":"waterfall"}\n`))
      .toThrow(/Invalid node workflow mode/);
    expect(() => applyOperation(parseSource(source), {
      type: 'setNodeTask', id: 'planning', task: { logic: 'x'.repeat(4_001) },
    })).toThrow(/at most 4000/);
  });

  it('preserves metadata across partial edits, subtree restore, reparenting, and sibling order changes', async () => {
    const original = parseSource(await fs.readFile(demoUrl, 'utf8'));
    const enriched = applyOperation(original, {
      type: 'setNodeTask', id: 'stage1', task: { inputs: '원본', outputs: '분석', executor: { kind: 'code' } },
    });
    enriched.nodes.find(({ id }) => id === 'stage1').proposal = { reason: '구조 개선', executor: { kind: 'human' } };
    const renamed = applyOperation(enriched, { type: 'renameNode', id: 'stage1', label: '1. 분석 수정' });
    expect(renamed.nodes.find(({ id }) => id === 'stage1').task).toEqual(enriched.nodes.find(({ id }) => id === 'stage1').task);

    const reordered = applyOperation(renamed, {
      type: 'setChildOrder', id: 'stages', childIds: ['stage15', 'stage1'],
    });
    expect(reordered.nodes.filter(({ parentId }) => parentId === 'stages').map(({ id }) => id))
      .toEqual(['stage15', 'stage1']);
    expect(() => applyOperation(reordered, {
      type: 'setChildOrder', id: 'stages', childIds: ['stage15'],
    })).toThrow(/every direct child/);

    const moved = applyOperation(reordered, { type: 'moveNode', id: 'stage1', parentId: 'shortform' });
    const deleted = applyOperation(moved, { type: 'deleteSubtrees', ids: ['stage1'] });
    const restored = applyOperation(deleted, {
      type: 'restoreNodes',
      nodes: [moved.nodes.find(({ id }) => id === 'stage1')],
      order: moved.nodes.map(({ id }) => id),
    });
    expect(parseSource(writeSource(restored))).toEqual(moved);
    expect(restored.nodes.find(({ id }) => id === 'stage1').task).toEqual(enriched.nodes.find(({ id }) => id === 'stage1').task);
    expect(restored.nodes.find(({ id }) => id === 'stage1').proposal).toEqual(enriched.nodes.find(({ id }) => id === 'stage1').proposal);
  });

  it('appends incoming nodes to explicit sequences and supports exact order restoration', async () => {
    const original = parseSource(await fs.readFile(demoUrl, 'utf8'));
    const sequenced = applyOperation(original, {
      type: 'setNodeWorkflow', id: 'stages', workflow: { mode: 'sequence' },
    });
    const originalOrder = sequenced.nodes.map(({ id }) => id);

    const moved = applyOperation(sequenced, { type: 'moveNode', id: 'planning', parentId: 'stages' });
    expect(moved.nodes.filter(({ parentId }) => parentId === 'stages').map(({ id }) => id))
      .toEqual(['stage1', 'stage15', 'planning']);

    const restored = applyOperation(moved, {
      type: 'moveNode', id: 'planning', parentId: 'live', order: originalOrder,
    });
    expect(restored.nodes.map(({ id }) => id)).toEqual(originalOrder);
    expect(restored).toEqual(sequenced);
    expect(() => applyOperation(moved, {
      type: 'moveNode', id: 'planning', parentId: 'live', order: originalOrder.slice(1),
    })).toThrow(/every node exactly once/);
  });

  it('appends multiple incoming sequence children in operation item order', async () => {
    const original = parseSource(await fs.readFile(demoUrl, 'utf8'));
    const sequenced = applyOperation(original, {
      type: 'setNodeWorkflow', id: 'stages', workflow: { mode: 'sequence' },
    });
    const moved = applyOperation(sequenced, {
      type: 'moveNodes',
      items: [
        { id: 'original', parentId: 'stages' },
        { id: 'planning', parentId: 'stages' },
      ],
    });
    expect(moved.nodes.filter(({ parentId }) => parentId === 'stages').map(({ id }) => id))
      .toEqual(['stage1', 'stage15', 'original', 'planning']);
  });
});
