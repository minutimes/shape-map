import { useEffect, useId, useRef, useState } from 'react';
import { ShapeIcon } from './ShapeNode.jsx';
import {
  CREATABLE_MAP_KINDS, MAP_KIND_HINTS, MAP_TEXT_LIMITS, MAP_TITLE_EXAMPLES, mapKindLabel, mapRequestReason, textLength,
} from './mapKinds.js';

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || 'Request failed.');
    error.status = response.status;
    error.body = payload;
    throw error;
  }
  return payload;
}

/** Asks the server to write a starter map into the project's docs/maps (docs/API.md "Projects"). */
export function createProjectMap(project, { kind, title, description }) {
  const query = new URLSearchParams({ project }).toString();
  return postJson(`/api/project/maps?${query}`, { kind, title, ...(description ? { description } : {}) });
}

const oneLine = (value) => value.replace(/[\r\n]+/g, ' ');

/** A modal that keeps focus inside and returns it to the opener on close. */
function ShellDialog({ title, subtitle, onClose, busy, children }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.querySelector('[data-autofocus]')?.focus();
    return () => opener?.focus?.();
  }, []);
  const close = () => { if (!busy) onClose(); };
  return <div className="sm-dialog-backdrop sm-map-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={ref} className="sm-dialog sm-map-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
          const items = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
            .filter((item) => item.type !== 'radio' || item.checked);
          const first = items[0]; const last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="sm-dialog__header">
        <div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="sm-icon-button" aria-label="닫기" onClick={close} disabled={busy}><ShapeIcon name="close" /></button>
      </header>
      {children}
    </section>
  </div>;
}

function TextField({ label, optional, value, onChange, limit, placeholder, autoFocus, name }) {
  const length = textLength(value);
  const over = length > limit;
  return <label className={`sm-map-field${over ? ' is-over' : ''}`}>
    <span className="sm-map-field__label">{label}{optional && <small>선택</small>}
      {length > limit * 0.75 && <small className="sm-map-field__count" aria-live="polite">{length}/{limit}</small>}</span>
    <input name={name} value={value} placeholder={placeholder} autoComplete="off" spellCheck={false} data-autofocus={autoFocus || undefined}
      aria-invalid={over || undefined} onChange={(event) => onChange(oneLine(event.target.value))} />
  </label>;
}

function problemOf(title, description) {
  if (!title.trim()) return '이름을 적어 주세요.';
  if (textLength(title.trim()) > MAP_TEXT_LIMITS.title) return `이름은 ${MAP_TEXT_LIMITS.title}자까지 적을 수 있어요.`;
  if (textLength(description.trim()) > MAP_TEXT_LIMITS.description) return `설명은 ${MAP_TEXT_LIMITS.description}자까지 적을 수 있어요.`;
  return null;
}

