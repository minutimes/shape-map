import { memo } from 'react';
import { EdgeLabelRenderer, Handle, Position } from '@xyflow/react';
import { roundedShapePath } from '../shapeRouting.js';
import { STEP_SHAPES } from './flowConstants.js';
import { firstLine } from './flowLayout.js';
import FlowIcon from './FlowIcon.jsx';

const SHAPE_NAME = Object.fromEntries(STEP_SHAPES.map((shape) => [shape.id, shape.label]));

export function shapePath(shape, width, height, point) {
  const w = width - 1; const h = height - 1;
  if (shape === 'decision') {
    return `M ${point + .5},.5 L ${w - point + .5},.5 L ${w + .5},${h / 2 + .5} L ${w - point + .5},${h + .5} L ${point + .5},${h + .5} L .5,${h / 2 + .5} Z`;
  }
  const r = shape === 'milestone' ? h / 2 : 9;
  return `M ${r + .5},.5 H ${w - r + .5} A ${r},${r} 0 0 1 ${w + .5},${r + .5} V ${h - r + .5} A ${r},${r} 0 0 1 ${w - r + .5},${h + .5} H ${r + .5} A ${r},${r} 0 0 1 .5,${h - r + .5} V ${r + .5} A ${r},${r} 0 0 1 ${r + .5},.5 Z`;
}

export function TagChip({ tag, small = false }) {
  if (!tag) return null;
  return <span className={`fm-chip${small ? ' fm-chip--small' : ''}${tag.strokeDasharray ? ' is-dashed' : ''}`}
    style={{ background: tag.fill, color: tag.textColor, borderColor: tag.strokeDasharray ? tag.stroke : `${tag.stroke}40` }} title={tag.description || tag.label}>
    <i style={{ background: tag.stroke }} aria-hidden="true" />{tag.label}
  </span>;
}

const STATE_SHORT = { planned: '수정 대상', concern: '검토 필요', verified: '검수 완료', changed: '직전 개선' };

/** Derived color, memo count, and feature-link count, sitting on the card's top edge. */
function StepMarks({ step, state }) {
  const status = state?.status && state.status !== 'neutral' ? state.status : null;
  const memos = state?.unresolvedCount || 0;
  const links = step.features?.length || 0;
  if (!status && !memos && !links) return null;
  return <span className="fm-step__marks" aria-hidden="true">
    {status && <span className={`fm-mark fm-mark--${status}`}><i />{STATE_SHORT[status]}</span>}
    {memos > 0 && <span className="fm-mark" title={`풀리지 않은 메모 ${memos}개`}><FlowIcon name="comment" size={10} />{memos}</span>}
    {links > 0 && <span className="fm-mark" title={`연결된 기능 ${links}개`}><FlowIcon name="link" size={10} />{links}</span>}
  </span>;
}

export const StepCard = memo(function StepCard({ data, selected }) {
  const { step, card, tags, emphasis, editable, point, columns, state } = data;
  const visible = tags.slice(0, 2);
  const dashed = tags.find((tag) => tag.strokeDasharray);
  const outline = shapePath(step.shape, card.width, card.height, point);
  const status = state?.status && state.status !== 'neutral' ? state.status : null;
  return <div className={`fm-step fm-step--${step.shape}${selected ? ' is-selected' : ''}${emphasis ? ` is-${emphasis}` : ''}${dashed ? ' is-dashed' : ''}${columns ? ' is-columns' : ''}${status ? ` is-state-${status}` : ''}`}
    data-step-id={step.id} data-testid={`fm-step-${step.id}`} data-state={status || undefined} style={{ width: card.width, height: card.height }}>
    <svg className="fm-step__shape" width={card.width} height={card.height} aria-hidden="true">
      <path className="fm-step__halo" d={outline} />
      <path className="fm-step__outline" d={outline} style={dashed ? { strokeDasharray: dashed.strokeDasharray } : undefined} />
    </svg>
    <Handle type="target" position={columns ? Position.Top : Position.Left} id="in" className="fm-handle fm-handle--in" isConnectable={editable} />
    <div className="fm-step__body">
      <span className="fm-sr-only">{SHAPE_NAME[step.shape]}{status ? `, ${STATE_SHORT[status]}` : ''}: </span>
      <span className="fm-step__label" style={{ WebkitLineClamp: card.lines }} title={step.label}>{step.label}</span>
      {card.noteLines > 0 && <span className="fm-step__summary" style={{ WebkitLineClamp: card.noteLines }} title={step.summary}>{firstLine(step.summary)}</span>}
      {tags.length > 0 && <span className="fm-step__tags">{visible.map((tag) => <TagChip key={tag.id} tag={tag} small />)}
        {tags.length > visible.length && <span className="fm-chip fm-chip--small fm-chip--more" title={tags.slice(2).map((tag) => tag.label).join(', ')}>+{tags.length - visible.length}</span>}</span>}
    </div>
    {step.summary && !card.noteLines && <span className="fm-step__note" title={step.summary} aria-label="설명 있음" />}
    <StepMarks step={step} state={state} />
    <Handle type="source" position={columns ? Position.Bottom : Position.Right} id="out" className="fm-handle fm-handle--out" isConnectable={editable} title="끌어서 다른 단계와 잇기" />
    {selected && editable && <button type="button" className="fm-step__next nodrag nopan" aria-label={`${step.label} 다음 단계 추가`} title="다음 단계 추가"
      onClick={(event) => { event.stopPropagation(); data.onAddNext(step.id); }}><FlowIcon name="plus" size={13} /></button>}
  </div>;
});

