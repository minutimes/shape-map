import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { featureLinkKey } from '../../lib/flowState.mjs';
import { PanelSection } from './FlowFields.jsx';
import FlowIcon from './FlowIcon.jsx';
import { draftKey } from './flowDrafts.js';
import { TEXT_LIMITS } from './flowConstants.js';
import './flowCollab.css';

/*
 * Collaboration on flow steps: memos, proposals, human review, recorded turns,
 * feature links, and the AI handoff. Colors mean exactly what they mean on the
 * features map (docs/SHAPE-MAP.md "Derived colors").
 */

export const FLOW_STATES = Object.freeze({
  planned: { label: '수정 대상', meaning: '다음에 바꿀 수정안이 있어요' },
  concern: { label: '검토 필요', meaning: '풀리지 않은 걱정 메모가 있어요' },
  verified: { label: '검수 완료', meaning: '사람이 지금 내용을 직접 확인했어요' },
  changed: { label: '직전 턴 개선', meaning: '기록한 마지막 두 턴 사이에 바뀌었어요' },
});
const STATE_ORDER = ['planned', 'concern', 'verified', 'changed'];
const COMMENT_KINDS = [
  { id: 'note', label: '의견' },
  { id: 'concern', label: '걱정되는 점' },
  { id: 'change', label: '개선 의견' },
];
const COMMENT_NAMES = { note: '의견', concern: '걱정되는 점', change: '개선 의견' };
const CHANGE_NAMES = { label: '이름', shape: '모양', lane: '줄', tags: '표시', summary: '설명', proposal: '수정안', features: '연결된 기능', arrows: '화살표' };
const dateText = (date) => new Date(date).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' });

export function StateBadge({ status, compact = false }) {
  const state = FLOW_STATES[status];
  if (!state) return null;
  return <span className={`fm-state fm-state--${status}${compact ? ' is-compact' : ''}`} title={state.meaning}><i aria-hidden="true" />{state.label}</span>;
}

/** Counts of the derived colors on the map, steps and lanes together; only colors in use are shown. */
export function StateLegend({ states, laneStates }) {
  const totals = useMemo(() => {
    const counts = {};
    for (const state of [...states.values(), ...(laneStates?.values() || [])]) if (state.status !== 'neutral') counts[state.status] = (counts[state.status] || 0) + 1;
    return counts;
  }, [states, laneStates]);
  const used = STATE_ORDER.filter((status) => totals[status]);
  if (!used.length) return null;
  return <span className="fm-state-legend" aria-label="색이 뜻하는 것" data-testid="fm-state-legend">
    {used.map((status) => <span key={status} className={`fm-state fm-state--${status}`} title={FLOW_STATES[status].meaning}><i aria-hidden="true" />{FLOW_STATES[status].label}<b>{totals[status]}</b></span>)}
  </span>;
}

function InlineConfirm({ text, hint, action, actionClass = 'fm-button--dark', onConfirm, onCancel }) {
  return <div className="fm-confirm is-calm" role="alertdialog" aria-label={text}>
    <p><strong>{text}</strong>{hint && <span>{hint}</span>}</p>
    <div><button type="button" className={`fm-button ${actionClass}`} onClick={onConfirm} autoFocus>{action}</button>
      <button type="button" className="fm-button" onClick={onCancel}>그만두기</button></div>
  </div>;
}

/** A lane takes memos only; an open concern is the one color it can have. */
export function LaneStatus({ state }) {
  return <section className="fm-status" data-testid="fm-lane-status"><div className="fm-status__row">
    {state.status === 'concern' ? <StateBadge status="concern" /> : <span className="fm-state fm-state--neutral"><i aria-hidden="true" />풀리지 않은 걱정이 없어요</span>}
  </div></section>;
}

