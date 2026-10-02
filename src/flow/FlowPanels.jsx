import { useEffect, useMemo, useState } from 'react';
import { ARROW_STYLES, SHARED_BAND_ID, STEP_SHAPES, TAG_PALETTE, TEXT_LIMITS } from './flowConstants.js';
import {
  changeLaneOperation, cleanLabel, cleanSummary, connectableTargets, deleteLanePlan, laneSteps, laneTitle, moveLaneOperation,
  newTagId, paletteIndexFor, reorderStepOperation, reverseArrowOperation, stepRelations, tagOperation, tagUsage, toggleTag,
} from './flowEditing.js';
import { DraftField, PanelSection, Segmented } from './FlowFields.jsx';
import { TagChip } from './FlowElements.jsx';
import FlowIcon from './FlowIcon.jsx';

function PanelHeader({ eyebrow, title, onClose }) {
  return <header className="fm-panel__header">
    <div><span className="fm-panel__eyebrow">{eyebrow}</span><h2 title={title}>{title}</h2></div>
    <button type="button" className="fm-icon-button" aria-label="닫기" title="닫기 (Esc)" onClick={onClose}><FlowIcon name="close" size={15} /></button>
  </header>;
}

function CopyId({ id, act }) {
  return <button type="button" className="fm-copy-id" title={id} onClick={() => act.copy(id, '고유 이름을 복사했어요.')}>
    <FlowIcon name="copy" size={12} />고유 이름 복사
  </button>;
}

function TagPicker({ graph, value = [], onChange, disabled, act }) {
  const order = graph.tags.map((tag) => tag.id);
  return <PanelSection title="표시" aside={<button type="button" className="fm-text-button" onClick={act.openTags}>표시 관리</button>}>
    {graph.tags.length ? <div className="fm-tag-picker" role="group" aria-label="표시 고르기">
      {graph.tags.map((tag) => <button key={tag.id} type="button" aria-pressed={value.includes(tag.id)} disabled={disabled}
        onClick={() => onChange(toggleTag(value, tag.id, order))}><TagChip tag={tag} small />{value.includes(tag.id) && <FlowIcon name="check" size={12} />}</button>)}
    </div> : <p className="fm-muted">아직 만든 표시가 없어요.</p>}
  </PanelSection>;
}

function Confirm({ text, action, onConfirm, onCancel }) {
  return <div className="fm-confirm" role="alertdialog" aria-label={text}>
    <p>{text}</p>
    <div><button type="button" className="fm-button fm-button--danger" onClick={onConfirm} autoFocus>{action}</button>
      <button type="button" className="fm-button" onClick={onCancel}>그만두기</button></div>
  </div>;
}

