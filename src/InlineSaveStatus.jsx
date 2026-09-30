import { useState, useSyncExternalStore } from 'react';

const FIELD_NAMES = { label: '제목', logic: '로직', inputs: '입력', outputs: '출력', ui: 'UI',
  condition: '조건', executor: '실행 담당', reason: '변경 이유', proposal: '변경안', workflow: '하위 작업 흐름' };
const format = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) || '비어 있음';

export default function InlineSaveStatus({ editor, connection, onCopy }) {
  const state = useSyncExternalStore(editor.subscribeSummary, editor.getSummary, editor.getSummary);
  const [open, setOpen] = useState(false);
  const issue = state.errors || state.conflicts || state.storageError;
  const text = state.storageError ? '초안 보관 확인 필요' : state.conflicts ? '변경 확인 필요'
    : state.errors ? '초안 보관 중' : state.saving ? '저장 중…' : state.pending ? '저장 대기…'
      : connection === 'online' ? '자동 저장됨' : '연결 확인 중';
  return <div className={`inline-save-status${issue ? ' has-issue' : ''}`}>
    <button type="button" className="inline-save-status__button" data-testid="connection-status"
      aria-label={`저장 상태: ${text}`} aria-expanded={open} onClick={() => setOpen(!open)}>
      <i aria-hidden="true" /><span role="status">{text}</span>
    </button>
    {open && <section className="draft-recovery" aria-label="자동 저장과 초안">
      <header><strong>자동 저장과 초안</strong><button type="button" onClick={() => setOpen(false)}>닫기</button></header>
      <p>{state.storageError || (state.count ? '저장하지 못한 내용도 이 브라우저에 보관합니다.' : '모든 변경이 지도 파일에 저장됐습니다.')}</p>
      {editor.entries().map(({ id, label, fields }) => <div className="draft-recovery__item" key={id}>
        <strong>{label}</strong>
        {Object.entries(fields).map(([path, field]) => <div key={path}>
          <label>{path.startsWith('proposal.') ? '변경안 · ' : ''}{FIELD_NAMES[path.split('.').at(-1)] || path}
            <textarea readOnly value={format(field.value)} aria-label={`${label}의 보관된 초안`} />
          </label>
          <small>{field.message}</small>
          {field.status === 'conflict' && <><p>새 내용: {format(field.remote)}</p><div className="draft-recovery__actions">
            <button onClick={() => editor.resolve(id, path, 'local')}>내 초안 유지</button>
            <button onClick={() => editor.resolve(id, path, 'remote')}>새 내용 사용</button>
          </div></>}
        </div>)}
      </div>)}
      {state.count > 0 && <div className="draft-recovery__actions">
        <button type="button" onClick={() => editor.retry()}>다시 저장</button>
        <button type="button" onClick={() => onCopy(editor.entries().map(({ label, fields }) =>
          `${label}\n${Object.entries(fields).map(([path, field]) => `${path}: ${format(field.value)}`).join('\n')}`).join('\n\n'))}>초안 복사</button>
      </div>}
    </section>}
  </div>;
}
