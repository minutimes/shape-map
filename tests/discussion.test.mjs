import { describe, expect, it } from 'vitest';
import { discussionBrief } from '../lib/discussion.mjs';

const snapshot = () => {
  const nodes = [{ id: 'root', label: '제품', parentId: null }, { id: 'a', label: '장면', parentId: 'root', task: { inputs: '원본 영상'.repeat(3000) }, block: { comments: [{ id: 'old', body: '기록된 메모', resolved: false }] } }];
  return { mapPath: 'maps/product.mmd', revision: 'current', graph: { nodes, turns: [{ nodes: structuredClone(nodes) }], links: [{ id: 'link', label: '원본에서 볼 연결 내용' }] } };
};

describe('a compact facilitation handoff', () => {
  it('exports changes and new notes instead of serializing an unchanged map again', () => {
    const source = snapshot(); source.graph.nodes[1].proposal = { reason: '장면을 못 찾는다', purpose: '한눈에 이해한다', successCriteria: '한 번에 찾는다' };
    source.graph.nodes[1].block.comments.push({ id: 'new', body: '메모에서 바로 수정하고 싶다', resolved: false });
    const result = discussionBrief(source);
    expect(result.text).toContain('maps/product.mmd'); expect(result.text).toContain('[a] 장면');
    expect(result.text).toContain('메모에서 바로 수정하고 싶다'); expect(result.text).toContain('한 번에 찾는다');
    expect(result.text).not.toContain('기록된 메모'); expect(result.text).not.toContain('원본 영상'); expect(result.text).not.toContain('원본에서 볼 연결 내용');
    expect(result.text).toContain('기획문답(decision-interview)'); expect(result.text).toContain('사용자가 승인하면 실제로 구현');
    expect(result.approved).toBe(false); expect(result.targetCount).toBe(1);
  });
  it('includes the selected branch saved intent even if already recorded, but excludes other branches', () => {
    const source = snapshot(); source.graph.nodes.push({ id: 'b', label: '다른 기능', parentId: 'root', proposal: { reason: '다른 영역 요청' } });
    const result = discussionBrief(source, 'a');
    expect(result.text).toContain('기록된 메모'); expect(result.text).not.toContain('다른 영역 요청');
    expect(() => discussionBrief(source, 'missing')).toThrow();
  });
  it('bounds a large change set and long user prose while preserving the complete source reference', () => {
    const source = snapshot(); for (let i = 0; i < 5000; i++) source.graph.nodes.push({ id: `n${i}`, label: '기능'.repeat(100), parentId: 'root', proposal: { reason: '문제'.repeat(2000), purpose: '목적'.repeat(2000), logic: '변화'.repeat(2000), successCriteria: '완료'.repeat(2000) } });
    const result = discussionBrief(source, null, { problem: '문제'.repeat(2000), purpose: '목적'.repeat(2000), successCriteria: '완료'.repeat(2000), approved: true });
    expect(result.text.length).toBeLessThan(26000); expect(result.text).not.toContain('[n4999]');
    expect(result.text).toContain(`문제: ${'문제'.repeat(2000)}`);
    expect(result.text).toContain('나머지 대상'); expect(result.approved).toBe(true);
  });
  it('identifies edited connections and deletions without copying unchanged relationship prose', () => {
    const source = snapshot(); source.graph.links = [{ id: 'relation', source: 'root', target: 'a', kind: 'data', label: '자료' }];
    source.graph.turns[0].links = structuredClone(source.graph.links); source.graph.links[0].kind = 'dependency';
    expect(discussionBrief(source).text).toContain('바뀐 항목: 연결');
    source.graph.nodes = source.graph.nodes.filter((node) => node.id !== 'a'); source.graph.links = [];
    expect(discussionBrief(source).text).toContain('지도에서 제거된 기능 1개: [a]');
  });
  it('does not repeat the same problem and goals from a saved proposal', () => {
    const source = snapshot(); source.graph.nodes[1].proposal = { reason: '찾기 어렵다', purpose: '한눈에 이해', successCriteria: '한 번에 확인', logic: '카드에 모은다' };
    const result = discussionBrief(source, 'a', { problem: '찾기 어렵다', purpose: '한눈에 이해', successCriteria: '한 번에 확인' });
    expect(result.text.match(/찾기 어렵다/g)).toHaveLength(1);
    expect(result.text.match(/한눈에 이해/g)).toHaveLength(1);
    expect(result.text.match(/한 번에 확인/g)).toHaveLength(1);
    expect(result.text).toContain('카드에 모은다');
    expect(result.text).toContain('skills/shape-map-facilitation/SKILL.md');
  });
});
