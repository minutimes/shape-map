import { useEffect, useState } from 'react';

/*
 * Placeholder for the flow map canvas (유저 플로우, 시스템 플로우).
 * The real editor replaces this file and keeps the same contract:
 *   props.api = { readMap(signal), mutateMap({ baseRevision, clientId, operation }), eventsUrl }
 *   props.map = { project, file, kind, title, description, editable }
 * It fills its parent box.
 */
export default function FlowWorkspace({ api, map }) {
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    api.readMap(controller.signal).then(setSnapshot).catch(() => {});
    const events = new EventSource(api.eventsUrl);
    events.addEventListener('snapshot', (event) => setSnapshot(JSON.parse(event.data)));
    return () => { controller.abort(); events.close(); };
  }, [api]);
  const graph = snapshot?.graph;
  return <section aria-label={map.title} style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: '#77777f', fontSize: 12, background: '#fbfbfc' }}>
    <p style={{ margin: 0, textAlign: 'center', lineHeight: 1.8 }}>
      {graph ? `참여자 줄 ${graph.lanes.length}개 · 단계 ${graph.steps.length}개 · 연결 ${graph.arrows.length}개` : '흐름을 불러오고 있어요.'}
      <br />흐름 편집 화면을 준비하고 있어요.
    </p>
  </section>;
}
