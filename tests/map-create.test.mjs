import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyOperation } from '../lib/graph.mjs';
import { parseSource, writeSource } from '../lib/format.mjs';
import { readEditableMap } from '../lib/mapSource.mjs';
import { mapFileNames, mapSlug, normalizeNewMap, starterSource } from '../lib/mapTemplates.mjs';
import { createWorkspace } from '../lib/workspace.mjs';
import { createApiApp } from '../server/app.mjs';
import { mapRequestReason } from '../src/mapKinds.js';

const mapctl = fileURLToPath(new URL('../bin/mapctl.mjs', import.meta.url));
const sampleProject = new URL('../examples/sample-project/', import.meta.url);

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Shape map test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function mapctlRun(...args) {
  return execFileSync(process.execPath, [mapctl, ...args], { encoding: 'utf8' });
}

describe('starter maps', () => {
  it('writes a valid, canonical starter for every kind', async () => {
    for (const kind of ['features', 'user-flow', 'system-flow']) {
      const source = starterSource({ kind, title: '방 "들어가기"', description: '방을 만들고 | 들어가는 흐름' });
      const { kind: parsedKind, graph } = await readEditableMap(source);
      expect(parsedKind).toBe(kind);
      expect(graph.map).toEqual({ kind, title: '방 "들어가기"', description: '방을 만들고 | 들어가는 흐름' });
      if (kind === 'features') {
        expect(graph.nodes).toEqual([expect.objectContaining({ id: 'root', label: '방 ”들어가기”', parentId: null })]);
        expect(writeSource(parseSource(source))).toBe(source);
      } else {
        expect(graph.lanes).toEqual([{ id: 'lane-1', title: kind === 'user-flow' ? '사용자' : '서비스', tags: [] }]);
        expect(graph.steps).toEqual([{ id: 'step-1', label: '시작', shape: 'milestone', lane: 'lane-1', tags: [] }]);
      }
    }
  });

  it('validates a create request and keeps the description optional', () => {
    expect(normalizeNewMap({ kind: 'user-flow', title: '  책 빌리기 ', description: '  ' })).toEqual({ kind: 'user-flow', title: '책 빌리기' });
    for (const input of [null, {}, { kind: 'other', title: 'x' }, { kind: 'features', title: ' ' }, { kind: 'features', title: 'x'.repeat(81) },
      { kind: 'features', title: 'a\nb' }, { kind: 'features', title: 'x', description: 3 }, { kind: 'features', title: 'x', file: '../a.mmd' }]) {
      expect(() => normalizeNewMap(input)).toThrow();
    }
  });

  it('names files in ASCII after the highest number already used, without clashes', () => {
    expect(mapSlug('Rooms & Leagues 플로우', 'user-flow')).toBe('rooms-leagues');
    expect(mapSlug('방 들어가기', 'system-flow')).toBe('system-flow');
    expect(mapSlug('Café', 'features')).toBe('cafe');
    expect(mapSlug('../../etc/passwd', 'features')).toBe('etc-passwd');
    const existing = ['01-features.mmd', '09-sequence.mmd', 'README.md', '10-rooms.MMD'];
    expect([...mapFileNames('Rooms', 'user-flow', existing)].slice(0, 2)).toEqual(['11-rooms.mmd', '12-rooms.mmd']);
    expect([...mapFileNames('방', 'features', [])][0]).toBe('01-features.mmd');
    expect([...mapFileNames('Rooms', 'user-flow', ['10-rooms.mmd'])][0]).toBe('11-rooms.mmd');
  });
});

describe('feature map header edits', () => {
  const headerless = `flowchart LR
  %% mlc-format: 1
  app(["동네 책장"])

  classDef feature fill:#FFFFFF,stroke:#D9D9DE,color:#28282C,stroke-width:1px
  class app feature

  %% mlc-legend: feature|기능|하나의 기능
`;

  it('adds a header for a title, keeps it afterwards, and leaves an absent header absent otherwise', () => {
    const graph = parseSource(headerless);
    const canonical = writeSource(graph);
    expect(canonical).not.toContain('sm-map');
    expect(writeSource(applyOperation(graph, { type: 'setMapHeader', description: null }))).toBe(canonical);
    const titled = applyOperation(graph, { type: 'setMapHeader', title: ' 책장 기능 ', description: '빌리고 빌려주는 기능' });
    expect(titled.map).toEqual({ kind: 'features', title: '책장 기능', description: '빌리고 빌려주는 기능' });
    expect(writeSource(titled)).toContain('  %% mlc-format: 1\n  %% sm-map: {"kind":"features","title":"책장 기능","description":"빌리고 빌려주는 기능"}\n');
    const cleared = applyOperation(titled, { type: 'setMapHeader', title: null, description: '' });
    expect(cleared.map).toEqual({ kind: 'features' });
    expect(() => applyOperation(graph, { type: 'setMapHeader', kind: 'user-flow' })).toThrow(/Unsupported setMapHeader field/);
    expect(() => applyOperation(graph, { type: 'setMapHeader', title: 'x'.repeat(81) })).toThrow();
  });
});

