import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveServicePaths, runService } from '../scripts/service.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoUrl = new URL('../maps/demo.mmd', import.meta.url);
const running = [];
const temporaryRoots = [];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

afterEach(async () => {
  while (running.length) await runService('stop', running.pop()).catch(() => {});
  while (temporaryRoots.length) await fs.rm(temporaryRoots.pop(), { recursive: true, force: true });
});

describe('local service instances', () => {
  it('uses separate pid and log files per port or explicit instance key', () => {
    const byPortA = resolveServicePaths({ projectRoot, environment: { FINAL_SHAPE_MAP_PORT: '4317' } });
    const byPortB = resolveServicePaths({ projectRoot, environment: { FINAL_SHAPE_MAP_PORT: '4319' } });
    const named = resolveServicePaths({ projectRoot, environment: {
      FINAL_SHAPE_MAP_PORT: '4319', FINAL_SHAPE_MAP_INSTANCE_KEY: 'wve-map',
    } });
    expect(byPortA.pidPath).not.toBe(byPortB.pidPath);
    expect(byPortA.logPath).not.toBe(byPortB.logPath);
    expect(byPortA.legacyPidPath).toMatch(/server\.pid$/);
    expect(byPortB.legacyPidPath).toBeNull();
    expect(named.pidPath).toMatch(/server-wve-map\.pid$/);
    expect(() => resolveServicePaths({ projectRoot, environment: {
      FINAL_SHAPE_MAP_PORT: '4319', FINAL_SHAPE_MAP_INSTANCE_KEY: '../escape',
    } })).toThrow(/Instance key/);
  });

  it('stops one port instance without stopping the other', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'final-shape-services-'));
    temporaryRoots.push(temporaryRoot);
    const dataRoot = path.join(temporaryRoot, 'data');
    const runDir = path.join(temporaryRoot, 'run');
    const serviceRoot = path.join(temporaryRoot, 'app');
    await fs.mkdir(dataRoot);
    await fs.copyFile(demoUrl, path.join(dataRoot, 'demo.mmd'));
    await fs.mkdir(path.join(serviceRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(serviceRoot, 'dist', 'index.html'), '<!doctype html><title>Service fixture</title>');
    await fs.cp(path.join(projectRoot, 'server'), path.join(serviceRoot, 'server'), { recursive: true });
    await fs.cp(path.join(projectRoot, 'lib'), path.join(serviceRoot, 'lib'), { recursive: true });
    await fs.symlink(path.join(projectRoot, 'node_modules'), path.join(serviceRoot, 'node_modules'), 'dir');
    const [portA, portB] = await Promise.all([freePort(), freePort()]);
    const makeOptions = (port) => ({ projectRoot: serviceRoot, environment: {
      ...process.env,
      FINAL_SHAPE_MAP_PORT: String(port),
      FINAL_SHAPE_MAP_RUN_DIR: runDir,
      FINAL_SHAPE_MAP_DATA_ROOT: dataRoot,
      FINAL_SHAPE_MAP_PATH: 'demo.mmd',
    } });
    const first = makeOptions(portA);
    const second = makeOptions(portB);
    await runService('start', first);
    running.push(first);
    await runService('start', second);
    running.push(second);

    expect((await fetch(`http://127.0.0.1:${portA}/api/health`)).ok).toBe(true);
    expect((await fetch(`http://127.0.0.1:${portB}/api/health`)).ok).toBe(true);
    await runService('stop', first);
    running.splice(running.indexOf(first), 1);
    await expect(fetch(`http://127.0.0.1:${portA}/api/health`)).rejects.toThrow();
    expect((await fetch(`http://127.0.0.1:${portB}/api/health`)).ok).toBe(true);
  }, 20_000);
});
