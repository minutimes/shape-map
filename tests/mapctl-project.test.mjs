import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace } from '../lib/workspace.mjs';
import { createApiApp } from '../server/app.mjs';

const mapctl = fileURLToPath(new URL('../bin/mapctl.mjs', import.meta.url));
const sampleProject = fileURLToPath(new URL('../examples/sample-project/', import.meta.url));
const execute = promisify(execFile);

let temporary;
let workspace;
let server;
let url;

beforeEach(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shape-mapctl-project-')));
  const project = path.join(temporary, 'root', 'sample');
  await fs.cp(sampleProject, project, { recursive: true });
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-q', '-m', 'sample']]) {
    execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args]);
  }
  workspace = await createWorkspace({ root: path.join(temporary, 'root'), stateDir: path.join(temporary, 'state'), watchFiles: false });
  server = createApiApp(null, { workspace }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await workspace.close();
  await fs.rm(temporary, { recursive: true, force: true });
});

async function map(...args) {
  const { stdout } = await execute(process.execPath, [mapctl, ...args], { env: { ...process.env, FINAL_SHAPE_MAP_URL: url, FINAL_SHAPE_MAP_CLIENT_ID: 'ai-session' } });
  return stdout;
}
const flow = ['--project', 'sample', '--map', '02-lending.mmd'];

describe('mapctl on a project map', () => {
  it('lets an AI session comment, propose, record a turn, read, and brief a flow map through the server', async () => {
    const shown = JSON.parse(await map('show', ...flow));
    expect(shown).toMatchObject({ kind: 'user-flow', mapPath: 'docs/maps/02-lending.mmd' });

    const commented = JSON.parse(await map('comment', 'reader_search', '검색 결과가 너무 많아요', '--kind', 'concern', ...flow));
    expect(commented.origin).toBe('ai-session');
    expect(commented.graph.steps.find((step) => step.id === 'reader_search').comments[0]).toMatchObject({ body: '검색 결과가 너무 많아요', kind: 'concern', author: 'AI' });
    const laneMemo = JSON.parse(await map('comment', 'owner', '책 주인이 너무 늦게 답해요', '--kind', 'concern', ...flow));
    expect(laneMemo.graph.lanes.find((lane) => lane.id === 'owner').comments).toHaveLength(1);

    const proposed = JSON.parse(await map('propose', 'reader_wait', '--reason', '입고 알림이 늦어요', '--logic', '바로 알려요', '--success', '한 시간 안에', ...flow));
    expect(proposed.graph.steps.find((step) => step.id === 'reader_wait').proposal).toEqual({ reason: '입고 알림이 늦어요', logic: '바로 알려요', successCriteria: '한 시간 안에' });

    const turned = JSON.parse(await map('turn', '알림 개선 제안', '--summary', 'AI가 남긴 기록', ...flow));
    expect(turned.graph.turns[0]).toMatchObject({ number: 1, title: '알림 개선 제안', summary: 'AI가 남긴 기록' });

    const brief = await map('brief', '--focus', 'reader_wait', '--problem', '알림이 늦어요', '--success', '한 시간 안에', '--approved', ...flow);
    expect(brief).toContain('지도: docs/maps/02-lending.mmd');
    expect(brief).toContain('[reader_wait]');
    expect(brief).toContain('사용자가 위 요청을 승인했습니다');
    const laneBrief = await map('brief', '--focus', 'owner', ...flow);
    expect(laneBrief).toContain('책 주인이 너무 늦게 답해요');

    const file = await fs.readFile(path.join(temporary, 'root/sample/docs/maps/02-lending.mmd'), 'utf8');
    expect(file).toBe(JSON.parse(await map('show', ...flow)).source);
    // The features map of the same project works the same way.
    const features = JSON.parse(await map('comment', 'search', '제목으로도 찾고 싶어요', '--project', 'sample', '--map', '01-features.mmd'));
    expect(features.graph.nodes.find((node) => node.id === 'search').block.comments).toHaveLength(1);
  });

  it('explains a missing half of the project pair and an unknown map', async () => {
    await expect(map('show', '--project', 'sample')).rejects.toMatchObject({ stderr: expect.stringContaining('--project and --map go together') });
    await expect(map('show', '--project', 'sample', '--map', 'nope.mmd')).rejects.toMatchObject({ stderr: expect.stringContaining('Map not found') });
  });
});
