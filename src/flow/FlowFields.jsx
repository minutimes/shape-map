import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createDraftStore } from './flowDrafts.js';

/**
 * A text field that saves on Enter or when focus leaves. Typed text is kept in
 * a draft store under `draftKey`, so it survives selecting another element and
 * a failed save, until it is saved or the person discards it.
 */
export function DraftField({ label, value, onCommit, multiline = false, limit, placeholder, allowEmpty = false, clean = (text) => text.trim(),
  disabled = false, autoFocus = false, testId, hint, store: sharedStore, draftKey }) {
  const id = useId();
  const localStore = useMemo(() => createDraftStore(), []);
  const store = sharedStore || localStore;
  const key = draftKey || id;
  useSyncExternalStore(store.subscribe, store.version, store.version);
  const draft = store.get(key);
  const [note, setNote] = useState(null);
  const ref = useRef(null);
  const saved = value ?? '';
  const text = draft ? draft.value : saved;

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

  const discard = () => { store.clear(key); setNote(null); };
  async function commit({ explicit = true } = {}) {
    const current = store.get(key);
    if (!current || disabled || current.status === 'saving') return;
    // A draft that failed is saved again only when the person asks, never by leaving the field.
    if (!explicit && current.status === 'failed') return;
    const next = clean(current.value);
    if (!next && !allowEmpty) { discard(); setNote('비워 둘 수 없어서 원래 글로 되돌렸어요.'); return; }
    if (next === saved) { discard(); return; }
    store.set(key, { value: current.value, status: 'saving', message: null });
    const result = await onCommit(next);
    if (result?.ok) { if (store.get(key)?.value === current.value) store.clear(key); else store.set(key, { status: 'editing' }); return; }
    store.set(key, { status: 'failed', message: result?.message || '저장하지 못했어요.' });
  }

  const status = draft?.status;
  const props = {
    id, ref, value: text, disabled, placeholder, maxLength: limit, 'data-testid': testId,
    'aria-invalid': status === 'failed' || undefined,
    onChange: (event) => { setNote(null); store.set(key, { value: event.target.value, ...(status === 'saving' ? {} : { status: 'editing', message: null }) }); },
    onBlur: () => { commit({ explicit: false }); },
    onKeyDown: (event) => {
      // Escape drops text that is still being typed; a draft that failed to save stays until it is saved or discarded.
      if (event.key === 'Escape' && draft && draft.status === 'editing') { event.stopPropagation(); discard(); return; }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); }
    },
  };
  return <div className={`fm-field${status === 'failed' ? ' has-error' : ''}`}>
    <label htmlFor={id}>{label}{hint && <small>{hint}</small>}</label>
    {multiline ? <textarea rows={2} {...props} /> : <input type="text" {...props} />}
    {status === 'failed' && <p className="fm-field__status" role="alert">{draft.message}
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => commit()}>다시 저장</button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={discard}>새 내용 쓰기</button></p>}
    {status === 'saving' && <p className="fm-field__status is-quiet" role="status">저장 중…</p>}
    {note && <p className="fm-field__status is-quiet" role="status">{note}</p>}
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

/** The server's own words, kept out of the way behind a small disclosure. */
export function ProblemDetail({ detail }) {
  if (!detail) return null;
  return <details className="fm-detail"><summary>자세히</summary><code>{detail}</code></details>;
}
