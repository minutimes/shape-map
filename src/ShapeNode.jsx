import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

export function ShapeIcon({ name, size = 18, ...props }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    branch: <><rect x="3" y="9" width="6" height="6" rx="1" /><path d="M9 12h4V5h3m-3 7v7h3" /><path d="M16 3h5v4h-5zm0 14h5v4h-5z" /></>,
    box: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9" /></>,
    comment: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    expand: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    history: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6m3-4v6l4 2" /></>,
    code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" />,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    back: <path d="M19 12H5m6-6-6 6 6 6" />,
    play: <path d="m8 4 12 8-12 8V4Z" />,
    pause: <><path d="M8 4v16M16 4v16" /></>,
    copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></>,
    alert: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3h.01" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    minus: <path d="M5 12h14" />,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 8a2.6 2.6 0 0 1 5 1c0 2-2.5 2-2.5 4m0 3h.01" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.box}</svg>;
}

export const SHAPE_STATES = {
  neutral: { label: '현재 기능', short: '현재', icon: 'box' },
  planned: { label: '수정 대상', short: '수정 대상', icon: 'arrow' },
  verified: { label: '사람 검수 완료', short: '검수 완료', icon: 'check' },
  changed: { label: '직전 턴 개선', short: '직전 개선', icon: 'history' },
  concern: { label: '검토 필요', short: '검토 필요', icon: 'alert' },
};

export function StateBadge({ status = 'neutral', compact = false }) {
  const state = SHAPE_STATES[status] || SHAPE_STATES.neutral;
  return <span className={`sm-state sm-state--${status}`}><span className="sm-state__dot" />{compact ? state.short : state.label}</span>;
}

export const ShapeBlock = memo(function ShapeBlock({ data, selected }) {
  const { node, state, mode, childCount } = data;
  const description = mode === 'product' ? node.task?.ui || node.task?.outputs || node.block?.summary || node.task?.logic
    : node.block?.summary || node.task?.logic;
  return <div className={`sm-block sm-block--${state.status}${selected ? ' is-selected' : ''}`} data-testid={`shape-block-${node.id}`}>
    <Handle type="target" position={Position.Left} className="sm-handle" />
    <div className="sm-block__top"><StateBadge status={state.status} compact />
      {state.commentCount > 0 && <span className="sm-block__comments" aria-label={`의견 ${state.commentCount}개`}><ShapeIcon name="comment" size={12} />{state.commentCount}</span>}
    </div>
    <button className="sm-block__title nodrag" onClick={(event) => { event.stopPropagation(); data.onOpen(node.id); }}>{node.label}</button>
    {description && <p className="sm-block__description">{description}</p>}
    {childCount > 0 && <button className="sm-block__deeper nodrag" aria-label={`${node.label} 내부 ${childCount}개 보기`} onClick={(event) => { event.stopPropagation(); data.onFocus(node.id); }}><span>내부 {childCount}개</span><ShapeIcon name="chevron" size={11} /></button>}
    <Handle type="source" position={data.verticalHierarchy ? Position.Left : Position.Right} className="sm-handle" />
  </div>;
});

export const ShapeGroup = memo(function ShapeGroup({ data, selected }) {
  const { node, state, index, childCount } = data;
  return <div className={`sm-group${selected ? ' is-selected' : ''}`} data-testid={`shape-group-${node.id}`}>
    <div className="sm-group__header"><span className="sm-group__index">{String(index).padStart(2, '0')}</span>
      <button className="sm-group__title nodrag" onClick={(event) => { event.stopPropagation(); data.onOpen(node.id); }}>{node.label}</button>
      <StateBadge status={state.status} compact />
      {childCount > 0 && <button className="sm-icon-button sm-group__focus nodrag" aria-label={`${node.label} 안으로 들어가기`} onClick={(event) => { event.stopPropagation(); data.onFocus(node.id); }}><ShapeIcon name="expand" size={14} /></button>}
    </div>
    {node.block?.summary || node.task?.logic ? <p className="sm-group__description">{node.block?.summary || node.task.logic}</p> : null}
    {!childCount && <p className="sm-group__empty">이 기능을 눌러 설명과 의견을 남겨 보세요.</p>}
  </div>;
});
