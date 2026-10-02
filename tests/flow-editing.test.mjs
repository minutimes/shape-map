import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOperation, graphOf, parseFlow, serializeFlow } from '../harness/flow/flowModel.js';
import { createFakeFlowApi } from '../harness/flow/fakeApi.js';
import { FLOW_VOCABULARY, flowVocabulary, TAG_PALETTE } from '../src/flow/flowConstants.js';
import {
  changeLaneOperation, cleanLabel, cleanSummary, connectOperation, connectableTargets, deleteLanePlan, describeError, emphasisFor,
  insertOnArrowOperation, laneStepOperation, moveLaneOperation, newIdAfter, newTagId, nextStepOperation, paletteIndexFor, pushHistory,
  reorderStepOperation, reverseArrowOperation, stepRelations, tagOperation, tagUsage, toggleTag,
} from '../src/flow/flowEditing.js';

const source = fs.readFileSync(new URL('../examples/sample-project/docs/maps/02-lending.mmd', import.meta.url), 'utf8');
const systemSource = fs.readFileSync(new URL('../examples/sample-project/docs/maps/03-lending-system.mmd', import.meta.url), 'utf8');
const model = parseFlow(source);
const graph = graphOf(model);
const apply = (operation) => graphOf(applyOperation(model, operation));

describe('flow map vocabulary', () => {
  it('keeps one word set per kind', () => {
    expect(flowVocabulary('user-flow').kindLabel).toBe('유저 플로우');
    expect(flowVocabulary('system-flow').kindLabel).toBe('시스템 플로우');
    expect(flowVocabulary('system-flow').lane).toBe('영역');
    expect(flowVocabulary('unknown')).toBe(FLOW_VOCABULARY['user-flow']);
    for (const words of Object.values(FLOW_VOCABULARY)) expect(JSON.stringify(Object.keys(words).sort())).toBe(JSON.stringify(Object.keys(FLOW_VOCABULARY['user-flow']).sort()));
  });
});

