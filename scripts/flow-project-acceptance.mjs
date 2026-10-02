#!/usr/bin/env node
/*
 * End-to-end acceptance for flow maps through the real project shell and
 * server. Builds a throwaway workspace with a copy of the synthetic sample
 * project, starts a production server, and checks reading, editing, undo,
 * a live external edit, a conflict made on disk, source errors, a file that
 * breaks after opening, the system flow tab, and three screen sizes.
 * Run `npm run build` first. Screenshots go to test-results/flow-project/.
 *
 *   node scripts/flow-project-acceptance.mjs   (a free port; FLOW_ACCEPTANCE_PORT pins one)
 *   FLOW_ACCEPTANCE_EXTRA="/path/a.mmd:system-flow,/path/b.mmd:user-flow"
 *     (optional; real maps copied into the temporary project only and
 *      converted there: a header, legends, and note links turned into descriptions)
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, launchBrowser } from './support/browser-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.FLOW_ACCEPTANCE_PORT) || await freePort();
const origin = `http://127.0.0.1:${port}`;
const shots = path.join(root, 'test-results', 'flow-project');
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
/** Makes a common Mermaid flowchart editable: header, legends, and `-.-` notes as descriptions. */
export function prepareFlowSource(text, kind, title) {
  let lines = text.replace(/\r\n/g, '\n').split('\n');
  const labelOf = new Map();
  for (const line of lines) {
    const match = line.trim().match(/^([A-Za-z][\w-]*)(?:\["(.*)"\]|\(\["(.*)"\]\)|\{"(.*)"\})$/);
    if (match) labelOf.set(match[1], match[2] ?? match[3] ?? match[4]);
  }
  const notes = new Map();
  for (const line of lines) {
    const match = line.trim().match(/^([A-Za-z][\w-]*)\s+-\.-\s+([A-Za-z][\w-]*)$/);
    if (match) notes.set(match[2], match[1]);
  }
  lines = lines.filter((line) => {
    const trimmed = line.trim();
    if (/^([A-Za-z][\w-]*)\s+-\.-\s+/.test(trimmed)) return false;
    const declared = trimmed.match(/^([A-Za-z][\w-]*)[[({]/);
    return !(declared && notes.has(declared[1]));
  }).map((line) => {
    const match = line.match(/^(\s*class\s+)([\w,-]+)(\s+\w+)$/);
    if (!match) return line;
    const ids = match[2].split(',').filter((id) => !notes.has(id));
    return ids.length ? `${match[1]}${ids.join(',')}${match[3]}` : null;
  }).filter((line) => line !== null);
  lines.splice(1, 0, `  %% sm-map: ${JSON.stringify({ kind, title })}`);
  const tags = [...text.matchAll(/classDef (\w+)/g)].map((match) => match[1]);
  const summaries = new Map();
  for (const [note, owner] of notes) summaries.set(owner, [summaries.get(owner), labelOf.get(note)].filter(Boolean).join('\n'));
  const tail = [...[...summaries].map(([id, summary]) => `  %% sm-block: ${id}|${JSON.stringify({ summary })}`),
    ...tags.map((tag) => `  %% mlc-legend: ${tag}|${{ pub: '광장', rsv: '예약 서버', pay: '결제', dec: '판단', bad: '예외', open: '미정', note: '메모', ops: '운영' }[tag] || tag}|${tag}`)];
  return `${lines.join('\n').trimEnd()}\n\n${tail.join('\n')}\n`;
}

async function makeWorkspace() {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shape-flow-')));
  const workspaceRoot = path.join(temporary, 'root');
  const bookshelf = path.join(workspaceRoot, 'bookshelf');
  await fs.mkdir(workspaceRoot);
  await fs.cp(path.join(root, 'examples/sample-project'), bookshelf, { recursive: true });
  git(bookshelf, 'init', '-q', '-b', 'main');
  git(bookshelf, 'add', '.');
  git(bookshelf, 'commit', '-q', '-m', 'Sample maps');
  const extras = [];
  if (process.env.FLOW_ACCEPTANCE_EXTRA) {
    const project = path.join(workspaceRoot, 'real-size');
    await fs.mkdir(path.join(project, 'docs/maps'), { recursive: true });
    for (const entry of process.env.FLOW_ACCEPTANCE_EXTRA.split(',')) {
      const [file, kind] = entry.split(':');
      const name = path.basename(file);
      await fs.writeFile(path.join(project, 'docs/maps', name), prepareFlowSource(await fs.readFile(file, 'utf8'), kind, name.replace(/\.mmd$/, '')));
      extras.push({ name, kind });
    }
    git(project, 'init', '-q', '-b', 'main');
  }
  return { temporary, workspaceRoot, bookshelf, maps: path.join(bookshelf, 'docs/maps'), extras };
}

async function startServer(environment) {
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, FINAL_SHAPE_MAP_PORT: String(port), ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await until(async () => (await fetch(`${origin}/api/health`)).ok, { timeout: 15000, message: `server did not start: ${output}` });
  return child;
}

async function apiMap(map, project = 'bookshelf') {
  const response = await fetch(`${origin}/api/map?project=${project}&map=${map}`);
  return response.json();
}

async function screenshot(page, name, note) {
  const file = path.join(shots, `${name}.png`);
  await page.screenshot({ path: file });
  screenshots[name] = { file: path.relative(root, file), note };
  console.log(`    screenshot ${path.relative(root, file)}`);
}

async function geometry(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.react-flow__node[data-id]')].filter((node) => !node.dataset.id.startsWith('__')).map((node) => node.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < cards.length; i += 1) for (let j = i + 1; j < cards.length; j += 1) {
      const a = cards[i]; const b = cards[j];
      if (a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5) overlaps += 1;
    }
    return { cards: cards.length, overlaps, overflow: document.documentElement.scrollWidth - window.innerWidth };
  });
}