/** While reading a recorded turn: how this step differs from the comparison. */
function TurnDifference({ state, step }) {
  if (!state.compare) return null;
  const previous = state.compare === 'previous';
  if (!state.base) return <p className="fm-muted">첫 턴이라 비교할 이전 기록이 없어요.</p>;
  if (state.added) return <p className="fm-muted">{previous ? '이 턴에서 새로 생긴 단계예요.' : '지금 지도에는 없는 단계예요.'}</p>;
  if (!state.changes.length) return <p className="fm-muted">{previous ? '이전 턴과 같아요.' : '지금 지도와 같아요.'}</p>;
  const before = state.before;
  const [from, to] = previous ? [before, step] : [step, before];
  const [fromName, toName] = previous ? ['이전 턴', '이 턴'] : ['이 턴', '지금'];
  return <div className="fm-diff" data-testid="fm-turn-diff">
    <p className="fm-muted">{previous ? '이전 턴에서 바뀐 것' : '지금 지도와 다른 것'}: {state.changes.map((field) => CHANGE_NAMES[field]).join(', ')}</p>
    {['label', 'summary'].filter((field) => state.changes.includes(field)).map((field) => <dl key={field} className="fm-diff__pair">
      <div><dt>{fromName} {CHANGE_NAMES[field]}</dt><dd>{from?.[field] || '없음'}</dd></div>
      <div><dt>{toName} {CHANGE_NAMES[field]}</dt><dd>{to?.[field] || '없음'}</dd></div>
    </dl>)}
  </div>;
}

/** The step's color, why it has it, and the explicit human review control. */
export function StepStatus({ step, state, editable, act }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setConfirming(false); }, [step.id]);
  const verified = state.status === 'verified';
  const staleReview = step.review && state.fingerprint !== step.review.fingerprint;
  return <section className="fm-status" data-testid="fm-step-status">
    <div className="fm-status__row">
      {state.status === 'neutral' ? <span className="fm-state fm-state--neutral"><i aria-hidden="true" />아직 표시할 상태가 없어요</span> : <StateBadge status={state.status} />}
      {editable && (verified
        ? <button type="button" className="fm-button fm-button--small fm-button--verified" onClick={() => act.send({ type: 'setBlock', id: step.id, block: { status: 'neutral' } }, '검수 되돌리기')}>
          <FlowIcon name="check" size={13} />검수 완료 · 되돌리기</button>
        : <button type="button" className="fm-button fm-button--small" disabled={step.proposal !== undefined} onClick={() => setConfirming(true)} data-testid="fm-review"
          title={step.proposal !== undefined ? '수정안을 정리한 뒤 검수할 수 있어요' : '지금 내용을 직접 확인했다고 남겨요'}>
          <FlowIcon name="check" size={13} />직접 확인했어요</button>)}
    </div>
    <TurnDifference state={state} step={step} />
    {state.status === 'changed' && !state.compare && <p className="fm-muted">{state.addedInLastTurn ? '마지막 턴에서 새로 생긴 단계예요.' : `마지막 턴에서 바뀐 것: ${state.lastTurnChanges.map((field) => CHANGE_NAMES[field]).join(', ')}`}</p>}
    {staleReview && !verified && <p className="fm-muted">확인한 뒤 내용이 바뀌었어요. 다시 확인해 주세요.</p>}
    {editable && step.proposal !== undefined && !verified && <p className="fm-muted">수정안을 정리한 뒤 검수할 수 있어요.</p>}
    {confirming && <InlineConfirm text="이 단계를 직접 확인했나요?" hint="초록색은 사람이 확인한 단계에만 붙어요. 단계 내용이 바뀌면 검수가 풀려요." action="직접 확인했어요"
      actionClass="fm-button--verified" onConfirm={async () => { setConfirming(false); await act.send({ type: 'setBlock', id: step.id, block: { status: 'verified' } }, '사람 검수'); }} onCancel={() => setConfirming(false)} />}
  </section>;
}

function useDraft(store, key, fallback = '') {
  useSyncExternalStore(store.subscribe, store.version, store.version);
  const draft = store.get(key);
  return [draft ? draft.value : fallback, (value) => (value === fallback && !draft?.message ? store.clear(key) : store.set(key, { value, status: 'editing', message: null })), () => store.clear(key)];
}

