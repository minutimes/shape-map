import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSource, writeSource } from '../lib/format.mjs';
import { applyFlowOperation, parseFlowMap, writeFlowMap } from '../lib/flowMap.mjs';
import { classifyMap, detectMapKind, readEditableMap } from '../lib/mapSource.mjs';

const sample = (name) => fs.readFileSync(new URL(`../examples/sample-project/docs/maps/${name}`, import.meta.url), 'utf8');
const lending = sample('02-lending.mmd');
const features = sample('01-features.mmd');

function flow(body, header = '{"kind":"user-flow"}') {
  return `flowchart LR\n  %% sm-map: ${header}\n${body}`;
}

function errorOf(action) {
  try { action(); } catch (error) { return error; }
  throw new Error('expected an error');
}

describe('features map header', () => {
  it('round-trips the sample features map byte for byte and keeps the header', () => {
    const graph = parseSource(features);
    expect(graph.map).toEqual({ kind: 'features', title: '동네 책장 기능' });
    expect(writeSource(graph)).toBe(features);
  });

  it('keeps headerless v1 maps unchanged and rejects other kinds or a second header', () => {
    for (const file of ['demo.mmd', 'shape-map.mmd', 'synthetic.mmd']) {
      const source = fs.readFileSync(new URL(`../maps/${file}`, import.meta.url), 'utf8');
      const graph = parseSource(source);
      expect(graph.map).toBeUndefined();
      expect(writeSource(graph)).toBe(source);
    }
    expect(() => parseSource(features.replace('"kind":"features"', '"kind":"user-flow"'))).toThrow(/Line 3: Unsupported map kind/);
    expect(() => parseSource(features.replace('  app([', '  %% sm-map: {"kind":"features"}\n  app(['))).toThrow(/duplicate map header/);
    expect(() => parseSource(features.replace('"title"', '"name"'))).toThrow(/Unsupported map header field: name/);
  });
});

