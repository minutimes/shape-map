import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMapApi, legacyMapApi } from '../src/api.js';
import { MAP_KIND_LABELS, MAP_KIND_ORDER, mapKindLabel, readOnlyReason } from '../src/mapKinds.js';

afterEach(() => vi.unstubAllGlobals());

describe('map API binding', () => {
  it('keeps the single-map routes and storage keys unchanged', async () => {
    expect(legacyMapApi.eventsUrl).toBe('/api/events');
    expect(legacyMapApi.url('/api/brief')).toBe('/api/brief');
    expect(legacyMapApi.storagePrefix).toBe('');
    expect(legacyMapApi.editorHref).toBe('?editor=1');
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ revision: 'r' }) }));
    vi.stubGlobal('fetch', fetch);
    await legacyMapApi.mutateMap({ baseRevision: 'r', clientId: 'c', operation: { type: 'x' } });
    expect(fetch.mock.calls[0][0]).toBe('/api/mutations');
  });

  it('sends every request of a project map to that map and scopes drafts by project', async () => {
    const api = createMapApi({ project: 'games/rooms', map: '01 rooms.mmd' });
    const query = 'project=games%2Frooms&map=01+rooms.mmd';
    expect(api.eventsUrl).toBe(`/api/events?${query}`);
    expect(api.url('/api/subtree/a?depth=1')).toBe(`/api/subtree/a?depth=1&${query}`);
    expect(api.storagePrefix).toBe('project:games/rooms:');
    expect(api.editorHref).toBe(`/?${query}&editor=1`);
    expect(api.workspaceHref).toBe(`/?${query}`);
    const fetch = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ code: 'revision_conflict', message: 'stale' }) }));
    vi.stubGlobal('fetch', fetch);
    const error = await api.saveView({ baseRevision: 'r', clientId: 'c', patch: {} }).catch((caught) => caught);
    expect(fetch.mock.calls[0][0]).toBe(`/api/view?${query}`);
    expect(error).toMatchObject({ status: 409, body: { code: 'revision_conflict' }, message: 'stale' });
    expect(createMapApi({ project: 'b', map: 'x.mmd' }).storagePrefix).not.toBe(createMapApi({ project: 'a', map: 'x.mmd' }).storagePrefix);
  });
});

describe('map kinds', () => {
  it('keeps the visible kind names and tab order in one place', () => {
    expect(MAP_KIND_ORDER.map((kind) => MAP_KIND_LABELS[kind])).toEqual(['기능 계통도', '유저 플로우', '시스템 플로우', '기타 그림']);
    expect(mapKindLabel('timeline')).toBe('기타 그림');
  });

  it('explains read-only maps in short plain Korean with the line', () => {
    expect(readOnlyReason({ error: 'Line 40: links need an arrowhead: use -->, -.->, or ==> instead of ---.', line: 40 }).text).toBe('40번째 줄을 읽지 못했어요. 연결선에 화살표가 없어요.');
    expect(readOnlyReason({ sourceStatus: { error: 'Line 3: tag pub is missing its legend (%% mlc-legend: pub|label|description).', line: 3 } }).text).toMatch(/^3번째 줄.*이름과 설명/);
    expect(readOnlyReason({ error: 'This flowchart has no %% sm-map: header, so Shape map shows it without editing.' }).text).toMatch(/첫머리 줄이 없어서/);
    expect(readOnlyReason({ error: 'Shape map shows sequenceDiagram diagrams without editing.' }).text).toMatch(/편집하지 않는 그림 종류/);
    expect(readOnlyReason({ declaredKind: 'timeline', error: 'x', line: 2 }).text).toMatch(/timeline/);
    expect(readOnlyReason({ error: 'Expected exactly one flowchart LR declaration; found 0.' }).text).toMatch(/파일/);
  });
});