export function StepPanel({ step, graph, words, editable, act, focusLabel }) {
  const relations = useMemo(() => stepRelations(graph, step.id), [graph, step.id]);
  const [target, setTarget] = useState('');
  const [style, setStyle] = useState('next');
  const lanePosition = laneSteps(graph, step.lane).findIndex((item) => item.id === step.id);
  const laneCount = laneSteps(graph, step.lane).length;
  const options = connectableTargets(graph, step.id);
  useEffect(() => { setTarget(''); }, [step.id]);
  return <>
    <PanelHeader eyebrow={`단계 · ${laneTitle(graph, step.lane, words.shared)}`} title={step.label} onClose={act.close} />
    <div className="fm-panel__body">
      <DraftField key={`${step.id}-label`} label="이름" value={step.label} limit={TEXT_LIMITS.step} disabled={!editable} autoFocus={focusLabel} testId="fm-step-label"
        clean={(text) => cleanLabel(text)} onCommit={(label) => act.send({ type: 'updateStep', id: step.id, label }, '단계 이름 바꾸기')} />
      <DraftField key={`${step.id}-summary`} label="설명" hint="카드에는 첫 줄만 보여요" value={step.summary || ''} multiline limit={TEXT_LIMITS.summary} allowEmpty disabled={!editable}
        placeholder="이 단계에서 일어나는 일, 정해야 할 것" clean={cleanSummary} testId="fm-step-summary"
        onCommit={(summary) => act.send({ type: 'updateStep', id: step.id, summary: summary || null }, '단계 설명 바꾸기')} />
      <Segmented label="모양" options={STEP_SHAPES} value={step.shape} disabled={!editable}
        renderOption={(option) => <><i className={`fm-shape-glyph fm-shape-glyph--${option.id}`} aria-hidden="true" />{option.label}</>}
        onChange={(shape) => act.send({ type: 'updateStep', id: step.id, shape }, '단계 모양 바꾸기')} />
      <TagPicker graph={graph} value={step.tags} disabled={!editable} act={act}
        onChange={(tags) => act.send({ type: 'updateStep', id: step.id, tags }, '단계 표시 바꾸기')} />
      {(graph.lanes.length > 0 || step.lane != null) && <PanelSection title={`${words.lane} · 순서`}>
        <div className="fm-row">
          <label className="fm-select"><span className="fm-sr-only">{words.lane}</span>
            <select value={step.lane ?? SHARED_BAND_ID} disabled={!editable} data-testid="fm-step-lane"
              onChange={(event) => { const lane = event.target.value === SHARED_BAND_ID ? null : event.target.value; const operation = changeLaneOperation(graph, step.id, lane); if (operation) act.send(operation, `${words.lane} 바꾸기`); }}>
              {graph.lanes.map((lane) => <option key={lane.id} value={lane.id}>{lane.title}</option>)}
              <option value={SHARED_BAND_ID}>{words.shared}</option>
            </select></label>
          <button type="button" className="fm-icon-button fm-icon-button--boxed" aria-label="앞으로 옮기기" title="같은 줄에서 앞으로" disabled={!editable || lanePosition <= 0}
            onClick={() => act.send(reorderStepOperation(graph, step.id, 'earlier'), '단계 순서 바꾸기')}><FlowIcon name="left" size={14} /></button>
          <button type="button" className="fm-icon-button fm-icon-button--boxed" aria-label="뒤로 옮기기" title="같은 줄에서 뒤로" disabled={!editable || lanePosition >= laneCount - 1}
            onClick={() => act.send(reorderStepOperation(graph, step.id, 'later'), '단계 순서 바꾸기')}><FlowIcon name="right" size={14} /></button>
        </div>
        <p className="fm-muted">화살표가 없는 단계만 이 순서대로 놓여요.</p>
      </PanelSection>}
      <PanelSection title="이어진 단계">
        <ul className="fm-relations">
          {relations.incoming.map(({ arrow, label }) => <li key={`in-${arrow.source}`}><button type="button" onClick={() => act.select({ kind: 'arrow', id: `${arrow.source}->${arrow.target}` })}>
            <span className="fm-relations__dir">앞</span><span>{label}</span>{arrow.label && <small>{arrow.label}</small>}</button></li>)}
          {relations.outgoing.map(({ arrow, label }) => <li key={`out-${arrow.target}`}><button type="button" onClick={() => act.select({ kind: 'arrow', id: `${arrow.source}->${arrow.target}` })}>
            <span className="fm-relations__dir">다음</span><span>{label}</span>{arrow.label && <small>{arrow.label}</small>}</button></li>)}
          {!relations.incoming.length && !relations.outgoing.length && <li className="fm-muted">아직 이어진 단계가 없어요.</li>}
        </ul>
        {editable && options.length > 0 && <div className="fm-connect">
          <label className="fm-select"><span className="fm-sr-only">이을 단계</span>
            <select value={target} onChange={(event) => setTarget(event.target.value)} data-testid="fm-connect-target">
              <option value="">이을 단계 고르기…</option>
              {options.map((item) => <option key={item.id} value={item.id}>{item.label} · {laneTitle(graph, item.lane, words.shared)}</option>)}
            </select></label>
          <label className="fm-select fm-select--small"><span className="fm-sr-only">화살표 종류</span>
            <select value={style} onChange={(event) => setStyle(event.target.value)}>{ARROW_STYLES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <button type="button" className="fm-button" disabled={!target} onClick={async () => { const result = await act.connect(step.id, target, style); if (result?.ok) setTarget(''); }}>잇기</button>
        </div>}
      </PanelSection>
      {editable && <div className="fm-panel__actions">
        <button type="button" className="fm-button fm-button--dark" onClick={() => act.addNext(step.id)}><FlowIcon name="plus" size={14} />다음 단계 추가</button>
        <button type="button" className="fm-button fm-button--quiet-danger" onClick={() => act.deleteSteps([step.id])}><FlowIcon name="trash" size={14} />지우기</button>
      </div>}
      <CopyId id={step.id} act={act} />
    </div>
  </>;
}

const ARROW_SAMPLE = (style) => <svg width="30" height="10" aria-hidden="true" className={`fm-arrow-sample fm-arrow-sample--${style}`}>
  {style === 'exchange' && <path d="M2 5 H22" className="casing" />}<path d="M2 5 H22" className="line" /><path d="M21 1.5 L28 5 L21 8.5 Z" className="head" />
</svg>;

export function ArrowPanel({ arrow, graph, editable, act }) {
  const from = graph.steps.find((step) => step.id === arrow.source);
  const to = graph.steps.find((step) => step.id === arrow.target);
  return <>
    <PanelHeader eyebrow="화살표" title={`${from?.label ?? ''} → ${to?.label ?? ''}`} onClose={act.close} />
    <div className="fm-panel__body">
      <div className="fm-arrow-ends">
        <button type="button" onClick={() => act.select({ kind: 'step', id: arrow.source })}><small>시작</small>{from?.label}</button>
        <FlowIcon name="arrow" size={14} />
        <button type="button" onClick={() => act.select({ kind: 'step', id: arrow.target })}><small>도착</small>{to?.label}</button>
      </div>
      <Segmented label="종류" options={ARROW_STYLES} value={arrow.style} disabled={!editable}
        renderOption={(option) => <>{ARROW_SAMPLE(option.id)}{option.label}</>}
        onChange={(style) => act.send({ type: 'updateArrow', source: arrow.source, target: arrow.target, style }, '화살표 종류 바꾸기')} />
      <DraftField key={`${arrow.source}->${arrow.target}`} label="글자" hint="비우면 글자가 없어져요" value={arrow.label || ''} limit={TEXT_LIMITS.arrow} allowEmpty disabled={!editable}
        placeholder="예: 보증금, 거절, 실패하면" clean={(text) => cleanLabel(text, TEXT_LIMITS.arrow)} testId="fm-arrow-label-input"
        onCommit={(label) => act.send({ type: 'updateArrow', source: arrow.source, target: arrow.target, label: label || null }, '화살표 글자 바꾸기')} />
      {editable && <div className="fm-panel__actions fm-panel__actions--stack">
        <button type="button" className="fm-button fm-button--dark" onClick={() => act.insertOnArrow(`${arrow.source}->${arrow.target}`)}><FlowIcon name="plus" size={14} />사이에 단계 넣기</button>
        <div className="fm-row">
          <button type="button" className="fm-button" onClick={() => { const plan = reverseArrowOperation(graph, arrow); if (plan.error) act.notify(plan.error, true); else act.send(plan.operation, '화살표 방향 바꾸기', { select: { kind: 'arrow', id: `${arrow.target}->${arrow.source}` } }); }}>
            <FlowIcon name="swap" size={14} />방향 뒤집기</button>
          <button type="button" className="fm-button fm-button--quiet-danger" onClick={() => act.removeArrow(arrow)}><FlowIcon name="trash" size={14} />지우기</button>
        </div>
      </div>}
    </div>
  </>;
}

export function LanePanel({ lane, graph, words, editable, act, focusLane, focusLabel }) {
  const [confirming, setConfirming] = useState(false);
  const plan = deleteLanePlan(graph, lane.id);
  const index = graph.lanes.findIndex((item) => item.id === lane.id);
  useEffect(() => { setConfirming(false); }, [lane.id]);
  return <>
    <PanelHeader eyebrow={words.lane} title={lane.title} onClose={act.close} />
    <div className="fm-panel__body">
      <DraftField key={`${lane.id}-title`} label="이름" value={lane.title} limit={TEXT_LIMITS.lane} disabled={!editable} autoFocus={focusLabel} testId="fm-lane-title"
        clean={(text) => cleanLabel(text, TEXT_LIMITS.lane)} onCommit={(title) => act.send({ type: 'updateLane', id: lane.id, title }, `${words.lane} 이름 바꾸기`)} />
      <DraftField key={`${lane.id}-summary`} label="설명" value={lane.summary || ''} multiline allowEmpty limit={TEXT_LIMITS.summary} disabled={!editable}
        placeholder={words.lanePlaceholder} clean={cleanSummary}
        onCommit={(summary) => act.send({ type: 'updateLane', id: lane.id, summary: summary || null }, `${words.lane} 설명 바꾸기`)} />
      <TagPicker graph={graph} value={lane.tags} disabled={!editable} act={act}
        onChange={(tags) => act.send({ type: 'updateLane', id: lane.id, tags }, `${words.lane} 표시 바꾸기`)} />
      <PanelSection title="보기와 순서">
        <div className="fm-row">
          <button type="button" className={`fm-button${focusLane === lane.id ? ' is-on' : ''}`} aria-pressed={focusLane === lane.id}
            onClick={() => act.focusLane(focusLane === lane.id ? null : lane.id)}><FlowIcon name="eye" size={14} />{words.laneFocus}</button>
          <button type="button" className="fm-icon-button fm-icon-button--boxed" aria-label="위로 옮기기" disabled={!editable || index <= 0}
            onClick={() => act.send(moveLaneOperation(graph, lane.id, 'up'), `${words.lane} 순서 바꾸기`)}><FlowIcon name="up" size={14} /></button>
          <button type="button" className="fm-icon-button fm-icon-button--boxed" aria-label="아래로 옮기기" disabled={!editable || index >= graph.lanes.length - 1}
            onClick={() => act.send(moveLaneOperation(graph, lane.id, 'down'), `${words.lane} 순서 바꾸기`)}><FlowIcon name="down" size={14} /></button>
        </div>
      </PanelSection>
      {editable && <div className="fm-panel__actions">
        <button type="button" className="fm-button fm-button--dark" onClick={() => act.addInLane(lane.id)}><FlowIcon name="plus" size={14} />단계 추가</button>
        <button type="button" className="fm-button fm-button--quiet-danger" onClick={() => (plan.needsConfirmation ? setConfirming(true) : act.send(plan.operation, words.laneDelete, { select: null }))}>
          <FlowIcon name="trash" size={14} />{words.laneDelete}</button>
      </div>}
      {confirming && <Confirm text={`이 ${words.lane}의 단계 ${plan.stepCount}개와 그 화살표도 함께 지워져요. 지울까요?`} action="함께 지우기"
        onConfirm={() => { setConfirming(false); act.send(plan.operation, words.laneDelete, { select: null }); }} onCancel={() => setConfirming(false)} />}
      <CopyId id={lane.id} act={act} />
    </div>
  </>;
}

export function MapPanel({ graph, fallbackTitle, words, editable, act }) {
  return <>
    <PanelHeader eyebrow={`${words.kindLabel} 정보`} title={graph.map?.title || fallbackTitle} onClose={act.close} />
    <div className="fm-panel__body">
      <DraftField label="지도 이름" value={graph.map?.title || ''} limit={TEXT_LIMITS.title} allowEmpty disabled={!editable} placeholder={fallbackTitle} testId="fm-map-title"
        clean={(text) => cleanLabel(text, TEXT_LIMITS.title)} onCommit={(title) => act.send({ type: 'setMapHeader', title: title || null }, '지도 이름 바꾸기')} />
      <DraftField label="한 줄 설명" value={graph.map?.description || ''} limit={TEXT_LIMITS.description} allowEmpty disabled={!editable} testId="fm-map-description"
        placeholder="이 지도가 보여 주는 것" clean={(text) => cleanLabel(text, TEXT_LIMITS.description)}
        onCommit={(description) => act.send({ type: 'setMapHeader', description: description || null }, '지도 설명 바꾸기')} />
      <p className="fm-muted">단계 {graph.steps.length}개 · 화살표 {graph.arrows.length}개 · {words.lanes} {graph.lanes.length}개 · 표시 {graph.tags.length}개</p>
    </div>
  </>;
}

function TagEditor({ graph, tag, onSave, onDelete, onCancel, editable }) {
  const [label, setLabel] = useState(tag?.label || '');
  const [description, setDescription] = useState(tag?.description || '');
  const known = tag ? paletteIndexFor(tag) : -1;
  const firstFree = TAG_PALETTE.findIndex((entry) => !graph.tags.some((item) => item.fill.toUpperCase() === entry.fill.toUpperCase()));
  const [paletteIndex, setPaletteIndex] = useState(tag ? known : Math.max(0, firstFree));
  const [dashed, setDashed] = useState(Boolean(tag?.strokeDasharray));
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState(null);
  const usage = tag ? tagUsage(graph, tag.id) : 0;
  const preview = paletteIndex >= 0 ? { ...TAG_PALETTE[paletteIndex], label: label || '이름', strokeDasharray: dashed ? '4 3' : undefined }
    : { ...tag, label: label || '이름', strokeDasharray: dashed ? tag.strokeDasharray || '4 3' : undefined };
  async function save(event) {
    event.preventDefault();
    if (!cleanLabel(label, TEXT_LIMITS.tag)) { setStatus('이름을 적어 주세요.'); return; }
    setStatus('저장 중…');
    const result = await onSave(tagOperation({ id: tag?.id || newTagId(graph), label, description, paletteIndex, dashed, base: tag, strokeWidth: tag?.strokeWidth ?? 1 }));
    setStatus(result?.ok ? null : result?.message || '저장하지 못했어요. 적은 내용은 그대로 있어요.');
  }
  return <form className="fm-tag-editor" onSubmit={save}>
    <div className="fm-tag-editor__preview"><TagChip tag={preview} /></div>
    <label className="fm-field"><span className="fm-field__label">이름</span><input value={label} maxLength={TEXT_LIMITS.tag} disabled={!editable} onChange={(event) => setLabel(event.target.value)} autoFocus={!tag} data-testid="fm-tag-name" /></label>
    <label className="fm-field"><span className="fm-field__label">설명</span><input value={description} maxLength={TEXT_LIMITS.description} disabled={!editable} placeholder="예: 돈이 오가는 단계" onChange={(event) => setDescription(event.target.value)} /></label>
    <div className="fm-field"><span className="fm-field__label">색</span>
      <div className="fm-swatches" role="radiogroup" aria-label="색">
        {TAG_PALETTE.map((entry, index) => <button key={entry.name} type="button" role="radio" aria-checked={paletteIndex === index} aria-label={entry.name} title={entry.name} disabled={!editable}
          style={{ background: entry.fill, borderColor: entry.stroke, color: entry.stroke }} onClick={() => setPaletteIndex(index)}>{paletteIndex === index && <FlowIcon name="check" size={12} />}</button>)}
        {tag && known < 0 && <button type="button" role="radio" aria-checked={paletteIndex < 0} aria-label="지금 색" title="지금 색" style={{ background: tag.fill, borderColor: tag.stroke, color: tag.stroke }} onClick={() => setPaletteIndex(-1)}>{paletteIndex < 0 && <FlowIcon name="check" size={12} />}</button>}
      </div>
    </div>
    <label className="fm-check"><input type="checkbox" checked={dashed} disabled={!editable} onChange={(event) => setDashed(event.target.checked)} />점선으로 보이기<small>아직 정하지 않았거나 실제 단계가 아닌 것</small></label>
    {status && <p className="fm-field__status" role="status">{status}</p>}
    {editable && <div className="fm-row">
      <button type="submit" className="fm-button fm-button--dark">{tag ? '저장' : '표시 만들기'}</button>
      <button type="button" className="fm-button" onClick={onCancel}>닫기</button>
      {tag && <button type="button" className="fm-button fm-button--quiet-danger fm-push" onClick={() => (usage ? setConfirming(true) : onDelete(tag.id))}>지우기</button>}
    </div>}
    {confirming && <Confirm text={`이 표시가 ${usage}곳에서 빠져요. 지울까요?`} action="표시 지우기" onConfirm={() => { setConfirming(false); onDelete(tag.id); }} onCancel={() => setConfirming(false)} />}
  </form>;
}

export function TagsPanel({ graph, editable, act, highlight, onHighlight }) {
  const [editing, setEditing] = useState(null);
  return <>
    <PanelHeader eyebrow="표시 관리" title="표시" onClose={act.close} />
    <div className="fm-panel__body">
      <p className="fm-muted">표시는 장소, 주고받는 것, 쪽 같은 뜻을 단계와 줄에 붙여요. 눌러서 그 표시만 밝게 볼 수 있어요.</p>
      <ul className="fm-tag-list">
        {graph.tags.map((tag) => <li key={tag.id}>
          {editing === tag.id ? <TagEditor graph={graph} tag={tag} editable={editable} onCancel={() => setEditing(null)}
            onSave={async (operation) => { const result = await act.send(operation, '표시 바꾸기'); if (result.ok) setEditing(null); return result; }}
            onDelete={async (id) => { const result = await act.send({ type: 'deleteTag', id }, '표시 지우기'); if (result.ok) { setEditing(null); if (highlight === id) onHighlight(null); } }} />
            : <div className="fm-tag-row">
              <button type="button" className="fm-tag-row__main" aria-pressed={highlight === tag.id} onClick={() => onHighlight(highlight === tag.id ? null : tag.id)}>
                <TagChip tag={tag} /><span>{tag.description}</span><small>{tagUsage(graph, tag.id)}곳</small></button>
              {editable && <button type="button" className="fm-icon-button" aria-label={`${tag.label} 고치기`} onClick={() => setEditing(tag.id)}><FlowIcon name="pencil" size={14} /></button>}
            </div>}
        </li>)}
      </ul>
      {editable && (editing === '__new' ? <TagEditor graph={graph} editable={editable} onCancel={() => setEditing(null)}
        onSave={async (operation) => { const result = await act.send(operation, '표시 만들기'); if (result.ok) setEditing(null); return result; }} />
        : <button type="button" className="fm-button fm-button--wide" onClick={() => setEditing('__new')}><FlowIcon name="plus" size={14} />새 표시 만들기</button>)}
    </div>
  </>;
}