describe('flow map format', () => {
  it('round-trips the sample user flow map byte for byte', () => {
    const graph = parseFlowMap(lending);
    expect(writeFlowMap(graph)).toBe(lending);
    expect(graph.map).toMatchObject({ kind: 'user-flow', title: '책 빌리고 빌려주기' });
    expect(graph.lanes.map(({ id }) => id)).toEqual(['reader', 'owner', 'catalog', 'platform']);
    expect(graph.lanes[2]).toMatchObject({ tags: ['provider'], summary: expect.stringContaining('책 제목') });
    expect(graph.steps[0]).toEqual({ id: 'reader_open', label: '앱 열기', shape: 'milestone', lane: 'reader', tags: [] });
    expect(graph.steps.find(({ id }) => id === 'reader_available').shape).toBe('decision');
    expect(graph.arrows[3]).toEqual({ source: 'reader_available', target: 'reader_wait', style: 'alternative', label: '없어요' });
    expect(graph.arrows.find(({ style }) => style === 'exchange')).toBeTruthy();
  });

  it('accepts a valid file in another order and writes canonical order without changing meaning', () => {
    const source = flow([
      '  a --> b',
      '  shared["함께 보는 단계"]',
      '  %% mlc-legend: hot|뜨거움|중요한 단계',
      '  class b,lane1 hot',
      '  subgraph lane1["첫 줄"]',
      '    a(["시작"])',
      '    b{"고르기"}',
      '  end',
      '  classDef hot fill:#FFFFFF,stroke:#000000,color:#111111,stroke-width:1px',
      '  b -.->|"다시"| shared',
      '  %% sm-block: b|{"summary":"설명"}',
      '',
    ].join('\n'));
    const graph = parseFlowMap(source);
    const canonical = writeFlowMap(graph);
    expect(canonical).toBe(flow([
      '  subgraph lane1["첫 줄"]',
      '    a(["시작"])',
      '    b{"고르기"}',
      '  end',
      '  shared["함께 보는 단계"]',
      '',
      '  a --> b',
      '  b -.->|"다시"| shared',
      '',
      '  classDef hot fill:#FFFFFF,stroke:#000000,color:#111111,stroke-width:1px',
      '  class lane1,b hot',
      '',
      '  %% sm-block: b|{"summary":"설명"}',
      '',
      '  %% mlc-legend: hot|뜨거움|중요한 단계',
      '',
    ].join('\n')));
    expect(parseFlowMap(canonical)).toEqual(graph);
  });

  it('rejects unsupported statements with their line numbers', () => {
    const cases = [
      [flow('  a["x"]\n  b["y"]\n  a --> b --> a --> b\n'), 5, /duplicate arrow a → b/],
      [flow('  a["x"] --> b["y"]\n'), 3, /declare each step on its own line/],
      [flow('  a["x"]\n  b["y"]\n  a & b --> a\n'), 5, /instead of &/],
      [flow('  a["x"]\n  b["y"]\n  a --- b\n'), 5, /need an arrowhead.*---/],
      [flow('  a["x"]\n  b["y"]\n  a -.- b\n'), 5, /need an arrowhead.*-\.-/],
      [flow('  subgraph l["L"]\n    a --> b\n  end\n'), 4, /steps already declared in that lane/],
      [flow('  a["x"]\n  subgraph l["L"]\n    b["y"]\n    a --> b\n  end\n'), 6, /steps already declared in that lane/],
      [flow('  subgraph l["L"]\n    b["y"]\n    direction TB\n  end\n'), 5, /first statement in a lane/],
      [flow('  subgraph l["L"]\n    %% note\n  end\n'), 4, /sm-block/],
      [flow('  classDef t fill:#FFFFFF,stroke:#000000,color:#111111,stroke-width:1px,stroke-dasharray:0 3\n  %% mlc-legend: t|T|t\n'), 3, /from 1 to 40/],
      [flow('  subgraph l["L"]\n    direction XY\n  end\n'), 4, /only steps and arrows/],
      [flow('  subgraph l["L"]\n    subgraph m["M"]\n    end\n  end\n'), 4, /cannot be nested/],
      [flow('  subgraph l["L"]\n    a["x"]\n'), 3, /missing its end/],
      [flow('  end\n'), 3, /end without/],
      [flow('  a["x"]\n  a --> missing\n'), 4, /undeclared step missing/],
      [flow('  subgraph l["L"]\n  end\n  a["x"]\n  a --> l\n'), 6, /not lanes/],
      [flow('  a["x"]\n  a --> a\n'), 4, /different steps/],
      [flow('  a["x"]\n  b["y"]\n  a --> b\n  a -.-> b\n'), 6, /duplicate arrow/],
      [flow('  a["x"]\n  a["y"]\n'), 4, /duplicate ID a/],
      [flow('  End["x"]\n'), 3, /Mermaid keyword/],
      [flow('  a[("x")]\n'), 3, /unsupported statement/],
      [flow('  a["say \\"hi\\""]\n'), 3, /double quote/],
      [flow('  a["x"]\n  style a fill:#fff\n'), 4, /unsupported statement/],
      [flow('  %% just a note\n'), 3, /other comments are not supported; write notes as a step description/],
      [flow('  a["x"]\n  %% sm-block: a|{"summary":"s","files":[]}\n'), 4, /only summary/],
      [flow('  a["x"]\n  class a ghost\n'), 4, /undefined tag ghost/],
      [flow('  classDef t fill:#FFFFFF,stroke:#000000,color:#111111,stroke-width:1px\n'), 3, /missing its legend/],
      [flow('  a["x"]\n', '{"kind":"user-flow","owner":"me"}'), 2, /Unsupported map header field/],
      [flow(`  a["${'가'.repeat(201)}"]\n`), 3, /at most 200/],
    ];
    for (const [source, line, message] of cases) {
      const error = errorOf(() => parseFlowMap(source));
      expect(error.message, source).toMatch(message);
      expect(error.details?.line, source).toBe(line);
    }
    expect(() => parseFlowMap('flowchart LR\n  a["x"]\n')).toThrow(/needs a %% sm-map: header/);
    expect(() => parseFlowMap('flowchart RL\n  %% sm-map: {"kind":"user-flow"}\n')).toThrow(/Line 1: unsupported statement/);
  });

  it('round-trips the sample system flow and accepts common Mermaid flowchart forms', () => {
    const system = sample('03-lending-system.mmd');
    const graph = parseFlowMap(system);
    expect(writeFlowMap(graph)).toBe(system);
    expect(graph).toMatchObject({ map: { kind: 'system-flow' }, direction: 'TB', lanes: [] });
    expect(graph.tags[1]).toMatchObject({ id: 'open', strokeDasharray: '4 3' });
    expect(graph.arrows.find((arrow) => arrow.source === 'next_owner')).toEqual({ source: 'next_owner', target: 'stock', style: 'alternative' });

    const loose = [
      'flowchart TD',
      '  %% sm-map: {"kind":"system-flow"}',
      '  subgraph room["방 서버"]',
      '    direction LR',
      '    wait["대기"]',
      '    play["판"]',
      '    wait --> play -->|"끝"| result',
      '    result["결과"]',
      '    wait-->play2',
      '    play2["둘째 판"]',
      '  end',
      '  plaza(["광장"])',
      '  plaza --> wait==>|"점수"|result -.-> plaza',
      '  classDef hot fill:#FFFFFF,stroke:#000000,color:#111111,stroke-width:2px,stroke-dasharray:5 5',
      '  class wait hot',
      '  class room,play hot',
      '  %% mlc-legend: hot|뜨거움|중요한 단계',
      '',
    ].join('\n');
    // The in-lane arrows above name steps declared later, so they are rejected first.
    expect(() => parseFlowMap(loose)).toThrow(/Line 7: an arrow inside a lane/);
    const fixed = loose.replace('    wait --> play -->|"끝"| result\n    result["결과"]\n    wait-->play2\n    play2["둘째 판"]\n',
      '    result["결과"]\n    play2["둘째 판"]\n    wait --> play -->|"끝"| result\n    wait-->play2\n');
    const parsed = parseFlowMap(fixed);
    expect(parsed.direction).toBe('TD');
    expect(parsed.lanes[0]).toEqual({ id: 'room', title: '방 서버', direction: 'LR', tags: ['hot'] });
    expect(parsed.arrows).toEqual([
      { source: 'wait', target: 'play', style: 'next' },
      { source: 'play', target: 'result', style: 'next', label: '끝' },
      { source: 'wait', target: 'play2', style: 'next' },
      { source: 'plaza', target: 'wait', style: 'next' },
      { source: 'wait', target: 'result', style: 'exchange', label: '점수' },
      { source: 'result', target: 'plaza', style: 'alternative' },
    ]);
    expect(writeFlowMap(parsed)).toBe([
      'flowchart TD',
      '  %% sm-map: {"kind":"system-flow"}',
      '  subgraph room["방 서버"]',
      '    direction LR',
      '    wait["대기"]',
      '    play["판"]',
      '    result["결과"]',
      '    play2["둘째 판"]',
      '  end',
      '  plaza(["광장"])',
      '',
      '  wait --> play',
      '  play -->|"끝"| result',
      '  wait --> play2',
      '  plaza --> wait',
      '  wait ==>|"점수"| result',
      '  result -.-> plaza',
      '',
      '  classDef hot fill:#FFFFFF,stroke:#000000,color:#111111,stroke-width:2px,stroke-dasharray:5 5',
      '  class room,wait,play hot',
      '',
      '  %% mlc-legend: hot|뜨거움|중요한 단계',
      '',
    ].join('\n'));
  });

  it('enforces the lane limit with the line of the excess lane', () => {
    const lanes = Array.from({ length: 51 }, (_, index) => `  subgraph l${index}["L"]\n  end`).join('\n');
    const error = errorOf(() => parseFlowMap(flow(`${lanes}\n`)));
    expect(error.message).toMatch(/at most 50 lanes/);
    expect(error.details.line).toBe(2 + 50 * 2 + 1);
  });
});

