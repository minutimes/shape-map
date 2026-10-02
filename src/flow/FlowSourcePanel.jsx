import { useEffect, useRef, useState } from 'react';
import FlowIcon from './FlowIcon.jsx';

const LINE = 19;
const PAD = 12;

/** The Mermaid source, editable as text. Server errors are shown at their line. */
export default function FlowSourcePanel({ source, editable, invalid, onApply, onClose, onCopy }) {
  const [text, setText] = useState(source || '');
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState(null);
  const [saving, setSaving] = useState(false);
  const [scroll, setScroll] = useState(0);
  const area = useRef(null);
  const dirtyRef = useRef(false); dirtyRef.current = dirty;

  useEffect(() => { if (!dirtyRef.current) { setText(source || ''); setProblem(null); } }, [source]);
  const line = problem?.line ?? (invalid && !dirty ? invalid.line : null);
  useEffect(() => {
    if (!line || !area.current) return;
    const target = Math.max(0, (line - 4) * LINE);
    area.current.scrollTop = target; setScroll(target);
  }, [line]);

  async function apply() {
    setSaving(true);
    const result = await onApply(text);
    setSaving(false);
    if (result.ok) { setDirty(false); setProblem(null); return; }
    setProblem(result.kind === 'conflict'
      ? { kind: 'conflict', text: '그사이 다른 곳에서 지도가 바뀌었어요. 쓴 내용은 그대로 있어요.' }
      : { kind: result.kind, line: result.line, text: result.text || result.message, detail: result.detail });
  }
  const lines = text.split('\n').length;
  const blocked = !editable || Boolean(invalid);
  return <section className="fm-source" aria-label="원문">
    <header className="fm-panel__header">
      <div><span className="fm-panel__eyebrow">Mermaid 원문</span><h2>원문 보기</h2></div>
      <button type="button" className="fm-icon-button" aria-label="닫기" title="닫기 (Esc)" onClick={onClose}><FlowIcon name="close" size={15} /></button>
    </header>
    <p className="fm-source__lead">{blocked ? (invalid ? '원문에 고칠 곳이 있어요. 파일을 고치면 바로 다시 열려요.' : '이 지도는 읽기만 할 수 있어요.')
      : '그림과 같은 내용이에요. 고친 뒤 적용하면 그림이 바뀌고, 되돌리기로 돌아갈 수 있어요.'}</p>
    {(problem || (invalid && !dirty)) && <div className={`fm-source__problem${problem?.kind === 'conflict' ? ' is-conflict' : ''}`} role="alert" data-testid="fm-source-problem">
      <FlowIcon name="alert" size={14} />
      <div><strong>{problem ? problem.text : `${invalid.line ? `${invalid.line}번째 줄을 ` : ''}확인해 주세요.`}</strong>
        {(problem?.detail || (!problem && invalid?.error)) && <small>{problem?.detail || invalid.error}</small>}
        {problem?.kind === 'conflict' && <div className="fm-row">
          <button type="button" className="fm-button fm-button--dark" onClick={apply}>내 내용 다시 적용</button>
          <button type="button" className="fm-button" onClick={() => { setText(source || ''); setDirty(false); setProblem(null); }}>새 원문 불러오기</button>
        </div>}
      </div>
    </div>}
    <div className="fm-source__editor">
      <div className="fm-source__gutter" aria-hidden="true" style={{ transform: `translateY(${-scroll}px)` }}>
        {Array.from({ length: lines }, (_, index) => <span key={index} className={line === index + 1 ? 'is-error' : undefined}>{index + 1}</span>)}
      </div>
      <div className="fm-source__field">
        {line && <div className="fm-source__mark" style={{ top: PAD + (line - 1) * LINE - scroll }} aria-hidden="true" />}
        <textarea ref={area} value={text} spellCheck={false} readOnly={blocked} aria-label="Mermaid 원문" data-testid="fm-source-text"
          onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
          onChange={(event) => { setText(event.target.value); setDirty(true); if (problem?.kind !== 'conflict') setProblem(null); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (dirty && !blocked) apply(); } }} />
      </div>
    </div>
    <footer className="fm-row fm-source__actions">
      {!blocked && <button type="button" className="fm-button fm-button--dark" disabled={!dirty || saving} onClick={apply} data-testid="fm-source-apply">{saving ? '적용 중…' : '적용'}</button>}
      {!blocked && <button type="button" className="fm-button" disabled={!dirty} onClick={() => { setText(source || ''); setDirty(false); setProblem(null); }}>고친 것 버리기</button>}
      <button type="button" className="fm-button fm-push" onClick={() => onCopy(text)}><FlowIcon name="copy" size={13} />복사</button>
    </footer>
  </section>;
}
