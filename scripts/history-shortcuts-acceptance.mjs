import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(root, 'test-results', 'history-shortcuts');
const mapPath = path.join(evidenceDir, 'history-fixture.mmd');
let port;
let origin;
let server;
let browser;

function fixtureSource() {
  return `flowchart LR
  %% mlc-format: 1
  root(["전체 방향"])
  a(["A 가지"])
  a1["A 세부 1"]
  a2["A 세부 2"]
  b(["B 가지"])
  b1["B 세부 1"]
  c(["C 가지"])

  root --> a
  a --> a1
  a --> a2
  root --> b
  b --> b1
  root --> c

  classDef stage fill:#F2F6F3,stroke:#78958A,color:#17362E,stroke-width:1px
  class root,a,a1,a2,b,b1,c stage

  %% mlc-legend: stage|단계|삭제와 복구 검증
`;
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const selected = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return selected;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('History shortcut fixture server did not start.');
}

async function snapshot() {
  const response = await fetch(`${origin}/api/map`);
  if (!response.ok) throw new Error(`Snapshot read failed: ${response.status}.`);
  return response.json();
}

async function waitForSnapshot(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await snapshot();
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Snapshot did not settle: ${label}.`);
}

async function waitForEnabled(locator, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await locator.isEnabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not become enabled.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalGraph(graph) {
  return {
    direction: graph.direction,
    nodes: graph.nodes.map(({ id, label, parentId, shape, category }) => (
      { id, label, parentId, shape, category }
    )),
    categories: graph.categories.map(({
      id, label, description, fill, stroke, textColor, strokeWidth,
    }) => ({ id, label, description, fill, stroke, textColor, strokeWidth })),
  };
}

async function toolbarBounds(page, width) {
  await page.setViewportSize({ width, height: 820 });
  const buttons = await page.locator('.topbar button:visible').evaluateAll((elements) => elements.map((button) => {
    const rect = button.getBoundingClientRect();
    return {
      label: button.getAttribute('aria-label') || button.textContent.trim(),
      left: rect.left,
      right: rect.right,
      height: rect.height,
    };
  }));
  assert(buttons.every((button) => button.left >= 0 && button.right <= width && button.height >= 40),
    `${width}px toolbar clipping: ${JSON.stringify(buttons)}`);
  return buttons;
}

async function run() {
  await fs.rm(evidenceDir, { recursive: true, force: true });
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(mapPath, fixtureSource(), 'utf8');
  await fs.writeFile(mapPath.replace(/\.mmd$/, '.view.json'), `${JSON.stringify({
    positions: {
      root: { x: 40, y: 200 },
      a: { x: 340, y: 80 },
      a1: { x: 640, y: 30 },
      a2: { x: 640, y: 150 },
      b: { x: 340, y: 320 },
      b1: { x: 640, y: 320 },
      c: { x: 340, y: 520 },
    },
    collapsedIds: [], viewport: { x: 0, y: 0, zoom: 1 },
  }, null, 2)}\n`, 'utf8');

  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      FINAL_SHAPE_MAP_PORT: String(port),
      FINAL_SHAPE_MAP_DATA_ROOT: evidenceDir,
      FINAL_SHAPE_MAP_PATH: path.basename(mapPath),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();

  browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await context.addInitScript(() => localStorage.setItem('final-shape-map-workflow-mode', 'false'));
  const page = await context.newPage();
  await page.goto(`${origin}?editor=1`, { waitUntil: 'networkidle' });
  await page.getByTestId('node-root').waitFor();
  const original = await waitForSnapshot(
    (current) => current.graph.nodes.length === 7 && Object.keys(current.view.positions).length === 7,
    'initial positions',
  );

  const aBox = await page.getByTestId('node-a').boundingBox();
  const bBox = await page.getByTestId('node-b').boundingBox();
  assert(aBox && bBox, 'Branch bounds were unavailable for drag selection.');
  const start = {
    x: Math.min(aBox.x, bBox.x) - 12,
    y: Math.min(aBox.y, bBox.y) - 12,
  };
  const end = {
    x: Math.max(aBox.x + aBox.width, bBox.x + bBox.width) + 12,
    y: Math.max(aBox.y + aBox.height, bBox.y + bBox.height) + 12,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  const selectedIds = await page.locator('.react-flow__node.selected').evaluateAll(
    (nodes) => nodes.map((node) => node.dataset.id).sort(),
  );
  assert(JSON.stringify(selectedIds) === JSON.stringify(['a', 'b']),
    `Drag selection chose unexpected nodes: ${JSON.stringify(selectedIds)}`);
  const selectionScreenshot = path.join(evidenceDir, 'drag-selected-two.png');
  await page.screenshot({ path: selectionScreenshot, fullPage: true });

  await page.keyboard.press('Delete');
  const deleted = await waitForSnapshot(
    (current) => current.graph.nodes.map((node) => node.id).join(',') === 'root,c',
    'multi-selection delete',
  );
  await waitForEnabled(page.getByTestId('undo-button'), 'Delete undo');
  assert(!(await page.getByTestId('redo-button').isEnabled()), 'Redo was enabled before an undo.');

  await page.keyboard.press('Control+z');
  const restoredIds = ['a', 'a1', 'a2', 'b', 'b1'];
  const restored = await waitForSnapshot((current) => (
    current.graph.nodes.length === 7
    && restoredIds.every((id) => (
      JSON.stringify(current.view.positions[id]) === JSON.stringify(original.view.positions[id])
    ))
  ), 'Control+Z graph and position restore');
  assert(JSON.stringify(canonicalGraph(restored.graph)) === JSON.stringify(canonicalGraph(original.graph)),
    'Control+Z did not restore exact graph order and semantics.');
  for (const id of restoredIds) {
    assert(JSON.stringify(restored.view.positions[id]) === JSON.stringify(original.view.positions[id]),
      `Control+Z did not restore ${id} position.`);
  }
  await waitForEnabled(page.getByTestId('redo-button'), 'Control+Z redo');

  await page.keyboard.press('Control+Shift+z');
  await waitForSnapshot((current) => current.graph.nodes.length === 2, 'Control+Shift+Z redo');
  await waitForEnabled(page.getByTestId('undo-button'), 'Control+Shift+Z undo');
  await page.keyboard.press('Meta+z');
  await waitForSnapshot((current) => current.graph.nodes.length === 7, 'Command+Z restore');
  await waitForEnabled(page.getByTestId('redo-button'), 'Command+Z redo');
  await page.keyboard.press('Meta+Shift+z');
  await waitForSnapshot((current) => current.graph.nodes.length === 2, 'Command+Shift+Z redo');
  await waitForEnabled(page.getByTestId('undo-button'), 'Command+Shift+Z undo');
  await page.keyboard.press('Control+z');
  await waitForSnapshot((current) => current.graph.nodes.length === 7, 'final restore');

  await page.getByTestId('node-root').click();
  await page.keyboard.press('Delete');
  await page.getByText('최상위 항목은 삭제할 수 없습니다.', { exact: true }).waitFor();
  assert((await snapshot()).graph.nodes.length === 7, 'Delete removed the root node.');

  await page.getByTestId('node-b1').click();
  await page.keyboard.press('Backspace');
  await waitForSnapshot((current) => current.graph.nodes.length === 6, 'Backspace delete');
  await waitForEnabled(page.getByTestId('undo-button'), 'Backspace undo');
  await page.keyboard.press('Control+z');
  await waitForSnapshot((current) => current.graph.nodes.length === 7, 'Backspace undo');

  await page.getByTestId('node-c').click();
  await page.getByTestId('properties-button').click();
  await page.getByTestId('rename-input').fill('C 수정');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await waitForSnapshot(
    (current) => current.graph.nodes.find((node) => node.id === 'c')?.label === 'C 수정',
    'ordinary rename',
  );
  await waitForEnabled(page.getByTestId('undo-button'), 'Rename undo');
  assert(!(await page.getByTestId('redo-button').isEnabled()), 'A new rename did not clear redo history.');
  await page.getByTestId('inspector-close').click();
  await page.keyboard.press('Control+z');
  await waitForSnapshot(
    (current) => current.graph.nodes.find((node) => node.id === 'c')?.label === 'C 가지',
    'ordinary rename undo',
  );
  await waitForEnabled(page.getByTestId('redo-button'), 'Rename redo');
  await page.keyboard.press('Control+Shift+z');
  await waitForSnapshot(
    (current) => current.graph.nodes.find((node) => node.id === 'c')?.label === 'C 수정',
    'ordinary rename redo',
  );
  await waitForEnabled(page.getByTestId('undo-button'), 'Rename final undo');
  await page.keyboard.press('Control+z');
  await waitForSnapshot(
    (current) => current.graph.nodes.find((node) => node.id === 'c')?.label === 'C 가지',
    'ordinary rename final restore',
  );

  const toolbar768 = await toolbarBounds(page, 768);
  const toolbar390 = await toolbarBounds(page, 390);
  const compactScreenshot = path.join(evidenceDir, 'toolbar-390.png');
  await page.screenshot({ path: compactScreenshot, fullPage: true });

  const report = {
    fixture: { totalNodes: original.graph.nodes.length, selectedIds },
    deletion: {
      deletedNodeIds: original.graph.nodes.filter((node) => !deleted.graph.nodes.some((kept) => kept.id === node.id)).map((node) => node.id),
      rootProtected: true,
      deleteKey: true,
      backspaceKey: true,
    },
    history: {
      controlUndo: true,
      controlShiftRedo: true,
      commandUndo: true,
      commandShiftRedo: true,
      ordinaryRenameUndoRedo: true,
      exactGraphRestored: true,
      positionsRestored: ['a', 'a1', 'a2', 'b', 'b1'],
    },
    responsiveToolbar: { 768: toolbar768, 390: toolbar390 },
    screenshots: [
      path.relative(root, selectionScreenshot),
      path.relative(root, compactScreenshot),
    ],
  };
  await fs.writeFile(path.join(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  await run();
} finally {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