describe('flow map editing helpers', () => {
  it('cleans one-line labels that Mermaid can store', () => {
    expect(cleanLabel('  "빠른" 참가\n누르기 ')).toBe('“빠른” 참가 누르기');
    expect(cleanLabel('가'.repeat(300))).toHaveLength(200);
    expect(cleanSummary('첫 줄\n둘째 "줄"')).toBe('첫 줄\n둘째 “줄”');
  });

  it('adds the next step after a step and connects it', () => {
    const operation = nextStepOperation(graph, 'reader_search');
    expect(operation).toEqual({ type: 'addStep', lane: 'reader', label: '새 단계', after: 'reader_search', connectFrom: 'reader_search' });
    const next = apply(operation);
    const id = newIdAfter(graph, next);
    expect(id).toBe('step-1');
    expect(next.arrows.some((arrow) => arrow.source === 'reader_search' && arrow.target === id && arrow.style === 'next')).toBe(true);
  });

  it('inserts a step on an arrow and keeps the old style and label first', () => {
    const arrow = graph.arrows.find((item) => item.source === 'reader_request');
    const next = apply(insertOnArrowOperation(graph, arrow));
    const id = newIdAfter(graph, next);
    expect(next.arrows.find((item) => item.source === 'reader_request')).toMatchObject({ target: id, style: 'exchange', label: '대여 요청' });
    expect(next.arrows.find((item) => item.source === id)).toMatchObject({ target: 'platform_match', style: 'next' });
    expect(next.steps.find((step) => step.id === id).lane).toBe('reader');
  });

  it('adds a step at the end of a lane', () => {
    expect(laneStepOperation(graph, 'catalog')).toEqual({ type: 'addStep', lane: 'catalog', label: '새 단계', after: 'catalog_send' });
    expect(laneStepOperation({ ...graph, steps: [] }, null)).toEqual({ type: 'addStep', lane: null, label: '새 단계' });
  });

  it('reorders steps within a lane and moves them between lanes', () => {
    expect(reorderStepOperation(graph, 'reader_search', 'earlier')).toEqual({ type: 'moveStep', id: 'reader_search', lane: 'reader', before: 'reader_open' });
    expect(reorderStepOperation(graph, 'reader_open', 'earlier')).toBeNull();
    expect(reorderStepOperation(graph, 'reader_review', 'later')).toBeNull();
    const moved = apply(reorderStepOperation(graph, 'reader_open', 'later'));
    expect(moved.steps.filter((step) => step.lane === 'reader').slice(0, 2).map((step) => step.id)).toEqual(['reader_search', 'reader_open']);
    expect(changeLaneOperation(graph, 'catalog_send', 'platform')).toEqual({ type: 'moveStep', id: 'catalog_send', lane: 'platform', after: 'platform_settle' });
    expect(changeLaneOperation(graph, 'catalog_send', 'catalog')).toBeNull();
  });

  it('moves lanes up and down', () => {
    expect(moveLaneOperation(graph, 'owner', 'up')).toEqual({ type: 'moveLane', id: 'owner', after: null });
    expect(moveLaneOperation(graph, 'catalog', 'up')).toEqual({ type: 'moveLane', id: 'catalog', after: 'reader' });
    expect(moveLaneOperation(graph, 'reader', 'down')).toEqual({ type: 'moveLane', id: 'reader', after: 'owner' });
    expect(moveLaneOperation(graph, 'platform', 'down')).toBeNull();
    expect(apply(moveLaneOperation(graph, 'catalog', 'up')).lanes.map((lane) => lane.id)).toEqual(['reader', 'catalog', 'owner', 'platform']);
  });

  it('asks before deleting a lane that has steps', () => {
    expect(deleteLanePlan(graph, 'catalog')).toEqual({ needsConfirmation: true, stepCount: 1, operation: { type: 'deleteLane', id: 'catalog', withSteps: true } });
    const empty = graphOf(applyOperation(model, { type: 'addLane', title: '빈 줄' }));
    expect(deleteLanePlan(empty, 'lane-1')).toEqual({ needsConfirmation: false, stepCount: 0, operation: { type: 'deleteLane', id: 'lane-1' } });
  });

  it('connects steps once and reverses arrows only when free', () => {
    expect(connectOperation(graph, 'reader_open', 'reader_open').error).toBeTruthy();
    expect(connectOperation(graph, 'reader_open', 'reader_search').error).toBe('이미 이어져 있어요.');
    expect(connectOperation(graph, 'reader_open', 'reader_review', 'alternative').operation).toEqual({ type: 'addArrow', source: 'reader_open', target: 'reader_review', style: 'alternative' });
    expect(connectableTargets(graph, 'reader_open').some((step) => step.id === 'reader_search')).toBe(false);
    const arrow = graph.arrows.find((item) => item.source === 'reader_open');
    expect(reverseArrowOperation(graph, arrow).operation).toEqual({ type: 'updateArrow', source: 'reader_open', target: 'reader_search', newSource: 'reader_search', newTarget: 'reader_open' });
  });

  it('lists the arrows around a step', () => {
    const relations = stepRelations(graph, 'reader_search');
    expect(relations.incoming.map((item) => item.other)).toEqual(['reader_wait', 'platform_fill', 'reader_open'].sort((a, b) => graph.arrows.findIndex((x) => x.source === a) - graph.arrows.findIndex((x) => x.source === b)));
    expect(relations.outgoing.map((item) => item.label)).toEqual(['지금 빌릴 수 있나?']);
  });

  it('builds tags from the palette and keeps tag order', () => {
    expect(newTagId(graph)).toBe('tag-1');
    expect(toggleTag(['data'], 'money', graph.tags.map((tag) => tag.id))).toEqual(['money', 'data']);
    expect(toggleTag(['money', 'data'], 'money')).toEqual(['data']);
    const operation = tagOperation({ id: 'tag-1', label: '위험 | 큼', description: '조심 | 할 곳', paletteIndex: 4, dashed: true });
    expect(operation.tag).toMatchObject({ id: 'tag-1', label: '위험 | 큼', description: '조심 / 할 곳', fill: TAG_PALETTE[4].fill, strokeDasharray: '4 3' });
    expect(paletteIndexFor(graph.tags.find((tag) => tag.id === 'money'))).toBe(0);
    const custom = { id: 'x', fill: '#E6EAFB', stroke: '#3550C8', textColor: '#1A1F26', strokeWidth: 2 };
    expect(tagOperation({ id: 'x', label: '광장', paletteIndex: -1, base: custom }).tag).toMatchObject({ fill: '#E6EAFB', stroke: '#3550C8' });
    expect(tagUsage(graph, 'provider')).toBe(2);
  });

  it('highlights a tag through steps and lane tags without changing the map', () => {
    const money = emphasisFor(graph, { tagId: 'money' });
    expect(money.steps.get('reader_deposit')).toBe('on');
    expect(money.steps.get('reader_open')).toBe('off');
    expect(money.arrows.get('reader_deposit->platform_hold')).toBe('on');
    const provider = emphasisFor(graph, { tagId: 'provider' });
    expect(provider.steps.get('catalog_send')).toBe('on');
    expect(provider.lanes.get('owner')).toBe('on');
    expect(provider.lanes.get('reader')).toBe('off');
    expect(emphasisFor(graph, {})).toBeNull();
  });

  it('focuses one participant and keeps its direct partners readable', () => {
    const focus = emphasisFor(graph, { laneId: 'catalog' });
    expect(focus.steps.get('catalog_send')).toBe('on');
    expect(focus.steps.get('platform_fill')).toBe('near');
    expect(focus.steps.get('reader_open')).toBe('off');
    expect(focus.arrows.get('catalog_send->platform_fill')).toBe('near');
    expect(focus.lanes.get('catalog')).toBe('on');
  });

  it('keeps a bounded undo history and ignores no-op entries', () => {
    let stack = [];
    for (let index = 0; index < 105; index += 1) stack = pushHistory(stack, { before: `${index}`, after: `${index + 1}`, label: 'x' });
    expect(stack).toHaveLength(100);
    expect(pushHistory(stack, { before: 'a', after: 'a' })).toBe(stack);
  });

  it('explains failures in plain Korean', () => {
    expect(describeError({ status: 409, body: { code: 'revision_conflict' } }).kind).toBe('conflict');
    expect(describeError({ status: 422, body: { code: 'validation_error', message: 'x', details: { line: 7 } } })).toMatchObject({ kind: 'validation', line: 7, text: '7번째 줄을 확인해 주세요.' });
    expect(describeError({ status: 422, body: { code: 'invalid_source' } }).kind).toBe('invalid');
    expect(describeError(new TypeError('Failed to fetch')).kind).toBe('offline');
  });
});