/** Memos on a step or, with `targetKind="lane"`, on a lane. */
export function CommentsTab({ step, editable, act, onToProposal, targetKind = 'step' }) {
  const [body, setBody, clearBody] = useDraft(act.drafts, draftKey(targetKind, step.id, 'memo'));
  const [kind, setKind] = useState('note');
  const [busy, setBusy] = useState(false);
  const comments = step.comments || [];
  async function submit(event) {
    event.preventDefault();
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    const result = await act.send({ type: 'addComment', id: step.id, body: text, kind, author: '사람' }, '메모 남기기');
    setBusy(false);
    if (result.ok) { clearBody(); setKind('note'); }
  }
  return <>
    <p className="fm-muted">{targetKind === 'lane' ? '이 줄 전체에 대한 생각을 남겨요.' : '이 단계를 보며 든 생각을 남겨요.'} 걱정되는 점은 지도에 노란색으로 보여요.</p>
    <ul className="fm-comments" data-testid="fm-comments">
      {comments.length ? [...comments].reverse().map((comment) => <li key={comment.id} className={`fm-comment fm-comment--${comment.kind}${comment.resolved ? ' is-resolved' : ''}`}>
        <header><span className="fm-comment__kind">{COMMENT_NAMES[comment.kind]}</span><small>{comment.author} · {dateText(comment.createdAt)}{comment.resolved ? ' · 마침' : ''}</small></header>
        <p>{comment.body}</p>
        {editable && <footer>
          {comment.kind === 'change' && !comment.resolved && onToProposal && <button type="button" onClick={() => onToProposal(comment.body)}>수정안으로 옮기기</button>}
          <button type="button" onClick={() => act.send({ type: 'resolveComment', id: step.id, commentId: comment.id, resolved: !comment.resolved }, comment.resolved ? '메모 다시 열기' : '메모 논의 마침')}>
            {comment.resolved ? '다시 열기' : '논의 마침'}</button>
        </footer>}
      </li>) : <li className="fm-comments__empty"><FlowIcon name="comment" size={20} /><span>아직 남긴 메모가 없어요.</span></li>}
    </ul>
    {editable && <form className="fm-composer" onSubmit={submit}>
      <div className="fm-segmented" role="radiogroup" aria-label="메모 종류">
        {COMMENT_KINDS.map((option) => <button key={option.id} type="button" role="radio" aria-checked={kind === option.id} className={`is-${option.id}`} onClick={() => setKind(option.id)}>{option.label}</button>)}
      </div>
      <label className="fm-sr-only" htmlFor={`fm-memo-${step.id}`}>메모</label>
      <textarea id={`fm-memo-${step.id}`} value={body} maxLength={TEXT_LIMITS.summary} rows={3} placeholder="어떤 점을 함께 살펴볼까요?" data-testid="fm-memo-input"
        onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) submit(event); }} />
      <div className="fm-row"><small className="fm-muted fm-grow">{body ? '쓰던 메모는 다른 곳을 봐도 남아 있어요.' : '지도 파일에 함께 저장돼요.'}</small>
        <button type="submit" className="fm-button fm-button--dark" disabled={!body.trim() || busy} data-testid="fm-memo-submit"><FlowIcon name="plus" size={13} />메모 남기기</button></div>
    </form>}
  </>;
}

const PROPOSAL_FIELDS = [
  { id: 'reason', label: '지금 풀고 싶은 문제', placeholder: '예: 처음 온 사람이 어디서 시작할지 몰라요.', required: true, rows: 2 },
  { id: 'purpose', label: '목적', placeholder: '무엇을 더 쉽게 하려는 건가요?', rows: 2 },
  { id: 'logic', label: '원하는 변화', placeholder: '바뀐 뒤 사람이 겪을 흐름을 적어 주세요.', rows: 3 },
  { id: 'successCriteria', label: '해결 성공 기준', placeholder: '무엇을 확인하면 해결된 건가요?', rows: 2 },
];

