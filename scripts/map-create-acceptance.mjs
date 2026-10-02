#!/usr/bin/env node
/*
 * Browser acceptance for creating maps from the app. Builds a throwaway workspace
 * root (the synthetic sample project and three repositories without maps), starts
 * a production server, and at 1440, 1024, and 390 px: creates a first map from an
 * empty project, adds another map from the shell, and renames it. Checks that only
 * the new .mmd files appear in the repository and that they pass `map check` and
 * stay unchanged under `map format`. Run `npm run build` first.
 * Screenshots go to test-results/map-create/.
 *
 *   SHAPE_MAP_ACCEPTANCE_PORT=4381 node scripts/map-create-acceptance.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SHAPE_MAP_ACCEPTANCE_PORT || 4381);
const shots = path.join(root, 'test-results', 'map-create');
const VIEWPORTS = [[1440, 900], [1024, 768], [390, 844]];

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Shape map acceptance', '-c', 'user.email=acceptance@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: 'pipe' });
}

function check(name, condition, detail = '') {
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

async function headlessShellPath() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  const bundled = chromium.executablePath();
  const match = bundled.match(/^(.*)\/chromium-(\d+)\//);
  if (!match) return bundled;
  const candidate = path.join(match[1], `chromium_headless_shell-${match[2]}`, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
  return fs.access(candidate).then(() => candidate, () => bundled);
}

async function makeWorkspace() {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shape-create-')));
  const workspaceRoot = path.join(temporary, 'root');
  await fs.mkdir(workspaceRoot);
  const bookshelf = path.join(workspaceRoot, 'bookshelf');
  await fs.cp(path.join(root, 'examples/sample-project'), bookshelf, { recursive: true });
  git(bookshelf, 'init', '-q', '-b', 'main');
  git(bookshelf, 'add', '.');
  git(bookshelf, 'commit', '-q', '-m', 'Sample maps');
  for (const [width] of VIEWPORTS) {
    const empty = path.join(workspaceRoot, `notes-${width}`);
    await fs.mkdir(empty);
    await fs.writeFile(path.join(empty, 'README.md'), '# notes\n');
    git(empty, 'init', '-q', '-b', 'main');
    git(empty, 'add', '.');
    git(empty, 'commit', '-q', '-m', 'Notes');
  }
  return { temporary, workspaceRoot };
}

async function startServer(environment) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, env: { ...process.env, FINAL_SHAPE_MAP_PORT: String(port), ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok, { timeout: 15_000, message: `server on ${port} did not start: ${output}` });
  return child;
}

async function screenshot(page, name) {
  const file = path.join(shots, `${name}.png`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: file });
  console.log(`    screenshot ${path.relative(root, file)}`);
}

const currentTab = (page) => page.locator('.sm-shell-tabs button[aria-current="page"]').textContent();
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function main() {
  await fs.mkdir(shots, { recursive: true });
  const workspace = await makeWorkspace();
  const browser = await chromium.launch({ executablePath: await headlessShellPath() });
  let server;
  const pageErrors = [];
  try {
    server = await startServer({ SHAPE_MAP_WORKSPACE_ROOT: workspace.workspaceRoot, SHAPE_MAP_STATE_DIR: path.join(workspace.temporary, 'state') });
    const origin = `http://127.0.0.1:${port}`;
    for (const [width, height] of VIEWPORTS) {
      const key = `notes-${width}`;
      const project = path.join(workspace.workspaceRoot, key);
      const context = await browser.newContext({ viewport: { width, height }, locale: 'ko-KR', isMobile: width < 500, hasTouch: width < 500 });
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push(error.message));

      // Home: projects without maps say how to start one.
      await page.goto(origin);
      await page.getByRole('heading', { name: '프로젝트' }).waitFor();
      await page.locator('.sm-project-more summary').click();
      check(`${width}: folded projects explain how to add a first map`, (await page.locator('.sm-project-more__hint').textContent()).includes('첫 지도'));
      await page.locator('.sm-project-list li').filter({ hasText: key }).getByRole('button').click();

      // Empty project: one clear action.
      const first = page.getByRole('button', { name: '첫 지도 만들기' });
      await first.waitFor();
      check(`${width}: empty project offers a first map`, await page.getByText('이 프로젝트에는 아직 지도가 없어요.').isVisible());
      check(`${width}: no shell actions before the first map`, (await page.locator('.sm-shell-action').count()) === 0);
      await screenshot(page, `empty-project-${width}`);

      // Dialog: kind, title, optional description; an empty title is explained.
      await first.click();
      const dialog = page.getByRole('dialog', { name: '첫 지도 만들기' });
      await dialog.waitFor();
      check(`${width}: title field has focus`, await page.evaluate(() => document.activeElement?.name === 'title'));
      await dialog.getByRole('button', { name: '만들기', exact: true }).click();
      check(`${width}: empty title is explained`, (await dialog.getByRole('alert').textContent()).includes('이름을 적어 주세요'));
      await dialog.getByText('유저 플로우', { exact: true }).click();
      check(`${width}: user flow kind selected`, await dialog.getByRole('radio', { name: /유저 플로우/ }).isChecked());
      await dialog.getByLabel('이름').fill('책 빌리기');
      await dialog.getByLabel(/한 줄 설명/).fill('처음 온 사람이 책을 빌리는 흐름');
      check(`${width}: no horizontal page scroll with the dialog`, (await noOverflow(page)) <= 0);
      await screenshot(page, `create-dialog-${width}`);
      await dialog.getByRole('button', { name: '만들기', exact: true }).click();
      await page.waitForURL(new RegExp(`project=${key}&map=01-user-flow\\.mmd`));
      await page.getByTestId('fm-workspace').waitFor();
      check(`${width}: the new map opens in the user flow tab`, (await currentTab(page)).startsWith('유저 플로우'));
      await until(async () => (await page.getByText('사용자', { exact: true }).count()) > 0 && (await page.getByText('시작', { exact: true }).count()) > 0,
        { message: 'starter lane and step not drawn' });
      check(`${width}: starter lane and step are drawn`, true);
      check(`${width}: a flow map keeps its title editor beside the title, not in the shell`,
        (await page.getByRole('button', { name: '지도 이름과 설명 바꾸기' }).count()) === 0 && (await page.getByRole('button', { name: '지도 이름과 설명 보기' }).count()) === 1);
      await screenshot(page, `created-user-flow-${width}`);

      // Another map from the shell: a feature map named in ASCII.
      await page.getByRole('button', { name: '새 지도 만들기' }).click();
      const second = page.getByRole('dialog', { name: '새 지도 만들기' });
      check(`${width}: new map dialog starts on the open tab's kind`, await second.getByRole('radio', { name: /유저 플로우/ }).isChecked());
      await second.getByText('기능 계통도', { exact: true }).click();
      await second.getByLabel('이름').fill('Notes 기능');
      await page.keyboard.press('Enter');
      await page.waitForURL(new RegExp(`map=02-notes\\.mmd`));
      await page.getByTestId('shape-canvas').waitFor();
      await page.locator('.react-flow__node').first().waitFor();
      check(`${width}: the feature map opens in its tab`, (await currentTab(page)).startsWith('기능 계통도'));
      check(`${width}: the root feature carries the title`, (await page.getByText('Notes 기능').count()) > 0);
      check(`${width}: no horizontal page scroll in the project`, (await noOverflow(page)) <= 0);
      await screenshot(page, `created-features-${width}`);

      // Rename from the shell; the file name stays.
      await page.getByRole('button', { name: '지도 이름과 설명 바꾸기' }).click();
      const info = page.getByRole('dialog', { name: '지도 이름과 설명' });
      check(`${width}: info dialog names the file`, (await info.textContent()).includes('docs/maps/02-notes.mmd'));
      await info.getByLabel('이름').fill('노트 기능');
      await info.getByLabel(/한 줄 설명/).fill('노트에서 할 수 있는 일');
      await screenshot(page, `map-info-${width}`);
      await info.getByRole('button', { name: '저장', exact: true }).click();
      await info.waitFor({ state: 'detached' });
      await until(async () => (await fs.readFile(path.join(project, 'docs/maps/02-notes.mmd'), 'utf8')).includes('"title":"노트 기능","description":"노트에서 할 수 있는 일"'),
        { message: 'header not written' });
      await until(async () => (await page.getByText('노트 기능', { exact: true }).count()) > 0, { message: 'new title not shown' });
      check(`${width}: renamed map shows its new title`, true);

      // Escape closes a dialog without writing.
      await page.getByRole('button', { name: '새 지도 만들기' }).click();
      await page.getByRole('dialog', { name: '새 지도 만들기' }).waitFor();
      await page.keyboard.press('Escape');
      check(`${width}: Escape closes the dialog`, (await page.getByRole('dialog', { name: '새 지도 만들기' }).count()) === 0);

      // Only the new map files changed in the repository, and they are canonical.
      const status = git(project, 'status', '--porcelain', '--untracked-files=all').trim().split('\n').sort();
      check(`${width}: only the new maps are written into the project`, JSON.stringify(status) === JSON.stringify(['?? docs/maps/01-user-flow.mmd', '?? docs/maps/02-notes.mmd']), status.join(', '));
      const checked = execFileSync(process.execPath, ['bin/mapctl.mjs', 'check', project], { cwd: root, encoding: 'utf8' });
      check(`${width}: new maps pass map check`, /ok\s+01-user-flow\.mmd/.test(checked) && /ok\s+02-notes\.mmd/.test(checked), checked.trim().replace(/\n/g, ' / '));
      const formatted = execFileSync(process.execPath, ['bin/mapctl.mjs', 'format', '--dry-run', project], { cwd: root, encoding: 'utf8' });
      check(`${width}: new maps are already canonical`, formatted.trim().split('\n').every((line) => line.startsWith('same')), formatted.trim().replace(/\n/g, ' / '));
      await context.close();
    }

    // A project with maps: the new map is numbered after the existing ones and the
    // existing files are untouched.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${origin}/?project=bookshelf&map=03-lending-system.mmd`);
    await page.getByTestId('fm-workspace').waitFor();
    await page.getByRole('button', { name: '새 지도 만들기' }).click();
    const dialog = page.getByRole('dialog', { name: '새 지도 만들기' });
    check('existing project: new map dialog starts on system flow', await dialog.getByRole('radio', { name: /시스템 플로우/ }).isChecked());
    await dialog.getByLabel('이름').fill('반납 처리');
    await dialog.getByRole('button', { name: '만들기', exact: true }).click();
    await page.waitForURL(/map=10-system-flow\.mmd/);
    await page.getByTestId('fm-workspace').waitFor();
    const chips = await page.locator('.sm-shell-chips button').allTextContents();
    check('existing project: the new map is listed last in its tab', JSON.stringify(chips) === JSON.stringify(['대여 처리', '반납 처리']), chips.join(', '));
    await screenshot(page, 'existing-project-system-flow-1440');
    const status = git(path.join(workspace.workspaceRoot, 'bookshelf'), 'status', '--porcelain', '--untracked-files=all').trim();
    check('existing project: only the new file appears', status === '?? docs/maps/10-system-flow.mmd', status);
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close();
    server?.kill('SIGTERM');
    await fs.rm(workspace.temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
