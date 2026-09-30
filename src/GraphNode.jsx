import { memo, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position, useStore } from '@xyflow/react';
import { SelectionCountContext } from './SelectionContext.js';
import {
  NODE_MAX_HEIGHT,
  NODE_MAX_WIDTH,
  NODE_MIN_HEIGHT,
  NODE_MIN_WIDTH,
} from './layout.js';

const RESIZE_LINES = ['top', 'right', 'bottom', 'left'];
const RESIZE_HANDLES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function GraphNode({ id, data, selected }) {
  const selectionCount = useContext(SelectionCountContext);
  const zoom = useStore((state) => state.transform[2]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.label);
  const finishingRef = useRef(false);
  const editorRef = useRef(null);
  const nodeRef = useRef(null);
  const resizeSessionRef = useRef(null);

  useEffect(() => setDraft(data.label), [data.label]);

  useEffect(() => {
    if (!data.editing) return;
    finishingRef.current = false;
    setDraft('');
    setEditing(true);
  }, [data.editing]);

  useLayoutEffect(() => {
    if (!editing || !editorRef.current) return;
    editorRef.current.style.height = '0px';
    editorRef.current.style.height = `${editorRef.current.scrollHeight + 2}px`;
  }, [draft, editing]);

  function finishEdit() {
    if (finishingRef.current) return;
    finishingRef.current = true;
    const label = draft.replace(/\s+/g, ' ').trim();
    setEditing(false);
    if (label && label !== data.label) data.onRename(id, label);
    else setDraft(data.label);
    data.onEditingComplete(id);
  }

  function startResize(event, control) {
    if (event.button !== 0 || !nodeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const nodeElement = nodeRef.current;
    const width = nodeElement.offsetWidth;
    const height = nodeElement.offsetHeight;
    resizeSessionRef.current = {
      pointerId: event.pointerId,
      control,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      width,
      height,
      x: data.canvasPosition.x,
      y: data.canvasPosition.y,
      changed: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    nodeElement.classList.add('is-resizing');
    nodeElement.style.setProperty('--node-line-clamp', Math.max(1, Math.floor((height - 62) / 20)));
    data.onResizeStart(id);
  }

  function continueResize(event) {
    const session = resizeSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();

    const deltaX = (event.clientX - session.lastClientX) / zoom;
    const deltaY = (event.clientY - session.lastClientY) / zoom;
    session.lastClientX = event.clientX;
    session.lastClientY = event.clientY;

    const previousWidth = session.width;
    const previousHeight = session.height;
    if (session.control.includes('left')) {
      session.width = clamp(previousWidth - deltaX, NODE_MIN_WIDTH, NODE_MAX_WIDTH);
      session.x += previousWidth - session.width;
    } else if (session.control.includes('right')) {
      session.width = clamp(previousWidth + deltaX, NODE_MIN_WIDTH, NODE_MAX_WIDTH);
    }
    if (session.control.includes('top')) {
      session.height = clamp(previousHeight - deltaY, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT);
      session.y += previousHeight - session.height;
    } else if (session.control.includes('bottom')) {
      session.height = clamp(previousHeight + deltaY, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT);
    }

    if (session.width === previousWidth && session.height === previousHeight) return;
    session.changed = true;
    nodeRef.current?.style.setProperty(
      '--node-line-clamp',
      Math.max(1, Math.floor((session.height - 62) / 20)),
    );
    data.onResize(id, {
      width: session.width,
      height: session.height,
      x: session.x,
      y: session.y,
    });
  }

  async function finishResize(event) {
    const session = resizeSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeSessionRef.current = null;
    if (!session.changed) {
      data.onResizeCancel(id);
      nodeRef.current?.classList.remove('is-resizing');
      return;
    }
    try {
      await data.onResizeEnd(id, {
        width: session.width,
        height: session.height,
        x: session.x,
        y: session.y,
      });
    } finally {
      nodeRef.current?.classList.remove('is-resizing');
    }
  }

  const style = {
    '--node-fill': data.category.fill,
    '--node-stroke': data.category.stroke,
    '--node-text': data.category.textColor,
    '--node-stroke-width': `${data.category.strokeWidth}px`,
    '--node-line-clamp': Math.max(1, Math.floor((data.layout.height - 62) / 20)),
  };

  return (
    <div
      ref={nodeRef}
      className={`map-node map-node--${data.shape} map-node--category-${data.category.id} map-node--layout-${data.layout.mode}${selected ? ' is-selected' : ''}${selected && selectionCount === 1 && !editing ? ' is-resizable' : ''}${data.cut ? ' is-cut' : ''}${editing ? ' is-editing' : ''}${data.dropTarget ? ' is-drop-target' : ''}`}
      style={style}
      data-testid={`node-${id}`}
      data-depth={data.depth}
      tabIndex={0}
      role="treeitem"
      aria-level={data.depth + 1}
      aria-label={`${data.label}, ${data.depth === 0 ? '중심' : `${data.depth}단계`}, ${data.category.label}`}
      onDoubleClick={(event) => {
        event.stopPropagation();
        finishingRef.current = false;
        setDraft(data.label);
        setEditing(true);
      }}
    >
      {data.dropTarget && (
        <span className="map-node__drop-label" role="status" data-testid={`drop-target-${id}`}>
          {data.dropTargetCount > 1
            ? `선택한 ${data.dropTargetCount}개를 하위로 넣기`
            : '이 항목의 하위로 넣기'}
        </span>
      )}
      {selected && selectionCount === 1 && !editing && (
        <>
          {RESIZE_LINES.map((control) => (
            <div
              key={control}
              className={`map-node__resize-line map-node__resize-line--${control} ${control} nodrag nopan`}
              data-resize-control={control}
              onPointerDown={(event) => startResize(event, control)}
              onPointerMove={continueResize}
              onPointerUp={finishResize}
              onPointerCancel={finishResize}
            />
          ))}
          {RESIZE_HANDLES.map((control) => (
            <div
              key={control}
              className={`map-node__resize-handle ${control.replace('-', ' ')} nodrag nopan`}
              data-resize-control={control}
              style={{ '--resize-control-scale': Math.max(1 / zoom, 1) }}
              onPointerDown={(event) => startResize(event, control)}
              onPointerMove={continueResize}
              onPointerUp={finishResize}
              onPointerCancel={finishResize}
            />
          ))}
        </>
      )}
      <Handle type="target" position={Position.Left} className="map-node__handle" />
      {!editing && (
        <button
          type="button"
          className="map-node__key-copy nodrag nopan"
          aria-label={`${data.label} 키 복사`}
          title={`키 복사: ${id}`}
          data-testid={`copy-key-${id}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            data.onCopyKey(id);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Zm6 0V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
          </svg>
        </button>
      )}
      <div className="map-node__content">
        {editing ? (
          <textarea
            ref={editorRef}
            autoFocus
            rows={1}
            aria-label={`${data.label} 이름 바꾸기`}
            className="map-node__inline-input nodrag"
            data-testid="inline-rename-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={finishEdit}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                finishEdit();
              }
              if (event.key === 'Escape') {
                finishingRef.current = true;
                setDraft(data.label);
                setEditing(false);
                data.onEditingComplete(id);
              }
            }}
          />
        ) : (
          <span className="map-node__label">{data.label}</span>
        )}
        <span className="map-node__meta">
          <span>{data.depth === 0 ? '중심' : `${data.depth}단계`}</span>
          <span>{data.category.label}</span>
        </span>
      </div>
      {data.childCount > 0 && (
        <button
          type="button"
          className="map-node__fold nodrag"
          aria-label={`${data.label} 하위 항목 ${data.collapsed ? '펼치기' : '접기'}`}
          aria-expanded={!data.collapsed}
          data-testid={`toggle-${id}`}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggleCollapse(id);
          }}
        >
          <span aria-hidden="true">{data.collapsed ? '+' : '−'}</span>
          <span>{data.childCount}</span>
        </button>
      )}
      <Handle type="source" position={Position.Right} className="map-node__handle" />
    </div>
  );
}

export default memo(GraphNode);