describe('creating maps in a project', () => {
  let temporary; let root; let outside; let workspace; let app; let sample;

  beforeEach(async () => {
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shape-map-create-')));
    root = path.join(temporary, 'root');
    outside = path.join(temporary, 'outside');
    await fs.mkdir(root); await fs.mkdir(outside);
    sample = path.join(root, 'sample');
    await fs.cp(sampleProject, sample, { recursive: true });
    git(sample, 'init', '-q'); git(sample, 'add', '.'); git(sample, 'commit', '-q', '-m', 'sample');
    await fs.mkdir(path.join(root, 'empty'));
    git(path.join(root, 'empty'), 'init', '-q');
    workspace = await createWorkspace({ root, stateDir: path.join(temporary, 'state'), watchFiles: false });
    app = createApiApp(null, { workspace });
  });

  afterEach(async () => {
    await workspace?.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const create = (project, body) => request(app).post(`/api/project/maps?project=${encodeURIComponent(project)}`).send(body);

  it('creates docs/maps for a project without maps and writes only the new map', async () => {
    const empty = path.join(root, 'empty');
    const { body } = await create('empty', { kind: 'features', title: '첫 기능 지도', description: '무엇을 할 수 있는지' }).expect(201);
    expect(body.map).toEqual({ file: '01-features.mmd', path: 'docs/maps/01-features.mmd', kind: 'features', title: '첫 기능 지도', description: '무엇을 할 수 있는지', editable: true });
    expect(body.project).toMatchObject({ key: 'empty', mapCount: 1 });
    expect(body.maps.map((map) => map.file)).toEqual(['01-features.mmd']);
    expect(git(empty, 'status', '--porcelain', '--untracked-files=all').trim()).toBe('?? docs/maps/01-features.mmd');
    expect(await fs.readdir(path.join(empty, 'docs', 'maps'))).toEqual(['01-features.mmd']);
    // The new file passes check and is already canonical.
    expect(mapctlRun('check', empty)).toMatch(/^ok\s+01-features\.mmd\s+features\s+"첫 기능 지도"/);
    expect(mapctlRun('format', empty)).toMatch(/^same\s+01-features\.mmd/);
    // The project now opens it for editing.
    const snapshot = (await request(app).get('/api/map?project=empty&map=01-features.mmd').expect(200)).body;
    expect(snapshot).toMatchObject({ kind: 'features', editable: true, graph: { map: { kind: 'features', title: '첫 기능 지도' } } });
    expect((await request(app).get('/api/projects').expect(200)).body.projects.find((project) => project.key === 'empty').mapCount).toBe(1);
  });

  it('numbers new maps after existing ones and never overwrites a file', async () => {
    const directory = path.join(sample, 'docs', 'maps');
    const before = Object.fromEntries(await Promise.all((await fs.readdir(directory)).map(async (name) => [name, await fs.readFile(path.join(directory, name), 'utf8')])));
    const first = (await create('sample', { kind: 'user-flow', title: 'Rooms 들어가기' }).expect(201)).body;
    expect(first.map).toMatchObject({ file: '10-rooms.mmd', kind: 'user-flow', title: 'Rooms 들어가기', editable: true });
    expect(first.map.description).toBeUndefined();
    // A file someone else created under the next name is skipped, not replaced.
    await fs.writeFile(path.join(directory, '11-rooms.mmd'), 'not mine\n');
    const second = (await create('sample', { kind: 'system-flow', title: 'Rooms' }).expect(201)).body;
    expect(second.map.file).toBe('12-rooms.mmd');
    expect(await fs.readFile(path.join(directory, '11-rooms.mmd'), 'utf8')).toBe('not mine\n');
    for (const [name, text] of Object.entries(before)) expect(await fs.readFile(path.join(directory, name), 'utf8')).toBe(text);
    expect((await fs.readdir(directory)).filter((name) => name.startsWith('.'))).toEqual([]);
    expect(mapctlRun('format', '--dry-run', directory)).toMatch(/same\s+10-rooms\.mmd[\s\S]*same\s+12-rooms\.mmd/);
    // Simultaneous requests each get their own file.
    const results = await Promise.all(Array.from({ length: 4 }, () => create('sample', { kind: 'features', title: 'Same' })));
    const files = results.map((result) => result.body.map.file);
    expect(new Set(files).size).toBe(4);
    for (const file of files) expect(await fs.readFile(path.join(directory, file), 'utf8')).toBe(starterSource({ kind: 'features', title: 'Same' }));
  });

  it('accepts only listed projects and the docs/maps folder inside them', async () => {
    for (const project of ['', '../outside', 'missing', 'sample/docs']) {
      expect((await create(project, { kind: 'features', title: 'x' }).expect(404)).body.code).toBe('project_not_found');
    }
    expect((await create('sample', { kind: 'sequence', title: 'x' }).expect(422)).body.code).toBe('validation_error');
    expect((await create('sample', { kind: 'features', title: 'x', file: '../../escape.mmd' }).expect(422)).body.code).toBe('validation_error');
    expect((await request(createApiApp(null)).post('/api/project/maps?project=sample').send({ kind: 'features', title: 'x' }).expect(404)).body.code).toBe('project_not_found');

    // docs/maps that resolves outside the project is refused, and nothing is written there.
    const empty = path.join(root, 'empty');
    await fs.mkdir(path.join(outside, 'maps'));
    await fs.mkdir(path.join(empty, 'docs'));
    await fs.symlink(path.join(outside, 'maps'), path.join(empty, 'docs', 'maps'));
    expect((await create('empty', { kind: 'features', title: 'x' }).expect(422)).body.code).toBe('maps_folder_unavailable');
    expect(await fs.readdir(path.join(outside, 'maps'))).toEqual([]);
    // So is a docs symlink leaving the project, and a docs/maps that is a file.
    await fs.rm(path.join(empty, 'docs'), { recursive: true });
    await fs.symlink(outside, path.join(empty, 'docs'));
    expect((await create('empty', { kind: 'features', title: 'x' }).expect(422)).body.code).toBe('maps_folder_unavailable');
    expect(await fs.readdir(outside)).toEqual(['maps']);
    await fs.rm(path.join(empty, 'docs'));
    await fs.mkdir(path.join(empty, 'docs'));
    await fs.writeFile(path.join(empty, 'docs', 'maps'), 'a file\n');
    expect((await create('empty', { kind: 'features', title: 'x' }).expect(422)).body.code).toBe('maps_folder_unavailable');
  });

  it('changes the title and description of every kind through setMapHeader', async () => {
    const directory = path.join(sample, 'docs', 'maps');
    const created = (await create('sample', { kind: 'features', title: '기능' }).expect(201)).body.map;
    for (const file of [created.file, '02-lending.mmd']) {
      const query = `project=sample&map=${encodeURIComponent(file)}`;
      const snapshot = (await request(app).get(`/api/map?${query}`).expect(200)).body;
      const saved = (await request(app).post(`/api/mutations?${query}`).send({ baseRevision: snapshot.revision, clientId: 'shell',
        operation: { type: 'setMapHeader', title: '새 이름', description: '새 설명' } }).expect(200)).body;
      expect(saved.graph.map).toMatchObject({ title: '새 이름', description: '새 설명' });
      expect(await fs.readFile(path.join(directory, file), 'utf8')).toContain('"title":"새 이름","description":"새 설명"');
      const listed = (await request(app).get('/api/project?project=sample').expect(200)).body.maps.find((map) => map.file === file);
      expect(listed).toMatchObject({ title: '새 이름', description: '새 설명', editable: true });
    }
  });
});

describe('live map lists', () => {
  it('tells subscribers about the first map at once and then watches the new folder', async () => {
    const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shape-map-create-live-')));
    const project = path.join(temporary, 'root', 'empty');
    await fs.mkdir(project, { recursive: true });
    git(project, 'init', '-q');
    const workspace = await createWorkspace({ root: path.join(temporary, 'root'), stateDir: path.join(temporary, 'state'), watchFiles: true });
    try {
      const events = [];
      const unsubscribe = await workspace.subscribeMaps('empty', (maps) => events.push(maps.map((map) => map.file)));
      await workspace.createMap('empty', { kind: 'user-flow', title: '책 빌리기' });
      expect(events.at(-1)).toEqual(['01-user-flow.mmd']);
      // The folder is watched now, so a file added by hand appears without the periodic check.
      await fs.copyFile(new URL('docs/maps/03-lending-system.mmd', sampleProject), path.join(project, 'docs', 'maps', '02-system.mmd'));
      const deadline = Date.now() + 3_000;
      while (events.at(-1)?.length !== 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));
      expect(events.at(-1)).toEqual(['01-user-flow.mmd', '02-system.mmd']);
      unsubscribe();
    } finally {
      await workspace.close();
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
});

describe('request reasons', () => {
  it('explains failures in plain Korean', () => {
    expect(mapRequestReason(new TypeError('Failed to fetch'))).toMatch(/연결하지 못했어요/);
    expect(mapRequestReason({ status: 422, body: { code: 'maps_folder_unavailable' } })).toMatch(/docs\/maps 폴더/);
    expect(mapRequestReason({ status: 409, body: { code: 'revision_conflict' } })).toMatch(/한 번 더 저장/);
    expect(mapRequestReason({ status: 500, body: {} })).toMatch(/다시 해 주세요/);
  });
});
