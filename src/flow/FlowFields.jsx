import { useEffect, useId, useRef, useState } from 'react';

/**
 * A text field that saves on Enter or when focus leaves. When saving fails, the
 * typed text stays so the person can save it again after the map refreshes.
 */
export function DraftField({ label, value, onCommit, multiline = false, limit, placeholder, allowEmpty = false, clean = (text) => text.trim(),
  disabled = false, autoFocus = false, testId, hint }) {
  const id = useId();
  const [text, setText] = useState(value ?? '');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState({ kind: 'idle' });
  const ref = useRef(null);
  const dirtyRef = useRef(false); dirtyRef.current = dirty;

  useEffect(() => { if (!dirtyRef.current) setText(value ?? ''); }, [value]);
  useEffect(() => {
    if (!autoFocus || !ref.current) return;
    ref.current.focus();
    ref.current.select?.();
  }, [autoFocus]);
  useEffect(() => {
    if (!multiline || !ref.current) return;
    ref.current.style.height = 'auto';
    ref.current.style.height = `${Math.min(220, ref.current.scrollHeight + 2)}px`;
  }, [text, multiline]);

  async function commit() {
    if (!dirtyRef.current || disabled) return;
    const next = clean(text);
    if (!next && !allowEmpty) { setText(value ?? ''); setDirty(false); setStatus({ kind: 'note', message: '비워 둘 수 없어서 원래 글로 되돌렸어요.' }); return; }
    if (next === (value ?? '')) { setText(next); setDirty(false); setStatus({ kind: 'idle' }); return; }
    setStatus({ kind: 'saving' });
    const result = await onCommit(next);
    if (result?.ok) { setDirty(false); setStatus({ kind: 'idle' }); return; }
    setStatus({ kind: 'failed', message: result?.message || '저장하지 못했어요.' });
  }

  const props = {
    id, ref, value: text, disabled, placeholder, maxLength: limit, 'data-testid': testId,
    'aria-invalid': status.kind === 'failed' || undefined,
    onChange: (event) => { setText(event.target.value); setDirty(true); if (status.kind !== 'saving') setStatus({ kind: 'idle' }); },
    onBlur: () => { commit(); },
    onKeyDown: (event) => {
      if (event.key === 'Escape' && dirty) { event.stopPropagation(); setText(value ?? ''); setDirty(false); setStatus({ kind: 'idle' }); return; }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); }
    },
  };
  return <div className={`fm-field${status.kind === 'failed' ? ' has-error' : ''}`}>
    <label htmlFor={id}>{label}{hint && <small>{hint}</small>}</label>
    {multiline ? <textarea rows={2} {...props} /> : <input type="text" {...props} />}
    {status.kind === 'failed' && <p className="fm-field__status" role="alert">{status.message}
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => commit()}>다시 저장</button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { setText(value ?? ''); setDirty(false); setStatus({ kind: 'idle' }); }}>새 내용 쓰기</button></p>}
    {status.kind === 'saving' && <p className="fm-field__status is-quiet" role="status">저장 중…</p>}
    {status.kind === 'note' && <p className="fm-field__status is-quiet" role="status">{status.message}</p>}
  </div>;
}

export function Segmented({ label, options, value, onChange, disabled, renderOption }) {
  return <div className="fm-field">
    <span className="fm-field__label" id={`${label}-label`}>{label}</span>
    <div className="fm-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => <button key={option.id} type="button" role="radio" aria-checked={value === option.id} disabled={disabled}
        title={option.hint} onClick={() => value !== option.id && onChange(option.id)}>{renderOption ? renderOption(option) : option.label}</button>)}
    </div>
  </div>;
}

export function PanelSection({ title, children, aside }) {
  return <section className="fm-panel__section">
    {title && <header><h3>{title}</h3>{aside}</header>}
    {children}
  </section>;
}
