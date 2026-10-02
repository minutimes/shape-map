#!/usr/bin/env node
/*
 * End-to-end acceptance for placing flow cards by hand. Builds a throwaway
 * workspace with a copy of the synthetic sample project, starts a production
 * server, and checks dragging inside a lane and onto another lane, the saved
 * view state, reload, undo and redo, returning cards to automatic placement,
 * keyboard moves, deletion, reading modes, and three screen sizes. Rendered
 * arrows are sampled along their paths to make sure none crosses a card.
 * Run `npm run build` first. Screenshots go to test-results/flow-placement/.
 *
 *   FLOW_PLACEMENT_PORT=4371 node scripts/flow-placement-acceptance.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.FLOW_PLACEMENT_PORT || 4371);
const origin = `http://127.0.0.1:${port}`;
const shots = path.join(root, 'test-results', 'flow-placement');
const results = [];
const screenshots = {};

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Shape map acceptance', '-c', 'user.email=acceptance@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
}
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) throw new Error(`${name} failed ${detail}`);
  console.log(`ok  ${name}${detail ? ` (${detail})` : ''}`);
}
async function until(fn, { timeout = 8000, message = 'timed out' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}
async function headlessShellPath() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  const bundled = chromium.executablePath();
  const match = bundled.match(/^(.*)\/chromium-(\d+)\//);
  if (!match) return bundled;
  const candidate = path.join(match[1], `chromium_headless_shell-${match[2]}`, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
  return fs.access(candidate).then(() => candidate, () => bundled);
}

async function makeWorkspace() {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shape-placement-')));
  const workspaceRoot = path.join(temporary, 'root');
  const bookshelf = path.join(workspaceRoot, 'bookshelf');
  await fs.mkdir(workspaceRoot);
  await fs.cp(path.join(root, 'examples/sample-project'), bookshelf, { recursive: true });
  git(bookshelf, 'init', '-q', '-b', 'main');
  git(bookshelf, 'add', '.');
  git(bookshelf, 'commit', '-q', '-m', 'Sample maps');
  return { temporary, workspaceRoot, bookshelf, maps: path.join(bookshelf, 'docs/maps'), state: path.join(temporary, 'state') };
}

async function startServer(environment) {
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, FINAL_SHAPE_MAP_PORT: String(port), ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await until(async () => (await fetch(`${origin}/api/health`)).ok, { timeout: 15000, message: `server did not start: ${output}` });
  return child;
}

async function screenshot(page, name, note) {
  const file = path.join(shots, `${name}.png`);
  await page.screenshot({ path: file });
  screenshots[name] = { file: path.relative(root, file), note };
  console.log(`    screenshot ${path.relative(root, file)}`);
}

/** Cards that overlap, arrows whose drawn path crosses a card that is not one of its ends, and labels on cards. */
async function cleanliness(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.react-flow__node-step[data-id]')].map((node) => ({ id: node.dataset.id, rect: node.getBoundingClientRect() }));
    let overlaps = 0;
    for (let i = 0; i < cards.length; i += 1) for (let j = i + 1; j < cards.length; j += 1) {
      const a = cards[i].rect; const b = cards[j].rect;
      if (a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5) overlaps += 1;
    }
    const crossings = [];
    for (const group of document.querySelectorAll('.fm-arrow')) {
      const key = group.dataset.testid.replace('fm-arrow-', '');
      const [source, target] = key.split('->');
      const line = group.querySelector('.fm-arrow__line');
      const matrix = line.getScreenCTM();
      const length = line.getTotalLength();
      for (let at = 0; at <= length; at += 3) {
        const point = line.getPointAtLength(at);
        const x = matrix.a * point.x + matrix.c * point.y + matrix.e; const y = matrix.b * point.x + matrix.d * point.y + matrix.f;
        const hit = cards.find((card) => card.id !== source && card.id !== target && x > card.rect.left + 2 && x < card.rect.right - 2 && y > card.rect.top + 2 && y < card.rect.bottom - 2);
        if (hit) { crossings.push(`${key} over ${hit.id}`); break; }
      }
    }
    const labelsOnCards = [];
    for (const label of document.querySelectorAll('.fm-arrow-label')) {
      const rect = label.getBoundingClientRect();
      const hit = cards.find((card) => rect.left < card.rect.right - 1 && card.rect.left < rect.right - 1 && rect.top < card.rect.bottom - 1 && card.rect.top < rect.bottom - 1);
      if (hit) labelsOnCards.push(`${label.dataset.testid} on ${hit.id}`);
    }
    return { cards: cards.length, overlaps, crossings, labelsOnCards, overflow: document.documentElement.scrollWidth - window.innerWidth };
  });
}
const isClean = (measured) => measured.overlaps === 0 && !measured.crossings.length && !measured.labelsOnCards.length;

