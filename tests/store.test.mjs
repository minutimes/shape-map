import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMapStore, resolveMapPath } from '../lib/store.mjs';
import { shapeHistoryEntry, shapeViewHistoryEntry } from '../src/shapeEditing.js';

const demoUrl = new URL('../maps/demo.mmd', import.meta.url);
const cleanups = [];

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mlc-store-'));
  await fs.mkdir(path.join(root, 'maps'));
  await fs.copyFile(demoUrl, path.join(root, 'maps/demo.mmd'));
  const store = await createMapStore({ projectRoot: root, mapPath: 'maps/demo.mmd', watchFiles: options.watchFiles ?? false });
  cleanups.push(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, mapPath: path.join(root, 'maps/demo.mmd') };
}

afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

describe('MapStore', () => {
  it('persists responsive placements, rejects cycles, and restores references removed by deletion', async () => {
    const { store, root, mapPath } = await fixture(); const before = store.getSnapshot(); const source = await fs.readFile(mapPath, 'utf8');
    const anchors = { shortform: { x: { id: 'live', edge: 'right', offset: 35 }, y: { ids: ['live'], edge: 'top', offset: 0 } } };
    const next = await store.updateView({ baseRevision: before.revision, clientId: 'placement', patch: { shape: { layoutVersion: 3, anchors } } });
    expect(next.view.shape.anchors).toEqual(anchors); expect(next.revision).toBe(before.revision); expect(await fs.readFile(mapPath, 'utf8')).toBe(source);
    await expect(store.updateView({ baseRevision: next.revision, clientId: 'invalid', patch: { shape: { anchors: { live: { x: { id: 'shortform', edge: 'left', offset: 0 } } } } } })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(store.updateView({ baseRevision: next.revision, clientId: 'invalid', patch: { shape: { anchors: { shortform: { x: { id: 'planning', edge: 'right', offset: 0 } } } } } })).rejects.toMatchObject({ code: 'validation_error' });
    const entry = shapeHistoryEntry({ type: 'deleteSubtrees', ids: ['live'] }, next);
    const deleted = await store.mutate({ baseRevision: next.revision, clientId: 'placement', operation: entry.redo });
    expect(deleted.view.shape.anchors).toEqual({});
    const restored = await store.mutate({ baseRevision: deleted.revision, clientId: 'placement', operation: entry.undo });
    await store.updateView({ baseRevision: restored.revision, clientId: 'placement', patch: { shape: { anchors } } });
    const reopened = await createMapStore({ projectRoot: root, mapPath: 'maps/demo.mmd', watchFiles: false });
    expect(reopened.getSnapshot().view.shape.anchors).toEqual(anchors); await reopened.close();
    const removed = await store.updateView({ baseRevision: restored.revision, clientId: 'undo', patch: { shape: { anchors: { shortform: null } } } });
    expect(removed.view.shape.anchors).toEqual({});
  });
  it('persists mixed folds, creation, movement, resizing, and deletion in reversible edit order', async () => {
    const { store, root, mapPath } = await fixture();
    const clientId = 'mixed-canvas-history';
    let current = await store.updateView({ baseRevision: store.getSnapshot().revision, clientId,
      patch: { shape: { layoutVersion: 3, collapsedIds: ['stages'], positions: {}, sizes: {}, viewport: { x: 17, y: 29, zoom: .75 } } } });
    const source = await fs.readFile(mapPath, 'utf8');
    const checkpoints = [current]; const entries = [];
    const apply = async (entry, direction) => {
      for (const operation of [entry[direction]].filter(Boolean)) current = await store.mutate({ baseRevision: current.revision, clientId, operation });
      if (entry[`${direction}View`]) current = await store.updateView({ baseRevision: current.revision, clientId, patch: entry[`${direction}View`] });
    };
    const record = async (entry) => { await apply(entry, 'redo'); entries.push(entry); checkpoints.push(current); };
    await record(shapeViewHistoryEntry({ collapsedIds: [] }, { collapsedIds: ['stages'] }, 'stages'));
    expect(await fs.readFile(mapPath, 'utf8')).toBe(source);
    await record(shapeHistoryEntry({ type: 'addNode', id: 'history-note', parentId: 'shortform', label: '의견', shape: 'rectangle', category: current.graph.nodes.find(n => n.id === 'shortform').category }, current));
    await record(shapeViewHistoryEntry({ positions: { 'history-note': { x: 330, y: 200 } } }, { positions: { 'history-note': null } }));
    await record(shapeViewHistoryEntry({ sizes: { live: { width: 1500, height: 900 } } }, { sizes: { live: null } }));
    const deletion = shapeHistoryEntry({ type: 'deleteSubtrees', ids: ['history-note'] }, current);
    deletion.undoView = { shape: { positions: { 'history-note': current.view.shape.positions['history-note'] }, collapsedIds: current.view.shape.collapsedIds } };
    await record(deletion);
    for (let i = entries.length - 1; i >= 0; i--) {
      await apply(entries[i], 'undo');
      expect(current.graph).toEqual(checkpoints[i].graph); expect(current.view.shape).toEqual(checkpoints[i].view.shape);
    }
    for (let i = 0; i < entries.length; i++) {
      await apply(entries[i], 'redo');
      expect(current.graph).toEqual(checkpoints[i + 1].graph); expect(current.view.shape).toEqual(checkpoints[i + 1].view.shape);
    }
    const reopened = await createMapStore({ projectRoot: root, mapPath: 'maps/demo.mmd', watchFiles: false });
    expect(reopened.getSnapshot().graph).toEqual(current.graph); expect(reopened.getSnapshot().view.shape).toEqual(current.view.shape);
    await reopened.close();
  });
  it('saves section size and nested placement independently, reopens them and supports undo removal', async () => {
    const { root, store, mapPath } = await fixture(); const before = store.getSnapshot(); const source = await fs.readFile(mapPath, 'utf8');
    const updated = await store.updateView({ baseRevision: before.revision, clientId: 'studio', patch: { shape: { layoutVersion: 3, sizes: { planning: { width: 850, height: 480 } }, positions: { planning: { x: 320, y: 100 } } } } });
    expect(updated.revision).toBe(before.revision); expect(await fs.readFile(mapPath, 'utf8')).toBe(source);
    const reopened = await createMapStore({ projectRoot: root, mapPath: 'maps/demo.mmd', watchFiles: false });
    expect(reopened.getSnapshot().view.shape).toEqual(updated.view.shape); await reopened.close();
    await expect(store.updateView({ baseRevision: before.revision, clientId: 'invalid', patch: { shape: { sizes: { planning: { width: 10, height: 500 } } } } })).rejects.toMatchObject({ code: 'validation_error' });
    expect(store.getSnapshot().view.shape.sizes).toEqual(updated.view.shape.sizes);
    const undone = await store.updateView({ baseRevision: before.revision, clientId: 'undo', patch: { shape: { sizes: { planning: null }, positions: { planning: null } } } });
    expect(undone.view.shape.sizes).toEqual({}); expect(undone.view.shape.positions).toEqual({});
  });
  it('migrates a vertical composition view independently of the canonical map and other editor navigation', async () => {
    const { store, mapPath } = await fixture(); const before = store.getSnapshot(); const source = await fs.readFile(mapPath, 'utf8');
    await store.updateView({ baseRevision: before.revision, clientId: 'old', patch: {
      positions: { live: { x: 12, y: 34 } }, shape: { layoutVersion: 2, positions: { live: { x: 100, y: 200 } }, collapsedIds: ['live'], viewport: { x: 3, y: 4, zoom: .7 } },
    } });
    const next = await store.updateView({ baseRevision: before.revision, clientId: 'horizontal', patch: { shape: { layoutVersion: 3 } } });
    expect(next.view.shape).toEqual({ layoutVersion: 3 });
    expect(next.view.positions).toEqual({ live: { x: 12, y: 34 } });
    expect(next.revision).toBe(before.revision); expect(await fs.readFile(mapPath, 'utf8')).toBe(source);
  });
  it('upgrades nested canvas navigation without retaining obsolete placement or changing source', async () => {
    const { store } = await fixture(); const before = store.getSnapshot();
    await store.updateView({ baseRevision: before.revision, clientId: 'old-canvas', patch: {
      positions: { live: { x: 12, y: 34 } }, viewport: { x: 5, y: 6, zoom: .7 },
      shape: { positions: { live: { x: 5000, y: 8000 } }, viewport: { x: -900, y: -1500, zoom: .2 } },
    } });
    const upgraded = await store.updateView({ baseRevision: before.revision, clientId: 'nested-canvas', patch: { shape: { layoutVersion: 2, collapsedIds: ['live'] } } });
    expect(upgraded.revision).toBe(before.revision);
    expect(upgraded.view).toMatchObject({ positions: { live: { x: 12, y: 34 } }, viewport: { x: 5, y: 6, zoom: .7 }, shape: { layoutVersion: 2, collapsedIds: ['live'] } });
    expect(upgraded.view.shape).not.toHaveProperty('viewport');
    expect(upgraded.view.shape).not.toHaveProperty('positions');
  });
  it('rejects stale revisions and preserves unrelated nodes during a mutation', async () => {
    const { store, mapPath } = await fixture();
    const before = store.getSnapshot();
    const after = await store.mutate({ baseRevision: before.revision, clientId: 'test',
      operation: { type: 'renameNode', id: 'planning', label: '기획 수정' } });

    expect(after.revision).not.toBe(before.revision);
    expect(after.graph.nodes.find(({ id }) => id === 'planning').label).toBe('기획 수정');
    expect(after.graph.nodes.find(({ id }) => id === 'stage1')).toEqual(before.graph.nodes.find(({ id }) => id === 'stage1'));
    expect(await fs.readFile(mapPath, 'utf8')).toContain('planning["기획 수정"]');
    await expect(store.mutate({ baseRevision: before.revision, clientId: 'stale',
      operation: { type: 'renameNode', id: 'planning', label: '덮어쓰기' } })).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('merges stale guarded edits to different fields and rejects same-field conflicts atomically', async () => {
    const { store, mapPath } = await fixture();
    const initial = store.getSnapshot();
    const logicEdit = {
      type: 'patchNodeContent', id: 'planning',
      changes: [{ path: 'task.logic', before: null, after: '현재 로직' }],
    };
    const afterLogic = await store.mutate({ baseRevision: initial.revision, clientId: 'logic-editor', operation: logicEdit });
    const merged = await store.mutate({
      baseRevision: initial.revision,
      clientId: 'proposal-editor',
      operation: {
        type: 'patchNodeContent', id: 'planning',
        changes: [{ path: 'proposal.reason', before: null, after: '분리 제안' }],
      },
    });
    expect(merged.graph.nodes.find(({ id }) => id === 'planning')).toMatchObject({
      task: { logic: '현재 로직' }, proposal: { reason: '분리 제안' },
    });

    const sourceBeforeConflict = await fs.readFile(mapPath, 'utf8');
    await expect(store.mutate({
      baseRevision: initial.revision,
      clientId: 'stale-same-field',
      operation: {
        type: 'patchNodeContent', id: 'planning',
        changes: [
          { path: 'task.logic', before: null, after: '덮어쓰기' },
          { path: 'proposal.ui', before: null, after: '함께 저장되면 안 됨' },
        ],
      },
    })).rejects.toMatchObject({ code: 'field_conflict', details: { fields: ['task.logic'] } });
    expect(await fs.readFile(mapPath, 'utf8')).toBe(sourceBeforeConflict);
    expect(store.getSnapshot().revision).toBe(merged.revision);
    expect(afterLogic.revision).not.toBe(merged.revision);
  });

  it('treats a lost-response retry as an idempotent no-op without writing or emitting', async () => {
    const { store, mapPath } = await fixture();
    const initial = store.getSnapshot();
    const operation = {
      type: 'patchNodeContent', id: 'planning',
      changes: [{ path: 'label', before: '기획', after: '기획 수정' }],
    };
    const saved = await store.mutate({ baseRevision: initial.revision, clientId: 'autosave', operation });
    const beforeRetryStat = await fs.stat(mapPath);
    let events = 0;
    store.on('snapshot', () => { events += 1; });
    const retried = await store.mutate({ baseRevision: initial.revision, clientId: 'autosave', operation });
    const afterRetryStat = await fs.stat(mapPath);
    expect(retried).toEqual(saved);
    expect(afterRetryStat.mtimeMs).toBe(beforeRetryStat.mtimeMs);
    expect(events).toBe(0);
  });

  it('refuses to overwrite an invalid externally edited source', async () => {
    const { store, mapPath } = await fixture();
    const before = store.getSnapshot();
    const invalid = 'flowchart LR\n  %% mlc-format: 1\n  not supported\n';
    await fs.writeFile(mapPath, invalid);
    await expect(store.mutate({ baseRevision: before.revision, clientId: 'test',
      operation: { type: 'renameNode', id: 'planning', label: '금지' } })).rejects.toMatchObject({ code: 'invalid_source' });
    expect(await fs.readFile(mapPath, 'utf8')).toBe(invalid);
    expect(store.getSnapshot().graph).toEqual(before.graph);
    expect(store.getSnapshot().sourceStatus.valid).toBe(false);
  });

  it('detects valid and invalid external changes while retaining the last valid graph', async () => {
    const { store, mapPath } = await fixture({ watchFiles: true });
    const before = store.getSnapshot();
    const errorEvent = new Promise((resolve) => store.once('source-error', resolve));
    await fs.writeFile(mapPath, `${await fs.readFile(mapPath, 'utf8')}\nunsupported\n`);
    await errorEvent;
    expect(store.getSnapshot().revision).toBe(before.revision);
    expect(store.getSnapshot().sourceStatus.valid).toBe(false);

    const valid = (await fs.readFile(demoUrl, 'utf8')).replace('planning["기획"]', 'planning["외부 기획"]');
    const snapshotEvent = new Promise((resolve) => store.once('snapshot', resolve));
    await fs.writeFile(mapPath, valid);
    await snapshotEvent;
    expect(store.getSnapshot().graph.nodes.find(({ id }) => id === 'planning').label).toBe('외부 기획');
    expect(store.getSnapshot().origin).toBe('external');
  }, 10_000);

  it('stores only valid view state and serves a compact subtree', async () => {
    const { store, root } = await fixture();
    const before = store.getSnapshot();
    const after = await store.updateView({ baseRevision: before.revision, clientId: 'canvas', patch: {
      positions: { planning: { x: 12, y: 34 }, absent: { x: 1, y: 2 } },
      collapsedIds: ['stages', 'absent'], viewport: { x: 5, zoom: 1.5 },
    } });
    expect(after.revision).toBe(before.revision);
    expect(after.view).toEqual({ positions: { planning: { x: 12, y: 34 } }, collapsedIds: ['stages'], viewport: { x: 5, y: 0, zoom: 1.5 } });
    expect(JSON.parse(await fs.readFile(path.join(root, 'maps/demo.view.json'), 'utf8'))).toEqual(after.view);
    expect(store.getSubtree('stages', 1).root.children.map(({ id }) => id)).toEqual(['stage1', 'stage15']);
    await expect(store.updateView({
      baseRevision: before.revision,
      clientId: 'canvas',
      patch: { nodeLayouts: { planning: { mode: 'fixed', width: 300, height: 120 } } },
    })).rejects.toThrow(/Unsupported view patch field/);
  });

  it('merges workflow navigation independently and leaves canonical source unchanged', async () => {
    const { store, root, mapPath } = await fixture();
    const before = store.getSnapshot();
    const sourceBefore = await fs.readFile(mapPath, 'utf8');
    expect(before.view).not.toHaveProperty('workflow');

    const first = await store.updateView({
      baseRevision: before.revision,
      clientId: 'workflow-canvas',
      patch: { workflow: { collapsedIds: ['stages', 'absent'], viewport: { x: 40, y: 50, zoom: 1.25 } } },
    });
    const second = await store.updateView({
      baseRevision: before.revision,
      clientId: 'workflow-canvas',
      patch: { workflow: { viewport: { x: 72 } } },
    });

    expect(first.revision).toBe(before.revision);
    expect(second.view.workflow).toEqual({
      collapsedIds: ['stages'], viewport: { x: 72, y: 50, zoom: 1.25 },
    });
    expect(second.view.viewport).toEqual(before.view.viewport);
    expect(await fs.readFile(mapPath, 'utf8')).toBe(sourceBefore);
    expect(JSON.parse(await fs.readFile(path.join(root, 'maps/demo.view.json'), 'utf8')).workflow)
      .toEqual(second.view.workflow);
  });

  it('keeps first workflow viewport and collapse patches independently optional', async () => {
    const viewportFixture = await fixture();
    const viewportBefore = viewportFixture.store.getSnapshot();
    const viewportOnly = await viewportFixture.store.updateView({
      baseRevision: viewportBefore.revision,
      clientId: 'workflow-canvas',
      patch: { workflow: { viewport: { x: 18, y: 24, zoom: 1.1 } } },
    });
    expect(viewportOnly.view.workflow).toEqual({ viewport: { x: 18, y: 24, zoom: 1.1 } });
    expect(viewportOnly.view.workflow).not.toHaveProperty('collapsedIds');

    const collapseFixture = await fixture();
    const collapseBefore = collapseFixture.store.getSnapshot();
    const collapseOnly = await collapseFixture.store.updateView({
      baseRevision: collapseBefore.revision,
      clientId: 'workflow-canvas',
      patch: { workflow: { collapsedIds: ['stages'] } },
    });
    expect(collapseOnly.view.workflow).toEqual({ collapsedIds: ['stages'] });
    expect(collapseOnly.view.workflow).not.toHaveProperty('viewport');

    const merged = await collapseFixture.store.updateView({
      baseRevision: collapseBefore.revision,
      clientId: 'workflow-canvas',
      patch: { workflow: { viewport: { x: 31 } } },
    });
    expect(merged.view.workflow).toEqual({
      collapsedIds: ['stages'], viewport: { x: 31, y: 0, zoom: 1 },
    });
  });

  it('filters deleted workflow navigation IDs and keeps source revision conflicts intact', async () => {
    const { store } = await fixture();
    const initial = store.getSnapshot();
    await store.updateView({
      baseRevision: initial.revision,
      clientId: 'workflow-canvas',
      patch: { workflow: { collapsedIds: ['stage1', 'stage15'] } },
    });
    const deleted = await store.mutate({
      baseRevision: initial.revision,
      clientId: 'editor',
      operation: { type: 'deleteSubtrees', ids: ['stage1'] },
    });
    expect(deleted.view.workflow.collapsedIds).toEqual(['stage15']);
    await expect(store.updateView({
      baseRevision: initial.revision,
      clientId: 'stale-workflow-canvas',
      patch: { workflow: { viewport: { zoom: 2 } } },
    })).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('persists card sizing as canonical Mermaid presentation', async () => {
    const { store, mapPath } = await fixture();
    const before = store.getSnapshot();
    const after = await store.mutate({
      baseRevision: before.revision,
      clientId: 'canvas',
      operation: {
        type: 'setNodeLayouts',
        items: [
          { id: 'planning', layout: { mode: 'wrap', width: 336 } },
          { id: 'stage1', layout: { mode: 'fixed', width: 288, height: 128 } },
        ],
      },
    });
    expect(after.graph.nodes.find(({ id }) => id === 'planning').layout).toEqual({ mode: 'wrap', width: 336 });
    const source = await fs.readFile(mapPath, 'utf8');
    expect(source).toContain('%% mlc-node-layout: planning|wrap|336');
    expect(source).toContain('%% mlc-node-layout: stage1|fixed|288|128');
  });

  it('keeps map selection inside the configured data root', () => {
    expect(() => resolveMapPath('/tmp/project', '../outside.mmd')).toThrow(/configured data root/);
    expect(() => resolveMapPath('/tmp/project', 'maps/demo.txt')).toThrow(/configured data root/);
  });

  it('reads and writes an explicit data root outside the code repository', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'final-shape-roots-'));
    const projectRoot = path.join(workspace, 'code');
    const dataRoot = path.join(workspace, 'data');
    await fs.mkdir(projectRoot);
    await fs.mkdir(dataRoot);
    await fs.copyFile(demoUrl, path.join(dataRoot, 'working.mmd'));
    const store = await createMapStore({ projectRoot, dataRoot, mapPath: 'working.mmd', watchFiles: false });
    cleanups.push(async () => { await store.close(); await fs.rm(workspace, { recursive: true, force: true }); });

    const before = store.getSnapshot();
    expect(before.mapPath).toBe('working.mmd');
    const written = await store.mutate({ baseRevision: before.revision, clientId: 'external-root',
      operation: { type: 'renameNode', id: 'planning', label: '외부 데이터 루트' } });
    expect(await fs.readFile(path.join(dataRoot, 'working.mmd'), 'utf8')).toContain('planning["외부 데이터 루트"]');
    expect(await fs.readdir(projectRoot)).toEqual([]);

    const externallyChanged = (await fs.readFile(path.join(dataRoot, 'working.mmd'), 'utf8'))
      .replace('planning["외부 데이터 루트"]', 'planning["외부 변경"]');
    await fs.writeFile(path.join(dataRoot, 'working.mmd'), externallyChanged);
    const refreshed = await store.getFreshSnapshot();
    expect(refreshed.revision).not.toBe(written.revision);
    expect(refreshed.origin).toBe('external');
    expect(refreshed.graph.nodes.find(({ id }) => id === 'planning').label).toBe('외부 변경');
  });

  it('rejects traversal and map or view symlinks that escape the data root', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'final-shape-boundary-'));
    const projectRoot = path.join(workspace, 'code');
    const dataRoot = path.join(workspace, 'data');
    const outsideRoot = path.join(workspace, 'outside');
    await Promise.all([fs.mkdir(projectRoot), fs.mkdir(dataRoot), fs.mkdir(outsideRoot)]);
    await fs.copyFile(demoUrl, path.join(outsideRoot, 'outside.mmd'));
    await fs.symlink(path.join(outsideRoot, 'outside.mmd'), path.join(dataRoot, 'linked.mmd'));
    expect(() => resolveMapPath(dataRoot, '../outside/outside.mmd')).toThrow(/configured data root/);
    expect(() => resolveMapPath(dataRoot, 'linked.mmd')).toThrow(/configured data root/);

    await fs.copyFile(demoUrl, path.join(dataRoot, 'safe.mmd'));
    await fs.writeFile(path.join(outsideRoot, 'outside.view.json'), '{}\n');
    await fs.symlink(path.join(outsideRoot, 'outside.view.json'), path.join(dataRoot, 'safe.view.json'));
    await expect(createMapStore({ projectRoot, dataRoot, mapPath: 'safe.mmd', watchFiles: false }))
      .rejects.toThrow(/configured data root/);
    await fs.rm(workspace, { recursive: true, force: true });
  });
});