export function ProposalTab({ step, editable, act, seed, onSeedUsed }) {
  const saved = step.proposal || {};
  const keys = Object.fromEntries(PROPOSAL_FIELDS.map((field) => [field.id, draftKey('step', step.id, `proposal.${field.id}`)]));
  useSyncExternalStore(act.drafts.subscribe, act.drafts.version, act.drafts.version);
  const value = (field) => act.drafts.get(keys[field])?.value ?? saved[field] ?? '';
  const setValue = (field, text) => { if (text === (saved[field] ?? '')) act.drafts.clear(keys[field]); else act.drafts.set(keys[field], { value: text, status: 'editing', message: null }); };
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (seed && editable) { setValue('reason', seed); onSeedUsed(); }
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = PROPOSAL_FIELDS.some((field) => act.drafts.get(keys[field.id]));
  const clear = () => PROPOSAL_FIELDS.forEach((field) => act.drafts.clear(keys[field.id]));
  async function save(event) {
    event.preventDefault();
    if (!value('reason').trim() || busy) return;
    setBusy(true);
    const proposal = Object.fromEntries(PROPOSAL_FIELDS.map((field) => [field.id, value(field.id).trim()]).filter(([, text]) => text));
    const result = await act.send({ type: 'setProposal', id: step.id, proposal }, step.proposal ? '수정안 고치기' : '수정안 남기기');
    setBusy(false);
    if (result.ok) clear();
  }
  return <>
    <p className="fm-muted fm-proposal-intro"><span className="fm-state fm-state--planned"><i aria-hidden="true" />다음에 바꿀 내용</span>왜 바꾸는지, 바꾼 뒤 어떻게 되어야 하는지 적어요. 지도에는 빨간색으로 남아요.</p>
    {!editable ? (step.proposal ? <dl className="fm-proposal-read">{PROPOSAL_FIELDS.filter((field) => saved[field.id]).map((field) => <div key={field.id}><dt>{field.label}</dt><dd>{saved[field.id]}</dd></div>)}</dl>
      : <p className="fm-muted">이 단계에는 수정안이 없어요.</p>)
      : <form className="fm-proposal-form" onSubmit={save}>
        {PROPOSAL_FIELDS.map((field) => <label key={field.id} className="fm-field"><span className="fm-field__label">{field.label}{!field.required && <small>선택</small>}</span>
          <textarea value={value(field.id)} rows={field.rows} maxLength={TEXT_LIMITS.summary} placeholder={field.placeholder} required={field.required}
            data-testid={`fm-proposal-${field.id}`} onChange={(event) => setValue(field.id, event.target.value)} /></label>)}
        <div className="fm-row">
          <button type="submit" className="fm-button fm-button--planned" disabled={busy || !value('reason').trim() || (!dirty && step.proposal !== undefined)} data-testid="fm-proposal-save">
            <FlowIcon name="arrow" size={13} />{step.proposal ? '수정안 저장' : '수정안 남기기'}</button>
          {dirty && <button type="button" className="fm-text-button" onClick={clear}>쓰던 내용 지우기</button>}
          {step.proposal !== undefined && <button type="button" className="fm-text-button fm-push" disabled={busy}
            onClick={async () => { const result = await act.send({ type: 'setProposal', id: step.id, proposal: null }, '수정안 거두기'); if (result.ok) clear(); }}>수정안 거두기</button>}
        </div>
      </form>}
  </>;
}

function featureIndex(links) {
  const index = new Map();
  for (const map of links?.data?.features || []) {
    const byId = new Map(map.nodes.map((node) => [node.id, node]));
    for (const node of map.nodes) {
      const parent = node.parentId ? byId.get(node.parentId) : null;
      index.set(`${map.file}#${node.id}`, { map, node, parentLabel: parent?.label || null });
    }
  }
  return index;
}