describe('map kinds', () => {
  it('detects kinds from the header or the v1 marker and explains files it cannot edit', async () => {
    expect(detectMapKind(features).kind).toBe('features');
    expect(detectMapKind(lending).kind).toBe('user-flow');
    expect(detectMapKind(sample('09-sequence.mmd'))).toMatchObject({ kind: 'other' });
    expect(detectMapKind(flow('', '{"kind":"timeline"}'))).toMatchObject({ kind: 'other', declaredKind: 'timeline', line: 2 });
    expect(await classifyMap(sample('09-sequence.mmd'), '09-sequence.mmd')).toMatchObject({ kind: 'other', editable: false, title: '09-sequence' });
    expect(await classifyMap(lending, '02-lending.mmd')).toMatchObject({ kind: 'user-flow', editable: true, title: '책 빌리고 빌려주기', description: expect.any(String) });
    const broken = lending.replace('  reader_open --> reader_search', '  reader_open --> nowhere');
    expect(await classifyMap(broken, 'x.mmd')).toMatchObject({ kind: 'user-flow', editable: false, title: '책 빌리고 빌려주기', line: 33 });
    const headerless = 'flowchart LR\n  a["x"]\n';
    expect(await classifyMap(headerless, 'plain.mmd')).toMatchObject({ kind: 'other', editable: false });
  });

  it('runs Mermaid validation on user flow maps with a line number', async () => {
    const source = flow('  a["x"]\n  call["y"]\n  a --> call\n');
    const error = await readEditableMap(source).catch((caught) => caught);
    expect(error.kind).toBe('user-flow');
    expect(error.message).toMatch(/Mermaid/);
    expect(error.line).toBe(5);
  });
});