async function box(page, id) { return page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox(); }
/** The card's position on the canvas (flow coordinates), from its transform. */
async function flowPosition(page, id) {
  return page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((node) => {
    const match = node.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    return { x: Number(match[1]), y: Number(match[2]) };
  });
}
async function zoomOf(page) { return Number((await page.locator('.fm-zoom__value').innerText()).replace('%', '')) / 100; }
/** Opens the map again looking at one card at `zoom`, through the remembered view. */
async function look(page, id, zoom = .8) {
  const at = await flowPosition(page, id);
  const canvas = await page.getByTestId('fm-canvas').boundingBox();
  const map = new URL(page.url()).searchParams;
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, JSON.stringify(value)),
    [`shape-map:flow-viewport:${map.get('project')}/${map.get('map')}`, { x: Math.round(canvas.width / 2 - (at.x + 82) * zoom), y: Math.round(canvas.height / 2 - (at.y + 28) * zoom), zoom }]);
  await page.reload();
  await page.locator(`.react-flow__node[data-id="${id}"]`).waitFor();
  await page.waitForTimeout(250);
}
/** Drags a card by a distance on the canvas (not on screen). */
async function drag(page, id, fx, fy, options) {
  const zoom = await zoomOf(page);
  return dragScreen(page, id, fx * zoom, fy * zoom, options);
}
async function dragScreen(page, id, dx, dy, { hold = null } = {}) {
  const start = await box(page, id);
  const x = start.x + start.width / 2; const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 14; step += 1) await page.mouse.move(x + (dx * step) / 14, y + (dy * step) / 14);
  await page.waitForTimeout(120);
  if (hold) await hold();
  await page.mouse.up();
}
async function viewFile(workspace, map) {
  try { return JSON.parse(await fs.readFile(path.join(workspace.state, 'projects', 'bookshelf', map.replace(/\.mmd$/, '.view.json')), 'utf8')); } catch { return null; }
}
const spotsOf = async (workspace, map) => (await viewFile(workspace, map))?.flow?.positions || {};

