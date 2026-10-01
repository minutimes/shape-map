import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSource, writeSource } from '../lib/format.mjs';
import { compareTurnGraphs, getBlockState, nodeFingerprint } from '../lib/shape.mjs';
import { sha256Hex } from '../lib/sha256.mjs';
import { createMapStore } from '../lib/store.mjs';
import { createApiApp } from '../server/app.mjs';

const demoUrl = new URL('../maps/demo.mmd', import.meta.url);
const cleanups = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shape-backend-'));
  await fs.mkdir(path.join(root, 'maps'));
  await fs.copyFile(demoUrl, path.join(root, 'maps/demo.mmd'));
  const store = await createMapStore({ projectRoot: root, mapPath: 'maps/demo.mmd', watchFiles: false });
  cleanups.push(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, app: createApiApp(store) };
}

afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

describe('Shape collaboration backend', () => {
  it('uses one browser-ready deterministic SHA-256 implementation', async () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const sources = await Promise.all([
      fs.readFile(new URL('../lib/sha256.mjs', import.meta.url), 'utf8'),
      fs.readFile(new URL('../lib/shape.mjs', import.meta.url), 'utf8'),
    ]);
    expect(sources.join('\n')).not.toMatch(/from ['"]node:/);
  });

  it('keeps legacy maps free of fabricated state and round-trips blocks and immutable turns', async () => {
    const source = await fs.readFile(demoUrl, 'utf8');
    const legacy = parseSource(source);
    expect(legacy).not.toHaveProperty('turns');
    expect(legacy.nodes.every((node) => !Object.hasOwn(node, 'block'))).toBe(true);
    expect(parseSource(writeSource(legacy))).toEqual(legacy);

    const { store, root } = await fixture();
    let snapshot = store.getSnapshot();
    snapshot = await store.mutate({
      baseRevision: snapshot.revision,
      clientId: 'reviewer',
      operation: { type: 'setBlock', id: 'planning', block: { summary: '검토 범위', files: ['lib/a.mjs'], status: 'verified' } },
    });
    snapshot = await store.mutate({
      baseRevision: snapshot.revision,
      clientId: 'reviewer',
      operation: { type: 'addComment', id: 'planning', body: '사람이 확인함', kind: 'note', author: '평일' },
    });
    snapshot = await store.mutate({
      baseRevision: snapshot.revision,
      clientId: 'reviewer',
      operation: { type: 'createTurn', title: '첫 검토', summary: '현재 실제 상태' },
    });

    const reopened = parseSource(await fs.readFile(path.join(root, 'maps/demo.mmd'), 'utf8'));
    expect(reopened.turns).toHaveLength(1);
    expect(reopened.turns[0].nodes.find(({ id }) => id === 'planning').block).toMatchObject({
      status: 'verified', summary: '검토 범위', comments: [{ body: '사람이 확인함', author: '평일' }],
    });
    expect(reopened.turns[0]).not.toHaveProperty('turns');
    expect(writeSource(reopened)).toContain('%% sm-turn:');
  });

  it('derives concern, planned, verified, and prior-turn change states without treating comments as semantic changes', async () => {
    const { store } = await fixture();
    let snapshot = store.getSnapshot();
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'reviewer',
      operation: { type: 'setBlock', id: 'planning', block: { status: 'verified' } } });
    let node = snapshot.graph.nodes.find(({ id }) => id === 'planning');
    expect(getBlockState(snapshot.graph, node).status).toBe('verified');

    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'editor',
      operation: { type: 'setBlock', id: 'planning', block: { summary: '설명이 바뀜' } } });
    node = snapshot.graph.nodes.find(({ id }) => id === 'planning');
    expect(node.block).toMatchObject({ status: 'neutral', summary: '설명이 바뀜' });
    expect(node.block).not.toHaveProperty('review');
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'reviewer',
      operation: { type: 'setBlock', id: 'planning', block: { status: 'verified' } } });
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'reviewer',
      operation: { type: 'createTurn', title: '설명 기준' } });
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'editor',
      operation: { type: 'setBlock', id: 'planning', block: { summary: '다음 설명' } } });
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'reviewer',
      operation: { type: 'createTurn', title: '설명 변경' } });
    node = snapshot.graph.nodes.find(({ id }) => id === 'planning');
    expect(getBlockState(snapshot.graph, node)).toMatchObject({ status: 'changed', changedSinceBaseline: true });
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'reviewer',
      operation: { type: 'setBlock', id: 'planning', block: { status: 'verified' } } });

    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'editor',
      operation: { type: 'renameNode', id: 'planning', label: '기획 변경' } });
    node = snapshot.graph.nodes.find(({ id }) => id === 'planning');
    expect(node.block).toMatchObject({ status: 'neutral' });
    expect(node.block).not.toHaveProperty('review');

    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'editor',
      operation: { type: 'setProposal', id: 'planning', proposal: { logic: '새 로직' } } });
    node = snapshot.graph.nodes.find(({ id }) => id === 'planning');
    expect(getBlockState(snapshot.graph, node).status).toBe('planned');
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'reviewer',
      operation: { type: 'addComment', id: 'planning', body: '근거가 부족함', kind: 'concern', author: '평일' } });
    node = snapshot.graph.nodes.find(({ id }) => id === 'planning');
    expect(getBlockState(snapshot.graph, node)).toMatchObject({ status: 'planned', unresolvedCount: 1, concernCount: 1 });
    const commentId = node.block.comments[0].id;
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'reviewer',
      operation: { type: 'resolveComment', id: 'planning', commentId } });
    expect(getBlockState(snapshot.graph, snapshot.graph.nodes.find(({ id }) => id === 'planning')).status).toBe('planned');

    const beforeComment = structuredClone(snapshot.graph);
    const afterComment = structuredClone(snapshot.graph);
    afterComment.nodes.find(({ id }) => id === 'planning').block.comments.push({
      id: 'comment-extra', body: '메모', kind: 'note', author: '평일', createdAt: new Date().toISOString(),
    });
    expect(compareTurnGraphs(beforeComment, afterComment)).toEqual({ addedIds: [], changedIds: [], removedIds: [] });
  });

  it('marks new baseline nodes changed and limits category changes to nodes using that category', async () => {
    const graph = parseSource(await fs.readFile(demoUrl, 'utf8'));
    const baseline = structuredClone(graph);
    const added = {
      id: 'newFeature', label: '새 기능', parentId: graph.nodes[0].id,
      shape: 'rectangle', category: graph.categories[0].id, layout: { mode: 'fit' },
    };
    graph.nodes.push(added);
    expect(getBlockState(graph, added, baseline)).toMatchObject({ status: 'changed', changedSinceBaseline: true });

    const categoryBefore = structuredClone(baseline);
    const categoryAfter = structuredClone(baseline);
    const changedCategory = categoryAfter.categories[0];
    changedCategory.fill = changedCategory.fill === '#FFFFFF' ? '#EEEEEE' : '#FFFFFF';
    const expected = categoryAfter.nodes.filter((node) => node.category === changedCategory.id).map(({ id }) => id);
    const comparison = compareTurnGraphs(categoryBefore, categoryAfter);
    expect(comparison.changedIds).toEqual(expected);
    expect(comparison.changedIds.length).toBeLessThan(categoryAfter.nodes.length);
  });

  it('applies a proposal, marks only replayed turn deltas blue, and rejects stale turn creation', async () => {
    const { store } = await fixture();
    let snapshot = store.getSnapshot();
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'editor',
      operation: { type: 'createTurn', title: '기준' } });
    expect(getBlockState(snapshot.graph, snapshot.graph.nodes[0]).status).not.toBe('changed');
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'editor',
      operation: { type: 'setProposal', id: 'planning', proposal: { outputs: '새 결과', reason: '변경 이유' } } });
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'editor',
      operation: { type: 'applyProposal', id: 'planning' } });
    expect(snapshot.graph.nodes.find(({ id }) => id === 'planning')).toMatchObject({ task: { outputs: '새 결과' } });
    expect(snapshot.graph.nodes.find(({ id }) => id === 'planning')).not.toHaveProperty('proposal');
    const staleRevision = snapshot.revision;
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'editor',
      operation: { type: 'createTurn', title: '적용 완료' } });
    expect(getBlockState(snapshot.graph, snapshot.graph.nodes.find(({ id }) => id === 'planning')).status).toBe('changed');
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'editor',
      operation: { type: 'renameNode', id: 'planning', label: '기록 뒤 수정' } });
    expect(getBlockState(snapshot.graph, snapshot.graph.nodes.find(({ id }) => id === 'planning')).status).not.toBe('changed');
    await expect(store.mutate({ baseRevision: staleRevision, clientId: 'stale',
      operation: { type: 'createTurn', title: '낡은 기록' } })).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('serves a copyable Korean brief and persists independent shape canvas state', async () => {
    const { app } = await fixture();
    let snapshot = (await request(app).get('/api/map').expect(200)).body;
    snapshot = (await request(app).post('/api/mutations').send({
      baseRevision: snapshot.revision, clientId: 'reviewer',
      operation: { type: 'addComment', id: 'planning', body: '결정 필요', kind: 'concern', author: '평일' },
    }).expect(200)).body;
    const brief = (await request(app).get('/api/brief').expect(200)).body;
    expect(brief).toMatchObject({ mapPath: 'maps/demo.mmd', revision: snapshot.revision });
    expect(brief.text).toContain('[planning] 기획');
    expect(brief.text).toContain('검토 필요: 결정 필요 (평일)');

    const view = (await request(app).put('/api/view').send({
      baseRevision: snapshot.revision, clientId: 'shape-canvas',
      patch: { shape: { positions: { planning: { x: 11, y: 22 }, absent: { x: 1, y: 2 } }, collapsedIds: ['planning'], viewport: { x: 3, y: 4, zoom: 1.2 } } },
    }).expect(200)).body.view;
    expect(view.shape).toEqual({
      positions: { planning: { x: 11, y: 22 } }, collapsedIds: ['planning'], viewport: { x: 3, y: 4, zoom: 1.2 },
    });
  });

  it('exports object-specific human notes and proposals for AI with their saved hierarchy', async () => {
    const { store } = await fixture(); let snapshot = store.getSnapshot();
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'owner', operation: { type: 'addComment', id: 'planning', body: '이 기능은 결과부터 보여 주세요.', kind: 'change', author: '사람' } });
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'owner', operation: { type: 'setProposal', id: 'planning', proposal: { reason: '구성을 읽기 어렵습니다.', logic: '기능 안의 카드를 가로로 보여줍니다.' } } });
    snapshot = await store.mutate({ baseRevision: snapshot.revision, clientId: 'owner', operation: { type: 'addComment', id: 'live', body: '다른 영역의 메모', kind: 'note', author: '사람' } });
    const app = createApiApp(store);
    const brief = (await request(app).get('/api/brief?focus=planning').expect(200)).body;
    expect(brief.revision).toBe(snapshot.revision);
    expect(brief.text).toContain('논의할 기능: [planning]');
    expect(brief.text).toContain('소속:');
    expect(brief.text).toContain('개선 의견: 이 기능은 결과부터 보여 주세요. (사람)');
    expect(brief.text).toContain('구성을 읽기 어렵습니다.');
    expect(brief.text).toContain('기능 안의 카드를 가로로 보여줍니다.');
    expect(brief.text).not.toContain('다른 영역의 메모');
    expect(store.getSnapshot().revision).toBe(snapshot.revision);
    await request(app).get('/api/brief?focus=absent').expect(422);
    await request(app).get('/api/brief?focus=planning&focus=live').expect(422);
  });

  it('guards explicit form saves by semantic fingerprint while allowing unrelated fresh-CAS changes', async () => {
    const { store } = await fixture();
    let snapshot = store.getSnapshot();
    const planning = snapshot.graph.nodes.find(({ id }) => id === 'planning');
    const formFingerprint = nodeFingerprint(planning, snapshot.graph);

    snapshot = await store.mutate({
      baseRevision: snapshot.revision,
      clientId: 'external-ai',
      operation: { type: 'setProposal', id: 'planning', proposal: { logic: '외부 제안' } },
    });
    await expect(store.mutate({
      baseRevision: snapshot.revision,
      clientId: 'open-form',
      operation: {
        type: 'setBlock', id: 'planning', label: '숨은 덮어쓰기',
        block: { summary: '오래된 초안' }, expectedFingerprint: formFingerprint,
      },
    })).rejects.toMatchObject({
      code: 'field_conflict',
      details: { id: 'planning', currentNode: { proposal: { logic: '외부 제안' } } },
    });

    const currentPlanning = snapshot.graph.nodes.find(({ id }) => id === 'planning');
    const freshFingerprint = nodeFingerprint(currentPlanning, snapshot.graph);
    snapshot = await store.mutate({
      baseRevision: snapshot.revision,
      clientId: 'other-editor',
      operation: { type: 'renameNode', id: 'stage1', label: '관계없는 변경' },
    });
    snapshot = await store.mutate({
      baseRevision: snapshot.revision,
      clientId: 'open-form',
      operation: {
        type: 'setBlock', id: 'planning', label: '기획 개요',
        block: { summary: '저장된 설명', files: ['lib/shape.mjs'] }, expectedFingerprint: freshFingerprint,
      },
    });
    expect(snapshot.graph.nodes.find(({ id }) => id === 'planning')).toMatchObject({
      label: '기획 개요', proposal: { logic: '외부 제안' },
      block: { summary: '저장된 설명', files: ['lib/shape.mjs'] },
    });
    expect(snapshot.graph.nodes.find(({ id }) => id === 'stage1').label).toBe('관계없는 변경');

    const beforeSummaryChange = nodeFingerprint(
      snapshot.graph.nodes.find(({ id }) => id === 'planning'), snapshot.graph,
    );
    snapshot = await store.mutate({
      baseRevision: snapshot.revision,
      clientId: 'external-ai',
      operation: {
        type: 'setBlock', id: 'planning',
        block: { summary: '외부에서 바뀐 설명', files: ['lib/graph.mjs'] },
      },
    });
    await expect(store.mutate({
      baseRevision: snapshot.revision,
      clientId: 'open-proposal-form',
      operation: {
        type: 'setProposal', id: 'planning', proposal: { logic: '오래된 제안' },
        expectedFingerprint: beforeSummaryChange,
      },
    })).rejects.toMatchObject({ code: 'field_conflict', details: { id: 'planning' } });
    await expect(store.mutate({
      baseRevision: snapshot.revision,
      clientId: 'open-title-form',
      operation: {
        type: 'renameNode', id: 'planning', label: '오래된 제목', expectedFingerprint: beforeSummaryChange,
      },
    })).rejects.toMatchObject({ code: 'field_conflict', details: { id: 'planning' } });
  });

  it('strictly rejects malformed block and turn metadata and dangling references', async () => {
    const source = await fs.readFile(demoUrl, 'utf8');
    expect(() => parseSource(`${source}\n%% sm-block: absent|{}\n`)).toThrow(/undeclared node/);
    expect(() => parseSource(`${source}\n%% sm-block: planning|{"unknown":true}\n`)).toThrow(/Unsupported node block field/);
    expect(() => parseSource(`${source}\n%% sm-turn: {"id":"t","number":1,"title":"x","createdAt":"bad","revision":"r","nodes":[],"categories":[]}\n`))
      .toThrow(/must contain nodes/);
  });
});