describe('flow map operations', () => {
  const base = () => parseFlowMap(lending);

  it('adds steps with generated IDs, placement, connections, and splices', () => {
    let graph = applyFlowOperation(base(), { type: 'addStep', lane: 'owner', label: '새 단계', after: 'owner_list' });
    let laneSteps = graph.steps.filter((step) => step.lane === 'owner').map(({ id }) => id);
    expect(laneSteps.slice(0, 2)).toEqual(['owner_list', 'step-1']);
    graph = applyFlowOperation(graph, { type: 'addStep', lane: 'owner', label: '맨 앞', before: 'owner_list', shape: 'milestone', connectFrom: 'step-1' });
    laneSteps = graph.steps.filter((step) => step.lane === 'owner').map(({ id }) => id);
    expect(laneSteps.slice(0, 3)).toEqual(['step-2', 'owner_list', 'step-1']);
    expect(graph.arrows.at(-1)).toEqual({ source: 'step-1', target: 'step-2', style: 'next' });
    graph = applyFlowOperation(graph, { type: 'addStep', lane: null, label: '공유 단계', id: 'shared_check',
      splice: { source: 'reader_available', target: 'reader_wait' } });
    const index = graph.arrows.findIndex((arrow) => arrow.target === 'shared_check');
    expect(graph.arrows.slice(index, index + 2)).toEqual([
      { source: 'reader_available', target: 'shared_check', style: 'alternative', label: '없어요' },
      { source: 'shared_check', target: 'reader_wait', style: 'next' },
    ]);
    expect(graph.steps.at(-1)).toMatchObject({ id: 'shared_check', lane: null });
    expect(writeFlowMap(graph)).toContain('  end\n  shared_check["공유 단계"]\n\n');
    expect(() => applyFlowOperation(graph, { type: 'addStep', lane: 'owner', label: 'x', after: 'reader_open' })).toThrow(/same lane/);
    expect(() => applyFlowOperation(graph, { type: 'addStep', lane: 'owner', label: 'x', id: 'owner_list' })).toThrow(/already used/);
    expect(() => applyFlowOperation(graph, { type: 'addStep', label: 'x' })).toThrow(/lane is required/);
    expect(() => applyFlowOperation(graph, { type: 'addStep', lane: 'owner', label: 'x', color: 'red' })).toThrow(/Unsupported addStep field: color/);
  });

  it('updates, moves, and deletes steps with bridging', () => {
    let graph = applyFlowOperation(base(), { type: 'updateStep', id: 'reader_wait', label: '알림 받기', shape: 'milestone', tags: ['meet', 'money'], summary: '나중에 알려 줘요.' });
    expect(graph.steps.find(({ id }) => id === 'reader_wait')).toEqual({ id: 'reader_wait', label: '알림 받기', shape: 'milestone', lane: 'reader', tags: ['money', 'meet'], summary: '나중에 알려 줘요.' });
    graph = applyFlowOperation(graph, { type: 'updateStep', id: 'reader_wait', summary: null, tags: [] });
    expect(graph.steps.find(({ id }) => id === 'reader_wait').summary).toBeUndefined();
    const arrowsBefore = structuredClone(graph.arrows);
    graph = applyFlowOperation(graph, { type: 'moveStep', id: 'catalog_send', lane: 'platform', before: 'platform_fill' });
    expect(graph.steps.filter((step) => step.lane === 'platform').map(({ id }) => id)[0]).toBe('catalog_send');
    expect(graph.arrows).toEqual(arrowsBefore);
    // reader_receive has one incoming (owner_handover ==>|"책"|) and one outgoing arrow.
    graph = applyFlowOperation(graph, { type: 'deleteSteps', ids: ['reader_receive'] });
    expect(graph.arrows).toContainEqual({ source: 'owner_handover', target: 'reader_return', style: 'exchange', label: '책' });
    expect(graph.steps.some(({ id }) => id === 'reader_receive')).toBe(false);
    const unbridged = applyFlowOperation(graph, { type: 'deleteSteps', ids: ['reader_return'], bridge: false });
    expect(unbridged.arrows.some((arrow) => arrow.source === 'owner_handover' && arrow.target === 'owner_collect')).toBe(false);
    // A chain deleted in one operation is bridged end to end.
    let chain = parseFlowMap(flow('  a["a"]\n  b["b"]\n  c["c"]\n  d["d"]\n  a -->|"go"| b\n  b --> c\n  c --> d\n'));
    chain = applyFlowOperation(chain, { type: 'deleteSteps', ids: ['b', 'c'] });
    expect(chain.arrows).toEqual([{ source: 'a', target: 'd', style: 'next', label: 'go' }]);
  });

  it('edits arrows, lanes, tags, and the header', () => {
    let graph = applyFlowOperation(base(), { type: 'addArrow', source: 'reader_open', target: 'reader_review', style: 'alternative', label: '바로 가기' });
    expect(graph.arrows.at(-1)).toEqual({ source: 'reader_open', target: 'reader_review', style: 'alternative', label: '바로 가기' });
    expect(() => applyFlowOperation(graph, { type: 'addArrow', source: 'reader_open', target: 'reader_review' })).toThrow(/already connected/);
    expect(() => applyFlowOperation(graph, { type: 'addArrow', source: 'reader', target: 'reader_review' })).toThrow(/Source step does not exist/);
    graph = applyFlowOperation(graph, { type: 'updateArrow', source: 'reader_open', target: 'reader_review', label: null, style: 'exchange', newTarget: 'reader_refund' });
    expect(graph.arrows.at(-1)).toEqual({ source: 'reader_open', target: 'reader_refund', style: 'exchange' });
    graph = applyFlowOperation(graph, { type: 'removeArrow', source: 'reader_open', target: 'reader_refund' });
    expect(graph.arrows).toHaveLength(base().arrows.length);
    graph = applyFlowOperation(graph, { type: 'addLane', title: '배송 기사', after: 'owner', tags: ['provider'], summary: '책을 옮겨요.' });
    expect(graph.lanes.map(({ id }) => id)).toEqual(['reader', 'owner', 'lane-1', 'catalog', 'platform']);
    graph = applyFlowOperation(graph, { type: 'addLane', title: '맨 위', after: null, id: 'top' });
    graph = applyFlowOperation(graph, { type: 'moveLane', id: 'platform', after: null });
    expect(graph.lanes.map(({ id }) => id)).toEqual(['platform', 'top', 'reader', 'owner', 'lane-1', 'catalog']);
    expect(graph.steps[0].lane).toBe('platform');
    graph = applyFlowOperation(graph, { type: 'updateLane', id: 'lane-1', title: '택배', summary: '' });
    expect(graph.lanes.find(({ id }) => id === 'lane-1')).toEqual({ id: 'lane-1', title: '택배', tags: ['provider'] });
    expect(() => applyFlowOperation(graph, { type: 'deleteLane', id: 'catalog' })).toThrow(/withSteps/);
    graph = applyFlowOperation(graph, { type: 'deleteLane', id: 'catalog', withSteps: true });
    expect(graph.steps.some(({ id }) => id === 'catalog_send')).toBe(false);
    expect(graph.arrows.some((arrow) => arrow.source === 'catalog_send')).toBe(false);
    graph = applyFlowOperation(graph, { type: 'upsertTag', tag: { id: 'money', label: '돈', description: '결제', fill: '#FFFFFF', stroke: '#000000', textColor: '#000000', strokeWidth: 2 } });
    expect(graph.tags.find(({ id }) => id === 'money')).toMatchObject({ label: '돈', strokeWidth: 2 });
    graph = applyFlowOperation(graph, { type: 'deleteTag', id: 'money' });
    expect([...graph.lanes, ...graph.steps].some((item) => item.tags.includes('money'))).toBe(false);
    graph = applyFlowOperation(graph, { type: 'setMapHeader', title: '새 이름', description: null });
    expect(graph.map).toEqual({ kind: 'user-flow', title: '새 이름' });
    expect(parseFlowMap(writeFlowMap(graph))).toEqual(graph);
  });
});
