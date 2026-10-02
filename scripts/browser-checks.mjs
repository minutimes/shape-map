#!/usr/bin/env node
/*
 * Runs every browser check: builds the app once, then runs each
 * scripts/*-acceptance.mjs in its own process (each picks free loopback ports),
 * prints one line per check and a summary, and exits nonzero on any failure.
 *
 *   npm run test:browser                     build, then run all checks
 *   npm run test:browser -- flow shell       only checks whose name contains a word
 *   npm run test:browser -- --skip-build     reuse the current dist/
 *   npm run test:browser -- --jobs 1         run one check at a time (default 3)
 *   npm run test:browser -- --list           list the checks without running them
 *
 * Full output of each check: test-results/browser-checks/<name>.log
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(root, 'test-results', 'browser-checks');
const timeoutMs = Number(process.env.BROWSER_CHECK_TIMEOUT_MS) || 5 * 60_000;

function parseArgs(argv) {
  const options = { build: true, jobs: 3, list: false, filters: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skip-build') options.build = false;
    else if (arg === '--list') options.list = true;
    else if (arg === '--jobs') options.jobs = Number(argv[++index]);
    else if (arg.startsWith('--jobs=')) options.jobs = Number(arg.slice(7));
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else options.filters.push(arg);
  }
  if (!Number.isInteger(options.jobs) || options.jobs < 1) throw new Error('--jobs needs a whole number of 1 or more.');
  return options;
}

async function discover(filters) {
  const names = (await fs.readdir(path.join(root, 'scripts')))
    .filter((file) => file.endsWith('-acceptance.mjs'))
    .map((file) => file.replace(/-acceptance\.mjs$/, ''))
    .sort();
  return filters.length ? names.filter((name) => filters.some((filter) => name.includes(filter))) : names;
}

function run(command, args, { logFile, timeout } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    running.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    let timedOut = false;
    const timer = timeout ? setTimeout(() => { timedOut = true; stop(child); }, timeout) : null;
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      running.delete(child);
      if (timedOut) output += `\n[browser-checks] stopped after ${Math.round(timeout / 1000)}s without finishing.\n`;
      if (logFile) await fs.writeFile(logFile, output);
      resolve({ ok: code === 0 && !timedOut, code, signal, timedOut, output, seconds: (Date.now() - started) / 1000 });
    });
  });
}

const running = new Set();
function stop(child) {
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM'); // the check and the server and browser it started
  } catch { /* already gone */ }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { running.forEach(stop); process.exit(130); });
}

function tail(text, lines = 30) {
  return text.trimEnd().split('\n').slice(-lines).map((line) => `    ${line}`).join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const names = await discover(options.filters);
  if (options.list) {
    names.forEach((name) => console.log(`scripts/${name}-acceptance.mjs`));
    return;
  }
  if (!names.length) {
    console.error(`No browser checks match ${options.filters.join(' ') || 'scripts/*-acceptance.mjs'}.`);
    process.exitCode = 1;
    return;
  }

  await fs.rm(logDir, { recursive: true, force: true });
  await fs.mkdir(logDir, { recursive: true });
  if (options.build) {
    process.stdout.write('Building the app (npm run build)… ');
    const build = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { logFile: path.join(logDir, 'build.log') });
    if (!build.ok) {
      console.log('failed');
      console.error(tail(build.output));
      process.exitCode = 1;
      return;
    }
    console.log(`done in ${build.seconds.toFixed(1)}s`);
  }

  console.log(`Running ${names.length} browser checks, ${Math.min(options.jobs, names.length)} at a time.\n`);
  const results = [];
  const queue = [...names];
  const started = Date.now();
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const logFile = path.join(logDir, `${name}.log`);
      const result = await run(process.execPath, [path.join('scripts', `${name}-acceptance.mjs`)], { logFile, timeout: timeoutMs });
      results.push({ name, ...result });
      console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} ${result.seconds.toFixed(1).padStart(6)}s`);
      if (!result.ok) console.log(`${tail(result.output)}\n    full log: ${path.relative(root, logFile)}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.jobs, names.length) }, worker));

  const failed = results.filter((result) => !result.ok);
  const seconds = (Date.now() - started) / 1000;
  await fs.writeFile(path.join(logDir, 'summary.json'), `${JSON.stringify({
    passed: results.length - failed.length,
    failed: failed.map((result) => result.name),
    seconds,
    checks: results.map(({ name, ok, code, timedOut, seconds: time }) => ({ name, ok, code, timedOut, seconds: time })),
  }, null, 2)}\n`);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed of ${results.length} browser checks in ${seconds.toFixed(1)}s.`);
  if (failed.length) {
    console.log(`Failed: ${failed.map((result) => result.name).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
