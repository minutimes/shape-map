// Browser acceptance for the flow map canvas, run against the development
// harness (harness/flow) and its fake API. Saves screenshots and a report under
// test-results/flow-acceptance/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(root, 'test-results', 'flow-acceptance');
const port = Number(process.env.FLOW_QA_PORT || 4342);
const origin = `http://127.0.0.1:${port}`;
const report = { origin, checks: {}, screenshots: {}, timings: {} };
const diagnostics = [];
let server; let browser;

async function headlessShellPath() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  const bundled = chromium.executablePath();
  const match = bundled.match(/^(.*)\/chromium-(\d+)\//);
  if (!match) return bundled;
  const candidate = path.join(match[1], `chromium_headless_shell-${match[2]}`, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
  try { await fs.access(candidate); return candidate; } catch { return bundled; }
}

function assert(condition, message) { if (!condition) throw new Error(message); }
async function waitUntil(check, { timeoutMs = 6000, intervalMs = 40, message = 'condition timed out' } = {}) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function startServer() {
  server = spawn(path.join(root, 'node_modules', '.bin', 'vite'), ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  await waitUntil(async () => (await fetch(`${origin}/harness/flow/`)).ok, { timeoutMs: 20000, message: `harness server did not start: ${output}` });
}

async function open(page, fixture, { latency = 60, fresh = true } = {}) {
  await page.goto(`${origin}/harness/flow/?fixture=${fixture}&latency=${latency}`);
  if (fresh) {
    await page.evaluate(() => { try { window.localStorage.clear(); } catch { /* storage unavailable */ } });
    await page.reload();
  }
  await page.waitForSelector('[data-testid="fm-canvas"] .react-flow__node', { timeout: 15000 });
  await page.waitForTimeout(250);
}

const snapshot = (page) => page.evaluate(() => window.__flowHarness.snapshot());
const graph = async (page) => (await snapshot(page)).graph;
const step = async (page, id) => (await graph(page)).steps.find((item) => item.id === id);
const saved = (page) => waitUntil(async () => (await page.getByTestId('fm-save-state').innerText()).includes('저장됨'), { message: 'save state did not settle' });

async function shot(page, name, note) {
  const file = path.join(evidenceDir, `${name}.png`);
  await page.screenshot({ path: file });
  report.screenshots[name] = { file: path.relative(root, file), note };
}

async function noPageOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function cardsFitCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="fm-canvas"]').getBoundingClientRect();
    return [...document.querySelectorAll('.react-flow__node')].every((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= canvas.left - 1 && rect.right <= canvas.right + 1 && rect.top >= canvas.top - 1 && rect.bottom <= canvas.bottom + 1;
    });
  });
}

async function selectStep(page, id) {
  await page.getByTestId(`fm-step-${id}`).click();
  await page.getByTestId('fm-panel').waitFor({ state: 'visible' });
}

