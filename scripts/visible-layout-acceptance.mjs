import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(root, 'test-results', 'visible-layout');
const mapPath = path.join(evidenceDir, 'fifty-nodes.mmd');
const port = 4334;
const origin = `http://127.0.0.1:${port}`;
let server;
let browser;

async function headlessShellPath() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  const bundledPath = chromium.executablePath();
  const match = bundledPath.match(/^(.*)\/chromium-(\d+)\//);
  if (!match) return bundledPath;
  const candidate = path.join(
    match[1],
    `chromium_headless_shell-${match[2]}`,
    'chrome-headless-shell-mac-arm64',
    'chrome-headless-shell',
  );
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return bundledPath;
  }
}

function fixtureSource() {
  const branches = Array.from({ length: 8 }, (_, index) => `branch_${index + 1}`);
  const nodes = ['  root(["WVE 전체 방향"])'];
  const edges = [];
  const classes = ['root'];
  let childNumber = 0;
  branches.forEach((id, branchIndex) => {
    nodes.push(`  ${id}(["큰 가지 ${branchIndex + 1}"])`);
    edges.push(`  root --> ${id}`);
    classes.push(id);
    const count = branchIndex === 0 ? 6 : 5;
    for (let index = 0; index < count; index += 1) {
      childNumber += 1;
      const childId = `child_${childNumber}`;
      nodes.push(`  ${childId}["세부 항목 ${childNumber}"]`);
      edges.push(`  ${id} --> ${childId}`);
    }
  });
  return [
    'flowchart LR',
    '  %% mlc-format: 1',
    ...nodes,
    '',
    ...edges,
    '',
    '  classDef direction fill:#16362F,stroke:#4FD1A0,color:#F5FFF9,stroke-width:2px',
    '  classDef stage fill:#F2F6F3,stroke:#78958A,color:#17362E,stroke-width:1px',
    '  classDef focus fill:#FFF0C7,stroke:#C98A17,color:#4F3506,stroke-width:2px',
    '  class root direction',
    `  class ${branches.join(',')} stage`,
    `  class ${Array.from({ length: 41 }, (_, index) => `child_${index + 1}`).join(',')} focus`,
    '',
    '  %% mlc-legend: direction|방향|전체 구조의 출발점',
    '  %% mlc-legend: stage|큰 가지|접어서 보는 주요 영역',
    '  %% mlc-legend: focus|세부 항목|펼쳤을 때 보이는 하위 항목',
    '',
  ].join('\n');
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {
      // The isolated fixture server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Focused fixture server did not start.');
}

async function readSnapshot() {
  const response = await fetch(`${origin}/api/map`);
  if (!response.ok) throw new Error(`Snapshot read failed: ${response.status}.`);
  return response.json();
}

async function waitForSnapshot(predicate, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const snapshot = await readSnapshot();
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Snapshot did not settle: ${label}.`);
}

function positionsFor(snapshot, ids) {
  return Object.fromEntries(ids.map((id) => [id, snapshot.view.positions[id]]));
}

async function visibleMetrics(page) {
  return page.locator('.react-flow__node').evaluateAll((elements) => {
    const nodes = elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.dataset.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const overlapPairs = [];
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const a = nodes[left];
        const b = nodes[right];
        if (
          a.x < b.x + b.width - 0.5
          && a.x + a.width > b.x + 0.5
          && a.y < b.y + b.height - 0.5
          && a.y + a.height > b.y + 0.5
        ) overlapPairs.push([a.id, b.id]);
      }
    }
    const bounds = {
      left: Math.min(...nodes.map((node) => node.x)),
      top: Math.min(...nodes.map((node) => node.y)),
      right: Math.max(...nodes.map((node) => node.x + node.width)),
      bottom: Math.max(...nodes.map((node) => node.y + node.height)),
    };
    return { nodeCount: nodes.length, overlapPairs, bounds, firstCardWidth: nodes[0]?.width || 0 };
  });
}

async function viewportTransform(page) {
  return page.locator('.react-flow__viewport').evaluate((element) => {
    const match = getComputedStyle(element).transform.match(/^matrix\(([^)]+)\)$/);
    if (!match) return null;
    const [a, b, c, d, x, y] = match[1].split(',').map(Number);
    return { a, b, c, d, x, y };
  });
}

function assertViewport(actual, expected, label) {
  const close = (left, right) => Math.abs(left - right) < 0.05;
  if (!actual || !close(actual.x, expected.x) || !close(actual.y, expected.y) || !close(actual.a, expected.zoom)) {
    throw new Error(`${label} viewport mismatch: ${JSON.stringify({ actual, expected })}`);
  }
}

async function run() {
  await fs.rm(evidenceDir, { recursive: true, force: true });
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(mapPath, fixtureSource(), 'utf8');
  await fs.writeFile(mapPath.replace(/\.mmd$/, '.view.json'), `${JSON.stringify({
    positions: {},
    collapsedIds: Array.from({ length: 8 }, (_, index) => `branch_${index + 1}`),
    viewport: { x: 160, y: -3485, zoom: 1 },
  }, null, 2)}\n`, 'utf8');

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

  browser = await chromium.launch({ executablePath: await headlessShellPath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await context.addInitScript(() => localStorage.setItem('final-shape-map-workflow-mode', 'false'));
  const page = await context.newPage();
  await page.goto(`${origin}?editor=1`, { waitUntil: 'networkidle' });
  await page.getByTestId('node-root').waitFor();

  const restoredZoomOne = await viewportTransform(page);
  assertViewport(restoredZoomOne, { x: 160, y: -3485, zoom: 1 }, 'Initial');

  const current = await readSnapshot();
  const updatedViewResponse = await fetch(`${origin}/api/view`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: 'visible-layout-acceptance',
      baseRevision: current.revision,
      patch: { viewport: { x: 160, y: -3485, zoom: 2 } },
    }),
  });
  if (!updatedViewResponse.ok) throw new Error(`Viewport fixture update failed: ${updatedViewResponse.status}.`);
  await page.waitForTimeout(120);
  const unchangedBeforeReload = await viewportTransform(page);
  assertViewport(unchangedBeforeReload, { x: 160, y: -3485, zoom: 1 }, 'Live external update');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('node-root').waitFor();
  const restoredZoomTwo = await viewportTransform(page);
  assertViewport(restoredZoomTwo, { x: 160, y: -3485, zoom: 2 }, 'Reloaded');

  const initialVisibleCount = await page.locator('.react-flow__node').count();
  if (initialVisibleCount !== 9) throw new Error(`Expected 9 folded nodes, got ${initialVisibleCount}.`);
  const allChildIds = Array.from({ length: 41 }, (_, index) => `child_${index + 1}`);
  const beforeFoldedArrange = await waitForSnapshot(
    (snapshot) => allChildIds.every((id) => snapshot.view.positions[id]),
    'initial hidden positions',
  );
  const foldedHiddenBefore = positionsFor(beforeFoldedArrange, allChildIds);
  await page.getByTestId('arrange-visible-button').click();
  await page.waitForTimeout(320);
  const afterFoldedArrange = await readSnapshot();
  if (JSON.stringify(afterFoldedArrange.graph) !== JSON.stringify(beforeFoldedArrange.graph)) {
    throw new Error('Visible arrangement changed the semantic graph.');
  }
  if (JSON.stringify(positionsFor(afterFoldedArrange, allChildIds)) !== JSON.stringify(foldedHiddenBefore)) {
    throw new Error('Folded hidden positions changed during visible arrangement.');
  }
  const folded = await visibleMetrics(page);
  if (folded.overlapPairs.length) throw new Error(`Folded nodes overlap: ${JSON.stringify(folded.overlapPairs)}`);
  if (folded.firstCardWidth < 130) throw new Error(`Folded cards are too small: ${folded.firstCardWidth}px.`);
  const foldedScreenshot = path.join(evidenceDir, 'folded-9-visible.png');
  await page.screenshot({ path: foldedScreenshot, fullPage: true });

  await page.getByTestId('toggle-branch_1').click();
  await page.locator('.react-flow__node').nth(14).waitFor();
  const stillHiddenIds = allChildIds.slice(6);
  const beforeExpandedArrange = await waitForSnapshot(
    (snapshot) => !snapshot.view.collapsedIds.includes('branch_1'),
    'expanded branch state',
  );
  const expandedHiddenBefore = positionsFor(beforeExpandedArrange, stillHiddenIds);
  await page.getByTestId('arrange-visible-button').click();
  await page.waitForTimeout(320);
  const afterExpandedArrange = await readSnapshot();
  if (JSON.stringify(afterExpandedArrange.graph) !== JSON.stringify(beforeExpandedArrange.graph)) {
    throw new Error('Expanded visible arrangement changed the semantic graph.');
  }
  if (JSON.stringify(positionsFor(afterExpandedArrange, stillHiddenIds)) !== JSON.stringify(expandedHiddenBefore)) {
    throw new Error('Still-hidden positions changed during expanded arrangement.');
  }
  const expanded = await visibleMetrics(page);
  if (expanded.nodeCount !== 15) throw new Error(`Expected 15 expanded nodes, got ${expanded.nodeCount}.`);
  if (expanded.overlapPairs.length) throw new Error(`Expanded nodes overlap: ${JSON.stringify(expanded.overlapPairs)}`);
  const expandedScreenshot = path.join(evidenceDir, 'expanded-15-visible.png');
  await page.screenshot({ path: expandedScreenshot, fullPage: true });

  await page.setViewportSize({ width: 390, height: 820 });
  const toolbarButtons = await page.locator('.topbar button:visible').evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return {
      label: button.getAttribute('aria-label') || button.textContent.trim(),
      left: rect.left,
      right: rect.right,
      height: rect.height,
    };
  }));
  if (toolbarButtons.some((button) => button.left < 0 || button.right > 390 || button.height < 40)) {
    throw new Error(`390px toolbar clipping: ${JSON.stringify(toolbarButtons)}`);
  }
  const compactScreenshot = path.join(evidenceDir, 'toolbar-390.png');
  await page.screenshot({ path: compactScreenshot, fullPage: true });

  const report = {
    fixture: { totalNodes: 50, foldedBranches: 8 },
    viewportRestore: { restoredZoomOne, unchangedBeforeReload, restoredZoomTwo },
    folded,
    expanded,
    preservation: {
      foldedHiddenPositions: allChildIds.length,
      expandedHiddenPositions: stillHiddenIds.length,
      semanticGraphUnchanged: true,
    },
    responsiveToolbar: { viewportWidth: 390, buttons: toolbarButtons },
    screenshots: [
      path.relative(root, foldedScreenshot),
      path.relative(root, expandedScreenshot),
      path.relative(root, compactScreenshot),
    ],
  };
  await fs.writeFile(path.join(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  await run();
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
