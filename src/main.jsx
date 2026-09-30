import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import ShapeWorkspace from './ShapeWorkspace.jsx';

const DetailEditor = lazy(() => import('./App.jsx'));
const Editor = new URLSearchParams(window.location.search).get('editor') === '1' ? DetailEditor : ShapeWorkspace;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ReactFlowProvider>
      <Suspense fallback={<div className="sm-loading">지도를 펼치고 있습니다.</div>}><Editor /></Suspense>
    </ReactFlowProvider>
  </StrictMode>,
);
