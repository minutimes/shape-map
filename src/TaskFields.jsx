import { useEffect, useMemo, useRef, useState } from 'react';
import './workflow.css';

const EXECUTOR_OPTIONS = [
  ['', '담당 미정'],
  ['code', '일반 코드'],
  ['perception', '로컬 인식'],
  ['llm', '생성·추론 모델'],
  ['jev', 'Jev 후보'],
  ['human', '사용자'],
];

function taskDraft(task = {}) {
  return {
    logic: task.logic || '',
    inputs: task.inputs || '',
    outputs: task.outputs || '',
    ui: task.ui || '',
    condition: task.condition || '',
    executorKind: task.executor?.kind || '',
    model: task.executor?.model || '',
    effort: task.executor?.effort || '',
  };
}

function signature(task) {
  return JSON.stringify(taskDraft(task));
}

function TextField({ id, label, value, onChange, rows = 3, help }) {
  return (
    <label className="wf-task-form__field" htmlFor={id}>
      <span>{label}</span>
      {help && <small>{help}</small>}
      <textarea id={id} rows={rows} maxLength={4000} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export default function TaskFields({ node, onSave, onCancel, busy = false, optionalFields = ['executor', 'model', 'effort', 'condition'] }) {
  const nodeId = node?.id || '';
  const nodeTask = node?.task || node?.data?.task;
  const nodeLabel = node?.label || node?.data?.label || '이름 없음';
  const externalSignature = useMemo(() => signature(nodeTask), [nodeTask]);
  const [draft, setDraft] = useState(() => taskDraft(nodeTask));
  const [baseSignature, setBaseSignature] = useState(externalSignature);
  const [savedSignature, setSavedSignature] = useState('');
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const previousNodeId = useRef(nodeId);
  const draftSignature = JSON.stringify(draft);
  const dirty = draftSignature !== baseSignature && draftSignature !== savedSignature;

  useEffect(() => {
    if (previousNodeId.current !== nodeId) {
      previousNodeId.current = nodeId;
      setDraft(taskDraft(nodeTask));
      setBaseSignature(externalSignature);
      setSavedSignature('');
      setStale(false);
      setError('');
      return;
    }
    if (externalSignature === baseSignature) return;
    if (savedSignature && externalSignature === savedSignature) {
      setBaseSignature(externalSignature);
      setSavedSignature('');
      setStale(false);
      return;
    }
    if (savedSignature) {
      setStale(true);
      return;
    }
    if (dirty) {
      setStale(true);
      return;
    }
    setDraft(taskDraft(nodeTask));
    setBaseSignature(externalSignature);
    setStale(false);
  }, [baseSignature, dirty, externalSignature, nodeId, nodeTask, savedSignature]);

  function update(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSavedSignature('');
    setError('');
  }

  function loadLatest() {
    setDraft(taskDraft(nodeTask));
    setBaseSignature(externalSignature);
    setSavedSignature('');
    setStale(false);
    setError('');
  }

  function keepDraft() {
    setBaseSignature(externalSignature);
    setSavedSignature('');
    setStale(false);
    setError('');
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || stale) return;
    setError('');
    const executor = draft.executorKind
      ? {
          kind: draft.executorKind,
          ...(draft.model.trim() && ['perception', 'llm', 'jev'].includes(draft.executorKind)
            ? { model: draft.model.trim() }
            : {}),
          ...(draft.executorKind === 'llm' && draft.effort ? { effort: draft.effort } : {}),
          ...(draft.executorKind === 'jev' ? { language: 'en' } : {}),
        }
      : undefined;
    const nextTask = {
      logic: draft.logic.trim(),
      inputs: draft.inputs.trim(),
      outputs: draft.outputs.trim(),
      ui: draft.ui.trim(),
      condition: draft.condition.trim(),
      ...(executor ? { executor } : {}),
    };

    try {
      const saved = await onSave?.(nextTask);
      if (saved === false) {
        setError('저장하지 못했습니다. 내용을 확인하고 다시 시도해 주세요.');
        return;
      }
      setSavedSignature(signature(nextTask));
      setStale(false);
    } catch (saveError) {
      setError(saveError?.message || '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  }

  const showModel = ['perception', 'llm', 'jev'].includes(draft.executorKind);

  return (
    <form className="wf-task-form" data-testid="task-fields" onSubmit={submit} aria-label={`${nodeLabel} 상세 편집`}>
      <div className="wf-task-form__heading">
        <div>
          <span>작업 상세</span>
          <h3>{nodeLabel}</h3>
        </div>
        {dirty && <span className="wf-task-form__dirty">저장 전</span>}
      </div>

      {stale && (
        <div className="wf-task-form__notice" role="alert">
          <p>다른 곳에서 이 작업이 바뀌었습니다. 저장하기 전에 사용할 내용을 선택해 주세요.</p>
          <div className="wf-task-form__conflict-actions">
            <button type="button" onClick={loadLatest}>최신 값 불러오기</button>
            <button type="button" onClick={keepDraft}>초안 유지하고 다시 검토</button>
          </div>
        </div>
      )}

      <TextField id={`${nodeId}-logic`} label="로직" value={draft.logic} onChange={(value) => update('logic', value)} />
      <TextField id={`${nodeId}-inputs`} label="데이터 · 입력" value={draft.inputs} onChange={(value) => update('inputs', value)} />
      <TextField id={`${nodeId}-outputs`} label="데이터 · 출력" value={draft.outputs} onChange={(value) => update('outputs', value)} />
      <TextField id={`${nodeId}-ui`} label="UI · 사용자에게 보여줄 내용" value={draft.ui} onChange={(value) => update('ui', value)} />
      {optionalFields.includes('condition') && <TextField id={`${nodeId}-condition`} label="조건" rows={2} value={draft.condition} onChange={(value) => update('condition', value)} help="조건 분기일 때만 작성합니다." />}

      {optionalFields.includes('executor') && <fieldset className="wf-task-form__executor">
        <legend>실행 담당</legend>
        <label>
          <span>담당 종류</span>
          <select value={draft.executorKind} onChange={(event) => update('executorKind', event.target.value)}>
            {EXECUTOR_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {showModel && optionalFields.includes('model') && (
          <label>
            <span>모델</span>
            <input maxLength={160} value={draft.model} onChange={(event) => update('model', event.target.value)} placeholder="아직 정하지 않음" />
          </label>
        )}
        {draft.executorKind === 'llm' && optionalFields.includes('effort') && (
          <label>
            <span>Effort</span>
            <input list={`${nodeId}-effort-options`} maxLength={160} value={draft.effort} onChange={(event) => update('effort', event.target.value)} placeholder="아직 정하지 않음" />
            <datalist id={`${nodeId}-effort-options`}>
              {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => <option key={effort} value={effort} />)}
            </datalist>
          </label>
        )}
        {draft.executorKind === 'jev' && (
          <label>
            <span>지시 언어</span>
            <input value="English (EN)" readOnly aria-readonly="true" />
            <small>영어 상태와 선택지를 기준으로 설계합니다.</small>
          </label>
        )}
      </fieldset>}

      {error && <p className="wf-task-form__error" role="alert">{error}</p>}
      <div className="wf-task-form__actions">
        <button type="button" onClick={onCancel} disabled={busy}>취소</button>
        <button type="submit" className="is-primary" disabled={busy || stale}>{busy ? '저장 중…' : '저장'}</button>
      </div>
    </form>
  );
}