export function FeaturesTab({ step, editable, act, links }) {
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);
  useEffect(() => { act.loadLinks(); }, [step.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPicking(false); setQuery(''); }, [step.id]);
  const index = useMemo(() => featureIndex(links), [links]);
  const current = step.features || [];
  const currentKeys = new Set(current.map(featureLinkKey));
  const maps = links?.data?.features || [];
  const ready = links?.status === 'ready';
  const save = (features, label) => act.send({ type: 'updateStep', id: step.id, features }, label);
  const results = useMemo(() => {
    const text = query.trim().toLowerCase();
    const items = [];
    for (const map of maps) for (const node of map.nodes) {
      if (node.section === 'reference' || !node.parentId) continue;
      const key = `${map.file}#${node.id}`;
      if (currentKeys.has(key)) continue;
      if (text && !node.label.toLowerCase().includes(text) && !node.id.toLowerCase().includes(text)) continue;
      items.push({ key, map, node, parentLabel: index.get(key)?.parentLabel });
      if (items.length >= 40) return items;
    }
    return items;
  }, [maps, query, current, index]); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <p className="fm-muted">이 단계에서 쓰는 기능을 기능 계통도에서 골라 이어요. 이은 기능은 이 지도 파일에 적혀요.</p>
    <ul className="fm-links" data-testid="fm-feature-links">
      {current.map((link) => {
        const found = index.get(featureLinkKey(link));
        const missing = ready && !found;
        return <li key={featureLinkKey(link)} className={missing ? 'is-missing' : undefined}>
          <button type="button" className="fm-links__main" disabled={missing || !found} onClick={() => act.openFeature(link.map, link.id)}
            title={missing ? `${link.map}에서 ${link.id}를 찾을 수 없어요` : '기능 계통도에서 열기'}>
            <FlowIcon name={missing ? 'alert' : 'link'} size={13} />
            <span>{missing ? '찾을 수 없는 기능' : found ? found.node.label : '불러오는 중…'}
              <small>{missing ? `${link.map} · ${link.id}` : found ? [maps.length > 1 ? found.map.title : null, found.parentLabel].filter(Boolean).join(' · ') : link.id}</small></span>
            {!missing && found && <FlowIcon name="arrow" size={12} />}
          </button>
          {editable && <button type="button" className="fm-icon-button" aria-label={`${found?.node.label || link.id} 연결 빼기`} title="연결 빼기"
            onClick={() => save(current.filter((item) => featureLinkKey(item) !== featureLinkKey(link)), '기능 연결 빼기')}><FlowIcon name="close" size={13} /></button>}
        </li>;
      })}
      {!current.length && <li className="fm-links__empty">아직 이은 기능이 없어요.</li>}
    </ul>
    {links?.status === 'error' && <p className="fm-field__status" role="alert">기능 목록을 불러오지 못했어요. <button type="button" onClick={() => act.loadLinks(true)}>다시 불러오기</button></p>}
    {editable && ready && !maps.length && <p className="fm-muted">이 프로젝트에는 아직 기능 계통도가 없어요.</p>}
    {editable && maps.length > 0 && (picking ? <div className="fm-picker">
      <label className="fm-search"><FlowIcon name="search" size={13} /><span className="fm-sr-only">기능 찾기</span>
        <input type="text" value={query} autoFocus placeholder="기능 이름으로 찾기" onChange={(event) => setQuery(event.target.value)} data-testid="fm-feature-search"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setPicking(false); } }} /></label>
      <ul className="fm-picker__list" role="listbox" aria-label="이을 기능">
        {results.map(({ key, map, node, parentLabel }) => <li key={key}><button type="button" role="option" aria-selected="false" data-testid={`fm-feature-option-${node.id}`}
          onClick={async () => { const result = await save([...current, { map: map.file, id: node.id }], '기능 잇기'); if (result.ok) setQuery(''); }}>
          <span>{node.label}<small>{[maps.length > 1 ? map.title : null, parentLabel].filter(Boolean).join(' · ')}</small></span><FlowIcon name="plus" size={13} /></button></li>)}
        {!results.length && <li className="fm-links__empty">{query ? '맞는 기능이 없어요.' : '더 이을 기능이 없어요.'}</li>}
      </ul>
      <button type="button" className="fm-text-button" onClick={() => setPicking(false)}>다 골랐어요</button>
    </div> : <button type="button" className="fm-button fm-button--wide" onClick={() => setPicking(true)} data-testid="fm-feature-pick"><FlowIcon name="link" size={13} />기능 고르기</button>)}
  </>;
}

