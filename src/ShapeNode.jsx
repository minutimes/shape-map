import { memo, useCallback, useRef } from 'react';
import { Handle, Position, NodeResizer, useViewport } from '@xyflow/react';

export function ShapeIcon({ name, size = 18, ...props }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    branch: <><rect x="3" y="9" width="6" height="6" rx="1" /><path d="M9 12h4V5h3m-3 7v7h3" /><path d="M16 3h5v4h-5zm0 14h5v4h-5z" /></>,
    box: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9" /></>,
    comment: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    expand: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /></>,
    screen: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M13 8h4v4m0-4-6 6" /></>,
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
    undo: <path d="M9 5 4 10l5 5m-5-5h10a6 6 0 0 1 0 12" />,
    redo: <path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12" />,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
    pencil: <><path d="m15 4 5 5M4 20l5-1L21 7a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" /></>,
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

const executorLabel = { code: '코드', perception: '음성·문자 인식', llm: '추론·생성 모델', jev: '구조화 판단 모델', human: '사람' };
function Ports({ vertical = false }) {
  const { zoom } = useViewport();
  return <div style={{ '--sm-port-hit': `${Math.min(48, 24 / zoom)}px`, '--sm-port-dot': `${Math.min(12, 7 / zoom)}px` }}><Handle id="in" type="source" position={Position.Left} className="sm-handle" />
    <Handle id="out" type="source" position={vertical ? Position.Left : Position.Right} className="sm-handle" />
    <Handle id="top" type="source" position={Position.Top} className="sm-handle" />
    <Handle id="bottom" type="source" position={Position.Bottom} className="sm-handle" />
    <Handle id="left-source" type="source" position={Position.Left} className="sm-handle sm-handle-alias" isConnectable={false} />
    <Handle id="right-target" type="target" position={Position.Right} className="sm-handle sm-handle-alias" isConnectable={false} />
    <Handle id="top-source" type="source" position={Position.Top} className="sm-handle sm-handle-alias" isConnectable={false} />
    <Handle id="bottom-target" type="target" position={Position.Bottom} className="sm-handle sm-handle-alias" isConnectable={false} /></div>;
}

function EditButton({ data }) {
  return <button className="sm-icon-button sm-node-edit nodrag nopan" aria-label={`${data.node.label} 상세 수정`} title="설명·메모·수정안" onClick={(event) => { event.stopPropagation(); data.onOpen(data.node.id); }}><ShapeIcon name="pencil" size={14} /></button>;
}

function FeatureHints({ node, reading }) {
  return <span className="sm-feature-hints">{node.task?.executor && <span title={[node.task.executor.model, node.task.executor.effort].filter(Boolean).join(' / ')}>{executorLabel[node.task.executor.kind]}</span>}
    {reading?.custom && <span>형식별 로직</span>}{reading?.pending && <span>설계·미연결</span>}{node.task?.condition && <span title={node.task.condition}>조건 있음</span>}</span>;
}

export const ShapeBlock = memo(function ShapeBlock({ data, selected }) {
  const { node, state, mode, childCount } = data;
  const description = mode === 'product' ? node.task?.ui || node.task?.outputs || node.block?.summary || node.task?.logic
    : node.block?.summary || node.task?.logic;
  return <div className={`sm-block sm-block--${state.status}${data.architecture ? ' sm-architecture' : ''}${selected ? ' is-selected' : ''}`} data-testid={`shape-block-${node.id}`}>
    <Ports vertical={data.verticalHierarchy} />
    <div className="sm-block__top"><StateBadge status={state.status} compact />
      {state.commentCount > 0 && <span className="sm-block__comments" aria-label={`의견 ${state.commentCount}개`}><ShapeIcon name="comment" size={12} />{state.commentCount}</span>}
      <FeatureHints node={node} reading={data.reading} />
      <span className="sm-node-actions"><EditButton data={data} /></span>
    </div>
    <button className="sm-block__title" aria-label={node.label} title={node.label} aria-expanded={childCount ? !data.collapsed : undefined} onClick={(event) => { if (event.shiftKey || event.ctrlKey || event.metaKey) return; event.stopPropagation(); data.onActivate(node.id); }}>{data.title || node.label}</button>
    {description && !data.architecture && <p className="sm-block__description">{description}</p>}
    {childCount > 0 && <button className="sm-block__deeper nodrag" aria-label={`${node.label} 내부 ${childCount}개 보기`} onClick={(event) => { event.stopPropagation(); data.onFocus(node.id); }}><span>내부 {childCount}개</span><ShapeIcon name="chevron" size={11} /></button>}
  </div>;
});

export const ShapeGroup = memo(function ShapeGroup({ data, selected }) {
  const { node, state, index, childCount } = data;
  const resize = useRef(data.onResize); resize.current = data.onResize;
  // Stable listeners keep React Flow's active resize gesture alive while the
  // controlled node dimensions update on every pointer movement.
  const startResize = useCallback((_event, params) => resize.current?.(node.id, params, 'start'), [node.id]);
  const finishResize = useCallback((_event, params) => resize.current?.(node.id, params, 'end'), [node.id]);
  return <div className={`sm-group sm-group--${state.status} sm-group--depth-${data.depth || 0}${data.architecture ? ' sm-architecture' : ''}${selected ? ' is-selected' : ''}${data.collapsed ? ' is-collapsed' : ''}`} data-testid={`shape-group-${node.id}`}>
    {data.onResize && <NodeResizer isVisible={selected} minWidth={data.minimumWidth || 340} minHeight={data.minimumHeight || 100} onResizeStart={startResize} onResizeEnd={finishResize} />}
    <Ports />
    <div className="sm-group__header"><span className="sm-group__index">{data.depth ? `내부 ${childCount}개` : String(index).padStart(2, '0')}</span><StateBadge status={state.status} compact />{data.collapsed && !data.depth && <span className="sm-group__part-count">세부 영역 {childCount}개</span>}<FeatureHints node={node} reading={data.reading} />
      <span className="sm-node-actions"><EditButton data={data} />{childCount > 0 && <button className="sm-icon-button sm-group__fold nodrag" aria-label={`${node.label} ${data.collapsed ? '내부 펼치기' : '내부 접기'}`} aria-expanded={!data.collapsed} onClick={(event) => { event.stopPropagation(); data.onToggle(node.id); }}><ShapeIcon name={data.collapsed ? 'plus' : 'minus'} size={14} /></button>}
      <button className="sm-icon-button sm-group__focus nodrag" aria-label={`${node.label} 안으로 들어가기`} onClick={(event) => { event.stopPropagation(); data.onFocus(node.id); }}><ShapeIcon name="expand" size={14} /></button>
      </span>
    </div><button className="sm-group__title" aria-label={node.label} title={node.label} aria-expanded={childCount ? !data.collapsed : undefined} onClick={(event) => { if (event.shiftKey || event.ctrlKey || event.metaKey) return; event.stopPropagation(); data.onActivate(node.id); }}>{data.title || node.label}</button>
    {data.showDescription && (node.block?.summary || node.task?.logic) ? <p className="sm-group__description">{node.block?.summary || node.task.logic}</p> : null}
    {!childCount && <p className="sm-group__empty">연필을 눌러 설명과 의견을 남겨 보세요.</p>}
  </div>;
});
