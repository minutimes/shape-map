import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import ShapeWorkspace from './ShapeWorkspace.jsx';
import { ShapeIcon } from './ShapeNode.jsx';
import { createMapApi, readJson } from './api.js';
import { FLOW_MAP_KINDS, MAP_KIND_ORDER, mapKindLabel } from './mapKinds.js';
import './shapeWorkspace.css';
import './projectShell.css';

const FlowWorkspace = lazy(() => import('./flow/FlowWorkspace.jsx'));
const ReadOnlyMap = lazy(() => import('./ReadOnlyMap.jsx'));

function readRoute() {
  const params = new URLSearchParams(window.location.search);
  return { project: params.get('project') || null, map: params.get('map') || null };
}

function routeUrl({ project, map }) {
  const params = new URLSearchParams();
  if (project) params.set('project', project);
  if (project && map) params.set('map', map);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

const Loading = ({ text = '지도를 펼치고 있어요.' }) => <div className="sm-shell-loading" role="status">{text}</div>;

/**
 * Opens the project list when a workspace is configured, and the single
 * configured map otherwise. URL state is ?project=KEY&map=FILE.
 */
export default function ProjectShell() {
  const [workspace, setWorkspace] = useState(null);
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    let cancelled = false;
    readJson('/api/projects')
      .then((body) => { if (!cancelled) setWorkspace(body.workspace ? { projects: body.projects } : false); })
      .catch(() => { if (!cancelled) setWorkspace('offline'); });
    const onPop = () => setRoute(readRoute());
    window.addEventListener('popstate', onPop);
    return () => { cancelled = true; window.removeEventListener('popstate', onPop); };
  }, []);

  const navigate = useCallback((next, { replace = false } = {}) => {
    const url = routeUrl(next);
    if (`${window.location.pathname}${window.location.search}` !== url) window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    setRoute({ project: next.project || null, map: next.map || null });
  }, []);

  if (workspace === false) return <ShapeWorkspace />;
  if (workspace === null) return <main className="sm-shell"><Loading /></main>;
  if (workspace === 'offline') {
    return <main className="sm-shell"><div className="sm-shell-loading" role="alert">Shape map에 연결하지 못했어요.<button className="sm-button" onClick={() => window.location.reload()}>다시 연결</button></div></main>;
  }
  if (!route.project) return <ProjectHome initial={workspace.projects} onOpen={(project) => navigate({ project })} />;
  return <ProjectView key={route.project} projectKey={route.project} mapFile={route.map} navigate={navigate} />;
}