/** Recorded turns of the map, and recording a new one. Each turn can be read on the canvas. */
export function TurnsPanel({ graph, editable, act, header, viewing = null }) {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const turns = graph.turns || [];
  async function record(event) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    const result = await act.send({ type: 'createTurn', title: title.trim(), ...(summary.trim() ? { summary: summary.trim() } : {}) }, '턴 기록', { record: false });
    setBusy(false);
    if (result.ok) { setTitle(''); setSummary(''); act.clearHistory(); act.notify(`턴 ${turns.length + 1} 기록을 남겼어요.`); }
  }
  return <>
    {header}
    <div className="fm-panel__body">
      <p className="fm-muted">턴은 지금 지도의 모습을 그대로 남기는 기록이에요. 다음 턴을 남기면 두 턴 사이에 바뀐 단계가 파란색으로 보여요. 기록한 턴은 고치거나 지울 수 없어요.</p>
      {editable && <form className="fm-turn-form" onSubmit={record}>
        <label className="fm-field"><span className="fm-field__label">턴 이름</span>
          <input type="text" value={title} maxLength={TEXT_LIMITS.title} placeholder="예: 빠른 참가 흐름 정리" onChange={(event) => setTitle(event.target.value)} data-testid="fm-turn-title" /></label>
        <label className="fm-field"><span className="fm-field__label">무엇이 달라졌나요<small>선택</small></span>
          <textarea value={summary} rows={2} maxLength={TEXT_LIMITS.summary} placeholder="실제로 바꾼 것과 확인한 방법" onChange={(event) => setSummary(event.target.value)} /></label>
        <button type="submit" className="fm-button fm-button--dark" disabled={!title.trim() || busy} data-testid="fm-turn-submit"><FlowIcon name="history" size={13} />지금 모습을 턴으로 기록</button>
        <small className="fm-muted">기록하면 되돌리기 기록은 새로 시작돼요.</small>
      </form>}
      <PanelSection title={turns.length ? `기록한 턴 ${turns.length}개` : '기록한 턴'}>
        {turns.length ? <ol className="fm-turns" data-testid="fm-turn-list">{[...turns].reverse().map((turn) => <li key={turn.id} className={viewing === turn.id ? 'is-viewing' : undefined}>
          <header><b>턴 {turn.number}</b><span>{turn.title}</span><small>{dateText(turn.createdAt)}</small></header>
          {turn.summary && <p>{turn.summary}</p>}
          <div className="fm-turns__foot"><small className="fm-muted">단계 {turn.steps.length}개 · 화살표 {turn.arrows.length}개</small>
            {viewing === turn.id ? <span className="fm-turns__now">지금 보는 중</span>
              : <button type="button" className="fm-button fm-button--small" onClick={() => act.viewTurn(turn.id)} data-testid={`fm-view-turn-${turn.number}`}><FlowIcon name="eye" size={13} />이 턴 보기</button>}</div>
        </li>)}</ol> : <p className="fm-muted">아직 기록한 턴이 없어요.</p>}
      </PanelSection>
    </div>
  </>;
}

