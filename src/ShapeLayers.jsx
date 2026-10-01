import { useMemo } from 'react';
import { ShapeIcon } from './ShapeNode.jsx';

export default function ShapeLayers({ graph, rootId, states, collapsedIds, selectedIds, onToggle, onSelect, onFocus, onMenu, search }) {
  const children = useMemo(() => {
    const result = new Map(graph.nodes.map((node) => [node.id, []]));
    graph.nodes.forEach((node) => { if (node.section !== 'reference') result.get(node.parentId)?.push(node); }); return result;
  }, [graph.nodes]);
  const query = search.trim().toLowerCase();
  const matches = (node) => `${node.label} ${node.id} ${node.block?.summary || ''}`.toLowerCase().includes(query);
  const allowed = new Set();
  if (query) graph.nodes.filter(matches).forEach((node) => { let cursor = node; while (cursor) { allowed.add(cursor.id); cursor = graph.nodes.find((item) => item.id === cursor.parentId); } });
  const collapsed = new Set(collapsedIds);
  const render = (node, depth) => {
    if (query && !allowed.has(node.id)) return null;
    const parts = children.get(node.id) || []; const open = query || !collapsed.has(node.id);
    return <li key={node.id} role="treeitem" aria-expanded={parts.length ? Boolean(open) : undefined} aria-selected={selectedIds.includes(node.id)}>
      <div className={`sm-layer-row${selectedIds.includes(node.id) ? ' is-selected' : ''}`} style={{ '--layer-depth': depth }} onContextMenu={(event) => onMenu(event, node.id)}>
        <button className="sm-layer-fold" aria-label={`${node.label} ${open ? '레이어 접기' : '레이어 펼치기'}`} disabled={!parts.length} onClick={() => onToggle(node.id)}><ShapeIcon name={open ? 'minus' : 'chevron'} size={11} /></button>
        <button className="sm-layer-name" title={`${node.label} · ${node.id}`} onClick={() => onSelect(node.id)} onDoubleClick={() => onFocus(node.id)}><ShapeIcon name={parts.length || node.workflow ? 'grid' : 'box'} size={13} /><span>{node.label}</span><i className={`sm-outline-dot sm-outline-dot--${states[node.id]?.status}`} />{parts.length > 0 && <small>{parts.length}</small>}</button>
      </div>
      {parts.length > 0 && open && <ul role="group">{parts.map((child) => render(child, depth + 1))}</ul>}
    </li>;
  };
  return <ul className="sm-layer-tree" role="tree" aria-label="기능 레이어">{(children.get(rootId) || []).map((node) => render(node, 0))}</ul>;
}
