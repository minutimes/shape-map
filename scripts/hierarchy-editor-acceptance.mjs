#!/usr/bin/env node
/*
 * Browser check for the detailed hierarchy editor (`?editor=1`) on a copy of
 * maps/demo.mmd: direct editing, keyboard creation, branch drag, copy/cut/paste,
 * selection, navigation, folding, restart persistence, external and invalid
 * source, a stale-edit conflict, and the toolbar at three widths.
 * Evidence: test-results/hierarchy-editor/.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  assert, cardOverlap, evidenceDir as makeEvidenceDir, launchBrowser, root, startServer, waitUntil as baseWaitUntil,
} from './support/browser-check.mjs';

let evidenceDir;
let mapPath;
let origin;
let server;
let browser;
const report = { checks: {}, screenshots: {} };
const browserDiagnostics = [];

const waitUntil = (check, { timeoutMs = 5000, intervalMs = 35, message } = {}) => baseWaitUntil(check, { timeoutMs, intervalMs, message });

async function snapshot() {
  const response = await fetch(`${origin}/api/map`);
  if (!response.ok) throw new Error(`snapshot failed: HTTP ${response.status}`);
  return response.json();
}

async function mutate(operation, clientId = 'hierarchy-editor-external') {
  const current = await snapshot();
  const response = await fetch(`${origin}/api/mutations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: current.revision, clientId, operation }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`mutation failed: ${body.message || response.status}`);
  return body;
}

async function waitForNode(id, predicate, message) {
  return waitUntil(async () => {
    const current = await snapshot();
    const node = current.graph.nodes.find((item) => item.id === id);
    return node && predicate(node, current) ? { node, current } : false;
  }, { message });
}

// The inspector has two 저장 buttons: the name form and the detail form.
function renameSaveButton(targetPage) {
  return targetPage.locator('form', { has: targetPage.getByTestId('rename-input') }).getByRole('button', { name: '저장', exact: true });
}

// Waits until the editor is idle and no card moves between two frames apart.
async function settleCanvas(targetPage) {
  await waitUntil(() => targetPage.getByTestId('add-root-child-button').isEnabled(), { message: 'Editor did not become idle' });
  const boxes = () => targetPage.locator('.react-flow__node').evaluateAll((nodes) => JSON.stringify(nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return [node.dataset.id, Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)];
  })));
  let previous = await boxes();
  await waitUntil(async () => {
    await targetPage.waitForTimeout(150);
    const current = await boxes();
    const stable = current === previous;
    previous = current;
    return stable;
  }, { message: 'Canvas did not settle' });
}

async function openInspectorFor(targetPage, id) {
  await targetPage.getByTestId(`node-${id}`).click();
  const inspector = targetPage.getByTestId('inspector');
  if (!(await inspector.isVisible())) await targetPage.getByTestId('properties-button').click();
  await inspector.waitFor({ state: 'visible' });
}

async function selectNode(targetPage, id, { force = false } = {}) {
  const node = targetPage.getByTestId(`node-${id}`);
  if (force) await node.evaluate((element) => element.click());
  else await node.click();
  await waitUntil(() => node.evaluate((element) => element.classList.contains('is-selected')), {
    message: `Node ${id} did not become the active selection`,
  });
}

async function arrangeAndFit(targetPage) {
  const arrange = targetPage.getByTestId('arrange-visible-button');
  try {
    await waitUntil(async () => (
      await arrange.count() > 0 && await arrange.isEnabled({ timeout: 250 })
    ), { message: 'Arrange action did not become ready' });
  } catch (error) {
    const body = await targetPage.locator('body').innerText({ timeout: 500 }).catch(() => '<body unavailable>');
    throw new Error(`${error.message}; url=${targetPage.url()}; body=${body.slice(0, 600)}; browser=${browserDiagnostics.join(' | ')}`);
  }
  await arrange.click();
  await waitUntil(() => arrange.isEnabled(), { message: 'Arrange action did not finish' });
  await targetPage.keyboard.press('Control+0');
  await targetPage.waitForTimeout(260);
}

async function visibleNodeOverlap(page) {
  const { nodeCount, overlapPairs } = await cardOverlap(page);
  return { nodeCount, overlapPairs };
}

async function run() {
  evidenceDir = await makeEvidenceDir('hierarchy-editor');
  mapPath = path.join(evidenceDir, 'map.mmd');
  await fs.copyFile(path.join(root, 'maps', 'demo.mmd'), mapPath);
  server = await startServer({ FINAL_SHAPE_MAP_DATA_ROOT: evidenceDir, FINAL_SHAPE_MAP_PATH: 'map.mmd' });
  origin = server.origin;
  browser = await launchBrowser();
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await context.addInitScript(() => localStorage.setItem('final-shape-map-workflow-mode', 'false'));
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  page.on('pageerror', (error) => browserDiagnostics.push(`pageerror:${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') browserDiagnostics.push(`console:${message.text()}`);
  });
  await page.goto(`${origin}?editor=1`, { waitUntil: 'networkidle' });
  await page.getByTestId('node-direction').waitFor();
  assert(await page.getByRole('heading', { name: 'Shape map', exact: true }).isVisible(),
    'Product title is not visible.');
  assert(await page.getByText('영상 설계 지도', { exact: true }).isVisible(), 'Korean root label is not visible.');
  assert(await page.getByTestId('legend').isVisible(), 'Legend is not visible.');
  const visualMetrics = await page.getByTestId('node-direction').evaluate((node) => {
    const label = node.querySelector('.map-node__label');
    const meta = node.querySelector('.map-node__meta');
    return {
      labelFontSize: Number.parseFloat(getComputedStyle(label).fontSize),
      metaFontSize: Number.parseFloat(getComputedStyle(meta).fontSize),
      metaParts: meta.querySelectorAll('span').length,
      depth: node.dataset.depth,
    };
  });
  assert(visualMetrics.labelFontSize >= 15 && visualMetrics.metaFontSize >= 10.5,
    `Card typography is too small: ${JSON.stringify(visualMetrics)}`);
  assert(visualMetrics.metaParts === 2 && visualMetrics.depth === '0',
    `Hierarchy/category metadata is incomplete: ${JSON.stringify(visualMetrics)}`);
  report.checks.initialRender = { productTitle: true, visualMetrics };
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(220);
  const overviewPath = path.join(evidenceDir, 'default-overview-1280.png');
  await page.screenshot({ path: overviewPath, fullPage: true });
  report.screenshots.defaultOverview = { path: path.relative(root, overviewPath), viewportWidth: 1280 };

  // Canvas overlays collapse into one icon each, persist through reload, and
  // expand back into their original corners.
  await page.getByTestId('legend-collapse-button').click();
  await page.getByTestId('minimap-collapse-button').click();
  await page.getByTestId('legend').waitFor({ state: 'detached' });
  await page.getByTestId('rf__minimap').waitFor({ state: 'detached' });
  const compactOverlaysPath = path.join(evidenceDir, 'compact-overlays-1280.png');
  await page.screenshot({ path: compactOverlaysPath, fullPage: true });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('legend-expand-button').waitFor({ state: 'visible' });
  await page.getByTestId('minimap-expand-button').waitFor({ state: 'visible' });
  await page.getByTestId('legend-expand-button').click();
  await page.getByTestId('minimap-expand-button').click();
  await page.getByTestId('legend').waitFor({ state: 'visible' });
  await page.getByTestId('rf__minimap').waitFor({ state: 'visible' });
  report.checks.overlayCollapsePersistence = {
    legend: true,
    minimap: true,
    reloadRestored: true,
  };
  report.screenshots.compactOverlays = {
    path: path.relative(root, compactOverlaysPath),
    viewportWidth: 1280,
  };

  // Direct visual add, rename, presentation edit, and semantic reparent.
  await page.getByTestId('node-planning').click();
  assert(!(await page.getByTestId('inspector').isVisible()), 'Selecting a card opened the inspector automatically.');
  assert(await page.getByTestId('properties-button').isEnabled(), 'Explicit properties action did not enable after selection.');
  const selectedOutline = await page.getByTestId('node-planning').evaluate(
    (node) => Number.parseFloat(getComputedStyle(node).outlineWidth),
  );
  assert(selectedOutline >= 3, `Selected card outline is too subtle: ${selectedOutline}px`);
  await page.getByTestId('copy-key-planning').click();
  const copiedNodeKey = await page.evaluate(() => navigator.clipboard.readText());
  assert(copiedNodeKey === 'planning', `Card key copy returned ${JSON.stringify(copiedNodeKey)}.`);
  report.checks.selectionPreservesCanvas = { inspectorClosed: true, selectedOutline };
  await page.getByTestId('properties-button').click();
  await page.getByTestId('inspector').waitFor({ state: 'visible' });
  await page.getByTestId('inspector-copy-key').click();
  const inspectorCopiedNodeKey = await page.evaluate(() => navigator.clipboard.readText());
  assert(inspectorCopiedNodeKey === 'planning',
    `Inspector key copy returned ${JSON.stringify(inspectorCopiedNodeKey)}.`);
  report.checks.nodeKeyCopy = {
    card: copiedNodeKey,
    inspector: inspectorCopiedNodeKey,
    rawStableId: true,
  };
  const editorPath = path.join(evidenceDir, 'explicit-editor-1280.png');
  await page.screenshot({ path: editorPath, fullPage: true });
  report.screenshots.explicitEditor = { path: path.relative(root, editorPath), viewportWidth: 1280 };
  await page.getByTestId('new-child-input').fill('브라우저 추가');
  await page.getByTestId('add-child-button').click();
  const added = await waitUntil(async () => {
    const current = await snapshot();
    const node = current.graph.nodes.find((item) => item.label === '브라우저 추가');
    return node ? { node, current } : false;
  }, { message: 'Visual child add did not reach the canonical source' });
  const addedId = added.node.id;
  await page.getByTestId(`node-${addedId}`).waitFor({ state: 'visible' });
  await page.getByTestId('rename-input').fill('브라우저 이름 변경');
  await renameSaveButton(page).click();
  await waitForNode(addedId, (node) => node.label === '브라우저 이름 변경', 'Visual rename did not save');

  await page.getByTestId('shape-rounded').click();
  await waitForNode(addedId, (node) => node.shape === 'rounded', 'Rounded presentation did not save');
  await waitUntil(async () => page.getByTestId('shape-rounded').getAttribute('aria-pressed').then((value) => value === 'true'), {
    message: 'Rounded presentation did not settle in the editor',
  });
  await page.getByTestId('category-select').selectOption('stage');
  await waitForNode(addedId, (node) => node.category === 'stage', 'Category presentation did not save');
  await waitUntil(async () => page.getByTestId('category-select').evaluate((select) => select.value === 'stage'), {
    message: 'Category presentation did not settle in the editor',
  });
  await page.getByText('현재 범례 색상 다듬기', { exact: true }).click();
  await page.getByTestId('style-outline').click();
  await waitUntil(async () => {
    const current = await snapshot();
    return current.graph.categories.find((category) => category.id === 'stage')?.fill === '#FFFDF7';
  }, { message: 'Outline palette did not save to classDef' });
  await waitUntil(async () => page.getByTestId('node-live').evaluate(
    (node) => getComputedStyle(node).backgroundColor === 'rgb(255, 253, 247)',
  ), { message: 'Outline palette did not settle on the open canvas' });
  await page.getByTestId('parent-select').selectOption('shortform');
  await waitUntil(async () => (
    await page.getByTestId('parent-select').evaluate((select) => select.value === 'shortform')
    && await page.getByTestId('reparent-button').isEnabled()
  ), { message: 'Reparent control did not settle after presentation save' });
  await page.getByTestId('reparent-button').click();
  await waitForNode(addedId, (node) => node.parentId === 'shortform', 'Visual reparent did not save');
  report.checks.directVisualRoundTrip = { id: addedId, label: '브라우저 이름 변경', shape: 'rounded', category: 'stage', parentId: 'shortform', fill: '#FFFDF7' };
  await page.getByTestId('inspector-close').click();
  await page.getByTestId('inspector').waitFor({ state: 'hidden' });

  // Mind-map creation grammar: Tab adds a child, Enter adds a sibling, and both
  // new cards immediately focus an empty inline editor.
  await selectNode(page, 'stages');
  await page.keyboard.press('Tab');
  const tabInput = page.getByTestId('inline-rename-input');
  await tabInput.waitFor({ state: 'visible', timeout: 5000 });
  await waitUntil(async () => (
    await tabInput.count() === 1
    && await tabInput.evaluate((input) => document.activeElement === input && input.value === '')
  ), {
    message: 'Tab child did not enter an empty focused editor',
  });
  await tabInput.fill('Tab으로 만든 하위');
  await tabInput.press('Enter');
  const tabChild = await waitUntil(async () => {
    const current = await snapshot();
    const node = current.graph.nodes.find((item) => item.label === 'Tab으로 만든 하위');
    return node?.parentId === 'stages' ? node : false;
  }, { message: 'Tab did not create and rename a child under the selected card' });

  await page.getByTestId('inline-rename-input').waitFor({ state: 'detached', timeout: 5000 });
  await waitUntil(() => page.getByTestId('add-root-child-button').isEnabled(), {
    message: 'Tab child rename did not finish before the next keyboard action',
  });
  await page.keyboard.press('Enter');
  const enterInput = page.getByTestId('inline-rename-input');
  await enterInput.waitFor({ state: 'visible', timeout: 5000 });
  await waitUntil(async () => (
    await enterInput.count() === 1
    && await enterInput.evaluate((input) => document.activeElement === input && input.value === '')
  ), {
    message: 'Enter sibling did not enter an empty focused editor',
  });
  await enterInput.fill('Enter로 만든 형제');
  await enterInput.press('Enter');
  const enterSibling = await waitUntil(async () => {
    const current = await snapshot();
    const node = current.graph.nodes.find((item) => item.label === 'Enter로 만든 형제');
    return node?.parentId === 'stages' ? node : false;
  }, { message: 'Enter did not create and rename a sibling at the same level' });

  // Shift+Tab retains the requested keyboard-only outdent behavior.
  await page.getByTestId('inline-rename-input').waitFor({ state: 'detached', timeout: 5000 });
  await waitUntil(() => page.getByTestId('add-root-child-button').isEnabled(), {
    message: 'Enter sibling rename did not finish before outdent',
  });
  await page.keyboard.press('Shift+Tab');
  await waitForNode(enterSibling.id, (node) => node.parentId === 'live', 'Shift+Tab did not outdent the selected branch');
  report.checks.keyboardNodeCreation = {
    tabChildId: tabChild.id,
    enterSiblingId: enterSibling.id,
    immediateEditing: true,
    shiftTabOutdent: true,
  };

  // Dragging a parent moves every descendant by the exact same canvas delta.
  // The camera follows the last edit; fit the whole map so the branch is in
  // view, and measure only once the outdent's rearrangement has settled.
  await page.keyboard.press('Control+0');
  await settleCanvas(page);
  const branchIds = ['stages', 'stage1', 'stage15', tabChild.id];
  const beforeBranchSnapshot = await snapshot();
  const beforeBranchPositions = Object.fromEntries(branchIds.map((id) => [
    id,
    { ...beforeBranchSnapshot.view.positions[id] },
  ]));
  const beforeBranchBoxes = Object.fromEntries(await Promise.all(branchIds.map(async (id) => [
    id,
    await page.getByTestId(`node-${id}`).boundingBox(),
  ])));
  assert(branchIds.every((id) => beforeBranchBoxes[id]), 'A branch node was unavailable before drag.');
  const branchRootBox = beforeBranchBoxes.stages;
  const grabTarget = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid^="node-"]')?.dataset.testid,
    { x: branchRootBox.x + branchRootBox.width / 2, y: branchRootBox.y + branchRootBox.height / 2 });
  assert(grabTarget === 'node-stages', `The branch card is not under the pointer before the drag: ${grabTarget}`);
  await page.mouse.move(branchRootBox.x + branchRootBox.width / 2, branchRootBox.y + branchRootBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    branchRootBox.x + branchRootBox.width / 2 + 36,
    branchRootBox.y + branchRootBox.height / 2 - 24,
    { steps: 8 },
  );
  await page.mouse.up();
  const persistedBranch = await waitUntil(async () => {
    const current = await snapshot();
    if (!branchIds.every((id) => current.view.positions[id])) return false;
    const rootPositionDelta = {
      x: current.view.positions.stages.x - beforeBranchPositions.stages.x,
      y: current.view.positions.stages.y - beforeBranchPositions.stages.y,
    };
    if (!rootPositionDelta.x && !rootPositionDelta.y) return false;
    const movedTogether = branchIds.slice(1).every((id) => (
      Math.abs(current.view.positions[id].x - beforeBranchPositions[id].x - rootPositionDelta.x) < 0.01
      && Math.abs(current.view.positions[id].y - beforeBranchPositions[id].y - rootPositionDelta.y) < 0.01
    ));
    if (!movedTogether) throw new Error(JSON.stringify({
      before: beforeBranchPositions,
      after: Object.fromEntries(branchIds.map((id) => [id, current.view.positions[id]])),
      rootPositionDelta,
    }));
    return current;
  }, { message: 'Dragged branch positions were not persisted for every descendant' });
  await page.waitForTimeout(80);
  assert(persistedBranch.graph.nodes.find((node) => node.id === 'stage1')?.parentId === 'stages'
    && persistedBranch.graph.nodes.find((node) => node.id === 'stage15')?.parentId === 'stages'
    && persistedBranch.graph.nodes.find((node) => node.id === tabChild.id)?.parentId === 'stages',
  'Spatial branch drag changed semantic parentage.');
  const afterBranchBoxes = Object.fromEntries(await Promise.all(branchIds.map(async (id) => [
    id,
    await page.getByTestId(`node-${id}`).boundingBox(),
  ])));
  const rootDelta = {
    x: afterBranchBoxes.stages.x - beforeBranchBoxes.stages.x,
    y: afterBranchBoxes.stages.y - beforeBranchBoxes.stages.y,
  };
  for (const id of branchIds.slice(1)) {
    const delta = {
      x: afterBranchBoxes[id].x - beforeBranchBoxes[id].x,
      y: afterBranchBoxes[id].y - beforeBranchBoxes[id].y,
    };
    assert(Math.abs(delta.x - rootDelta.x) < 1.5 && Math.abs(delta.y - rootDelta.y) < 1.5,
      `Descendant ${id} did not follow its parent: ${JSON.stringify({ rootDelta, delta })}`);
  }
  report.checks.branchDrag = {
    rootId: 'stages',
    descendantIds: branchIds.slice(1),
    delta: rootDelta,
    persistedIds: branchIds.filter((id) => persistedBranch.view.positions[id]),
    hierarchyPreserved: true,
  };

  // Cmd copy/paste duplicates the selected subtree with fresh stable IDs.
  const beforeCopy = await snapshot();
  const copiedIds = new Set(['stages']);
  let foundDescendant = true;
  while (foundDescendant) {
    foundDescendant = false;
    beforeCopy.graph.nodes.forEach((node) => {
      if (node.parentId && copiedIds.has(node.parentId) && !copiedIds.has(node.id)) {
        copiedIds.add(node.id);
        foundDescendant = true;
      }
    });
  }
  await selectNode(page, 'stages', { force: true });
  await page.keyboard.press('Meta+C');
  await selectNode(page, 'shortform', { force: true });
  await page.keyboard.press('Meta+V');
  const afterCopy = await waitUntil(async () => {
    const current = await snapshot();
    return current.graph.nodes.length === beforeCopy.graph.nodes.length + copiedIds.size ? current : false;
  }, { message: 'Cmd+C/V did not clone the selected branch' });
  const freshNodes = afterCopy.graph.nodes.filter((node) => !beforeCopy.graph.nodes.some((old) => old.id === node.id));
  assert(freshNodes.length === copiedIds.size, 'Copied subtree did not create one fresh ID per source node.');
  assert(freshNodes.every((node) => !copiedIds.has(node.id)), 'Copied subtree reused a source ID.');
  assert(freshNodes.some((node) => node.parentId === 'shortform'), 'Copied root was not attached to the selected parent.');
  report.checks.copyPasteFreshIds = freshNodes.map(({ id, parentId }) => ({ id, parentId }));

  // The Control form also performs a real copy/paste round trip.
  const beforeControlCopy = await snapshot();
  await selectNode(page, addedId, { force: true });
  await page.keyboard.press('Control+C');
  await selectNode(page, 'live', { force: true });
  await page.keyboard.press('Control+V');
  const afterControlCopy = await waitUntil(async () => {
    const current = await snapshot();
    return current.graph.nodes.length === beforeControlCopy.graph.nodes.length + 1 ? current : false;
  }, { message: 'Control+C/V did not clone the selected leaf' });
  const controlCopy = afterControlCopy.graph.nodes.find(
    (node) => !beforeControlCopy.graph.nodes.some((old) => old.id === node.id),
  );
  assert(controlCopy && controlCopy.id !== addedId && controlCopy.parentId === 'live',
    'Control+C/V did not produce a fresh child under the selected parent.');
  await page.getByTestId(`node-${controlCopy.id}`).waitFor({ state: 'visible', timeout: 5000 });
  await waitUntil(() => page.getByTestId('add-root-child-button').isEnabled({ timeout: 250 }), {
    message: 'Control+C/V did not finish before the external cleanup',
  });
  await mutate({ type: 'deleteLeaf', id: controlCopy.id });
  await page.getByTestId(`node-${controlCopy.id}`).waitFor({ state: 'detached', timeout: 5000 });

  // Ctrl cut/paste defers deletion and performs one safe move at paste time.
  await arrangeAndFit(page);
  await selectNode(page, 'original', { force: true });
  await page.keyboard.press('Control+X');
  assert((await snapshot()).graph.nodes.some((node) => node.id === 'original'), 'Cut removed the source before paste.');
  await selectNode(page, 'live', { force: true });
  await page.keyboard.press('Control+V');
  await waitForNode('original', (node) => node.parentId === 'live', 'Ctrl+X/V did not move the branch');
  report.checks.deferredCutPaste = true;

  // The Meta form moves the same branch back without deleting it before paste.
  await arrangeAndFit(page);
  await selectNode(page, 'original', { force: true });
  await page.keyboard.press('Meta+X');
  assert((await snapshot()).graph.nodes.some((node) => node.id === 'original'), 'Meta+X removed the source before paste.');
  await selectNode(page, 'shortform', { force: true });
  await page.keyboard.press('Meta+V');
  await waitForNode('original', (node) => node.parentId === 'shortform', 'Meta+X/V did not move the branch');

  // Both modifier forms select all currently visible nodes on the canvas.
  await selectNode(page, 'live', { force: true });
  await page.keyboard.press('Control+A');
  const controlSelectedCount = await page.locator('.react-flow__node.selected').count();
  const visibleCount = await page.locator('.react-flow__node').count();
  assert(controlSelectedCount === visibleCount && visibleCount > 0,
    `Ctrl+A selected ${controlSelectedCount}/${visibleCount} nodes.`);
  await selectNode(page, 'planning', { force: true });
  await page.keyboard.press('Meta+A');
  const metaSelectedCount = await page.locator('.react-flow__node.selected').count();
  assert(metaSelectedCount === visibleCount, `Meta+A selected ${metaSelectedCount}/${visibleCount} nodes.`);
  report.checks.selectAll = { controlSelectedCount, metaSelectedCount, visibleCount };
  report.checks.modifierShortcuts = {
    metaCopyPaste: true,
    controlCopyPaste: true,
    controlCutPaste: true,
    metaCutPaste: true,
    controlSelectAll: true,
    metaSelectAll: true,
  };

  // Every visible node must occupy a distinct canvas rectangle after adds and copies.
  const nodeOverlap = await visibleNodeOverlap(page);
  assert(nodeOverlap.overlapPairs.length === 0,
    `Visible node rectangles overlap: ${JSON.stringify(nodeOverlap.overlapPairs)}`);
  report.checks.nodeOverlap = nodeOverlap;

  // Native text editing keeps its own select-all behavior.
  await openInspectorFor(page, 'planning');
  const renameInput = page.getByTestId('rename-input');
  await renameInput.click();
  await page.keyboard.press('Meta+A');
  const textSelection = await renameInput.evaluate((input) => ({
    start: input.selectionStart,
    end: input.selectionEnd,
    length: input.value.length,
  }));
  assert(textSelection.start === 0 && textSelection.end === textSelection.length,
    'Meta+A was intercepted while a text input was focused.');
  report.checks.inputShortcutIsolation = textSelection;

  // Keyboard and pointer zoom/pan remain on the canvas.
  const viewport = page.locator('.react-flow__viewport');
  await page.getByTestId('node-planning').click();
  const beforeKeyZoom = await viewport.getAttribute('style');
  await page.keyboard.press('Control++');
  await page.waitForTimeout(180);
  const afterKeyZoom = await viewport.getAttribute('style');
  assert(beforeKeyZoom !== afterKeyZoom, 'Control++ did not change the viewport.');
  await page.keyboard.press('Control+0');

  const canvasBox = await page.getByTestId('map-canvas').boundingBox();
  assert(canvasBox, 'Canvas bounds are unavailable.');
  const startX = canvasBox.x + canvasBox.width * 0.72;
  const startY = canvasBox.y + canvasBox.height * 0.72;
  const beforeRightPan = await viewport.getAttribute('style');
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(startX - 90, startY - 55, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  const afterRightPan = await viewport.getAttribute('style');
  assert(beforeRightPan !== afterRightPan, 'Right-button drag did not pan the canvas.');

  const beforeCtrlWheel = await viewport.getAttribute('style');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -180);
  await page.keyboard.up('Control');
  const afterCtrlWheel = await viewport.getAttribute('style');
  assert(beforeCtrlWheel !== afterCtrlWheel, 'Control+wheel did not zoom the canvas.');
  report.checks.navigation = { keyZoom: true, rightDragPan: true, ctrlWheelZoom: true };

  // Opening one branch reserves its full vertical band and cascades the new
  // footprint into every lower sibling branch.
  await page.getByTestId('toggle-stages').click();
  const foldedStages = await waitUntil(async () => {
    const current = await snapshot();
    return current.view.collapsedIds.includes('stages') ? current : false;
  }, { message: 'Stage branch did not collapse' });
  assert((await page.getByTestId('notice').count()) === 0,
    'Routine branch collapse showed a redundant success toast.');
  await page.getByTestId('node-stage1').waitFor({ state: 'hidden' });
  const stagesNode = foldedStages.graph.nodes.find((node) => node.id === 'stages');
  const stagesPosition = foldedStages.view.positions.stages;
  const lowerStageSiblings = foldedStages.graph.nodes
    .filter((node) => (
      node.parentId === stagesNode.parentId
      && node.id !== stagesNode.id
      && foldedStages.view.positions[node.id]?.y > stagesPosition.y
    ))
    .map((node) => node.id);
  const lowerBeforeExpand = Object.fromEntries(lowerStageSiblings.map((id) => [
    id,
    { ...foldedStages.view.positions[id] },
  ]));
  await page.getByTestId('toggle-stages').click();
  await page.getByTestId('node-stage1').waitFor({ state: 'visible' });
  const expandedStages = await waitUntil(async () => {
    const current = await snapshot();
    return !current.view.collapsedIds.includes('stages') ? current : false;
  }, { message: 'Stage branch did not expand' });
  assert((await page.getByTestId('notice').count()) === 0,
    'Routine branch expansion showed a redundant success toast.');
  assert(expandedStages.view.positions.stages.x === stagesPosition.x
    && expandedStages.view.positions.stages.y === stagesPosition.y,
  'Expanding a branch moved the toggled card.');
  assert(lowerStageSiblings.length > 0
    && lowerStageSiblings.some((id) => expandedStages.view.positions[id].y > lowerBeforeExpand[id].y),
  'Opening the stage branch did not move any lower sibling branch down.');
  const expandedStageOverlap = await visibleNodeOverlap(page);
  assert(expandedStageOverlap.overlapPairs.length === 0,
    `Expanded branch overlaps neighboring branches: ${JSON.stringify(expandedStageOverlap.overlapPairs)}`);
  report.checks.collapseExpand = {
    toggledCardFixed: true,
    redundantSuccessToast: false,
    shiftedLowerBranches: lowerStageSiblings.filter(
      (id) => expandedStages.view.positions[id].y > lowerBeforeExpand[id].y,
    ),
    overlapPairs: expandedStageOverlap.overlapPairs,
  };

  // Global collapse keeps an overview, persists across a real restart, and a
  // global expand restores every node in one non-overlapping layout.
  const beforeCollapseAll = await snapshot();
  const parentIds = new Set(beforeCollapseAll.graph.nodes.map((node) => node.parentId).filter(Boolean));
  const expectedCollapsedIds = beforeCollapseAll.graph.nodes
    .filter((node) => node.parentId && parentIds.has(node.id))
    .map((node) => node.id)
    .sort();
  await page.getByTestId('collapse-all-button').click();
  await waitUntil(async () => {
    const ids = [...(await snapshot()).view.collapsedIds].sort();
    return JSON.stringify(ids) === JSON.stringify(expectedCollapsedIds);
  }, { message: 'Global collapsed state did not persist to the view sidecar' });
  const collapsedAllOverlap = await visibleNodeOverlap(page);
  assert(collapsedAllOverlap.overlapPairs.length === 0,
    `Global collapse left overlaps: ${JSON.stringify(collapsedAllOverlap.overlapPairs)}`);
  await server.restart();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('expand-all-button').waitFor();
  const restartedCollapsedIds = [...(await snapshot()).view.collapsedIds].sort();
  assert(JSON.stringify(restartedCollapsedIds) === JSON.stringify(expectedCollapsedIds),
    'Global collapsed state did not survive restart.');
  await page.getByTestId('expand-all-button').click();
  await waitUntil(async () => (await snapshot()).view.collapsedIds.length === 0, {
    message: 'Global expand did not clear the persisted collapsed state',
  });
  await waitUntil(async () => (
    await page.locator('.react-flow__node').count()
  ) === (await snapshot()).graph.nodes.length, {
    message: 'Global expand did not reveal every graph node',
  });
  const expandedAllOverlap = await visibleNodeOverlap(page);
  assert(expandedAllOverlap.overlapPairs.length === 0,
    `Global expand left overlaps: ${JSON.stringify(expandedAllOverlap.overlapPairs)}`);
  const expandedAllPath = path.join(evidenceDir, 'all-branches-expanded-1280.png');
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(260);
  await page.screenshot({ path: expandedAllPath, fullPage: true });
  report.screenshots.allBranchesExpanded = {
    path: path.relative(root, expandedAllPath),
    viewportWidth: 1280,
  };
  report.checks.globalCollapseExpandPersistence = {
    collapsedBranchCount: expectedCollapsedIds.length,
    restartRestored: true,
    expandedNodeCount: expandedAllOverlap.nodeCount,
    overlapPairs: expandedAllOverlap.overlapPairs,
  };

  // External source writes update the already-open canvas, and invalid text is recoverable.
  const beforeExternal = await fs.readFile(mapPath, 'utf8');
  const externalSource = beforeExternal.replace(
    /planning(?:\(\[|\[)"기획"(?:\]\)|\])/,
    'planning(["외부 파일 반영"])',
  );
  assert(externalSource !== beforeExternal, 'External edit fixture did not find the planning node.');
  const externalStarted = performance.now();
  await fs.writeFile(mapPath, externalSource, 'utf8');
  const externalPlanningLabel = page.getByTestId('node-planning').getByText('외부 파일 반영', { exact: true });
  await externalPlanningLabel.waitFor({ state: 'visible', timeout: 5000 });
  const externalLatencyMs = Math.round(performance.now() - externalStarted);
  report.checks.externalCanvasLatencyMs = externalLatencyMs;

  const lastValidNodeCount = (await snapshot()).graph.nodes.length;
  const invalidSource = `${externalSource}\n  this is not supported mermaid\n`;
  await fs.writeFile(mapPath, invalidSource, 'utf8');
  await page.getByTestId('source-error-banner').waitFor({ state: 'visible', timeout: 5000 });
  assert((await fs.readFile(mapPath, 'utf8')) === invalidSource, 'Invalid source was overwritten.');
  assert(await externalPlanningLabel.isVisible(), 'Last valid canvas disappeared on invalid source.');
  assert((await snapshot()).graph.nodes.length === lastValidNodeCount, 'Invalid source replaced the last valid graph.');
  await fs.writeFile(mapPath, externalSource, 'utf8');
  await page.getByTestId('source-error-banner').waitFor({ state: 'hidden', timeout: 5000 });
  report.checks.invalidSourceRecovery = true;

  // A page with SSE intentionally unavailable produces a visible stale-edit conflict.
  const stalePage = await context.newPage();
  await stalePage.route('**/api/events', (route) => route.abort());
  await stalePage.goto(`${origin}?editor=1`, { waitUntil: 'domcontentloaded' });
  await stalePage.getByTestId('node-original').waitFor();
  await stalePage.keyboard.press('Control+0');
  await stalePage.waitForTimeout(220);
  await mutate({ type: 'renameNode', id: 'original', label: '외부 충돌 변경' });
  await openInspectorFor(stalePage, 'original');
  await stalePage.getByTestId('rename-input').fill('오래된 화면 변경');
  await renameSaveButton(stalePage).click();
  await stalePage.getByTestId('conflict-banner').waitFor({ state: 'visible', timeout: 5000 });
  const afterConflict = await snapshot();
  assert(afterConflict.graph.nodes.find((node) => node.id === 'original').label === '외부 충돌 변경',
    'Stale UI edit overwrote the newer external label.');
  await stalePage.getByTestId('conflict-cancel').click();
  await stalePage.close();
  report.checks.visibleConflict = true;

  // External changes invalidate local undo instead of overwriting newer work.
  await page.getByTestId('node-original').getByText('외부 충돌 변경', { exact: true })
    .waitFor({ state: 'visible', timeout: 5000 });
  await openInspectorFor(page, 'planning');
  await page.getByTestId('rename-input').fill('실행 취소 후보');
  await renameSaveButton(page).click();
  await waitForNode('planning', (node) => node.label === '실행 취소 후보', 'UI rename for undo test did not save');
  await waitUntil(async () => page.getByTestId('undo-button').isEnabled(), {
    message: 'Undo was not enabled after a local edit',
  });
  await mutate({ type: 'renameNode', id: 'original', label: '외부 변경 유지' });
  await waitUntil(async () => !(await page.getByTestId('undo-button').isEnabled()), {
    message: 'External edit did not invalidate local undo',
  });
  report.checks.externalInvalidatesUndo = true;

  // Persist fold state through a real server restart.
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(220);
  await page.getByTestId('toggle-shortform').click();
  await waitUntil(async () => (await snapshot()).view.collapsedIds.includes('shortform'), {
    message: 'Collapsed state did not persist to the view sidecar',
  });
  await server.restart();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('toggle-shortform').waitFor();
  assert((await page.getByTestId('toggle-shortform').getAttribute('aria-expanded')) === 'false',
    'Collapsed state did not survive restart.');
  const reopened = await snapshot();
  const reopenedAdded = reopened.graph.nodes.find((node) => node.id === addedId);
  assert(reopenedAdded?.label === '브라우저 이름 변경'
    && reopenedAdded.parentId === 'shortform'
    && reopenedAdded.shape === 'rounded'
    && reopenedAdded.category === 'stage', 'Visual node presentation did not survive restart.');
  assert(reopened.graph.categories.find((category) => category.id === 'stage')?.fill === '#FFFDF7',
    'Legend palette did not survive restart.');
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(220);
  await page.getByTestId('toggle-shortform').click();
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(220);
  const restartedOverlap = await visibleNodeOverlap(page);
  assert(restartedOverlap.overlapPairs.length === 0,
    `Node rectangles overlap after restart: ${JSON.stringify(restartedOverlap.overlapPairs)}`);
  report.checks.nodeOverlapAfterRestart = restartedOverlap;
  report.checks.restartPersistence = true;

  // Responsive visual evidence and explicit clipping bounds.
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 820 });
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(220);
    await page.getByTestId('node-planning').click();
    await page.getByTestId('properties-button').waitFor({ state: 'visible' });
    await page.getByTestId('add-root-child-button').waitFor({ state: 'visible' });
    const actionBox = await page.getByTestId('add-root-child-button').boundingBox();
    assert(actionBox && actionBox.x >= 0 && actionBox.x + actionBox.width <= width,
      `Primary action is clipped at ${width}px: ${JSON.stringify(actionBox)}`);
    const topbarButtons = await page.locator('.topbar button:visible').evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { label: button.getAttribute('aria-label') || button.textContent.trim(), x: rect.x, right: rect.right, height: rect.height };
    }));
    assert(topbarButtons.every((button) => (
      button.x >= 0 && button.right <= width && button.height >= 40 && button.height <= 48
    )),
      `Toolbar target is clipped or undersized at ${width}px: ${JSON.stringify(topbarButtons)}`);
    // Phone widths start with the minimap folded, so each overlay has one toggle in either state.
    const overlayControls = await page.locator(['legend-collapse-button', 'legend-expand-button', 'minimap-collapse-button', 'minimap-expand-button']
      .map((id) => `[data-testid="${id}"]`).join(', ')).evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { label: button.getAttribute('aria-label'), x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width, height: rect.height };
    }));
    assert(overlayControls.length === 2 && overlayControls.every((button) => (
      button.x >= 0 && button.right <= width && button.y >= 0 && button.bottom <= 820
      && button.width >= 30 && button.height >= 30
    )), `Canvas overlay control is clipped at ${width}px: ${JSON.stringify(overlayControls)}`);
    const screenshotPath = path.join(evidenceDir, `${width}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    report.screenshots[width] = {
      path: path.relative(root, screenshotPath),
      actionBox,
      topbarButtons,
      overlayControls,
      viewportWidth: width,
    };
  }
  report.checks.responsivePrimaryAction = true;
  report.checks.responsiveSelectedToolbar = true;

  await fs.writeFile(path.join(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  await run();
} catch (error) {
  if (browserDiagnostics.length) error.message += `\nbrowser: ${browserDiagnostics.join(' | ')}`;
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
}
