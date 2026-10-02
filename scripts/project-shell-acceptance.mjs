#!/usr/bin/env node
/*
 * Browser acceptance for the project shell. Builds a throwaway workspace root
 * (the synthetic sample project, a worktree, a project without maps), starts a
 * production server, and checks the home list, tabs, editing a feature label,
 * read-only maps, live map additions, URL history, and legacy single-map mode.
 * Run `npm run build` first. Screenshots go to test-results/project-shell/.
 *
 *   node scripts/project-shell-acceptance.mjs   (free ports; SHAPE_MAP_ACCEPTANCE_PORT pins one)
 *   SHAPE_MAP_ACCEPTANCE_EXTRA=/path/to/repo/docs/maps  (optional, copied read-only)
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, launchBrowser } from './support/browser-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SHAPE_MAP_ACCEPTANCE_PORT) || await freePort();
const legacyPort = await freePort();
const shots = path.join(root, 'test-results', 'project-shell');
const results = [];

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Shape map acceptance', '-c', 'user.email=acceptance@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
}

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) throw new Error(`${name} failed ${detail}`);
  console.log(`ok  ${name}${detail ? ` (${detail})` : ''}`);
}

async function until(fn, { timeout = 8_000, message = 'timed out' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

async function makeWorkspace() {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shape-shell-')));
  const workspaceRoot = path.join(temporary, 'root');
  const bookshelf = path.join(workspaceRoot, 'bookshelf');
  await fs.mkdir(workspaceRoot);
  await fs.cp(path.join(root, 'examples/sample-project'), bookshelf, { recursive: true });
  // A second user flow with a broken line: it shows map chips and a read-only reason.
  const lending = await fs.readFile(path.join(bookshelf, 'docs/maps/02-lending.mmd'), 'utf8');
  await fs.writeFile(path.join(bookshelf, 'docs/maps/04-lending-draft.mmd'), lending
    .replace('"title":"책 빌리고 빌려주기"', '"title":"빌리기 초안"')
    .replace('  owner_check --> owner_accept', '  owner_check --- owner_accept'));
  git(bookshelf, 'init', '-q', '-b', 'main');
  git(bookshelf, 'add', '.');
  git(bookshelf, 'commit', '-q', '-m', 'Sample maps');
  git(bookshelf, 'worktree', 'add', '-q', '-b', 'rooms-rework', path.join(workspaceRoot, 'bookshelf-rooms'));
  await fs.mkdir(path.join(workspaceRoot, 'notes-app'));
  git(path.join(workspaceRoot, 'notes-app'), 'init', '-q', '-b', 'main');
  if (process.env.SHAPE_MAP_ACCEPTANCE_EXTRA) {
    const extra = path.join(workspaceRoot, path.basename(path.resolve(process.env.SHAPE_MAP_ACCEPTANCE_EXTRA, '../..')));
    await fs.mkdir(path.join(extra, 'docs/maps'), { recursive: true });
    for (const file of (await fs.readdir(process.env.SHAPE_MAP_ACCEPTANCE_EXTRA)).filter((name) => name.endsWith('.mmd'))) {
      await fs.copyFile(path.join(process.env.SHAPE_MAP_ACCEPTANCE_EXTRA, file), path.join(extra, 'docs/maps', file));
    }
    git(extra, 'init', '-q', '-b', 'main');
  }
  const legacy = path.join(temporary, 'legacy');
  await fs.mkdir(path.join(legacy, 'maps'), { recursive: true });
  await fs.copyFile(path.join(root, 'maps/demo.mmd'), path.join(legacy, 'maps/demo.mmd'));
  return { temporary, workspaceRoot, bookshelf, legacy };
}

async function startServer(serverPort, environment) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, env: { ...process.env, FINAL_SHAPE_MAP_PORT: String(serverPort), ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await until(async () => (await fetch(`http://127.0.0.1:${serverPort}/api/health`)).ok, { timeout: 15_000, message: `server on ${serverPort} did not start: ${output}` });
  return child;
}

async function screenshot(page, name) {
  const file = path.join(shots, `${name}.png`);
  await page.waitForTimeout(600); // let the canvas finish fitting
  await page.screenshot({ path: file });
  console.log(`    screenshot ${path.relative(root, file)}`);
}

const tabs = (page) => page.locator('.sm-shell-tabs button').evaluateAll((items) => items.map((item) => ({ text: item.textContent, current: item.getAttribute('aria-current') === 'page' })));

async function main() {
  await fs.mkdir(shots, { recursive: true });
  const workspace = await makeWorkspace();
  const servers = [];
  const browser = await launchBrowser();
  try {
    servers.push(await startServer(port, { SHAPE_MAP_WORKSPACE_ROOT: workspace.workspaceRoot, SHAPE_MAP_STATE_DIR: path.join(workspace.temporary, 'state') }));
    const origin = `http://127.0.0.1:${port}`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const requests = [];
    page.on('request', (request) => requests.push({ method: request.method(), url: request.url(), at: Date.now() }));

    // Home: every project, worktrees with their branch, quiet projects without maps.
    await page.goto(origin);
    await page.getByRole('heading', { name: '프로젝트' }).waitFor();
    const rows = await page.locator('.sm-project-list li').evaluateAll((items) => items.map((item) => ({ text: item.textContent, quiet: item.classList.contains('is-quiet'), nested: item.classList.contains('is-nested') })));
    check('home lists projects', rows.length >= 3, rows.map((row) => row.text).join(' | '));
    check('worktree shows its branch under its repository', rows.some((row) => row.nested && row.text.includes('rooms-rework') && row.text.startsWith('bookshelf')));
    const quietSection = await page.locator('.sm-project-more').evaluate((section) => ({ text: section.textContent, open: section.open })).catch(() => null);
    check('projects without maps are folded below with one hint', rows.some((row) => row.quiet && row.text.includes('notes-app'))
      && quietSection && !quietSection.open && quietSection.text.includes('docs/maps'), JSON.stringify(quietSection));
    check('projects with maps come first', rows.findIndex((row) => row.quiet) > rows.findIndex((row) => row.text.includes('bookshelf')));
    await screenshot(page, 'home-1440');

    // Project view: tabs in order, with counts; the first map opens.
    await page.locator('.sm-project-list li').filter({ hasText: 'bookshelf' }).first().getByRole('button').click();
    await page.waitForURL(/project=bookshelf&map=01-features\.mmd/);
    await page.locator('.react-flow__node').first().waitFor();
    const opened = await tabs(page);
    check('tabs are in kind order with counts', JSON.stringify(opened.map((tab) => tab.text)) === JSON.stringify(['기능 계통도1', '유저 플로우2', '시스템 플로우1', '기타 그림1']), opened.map((tab) => tab.text).join(', '));
    check('feature tab is active', opened[0].current);
    check('map title shown once', (await page.getByText('동네 책장 기능', { exact: true }).count()) >= 1 && (await page.locator('.sm-brand').count()) === 0);
    await screenshot(page, 'project-features-1440');

    // Edit a feature label; the draft is scoped by project, and the file changes on disk.
    const node = page.locator('.react-flow__node').filter({ hasText: '책 찾기' }).first();
    await node.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '이름·설명 수정' }).or(page.getByRole('button', { name: '이름·설명 수정' })).first().click();
    const label = page.getByLabel('기능 이름');
    await label.fill('책 찾아보기');
    const draftKeys = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('shape-map:draft:')));
    check('feature draft key is scoped by project and map', draftKeys.some((key) => key.startsWith('shape-map:draft:project:bookshelf:docs/maps/01-features.mmd:')), draftKeys.join(', '));
    await page.getByRole('button', { name: '설명 저장' }).click();
    const mapFile = path.join(workspace.bookshelf, 'docs/maps/01-features.mmd');
    await until(async () => (await fs.readFile(mapFile, 'utf8')).includes('find["책 찾아보기"]'), { message: 'label did not reach the project file' });
    const status = execFileSync('git', ['-C', workspace.bookshelf, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    check('feature label edit is written to the project map only', status === 'M docs/maps/01-features.mmd', status);
    await page.getByRole('button', { name: '기능 상세 닫기' }).click().catch(() => {});
    await screenshot(page, 'project-features-edited-1440');

    // Switching maps right after panning: the delayed view save never reaches another map.
    const switchAt = Date.now();
    const canvas = page.getByTestId('shape-canvas');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 240);
    await page.getByRole('button', { name: /^유저 플로우/ }).click();
    await page.waitForURL(/map=02-lending\.mmd/);
    await page.waitForTimeout(900);
    const stray = requests.filter((request) => request.at >= switchAt && request.method !== 'GET' && !request.url.includes('map=01-features.mmd'));
    check('no write reaches another map after switching', stray.length === 0, stray.map((request) => `${request.method} ${request.url}`).join(', '));
    check('flow map mounts the flow workspace', await page.getByTestId('fm-workspace').waitFor().then(() => true));
    const chips = await page.locator('.sm-shell-chips button').allTextContents();
    check('user flow tab shows map chips', chips.length === 2, chips.join(', '));
    await screenshot(page, 'project-user-flow-1440');

    // A read-only user flow: reason with its line, then the source.
    await page.locator('.sm-shell-chips button').filter({ hasText: '빌리기 초안' }).click();
    await page.getByText('보기 전용').waitFor();
    const reason = await page.locator('.sm-readonly__reason').textContent();
    check('read-only reason names the line in plain Korean', /40번째 줄/.test(reason) && /화살표/.test(reason), reason);
    await page.locator('.sm-readonly__svg svg, .sm-readonly__source').first().waitFor({ timeout: 15_000 });
    await screenshot(page, 'readonly-line-1440');
    await page.getByRole('tab', { name: '기타 그림' }).or(page.getByRole('button', { name: /^기타 그림/ })).first().click();
    await page.locator('.sm-readonly__svg svg').waitFor({ timeout: 15_000 });
    check('other diagram renders with Mermaid', true, await page.locator('.sm-readonly__reason').textContent());
    await screenshot(page, 'readonly-other-1440');
    await page.getByRole('button', { name: '원본 보기' }).click();
    check('source text is offered', (await page.locator('.sm-readonly__source li').count()) > 3);
    await screenshot(page, 'readonly-source-1440');

    // Back and forward follow the URL.
    await page.goBack();
    await page.waitForURL(/map=04-lending-draft\.mmd/);
    check('back returns to the previous map', (await tabs(page)).find((tab) => tab.current)?.text.startsWith('유저 플로우'));
    await page.goForward();
    await page.waitForURL(/map=09-sequence\.mmd/);
    check('forward returns to the later map', (await tabs(page)).find((tab) => tab.current)?.text.startsWith('기타 그림'));

    // A map file added while the page is open appears without reloading.
    const features = await fs.readFile(mapFile, 'utf8');
    await fs.writeFile(path.join(workspace.bookshelf, 'docs/maps/05-rooms.mmd'), features.replace('"title":"동네 책장 기능"', '"title":"모임방 기능"'));
    await until(async () => (await tabs(page))[0]?.text === '기능 계통도2', { message: 'added map did not appear' });
    check('added map appears live', true, (await tabs(page)).map((tab) => tab.text).join(', '));
    await page.getByRole('button', { name: /^기능 계통도/ }).click();
    await page.locator('.sm-shell-chips button').filter({ hasText: '모임방 기능' }).click();
    await page.waitForURL(/map=05-rooms\.mmd/);
    await page.locator('.react-flow__node').first().waitFor();
    await screenshot(page, 'live-added-1440');
    const added = await page.getByTestId('shape-canvas').boundingBox();
    await page.mouse.move(added.x + added.width / 2, added.y + added.height / 2);
    await page.mouse.wheel(0, 200);
    const viewFile = path.join(workspace.temporary, 'state/projects/bookshelf/05-rooms.view.json');
    await until(async () => (await fs.readFile(viewFile, 'utf8')).includes('viewport'), { message: 'view state was not saved' });
    const after = execFileSync('git', ['-C', workspace.bookshelf, 'status', '--porcelain'], { encoding: 'utf8' }).trim().split('\n');
    check('canvas state is saved outside the project', after.every((line) => /docs\/maps\/(01-features|05-rooms)\.mmd$/.test(line)), after.join(', '));

    // A deep link opens the right tab.
    const deep = await context.newPage();
    await deep.goto(`${origin}/?project=bookshelf&map=03-lending-system.mmd`);
    await deep.getByTestId('fm-workspace').waitFor();
    check('deep link opens the system flow tab', (await tabs(deep)).find((tab) => tab.current)?.text.startsWith('시스템 플로우'));
    // The detailed editor opens the same project map; other kinds go back to the shell.
    await deep.goto(`${origin}/?project=bookshelf&map=01-features.mmd&editor=1`);
    await deep.locator('.topbar').waitFor();
    await deep.getByText('책 찾아보기').first().waitFor();
    check('detailed editor opens the project map', (await deep.getByRole('link', { name: '제품 지도' }).getAttribute('href')) === '/?project=bookshelf&map=01-features.mmd');
    await deep.goto(`${origin}/?project=bookshelf&map=02-lending.mmd&editor=1`);
    await deep.waitForURL((url) => !url.search.includes('editor=1'));
    await deep.locator('.sm-shell-tabs button[aria-current="page"]').waitFor();
    check('detailed editor sends other kinds back to the shell', (await tabs(deep)).find((tab) => tab.current)?.text.startsWith('유저 플로우'));
    if (process.env.SHAPE_MAP_ACCEPTANCE_EXTRA) {
      const extraKey = path.basename(path.resolve(process.env.SHAPE_MAP_ACCEPTANCE_EXTRA, '../..'));
      await deep.goto(`${origin}/?project=${encodeURIComponent(extraKey)}`);
      await deep.waitForURL(/map=/);
      await deep.getByRole('button', { name: /^기타 그림/ }).click();
      await deep.getByText('보기 전용').waitFor();
      await deep.locator('.sm-readonly__svg svg').waitFor({ timeout: 15_000 }).catch(() => {});
      check('extra project opens with its maps', true, `${(await tabs(deep)).map((tab) => tab.text).join(', ')} · ${await deep.locator('.sm-readonly__reason').textContent()}`);
      await screenshot(deep, 'readonly-extra-1440');
    }
    await deep.close();

    // Widths: 1024 and 390.
    for (const [width, height] of [[1024, 768], [390, 844]]) {
      const narrow = await browser.newContext({ viewport: { width, height }, locale: 'ko-KR', isMobile: width < 500, hasTouch: width < 500 });
      const small = await narrow.newPage();
      small.on('pageerror', (error) => pageErrors.push(error.message));
      await small.goto(origin);
      await small.getByRole('heading', { name: '프로젝트' }).waitFor();
      await screenshot(small, `home-${width}`);
      await small.goto(`${origin}/?project=bookshelf&map=01-features.mmd`);
      await small.locator('.react-flow__node').first().waitFor();
      const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`no horizontal page scroll at ${width}px`, overflow <= 0, `${overflow}px`);
      await screenshot(small, `project-features-${width}`);
      await small.goto(`${origin}/?project=bookshelf&map=04-lending-draft.mmd`);
      await small.getByText('보기 전용').waitFor();
      await small.locator('.sm-readonly__svg svg').waitFor({ timeout: 15_000 }).catch(() => {});
      await screenshot(small, `readonly-${width}`);
      await narrow.close();
    }
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();

    // Legacy single-map mode without a workspace root.
    servers.push(await startServer(legacyPort, { SHAPE_MAP_WORKSPACE_ROOT: '', FINAL_SHAPE_MAP_DATA_ROOT: workspace.legacy, FINAL_SHAPE_MAP_PATH: 'maps/demo.mmd' }));
    const legacy = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await legacy.goto(`http://127.0.0.1:${legacyPort}/`);
    await legacy.locator('.react-flow__node').first().waitFor();
    check('legacy mode shows the single map without the project bar', (await legacy.locator('.sm-shellbar').count()) === 0 && (await legacy.locator('.sm-brand').count()) === 1);
    check('legacy projects route reports no workspace', JSON.stringify(await (await fetch(`http://127.0.0.1:${legacyPort}/api/projects`)).json()) === '{"workspace":false}');
    await screenshot(legacy, 'legacy-1440');
  } finally {
    await browser.close();
    for (const server of servers) server.kill('SIGTERM');
    if (!process.env.SHAPE_MAP_ACCEPTANCE_KEEP) await fs.rm(workspace.temporary, { recursive: true, force: true });
    await fs.writeFile(path.join(shots, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  }
  console.log(`\n${results.filter((result) => result.ok).length}/${results.length} checks passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
