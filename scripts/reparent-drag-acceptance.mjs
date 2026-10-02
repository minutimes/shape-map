#!/usr/bin/env node
/*
 * Browser check for drag-to-reparent in the hierarchy editor (`?editor=1`):
 * single and multi-card drops into another card, drop guidance, descendants
 * following, no overlap afterwards, and one undo/redo for the whole drop.
 * Evidence: test-results/reparent-drag/.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, evidenceDir as makeEvidenceDir, launchBrowser, startServer } from './support/browser-check.mjs';

let evidenceDir;
let mapPath;
let viewPath;
let server;
let browser;

async function waitUntil(check, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

function fixtureSource() {
  return `flowchart LR
  %% mlc-format: 1
  root(["구조 지도"])
  sourceA(["기존 상위 A"])
  sourceB(["기존 상위 B"])
  target(["새 상위"])
  a["옮길 가지 A"]
  a1["A의 하위"]
  b["옮길 가지 B"]
  b1["B의 하위"]
  peer["기존 하위"]

  root --> sourceA
  root --> sourceB
  root --> target
  sourceA --> a
  a --> a1
  sourceB --> b
  b --> b1
  target --> peer

  classDef direction fill:#16362F,stroke:#4FD1A0,color:#F5FFF9,stroke-width:2px
  classDef stage fill:#F2F6F3,stroke:#78958A,color:#17362E,stroke-width:1px
  classDef focus fill:#FFF0C7,stroke:#C98A17,color:#4F3506,stroke-width:2px
  class root direction
  class sourceA,sourceB,target stage
  class a,a1,b,b1,peer focus

  %% mlc-legend: direction|방향|전체 구조의 출발점
  %% mlc-legend: stage|영역|상위 작업 영역
  %% mlc-legend: focus|구체화 대상|옮길 작업 항목
`;
}

const initialPositions = {
  root: { x: 30, y: 300 },
  sourceA: { x: 350, y: 90 },
  sourceB: { x: 350, y: 300 },
  target: { x: 350, y: 570 },
  a: { x: 670, y: 90 },
  a1: { x: 990, y: 90 },
  b: { x: 670, y: 300 },
  b1: { x: 990, y: 300 },
  peer: { x: 670, y: 570 },
};

async function dragTo(page, sourceId, targetId, { hold = false } = {}) {
  const source = await page.getByTestId(`node-${sourceId}`).boundingBox();
  const target = await page.getByTestId(`node-${targetId}`).boundingBox();
  assert(source && target, `Could not measure ${sourceId} or ${targetId}.`);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 14 });
  if (hold) return { source, target };
  await page.mouse.up();
  return { source, target };
}

async function dragSelect(page, ids) {
  const boxes = await Promise.all(ids.map((id) => page.getByTestId(`node-${id}`).boundingBox()));
  assert(boxes.every(Boolean), `Could not measure selection: ${ids.join(', ')}`);
  const start = {
    x: Math.min(...boxes.map((box) => box.x)) - 12,
    y: Math.min(...boxes.map((box) => box.y)) - 12,
  };
  const end = {
    x: Math.max(...boxes.map((box) => box.x + box.width)) + 12,
    y: Math.max(...boxes.map((box) => box.y + box.height)) + 12,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

async function visibleOverlapPairs(page) {
  return page.locator('.react-flow__node').evaluateAll((elements) => {
    const boxes = elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.dataset.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    const pairs = [];
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        const a = boxes[left];
        const b = boxes[right];
        if (a.left < b.right - 0.5 && a.right > b.left + 0.5
          && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5) pairs.push([a.id, b.id]);
      }
    }
    return pairs;
  });
}

async function run() {
  evidenceDir = await makeEvidenceDir('reparent-drag');
  mapPath = path.join(evidenceDir, 'map.mmd');
  viewPath = path.join(evidenceDir, 'map.view.json');
  await fs.writeFile(mapPath, fixtureSource(), 'utf8');
  await fs.writeFile(viewPath, `${JSON.stringify({
    positions: initialPositions,
    collapsedIds: [],
    viewport: { x: 30, y: 20, zoom: 0.78 },
  }, null, 2)}\n`, 'utf8');

  server = await startServer({ FINAL_SHAPE_MAP_DATA_ROOT: evidenceDir, FINAL_SHAPE_MAP_PATH: path.basename(mapPath) });
  const { origin } = server;
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('final-shape-map-workflow-mode', 'false'));
  const page = await context.newPage();
  await page.goto(`${origin}?editor=1`, { waitUntil: 'networkidle' });
  await page.getByTestId('node-root').waitFor();

  const snapshot = async () => (await fetch(`${origin}/api/map`)).json();
  const parentOf = async (id) => (await snapshot()).graph.nodes.find((node) => node.id === id)?.parentId;

  await dragTo(page, 'a', 'target', { hold: true });
  const singleTarget = page.getByTestId('drop-target-target');
  await singleTarget.waitFor({ state: 'visible' });
  assert((await singleTarget.innerText()) === '이 항목의 하위로 넣기',
    'Single-card drop target guidance was not explicit.');
  await page.screenshot({ path: path.join(evidenceDir, 'single-drop-target.png'), fullPage: true });
  await page.mouse.up();
  await waitUntil(() => parentOf('a').then((parentId) => parentId === 'target'),
    'Single-card drop did not change its parent.');
  assert(await parentOf('a1') === 'a', 'A descendant detached from its moved branch.');

  await page.getByTestId('undo-button').click();
  await waitUntil(async () => {
    const current = await snapshot();
    return current.graph.nodes.find((node) => node.id === 'a')?.parentId === 'sourceA'
      && JSON.stringify(current.view.positions.a) === JSON.stringify(initialPositions.a);
  }, 'Single-card reparent undo did not restore its parent and position.');

  await dragSelect(page, ['a', 'b']);
  const selected = await page.locator('.react-flow__node.selected').evaluateAll(
    (elements) => elements.map((element) => element.dataset.id).sort(),
  );
  assert(JSON.stringify(selected) === JSON.stringify(['a', 'b']),
    `Unexpected multi-selection: ${JSON.stringify(selected)}`);

  await dragTo(page, 'a', 'target', { hold: true });
  const multiTarget = page.getByTestId('drop-target-target');
  await multiTarget.waitFor({ state: 'visible' });
  assert((await multiTarget.innerText()) === '선택한 2개를 하위로 넣기',
    'Multi-card drop target did not show the selected count.');
  await page.screenshot({ path: path.join(evidenceDir, 'multi-drop-target.png'), fullPage: true });
  await page.mouse.up();
  await waitUntil(async () => await parentOf('a') === 'target' && await parentOf('b') === 'target',
    'Multi-card drop did not change both parents atomically.');
  assert(await parentOf('a1') === 'a' && await parentOf('b1') === 'b',
    'Multi-card reparent detached a descendant.');
  await waitUntil(async () => (
    await page.locator('[data-testid="rf__edge-target-a"], [data-testid="rf__edge-target-b"]').count()
  ) === 2, 'Multi-card parent edges were not rendered.');
  assert((await visibleOverlapPairs(page)).length === 0,
    'Multi-card reparent left visible cards overlapping.');

  await page.getByTestId('undo-button').click();
  await waitUntil(async () => {
    const current = await snapshot();
    const parents = Object.fromEntries(current.graph.nodes.map((node) => [node.id, node.parentId]));
    return parents.a === 'sourceA'
      && parents.b === 'sourceB'
      && JSON.stringify(current.view.positions.a) === JSON.stringify(initialPositions.a)
      && JSON.stringify(current.view.positions.b) === JSON.stringify(initialPositions.b);
  }, 'One undo did not restore both original parents and positions.');

  await page.getByTestId('redo-button').click();
  await waitUntil(async () => await parentOf('a') === 'target' && await parentOf('b') === 'target',
    'One redo did not reapply both parent changes.');

  const report = {
    origin,
    checks: {
      singleReparent: true,
      descendantsFollow: true,
      multiReparentAtomic: true,
      multiReparentNoOverlap: true,
      dropTargetGuidance: true,
      undoRedoAtomic: true,
    },
    screenshots: ['single-drop-target.png', 'multi-drop-target.png'],
  };
  await fs.writeFile(path.join(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

try {
  await run();
} finally {
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
}
