import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import FlowWorkspace from '../../src/flow/FlowWorkspace.jsx';
import { createFakeFlowApi } from './fakeApi.js';
import { FIXTURES } from './fixtures.js';

const params = new URLSearchParams(window.location.search);
const name = FIXTURES[params.get('fixture')] ? params.get('fixture') : 'lending';
const fixture = FIXTURES[name];
const harness = createFakeFlowApi(fixture.source, { latency: Number(params.get('latency') ?? 80), mapPath: `docs/maps/${fixture.map.file}`, ...(fixture.options || {}) });
window.__flowHarness = harness;

function Shell() {
  const map = useMemo(() => ({ ...fixture.map, title: fixture.map.file.replace(/\.mmd$/, '') }), []);
  return <div className="harness-shell">
    <nav className="harness-tabs" aria-label="개발용 탭 자리">
      <strong>개발용 화면</strong>
      {Object.keys(FIXTURES).map((key) => <a key={key} href={`?fixture=${key}`} aria-current={key === name ? 'page' : undefined}>{key}</a>)}
    </nav>
    <div className="harness-frame"><FlowWorkspace api={harness.api} map={map} /></div>
  </div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><Shell /></StrictMode>);
