// Shared plumbing for the browser checks in scripts/*-acceptance.mjs.
// Each check starts its own production server (run `npm run build` first) on a
// free loopback port, drives headless Chromium, and writes evidence under
// test-results/<topic>/. `npm run test:browser` builds once and runs them all.
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function waitUntil(check, { timeoutMs = 8000, intervalMs = 40, message = 'condition timed out' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A loopback port that is free right now. Never one of the owner's fixed ports. */
export async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

/** Empties and returns test-results/<topic>/ for screenshots and the report. */
export async function evidenceDir(topic) {
  const directory = path.join(root, 'test-results', topic);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

/** Headless Chromium from Playwright's cache, or PLAYWRIGHT_CHROME_PATH when set. */
export async function launchBrowser() {
  const executablePath = process.env.PLAYWRIGHT_CHROME_PATH || undefined;
  try {
    return await chromium.launch({ headless: true, executablePath });
  } catch (error) {
    throw new Error(`Chromium did not start. Install it once with \`npx playwright-core install --only-shell chromium\`.\n${error.message}`);
  }
}

/**
 * Starts `node server/index.mjs` (the production build in dist/) on a free port.
 * `env` is added to the inherited environment. Returns { origin, port, stop, restart, log }.
 */
export async function startServer(env = {}, { port: fixedPort } = {}) {
  await fs.access(path.join(root, 'dist', 'index.html')).catch(() => {
    throw new Error('dist/ is missing. Run `npm run build` first, or use `npm run test:browser`.');
  });
  const port = fixedPort || await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let child = null;
  let output = '';
  const start = async () => {
    output = '';
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: root,
      env: { ...process.env, ...env, FINAL_SHAPE_MAP_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    await waitUntil(async () => {
      if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}: ${output}`);
      return (await fetch(`${origin}/api/health`)).ok;
    }, { timeoutMs: 15000, message: `server did not start on ${origin}` });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  };
  await start();
  return { origin, port, stop, restart: async () => { await stop(); await start(); }, log: () => output };
}

/** Bounding boxes of the visible canvas cards and every overlapping pair. */
export async function cardOverlap(page, selector = '.react-flow__node') {
  return page.locator(selector).evaluateAll((elements) => {
    const nodes = elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.dataset.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const overlapPairs = [];
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const a = nodes[left];
        const b = nodes[right];
        if (a.x < b.x + b.width - 0.5 && a.x + a.width > b.x + 0.5
          && a.y < b.y + b.height - 0.5 && a.y + a.height > b.y + 0.5) overlapPairs.push([a.id, b.id]);
      }
    }
    return { nodeCount: nodes.length, nodes, overlapPairs };
  });
}
