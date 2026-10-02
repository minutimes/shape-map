import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import ProjectShell from './ProjectShell.jsx';
import { createMapApi } from './api.js';

const DetailEditor = lazy(() => import('./App.jsx'));
const params = new URLSearchParams(window.location.search);
const binding = params.get('project') && params.get('map') ? { project: params.get('project'), map: params.get('map') } : null;
const loading = <div className="sm-loading">지도를 펼치고 있습니다.</div>;

/** The detailed hierarchy editor opens only editable feature maps. */
function DetailEditorFor({ api }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    api.readMap().then((snapshot) => {
      if (snapshot.kind === 'features' && snapshot.editable) setReady(true);
      else window.location.replace(api.workspaceHref);
    }).catch(() => window.location.replace(api.workspaceHref));
  }, [api]);
  return ready ? <DetailEditor api={api} /> : loading;
}

const editor = params.get('editor') === '1';
const root = editor ? (binding ? <DetailEditorFor api={createMapApi(binding)} /> : <DetailEditor />) : <ProjectShell />;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ReactFlowProvider>
      <Suspense fallback={loading}>{root}</Suspense>
    </ReactFlowProvider>
  </StrictMode>,
);
