import { describe, it, expect } from 'vitest';
import { areaReading, featureHistory } from '../src/systemReading.js';

const node = (id, parentId, extra = {}) => ({ id, parentId, label: id, shape: 'rectangle', category: 'feature', ...extra });
const graph = { nodes: [node('root', null), node('editing', 'root'), node('captions', 'editing'), node('words', 'captions'), node('timing', 'words'), node('sound', 'root'), node('notes', 'root', { section: 'reference' }), node('noteDetail', 'notes')], categories: [] };
const turn = (id, nodes, extra = {}) => ({ id, number: Number(id), title: `turn ${id}`, nodes, categories: [], ...extra });
describe('reading a system and its actual changes', () => {
  it('counts deep product parts without including inherited reference notes', () => {
    const area = areaReading(graph, 'editing');
    expect(area).toMatchObject({ total: 5, count: 3, depth: 3, referenceCount: 2 });
    expect([...area.ids]).toEqual(['editing', 'captions', 'words', 'timing']);
    expect(areaReading(graph, 'root').children.map(({ id }) => id)).toEqual(['editing', 'sound']);
  });
  it('does not present the first snapshot as prior improvements', () => {
    expect(featureHistory([turn('1', graph.nodes)], 'captions')).toEqual([]);
  });
  it('shows recorded changes even when a red improvement plan is still present', () => {
    const first = graph.nodes.map((n) => n.id === 'captions' ? { ...n, proposal: { reason: 'Keep the plan' }, block: { summary: 'Old wording' } } : n);
    const second = first.map((n) => n.id === 'captions' ? { ...n, block: { summary: 'Clear new wording' } } : n);
    const records = featureHistory([turn('1', first), turn('2', second)], 'captions');
    expect(records).toHaveLength(1);
    expect(records[0].facts).toContainEqual({ label: '쉽게 읽는 설명', before: 'Old wording', after: 'Clear new wording' });
    expect(second.find((n) => n.id === 'captions').proposal.reason).toBe('Keep the plan');
  });
  it('explains link-only changes using the actual feature and transferred material', () => {
    const before = turn('1', graph.nodes);
    const after = turn('2', graph.nodes, { links: [{ id: 'handoff', source: 'captions', target: 'sound', kind: 'data', label: 'Confirmed speech' }] });
    expect(featureHistory([before, after], 'captions')[0].facts).toContainEqual({ label: '다른 기능과의 연결', before: '기록 없음', after: '전달 → sound: Confirmed speech' });
  });
  it('keeps an unfinished live edit out of completed history', () => {
    const before = turn('1', graph.nodes);
    const second = turn('2', graph.nodes.map((n) => n.id === 'captions' ? { ...n, label: 'Recorded captions' } : n));
    const live = { ...second, nodes: second.nodes.map((n) => ({ ...n, label: 'Unrecorded edit' })) };
    expect(featureHistory([before, second], 'captions')[0].facts[0].after).toBe('Recorded captions');
    expect(live.nodes[0].label).toBe('Unrecorded edit');
  });
});