function ProjectHome({ initial, onOpen }) {
  const [projects, setProjects] = useState(initial);
  useEffect(() => {
    document.title = 'Shape map';
    const refresh = () => { if (document.visibilityState === 'visible') readJson('/api/projects').then((body) => body.workspace && setProjects(body.projects)).catch(() => {}); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return <main className="sm-home">
    <header className="sm-home__bar"><span className="sm-logo" /><span className="sm-home__brand">shape map<span className="sm-brand__dot">.</span></span></header>
    <section className="sm-home__body" aria-labelledby="sm-home-title">
      <h1 id="sm-home-title">프로젝트</h1>
      <p className="sm-home__lead">지도를 볼 제품을 고르세요.</p>
      {projects.length ? <ul className="sm-project-list">
        {projects.map((project, index) => {
          const nested = project.worktree && projects[index - 1]?.name === project.name;
          return <li key={project.key} className={`${project.mapCount ? '' : 'is-quiet'}${nested ? ' is-nested' : ''}`}>
            <button onClick={() => onOpen(project.key)}>
              <span className="sm-project-glyph" aria-hidden="true">{nested ? <ShapeIcon name="branch" size={14} /> : <ShapeIcon name="grid" size={14} />}</span>
              <span className="sm-project-text">
                <span className="sm-project-line"><strong>{project.name}</strong>{project.worktree && project.branch && <span className="sm-branch" title="작업 갈래">{project.branch}</span>}</span>
                <small>{project.mapCount ? `지도 ${project.mapCount}개` : '아직 지도가 없어요 · docs/maps 폴더에 .mmd 파일을 두면 보여요'}</small>
              </span>
              <ShapeIcon name="arrow" size={13} className="sm-project-go" />
            </button>
          </li>;
        })}
      </ul> : <p className="sm-home__empty">작업 폴더에 프로젝트가 없어요.</p>}
    </section>
  </main>;
}

function ProjectView({ projectKey, mapFile, navigate }) {
  const [state, setState] = useState({ status: 'loading', project: null, maps: [] });
  const lastByKind = useRef({});
  const editableLatch = useRef({ key: null, editable: false });

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ project: projectKey }).toString();
    readJson(`/api/project?${query}`, controller.signal)
      .then((body) => setState({ status: 'ready', project: body.project, maps: body.maps }))
      .catch((error) => { if (error.name !== 'AbortError') setState({ status: error.status === 404 ? 'missing' : 'offline', project: null, maps: [] }); });
    const events = new EventSource(`/api/project/events?${query}`);
    events.addEventListener('maps', (event) => {
      const maps = JSON.parse(event.data);
      setState((current) => current.project ? { ...current, status: 'ready', maps } : current);
    });
    return () => { controller.abort(); events.close(); };
  }, [projectKey]);

  const groups = useMemo(() => MAP_KIND_ORDER
    .map((kind) => ({ kind, maps: state.maps.filter((map) => (MAP_KIND_ORDER.includes(map.kind) ? map.kind : 'other') === kind) }))
    .filter((group) => group.maps.length), [state.maps]);
  const current = state.maps.find((map) => map.file === mapFile) || null;

  // Without a map in the URL, open the first map; the URL keeps the choice.
  useEffect(() => {
    if (state.status === 'ready' && !mapFile && groups.length) navigate({ project: projectKey, map: groups[0].maps[0].file }, { replace: true });
  }, [state.status, mapFile, groups, projectKey, navigate]);

  const activeKind = current ? (MAP_KIND_ORDER.includes(current.kind) ? current.kind : 'other') : null;
  if (current) lastByKind.current[activeKind] = current.file;
  const activeGroup = groups.find((group) => group.kind === activeKind);
  const showChips = (activeGroup?.maps.length || 0) > 1;

  // A map that breaks while open keeps its editor, which shows the last valid
  // version; only reopening it shows the read-only view.
  const mapKey = current ? `${current.file}\u0000${current.kind}` : null;
  if (editableLatch.current.key !== mapKey) editableLatch.current = { key: mapKey, editable: Boolean(current?.editable) };
  else if (current?.editable) editableLatch.current.editable = true;
  const editable = editableLatch.current.editable;

  const api = useMemo(() => (mapFile ? createMapApi({ project: projectKey, map: mapFile }) : null), [projectKey, mapFile]);
  const flowApi = useMemo(() => api && { readMap: api.readMap, mutateMap: api.mutateMap, eventsUrl: api.eventsUrl }, [api]);
  const flowMap = useMemo(() => current && { project: projectKey, file: current.file, kind: current.kind, title: current.title,
    description: current.description, editable: current.editable }, [projectKey, current?.file, current?.kind, current?.title, current?.description, current?.editable]);

  const projectName = state.project?.name || projectKey;
  useEffect(() => { document.title = current ? `${current.title} · ${projectName}` : `${projectName} · Shape map`; }, [current?.title, projectName]);

  const openKind = (kind) => {
    const group = groups.find((item) => item.kind === kind);
    const remembered = group.maps.find((map) => map.file === lastByKind.current[kind]);
    navigate({ project: projectKey, map: (remembered || group.maps[0]).file });
  };

  let content;
  if (state.status === 'loading') content = <Loading />;
  else if (state.status === 'missing') content = <EmptyState title="이 프로젝트를 찾을 수 없어요." text="폴더가 옮겨졌거나 이름이 바뀌었을 수 있어요." action={<button className="sm-button" onClick={() => navigate({})}>프로젝트 목록</button>} />;
  else if (state.status === 'offline') content = <EmptyState title="프로젝트를 불러오지 못했어요." action={<button className="sm-button" onClick={() => window.location.reload()}>다시 연결</button>} />;
  else if (!state.maps.length) content = <EmptyState title="이 프로젝트에는 아직 지도가 없어요." text="docs/maps 폴더에 지도 파일(.mmd)을 두면 바로 여기에 보여요." />;
  else if (!current) content = mapFile ? <EmptyState title="이 지도를 찾을 수 없어요." text="파일이 옮겨지거나 지워졌을 수 있어요. 위에서 다른 지도를 골라 주세요." /> : <Loading />;
  else if (editable && current.kind === 'features') {
    content = <ShapeWorkspace key={mapKey} api={api} embedded title={showChips ? null : current.title} />;
  } else if (editable && FLOW_MAP_KINDS.includes(current.kind)) {
    content = <Suspense fallback={<Loading />}><FlowWorkspace key={mapKey} api={flowApi} map={flowMap} /></Suspense>;
  } else {
    content = <Suspense fallback={<Loading />}><ReadOnlyMap key={mapKey} api={api} entry={current} title={showChips ? null : current.title} /></Suspense>;
  }

  return <main className="sm-shell">
    <header className="sm-shellbar">
      <button className="sm-shell-home" onClick={() => navigate({})} aria-label="프로젝트 목록"><span className="sm-logo" /></button>
      <div className="sm-shell-project" title={projectKey}>
        <strong>{projectName}</strong>
        {state.project?.worktree && state.project.branch && <span className="sm-branch" title="작업 갈래">{state.project.branch}</span>}
      </div>
      {groups.length > 0 && <nav className="sm-shell-tabs" aria-label="지도 종류">
        {groups.map((group) => <button key={group.kind} aria-current={group.kind === activeKind ? 'page' : undefined} onClick={() => openKind(group.kind)}>
          {mapKindLabel(group.kind)}<span className="sm-shell-count">{group.maps.length}</span>
        </button>)}
      </nav>}
      {showChips && <nav className="sm-shell-chips" aria-label={`${mapKindLabel(activeKind)} 지도`}>
        {activeGroup.maps.map((map) => <button key={map.file} aria-current={map.file === current.file ? 'page' : undefined} title={map.description || map.title}
          onClick={() => navigate({ project: projectKey, map: map.file })}>{!map.editable && <span className="sm-chip-readonly" aria-label="보기 전용" />}{map.title}</button>)}
      </nav>}
    </header>
    <div className="sm-shell-content">
      <ReactFlowProvider key={mapKey || 'none'}>{content}</ReactFlowProvider>
    </div>
  </main>;
}

function EmptyState({ title, text, action }) {
  return <div className="sm-shell-empty"><strong>{title}</strong>{text && <p>{text}</p>}{action}</div>;
}
