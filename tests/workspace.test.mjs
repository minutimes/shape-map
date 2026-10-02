import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMapStore } from '../lib/store.mjs';
import { createWorkspace } from '../lib/workspace.mjs';
import { createApiApp } from '../server/app.mjs';

const sampleProject = new URL('../examples/sample-project/', import.meta.url);
const demoMap = new URL('../maps/demo.mmd', import.meta.url);

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Shape map test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let temporary;
let root;
let outside;
let stateDir;
let workspace;
let legacy;
let app;

async function until(check, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function setup({ watchFiles = false } = {}) {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shape-workspace-')));
  root = path.join(temporary, 'root');
  outside = path.join(temporary, 'outside');
  stateDir = path.join(temporary, 'state');
  await fs.mkdir(root); await fs.mkdir(outside);
  const sample = path.join(root, 'sample');
  await fs.cp(sampleProject, sample, { recursive: true });
  git(sample, 'init', '-q');
  git(sample, 'add', '.');
  git(sample, 'commit', '-q', '-m', 'sample maps');
  // A worktree nested elsewhere inside the root, with maps.
  await fs.mkdir(path.join(root, 'trees'));
  git(sample, 'worktree', 'add', '-q', '-b', 'feature/rooms', path.join(root, 'trees', 'rooms'));
  // A worktree directly inside the root is named after its repository.
  git(sample, 'worktree', 'add', '-q', '-b', 'direct', path.join(root, 'sample-direct'));
  // A repository without maps, a plain folder, and a symlink leaving the root.
  await fs.mkdir(path.join(root, 'empty'));
  git(path.join(root, 'empty'), 'init', '-q');
  await fs.mkdir(path.join(root, 'notes'));
  await fs.mkdir(path.join(outside, 'escaped', 'docs', 'maps'), { recursive: true });
  git(path.join(outside, 'escaped'), 'init', '-q');
  await fs.copyFile(new URL('docs/maps/01-features.mmd', sampleProject), path.join(outside, 'escaped', 'docs', 'maps', 'a.mmd'));
  await fs.symlink(path.join(outside, 'escaped'), path.join(root, 'escaped'));
  // A map symlink that resolves outside the project.
  await fs.writeFile(path.join(outside, 'secret.mmd'), await fs.readFile(new URL('docs/maps/01-features.mmd', sampleProject)));
  await fs.symlink(path.join(outside, 'secret.mmd'), path.join(sample, 'docs', 'maps', 'secret.mmd'));
  await fs.writeFile(path.join(sample, 'docs', 'maps', 'README.md'), '# notes\n');
  await fs.mkdir(path.join(root, 'legacy', 'maps'), { recursive: true });
  await fs.copyFile(demoMap, path.join(root, 'legacy', 'maps', 'demo.mmd'));

  workspace = await createWorkspace({ root, stateDir, watchFiles });
  legacy = await createMapStore({ projectRoot: path.join(root, 'legacy'), mapPath: 'maps/demo.mmd', watchFiles: false });
  app = createApiApp(legacy, { workspace });
  return sample;
}

const q = (map, project = 'sample') => `project=${encodeURIComponent(project)}&map=${encodeURIComponent(map)}`;

afterEach(async () => {
  await workspace?.close(); await legacy?.close();
  workspace = null; legacy = null;
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

describe('project discovery', () => {
  beforeEach(() => setup());

  it('lists repositories directly inside the root and their worktrees with maps', async () => {
    const { body } = await request(app).get('/api/projects').expect(200);
    expect(body.workspace).toBe(true);
    expect(body.projects).toEqual([
      { key: 'empty', name: 'empty', branch: 'main', worktree: false, mapCount: 0 },
      { key: 'sample', name: 'sample', branch: 'main', worktree: false, mapCount: 4 },
      { key: 'sample-direct', name: 'sample', branch: 'direct', worktree: true, mapCount: 4 },
      { key: 'trees/rooms', name: 'sample', branch: 'feature/rooms', worktree: true, mapCount: 4 },
    ]);
    const single = createApiApp(legacy);
    expect((await request(single).get('/api/projects').expect(200)).body).toEqual({ workspace: false });
    await request(single).get(`/api/map?${q('01-features.mmd')}`).expect(404);
  });

  it('lists map files in name order with kinds, titles, and reasons', async () => {
    const { body } = await request(app).get('/api/project?project=sample').expect(200);
    expect(body.project).toMatchObject({ key: 'sample', mapCount: 4 });
    expect(body.maps).toEqual([
      { file: '01-features.mmd', path: 'docs/maps/01-features.mmd', kind: 'features', title: '동네 책장 기능', editable: true },
      { file: '02-lending.mmd', path: 'docs/maps/02-lending.mmd', kind: 'user-flow', title: '책 빌리고 빌려주기', description: expect.stringContaining('플랫폼'), editable: true },
      { file: '03-lending-system.mmd', path: 'docs/maps/03-lending-system.mmd', kind: 'system-flow', title: '대여 처리', description: expect.any(String), editable: true },
      { file: '09-sequence.mmd', path: 'docs/maps/09-sequence.mmd', kind: 'other', title: '09-sequence', editable: false, error: expect.stringContaining('sequenceDiagram') },
    ]);
  });

  it('rejects unknown projects, traversal, other folders, and symlinks that leave the root or project', async () => {
    for (const [project, map] of [['escaped', 'a.mmd'], ['../outside', 'a.mmd'], ['notes', 'x.mmd'], ['sample/docs', '01-features.mmd'], ['', '01-features.mmd']]) {
      const response = await request(app).get(`/api/map?${q(map, project)}`).expect(404);
      expect(response.body.code).toBe('project_not_found');
    }
    for (const map of ['secret.mmd', '../../../outside/secret.mmd', '..%2F01-features.mmd', 'README.md', 'missing.mmd', '.hidden.mmd', 'sub/01-features.mmd']) {
      const response = await request(app).get(`/api/map?project=sample&map=${map.includes('%') ? map : encodeURIComponent(map)}`).expect(404);
      expect(response.body.code).toBe('map_not_found');
    }
    expect((await request(app).get('/api/map?project=sample').expect(404)).body.code).toBe('map_not_found');
    expect((await request(app).get('/api/map?map=01-features.mmd').expect(404)).body.code).toBe('project_not_found');
    await request(app).get('/api/project?project=escaped').expect(404);
    await request(app).get('/api/events?project=sample&map=secret.mmd').expect(404);
  });
});

describe('project map routes', () => {
  let sample;
  beforeEach(async () => { sample = await setup(); });

  it('keeps the configured single map on routes without parameters', async () => {
    const snapshot = (await request(app).get('/api/map').expect(200)).body;
    expect(snapshot.mapPath).toBe('maps/demo.mmd');
    expect(snapshot.kind).toBeUndefined();
    await request(app).get('/api/subtree/live?depth=1').expect(200);
    await request(app).get('/api/brief').expect(200);
    expect((await request(app).get('/api/health').expect(200)).body).toMatchObject({ ok: true, mapPath: 'maps/demo.mmd' });
  });

  it('edits a features map in place and keeps canvas state outside the project', async () => {
    const before = (await request(app).get(`/api/map?${q('01-features.mmd')}`).expect(200)).body;
    expect(before).toMatchObject({ kind: 'features', editable: true, mapPath: 'docs/maps/01-features.mmd', graph: { map: { kind: 'features', title: '동네 책장 기능' } } });
    const renamed = (await request(app).post(`/api/mutations?${q('01-features.mmd')}`).send({ baseRevision: before.revision, clientId: 'test',
      operation: { type: 'renameNode', id: 'search', label: '제목으로 찾기' } }).expect(200)).body;
    const source = await fs.readFile(path.join(sample, 'docs/maps/01-features.mmd'), 'utf8');
    expect(source).toContain('search["제목으로 찾기"]');
    expect(source).toContain('%% sm-map: {"kind":"features","title":"동네 책장 기능"}');
    await request(app).put(`/api/view?${q('01-features.mmd')}`).send({ baseRevision: renamed.revision, clientId: 'test',
      patch: { shape: { layoutVersion: 3, viewport: { x: 1, y: 2, zoom: 0.5 } } } }).expect(200);
    expect(JSON.parse(await fs.readFile(path.join(stateDir, 'projects', 'sample', '01-features.view.json'), 'utf8')).shape.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 });
    expect(git(sample, 'status', '--porcelain').trim().split('\n')).toEqual(['M docs/maps/01-features.mmd', '?? docs/maps/README.md', '?? docs/maps/secret.mmd']);
    expect((await request(app).get(`/api/subtree/find?depth=1&${q('01-features.mmd')}`).expect(200)).body.root.id).toBe('find');
    expect((await request(app).get(`/api/brief?${q('01-features.mmd')}`).expect(200)).body.mapPath).toBe('docs/maps/01-features.mmd');
    const repository = (await request(app).get(`/api/repository?${q('01-features.mmd')}`).expect(200)).body;
    expect(repository).toMatchObject({ connected: true, name: 'sample', branch: 'main' });
    expect(repository.working.files).toContain('docs/maps/01-features.mmd');
    // The legacy map is untouched.
    expect(await fs.readFile(path.join(root, 'legacy/maps/demo.mmd'), 'utf8')).toBe(await fs.readFile(demoMap, 'utf8'));
  });

  it('serves and edits user flow maps with revision checks and line-numbered errors', async () => {
    const file = path.join(sample, 'docs/maps/02-lending.mmd');
    const original = await fs.readFile(file, 'utf8');
    const snapshot = (await request(app).get(`/api/map?${q('02-lending.mmd')}`).expect(200)).body;
    expect(snapshot).toMatchObject({ kind: 'user-flow', editable: true, source: original, mapPath: 'docs/maps/02-lending.mmd', sourceStatus: { valid: true, error: null } });
    expect(snapshot.view).toBeUndefined();
    expect(snapshot.graph.lanes[0]).toEqual({ id: 'reader', title: '빌리는 사람', tags: ['consumer'] });
    const added = (await request(app).post(`/api/mutations?${q('02-lending.mmd')}`).send({ baseRevision: snapshot.revision, clientId: 'flow',
      operation: { type: 'addStep', lane: 'reader', label: '알림 끄기', after: 'reader_wait' } }).expect(200)).body;
    expect(added.origin).toBe('flow');
    expect(added.graph.steps.find(({ id }) => id === 'step-1')).toMatchObject({ lane: 'reader', label: '알림 끄기' });
    expect(await fs.readFile(file, 'utf8')).toBe(added.source);
    expect(added.source).toContain('    reader_wait["입고 알림 신청"]\n    step-1["알림 끄기"]\n');
    const stale = (await request(app).post(`/api/mutations?${q('02-lending.mmd')}`).send({ baseRevision: snapshot.revision, clientId: 'flow',
      operation: { type: 'addLane', title: '늦은 사람' } }).expect(409)).body;
    expect(stale).toMatchObject({ code: 'revision_conflict', snapshot: { revision: added.revision, kind: 'user-flow' } });
    const invalid = (await request(app).post(`/api/mutations?${q('02-lending.mmd')}`).send({ baseRevision: added.revision, clientId: 'flow',
      operation: { type: 'replaceSource', source: original.replace('  reader_open --> reader_search', '  reader_open --> nowhere') } }).expect(422)).body;
    expect(invalid).toMatchObject({ code: 'validation_error', details: { line: 33 } });
    const undone = (await request(app).post(`/api/mutations?${q('02-lending.mmd')}`).send({ baseRevision: added.revision, clientId: 'flow',
      operation: { type: 'replaceSource', source: original } }).expect(200)).body;
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    const unchanged = (await request(app).post(`/api/mutations?${q('02-lending.mmd')}`).send({ baseRevision: undone.revision, clientId: 'other',
      operation: { type: 'updateStep', id: 'reader_open', label: '앱 열기' } }).expect(200)).body;
    expect(unchanged).toMatchObject({ revision: undone.revision, origin: 'flow' });
    expect((await request(app).post(`/api/mutations?${q('02-lending.mmd')}`).send({ baseRevision: undone.revision, clientId: 'flow',
      operation: { type: 'renameNode', id: 'reader_open', label: 'x' } }).expect(422)).body.code).toBe('validation_error');
    expect((await request(app).get(`/api/subtree/reader?${q('02-lending.mmd')}`).expect(422)).body.code).toBe('unsupported_map_kind');
    expect((await request(app).get(`/api/brief?${q('02-lending.mmd')}`).expect(200)).body.text).toContain('docs/maps/02-lending.mmd');
    expect((await request(app).put(`/api/view?${q('02-lending.mmd')}`).send({ baseRevision: undone.revision, clientId: 'flow', patch: {} }).expect(422)).body.code).toBe('unsupported_map_kind');
    expect((await request(app).get(`/api/repository?${q('02-lending.mmd')}`).expect(200)).body.connected).toBe(true);
  });

  it('lets replaceSource switch between the two flow kinds, which moves the map to the other tab', async () => {
    const snapshot = (await request(app).get(`/api/map?${q('03-lending-system.mmd')}`).expect(200)).body;
    expect(snapshot).toMatchObject({ kind: 'system-flow', graph: { direction: 'TB', map: { kind: 'system-flow' } } });
    const switched = (await request(app).post(`/api/mutations?${q('03-lending-system.mmd')}`).send({ baseRevision: snapshot.revision, clientId: 'flow',
      operation: { type: 'replaceSource', source: snapshot.source.replace('"kind":"system-flow"', '"kind":"user-flow"') } }).expect(200)).body;
    expect(switched.kind).toBe('user-flow');
    const listed = (await request(app).get('/api/project?project=sample').expect(200)).body.maps.find((map) => map.file === '03-lending-system.mmd');
    expect(listed.kind).toBe('user-flow');
    const features = (await request(app).get(`/api/map?${q('01-features.mmd')}`).expect(200)).body;
    expect((await request(app).post(`/api/mutations?${q('03-lending-system.mmd')}`).send({ baseRevision: switched.revision, clientId: 'flow',
      operation: { type: 'replaceSource', source: (await fs.readFile(path.join(sample, 'docs/maps/01-features.mmd'), 'utf8')) } }).expect(422)).body.message).toMatch(/flow map/);
    expect(features.kind).toBe('features');
  });

  it('serializes concurrent edits so only one wins against the same revision', async () => {
    const snapshot = (await request(app).get(`/api/map?${q('02-lending.mmd')}`).expect(200)).body;
    const results = await Promise.all(['첫째', '둘째', '셋째'].map((label, index) => request(app).post(`/api/mutations?${q('02-lending.mmd')}`)
      .send({ baseRevision: snapshot.revision, clientId: `c${index}`, operation: { type: 'addStep', lane: null, label } })));
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409, 409]);
    const source = await fs.readFile(path.join(sample, 'docs/maps/02-lending.mmd'), 'utf8');
    expect(source.match(/step-1\["/g)).toHaveLength(1);
  });

  it('shows unreadable maps read-only and makes them editable once fixed, without a restart', async () => {
    const other = (await request(app).get(`/api/map?${q('09-sequence.mmd')}`).expect(200)).body;
    expect(other).toMatchObject({ kind: 'other', editable: false, graph: null, sourceStatus: { valid: false } });
    expect(other.source).toContain('sequenceDiagram');
    for (const [method, route, body] of [['post', '/api/mutations', { operation: { type: 'renameNode', id: 'a', label: 'b' } }], ['put', '/api/view', { patch: {} }]]) {
      const response = await request(app)[method](`${route}?${q('09-sequence.mmd')}`).send({ baseRevision: other.revision, clientId: 'x', ...body }).expect(422);
      expect(response.body.code).toBe('read_only_map');
    }
    expect((await request(app).get(`/api/brief?${q('09-sequence.mmd')}`).expect(422)).body.code).toBe('read_only_map');
    expect((await request(app).get(`/api/health?${q('09-sequence.mmd')}`).expect(200)).body.sourceValid).toBe(false);

    const lending = await fs.readFile(path.join(sample, 'docs/maps/02-lending.mmd'), 'utf8');
    const broken = lending.replace('  owner_check --> owner_accept', '  owner_check -.- owner_accept');
    const file = path.join(sample, 'docs/maps/03-broken.mmd');
    await fs.writeFile(file, broken);
    const listed = (await request(app).get('/api/project?project=sample').expect(200)).body.maps.find((map) => map.file === '03-broken.mmd');
    expect(listed).toMatchObject({ kind: 'user-flow', editable: false, line: 40, title: '책 빌리고 빌려주기' });
    const readOnly = (await request(app).get(`/api/map?${q('03-broken.mmd')}`).expect(200)).body;
    expect(readOnly).toMatchObject({ kind: 'user-flow', editable: false, graph: null, sourceStatus: { valid: false, line: 40 } });
    await request(app).post(`/api/mutations?${q('03-broken.mmd')}`).send({ baseRevision: readOnly.revision, clientId: 'x', operation: { type: 'addLane', title: 'x' } }).expect(422);
    expect(await fs.readFile(file, 'utf8')).toBe(broken);

    await fs.writeFile(file, lending);
    const fixed = (await request(app).get(`/api/map?${q('03-broken.mmd')}`).expect(200)).body;
    expect(fixed).toMatchObject({ kind: 'user-flow', editable: true, sourceStatus: { valid: true } });
    expect((await request(app).get('/api/project?project=sample').expect(200)).body.maps.find((map) => map.file === '03-broken.mmd').editable).toBe(true);
    await request(app).post(`/api/mutations?${q('03-broken.mmd')}`).send({ baseRevision: fixed.revision, clientId: 'x', operation: { type: 'addLane', title: '새 사람' } }).expect(200);

    // A map that breaks after opening keeps its last valid snapshot (v1 behavior).
    const current = (await request(app).get(`/api/map?${q('03-broken.mmd')}`).expect(200)).body;
    await fs.writeFile(file, broken);
    const invalidAfterOpen = (await request(app).get(`/api/map?${q('03-broken.mmd')}`).expect(200)).body;
    expect(invalidAfterOpen).toMatchObject({ editable: true, revision: current.revision, sourceStatus: { valid: false, line: 40 } });
    expect(invalidAfterOpen.graph.lanes.length).toBeGreaterThan(0);
    expect((await request(app).post(`/api/mutations?${q('03-broken.mmd')}`).send({ baseRevision: current.revision, clientId: 'x', operation: { type: 'addLane', title: 'y' } }).expect(422)).body.code).toBe('invalid_source');
    expect(await fs.readFile(file, 'utf8')).toBe(broken);
  });

  it('maps an unknown declared kind to other and keeps it', async () => {
    await fs.writeFile(path.join(sample, 'docs/maps/04-later.mmd'), 'flowchart LR\n  %% sm-map: {"kind":"timeline","title":"나중 지도"}\n  a["x"]\n');
    const listed = (await request(app).get('/api/project?project=sample').expect(200)).body.maps.find((map) => map.file === '04-later.mmd');
    expect(listed).toMatchObject({ kind: 'other', declaredKind: 'timeline', title: '나중 지도', editable: false, line: 2 });
  });
});

describe('live project updates', () => {
  let sample;
  beforeEach(async () => { sample = await setup({ watchFiles: true }); });

  it('publishes the map list when files are added, changed, or removed', async () => {
    const events = [];
    const unsubscribe = await workspace.subscribeMaps('sample', (maps) => events.push(maps));
    const file = path.join(sample, 'docs/maps/05-new.mmd');
    await fs.writeFile(file, await fs.readFile(path.join(sample, 'docs/maps/01-features.mmd')));
    const added = await until(() => events.find((maps) => maps.some((map) => map.file === '05-new.mmd')));
    expect(added.find((map) => map.file === '05-new.mmd')).toMatchObject({ kind: 'features', editable: true });
    await fs.writeFile(file, 'flowchart LR\n  %% mlc-format: 1\n  broken line\n');
    await until(() => events.at(-1)?.find((map) => map.file === '05-new.mmd')?.editable === false);
    await fs.rm(file);
    await until(() => events.at(-1) && !events.at(-1).some((map) => map.file === '05-new.mmd'));
    unsubscribe();
  });

  it('streams per-map snapshots after an external edit', async () => {
    const store = await workspace.openMap('sample', '02-lending.mmd');
    const snapshots = [];
    store.on('snapshot', (snapshot) => snapshots.push(snapshot));
    const file = path.join(sample, 'docs/maps/02-lending.mmd');
    const source = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, source.replace('"앱 열기"', '"앱 켜기"'));
    const next = await until(() => snapshots.at(-1));
    expect(next).toMatchObject({ origin: 'external', kind: 'user-flow' });
    expect(next.graph.steps[0].label).toBe('앱 켜기');
  });

  it('streams project map events over SSE', async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/project/events?project=sample`, { signal: controller.signal });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body.getReader();
      let text = '';
      const read = async (pattern) => {
        while (!pattern.test(text)) text += new TextDecoder().decode((await reader.read()).value);
      };
      await read(/event: maps\ndata: .*09-sequence/);
      await fs.writeFile(path.join(sample, 'docs/maps/06-live.mmd'), await fs.readFile(path.join(sample, 'docs/maps/02-lending.mmd')));
      await read(/06-live\.mmd/);
    } finally {
      controller.abort();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('flow collaboration routes', () => {
  let sample;
  beforeEach(async () => { sample = await setup(); });
  const mutate = async (revision, operation, status = 200) => (await request(app).post(`/api/mutations?${q('02-lending.mmd')}`)
    .send({ baseRevision: revision, clientId: 'flow', operation }).expect(status)).body;

  it('writes memos, review, and turns with server values into the flow file only', async () => {
    let snapshot = (await request(app).get(`/api/map?${q('02-lending.mmd')}`).expect(200)).body;
    snapshot = await mutate(snapshot.revision, { type: 'addComment', id: 'reader_search', body: '검색 결과가 너무 많아요', kind: 'concern', author: '사람' });
    const [comment] = snapshot.graph.steps.find((step) => step.id === 'reader_search').comments;
    expect(comment).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), createdAt: expect.any(String), author: '사람' });
    snapshot = await mutate(snapshot.revision, { type: 'setBlock', id: 'reader_open', block: { status: 'verified' } });
    expect(snapshot.graph.steps.find((step) => step.id === 'reader_open').review).toMatchObject({ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const revision = snapshot.revision;
    snapshot = await mutate(snapshot.revision, { type: 'createTurn', title: '처음 기록' });
    expect(snapshot.graph.turns[0]).toMatchObject({ number: 1, title: '처음 기록', revision, id: expect.any(String) });
    const file = await fs.readFile(path.join(sample, 'docs/maps/02-lending.mmd'), 'utf8');
    expect(file).toBe(snapshot.source);
    expect(file).toMatch(/\n {2}%% sm-turn: \{"id":/);
    expect(git(sample, 'status', '--porcelain', '--untracked-files=no').trim()).toBe('M docs/maps/02-lending.mmd');
  });

  it('keeps turns immutable and never lets a replaced source invent a memo or review', async () => {
    let snapshot = (await request(app).get(`/api/map?${q('02-lending.mmd')}`).expect(200)).body;
    const original = snapshot.source;
    snapshot = await mutate(snapshot.revision, { type: 'addComment', id: 'reader_open', body: '좋아요', kind: 'note', author: '사람' });
    const withComment = snapshot.source;
    // Undo and redo restore a memo the store has already read.
    snapshot = await mutate(snapshot.revision, { type: 'replaceSource', source: original });
    snapshot = await mutate(snapshot.revision, { type: 'replaceSource', source: withComment });
    const forged = withComment.replace('"body":"좋아요"', '"body":"다른 사람이 쓴 척"');
    expect((await mutate(snapshot.revision, { type: 'replaceSource', source: forged }, 422)).message).toMatch(/review and memo records cannot be written/);
    const reviewed = original.replace('  %% sm-block: catalog|', `  %% sm-block: reader_open|{"status":"verified","review":{"at":"2026-01-01T00:00:00.000Z","fingerprint":"${'a'.repeat(64)}"}}\n  %% sm-block: catalog|`);
    expect((await mutate(snapshot.revision, { type: 'replaceSource', source: reviewed }, 422)).message).toMatch(/review and memo records/);
    snapshot = await mutate(snapshot.revision, { type: 'createTurn', title: '첫 턴' });
    const turnLine = snapshot.source.split('\n').find((line) => line.includes('sm-turn'));
    expect((await mutate(snapshot.revision, { type: 'replaceSource', source: withComment }, 422)).message).toMatch(/Recorded turns cannot be changed/);
    expect((await mutate(snapshot.revision, { type: 'replaceSource', source: snapshot.source.replace(turnLine, turnLine.replace('첫 턴', '고친 턴')) }, 422)).message).toMatch(/Recorded turns/);
    const invented = turnLine.replace('"number":1', '"number":2').replace(/"id":"[^"]+"/, '"id":"made-up"');
    expect((await mutate(snapshot.revision, { type: 'replaceSource', source: `${snapshot.source}${invented}\n` }, 422)).message).toMatch(/Recorded turns/);
    // An ordinary edit through the source editor still works and keeps the turn.
    const renamed = await mutate(snapshot.revision, { type: 'replaceSource', source: snapshot.source.replace('["앱 열기"]', '["앱 켜기"]') });
    expect(renamed.graph.turns).toEqual(snapshot.graph.turns);
  });

  it('lists explicit feature links both ways and names linked features in the flow brief', async () => {
    const snapshot = (await request(app).get(`/api/map?${q('02-lending.mmd')}`).expect(200)).body;
    await mutate(snapshot.revision, { type: 'updateStep', id: 'reader_search', features: [{ map: '01-features.mmd', id: 'search' }, { map: '01-features.mmd', id: 'retired' }] });
    const links = (await request(app).get('/api/project/links?project=sample').expect(200)).body;
    expect(links.features).toEqual([expect.objectContaining({ file: '01-features.mmd', title: '동네 책장 기능', nodes: expect.arrayContaining([{ id: 'search', label: '검색', parentId: 'find' }]) })]);
    expect(links.flows).toEqual([{ file: '02-lending.mmd', title: '책 빌리고 빌려주기', kind: 'user-flow',
      steps: [{ id: 'reader_search', label: '읽고 싶은 책 찾기', features: [{ map: '01-features.mmd', id: 'search' }, { map: '01-features.mmd', id: 'retired' }] }] }]);
    const brief = (await request(app).post(`/api/brief?${q('02-lending.mmd')}`).send({ focus: 'reader_search', problem: '못 찾아요', successCriteria: '찾는다' }).expect(200)).body;
    expect(brief.text).toContain('docs/maps/01-features.mmd [search] 검색');
    expect(brief.text).toContain('docs/maps/01-features.mmd [retired] (찾을 수 없는 기능)');
    expect((await request(app).post(`/api/brief?${q('02-lending.mmd')}`).send({ focus: 'nope' }).expect(422)).body.message).toMatch(/step or lane does not exist/);
    expect((await request(app).post(`/api/brief?${q('02-lending.mmd')}`).send({ approved: true }).expect(422)).body.message).toMatch(/approved request/);
    expect((await request(app).get('/api/project/links?project=../x').expect(404)).body.code).toBe('project_not_found');
  });
});
