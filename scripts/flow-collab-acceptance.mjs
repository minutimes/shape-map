#!/usr/bin/env node
/*
 * Browser acceptance for collaboration on flow maps: memos, proposals, human
 * review, recorded turns, the four derived colors, the AI handoff, and explicit
 * links between flow steps and features (both ways, and a link whose feature was
 * removed). Builds a throwaway workspace with a copy of the synthetic sample
 * project, starts a production server, runs the full loop at 1440×900, and checks
 * the same panels at 1024×768 and 390×844. Checks that only the map files change
 * in the repository and that `map check` and `map format` still pass.
 * Run `npm run build` first. Screenshots go to test-results/flow-collab/.
 *
 *   FLOW_COLLAB_PORT=4361 node scripts/flow-collab-acceptance.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.FLOW_COLLAB_PORT || 4361);
const origin = `http://127.0.0.1:${port}`;
const shots = path.join(root, 'test-results', 'flow-collab');
const FLOW = '02-lending.mmd';
const FEATURES = '01-features.mmd';

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
async function startServer(environment) {
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, FINAL_SHAPE_MAP_PORT: String(port), ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await until(async () => (await fetch(`${origin}/api/health`)).ok, { timeout: 15_000, message: `server on ${port} did not start: ${output}` });
  return child;
}
async function screenshot(page, name) {
  const file = path.join(shots, `${name}.png`);
  await page.waitForTimeout(350);
  await page.screenshot({ path: file });
  console.log(`    screenshot ${path.relative(root, file)}`);
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const stateOf = (page, id) => page.getByTestId(`fm-step-${id}`).getAttribute('data-state');
const panelTitle = (page) => page.locator('.fm-panel__header h2').textContent();
const mapUrl = (file, extra = '') => `${origin}/?project=sample&map=${file}${extra}`;
async function readFlow(project) { return fs.readFile(path.join(project, 'docs/maps', FLOW), 'utf8'); }
async function selectStep(page, id) {
  // Show the whole map first, so a card is never behind the lane titles or a panel.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '지도 전체 보기' }).click();
  await page.waitForTimeout(250);
  await page.getByTestId(`fm-step-${id}`).click();
  await until(async () => (await page.getByTestId('fm-panel').count()) > 0);
}
async function apiMutate(file, operation) {
  const snapshot = await (await fetch(`${origin}/api/map?project=sample&map=${file}`)).json();
  const response = await fetch(`${origin}/api/mutations?project=sample&map=${file}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseRevision: snapshot.revision, clientId: 'acceptance', operation }) });
  return { status: response.status, body: await response.json() };
}

async function fullLoop(page, project) {
  await page.goto(mapUrl(FLOW));
  await page.getByTestId('fm-step-reader_search').waitFor();
  check('a fresh flow map has no derived colors or legend', (await page.getByTestId('fm-state-legend').count()) === 0 && !(await stateOf(page, 'reader_search')));

  // A concern memo turns the step yellow; undo and redo restore the file exactly.
  const before = await readFlow(project);
  await selectStep(page, 'reader_search');
  await page.getByTestId('fm-tab-comments').click();
  await page.getByTestId('fm-memo-input').fill('검색 결과 순서가 뒤죽박죽이에요');
  await page.getByRole('radio', { name: '걱정되는 점' }).click();
  await page.getByTestId('fm-memo-submit').click();
  await until(async () => (await stateOf(page, 'reader_search')) === 'concern', { message: 'concern color did not appear' });
  check('a concern memo colors the card yellow and shows in the legend', (await page.getByTestId('fm-state-legend').textContent()).includes('검토 필요1'));
  check('the memo is listed with its kind and author', (await page.getByTestId('fm-comments').textContent()).includes('걱정되는 점사람'));
  await screenshot(page, 'memo-1440');
  await page.getByTestId('fm-canvas').click({ position: { x: 30, y: 30 } });
  await page.keyboard.press('Meta+z');
  await until(async () => (await readFlow(project)) === before, { message: 'undo did not restore the file' });
  check('undo removes the memo and restores the file byte for byte', !(await stateOf(page, 'reader_search')));
  await page.keyboard.press('Meta+Shift+z');
  await until(async () => (await stateOf(page, 'reader_search')) === 'concern', { message: 'redo did not restore the memo' });
  check('redo restores the same memo the service wrote', (await readFlow(project)).includes('검색 결과 순서가 뒤죽박죽이에요'));

  // A proposal turns the step red; review waits until the proposal is settled.
  await selectStep(page, 'reader_available');
  await page.getByTestId('fm-tab-proposal').click();
  await page.getByTestId('fm-proposal-reason').fill('없을 때 기다리면 된다는 걸 몰라요');
  await page.getByTestId('fm-proposal-successCriteria').fill('알림 신청이 두 배가 된다');
  await page.getByTestId('fm-proposal-save').click();
  await until(async () => (await stateOf(page, 'reader_available')) === 'planned', { message: 'proposal color did not appear' });
  check('a proposal colors the step red and disables review', await page.getByTestId('fm-review').isDisabled());

  // Explicit feature links: pick one, open it in the features tab, come back.
  await selectStep(page, 'reader_open');
  await page.getByTestId('fm-tab-features').click();
  await page.getByTestId('fm-feature-pick').click();
  await page.getByTestId('fm-feature-search').fill('검색');
  await screenshot(page, 'feature-picker-1440');
  await page.getByTestId('fm-feature-option-search').click();
  await until(async () => (await page.getByTestId('fm-feature-links').textContent()).includes('검색'), { message: 'link did not save' });
  check('the link is written into the flow file', (await readFlow(project)).includes('"features":[{"map":"01-features.mmd","id":"search"}]'));
  check('the card shows a link mark', (await page.getByTestId('fm-step-reader_open').locator('.fm-mark').textContent()).includes('1'));
  await page.getByRole('button', { name: '다 골랐어요' }).click();
  await page.locator('.fm-links__main').first().click();
  await page.waitForURL(/map=01-features\.mmd/);
  const inspector = page.getByTestId('shape-inspector');
  await inspector.waitFor();
  check('the feature opens in the 기능 계통도 tab with its editor', (await inspector.locator('#sm-inspector-title').textContent()) === '검색');
  check('the address no longer holds the one-time link', !page.url().includes('open='));
  const reverse = page.getByTestId('feature-flow-links');
  await reverse.waitFor();
  check('the feature lists the flow steps that link to it', (await reverse.textContent()).includes('앱 열기') && (await reverse.textContent()).includes('유저 플로우'));
  await screenshot(page, 'feature-reverse-links-1440');
  await reverse.getByRole('button').first().click();
  await page.waitForURL(/map=02-lending\.mmd/);
  await until(async () => (await page.getByTestId('fm-panel').count()) && (await panelTitle(page)) === '앱 열기', { message: 'the step did not open' });
  check('the step link opens the flow with that step selected', !page.url().includes('step='));

  // Human review is explicit and drops when the step changes.
  await page.getByTestId('fm-review').click();
  await page.locator('.fm-confirm').getByRole('button', { name: '직접 확인했어요' }).click();
  await until(async () => (await stateOf(page, 'reader_open')) === 'verified', { message: 'review color did not appear' });
  check('review records the time and a content fingerprint in the file', /%% sm-block: reader_open\|\{.*"status":"verified","review":\{"at":"[^"]+","fingerprint":"[0-9a-f]{64}"\}/.test(await readFlow(project)));
  await page.getByTestId('fm-tab-content').click();
  await page.getByTestId('fm-step-label').fill('앱 처음 열기');
  await page.getByTestId('fm-step-label').press('Enter');
  await until(async () => !(await stateOf(page, 'reader_open')), { message: 'review stayed after a content change' });
  check('changing the step drops its review', !(await readFlow(project)).includes('"status":"verified"'));
  await page.getByTestId('fm-review').click();
  await page.locator('.fm-confirm').getByRole('button', { name: '직접 확인했어요' }).click();
  await until(async () => (await stateOf(page, 'reader_open')) === 'verified');

  // Turns are real snapshots; blue appears only between two recorded turns.
  await page.getByTestId('fm-open-turns').click();
  await page.getByTestId('fm-turn-title').fill('처음 모습');
  await page.getByTestId('fm-turn-submit').click();
  await until(async () => (await page.getByTestId('fm-turn-list').count()) > 0, { message: 'turn 1 not listed' });
  check('recording a turn starts a new undo history', await page.getByTestId('fm-undo').isDisabled());
  check('one recorded turn shows no blue', (await page.locator('[data-state="changed"]').count()) === 0);
  await selectStep(page, 'owner_list');
  await page.getByTestId('fm-step-label').fill('내 책 올리기');
  await page.getByTestId('fm-step-label').press('Enter');
  await until(async () => (await readFlow(project)).includes('내 책 올리기'));
  check('a live edit after a turn is not blue', !(await stateOf(page, 'owner_list')));
  await page.getByTestId('fm-open-turns').click();
  await page.getByTestId('fm-turn-title').fill('요청 확인 다듬기');
  await page.getByTestId('fm-turn-submit').click();
  await until(async () => (await stateOf(page, 'owner_list')) === 'changed', { message: 'blue did not appear after the second turn' });
  const legend = await page.getByTestId('fm-state-legend').textContent();
  check('the legend names all four colors in use', ['수정 대상1', '검토 필요1', '검수 완료1', '직전 턴 개선1'].every((text) => legend.includes(text)), legend);
  check('the file holds two numbered turns', ((await readFlow(project)).match(/%% sm-turn: \{"id":"[^"]+","number":\d/g) || []).length === 2);
  await screenshot(page, 'turns-and-colors-1440');
  // Reopen at the readable starting view to show the four colors on the cards.
  await page.evaluate(() => window.localStorage.removeItem('shape-map:flow-viewport:sample/02-lending.mmd'));
  await page.reload();
  await page.getByTestId('fm-step-owner_list').waitFor();
  await screenshot(page, 'colors-1440');

  // Reading a recorded turn: read-only, compared honestly, with an obvious way back.
  const liveBefore = await readFlow(project);
  await page.getByTestId('fm-open-turns').click();
  await page.getByTestId('fm-view-turn-2').click();
  const bar = page.getByTestId('fm-turnbar');
  await bar.waitFor();
  check('a turn opens read-only with its title', (await bar.textContent()).includes('턴 2 · 요청 확인 다듬기') && (await page.getByTestId('fm-undo').count()) === 0 && (await page.getByTestId('fm-open-brief').count()) === 0);
  check('blue in a turn is the difference from the previous recorded turn', (await stateOf(page, 'owner_list')) === 'changed' && (await stateOf(page, 'reader_search')) === 'concern');
  check('the turn bar says what changed', (await page.getByTestId('fm-turn-summary').textContent()).includes('바뀐 단계 1개'), await page.getByTestId('fm-turn-summary').textContent());
  // The readable starting view is kept: open the card where it is.
  await page.getByTestId('fm-step-owner_list').click();
  await page.getByTestId('fm-turn-diff').waitFor();
  check('a step in a turn is read-only', await page.getByTestId('fm-step-label').isDisabled() && (await page.getByTestId('fm-review').count()) === 0 && (await page.getByTestId('fm-step-brief').count()) === 0);
  check('the step shows its recorded change', (await page.getByTestId('fm-turn-diff').textContent()).includes('책 올리기') && (await page.getByTestId('fm-turn-diff').textContent()).includes('내 책 올리기'));
  await screenshot(page, 'turn-view-1440');
  await page.keyboard.press('Escape');
  await page.getByTestId('fm-open-turns').click();
  await page.getByTestId('fm-view-turn-1').click();
  await until(async () => (await bar.textContent()).includes('턴 1 · 처음 모습'));
  check('the first turn does not invent earlier changes', (await page.locator('[data-state="changed"]').count()) === 0 && (await page.getByTestId('fm-turn-summary').textContent()).includes('첫 턴'));
  check('the first turn shows the map as recorded', (await page.getByTestId('fm-step-owner_list').textContent()).includes('책 올리기') && !(await page.getByTestId('fm-step-owner_list').textContent()).includes('내 책'));
  await page.getByTestId('fm-compare-current').click();
  await until(async () => (await page.getByTestId('fm-step-owner_list').locator('.fm-mark--compare').count()) === 1, { message: 'no comparison mark' });
  check('comparing with the live map marks differences without turning them blue', (await page.locator('[data-state="changed"]').count()) === 0
    && (await page.getByTestId('fm-step-owner_list').locator('.fm-mark--compare').textContent()) === '지금과 다름');
  await screenshot(page, 'turn-compare-current-1440');
  check('reading turns never changes the live file', (await readFlow(project)) === liveBefore);
  await page.getByTestId('fm-turn-exit').click();
  await until(async () => (await page.getByTestId('fm-turnbar').count()) === 0);
  check('the way back returns to the editable live map', (await page.getByTestId('fm-undo').count()) === 1 && (await page.getByTestId('fm-step-owner_list').textContent()).includes('내 책 올리기'));

  // Memos on a lane: the same kinds and resolve flow; an open concern is yellow.
  await page.getByTestId('fm-lane-owner').locator('.fm-rail__title').click();
  await page.getByTestId('fm-lane-tab-comments').click();
  await page.getByTestId('fm-memo-input').fill('책 주인의 답이 너무 늦어요');
  await page.getByRole('radio', { name: '걱정되는 점' }).click();
  await page.getByTestId('fm-memo-submit').click();
  await until(async () => (await page.getByTestId('fm-lane-owner').getAttribute('class')).includes('is-attention'), { message: 'lane memo mark missing' });
  check('a lane concern shows on the lane and in the legend', (await page.getByTestId('fm-lane-status').textContent()).includes('검토 필요')
    && (await page.getByTestId('fm-state-legend').textContent()).includes('검토 필요2'));
  check('the lane memo is written to the flow file', /%% sm-block: owner\|\{"comments":\[\{[^\n]*책 주인의 답이 너무 늦어요/.test(await readFlow(project)));
  await screenshot(page, 'lane-memo-1440');
  await page.getByTestId('fm-comments').getByRole('button', { name: '논의 마침' }).click();
  await until(async () => !(await page.getByTestId('fm-lane-owner').getAttribute('class')).includes('is-attention'), { message: 'resolved lane memo still marked' });
  check('resolving the lane memo clears the yellow', (await page.getByTestId('fm-lane-status').textContent()).includes('걱정이 없어요'));
  await page.getByTestId('fm-comments').getByRole('button', { name: '다시 열기' }).click();
  await until(async () => (await page.getByTestId('fm-lane-owner').getAttribute('class')).includes('is-attention'));
  await page.keyboard.press('Escape');

  // The AI handoff: problem, purpose, success criteria, and approval.
  await page.getByTestId('fm-open-brief').click();
  const brief = page.getByTestId('fm-brief');
  await brief.waitFor();
  check('approval waits for a problem and success criteria', await page.getByTestId('fm-brief-approve').isDisabled());
  await page.getByTestId('fm-brief-problem').fill('빌리는 사람이 책을 찾다가 그만둬요');
  await page.getByTestId('fm-brief-successCriteria').fill('검색에서 대여 신청까지 세 번 안에 간다');
  await page.getByTestId('fm-brief-approve').check();
  await page.getByTestId('fm-brief-generate').click();
  const text = await until(async () => { const value = await page.getByTestId('fm-brief-text').inputValue(); return value.includes('승인했습니다') && value; }, { message: 'approved brief not generated' });
  check('the map brief names the canonical file and the approval', text.includes('지도: docs/maps/02-lending.mmd') && text.includes('문제: 빌리는 사람이'));
  check('the map brief does not copy the whole map', !text.includes('[owner_payout]'));
  await screenshot(page, 'brief-1440');
  await page.getByTestId('fm-brief-purpose').fill('끝까지 빌리게');
  check('changing the request clears the approval', !(await page.getByTestId('fm-brief-approve').isChecked()));
  await page.keyboard.press('Escape');
  await selectStep(page, 'reader_available');
  await page.getByTestId('fm-step-brief').click();
  const stepText = await until(async () => { const value = await page.getByTestId('fm-brief-text').inputValue(); return value.includes('[reader_available]') && value; }, { message: 'step brief not generated' });
  check('a step brief starts from the step proposal and names its neighbors', stepText.includes('문제: 없을 때 기다리면') && stepText.includes('다음 단계: [reader_request]'));
  await page.keyboard.press('Escape');

  // A linked feature that disappears stays in the file and is named as missing.
  const removed = await apiMutate(FEATURES, { type: 'deleteSubtrees', ids: ['search'] });
  check('the feature is removed from the features map', removed.status === 200, String(removed.status));
  await selectStep(page, 'reader_open');
  await page.getByTestId('fm-tab-features').click();
  await until(async () => (await page.getByTestId('fm-feature-links').textContent()).includes('찾을 수 없는 기능'), { message: 'missing feature not shown' });
  check('the missing link stays in the flow file', (await readFlow(project)).includes('"id":"search"'));
  await screenshot(page, 'missing-feature-1440');
  check('no horizontal page scroll at 1440', (await noOverflow(page)) <= 0);
}

async function lightPass(page, width) {
  await page.goto(mapUrl(FLOW));
  await page.getByTestId('fm-step-reader_search').waitFor();
  await selectStep(page, 'reader_search');
  await page.getByTestId('fm-tab-comments').click();
  await page.getByTestId('fm-comments').waitFor();
  check(`${width}: the memo tab lists the saved memo`, (await page.getByTestId('fm-comments').textContent()).includes('뒤죽박죽'));
  const box = await page.getByTestId('fm-panel').boundingBox();
  check(`${width}: the step panel fits the window`, box.x >= 0 && box.x + box.width <= width + 1, JSON.stringify(box));
  check(`${width}: no horizontal page scroll`, (await noOverflow(page)) <= 0);
  await screenshot(page, `memo-${width}`);
  await selectStep(page, 'reader_open');
  await page.getByTestId('fm-tab-features').click();
  await until(async () => (await page.getByTestId('fm-feature-links').textContent()).includes('찾을 수 없는 기능'));
  await screenshot(page, `features-${width}`);
  await page.keyboard.press('Escape');
  // Reopen at the readable starting view, where lane titles show in full.
  await page.evaluate(() => window.localStorage.removeItem('shape-map:flow-viewport:sample/02-lending.mmd'));
  await page.reload();
  await page.getByTestId('fm-lane-owner').locator('.fm-rail__title').click();
  await page.getByTestId('fm-lane-tab-comments').click();
  check(`${width}: the lane memo tab lists the lane memo`, (await page.getByTestId('fm-comments').textContent()).includes('책 주인의 답이'));
  await screenshot(page, `lane-memo-${width}`);
  await page.keyboard.press('Escape');
  await page.getByTestId('fm-open-turns').click();
  await page.getByTestId('fm-turn-list').waitFor();
  await screenshot(page, `turns-${width}`);
  await page.getByTestId('fm-view-turn-2').click();
  await page.getByTestId('fm-turnbar').waitFor();
  check(`${width}: the way back is visible while reading a turn`, await page.getByTestId('fm-turn-exit').isVisible());
  check(`${width}: no horizontal page scroll while reading a turn`, (await noOverflow(page)) <= 0);
  await screenshot(page, `turn-view-${width}`);
  await page.getByTestId('fm-turn-exit').click();
  await until(async () => (await page.getByTestId('fm-turnbar').count()) === 0);
  await page.getByTestId('fm-open-brief').click();
  await page.getByTestId('fm-brief-text').waitFor();
  const briefBox = await page.getByTestId('fm-panel').boundingBox();
  check(`${width}: the AI panel fits the window`, briefBox.x >= 0 && briefBox.x + briefBox.width <= width + 1, JSON.stringify(briefBox));
  await screenshot(page, `brief-${width}`);
  await page.keyboard.press('Escape');
  await page.goto(mapUrl(FEATURES, '&open=alert'));
  await page.getByTestId('shape-inspector').waitFor();
  check(`${width}: a feature link opens the feature editor`, (await page.locator('#sm-inspector-title').textContent()) === '입고 알림');
}

async function main() {
  await fs.mkdir(shots, { recursive: true });
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shape-flow-collab-')));
  const workspaceRoot = path.join(temporary, 'root');
  const project = path.join(workspaceRoot, 'sample');
  await fs.mkdir(workspaceRoot);
  await fs.cp(path.join(root, 'examples/sample-project'), project, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'Sample maps');
  const browser = await chromium.launch({ executablePath: await headlessShellPath() });
  const pageErrors = [];
  let server;
  try {
    server = await startServer({ SHAPE_MAP_WORKSPACE_ROOT: workspaceRoot, SHAPE_MAP_STATE_DIR: path.join(temporary, 'state') });
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'ko-KR', isMobile: width < 500, hasTouch: width < 500 });
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push(error.message));
      if (width === 1440) await fullLoop(page, project);
      else await lightPass(page, width);
      await context.close();
    }
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    const changed = git(project, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).map((line) => line.trim()).sort();
    check('only the edited map files changed in the repository', JSON.stringify(changed) === JSON.stringify([`M docs/maps/${FEATURES}`, `M docs/maps/${FLOW}`]), changed.join(', '));
    const maps = path.join(project, 'docs/maps');
    const checked = execFileSync(process.execPath, [path.join(root, 'bin/mapctl.mjs'), 'check', maps], { encoding: 'utf8' });
    check('map check passes on the edited maps', checked.includes(`ok    ${FLOW}`), checked.trim().split('\n')[1]);
    const formatted = execFileSync(process.execPath, [path.join(root, 'bin/mapctl.mjs'), 'format', '--dry-run', maps], { encoding: 'utf8' });
    check('map format leaves the edited flow unchanged', formatted.includes(`same  ${FLOW}`), formatted.trim());
  } finally {
    server?.kill();
    await browser.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
