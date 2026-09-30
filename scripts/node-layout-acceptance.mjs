import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(root, 'test-results', 'node-layout');
const mapPath = path.join(evidenceDir, 'node-layout-fixture.mmd');
let server;
let browser;
let origin;

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
  return `flowchart LR
  %% mlc-format: 1
  root(["전체 방향"])
  a(["첫 번째 긴 카드 제목은 내용을 모두 보여 주기 위해 여러 줄로 표시됩니다"])
  a1["첫 번째 세부"]
  b(["두 번째 긴 카드 제목도 일괄 표시 설정과 말줄임을 확인합니다"])
  b1["두 번째 세부"]

  root --> a
  a --> a1
  root --> b
  b --> b1

  classDef stage fill:#F2F6F3,stroke:#5F8E7D,color:#17362E,stroke-width:1px
  class root,a,a1,b,b1 stage

  %% mlc-legend: stage|단계|카드 배치와 크기 검증
`;
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Node layout fixture server did not start.');
}

async function snapshot() {
  const response = await fetch(`${origin}/api/map`);
  if (!response.ok) throw new Error(`Snapshot read failed: ${response.status}.`);
  return response.json();
}

async function waitForSnapshot(predicate, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await snapshot();
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Snapshot did not settle: ${label}.`);
}

async function waitForEnabled(locator, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await locator.isEnabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not become enabled.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    return { nodes, overlapPairs };
  });
}

async function dragSelect(page, ids) {
  const boxes = await Promise.all(ids.map((id) => page.getByTestId(`node-${id}`).boundingBox()));
  assert(boxes.every(Boolean), `Could not measure selection targets: ${ids.join(', ')}`);
  const start = {
    x: Math.min(...boxes.map((box) => box.x)) - 14,
    y: Math.min(...boxes.map((box) => box.y)) - 14,
  };
  const end = {
    x: Math.max(...boxes.map((box) => box.x + box.width)) + 14,
    y: Math.max(...boxes.map((box) => box.y + box.height)) + 14,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

async function run() {
  await fs.rm(evidenceDir, { recursive: true, force: true });
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(mapPath, fixtureSource(), 'utf8');
  const initialPositions = {
    root: { x: 40, y: 220 },
    a: { x: 340, y: 120 },
    a1: { x: 700, y: 120 },
    b: { x: 340, y: 150 },
    b1: { x: 700, y: 150 },
  };
  await fs.writeFile(mapPath.replace(/\.mmd$/, '.view.json'), `${JSON.stringify({
    positions: initialPositions,
    collapsedIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, null, 2)}\n`, 'utf8');

  const port = await freePort();
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

  browser = await chromium.launch({ executablePath: await headlessShellPath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(() => localStorage.setItem('final-shape-map-workflow-mode', 'false'));
  const page = await context.newPage();
  await page.goto(`${origin}?editor=1`, { waitUntil: 'networkidle' });
  await page.getByTestId('node-root').waitFor();

  const autoArranged = await waitForSnapshot(
    (current) => current.view.positions.b?.y !== initialPositions.b.y,
    'startup overlap auto-arrangement',
  );
  await page.waitForTimeout(150);
  const arrangedMetrics = await visibleMetrics(page);
  const arrangedById = Object.fromEntries(arrangedMetrics.nodes.map((node) => [node.id, node]));
  assert(arrangedMetrics.overlapPairs.length === 0,
    `Auto-arrangement left overlaps: ${JSON.stringify(arrangedMetrics.overlapPairs)}`);
  assert(Math.abs(arrangedById.a.x - arrangedById.b.x) <= 1
    && Math.abs(arrangedById.a1.x - arrangedById.b1.x) <= 1,
  `Auto-arrangement did not align equal-depth cards by their left edge: ${JSON.stringify(arrangedById)}`);

  const beforeMove = { ...autoArranged.view.positions.b };
  const bBox = await page.getByTestId('node-b').boundingBox();
  assert(bBox, 'Could not measure the move target.');
  await page.mouse.move(bBox.x + bBox.width / 2, bBox.y + bBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(bBox.x + bBox.width / 2, bBox.y + bBox.height / 2 + 320, { steps: 12 });
  await page.mouse.up();
  const moved = await waitForSnapshot(
    (current) => current.view.positions.b?.x !== beforeMove.x || current.view.positions.b?.y !== beforeMove.y,
    'branch move',
  );
  const movedPosition = { ...moved.view.positions.b };
  await waitForEnabled(page.getByTestId('undo-button'), 'Move undo');
  await page.keyboard.press('Control+z');
  await waitForSnapshot(
    (current) => current.view.positions.b?.x === beforeMove.x && current.view.positions.b?.y === beforeMove.y,
    'branch move undo',
  );
  await waitForEnabled(page.getByTestId('redo-button'), 'Move redo');
  await page.keyboard.press('Control+Shift+z');
  await waitForSnapshot(
    (current) => current.view.positions.b?.x === movedPosition.x && current.view.positions.b?.y === movedPosition.y,
    'branch move redo',
  );

  await page.getByTestId('node-a').dblclick();
  const inlineEditor = page.getByTestId('node-a').getByTestId('inline-rename-input');
  await inlineEditor.waitFor();
  const longDraft = '작성 중인 긴 문장이 앞부분부터 끝부분까지 모두 보이도록 입력창이 내용에 맞춰 세로로 늘어나는지 확인하는 문장입니다';
  await inlineEditor.fill(longDraft);
  const editorMetrics = await inlineEditor.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    value: element.value,
  }));
  assert(editorMetrics.clientHeight > 34, `Inline editor did not grow: ${JSON.stringify(editorMetrics)}`);
  assert(editorMetrics.scrollHeight <= editorMetrics.clientHeight + 2,
    `Inline editor still hides earlier text: ${JSON.stringify(editorMetrics)}`);
  assert(editorMetrics.value === longDraft, 'Inline editor lost part of the draft.');
  await inlineEditor.press('Enter');
  await waitForSnapshot(
    (current) => current.graph.nodes.find((node) => node.id === 'a')?.label === longDraft,
    'long inline rename',
  );
  await page.waitForTimeout(120);
  const fittedWidth = (await page.getByTestId('node-a').boundingBox())?.width;
  assert(fittedWidth > 208, `Fit mode did not widen the long card: ${fittedWidth}`);

  await page.getByTestId('node-a').click();
  const handles = page.getByTestId('node-a').locator('.map-node__resize-handle');
  const handleCount = await handles.count();
  const resizeLines = page.getByTestId('node-a').locator('.map-node__resize-line');
  const resizeLineCount = await resizeLines.count();
  assert(handleCount >= 4 && resizeLineCount >= 4,
    `Expected four draggable borders and four corner handles, got ${resizeLineCount} borders and ${handleCount} handles.`);
  const handleClasses = await handles.evaluateAll((elements) => elements.map((element) => element.className));
  assert(handleClasses.some((name) => name.includes('left')) && handleClasses.some((name) => name.includes('right')),
    `Horizontal resize handles missing: ${JSON.stringify(handleClasses)}`);
  assert(handleClasses.some((name) => name.includes('top')) && handleClasses.some((name) => name.includes('bottom')),
    `Vertical resize handles missing: ${JSON.stringify(handleClasses)}`);
  const handleBoxes = await Promise.all(Array.from({ length: handleCount }, (_, index) => handles.nth(index).boundingBox()));
  const bottomRightIndex = handleBoxes.reduce((best, box, index, all) => (
    box && (!all[best] || box.x + box.y > all[best].x + all[best].y) ? index : best
  ), 0);
  const corner = handleBoxes[bottomRightIndex];
  const beforeResize = await snapshot();
  const beforeResizePosition = { ...beforeResize.view.positions.a };
  const beforeResizeMetrics = await visibleMetrics(page);
  const beforeResizeById = Object.fromEntries(beforeResizeMetrics.nodes.map((node) => [node.id, node]));
  const beforeResizeCard = beforeResizeMetrics.nodes.find((node) => node.id === 'a');
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + 84, corner.y + corner.height / 2 + 48, { steps: 10 });
  const liveResizeGeometry = await page.locator('.react-flow__node[data-id="a"]').evaluate((wrapper) => {
    const card = wrapper.querySelector('[data-testid="node-a"]');
    const wrapperRect = wrapper.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      wrapper: { x: wrapperRect.x, y: wrapperRect.y, width: wrapperRect.width, height: wrapperRect.height },
      card: { x: cardRect.x, y: cardRect.y, width: cardRect.width, height: cardRect.height },
      resizing: card.classList.contains('is-resizing'),
    };
  });
  assert(liveResizeGeometry.resizing, 'Card did not enter its live resizing state.');
  assert(Math.abs(liveResizeGeometry.wrapper.width - liveResizeGeometry.card.width) <= 1
    && Math.abs(liveResizeGeometry.wrapper.height - liveResizeGeometry.card.height) <= 1,
  `Live card and resize frame diverged: ${JSON.stringify(liveResizeGeometry)}`);
  assert(Math.abs(liveResizeGeometry.card.x - beforeResizeCard.x) <= 1
    && Math.abs(liveResizeGeometry.card.y - beforeResizeCard.y) <= 1,
  `Bottom-right resize moved its top-left anchor: ${JSON.stringify({ beforeResizeCard, liveResizeGeometry })}`);
  const firstLiveMetrics = await visibleMetrics(page);
  const firstLiveById = Object.fromEntries(firstLiveMetrics.nodes.map((node) => [node.id, node]));
  const firstWidthDelta = liveResizeGeometry.card.width - beforeResizeCard.width;
  assert(Math.abs(firstLiveById.a.x - firstLiveById.b.x) <= 1,
    `Resize broke the shared left edge for equal-depth cards: ${JSON.stringify(firstLiveById)}`);
  assert(Math.abs(firstLiveById.a1.x - firstLiveById.b1.x) <= 1,
    `Resize broke the next-rank left edge: ${JSON.stringify(firstLiveById)}`);
  assert(Math.abs((firstLiveById.a1.x - beforeResizeById.a1.x) - firstWidthDelta) <= 1
    && Math.abs((firstLiveById.b1.x - beforeResizeById.b1.x) - firstWidthDelta) <= 1,
  `Deeper rank did not move by the exact width delta: ${JSON.stringify({
    beforeResizeById,
    firstLiveById,
    firstWidthDelta,
  })}`);
  assert(Math.abs(firstLiveById.root.x - beforeResizeById.root.x) <= 1
    && Math.abs(firstLiveById.root.y - beforeResizeById.root.y) <= 1,
  `Resize moved an unrelated ancestor: ${JSON.stringify({ before: beforeResizeById.root, live: firstLiveById.root })}`);
  assert(firstLiveMetrics.overlapPairs.length === 0,
    `First live resize left cards overlapping: ${JSON.stringify(firstLiveMetrics.overlapPairs)}`);
  await page.mouse.up();
  const resized = await waitForSnapshot(
    (current) => current.graph.nodes.find((node) => node.id === 'a')?.layout?.mode === 'fixed',
    'diagonal card resize',
  );
  const resizedLayout = resized.graph.nodes.find((node) => node.id === 'a').layout;
  assert(resizedLayout.width > fittedWidth && resizedLayout.height > 88,
    `Diagonal resize did not change both dimensions: ${JSON.stringify(resizedLayout)}`);
  const savedResizeGeometry = await page.locator('.react-flow__node[data-id="a"]').evaluate((wrapper) => {
    const card = wrapper.querySelector('[data-testid="node-a"]');
    const wrapperRect = wrapper.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      wrapper: { x: wrapperRect.x, y: wrapperRect.y, width: wrapperRect.width, height: wrapperRect.height },
      card: { x: cardRect.x, y: cardRect.y, width: cardRect.width, height: cardRect.height },
    };
  });
  assert(Math.abs(savedResizeGeometry.wrapper.width - savedResizeGeometry.card.width) <= 1
    && Math.abs(savedResizeGeometry.wrapper.height - savedResizeGeometry.card.height) <= 1,
  `Saved card and resize frame diverged: ${JSON.stringify(savedResizeGeometry)}`);
  assert(Math.abs(savedResizeGeometry.card.width - liveResizeGeometry.card.width) <= 1
    && Math.abs(savedResizeGeometry.card.height - liveResizeGeometry.card.height) <= 1,
  `Card shape changed after resize save: ${JSON.stringify({ liveResizeGeometry, savedResizeGeometry })}`);
  assert(Math.abs(savedResizeGeometry.card.x - beforeResizeCard.x) <= 1
    && Math.abs(savedResizeGeometry.card.y - beforeResizeCard.y) <= 1,
  `Saved bottom-right resize moved its top-left anchor: ${JSON.stringify({ beforeResizeCard, savedResizeGeometry })}`);
  await waitForEnabled(page.getByTestId('undo-button'), 'Resize undo');
  await page.keyboard.press('Control+z');
  const resizeUndone = await waitForSnapshot(
    (current) => current.graph.nodes.find((node) => node.id === 'a')?.layout?.mode === 'fit'
      && current.graph.nodes.every((node) => (
        JSON.stringify(current.view.positions[node.id]) === JSON.stringify(beforeResize.view.positions[node.id])
      )),
    'resize undo',
  );
  assert(JSON.stringify(resizeUndone.view.positions.a) === JSON.stringify(beforeResizePosition),
    'Resize undo did not restore the original card position.');
  assert(beforeResize.graph.nodes.every((node) => (
    JSON.stringify(resizeUndone.view.positions[node.id]) === JSON.stringify(beforeResize.view.positions[node.id])
  )), `Resize undo did not restore every card pushed by the live reflow: ${JSON.stringify({
    before: beforeResize.view.positions,
    after: resizeUndone.view.positions,
  })}`);
  await waitForEnabled(page.getByTestId('redo-button'), 'Resize redo');
  await page.keyboard.press('Control+Shift+z');
  const resizeRedone = await waitForSnapshot(
    (current) => current.graph.nodes.find((node) => node.id === 'a')?.layout?.mode === 'fixed'
      && current.graph.nodes.every((node) => (
        JSON.stringify(current.view.positions[node.id]) === JSON.stringify(resized.view.positions[node.id])
      )),
    'resize redo',
  );
  assert(resized.graph.nodes.every((node) => (
    JSON.stringify(resizeRedone.view.positions[node.id]) === JSON.stringify(resized.view.positions[node.id])
  )), 'Resize redo did not restore every card pushed by the live reflow.');

  await page.getByTestId('node-a').click();
  const beforeMaximumSnapshot = await snapshot();
  const beforeMaximumMetrics = await visibleMetrics(page);
  const beforeMaximumById = Object.fromEntries(beforeMaximumMetrics.nodes.map((node) => [node.id, node]));
  const rightResizeLine = page.getByTestId('node-a').locator('[data-resize-control="right"]');
  let rightLineBox = await rightResizeLine.boundingBox();
  assert(rightLineBox, 'Could not measure the right resize border.');
  const rightLineCenter = {
    x: rightLineBox.x + 2,
    y: rightLineBox.y + rightLineBox.height * 0.25,
  };
  await page.mouse.move(rightLineCenter.x, rightLineCenter.y);
  await page.mouse.down();
  const maximumResizeStarted = await page.getByTestId('node-a').evaluate((card) => card.classList.contains('is-resizing'));
  assert(maximumResizeStarted,
    `Maximum-width resize did not start: ${JSON.stringify({ rightLineBox, rightLineCenter })}`);
  await page.mouse.move(rightLineCenter.x + 360, rightLineCenter.y, { steps: 18 });
  const maximumLiveWidth = (await page.getByTestId('node-a').boundingBox()).width;
  assert(Math.abs(maximumLiveWidth - 720) <= 1,
    `Card did not stop at its maximum width: ${maximumLiveWidth}`);
  const maximumMetrics = await visibleMetrics(page);
  const maximumById = Object.fromEntries(maximumMetrics.nodes.map((node) => [node.id, node]));
  assert(Math.abs(maximumById.a.x - beforeMaximumById.a.x) <= 1
    && Math.abs(maximumById.a.y - beforeMaximumById.a.y) <= 1,
  `Right-edge resize moved the card anchor: ${JSON.stringify({ before: beforeMaximumById.a, live: maximumById.a })}`);
  assert(maximumMetrics.overlapPairs.length === 0,
    `Live resize left cards overlapping: ${JSON.stringify(maximumMetrics.overlapPairs)}`);
  assert(Math.abs(maximumById.a.x - maximumById.b.x) <= 1
    && Math.abs(maximumById.a1.x - maximumById.b1.x) <= 1,
  `Maximum resize broke rank left-edge alignment: ${JSON.stringify(maximumById)}`);
  const maximumWidthDelta = maximumById.a.width - beforeMaximumById.a.width;
  assert(Math.abs((maximumById.a1.x - beforeMaximumById.a1.x) - maximumWidthDelta) <= 1
    && Math.abs((maximumById.b1.x - beforeMaximumById.b1.x) - maximumWidthDelta) <= 1,
  `Maximum resize did not move only the deeper rank by the width delta: ${JSON.stringify({
    beforeMaximumById,
    maximumById,
    maximumWidthDelta,
  })}`);
  assert(Math.abs(maximumById.root.x - beforeMaximumById.root.x) <= 1
    && Math.abs(maximumById.root.y - beforeMaximumById.root.y) <= 1,
  `Maximum resize moved the ancestor: ${JSON.stringify({ before: beforeMaximumById.root, live: maximumById.root })}`);
  const livePushedIds = maximumMetrics.nodes
    .filter((node) => node.id !== 'a' && beforeMaximumById[node.id])
    .filter((node) => Math.abs(node.x - beforeMaximumById[node.id].x) > 1
      || Math.abs(node.y - beforeMaximumById[node.id].y) > 1)
    .map((node) => node.id);
  assert(JSON.stringify(livePushedIds.sort()) === JSON.stringify(['a1', 'b1']),
    `Resize moved cards outside the deeper rank: ${JSON.stringify({ livePushedIds, beforeMaximumMetrics, maximumMetrics })}`);
  await page.mouse.move(rightLineCenter.x + 280, rightLineCenter.y, { steps: 4 });
  const reversedLiveWidth = (await page.getByTestId('node-a').boundingBox()).width;
  assert(reversedLiveWidth < maximumLiveWidth - 70,
    `Card did not shrink immediately after reversing at maximum width: ${JSON.stringify({ maximumLiveWidth, reversedLiveWidth })}`);
  const reversedLiveMetrics = await visibleMetrics(page);
  const reversedLiveById = Object.fromEntries(reversedLiveMetrics.nodes.map((node) => [node.id, node]));
  const reversedWidthDelta = reversedLiveById.a.width - beforeMaximumById.a.width;
  assert(Math.abs((reversedLiveById.a1.x - beforeMaximumById.a1.x) - reversedWidthDelta) <= 1
    && Math.abs((reversedLiveById.b1.x - beforeMaximumById.b1.x) - reversedWidthDelta) <= 1,
  `Reversing at maximum width did not pull the deeper rank back continuously: ${JSON.stringify({
    beforeMaximumById,
    reversedLiveById,
    reversedWidthDelta,
  })}`);
  const liveResizeScreenshot = path.join(evidenceDir, 'resize-live-desktop.png');
  await page.screenshot({ path: liveResizeScreenshot, fullPage: true });
  await page.mouse.up();
  const reversedAtMaximum = await waitForSnapshot((current) => {
    const layout = current.graph.nodes.find((node) => node.id === 'a')?.layout;
    return layout?.mode === 'fixed' && layout.width < 720;
  }, 'same-drag maximum width reversal');
  assert(reversedAtMaximum.view.positions.a.x === beforeMaximumSnapshot.view.positions.a.x
    && reversedAtMaximum.view.positions.a.y === beforeMaximumSnapshot.view.positions.a.y,
  `Saved right-edge resize moved the card anchor: ${JSON.stringify({ before: beforeMaximumSnapshot.view.positions.a, after: reversedAtMaximum.view.positions.a })}`);
  const savedResizeScreenshot = path.join(evidenceDir, 'resize-saved-desktop.png');
  await page.screenshot({ path: savedResizeScreenshot, fullPage: true });

  await page.getByTestId('node-a').click();
  rightLineBox = await page.getByTestId('node-a').locator('[data-resize-control="right"]').boundingBox();
  const secondRightLineCenter = {
    x: rightLineBox.x + 2,
    y: rightLineBox.y + rightLineBox.height * 0.25,
  };
  await page.mouse.move(secondRightLineCenter.x, secondRightLineCenter.y);
  await page.mouse.down();
  await page.mouse.move(secondRightLineCenter.x + 160, secondRightLineCenter.y, { steps: 10 });
  await page.mouse.up();
  await waitForSnapshot(
    (current) => current.graph.nodes.find((node) => node.id === 'a')?.layout?.width === 720,
    'saved maximum width',
  );
  await page.getByTestId('node-a').click();
  rightLineBox = await page.getByTestId('node-a').locator('[data-resize-control="right"]').boundingBox();
  const maximumRightLineCenter = {
    x: rightLineBox.x + 2,
    y: rightLineBox.y + rightLineBox.height * 0.25,
  };
  await page.mouse.move(maximumRightLineCenter.x, maximumRightLineCenter.y);
  await page.mouse.down();
  await page.mouse.move(maximumRightLineCenter.x - 140, maximumRightLineCenter.y, { steps: 8 });
  await page.mouse.up();
  const shrunkAfterMaximum = await waitForSnapshot((current) => {
    const layout = current.graph.nodes.find((node) => node.id === 'a')?.layout;
    return layout?.mode === 'fixed' && layout.width < 600;
  }, 'shrink after saved maximum width');

  await page.getByTestId('node-root').click();
  await dragSelect(page, ['a', 'b']);
  const selectedIds = await page.locator('.react-flow__node.selected').evaluateAll(
    (nodes) => nodes.map((node) => node.dataset.id).sort(),
  );
  assert(JSON.stringify(selectedIds) === JSON.stringify(['a', 'b']),
    `Batch selection chose unexpected cards: ${JSON.stringify(selectedIds)}`);
  await page.getByTestId('properties-button').click();
  await page.getByTestId('layout-mode-wrap').click();
  await page.getByTestId('layout-width').fill('260');
  await page.getByTestId('apply-layout').click();
  await waitForSnapshot((current) => ['a', 'b'].every((id) => {
    const layout = current.graph.nodes.find((node) => node.id === id)?.layout;
    return layout?.mode === 'wrap' && layout.width === 260;
  }), 'batch wrapped layout');
  const wrapHeights = await Promise.all(['a', 'b'].map(async (id) => (await page.getByTestId(`node-${id}`).boundingBox()).height));
  assert(wrapHeights.every((height) => height >= 88), `Wrapped cards did not show all content: ${wrapHeights.join(', ')}`);

  await page.getByTestId('layout-mode-fixed').click();
  await page.getByTestId('layout-height').fill('80');
  await page.getByTestId('apply-layout').click();
  const fixedBatch = await waitForSnapshot((current) => ['a', 'b'].every((id) => {
    const layout = current.graph.nodes.find((node) => node.id === id)?.layout;
    return layout?.mode === 'fixed' && layout.width === 260 && layout.height === 80;
  }), 'batch fixed layout');
  await page.waitForTimeout(120);
  const overflowStates = await Promise.all(['a', 'b'].map((id) => page.getByTestId(`node-${id}`).locator('.map-node__label').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    display: getComputedStyle(element).display,
    lineClamp: getComputedStyle(element).webkitLineClamp,
  }))));
  assert(overflowStates.every((state) => state.display === 'flow-root' || state.lineClamp !== 'none'),
    `Fixed cards did not apply clamping: ${JSON.stringify(overflowStates)}`);

  const source = await fs.readFile(mapPath, 'utf8');
  assert(source.includes('%% mlc-node-layout: a|fixed|260|80'), 'Card A layout was not saved to Mermaid.');
  assert(source.includes('%% mlc-node-layout: b|fixed|260|80'), 'Card B layout was not saved to Mermaid.');
  const desktopScreenshot = path.join(evidenceDir, 'batch-fixed-desktop.png');
  await page.screenshot({ path: desktopScreenshot, fullPage: true });

  await page.setViewportSize({ width: 390, height: 820 });
  await page.waitForTimeout(100);
  const mobileScreenshot = path.join(evidenceDir, 'layout-panel-390.png');
  await page.screenshot({ path: mobileScreenshot, fullPage: true });
  const panelBox = await page.getByTestId('inspector').boundingBox();
  assert(panelBox && panelBox.x >= 0 && panelBox.x + panelBox.width <= 390,
    `Mobile layout panel is clipped: ${JSON.stringify(panelBox)}`);

  const report = {
    overlap: { initialPairs: [['a', 'b'], ['a1', 'b1']], finalPairs: arrangedMetrics.overlapPairs },
    moveHistory: { beforeMove, movedPosition, undo: true, redo: true },
    inlineEditor: editorMetrics,
    fitWidth: fittedWidth,
    resize: {
      handleCount,
      resizeLineCount,
      resizedLayout,
      liveResizeGeometry,
      savedResizeGeometry,
      maximumReverse: {
        maximumLiveWidth,
        reversedLiveWidth,
        maximumWidthDelta,
        reversedWidthDelta,
        anchoredTopLeft: beforeMaximumById.a,
        livePushedIds,
        liveOverlapPairs: maximumMetrics.overlapPairs,
        savedAfterReverse: reversedAtMaximum.graph.nodes.find((node) => node.id === 'a').layout,
        savedAtMaximum: 720,
        shrunkAfterMaximum: shrunkAfterMaximum.graph.nodes.find((node) => node.id === 'a').layout,
      },
      undo: true,
      redo: true,
    },
    batch: {
      selectedIds,
      wrapHeights,
      fixedLayouts: ['a', 'b'].map((id) => fixedBatch.graph.nodes.find((node) => node.id === id).layout),
      overflowStates,
      canonicalMermaid: true,
    },
    screenshots: [
      path.relative(root, liveResizeScreenshot),
      path.relative(root, savedResizeScreenshot),
      path.relative(root, desktopScreenshot),
      path.relative(root, mobileScreenshot),
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
