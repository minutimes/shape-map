import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parsePort(environment = process.env) {
  const port = Number(environment.FINAL_SHAPE_MAP_PORT || environment.MLC_PORT || environment.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  return port;
}

export function resolveServicePaths({ projectRoot = root, environment = process.env } = {}) {
  const port = parsePort(environment);
  const configuredInstanceKey = environment.FINAL_SHAPE_MAP_INSTANCE_KEY
    || environment.MLC_INSTANCE_KEY;
  const instanceKey = configuredInstanceKey || `port-${port}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(instanceKey)) {
    throw new Error('Instance key must use 1-64 letters, numbers, dots, underscores, or hyphens.');
  }
  const configuredRunDir = environment.FINAL_SHAPE_MAP_RUN_DIR || environment.MLC_RUN_DIR;
  const runDir = configuredRunDir
    ? path.resolve(projectRoot, configuredRunDir)
    : path.join(projectRoot, '.run');
  return {
    port,
    instanceKey,
    runDir,
    pidPath: path.join(runDir, `server-${instanceKey}.pid`),
    logPath: path.join(runDir, `server-${instanceKey}.log`),
    // The original single-instance launcher used this file. Keep recognizing it
    // for the untouched 4317 demo until that process is stopped once.
    legacyPidPath: !configuredInstanceKey && port === 4317
      ? path.join(runDir, 'server.pid')
      : null,
    url: `http://127.0.0.1:${port}`,
  };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(pidPath) {
  try {
    return Number((await fsp.readFile(pidPath, 'utf8')).trim());
  } catch {
    return null;
  }
}

async function readRunningPid(paths) {
  const candidates = [paths.pidPath, paths.legacyPidPath].filter(Boolean);
  for (const candidate of candidates) {
    const pid = await readPid(candidate);
    if (isAlive(pid)) return { pid, pidPath: candidate };
  }
  return null;
}

async function removePidFiles(paths) {
  const candidates = [...new Set([paths.pidPath, paths.legacyPidPath].filter(Boolean))];
  await Promise.all(candidates.map((candidate) => fsp.rm(candidate, { force: true })));
}

async function waitForHealth(url, expectedPid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (expectedPid && !isAlive(expectedPid)) return false;
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return true;
    } catch {
      // The loopback listener may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 160));
  }
  return false;
}

export async function runService(command, { projectRoot = root, environment = process.env } = {}) {
  const paths = resolveServicePaths({ projectRoot, environment });
  const { port, runDir, pidPath, logPath, url } = paths;

  if (command === 'start') {
    await fsp.mkdir(runDir, { recursive: true });
    const running = await readRunningPid(paths);
    if (running) {
      console.log(`already running: ${url} (pid ${running.pid})`);
      return paths;
    }
    await removePidFiles(paths);
    if (!fs.existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
      throw new Error('dist is missing; run `npm run build` first.');
    }

    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: projectRoot,
      detached: true,
      env: { ...environment, FINAL_SHAPE_MAP_PORT: String(port) },
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
    await fsp.writeFile(pidPath, `${child.pid}\n`, 'utf8');

    const healthy = await waitForHealth(url, child.pid);
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (!healthy || !isAlive(child.pid)) {
      if (isAlive(child.pid)) process.kill(child.pid, 'SIGTERM');
      await removePidFiles(paths);
      throw new Error(`server did not become healthy; inspect ${logPath}`);
    }
    console.log(`running: ${url} (pid ${child.pid})`);
    return paths;
  }

  if (command === 'stop') {
    const running = await readRunningPid(paths);
    if (!running) {
      await removePidFiles(paths);
      console.log(`not running: ${paths.instanceKey}`);
      return paths;
    }
    const { pid } = running;
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await removePidFiles(paths);
    if (isAlive(pid)) throw new Error(`pid ${pid} did not stop; inspect it before retrying.`);
    console.log(`stopped: ${paths.instanceKey}`);
    return paths;
  }

  if (command === 'status') {
    const running = await readRunningPid(paths);
    if (!running) {
      console.log(`stopped: ${paths.instanceKey}`);
      process.exitCode = 1;
      return paths;
    }
    const { pid } = running;
    const healthy = await waitForHealth(url, pid, 1200);
    console.log(`${healthy ? 'healthy' : 'running-unhealthy'}: ${url} (pid ${pid})`);
    if (!healthy) process.exitCode = 1;
    return paths;
  }

  throw new Error('usage: node scripts/service.mjs <start|stop|status>');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runService(process.argv[2]);
