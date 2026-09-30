import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMapStore } from '../lib/store.mjs';
import { createApiApp } from '../server/app.mjs';

let root;
let store;
let app;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mlc-api-'));
  await fs.mkdir(path.join(root, 'maps'));
  await fs.copyFile(new URL('../maps/demo.mmd', import.meta.url), path.join(root, 'maps/demo.mmd'));
  store = await createMapStore({ projectRoot: root, mapPath: 'maps/demo.mmd', watchFiles: false });
  app = createApiApp(store);
});
afterEach(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });

describe('local collaboration API', () => {
  it('returns snapshots, health, and bounded subtrees', async () => {
    const snapshot = await request(app).get('/api/map').expect(200);
    expect(snapshot.body.graph.nodes.length).toBeGreaterThan(0);
    expect((await request(app).get('/api/health').expect(200)).body).toMatchObject({ ok: true, sourceValid: true });
    const subtree = await request(app).get('/api/subtree/live?depth=1').expect(200);
    const expectedChildren = snapshot.body.graph.nodes
      .filter(({ parentId }) => parentId === 'live')
      .map(({ id }) => id);
    expect(subtree.body.root.children.map(({ id }) => id)).toEqual(expectedChildren);
    expect(subtree.body.root.children.every((child) => !('children' in child))).toBe(true);
  });

  it('returns 409 with the fresh snapshot and 422 for invalid operations', async () => {
    const snapshot = (await request(app).get('/api/map')).body;
    const changed = await request(app).post('/api/mutations').send({ baseRevision: snapshot.revision, clientId: 'one',
      operation: { type: 'renameNode', id: 'planning', label: '새 이름' } }).expect(200);
    const conflict = await request(app).post('/api/mutations').send({ baseRevision: snapshot.revision, clientId: 'two',
      operation: { type: 'renameNode', id: 'planning', label: '낡은 수정' } }).expect(409);
    expect(conflict.body).toMatchObject({ code: 'revision_conflict', snapshot: { revision: changed.body.revision } });

    const invalid = await request(app).post('/api/mutations').send({ baseRevision: changed.body.revision, clientId: 'one',
      operation: { type: 'moveNode', id: 'live', parentId: 'stage1' } }).expect(422);
    expect(invalid.body.code).toBe('validation_error');
  });

  it('returns a field-conflict 409 with guarded fields and the current snapshot', async () => {
    const snapshot = (await request(app).get('/api/map')).body;
    const changed = await request(app).post('/api/mutations').send({
      baseRevision: snapshot.revision,
      clientId: 'first-editor',
      operation: {
        type: 'patchNodeContent', id: 'planning',
        changes: [{ path: 'task.outputs', before: null, after: '첫 결과' }],
      },
    }).expect(200);
    const conflict = await request(app).post('/api/mutations').send({
      baseRevision: snapshot.revision,
      clientId: 'second-editor',
      operation: {
        type: 'patchNodeContent', id: 'planning',
        changes: [{ path: 'task.outputs', before: null, after: '두 번째 결과' }],
      },
    }).expect(409);
    expect(conflict.body).toMatchObject({
      code: 'field_conflict', details: { fields: ['task.outputs'] },
      snapshot: { revision: changed.body.revision },
    });
  });

  it('updates the view sidecar without changing the semantic revision', async () => {
    const snapshot = (await request(app).get('/api/map')).body;
    const response = await request(app).put('/api/view').send({ baseRevision: snapshot.revision, clientId: 'canvas',
      patch: { positions: { live: { x: 10, y: 20 } }, collapsedIds: ['live'] } }).expect(200);
    expect(response.body.revision).toBe(snapshot.revision);
    expect(response.body.view).toMatchObject({ positions: { live: { x: 10, y: 20 } }, collapsedIds: ['live'] });
  });

  it('persists task and workflow operations through the revision-checked API', async () => {
    const snapshot = (await request(app).get('/api/map')).body;
    const withTask = await request(app).post('/api/mutations').send({
      baseRevision: snapshot.revision,
      clientId: 'contract-test',
      operation: {
        type: 'setNodeTask', id: 'planning',
        task: { condition: '승인 | 보류', executor: { kind: 'llm', model: 'design-model', effort: 'medium' } },
      },
    }).expect(200);
    const withWorkflow = await request(app).post('/api/mutations').send({
      baseRevision: withTask.body.revision,
      clientId: 'contract-test',
      operation: { type: 'setNodeWorkflow', id: 'planning', workflow: { mode: 'sequence' } },
    }).expect(200);

    expect(withWorkflow.body.graph.nodes.find(({ id }) => id === 'planning')).toMatchObject({
      task: { condition: '승인 | 보류', executor: { kind: 'llm', model: 'design-model', effort: 'medium' } },
      workflow: { mode: 'sequence' },
    });
    const invalid = await request(app).post('/api/mutations').send({
      baseRevision: withWorkflow.body.revision,
      clientId: 'contract-test',
      operation: { type: 'setNodeTask', id: 'planning', task: { executor: { kind: 'human', effort: 'high' } } },
    }).expect(422);
    expect(invalid.body.code).toBe('validation_error');
  });

  it('persists map settings with exact revision checks and allows explicit removal', async () => {
    const snapshot = (await request(app).get('/api/map')).body;
    expect(snapshot.graph).not.toHaveProperty('settings');

    const configured = await request(app).post('/api/mutations').send({
      baseRevision: snapshot.revision,
      clientId: 'settings-editor',
      operation: {
        type: 'setMapSettings',
        settings: { optionalFields: ['executor', 'condition'] },
      },
    }).expect(200);
    expect(configured.body.graph.settings).toEqual({ optionalFields: ['executor', 'condition'] });
    const subtree = await request(app).get('/api/subtree/direction?depth=0').expect(200);
    expect(subtree.body.settings).toEqual({ optionalFields: ['executor', 'condition'] });

    const stale = await request(app).post('/api/mutations').send({
      baseRevision: snapshot.revision,
      clientId: 'stale-settings-editor',
      operation: { type: 'setMapSettings', settings: { optionalFields: [] } },
    }).expect(409);
    expect(stale.body).toMatchObject({
      code: 'revision_conflict', snapshot: { revision: configured.body.revision },
    });

    const removed = await request(app).post('/api/mutations').send({
      baseRevision: configured.body.revision,
      clientId: 'settings-editor',
      operation: { type: 'setMapSettings', settings: null },
    }).expect(200);
    expect(removed.body.graph).not.toHaveProperty('settings');
  });

  it('creates and guarded-patches reference roots while preserving node content', async () => {
    const snapshot = (await request(app).get('/api/map')).body;
    const added = await request(app).post('/api/mutations').send({
      baseRevision: snapshot.revision,
      clientId: 'reference-editor',
      operation: {
        type: 'addNode', id: 'sources', parentId: 'direction', label: '출처와 버전',
        shape: 'rectangle', category: 'focus', section: 'reference',
        task: { outputs: '검증된 링크' }, proposal: { reason: '근거 분리' },
      },
    }).expect(200);
    expect(added.body.graph.nodes.find(({ id }) => id === 'sources')).toMatchObject({
      parentId: 'direction', section: 'reference', task: { outputs: '검증된 링크' },
      proposal: { reason: '근거 분리' },
    });

    const unrelated = await request(app).post('/api/mutations').send({
      baseRevision: added.body.revision,
      clientId: 'other-editor',
      operation: { type: 'renameNode', id: 'stage1', label: '1. 분석 유지' },
    }).expect(200);
    const undo = {
      baseRevision: added.body.revision,
      clientId: 'reference-editor',
      operation: {
        type: 'patchNodeContent', id: 'sources',
        changes: [{ path: 'section', before: 'reference', after: null }],
      },
    };
    const untagged = await request(app).post('/api/mutations').send(undo).expect(200);
    expect(untagged.body.graph.nodes.find(({ id }) => id === 'stage1').label).toBe('1. 분석 유지');
    expect(untagged.body.graph.nodes.find(({ id }) => id === 'sources')).toMatchObject({
      task: { outputs: '검증된 링크' }, proposal: { reason: '근거 분리' },
    });
    expect(untagged.body.graph.nodes.find(({ id }) => id === 'sources')).not.toHaveProperty('section');
    const retried = await request(app).post('/api/mutations').send(undo).expect(200);
    expect(retried.body.revision).toBe(untagged.body.revision);
    expect(retried.body.revision).not.toBe(unrelated.body.revision);
  });

  it('reads a fresh valid disk edit even when file watching is disabled', async () => {
    const mapPath = path.join(root, 'maps/demo.mmd');
    const source = await fs.readFile(mapPath, 'utf8');
    await fs.writeFile(mapPath, source.replace('planning["기획"]', 'planning["즉시 반영"]'));

    const response = await request(app).get('/api/map').expect(200);
    expect(response.body.origin).toBe('external');
    expect(response.body.graph.nodes.find(({ id }) => id === 'planning').label).toBe('즉시 반영');
  });
});
