#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createMapStore } from '../lib/store.mjs';
import { createApiApp } from './app.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const port = Number(process.env.FINAL_SHAPE_MAP_PORT || process.env.MLC_PORT || process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const dataRoot = process.env.FINAL_SHAPE_MAP_DATA_ROOT
  || process.env.FINAL_SHAPE_DATA_ROOT
  || process.env.MLC_MAP_DATA_ROOT
  || process.env.MLC_DATA_ROOT
  || projectRoot;

const store = await createMapStore({
  projectRoot,
  dataRoot,
  mapPath: process.env.FINAL_SHAPE_MAP_PATH || process.env.MLC_MAP_PATH || 'maps/shape-map.mmd',
});
const app = createApiApp(store);
let vite;

if (dev) {
  const { createServer } = await import('vite');
  vite = await createServer({ root: projectRoot, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const dist = path.join(projectRoot, 'dist');
  app.use(express.static(dist));
  app.get(/.*/, (_request, response) => response.sendFile(path.join(dist, 'index.html')));
}

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Shape map listening at http://127.0.0.1:${port}`);
});

async function shutdown() {
  server.close();
  await vite?.close();
  await store.close();
}
process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));
