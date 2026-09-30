import { describe, expect, it } from 'vitest';
import { blockDraftValues, draftConflicts, reconcileDraft } from '../src/shapeDraft.js';

describe('shared map discussion draft preservation', () => {
  const base = { label: '검색', summary: '이름으로 찾습니다.', reason: '', logic: '', files: 'src/search.jsx' };
  it('merges external edits to untouched fields while preserving authored text and Korean composition', () => {
    const draft = { ...base, reason: '찾는 기능을 더 잘 보이게', comment: '한글 작', kind: 'change' };
    const current = { ...base, summary: '이름과 설명으로 찾습니다.' };
    const result = reconcileDraft(draft, base, current);
    expect(result.draft).toMatchObject({ summary: current.summary, reason: draft.reason, comment: draft.comment });
    expect(result.conflicts).toEqual([]);
  });
  it('keeps both versions when the same feature description changes externally', () => {
    const draft = { ...base, summary: '내 설명' }; const current = { ...base, summary: 'AI가 쓴 설명' };
    const result = reconcileDraft(draft, base, current);
    expect(result.draft.summary).toBe('내 설명');
    expect(result.base.summary).toBe(base.summary);
    expect(result.conflicts).toEqual(['summary']);
    expect(draftConflicts(draft, current, current)).toEqual([]);
  });
  it('acknowledges a successful save and reads plain language from legacy task fields', () => {
    const draft = { ...base, summary: '저장한 설명' };
    expect(reconcileDraft(draft, base, { ...base, summary: draft.summary }).base.summary).toBe(draft.summary);
    expect(blockDraftValues({ label: '기능', task: { logic: '기존 내용' } }).summary).toBe('기존 내용');
  });
});
