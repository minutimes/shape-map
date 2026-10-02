import { useEffect, useId, useRef, useState } from 'react';
import { ShapeIcon } from './ShapeNode.jsx';
import { readOnlyReason } from './mapKinds.js';

let mermaidLoader;
function loadMermaid() {
  // Mermaid is large; it loads only when a map is shown read-only.
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard', sans-serif", flowchart: { htmlLabels: false } });
    return mermaid;
  });
  return mermaidLoader;
}

/** A map Shape map cannot edit: drawn by Mermaid, with the reason and its source. */
export default function ReadOnlyMap({ api, entry, title }) {
  const [snapshot, setSnapshot] = useState(null);
  const [svg, setSvg] = useState(null);
  const [drawError, setDrawError] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const renderId = `sm-readonly-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const lineRef = useRef(null);
  const diagramRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    api.readMap(controller.signal).then(setSnapshot).catch(() => {});
    const events = new EventSource(api.eventsUrl);
    const install = (event) => {
      const payload = JSON.parse(event.data);
      setSnapshot(payload.snapshot || payload);
    };
    events.addEventListener('snapshot', install);
    events.addEventListener('source-error', install);
    return () => { controller.abort(); events.close(); };
  }, [api]);

  const source = snapshot?.source ?? '';
  useEffect(() => {
    if (!source) return undefined;
    let cancelled = false;
    setDrawError(false);
    loadMermaid()
      .then((mermaid) => mermaid.render(renderId, source))
      .then((result) => {
        if (cancelled) return;
        // Start at natural size, shrinking to fit the width while text stays readable.
        const width = Number(result.svg.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) /)?.[1]) || 800;
        const room = (diagramRef.current?.clientWidth || 800) - 84;
        setZoom(Math.max(0.6, Math.min(1, room / width)));
        setSvg({ markup: result.svg, width });
      })
      .catch(() => {
        document.getElementById(renderId)?.remove();
        document.getElementById(`d${renderId}`)?.remove();
        if (!cancelled) { setSvg(null); setDrawError(true); setSourceOpen(true); }
      });
    return () => { cancelled = true; };
  }, [source, renderId]);

  const status = snapshot?.editable === false ? snapshot : entry;
  const reason = readOnlyReason(status);
  const lines = source ? source.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n') : [];
  useEffect(() => {
    if (sourceOpen) lineRef.current?.scrollIntoView({ block: 'center' });
  }, [sourceOpen, reason.line]);

  return <section className="sm-readonly" aria-label={title || entry?.title || '보기 전용 지도'}>
    <div className="sm-readonly__bar">
      <span className="sm-readonly__badge"><ShapeIcon name="alert" size={12} />보기 전용</span>
      {title && <strong className="sm-readonly__title">{title}</strong>}
      <p className="sm-readonly__reason">{reason.text}</p>
      <div className="sm-readonly__actions">
        {svg && !sourceOpen && <span className="sm-readonly__zoom"><button className="sm-icon-button" aria-label="그림 축소" onClick={() => setZoom((value) => Math.max(0.4, value - 0.2))}><ShapeIcon name="minus" size={13} /></button><button className="sm-icon-button" aria-label="그림 확대" onClick={() => setZoom((value) => Math.min(2.4, value + 0.2))}><ShapeIcon name="plus" size={13} /></button></span>}
        <button className="sm-button sm-button--small" aria-pressed={sourceOpen} onClick={() => setSourceOpen(!sourceOpen)}><ShapeIcon name="code" size={13} />{sourceOpen ? '그림 보기' : '원본 보기'}</button>
      </div>
    </div>
    {sourceOpen
      ? <div className="sm-readonly__source" role="region" aria-label="원본 글">
        {drawError && <p className="sm-readonly__note">그림으로 그리지 못했어요. 원본 글을 보여 드려요.</p>}
        <ol>{lines.map((text, index) => <li key={index} ref={index + 1 === reason.line ? lineRef : undefined} className={index + 1 === reason.line ? 'is-error' : undefined}><span>{index + 1}</span><code>{text || ' '}</code></li>)}</ol>
      </div>
      : <div className="sm-readonly__diagram" ref={diagramRef}>
        {svg ? <div className="sm-readonly__svg" style={{ width: Math.round(svg.width * zoom) + 36 }} dangerouslySetInnerHTML={{ __html: svg.markup }} />
          : <p className="sm-readonly__note">{snapshot ? '그림을 그리고 있어요.' : '지도를 불러오고 있어요.'}</p>}
      </div>}
  </section>;
}