/** Problem, purpose, success criteria, and approval; the export references the canonical file. */
/** `focusStep` is the focused step or lane, or null for the whole map. */
export function BriefPanel({ focusStep, mapKey, api, act, header }) {
  const storageKey = `shape-map:discussion:${mapKey}:${focusStep?.id || 'all'}`;
  const [request, setRequest] = useState(() => {
    try { const saved = JSON.parse(window.localStorage.getItem(storageKey)); if (saved) return { ...saved, approved: false }; } catch { /* use the proposal */ }
    return { problem: focusStep?.proposal?.reason || '', purpose: focusStep?.proposal?.purpose || '', successCriteria: focusStep?.proposal?.successCriteria || '', approved: false };
  });
  const [brief, setBrief] = useState(null);
  const [status, setStatus] = useState(null);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  async function generate(next = request) {
    const ticket = ++generation.current;
    setStatus('loading'); setCopied(false);
    try {
      const body = await api.requestBrief({ ...(focusStep ? { focus: focusStep.id } : {}), problem: next.problem, purpose: next.purpose, successCriteria: next.successCriteria, approved: next.approved });
      if (ticket === generation.current) { setBrief(body.text); setStatus(null); }
    } catch { if (ticket === generation.current) { setBrief(null); setStatus('error'); } }
  }
  useEffect(() => { generate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (field, value) => {
    const next = { ...request, [field]: value, approved: false };
    setRequest(next); setBrief(null); setCopied(false);
    try { window.localStorage.setItem(storageKey, JSON.stringify({ problem: next.problem, purpose: next.purpose, successCriteria: next.successCriteria })); } catch { /* the text stays on screen */ }
  };
  const canApprove = Boolean(request.problem.trim() && request.successCriteria.trim());
  async function copy() {
    try { await navigator.clipboard.writeText(brief); setCopied(true); } catch { act.notify('자동 복사를 쓸 수 없어요. 글을 직접 골라 복사하거나 파일로 저장해 주세요.', true); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([brief], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'shape-map-flow-request.md'; link.click(); URL.revokeObjectURL(url);
  }
  return <>
    {header}
    <div className="fm-panel__body fm-brief" data-testid="fm-brief">
      <p className="fm-muted">{focusStep ? `이 ${focusStep.title !== undefined ? '줄' : '단계'}에 대한 요청을 정리해 AI에게 전해요.` : '마지막 턴 이후 바뀐 단계, 새 메모, 수정안만 담아 AI에게 전해요.'} 지도 전체를 옮겨 적지 않고 원본 파일을 가리켜요.</p>
      {[['problem', '지금 풀고 싶은 문제', '무엇이 불편하거나 막히나요?'], ['purpose', '목적', '무엇을 더 쉽게 하려는 건가요?'], ['successCriteria', '해결 성공 기준', '무엇을 확인하면 해결된 건가요?']].map(([field, label, placeholder]) => <label key={field} className="fm-field">
        <span className="fm-field__label">{label}{field === 'purpose' && <small>선택</small>}</span>
        <textarea rows={2} value={request[field]} maxLength={4000} placeholder={placeholder} onChange={(event) => update(field, event.target.value)} data-testid={`fm-brief-${field}`} /></label>)}
      <label className="fm-check fm-approval"><input type="checkbox" checked={request.approved} disabled={!canApprove} data-testid="fm-brief-approve"
        onChange={(event) => { setRequest((value) => ({ ...value, approved: event.target.checked })); setBrief(null); }} />위 요청을 확정했고 실행을 승인합니다
        <small>{canApprove ? '승인하면 AI가 문답 뒤 바로 구현하고 검증해요. 내용을 고치면 승인이 풀려요.' : '문제와 성공 기준을 적으면 고를 수 있어요.'}</small></label>
      <button type="button" className="fm-button" onClick={() => generate()} disabled={status === 'loading'} data-testid="fm-brief-generate"><FlowIcon name="mail" size={13} />{request.approved ? '승인한 요청 만들기' : '문답용 글 만들기'}</button>
      {status === 'error' && <p className="fm-field__status" role="alert">요청 글을 만들지 못했어요. 연결을 확인하고 다시 눌러 주세요.</p>}
      {brief && <>
        <label className="fm-sr-only" htmlFor="fm-brief-text">AI에게 전할 글</label>
        <textarea id="fm-brief-text" className="fm-brief__text" value={brief} readOnly rows={12} data-testid="fm-brief-text" />
        <div className="fm-row"><button type="button" className="fm-button" onClick={download}><FlowIcon name="download" size={13} />글로 저장</button>
          <button type="button" className="fm-button fm-button--dark" onClick={copy} data-testid="fm-brief-copy"><FlowIcon name={copied ? 'check' : 'copy'} size={13} />{copied ? '복사했어요' : '요청 복사'}</button></div>
      </>}
    </div>
  </>;
}

const COMPARE_OPTIONS = [
  { id: 'previous', label: '이전 턴과 비교', hint: '기록한 두 턴 사이에 바뀐 단계가 파란색이에요' },
  { id: 'current', label: '지금 지도와 비교', hint: '지금 지도와 다른 단계에 표시가 붙어요. 색은 바뀌지 않아요' },
];

/** The bar shown while reading a recorded turn, with the way back to the live map. */
export function TurnBar({ turn, turns, reading, compare, onCompare, onView, onExit }) {
  const index = turns.findIndex((item) => item.id === turn.id);
  const changed = [...reading.states.values()].filter((state) => state.differs && !state.added).length;
  const added = [...reading.states.values()].filter((state) => state.added).length;
  const removed = reading.removed;
  const names = (steps) => steps.slice(0, 3).map((step) => step.label).join(', ') + (steps.length > 3 ? ` 외 ${steps.length - 3}개` : '');
  let summary;
  if (!reading.base) summary = '첫 턴이라 비교할 이전 기록이 없어요. 색은 이 턴에 기록된 그대로예요.';
  else if (compare === 'previous') {
    summary = changed || added || removed.length
      ? [changed && `바뀐 단계 ${changed}개`, added && `새 단계 ${added}개`, removed.length && `빠진 단계 ${removed.length}개(${names(removed)})`].filter(Boolean).join(' · ')
      : '이전 턴과 달라진 단계가 없어요.';
  } else {
    summary = changed || added || removed.length
      ? [changed && `지금과 다른 단계 ${changed}개`, added && `지금은 없는 단계 ${added}개`, removed.length && `그 뒤에 생긴 단계 ${removed.length}개(${names(removed)})`].filter(Boolean).join(' · ')
      : '지금 지도와 같아요.';
  }
  return <div className="fm-turnbar" role="region" aria-label="기록한 턴 보기" data-testid="fm-turnbar">
    <div className="fm-turnbar__main">
      <FlowIcon name="history" size={15} />
      <div className="fm-turnbar__text">
        <strong>턴 {turn.number} · {turn.title}</strong>
        <span>{new Date(turn.createdAt).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' })}에 기록한 모습이에요. 읽기만 할 수 있어요.</span>
        <span className="fm-turnbar__summary" data-testid="fm-turn-summary">{summary}</span>
      </div>
    </div>
    <div className="fm-turnbar__actions">
      <div className="fm-segmented fm-segmented--compact" role="radiogroup" aria-label="무엇과 비교할까요">
        {COMPARE_OPTIONS.map((option) => <button key={option.id} type="button" role="radio" aria-checked={compare === option.id} title={option.hint}
          onClick={() => onCompare(option.id)} data-testid={`fm-compare-${option.id}`}>{option.label}</button>)}
      </div>
      <div className="fm-turnbar__nav">
        <button type="button" className="fm-icon-button fm-icon-button--boxed" aria-label="이전 턴 보기" title="이전 턴" disabled={index <= 0} onClick={() => onView(turns[index - 1].id)}><FlowIcon name="left" size={14} /></button>
        <button type="button" className="fm-icon-button fm-icon-button--boxed" aria-label="다음 턴 보기" title="다음 턴" disabled={index >= turns.length - 1} onClick={() => onView(turns[index + 1].id)}><FlowIcon name="right" size={14} /></button>
      </div>
      <button type="button" className="fm-button fm-button--dark" onClick={onExit} data-testid="fm-turn-exit"><FlowIcon name="back" size={13} />지금 지도로 돌아가기</button>
    </div>
  </div>;
}