async function run() {
  await fs.mkdir(shots, { recursive: true });
  const workspace = await makeWorkspace();
  const server = await startServer({ SHAPE_MAP_WORKSPACE_ROOT: workspace.workspaceRoot, SHAPE_MAP_STATE_DIR: workspace.state });
  const browser = await chromium.launch({ executablePath: await headlessShellPath() });
  const errors = [];
  const lendingFile = path.join(workspace.maps, '02-lending.mmd');
  const original = await fs.readFile(lendingFile, 'utf8');
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/?project=bookshelf&map=02-lending.mmd`);
    await page.locator('.react-flow__node[data-id="reader_open"]').waitFor();
    await page.getByRole('button', { name: '지도 전체 보기' }).click();
    await page.waitForTimeout(300);
    check('the map opens clean with automatic placement', isClean(await cleanliness(page)) && !(await page.getByTestId('fm-placed').count()));
    await screenshot(page, 'before-1440', 'Lending user flow at 1440 before any card is placed by hand.');
    await look(page, 'owner_handover', .8);
    await screenshot(page, 'before-zoomed-1440', 'The middle of the lending flow at 80% before placing cards.');

    // Drag inside the lane: only placement changes; the file stays the same.
    const before = await flowPosition(page, 'owner_handover');
    await drag(page, 'owner_handover', 0, 50, { hold: () => screenshot(page, 'dragging-in-lane-1440', 'Dragging a card down inside its lane: the dashed outline shows where it lands and the arrows already follow.') });
    await until(async () => (await spotsOf(workspace, '02-lending.mmd')).owner_handover, { message: 'placement was not saved' });
    const placedAt = await flowPosition(page, 'owner_handover');
    check('a card dragged inside its lane stays where it was dropped', placedAt.y > before.y + 35 && Math.abs(placedAt.x - before.x) < 2, JSON.stringify({ before, placedAt }));
    check('placement never touches the map file', (await fs.readFile(lendingFile, 'utf8')) === original);
    let measured = await cleanliness(page);
    check('arrows and labels route around the placed card', isClean(measured), JSON.stringify(measured));
    check('the canvas offers to return placed cards', (await page.getByTestId('fm-placed').innerText()).includes('직접 놓은 카드 1'));
    await screenshot(page, 'placed-in-lane-1440', 'After the drop: the card keeps its spot, the 책 주인 lane grew to hold it, arrows go around cards.');

    // Undo and redo share the history with content edits.
    await page.locator('body').press('Meta+z');
    await until(async () => !(await spotsOf(workspace, '02-lending.mmd')).owner_handover, { message: 'undo did not remove the placement' });
    await until(async () => (await flowPosition(page, 'owner_handover')).y === before.y, { message: 'undo did not move the card back' });
    check('undo returns the card to its automatic spot', true);
    await page.locator('body').press('Shift+Meta+z');
    await until(async () => (await spotsOf(workspace, '02-lending.mmd')).owner_handover, { message: 'redo did not restore the placement' });
    check('redo puts it back', await until(async () => (await flowPosition(page, 'owner_handover')).y === placedAt.y, { message: 'redo did not move the card' }));

    // Reload keeps it.
    await page.reload();
    await page.locator('.react-flow__node[data-id="owner_handover"]').waitFor();
    await page.waitForTimeout(300);
    check('the placement survives a reload', JSON.stringify(await flowPosition(page, 'owner_handover')) === JSON.stringify(placedAt));

    // Dropping on another lane moves the step there in the file, as one undoable change.
    await look(page, 'reader_wait', .8);
    const owner = await page.getByTestId('fm-lane-owner').boundingBox();
    const waitBox = await box(page, 'reader_wait');
    await dragScreen(page, 'reader_wait', 40, owner.y + owner.height / 2 - (waitBox.y + waitBox.height / 2), {
      hold: async () => {
        check('the target lane is highlighted with where the card goes', await page.locator('.fm-band.is-drop').count() === 1 && (await page.locator('.fm-landing__hint').innerText()).includes('책 주인'));
        await screenshot(page, 'dragging-to-lane-1440', 'Dragging 입고 알림 신청 onto 책 주인: the lane is highlighted and the landing spot says where it goes.');
      },
    });
    await until(async () => /subgraph owner\["책 주인"\][^]*reader_wait\["입고 알림 신청"\][^]*end/.test(await fs.readFile(lendingFile, 'utf8')), { message: 'lane move did not reach the file' });
    const movedSource = await fs.readFile(lendingFile, 'utf8');
    check('dropping on another lane moves the step in the file', !/subgraph reader[^]*reader_wait\[[^]*subgraph owner/.test(movedSource));
    check('the move is announced in plain words', (await page.getByTestId('fm-toast').innerText()).includes('‘책 주인’ 쪽으로 옮겼어요'));
    await until(async () => (await spotsOf(workspace, '02-lending.mmd')).reader_wait, { message: 'lane drop placement was not saved' });
    measured = await cleanliness(page);
    check('the map stays clean after a lane move', isClean(measured), JSON.stringify(measured));
    await screenshot(page, 'moved-to-lane-1440', 'After the lane drop: 입고 알림 신청 now belongs to 책 주인 in the file and keeps its spot.');
    await page.locator('body').press('Meta+z');
    await until(async () => (await fs.readFile(lendingFile, 'utf8')) === original, { message: 'undo did not restore the file byte for byte' });
    await until(async () => !(await spotsOf(workspace, '02-lending.mmd')).reader_wait, { message: 'undo did not remove the lane drop placement' });
    check('one undo restores both the file and the placement', true);
    await page.locator('body').press('Shift+Meta+z');
    await until(async () => (await fs.readFile(lendingFile, 'utf8')) === movedSource, { message: 'redo did not repeat the lane move' });
    await page.locator('body').press('Meta+z');
    await until(async () => (await fs.readFile(lendingFile, 'utf8')) === original, { message: 'second undo failed' });

    // Keyboard: a chosen card moves with the arrow keys and settles after a moment.
    await look(page, 'reader_review', .8);
    // Reach the card with the keyboard: focus it, choose it with Enter, then use the arrow keys.
    await page.locator('.react-flow__node[data-id="reader_review"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    const keyStart = await flowPosition(page, 'reader_review');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowDown');
    const moving = await flowPosition(page, 'reader_review');
    await until(async () => (await spotsOf(workspace, '02-lending.mmd')).reader_review, { message: `keyboard move was not saved: ${JSON.stringify({ keyStart, moving, now: await flowPosition(page, 'reader_review'), focus: await page.evaluate(() => document.activeElement?.className), cls: await page.locator('.react-flow__node[data-id="reader_review"]').getAttribute('class') })}` });
    const keyEnd = await until(async () => { const at = await flowPosition(page, 'reader_review'); return at.y > keyStart.y ? at : null; }, { message: 'the card did not move' });
    check('arrow keys move a chosen card', keyEnd.y >= keyStart.y + 100, JSON.stringify({ keyStart, keyEnd }));
    check('the chosen placed card offers 자동 자리로', await page.getByTestId('fm-auto-reader_review').isVisible());
    await screenshot(page, 'keyboard-moved-1440', 'A card moved with Shift+arrow keys; the chosen placed card offers 자동 자리로.');
    await page.getByTestId('fm-auto-reader_review').click();
    await until(async () => !(await spotsOf(workspace, '02-lending.mmd')).reader_review, { message: '자동 자리로 did not remove the placement' });
    check('자동 자리로 returns one card', await until(async () => (await flowPosition(page, 'reader_review')).y === keyStart.y, { message: 'the card did not go back' }));

    // Reading modes and the overview work with placed cards.
    await look(page, 'platform_fill', .8);
    await drag(page, 'platform_fill', 120, 40);
    await until(async () => Object.keys(await spotsOf(workspace, '02-lending.mmd')).length === 2, { message: 'second placement was not saved' });
    await page.keyboard.press('Escape');
    await page.getByTestId('fm-focus-lane').selectOption('owner');
    await page.waitForTimeout(200);
    check('focusing one lane still shows placed cards', await page.locator('.react-flow__node[data-id="owner_handover"] .fm-step.is-on').count() === 1);
    await screenshot(page, 'focus-lane-1440', 'Showing only 책 주인 with two cards placed by hand.');
    await page.getByTestId('fm-focus-lane').selectOption('');
    if (!(await page.locator('.react-flow__minimap').count())) await page.getByTestId('fm-overview-toggle').click();
    await page.locator('.react-flow__minimap').waitFor();
    await screenshot(page, 'overview-1440', 'The overview with placed cards.');

    // Deleting a placed step drops its placement; undo brings both back.
    await page.getByTestId('fm-step-platform_fill').click();
    await page.keyboard.press('Escape');
    await page.getByTestId('fm-step-platform_fill').click();
    await page.locator('body').press('Delete');
    await until(async () => !(await fs.readFile(lendingFile, 'utf8')).includes('platform_fill'), { message: 'delete did not reach the file' });
    await until(async () => !(await spotsOf(workspace, '02-lending.mmd')).platform_fill, { message: 'deleted step kept its placement' });
    check('a deleted step loses its placement', true);
    await page.locator('body').press('Meta+z');
    await until(async () => (await spotsOf(workspace, '02-lending.mmd')).platform_fill, { message: 'undoing the delete did not bring the placement back' });
    check('undoing the delete brings the step back where it was placed', (await fs.readFile(lendingFile, 'utf8')) === original);

    // Return every card at once, then undo it.
    await page.getByTestId('fm-reset-all').click();
    await until(async () => !Object.keys(await spotsOf(workspace, '02-lending.mmd')).length, { message: '모두 자동 배치 did not clear the placements' });
    check('모두 자동 배치 returns every card', !(await page.getByTestId('fm-placed').count()));
    await page.locator('body').press('Meta+z');
    await until(async () => Object.keys(await spotsOf(workspace, '02-lending.mmd')).length === 2, { message: 'undo of 모두 자동 배치 failed' });
    check('undo brings every placement back', true);
    await screenshot(page, 'placed-1440', 'Two placed cards with 직접 놓은 카드 2 · 모두 자동 배치.');

    // A top-to-bottom system flow without lanes: cards move freely and arrows follow.
    await page.goto(`${origin}/?project=bookshelf&map=03-lending-system.mmd`);
    await page.locator('.react-flow__node[data-id="charge"]').waitFor();
    await look(page, 'charge', .8);
    await drag(page, 'charge', 260, 0);
    await until(async () => (await spotsOf(workspace, '03-lending-system.mmd')).charge, { message: 'system flow placement was not saved' });
    measured = await cleanliness(page);
    check('a card placed in a vertical flowchart keeps arrows clear of cards', isClean(measured), JSON.stringify(measured));
    await screenshot(page, 'system-flow-placed-1440', 'System flow (top to bottom, no lanes): 보증금 결제 요청 moved to the right; arrows re-route around cards.');

    // Other sizes, each in a fresh browser: the saved placement shows, and the map stays clean.
    for (const [width, height, mobile] of [[1024, 768, false], [390, 844, true]]) {
      const fresh = await browser.newContext({ viewport: { width, height }, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
      const small = await fresh.newPage();
      small.on('pageerror', (error) => errors.push(error.message));
      await small.goto(`${origin}/?project=bookshelf&map=02-lending.mmd`);
      await small.locator('.react-flow__node[data-id="owner_handover"]').waitFor();
      await small.getByRole('button', { name: '지도 전체 보기' }).click();
      await small.waitForTimeout(350);
      measured = await cleanliness(small);
      check(`placed cards read cleanly at ${width}px`, isClean(measured) && measured.overflow <= 0, JSON.stringify(measured));
      await screenshot(small, `placed-${width}`, `Two placed cards at ${width}×${height}.`);
      if (mobile) {
        // On a phone an unchosen card pans the map; a chosen card can be dragged.
        const target = 'reader_search';
        await look(small, target, .9);
        const pan = await flowPosition(small, target);
        const start = await box(small, target);
        await small.mouse.move(start.x + 30, start.y + 20); await small.mouse.down();
        for (let step = 1; step <= 8; step += 1) await small.mouse.move(start.x + 30, start.y + 20 + step * 6);
        await small.mouse.up();
        await small.waitForTimeout(200);
        check('on a phone, dragging an unchosen card pans instead of moving it', JSON.stringify(await flowPosition(small, target)) === JSON.stringify(pan) && !(await spotsOf(workspace, '02-lending.mmd'))[target]);
        await look(small, target, .9);
        await small.getByTestId(`fm-step-${target}`).click();
        // Choosing a card opens its sheet and glides the map to keep the card in view.
        await small.waitForTimeout(500);
        const chosen = await box(small, target);
        await small.mouse.move(chosen.x + 30, chosen.y + 20); await small.mouse.down();
        for (let step = 1; step <= 10; step += 1) await small.mouse.move(chosen.x + 30, chosen.y + 20 + step * 8);
        await small.mouse.up();
        await until(async () => (await spotsOf(workspace, '02-lending.mmd'))[target], { message: 'phone drag of a chosen card was not saved' });
        check('on a phone, a chosen card can be dragged', true);
        await small.waitForTimeout(250);
        await screenshot(small, 'phone-chosen-moved-390', 'Phone: a chosen card dragged down; 자동 자리로 sits above it.');
        await small.locator('body').press('Escape').catch(() => {});
        check('the phone keeps 모두 자동 배치 reachable', await small.getByTestId('fm-reset-all').isVisible());
      }
      await fresh.close();
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (error) {
    for (const open of browser.contexts().flatMap((context) => context.pages())) await open.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
    server.kill();
    await fs.writeFile(path.join(shots, 'report.json'), `${JSON.stringify({ results, screenshots }, null, 2)}\n`);
    await fs.rm(workspace.temporary, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => console.log(`\n${results.length}/${results.length} checks passed`)).catch((error) => {
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
