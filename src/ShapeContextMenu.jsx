import { useLayoutEffect, useRef, useState } from 'react';
import { ShapeIcon } from './ShapeNode.jsx';

export default function ShapeContextMenu({ menu, items, onClose }) {
  const ref = useRef(null); const [position, setPosition] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => { const rect = ref.current.getBoundingClientRect(); setPosition({ x: Math.max(8, Math.min(menu.x, innerWidth - rect.width - 8)), y: Math.max(8, Math.min(menu.y, innerHeight - rect.height - 8)) }); ref.current.querySelector('button:not(:disabled)')?.focus(); }, [menu]);
  return <div className="sm-context-cover" onPointerDown={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }}>
    <div ref={ref} className="sm-context-menu" role="menu" aria-label="캔버스 편집" style={{ left: position.x, top: position.y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')]; const index = buttons.indexOf(document.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    }}>{items.map((item, index) => item.separator ? <hr key={index} /> : <button key={item.label} role="menuitem" disabled={item.disabled} className={item.danger ? 'is-danger' : ''} onClick={() => { onClose(); item.action(); }}><ShapeIcon name={item.icon || 'box'} size={14} /><span>{item.label}</span>{item.key && <kbd>{item.key}</kbd>}</button>)}</div>
  </div>;
}
