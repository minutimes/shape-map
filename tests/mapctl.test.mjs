import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFlowMap, writeFlowMap } from '../lib/flowMap.mjs';

const mapctl = fileURLToPath(new URL('../bin/mapctl.mjs', import.meta.url));
const sampleMaps = fileURLToPath(new URL('../examples/sample-project/docs/maps/', import.meta.url));

// Chained arrows and an arrow inside a lane are valid, but not canonical.
const loose = `flowchart TB
  %% sm-map: {"kind":"system-flow","title":"방 플로우"}
  subgraph plaza["광장"]
    open(["방 만들기"])
    pick{"방 종류?"}
    open --> pick
  end
  create["예약 서버 만들기"]
  play["판"]
  pick -->|"무료방"| create --> play
  classDef rsv fill:#dcf1ea,stroke:#0b7358,color:#1a1f26,stroke-width:2px
  class create rsv
  class play rsv
  %% mlc-legend: rsv|방|예약 서버에서 일어나는 일
`;

function run(...args) {
  return execFileSync(process.execPath, [mapctl, ...args], { encoding: 'utf8' });
}

let directory;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shape-map-format-'));
  await fs.mkdir(path.join(directory, 'docs', 'maps'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('mapctl format', () => {
  it('rewrites editable maps canonically, leaves the rest alone, and is idempotent', async () => {
    const maps = path.join(directory, 'docs', 'maps');
    await fs.writeFile(path.join(maps, '20-rooms.mmd'), loose);
    await fs.copyFile(path.join(sampleMaps, '02-lending.mmd'), path.join(maps, '02-lending.mmd'));
    const broken = loose.replace('pick -->|"무료방"| create --> play', 'pick -.- create');
    await fs.writeFile(path.join(maps, '30-broken.mmd'), broken);
    await fs.copyFile(path.join(sampleMaps, '09-sequence.mmd'), path.join(maps, '09-sequence.mmd'));

    const dryRun = run('format', directory, '--dry-run');
    expect(dryRun).toContain('would 20-rooms.mmd');
    expect(dryRun).toContain('same  02-lending.mmd');
    expect(await fs.readFile(path.join(maps, '20-rooms.mmd'), 'utf8')).toBe(loose);

    const output = run('format', directory);
    expect(output).toContain('wrote 20-rooms.mmd');
    expect(output).toContain('skip  30-broken.mmd');
    expect(output).toContain('skip  09-sequence.mmd');
    const formatted = await fs.readFile(path.join(maps, '20-rooms.mmd'), 'utf8');
    expect(formatted).toBe(writeFlowMap(parseFlowMap(loose)));
    expect(formatted).toContain('  pick -->|"무료방"| create\n  create --> play\n');
    expect(parseFlowMap(formatted)).toEqual(parseFlowMap(loose));
    expect(await fs.readFile(path.join(maps, '30-broken.mmd'), 'utf8')).toBe(broken);
    expect((await fs.readdir(maps)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    expect(run('format', directory)).toContain('same  20-rooms.mmd');
  });
});