/** Choose a kind, a title, and an optional one-line description; the server writes the file. */
export function NewMapDialog({ projectKey, projectName, initialKind, first, onClose, onCreated }) {
  const [kind, setKind] = useState(CREATABLE_MAP_KINDS.includes(initialKind) ? initialKind : 'features');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tried, setTried] = useState(false);
  const problem = problemOf(title, description);

  const submit = async (event) => {
    event.preventDefault();
    setTried(true);
    if (problem || busy) return;
    setBusy(true); setError(null);
    try {
      const created = await createProjectMap(projectKey, { kind, title: title.trim(), description: description.trim() });
      onCreated(created);
    } catch (failure) {
      setError(mapRequestReason(failure));
      setBusy(false);
    }
  };

  return <ShellDialog title={first ? '첫 지도 만들기' : '새 지도 만들기'} busy={busy} onClose={onClose}
    subtitle={`${projectName}의 docs/maps 폴더에 새 파일로 저장돼요. 있던 파일은 건드리지 않아요.`}>
    <form className="sm-form sm-map-form" onSubmit={submit} noValidate>
      <fieldset className="sm-map-kinds">
        <legend>어떤 지도인가요?</legend>
        {CREATABLE_MAP_KINDS.map((item) => <label key={item} className={`sm-map-kind${item === kind ? ' is-selected' : ''}`}>
          <input type="radio" name="kind" value={item} checked={item === kind} onChange={() => setKind(item)} />
          <span className="sm-map-kind__text"><strong>{mapKindLabel(item)}</strong><small>{MAP_KIND_HINTS[item]}</small></span>
        </label>)}
      </fieldset>
      <TextField label="이름" name="title" value={title} onChange={setTitle} limit={MAP_TEXT_LIMITS.title} placeholder={MAP_TITLE_EXAMPLES[kind]} autoFocus />
      <TextField label="한 줄 설명" name="description" optional value={description} onChange={setDescription} limit={MAP_TEXT_LIMITS.description}
        placeholder="이 지도로 무엇을 보려는지 한 줄로 적어요." />
      <div className="sm-map-form__footer">
        <p className={`sm-map-form__message${(error || (tried && problem)) ? ' is-error' : ''}`} role={error || (tried && problem) ? 'alert' : undefined}>
          {error || (tried && problem) || ''}
        </p>
        <div className="sm-form-actions">
          <button type="button" className="sm-button" onClick={onClose} disabled={busy}>취소</button>
          <button type="submit" className="sm-button sm-button--dark" disabled={busy}>{busy ? '만드는 중…' : '만들기'}</button>
        </div>
      </div>
    </form>
  </ShellDialog>;
}

/**
 * Changes a map's title and one-line description through the same revision-checked
 * `setMapHeader` operation the canvases use. Only changed fields are sent.
 */
export function MapInfoDialog({ api, entry, onClose, onSaved }) {
  const [title, setTitle] = useState(entry.title || '');
  const [description, setDescription] = useState(entry.description || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tried, setTried] = useState(false);
  const clientId = useRef(`shell-${Math.random().toString(36).slice(2, 10)}`);
  const problem = problemOf(title, description);

  const submit = async (event) => {
    event.preventDefault();
    setTried(true);
    if (problem || busy) return;
    const operation = { type: 'setMapHeader' };
    if (title.trim() !== (entry.title || '')) operation.title = title.trim();
    if (description.trim() !== (entry.description || '')) operation.description = description.trim() || null;
    if (Object.keys(operation).length === 1) { onClose(); return; }
    setBusy(true); setError(null);
    try {
      const snapshot = await api.readMap();
      await api.mutateMap({ baseRevision: snapshot.revision, clientId: clientId.current, operation });
      onSaved();
    } catch (failure) {
      setError(mapRequestReason(failure));
      setBusy(false);
    }
  };

  return <ShellDialog title="지도 이름과 설명" busy={busy} onClose={onClose}
    subtitle={`${mapKindLabel(entry.kind)} · ${entry.path}. 파일 이름은 그대로예요.`}>
    <form className="sm-form sm-map-form" onSubmit={submit} noValidate>
      <TextField label="이름" name="title" value={title} onChange={setTitle} limit={MAP_TEXT_LIMITS.title} autoFocus />
      <TextField label="한 줄 설명" name="description" optional value={description} onChange={setDescription} limit={MAP_TEXT_LIMITS.description}
        placeholder="이 지도로 무엇을 보려는지 한 줄로 적어요." />
      <div className="sm-map-form__footer">
        <p className={`sm-map-form__message${(error || (tried && problem)) ? ' is-error' : ''}`} role={error || (tried && problem) ? 'alert' : undefined}>
          {error || (tried && problem) || ''}
        </p>
        <div className="sm-form-actions">
          <button type="button" className="sm-button" onClick={onClose} disabled={busy}>취소</button>
          <button type="submit" className="sm-button sm-button--dark" disabled={busy}>{busy ? '저장하는 중…' : '저장'}</button>
        </div>
      </div>
    </form>
  </ShellDialog>;
}
