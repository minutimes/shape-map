import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyFlowOperation, parseFlowMap, writeFlowMap } from '../lib/flowMap.mjs';
import { flowStepFingerprint, flowStepState, flowStepStates } from '../lib/flowState.mjs';
import { flowDiscussionBrief } from '../lib/discussion.mjs';

const sample = (name) => fs.readFileSync(new URL(`../examples/sample-project/docs/maps/${name}`, import.meta.url), 'utf8');
const lending = sample('02-lending.mmd');

function flow(body) {
  return `flowchart LR\n  %% sm-map: {"kind":"user-flow","title":"방"}\n${body}`;
}

function errorOf(action) {
  try { action(); } catch (error) { return error; }
  throw new Error('expected an error');
}

let clock = 0;
function context(extra = {}) {
  clock += 1;
  return { now: new Date(Date.UTC(2026, 9, 1, 0, 0, clock)).toISOString(), revision: `rev${clock}`, commentId: `c${clock}`, turnId: `t${clock}`, ...extra };
}
const run = (graph, operation) => applyFlowOperation(graph, operation, context());
const step = (graph, id) => graph.steps.find((item) => item.id === id);

describe('flow collaboration format', () => {
  it('keeps existing flow files byte for byte and writes nothing for absent records', () => {
    for (const name of ['02-lending.mmd', '03-lending-system.mmd']) {
      const source = sample(name);
      const graph = parseFlowMap(source);
      expect(writeFlowMap(graph)).toBe(source);
      expect(graph.turns).toBeUndefined();
      expect(graph.steps.some((item) => item.comments || item.review || item.proposal || item.features || item.status)).toBe(false);
    }
  });

  it('round-trips memos, review, proposals, feature links, and turns in canonical order', () => {
    let graph = parseFlowMap(lending);
    graph = run(graph, { type: 'addComment', id: 'reader_search', body: '검색이 어렵다', kind: 'concern', author: '사람' });
    graph = run(graph, { type: 'setProposal', id: 'reader_wait', proposal: { reason: '알림이 늦다', logic: '바로 알린다', successCriteria: '1분 안에 알림' } });
    graph = run(graph, { type: 'updateStep', id: 'reader_search', features: [{ map: '01-features.mmd', id: 'search' }] });
    graph = run(graph, { type: 'setBlock', id: 'reader_open', block: { status: 'verified' } });
    graph = run(graph, { type: 'createTurn', title: '첫 기록', summary: '지금 모습' });
    const source = writeFlowMap(graph);
    expect(source.startsWith(lending.split('\n\n  %% sm-block')[0].split('\n\n  classDef')[0])).toBe(true);
    const lines = source.split('\n');
    const at = (prefix) => lines.findIndex((line) => line.startsWith(prefix));
    expect(at('  %% sm-block: reader_open|')).toBeLessThan(at('  %% mlc-proposal: reader_wait|'));
    expect(at('  %% mlc-proposal:')).toBeLessThan(at('  %% mlc-legend:'));
    expect(at('  %% mlc-legend:')).toBeLessThan(at('  %% sm-turn:'));
    expect(lines[at('  %% sm-block: reader_search|')]).toMatch(/^ {2}%% sm-block: reader_search\|\{"features":\[\{"map":"01-features.mmd","id":"search"\}\],"comments":\[/);
    const reparsed = parseFlowMap(source);
    expect(reparsed).toEqual(graph);
    expect(writeFlowMap(reparsed)).toBe(source);
    expect(reparsed.turns).toHaveLength(1);
    expect(reparsed.turns[0]).toMatchObject({ id: expect.any(String), number: 1, title: '첫 기록', summary: '지금 모습', revision: expect.any(String) });
    expect(step(reparsed.turns[0], 'reader_search').comments[0].body).toBe('검색이 어렵다');
  });

  it('rejects malformed records with their line numbers instead of rewriting them', () => {
    const fingerprint = 'a'.repeat(64);
    const cases = [
      [flow('  a["x"]\n  %% sm-block: a|{"features":[]}\n'), 4, /at least one feature/],
      [flow('  a["x"]\n  %% sm-block: a|{"features":[{"map":"../x.mmd","id":"b"}]}\n'), 4, /map file name in docs\/maps/],
      [flow('  a["x"]\n  %% sm-block: a|{"features":[{"map":"f.mmd","id":"b"},{"map":"f.mmd","id":"b"}]}\n'), 4, /links feature f.mmd#b twice/],
      [flow('  a["x"]\n  %% sm-block: a|{"features":[{"map":"f.mmd","id":"b","label":"x"}]}\n'), 4, /Unsupported feature link field: label/],
      [flow('  a["x"]\n  %% sm-block: a|{"status":"done"}\n'), 4, /invalid status/],
      [flow('  a["x"]\n  %% sm-block: a|{"status":"verified","review":{"at":"2026-01-01T00:00:00.000Z"}}\n'), 4, /SHA-256 fingerprint/],
      [flow(`  a["x"]\n  %% sm-block: a|{"review":{"at":"2026-01-01T00:00:00.000Z","fingerprint":"${fingerprint}","by":"me"}}\n`), 4, /Unsupported review field: by/],
      [flow('  a["x"]\n  %% sm-block: a|{"comments":[{"id":"c","body":"b","kind":"rant","author":"a","createdAt":"2026-01-01T00:00:00.000Z"}]}\n'), 4, /comment kind/],
      [flow('  subgraph l["L"]\n  end\n  %% mlc-proposal: l|{"reason":"r"}\n'), 5, /proposals belong to steps/],
      [flow('  a["x"]\n  %% mlc-proposal: a|{"reason":"r","inputs":"i"}\n'), 4, /not inputs/],
      [flow('  a["x"]\n  %% mlc-proposal: a|{}\n  %% mlc-proposal: a|{}\n'), 5, /duplicate proposal for a/],
      [flow('  a["x"]\n  %% mlc-proposal: b|{}\n'), 4, /proposal references undeclared b/],
      [flow('  a["x"]\n  %% sm-turn: {"id":"t","number":2,"title":"T","createdAt":"2026-01-01T00:00:00.000Z","revision":"r","lanes":[],"steps":[],"arrows":[],"tags":[]}\n'), 4, /turn number must be 1/],
      [flow('  a["x"]\n  %% sm-turn: {"id":"t","number":1,"title":"T","createdAt":"2026-01-01T00:00:00.000Z","revision":"r","lanes":[],"steps":[],"arrows":[],"tags":[],"nodes":[]}\n'), 4, /Unsupported turn field: nodes/],
      [flow('  a["x"]\n  %% sm-turn: {"id":"t","number":1,"title":"T","createdAt":"2026-01-01T00:00:00.000Z","revision":"r","lanes":[],"steps":[{"id":"s","label":"S","shape":"action","lane":"gone","tags":[]}],"arrows":[],"tags":[]}\n'), 4, /Turn t: .*missing lane/],
    ];
    for (const [source, line, message] of cases) {
      const error = errorOf(() => parseFlowMap(source));
      expect(error.message, source).toMatch(message);
      expect(error.details?.line, source).toBe(line);
    }
  });

  it('keeps an empty proposal and the explicit neutral status as written', () => {
    const source = flow('  a["x"]\n\n  %% sm-block: a|{"status":"neutral"}\n\n  %% mlc-proposal: a|{}\n');
    const graph = parseFlowMap(source);
    expect(step(graph, 'a')).toMatchObject({ status: 'neutral', proposal: {} });
    expect(writeFlowMap(graph)).toBe(source);
  });
});

describe('flow collaboration operations', () => {
  it('lets only the map store supply comment IDs, dates, review fingerprints, and turn records', () => {
    const graph = parseFlowMap(lending);
    expect(() => applyFlowOperation(graph, { type: 'addComment', id: 'reader_open', body: 'x', kind: 'note', author: '사람' })).toThrow(/map store/);
    expect(() => applyFlowOperation(graph, { type: 'setBlock', id: 'reader_open', block: { status: 'verified' } })).toThrow(/map store/);
    expect(() => applyFlowOperation(graph, { type: 'createTurn', title: 'x' })).toThrow(/map store/);
    expect(() => run(graph, { type: 'addComment', id: 'reader_open', body: 'x', kind: 'note', author: '사람', createdAt: '2020-01-01' })).toThrow(/Unsupported addComment field: createdAt/);
    expect(() => run(graph, { type: 'setBlock', id: 'reader_open', block: { status: 'verified', review: { at: 'x', fingerprint: 'y' } } })).toThrow(/Unsupported flow setBlock field: review/);
    expect(() => run(graph, { type: 'createTurn', title: 'x', steps: [] })).toThrow(/Unsupported createTurn field/);
    expect(() => run(graph, { type: 'addComment', id: 'reader_open', body: ' ', kind: 'note', author: '사람' })).toThrow(/body/);
    expect(() => run(graph, { type: 'addComment', id: 'reader_open', body: 'x', kind: 'shout', author: '사람' })).toThrow(/kind/);
  });

  it('adds and resolves memos without changing the step fingerprint', () => {
    const before = parseFlowMap(lending);
    const fingerprint = flowStepFingerprint(step(before, 'reader_open'), before);
    let graph = run(before, { type: 'addComment', id: 'reader_open', body: '첫 화면이 비어 보여요', kind: 'concern', author: '사람' });
    const [comment] = step(graph, 'reader_open').comments;
    expect(comment).toMatchObject({ body: '첫 화면이 비어 보여요', kind: 'concern', author: '사람', id: expect.any(String), createdAt: expect.any(String) });
    expect(flowStepFingerprint(step(graph, 'reader_open'), graph)).toBe(fingerprint);
    expect(flowStepState(graph, step(graph, 'reader_open'))).toMatchObject({ status: 'concern', concernCount: 1, unresolvedCount: 1 });
    graph = run(graph, { type: 'resolveComment', id: 'reader_open', commentId: comment.id });
    expect(flowStepState(graph, step(graph, 'reader_open'))).toMatchObject({ status: 'neutral', unresolvedCount: 0, commentCount: 1 });
    graph = run(graph, { type: 'resolveComment', id: 'reader_open', commentId: comment.id, resolved: false });
    expect(step(graph, 'reader_open').comments[0].resolved).toBe(false);
    expect(() => run(graph, { type: 'resolveComment', id: 'reader_open', commentId: 'nope' })).toThrow(/Comment does not exist/);
  });

  it('records review against the current content and drops it when the step or its arrows change', () => {
    let graph = run(parseFlowMap(lending), { type: 'setBlock', id: 'reader_search', block: { status: 'verified' } });
    expect(step(graph, 'reader_search')).toMatchObject({ status: 'verified', review: { fingerprint: flowStepFingerprint(step(graph, 'reader_search'), graph) } });
    expect(flowStepState(graph, step(graph, 'reader_search')).status).toBe('verified');
    // A memo does not touch the review.
    graph = run(graph, { type: 'addComment', id: 'reader_search', body: '좋아요', kind: 'note', author: '사람' });
    expect(step(graph, 'reader_search').review).toBeDefined();
    // An arrow into the step is part of its content.
    graph = run(graph, { type: 'updateArrow', source: 'reader_open', target: 'reader_search', label: '처음에' });
    expect(step(graph, 'reader_search').review).toBeUndefined();
    expect(step(graph, 'reader_search').status).toBeUndefined();
    graph = run(graph, { type: 'setBlock', id: 'reader_search', block: { status: 'verified' } });
    graph = run(graph, { type: 'updateStep', id: 'reader_search', label: '책 찾기' });
    expect(step(graph, 'reader_search').review).toBeUndefined();
    graph = run(graph, { type: 'setBlock', id: 'reader_search', block: { status: 'verified' } });
    graph = run(graph, { type: 'setBlock', id: 'reader_search', block: { status: 'neutral' } });
    expect(step(graph, 'reader_search').review).toBeUndefined();
    expect(step(graph, 'reader_search').status).toBeUndefined();
  });

  it('keeps a proposal red until it is withdrawn, and links features explicitly', () => {
    let graph = run(parseFlowMap(lending), { type: 'setProposal', id: 'reader_wait', proposal: { reason: '  알림이 늦어요 ', purpose: '', logic: '바로 알려요' } });
    expect(step(graph, 'reader_wait').proposal).toEqual({ reason: '알림이 늦어요', logic: '바로 알려요' });
    graph = run(graph, { type: 'addComment', id: 'reader_wait', body: '걱정', kind: 'concern', author: '사람' });
    expect(flowStepState(graph, step(graph, 'reader_wait')).status).toBe('planned');
    graph = run(graph, { type: 'setProposal', id: 'reader_wait', proposal: null });
    expect(step(graph, 'reader_wait').proposal).toBeUndefined();
    expect(flowStepState(graph, step(graph, 'reader_wait')).status).toBe('concern');
    expect(() => run(graph, { type: 'setProposal', id: 'reader_wait', proposal: { owner: 'x' } })).toThrow(/not owner/);

    graph = run(graph, { type: 'updateStep', id: 'reader_wait', features: [{ map: '01-features.mmd', id: 'alert' }, { map: '01-features.mmd', id: 'gone' }] });
    expect(step(graph, 'reader_wait').features).toHaveLength(2);
    // A feature that no longer exists stays linked; the file stays valid.
    expect(parseFlowMap(writeFlowMap(graph))).toEqual(graph);
    graph = run(graph, { type: 'updateStep', id: 'reader_wait', features: [] });
    expect(step(graph, 'reader_wait').features).toBeUndefined();
    expect(writeFlowMap(graph)).not.toContain('"features"');
    expect(() => run(graph, { type: 'updateStep', id: 'reader_wait', features: [{ map: 'a.txt', id: 'x' }] })).toThrow(/map file name/);
  });

  it('records immutable numbered turns and shows blue only between the last two turns', () => {
    let graph = run(parseFlowMap(lending), { type: 'createTurn', title: '처음' });
    expect(flowStepStates(graph).get('reader_search').status).toBe('neutral');
    graph = run(graph, { type: 'updateStep', id: 'reader_search', label: '책 고르기' });
    graph = run(graph, { type: 'addStep', lane: 'reader', label: '추천 보기', id: 'reader_pick', after: 'reader_search' });
    // Live edits without a new turn are not history.
    expect(flowStepStates(graph).get('reader_search').status).toBe('neutral');
    graph = run(graph, { type: 'createTurn', title: '고르기 개선', summary: '이름을 바꿨어요' });
    expect(graph.turns.map((turn) => turn.number)).toEqual([1, 2]);
    const states = flowStepStates(graph);
    expect(states.get('reader_search')).toMatchObject({ status: 'changed', lastTurnChanges: ['label'] });
    expect(states.get('reader_pick')).toMatchObject({ status: 'changed', addedInLastTurn: true });
    expect(states.get('owner_list').status).toBe('neutral');
    // Once the live step moves on from the last turn, blue no longer describes it.
    graph = run(graph, { type: 'updateStep', id: 'reader_search', summary: '새 설명' });
    expect(flowStepStates(graph).get('reader_search').status).toBe('neutral');
    // Review wins over blue; a proposal wins over everything.
    graph = run(graph, { type: 'setBlock', id: 'reader_pick', block: { status: 'verified' } });
    expect(flowStepStates(graph).get('reader_pick').status).toBe('verified');
    graph = run(graph, { type: 'setProposal', id: 'reader_pick', proposal: { reason: '더 줄이기' } });
    expect(flowStepStates(graph).get('reader_pick').status).toBe('planned');
    // Deleting a step keeps the recorded turns intact.
    const turns = structuredClone(graph.turns);
    graph = run(graph, { type: 'deleteSteps', ids: ['reader_pick'] });
    expect(graph.turns).toEqual(turns);
  });
});

describe('flow discussion brief', () => {
  function recorded() {
    let graph = run(parseFlowMap(lending), { type: 'addComment', id: 'reader_open', body: '이미 기록한 메모', kind: 'note', author: '사람' });
    graph = run(graph, { type: 'createTurn', title: '처음' });
    graph = run(graph, { type: 'updateStep', id: 'reader_search', label: '책 고르기', features: [{ map: '01-features.mmd', id: 'search' }, { map: '01-features.mmd', id: 'gone' }] });
    graph = run(graph, { type: 'addComment', id: 'reader_wait', body: '알림이 너무 늦어요', kind: 'concern', author: '사람' });
    graph = run(graph, { type: 'setProposal', id: 'owner_check', proposal: { reason: '요청을 놓쳐요', purpose: '빨리 답하게', successCriteria: '하루 안에 답한다' } });
    graph = run(graph, { type: 'deleteSteps', ids: ['reader_review'] });
    return { mapPath: 'docs/maps/02-lending.mmd', revision: 'abc', graph };
  }
  const labels = { '01-features.mmd#search': '검색' };
  const featureLabel = (map, id) => labels[`${map}#${id}`] ?? null;

  it('names the canonical file and only the changed, proposed, or newly discussed steps', () => {
    const result = flowDiscussionBrief(recorded(), null, { problem: '책을 못 찾아요', successCriteria: '한 번에 찾는다' }, { featureLabel });
    expect(result.text).toContain('docs/maps/02-lending.mmd (버전 abc)');
    expect(result.text).toContain('(유저 플로우)');
    expect(result.text).toContain('[reader_search] 책 고르기 · 빌리는 사람');
    expect(result.text).toContain('바뀐 항목: 이름, 연결된 기능');
    expect(result.text).toContain('docs/maps/01-features.mmd [search] 검색');
    expect(result.text).toContain('docs/maps/01-features.mmd [gone] (찾을 수 없는 기능)');
    expect(result.text).toContain('사람 메모: 알림이 너무 늦어요');
    expect(result.text).toContain('[owner_check]');
    expect(result.text).toContain('성공 기준: 하루 안에 답한다');
    expect(result.text).toContain('지도에서 제거된 단계 1개: [reader_review]');
    expect(result.text).not.toContain('이미 기록한 메모');
    expect(result.text).not.toContain('[owner_payout]');
    expect(result.text).toContain('단계 ID를 유지하세요');
    expect(result.text).toContain('아직 실행 승인 전입니다');
    // The step that pointed at the removed one changed its arrows too.
    expect(result.text).toMatch(/\[reader_refund\][^\n]*\n- 지도에서 바뀐 항목: 화살표/);
    expect(result.targetCount).toBe(5);
  });

  it('focuses one step with its neighbors and saved intent, and rejects unknown steps', () => {
    const source = recorded();
    const result = flowDiscussionBrief(source, 'reader_open', { problem: 'p', successCriteria: 's', approved: true }, { featureLabel });
    expect(result.text).toContain('범위: 단계 [reader_open] 앱 열기');
    expect(result.text).toContain('다음 단계: [reader_search] 책 고르기');
    expect(result.text).toContain('사람 메모: 이미 기록한 메모');
    expect(result.text).not.toContain('[owner_check]');
    expect(result.text).toContain('사용자가 위 요청을 승인했습니다');
    expect(result.approved).toBe(true);
    expect(() => flowDiscussionBrief(source, 'missing')).toThrow(/step does not exist/);
  });
});