export const LaneAdd = memo(function LaneAdd({ data }) {
  return <button type="button" className="fm-lane-add nodrag nopan" onClick={(event) => { event.stopPropagation(); data.onAdd(data.laneId); }}>
    <FlowIcon name="plus" size={13} />{data.text}
  </button>;
});

function arrowHead(points, size) {
  const tip = points.at(-1); const from = points.at(-2);
  const length = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const dx = (tip.x - from.x) / length; const dy = (tip.y - from.y) / length;
  const bx = tip.x - dx * size.length; const by = tip.y - dy * size.length;
  return `M ${tip.x},${tip.y} L ${bx - dy * size.half},${by + dx * size.half} L ${bx + dy * size.half},${by - dx * size.half} Z`;
}

function trimmed(points, amount) {
  const result = points.map((point) => ({ ...point }));
  const tip = result.at(-1); const from = result.at(-2);
  const length = Math.hypot(tip.x - from.x, tip.y - from.y);
  if (length > amount) { tip.x -= ((tip.x - from.x) / length) * amount; tip.y -= ((tip.y - from.y) / length) * amount; }
  return result;
}

function longestMiddle(points) {
  let best = null;
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
    if (!best || length > best.length) best = { length, x: (points[i].x + points[i - 1].x) / 2, y: (points[i].y + points[i - 1].y) / 2 };
  }
  return best;
}

export const FlowArrow = memo(function FlowArrow({ id, data, selected }) {
  const { arrow, emphasis, editable } = data;
  const size = arrow.style === 'exchange' ? { length: 10, half: 5.5 } : { length: 8.5, half: 4.4 };
  const path = roundedShapePath(trimmed(arrow.points, size.length - 1), 7);
  const box = arrow.labelBox;
  const middle = longestMiddle(arrow.points);
  const insertAt = box ? { x: box.x + box.width / 2, y: box.y - 13 } : middle;
  const state = `${selected ? ' is-selected' : ''}${emphasis ? ` is-${emphasis}` : ''}`;
  return <g className={`fm-arrow fm-arrow--${arrow.style}${arrow.isReturn ? ' is-return' : ''}${state}`} data-testid={`fm-arrow-${arrow.key}`}>
    <path className="fm-arrow__hit" d={roundedShapePath(arrow.points, 7)} />
    {arrow.style === 'exchange' && <path className="fm-arrow__casing" d={path} />}
    <path id={id} className="fm-arrow__line" d={path} />
    <path className="fm-arrow__head" d={arrowHead(arrow.points, size)} />
    {(box || (selected && editable)) && <EdgeLabelRenderer>
      {box && <button type="button" tabIndex={-1} className={`fm-arrow-label fm-arrow-label--${arrow.style}${state} nodrag nopan`}
        style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height }}
        title={box.full} data-testid={`fm-arrow-label-${arrow.key}`} onClick={(event) => { event.stopPropagation(); data.onSelect(arrow.key); }}>{box.text}</button>}
      {selected && editable && <button type="button" className="fm-arrow-insert nodrag nopan" style={{ transform: `translate(${insertAt.x - 11}px, ${insertAt.y - 11}px)` }}
        aria-label="이 화살표 사이에 단계 넣기" title="사이에 단계 넣기" onClick={(event) => { event.stopPropagation(); data.onInsert(arrow.key); }}>
        <FlowIcon name="plus" size={12} />
      </button>}
    </EdgeLabelRenderer>}
  </g>;
});