async function run() {
  await fs.mkdir(shots, { recursive: true });
  const workspace = await makeWorkspace();
  const server = await startServer({ SHAPE_MAP_WORKSPACE_ROOT: workspace.workspaceRoot, SHAPE_MAP_STATE_DIR: path.join(workspace.temporary, 'state') });
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const lendingFile = path.join(workspace.maps, '02-lending.mmd');
    const original = await fs.readFile(lendingFile, 'utf8');

    await page.goto(`${origin}/?project=bookshelf&map=02-lending.mmd`);
    await page.getByTestId('fm-workspace').waitFor();
    await page.locator('.react-flow__node[data-id="reader_open"]').waitFor();
    check('user flow opens in the shell', (await page.locator('.fm-kind').innerText()) === '유저 플로우');
    const read = await geometry(page);
    check('every step is drawn without overlap', read.cards === 21 && read.overlaps === 0, JSON.stringify(read));
    const zoom = Number((await page.locator('.fm-zoom__value').innerText()).replace('%', ''));
    check('a long user flow opens readable with the overview', zoom >= 85 && await page.locator('.react-flow__minimap').isVisible(), `${zoom}%`);
    await screenshot(page, 'shell-user-flow-1440', 'User flow tab in the real shell: opens at 90% at the start of every lane, with the overview.');
    await page.getByRole('button', { name: '지도 전체 보기' }).click();
    await page.waitForTimeout(300);

    // Edit through the server and undo byte for byte.
    await page.getByTestId('fm-step-reader_search').click();
    await page.getByTestId('fm-step-label').fill('책 검색하기');
    await page.getByTestId('fm-step-label').press('Enter');
    await until(async () => (await fs.readFile(lendingFile, 'utf8')).includes('reader_search["책 검색하기"]'), { message: 'label edit did not reach the file' });
    check('a step edit is written to the map file', true);
    await page.getByTestId('fm-arrow-label-reader_available->reader_wait').click();
    await page.getByRole('radio', { name: '주고받기' }).click();
    await until(async () => (await fs.readFile(lendingFile, 'utf8')).includes('reader_available ==>|"없어요"| reader_wait'), { message: 'arrow kind edit did not reach the file' });
    await page.keyboard.press('Escape');
    await page.locator('body').press('Meta+z');
    await until(async () => (await fs.readFile(lendingFile, 'utf8')).includes('reader_available -.->|"없어요"| reader_wait'), { message: 'first undo failed' });
    await page.locator('body').press('Meta+z');
    await until(async () => (await fs.readFile(lendingFile, 'utf8')) === original, { message: 'undo did not restore the file byte for byte' });
    check('undo restores the file byte for byte', true);
    await page.locator('body').press('Shift+Meta+z');
    await until(async () => (await fs.readFile(lendingFile, 'utf8')).includes('reader_search["책 검색하기"]'), { message: 'redo failed' });
    check('redo reapplies the edit', true);

    // An external edit on disk appears live, keeps the selection, and clears history.
    await page.getByTestId('fm-step-owner_check').click();
    const current = await fs.readFile(lendingFile, 'utf8');
    await fs.writeFile(lendingFile, current.replace('owner_check["대여 요청 확인"]', 'owner_check["요청 살펴보기"]'));
    await until(async () => (await page.getByTestId('fm-step-label').inputValue()) === '요청 살펴보기', { message: 'external edit did not appear live' });
    check('an edit on disk appears live and keeps the selection', await page.getByTestId('fm-step-owner_check').evaluate((node) => node.classList.contains('is-selected')));
    check('an edit on disk clears undo history', !(await page.getByTestId('fm-undo').isEnabled()));

    // A conflict made on disk while a save is on its way.
    let held = false;
    await page.route('**/api/mutations**', async (route) => {
      if (held) return route.continue();
      held = true;
      const before = (await apiMap('02-lending.mmd')).revision;
      const text = await fs.readFile(lendingFile, 'utf8');
      await fs.writeFile(lendingFile, text.replace('owner_accept{"빌려줄까?"}', 'owner_accept{"빌려줄지 정하기"}'));
      await until(async () => (await apiMap('02-lending.mmd')).revision !== before, { message: 'server did not notice the disk edit' });
      await route.continue();
    });
    await page.getByTestId('fm-step-label').fill('내가 쓴 제목');
    await page.getByTestId('fm-step-label').press('Enter');
    await page.getByRole('button', { name: '다시 저장' }).waitFor({ timeout: 10000 });
    check('a disk conflict keeps the typed text', (await page.getByTestId('fm-step-label').inputValue()) === '내가 쓴 제목');
    await screenshot(page, 'shell-conflict-1440', 'Save conflict made on disk: the typed title stays with a retry button.');
    await page.unroute('**/api/mutations**');
    await page.getByRole('button', { name: '다시 저장' }).click();
    await until(async () => {
      const text = await fs.readFile(lendingFile, 'utf8');
      return text.includes('owner_check["내가 쓴 제목"]') && text.includes('owner_accept{"빌려줄지 정하기"}');
    }, { message: 'retry after conflict did not keep both edits' });
    check('saving again keeps both edits', true);
    await page.keyboard.press('Escape');

    // Source edit with a server error at its line.
    await page.getByTestId('fm-open-source').click();
    const sourceText = await page.getByTestId('fm-source-text').inputValue();
    const brokenLine = sourceText.split('\n').findIndex((line) => line.includes('reader_open --> reader_search')) + 1;
    await page.getByTestId('fm-source-text').fill(sourceText.replace('reader_open --> reader_search', 'reader_open --> reader_search & nowhere'));
    await page.getByTestId('fm-source-apply').click();
    const problem = await page.getByTestId('fm-source-problem').innerText();
    const headline = await page.locator('[data-testid="fm-source-problem"] strong').innerText();
    check('a source error is shown at its line in plain Korean', headline.includes(`${brokenLine}번째 줄`) && !/[A-Za-z]{3,}/.test(headline), headline);
    await page.locator('[data-testid="fm-source-problem"] summary').click();
    check('the server words stay behind 자세히', /instead of &/.test(await page.locator('[data-testid="fm-source-problem"] .fm-detail code').innerText()), problem.replace(/\n/g, ' '));
    await screenshot(page, 'shell-source-error-1440', 'Source view showing the server validation error at its line.');
    await page.getByTestId('fm-source-text').fill(sourceText.replace('"앱 열기"', '"앱 켜기"'));
    await page.getByTestId('fm-source-apply').click();
    await until(async () => (await fs.readFile(lendingFile, 'utf8')).includes('reader_open(["앱 켜기"])'), { message: 'source edit did not apply' });
    check('a source edit is written', true);
    await page.keyboard.press('Escape');

    // The file breaks after opening, then is fixed.
    const good = await fs.readFile(lendingFile, 'utf8');
    await fs.writeFile(lendingFile, good.replace('  reader_open --> reader_search', '  reader_open --- reader_search'));
    await page.getByTestId('fm-invalid-banner').waitFor({ timeout: 10000 });
    const banner = await page.locator('[data-testid="fm-invalid-banner"] strong').innerText();
    check('a broken file shows a calm Korean banner and pauses editing', !(await page.getByTestId('fm-undo').count()) && banner.includes('연결선에 화살표가 없어요') && !/[A-Za-z]{3,}/.test(banner), banner);
    await page.locator('[data-testid="fm-invalid-banner"] summary').click();
    await screenshot(page, 'shell-invalid-1440', 'The file broke after opening: banner with its line, last good picture kept.');
    await fs.writeFile(lendingFile, good);
    await until(async () => !(await page.getByTestId('fm-invalid-banner').count()), { timeout: 10000, message: 'banner did not clear' });
    // The project list reports the map editable again on its own event, a moment after the map itself.
    check('fixing the file resumes editing', await until(async () => await page.getByTestId('fm-undo').count() === 1, { message: 'editing did not resume' }));

    // The system flow tab.
    await page.getByRole('button', { name: /^시스템 플로우/ }).click();
    await page.locator('[data-testid="fm-workspace"][data-kind="system-flow"]').waitFor();
    await page.locator('.react-flow__node[data-id="receive"]').waitFor();
    await page.getByRole('button', { name: '지도 전체 보기' }).click();
    await page.waitForTimeout(300);
    const system = await geometry(page);
    check('system flow opens as a flowchart without a lane rail', (await page.locator('.fm-rail').count()) === 0 && system.overlaps === 0, JSON.stringify(system));
    await screenshot(page, 'shell-system-flow-1440', 'System flow tab in the real shell.');
    await page.getByTestId('fm-step-next_owner').click();
    await page.getByRole('button', { name: '다음 단계 추가', exact: true }).click();
    await until(async () => (await fs.readFile(path.join(workspace.maps, '03-lending-system.mmd'), 'utf8')).includes('step-1["새 단계"]'), { message: 'system flow add did not reach the file' });
    check('adding a step to the system flow writes the file', true);
    await page.keyboard.type('다른 주인 찾기 그만두기');
    await page.keyboard.press('Enter');
    await page.locator('body').press('Escape');

    for (const extra of workspace.extras) {
      await page.goto(`${origin}/?project=real-size&map=${extra.name}`);
      await page.getByTestId('fm-workspace').waitFor();
      await page.locator('.react-flow__node[data-id]').first().waitFor();
      await page.getByRole('button', { name: '지도 전체 보기' }).click();
      await page.waitForTimeout(300);
      const measured = await geometry(page);
      const api = await apiMap(extra.name, 'real-size');
      check(`real-size ${extra.name} reads cleanly`, api.sourceStatus?.valid && measured.overlaps === 0 && measured.cards === api.graph.steps.length, JSON.stringify({ ...measured, steps: api.graph.steps.length, error: api.sourceStatus?.error }));
    }

    // Opening views at three sizes, each in a fresh browser without a remembered view.
    const views = [['bookshelf', '02-lending.mmd'], ['bookshelf', '03-lending-system.mmd'], ...workspace.extras.map((extra) => ['real-size', extra.name])];
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
      const fresh = await browser.newContext({ viewport: { width, height } });
      const small = await fresh.newPage();
      small.on('pageerror', (error) => errors.push(error.message));
      for (const [project, map] of views) {
        await small.goto(`${origin}/?project=${project}&map=${map}`);
        await small.getByTestId('fm-workspace').waitFor();
        await small.locator('.react-flow__node[data-id]').first().waitFor();
        await small.waitForTimeout(300);
        const measured = await geometry(small);
        const zoom = Number((await small.locator('.fm-zoom__value').innerText()).replace('%', ''));
        check(`${map} opens readable at ${width}px`, measured.overflow <= 0 && measured.overlaps === 0 && zoom >= 70, JSON.stringify({ ...measured, zoom }));
        await screenshot(small, `open-${map.replace(/\.mmd$/, '')}-${width}`, `${map} as it opens at ${width}×${height} (${zoom}%).`);
      }
      await fresh.close();
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
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