async function run() {
  await fs.mkdir(evidenceDir, { recursive: true });
  await startServer();
  browser = await chromium.launch({ executablePath: await headlessShellPath() });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.push(`console: ${message.text()}`); });

  // Reading.
  await open(page, 'lending');
  const cardCount = await page.locator('.react-flow__node[data-id]:not([data-id^="__"])').count();
  assert(cardCount === 21, `expected 21 steps, saw ${cardCount}`);
  assert(await page.locator('.fm-rail__band').count() === 4, 'every participant lane is in the rail');
  assert(await cardsFitCanvas(page), 'the whole map fits the canvas on open');
  assert(await noPageOverflow(page), 'no horizontal page scroll');
  assert((await page.locator('.fm-kind').innerText()) === '유저 플로우', 'kind label is shown');
  const fullLabel = await page.getByTestId('fm-arrow-label-reader_available->reader_wait').getAttribute('title');
  assert(fullLabel === '없어요', 'arrow labels keep their full text on hover');
  report.checks.reading = { cardCount, fits: true };
  await shot(page, 'flow-read-1440', 'User flow sample at 1440×900: four participant rows, whole map fitted on open.');

  await page.getByTestId('fm-highlight-money').click();
  assert(await page.getByTestId('fm-step-reader_open').evaluate((node) => node.classList.contains('is-off')), 'tag highlight dims other steps');
  assert(!(await page.getByTestId('fm-step-reader_deposit').evaluate((node) => node.classList.contains('is-off'))), 'tag highlight keeps tagged steps');
  await page.getByTestId('fm-highlight-money').click();
  await page.getByTestId('fm-focus-lane').selectOption('catalog');
  assert(await page.getByTestId('fm-step-platform_fill').evaluate((node) => node.classList.contains('is-near')), 'participant focus keeps partners readable');
  await page.getByTestId('fm-focus-lane').selectOption('');
  assert((await snapshot(page)).origin === 'startup', 'highlighting does not change the file');
  report.checks.highlight = true;

  // The viewport is remembered per map in this browser.
  await page.locator('.fm-zoom__value').click();
  await page.waitForTimeout(400);
  await open(page, 'lending', { fresh: false });
  assert((await page.locator('.fm-zoom__value').innerText()) === '100%', 'viewport is restored when the map opens again');
  report.checks.viewportRestore = true;
  await page.getByRole('button', { name: '지도 전체 보기' }).click();
  await page.waitForTimeout(250);

  // Step edits.
  await selectStep(page, 'reader_search');
  const label = page.getByTestId('fm-step-label');
  await label.fill('읽고 싶은 책 검색하기');
  await label.press('Enter');
  await waitUntil(async () => (await step(page, 'reader_search')).label === '읽고 싶은 책 검색하기', { message: 'label edit did not save' });
  await page.getByRole('radio', { name: '갈림길' }).click();
  await waitUntil(async () => (await step(page, 'reader_search')).shape === 'decision', { message: 'shape edit did not save' });
  await page.locator('.fm-tag-picker button', { hasText: '데이터' }).click();
  await waitUntil(async () => (await step(page, 'reader_search')).tags.includes('data'), { message: 'tag edit did not save' });
  const summary = page.getByTestId('fm-step-summary');
  await summary.fill('제목이나 저자로 찾아요.\n둘째 줄');
  await summary.press('Meta+Enter');
  await waitUntil(async () => (await step(page, 'reader_search')).summary === '제목이나 저자로 찾아요.\n둘째 줄', { message: 'summary edit did not save' });
  await saved(page);
  report.checks.stepEdits = true;

  // Add the next step and name it.
  const before = (await graph(page)).steps.length;
  await page.getByRole('button', { name: '다음 단계 추가', exact: true }).click();
  await waitUntil(async () => (await graph(page)).steps.length === before + 1, { message: 'next step was not added' });
  await waitUntil(() => page.evaluate(() => document.activeElement?.dataset?.testid === 'fm-step-label'), { message: 'new step label is not focused' });
  await page.keyboard.type('책 미리 보기');
  await page.keyboard.press('Enter');
  await waitUntil(async () => (await step(page, 'step-1'))?.label === '책 미리 보기', { message: 'new step label did not save' });
  assert((await graph(page)).arrows.some((arrow) => arrow.source === 'reader_search' && arrow.target === 'step-1'), 'next step is connected');
  await shot(page, 'flow-edit-step-1440', 'A step selected with its editor open after adding and naming the next step.');

  // Insert a step on an arrow.
  await page.getByTestId('fm-arrow-label-reader_request->platform_match').click();
  await page.getByRole('button', { name: '사이에 단계 넣기' }).first().click();
  await waitUntil(async () => (await graph(page)).arrows.some((arrow) => arrow.source === 'reader_request' && arrow.target === 'step-2' && arrow.style === 'exchange'), { message: 'splice did not keep the old arrow first' });
  assert((await graph(page)).arrows.some((arrow) => arrow.source === 'step-2' && arrow.target === 'platform_match'), 'splice continues to the old target');
  await page.keyboard.press('Escape');

  // Change an arrow's kind and label.
  await page.getByTestId('fm-arrow-label-reader_available->reader_wait').click();
  await page.getByRole('radio', { name: '주고받기' }).click();
  await waitUntil(async () => (await graph(page)).arrows.find((arrow) => arrow.source === 'reader_available' && arrow.target === 'reader_wait').style === 'exchange', { message: 'arrow kind did not save' });
  const arrowLabel = page.getByTestId('fm-arrow-label-input');
  await arrowLabel.fill('지금은 없어요');
  await arrowLabel.press('Enter');
  await waitUntil(async () => (await graph(page)).arrows.find((arrow) => arrow.source === 'reader_available' && arrow.target === 'reader_wait').label === '지금은 없어요', { message: 'arrow label did not save' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  report.checks.arrowEdits = true;

  // Delete a step with the keyboard; the chain stays connected.
  await selectStep(page, 'reader_receive');
  await page.getByTestId('fm-step-reader_receive').focus();
  await page.keyboard.press('Delete');
  await waitUntil(async () => !(await step(page, 'reader_receive')), { message: 'step was not deleted' });
  assert((await graph(page)).arrows.some((arrow) => arrow.source === 'owner_handover' && arrow.target === 'reader_return' && arrow.label === '책'), 'deleting bridges the chain');
  report.checks.delete = true;

  // Connect two steps by dragging from the handle onto a card.
  await page.getByTestId('fm-step-owner_list').hover();
  const handle = page.locator('[data-id="owner_list"] .fm-handle--out');
  const from = await handle.boundingBox();
  const to = await page.getByTestId('fm-step-catalog_send').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await waitUntil(async () => (await graph(page)).arrows.some((arrow) => arrow.source === 'owner_list' && arrow.target === 'catalog_send'), { message: 'drag did not connect the steps' });
  report.checks.dragConnect = true;
  await page.keyboard.press('Escape');

  // Undo everything, then redo once.
  const original = (await page.evaluate(() => window.__flowHarness.snapshot())).source;
  const editedSource = original;
  let undoCount = 0;
  while (await page.getByTestId('fm-undo').isEnabled()) {
    await page.locator('body').press('Meta+z');
    undoCount += 1;
    await page.waitForTimeout(120);
    await saved(page);
    if (undoCount > 30) break;
  }
  const lending = await fs.readFile(path.join(root, 'examples/sample-project/docs/maps/02-lending.mmd'), 'utf8');
  assert((await snapshot(page)).source === lending, `undo restores the original source after ${undoCount} steps`);
  await page.locator('body').press('Shift+Meta+z');
  await waitUntil(async () => (await step(page, 'reader_search')).label === '읽고 싶은 책 검색하기', { message: 'redo did not reapply the first edit' });
  report.checks.undoRedo = { undoCount, restored: true, editedSourceDiffered: editedSource !== lending };

  // Another client changes the map: history clears, selection stays.
  await selectStep(page, 'owner_check');
  await page.evaluate(() => window.__flowHarness.external({ type: 'updateStep', id: 'owner_check', label: '요청을 확인해요' }));
  await waitUntil(async () => (await page.getByTestId('fm-step-label').inputValue()) === '요청을 확인해요', { message: 'external change did not re-render' });
  assert(await page.getByTestId('fm-step-owner_check').evaluate((node) => node.classList.contains('is-selected')), 'selection survives an external change');
  assert(!(await page.getByTestId('fm-undo').isEnabled()), 'external change clears undo history');
  report.checks.external = true;

  // Conflict: the save loses a race, the typed text stays, and saving again works.
  await page.evaluate(() => window.__flowHarness.setLatency(500));
  await page.getByTestId('fm-step-label').fill('내 초안 제목');
  await page.getByTestId('fm-step-label').press('Enter');
  await page.waitForTimeout(80);
  await page.evaluate(() => window.__flowHarness.external({ type: 'updateStep', id: 'owner_accept', label: '빌려줄지 정하기' }));
  await page.getByText('저장하지 못했어요', { exact: false }).first().waitFor({ timeout: 4000 }).catch(() => {});
  await waitUntil(async () => (await page.getByTestId('fm-step-label').inputValue()) === '내 초안 제목', { message: 'draft was not kept after a conflict' });
  assert(await page.getByRole('alert').filter({ hasText: '다른 곳에서 지도가 바뀌었어요' }).count() > 0, 'conflict is explained');
  await page.evaluate(() => window.__flowHarness.setLatency(40));
  await shot(page, 'flow-conflict-1440', 'After a save conflict: the typed title stays in the field with a retry button.');
  await page.getByRole('button', { name: '다시 저장' }).click();
  await waitUntil(async () => (await step(page, 'owner_check')).label === '내 초안 제목', { message: 'retry after conflict did not save' });
  assert((await step(page, 'owner_accept')).label === '빌려줄지 정하기', 'the other change is kept');
  report.checks.conflict = true;
  await page.keyboard.press('Escape');

  // Source view: a bad edit shows its line; a good edit applies and undoes.
  await page.getByTestId('fm-open-source').click();
  const text = page.getByTestId('fm-source-text');
  const current = await text.inputValue();
  const brokenLine = current.split('\n').findIndex((line) => line.includes('reader_open -->')) + 1;
  await text.fill(current.replace('  reader_open --> reader_search', '  reader_open --> reader_search --- oops'));
  await page.getByTestId('fm-source-apply').click();
  await page.getByTestId('fm-source-problem').waitFor();
  const problem = await page.getByTestId('fm-source-problem').innerText();
  assert(problem.includes(`${brokenLine}번째 줄`), `source error names line ${brokenLine}: ${problem}`);
  assert(await page.locator('.fm-source__gutter .is-error').innerText() === String(brokenLine), 'error line is marked');
  await shot(page, 'flow-source-error-1440', 'Source view with a server validation error marked at its line.');
  await text.fill(current.replace('"앱 열기"', '"앱 켜기"'));
  await page.getByTestId('fm-source-apply').click();
  await waitUntil(async () => (await step(page, 'reader_open')).label === '앱 켜기', { message: 'source edit did not apply' });
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.getByTestId('fm-undo').click();
  await waitUntil(async () => (await step(page, 'reader_open')).label === '앱 열기', { message: 'undo of a source edit failed' });
  await page.keyboard.press('Escape');
  report.checks.source = { brokenLine };

  // Lanes, tags, and the map header.
  await page.locator('.fm-rail__title', { hasText: '도서 정보 제공처' }).click();
  await page.getByTestId('fm-lane-title').fill('도서 정보 회사');
  await page.getByTestId('fm-lane-title').press('Enter');
  await waitUntil(async () => (await graph(page)).lanes.find((lane) => lane.id === 'catalog').title === '도서 정보 회사', { message: 'lane rename failed' });
  await page.getByRole('button', { name: '위로 옮기기' }).click();
  await waitUntil(async () => (await graph(page)).lanes[1].id === 'catalog', { message: 'lane move failed' });
  await page.getByRole('button', { name: '참여자 지우기' }).click();
  await page.getByRole('alertdialog').waitFor();
  await shot(page, 'flow-lane-delete-1440', 'Deleting a participant with steps asks first.');
  await page.getByRole('button', { name: '함께 지우기' }).click();
  await waitUntil(async () => !(await graph(page)).lanes.some((lane) => lane.id === 'catalog'), { message: 'lane delete failed' });
  await page.locator('.fm-rail__add').click();
  await waitUntil(async () => (await graph(page)).lanes.some((lane) => lane.title === '새 참여자'), { message: 'lane add failed' });
  await page.getByTestId('fm-lane-title').fill('배송 기사');
  await page.getByTestId('fm-lane-title').press('Enter');
  await waitUntil(async () => (await graph(page)).lanes.some((lane) => lane.title === '배송 기사'), { message: 'new lane rename failed' });
  await page.keyboard.press('Escape');
  await page.locator('.fm-toolbar .fm-text-button', { hasText: '관리' }).click();
  await page.getByRole('button', { name: '새 표시 만들기' }).click();
  await page.getByTestId('fm-tag-name').fill('미정');
  await page.getByRole('radio', { name: '올리브' }).click();
  await page.getByLabel('점선으로 보이기').check();
  await page.getByRole('button', { name: '표시 만들기' }).click();
  await waitUntil(async () => (await graph(page)).tags.some((tag) => tag.label === '미정' && tag.strokeDasharray), { message: 'tag create failed' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '지도 이름과 설명 보기' }).click();
  await page.getByTestId('fm-map-title').fill('책 빌리고 빌려주기 (새 판)');
  await page.getByTestId('fm-map-title').press('Enter');
  await waitUntil(async () => (await graph(page)).map.title === '책 빌리고 빌려주기 (새 판)', { message: 'map title edit failed' });
  await page.keyboard.press('Escape');
  report.checks.lanesTagsHeader = true;

  // Keyboard: Tab reaches cards, Enter selects, Escape closes.
  await page.locator('.react-flow__node[data-id="reader_open"]').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('fm-panel').waitFor();
  await page.keyboard.press('Escape');
  await waitUntil(async () => !(await page.getByTestId('fm-panel').count()), { message: 'Escape did not close the panel' });
  report.checks.keyboard = true;

  // The source becomes invalid after opening: calm banner, edits blocked.
  const good = (await snapshot(page)).source;
  await page.evaluate((value) => window.__flowHarness.writeFile(value.replace('  reader_open --> reader_search', '  reader_open ->> reader_search')), good);
  await page.getByTestId('fm-invalid-banner').waitFor();
  assert(!(await page.getByTestId('fm-undo').count()), 'edits are blocked while the source is invalid');
  await selectStep(page, 'reader_open');
  assert(await page.getByTestId('fm-step-label').isDisabled(), 'fields are read-only while the source is invalid');
  await shot(page, 'flow-invalid-1440', 'The file became invalid after opening: banner names the line and editing pauses.');
  await page.evaluate((value) => window.__flowHarness.writeFile(value), good);
  await waitUntil(async () => !(await page.getByTestId('fm-invalid-banner').count()), { message: 'banner did not clear after the fix' });
  assert(!(await page.getByTestId('fm-step-label').isDisabled()), 'editing resumes after the fix');
  await page.keyboard.press('Escape');
  report.checks.invalidSource = true;

  // System flow, notes toggle, and other sizes.
  await open(page, 'system');
  assert((await page.locator('.fm-kind').innerText()) === '시스템 플로우', 'system flow kind label');
  assert(await page.locator('.fm-rail').count() === 0, 'a lane-free system flow has no lane rail');
  assert(await cardsFitCanvas(page), 'system flow fits on open');
  await shot(page, 'flow-system-1440', 'Lane-free system flow drawn top to bottom as a flowchart, with the dashed undecided step.');
  await page.getByRole('button', { name: '설명 보기', exact: true }).click();
  await page.locator('.fm-step__summary').first().waitFor();
  report.checks.system = true;

  const started = performance.now();
  await open(page, 'large');
  report.timings.large200Open = Math.round(performance.now() - started);
  const pan = performance.now();
  for (let index = 0; index < 10; index += 1) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(50);
  report.timings.large200Pan = Math.round(performance.now() - pan);
  assert(await cardsFitCanvas(page), 'large map fits on open');
  await shot(page, 'flow-large-1440', 'Generated 12-lane, 200-step map fitted on open.');

  for (const [width, height] of [[1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await open(page, 'lending');
    assert(await noPageOverflow(page), `no horizontal page scroll at ${width}`);
    const zoom = Number((await page.locator('.fm-zoom__value').innerText()).replace('%', ''));
    if (width < 640) assert(zoom >= 60, `a phone opens a long flow at a readable size (${zoom}%)`);
    else assert(await cardsFitCanvas(page), `the map fits at ${width}`);
    await shot(page, `flow-read-${width}`, `User flow sample at ${width}×${height}.`);
    await selectStep(page, 'reader_deposit');
    await shot(page, `flow-edit-${width}`, `Step editor at ${width}×${height}${width < 640 ? ' as a bottom sheet' : ''}.`);
    await page.keyboard.press('Escape');
    await open(page, 'system');
    await shot(page, `flow-system-${width}`, `System flow at ${width}×${height}.`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  const unexpected = diagnostics.filter((line) => !line.includes('409') && !line.includes('422') && !line.includes('Failed to load resource'));
  assert(!unexpected.length, `browser errors: ${unexpected.join(' | ')}`);
  report.ok = true;
}

try {
  await run();
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.ok = false; report.error = error.message; report.diagnostics = diagnostics;
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  server?.kill();
}