describe('development flow map model', () => {
  it('reads and writes the sample maps canonically', () => {
    expect(serializeFlow(parseFlow(source))).toBe(source);
    expect(serializeFlow(parseFlow(systemSource))).toBe(systemSource);
    const system = graphOf(parseFlow(systemSource));
    expect(system.map.kind).toBe('system-flow');
    expect(system.direction).toBe('TB');
    expect(system.tags.find((tag) => tag.id === 'open').strokeDasharray).toBe('4 3');
  });

  it('accepts chained arrows and arrows inside a lane', () => {
    const graphText = graphOf(parseFlow('flowchart TB\n  %% sm-map: {"kind":"system-flow"}\n  subgraph a["가"]\n    direction LR\n    x["x"]\n    y["y"]\n    x --> y\n  end\n  z["z"]\n  y --> z -.->|"다시"| x\n'));
    expect(graphText.arrows).toEqual([{ source: 'x', target: 'y', style: 'next' }, { source: 'y', target: 'z', style: 'next' }, { source: 'z', target: 'x', style: 'alternative', label: '다시' }]);
    expect(graphText.lanes[0].direction).toBe('LR');
  });

  it('bridges deleted steps per deleteSteps', () => {
    const next = apply({ type: 'deleteSteps', ids: ['reader_search'] });
    expect(next.arrows.some((arrow) => arrow.target === 'reader_available')).toBe(false);
    const single = apply({ type: 'deleteSteps', ids: ['reader_receive'] });
    expect(single.arrows.find((arrow) => arrow.source === 'owner_handover' && arrow.target === 'reader_return')).toMatchObject({ style: 'exchange', label: '책' });
  });

  it('rejects a stale revision with a fresh snapshot and reports source lines', async () => {
    const harness = createFakeFlowApi(source, { latency: 0 });
    const first = await harness.api.readMap();
    harness.external({ type: 'updateStep', id: 'reader_open', label: '앱을 연다' });
    await expect(harness.api.mutateMap({ baseRevision: first.revision, clientId: 'c', operation: { type: 'updateStep', id: 'reader_open', label: 'x' } }))
      .rejects.toMatchObject({ status: 409, body: { code: 'revision_conflict', snapshot: { graph: { steps: expect.any(Array) } } } });
    const current = harness.snapshot();
    await expect(harness.api.mutateMap({ baseRevision: current.revision, clientId: 'c', operation: { type: 'replaceSource', source: `${source}  broken line\n` } }))
      .rejects.toMatchObject({ status: 422, body: { code: 'validation_error', details: { line: source.split('\n').length } } });
    harness.writeFile('flowchart LR\n  nonsense');
    expect(harness.snapshot().sourceStatus).toMatchObject({ valid: false, line: 2 });
    await expect(harness.api.mutateMap({ baseRevision: current.revision, clientId: 'c', operation: { type: 'setMapHeader', title: 'x' } }))
      .rejects.toMatchObject({ status: 422, body: { code: 'invalid_source' } });
  });
});
