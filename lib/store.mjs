import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { watch } from 'chokidar';
import { parseSource, writeSource } from './format.mjs';
import { applyOperation, getSubtree } from './graph.mjs';
import { MlcError, validationError } from './errors.mjs';
import { validateMermaid } from './mermaid-validator.mjs';

const DEFAULT_VIEW = Object.freeze({ positions: {}, collapsedIds: [], viewport: { x: 0, y: 0, zoom: 1 } });

function revisionFor(source) {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function isOutside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function containmentError() {
  return new Error('Map and view paths must stay inside the configured data root.');
}

function assertContainedPath(dataRoot, candidate, { allowMissing = false } = {}) {
  const lexicalCandidate = path.resolve(candidate);
  if (isOutside(dataRoot, lexicalCandidate)) throw containmentError();
  try {
    const realCandidate = realpathSync(lexicalCandidate);
    if (isOutside(dataRoot, realCandidate)) throw containmentError();
    return realCandidate;
  } catch (error) {
    if (error.code !== 'ENOENT' || !allowMissing) throw error;
    const realParent = realpathSync(path.dirname(lexicalCandidate));
    if (isOutside(dataRoot, realParent)) throw containmentError();
    return lexicalCandidate;
  }
}

async function atomicWrite(filePath, contents, expectedContents, dataRoot) {
  if (dataRoot) assertContainedPath(dataRoot, filePath, { allowMissing: true });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, contents, 'utf8');
    if (expectedContents !== undefined) {
      const current = await fs.readFile(filePath, 'utf8');
      if (current !== expectedContents) {
        throw new MlcError('revision_conflict', 'Canonical source changed while the mutation was being prepared.');
      }
    }
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function clone(value) {
  return structuredClone(value);
}

function normalizeView(input, graph) {
  const ids = new Set(graph.nodes.map(({ id }) => id));
  const positions = {};
  if (input?.positions && typeof input.positions === 'object' && !Array.isArray(input.positions)) {
    for (const [id, position] of Object.entries(input.positions)) {
      if (ids.has(id) && Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
        positions[id] = { x: position.x, y: position.y };
      }
    }
  }
  const collapsedIds = Array.isArray(input?.collapsedIds)
    ? [...new Set(input.collapsedIds.filter((id) => typeof id === 'string' && ids.has(id)))]
    : [];
  const viewport = {
    x: Number.isFinite(input?.viewport?.x) ? input.viewport.x : 0,
    y: Number.isFinite(input?.viewport?.y) ? input.viewport.y : 0,
    zoom: Number.isFinite(input?.viewport?.zoom) && input.viewport.zoom > 0 ? input.viewport.zoom : 1,
  };
  const view = { positions, collapsedIds, viewport };
  if (input?.workflow !== undefined) {
    const workflow = input.workflow && typeof input.workflow === 'object' && !Array.isArray(input.workflow)
      ? input.workflow : {};
    const normalizedWorkflow = {};
    if (Array.isArray(workflow.collapsedIds)) {
      normalizedWorkflow.collapsedIds = [
        ...new Set(workflow.collapsedIds.filter((id) => typeof id === 'string' && ids.has(id))),
      ];
    }
    if (workflow.viewport !== undefined) {
      normalizedWorkflow.viewport = {
        x: Number.isFinite(workflow.viewport?.x) ? workflow.viewport.x : 0,
        y: Number.isFinite(workflow.viewport?.y) ? workflow.viewport.y : 0,
        zoom: Number.isFinite(workflow.viewport?.zoom) && workflow.viewport.zoom > 0 ? workflow.viewport.zoom : 1,
      };
    }
    view.workflow = normalizedWorkflow;
  }
  if (input?.shape !== undefined) {
    const shape = input.shape && typeof input.shape === 'object' && !Array.isArray(input.shape)
      ? input.shape : {};
    const normalizedShape = {};
    if (shape.layoutVersion === 2) normalizedShape.layoutVersion = 2;
    if (shape.positions && typeof shape.positions === 'object' && !Array.isArray(shape.positions)) {
      normalizedShape.positions = {};
      for (const [id, position] of Object.entries(shape.positions)) {
        if (ids.has(id) && Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
          normalizedShape.positions[id] = { x: position.x, y: position.y };
        }
      }
    }
    if (Array.isArray(shape.collapsedIds)) {
      normalizedShape.collapsedIds = [...new Set(shape.collapsedIds.filter((id) => typeof id === 'string' && ids.has(id)))];
    }
    if (shape.viewport !== undefined) {
      normalizedShape.viewport = {
        x: Number.isFinite(shape.viewport?.x) ? shape.viewport.x : 0,
        y: Number.isFinite(shape.viewport?.y) ? shape.viewport.y : 0,
        zoom: Number.isFinite(shape.viewport?.zoom) && shape.viewport.zoom > 0 ? shape.viewport.zoom : 1,
      };
    }
    view.shape = normalizedShape;
  }
  return view;
}

async function readView(viewPath, graph, dataRoot) {
  try {
    assertContainedPath(dataRoot, viewPath, { allowMissing: true });
    return normalizeView(JSON.parse(await fs.readFile(viewPath, 'utf8')), graph);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return clone(DEFAULT_VIEW);
    throw error;
  }
}

export function resolveDataRoot(projectRoot, configuredRoot = projectRoot) {
  const candidate = path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.resolve(projectRoot, configuredRoot);
  return realpathSync(candidate);
}

export function resolveMapPath(dataRoot, selected = 'maps/demo.mmd') {
  const lexicalRoot = path.resolve(dataRoot);
  const lexicalCandidate = path.resolve(lexicalRoot, selected);
  if (!lexicalCandidate.endsWith('.mmd') || isOutside(lexicalRoot, lexicalCandidate)) {
    throw new Error('FINAL_SHAPE_MAP_PATH must select a .mmd file inside the configured data root.');
  }
  const root = realpathSync(lexicalRoot);
  const candidate = path.resolve(root, selected);
  try {
    return assertContainedPath(root, candidate);
  } catch (error) {
    if (error.message === containmentError().message) {
      throw new Error('FINAL_SHAPE_MAP_PATH must select a .mmd file inside the configured data root.');
    }
    throw error;
  }
}

export class MapStore extends EventEmitter {
  constructor({ projectRoot, dataRoot = projectRoot, mapPath, watchFiles = true }) {
    super();
    this.projectRoot = path.resolve(projectRoot);
    this.dataRoot = resolveDataRoot(this.projectRoot, dataRoot);
    this.mapPath = resolveMapPath(this.dataRoot, mapPath);
    this.relativeMapPath = path.relative(this.dataRoot, this.mapPath).split(path.sep).join('/');
    this.viewPath = this.mapPath.replace(/\.mmd$/, '.view.json');
    assertContainedPath(this.dataRoot, this.viewPath, { allowMissing: true });
    this.watchFiles = watchFiles;
    this.snapshot = null;
    this.validSource = null;
    this.watcher = null;
    this.queue = Promise.resolve();
  }

  async init() {
    assertContainedPath(this.dataRoot, this.mapPath);
    const source = await fs.readFile(this.mapPath, 'utf8');
    const graph = await this.#parseValidSource(source);
    const view = await readView(this.viewPath, graph, this.dataRoot);
    this.validSource = source;
    this.snapshot = this.#buildSnapshot(source, graph, view, 'startup');
    if (this.watchFiles) {
      this.watcher = watch([this.mapPath, this.viewPath], { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 } });
      this.watcher.on('add', (changed) => this.#enqueueExternal(changed));
      this.watcher.on('change', (changed) => this.#enqueueExternal(changed));
      this.watcher.on('unlink', (changed) => this.#enqueueExternal(changed));
      this.watcher.on('error', (error) => this.emit('watch-error', error));
      await new Promise((resolve, reject) => {
        this.watcher.once('ready', resolve);
        this.watcher.once('error', reject);
      });
    }
    return this;
  }

  async #parseValidSource(source) {
    const graph = parseSource(source);
    await validateMermaid(source);
    return graph;
  }

  #buildSnapshot(source, graph, view, origin) {
    return {
      revision: revisionFor(source),
      updatedAt: new Date().toISOString(),
      origin,
      mapPath: this.relativeMapPath,
      graph: clone(graph),
      view: normalizeView(view, graph),
      sourceStatus: { valid: true, error: null },
    };
  }

  getSnapshot() {
    return clone(this.snapshot);
  }

  getSubtree(id, depth = 2) {
    return {
      revision: this.snapshot.revision,
      ...(this.snapshot.graph.settings !== undefined ? { settings: clone(this.snapshot.graph.settings) } : {}),
      root: getSubtree(this.snapshot.graph, id, depth),
    };
  }

  async getFreshSnapshot() {
    return this.#runExclusive(async () => {
      await this.#reconcileSource();
      return this.getSnapshot();
    });
  }

  async getFreshSubtree(id, depth = 2) {
    return this.#runExclusive(async () => {
      await this.#reconcileSource();
      return this.getSubtree(id, depth);
    });
  }

  #runExclusive(action) {
    const pending = this.queue.then(action, action);
    this.queue = pending.catch(() => {});
    return pending;
  }

  #enqueueExternal(changedPath) {
    this.#runExclusive(async () => {
      if (path.resolve(changedPath) === path.resolve(this.viewPath)) await this.#loadExternalView();
      else await this.#loadExternalSource();
    }).catch((error) => this.emit('watch-error', error));
  }

  async #loadExternalView() {
    const view = await readView(this.viewPath, this.snapshot.graph, this.dataRoot);
    if (JSON.stringify(view) === JSON.stringify(this.snapshot.view)) return;
    this.snapshot = { ...this.snapshot, updatedAt: new Date().toISOString(), origin: 'external', view };
    this.emit('snapshot', this.getSnapshot());
  }

  async #loadExternalSource() {
    await this.#reconcileSource();
  }

  async #reconcileSource() {
    let source;
    try {
      assertContainedPath(this.dataRoot, this.mapPath);
      source = await fs.readFile(this.mapPath, 'utf8');
    } catch (error) {
      this.#recordSourceError(error.code === 'ENOENT' ? 'Canonical map file was removed.' : error.message);
      return;
    }
    if (revisionFor(source) === this.snapshot.revision && this.snapshot.sourceStatus.valid) return;
    try {
      const graph = await this.#parseValidSource(source);
      const view = normalizeView(this.snapshot.view, graph);
      this.validSource = source;
      this.snapshot = this.#buildSnapshot(source, graph, view, 'external');
      this.emit('snapshot', this.getSnapshot());
    } catch (error) {
      this.#recordSourceError(error.message);
    }
  }

  #recordSourceError(message) {
    if (!this.snapshot.sourceStatus.valid && this.snapshot.sourceStatus.error === message) return;
    this.snapshot = { ...this.snapshot, updatedAt: new Date().toISOString(), origin: 'external', sourceStatus: { valid: false, error: message } };
    this.emit('source-error', { message, snapshot: this.getSnapshot() });
  }

  async mutate({ baseRevision, clientId, operation }) {
    return this.#runExclusive(async () => {
      if (typeof clientId !== 'string' || !clientId.trim()) throw validationError('clientId must be a non-empty string.');
      await this.#reconcileSource();
      if (!this.snapshot.sourceStatus.valid) {
        throw new MlcError('invalid_source', 'Canonical source is invalid; fix it before applying mutations.', { error: this.snapshot.sourceStatus.error });
      }
      const guardedContentPatch = operation?.type === 'patchNodeContent';
      const hasStaleGuardRevision = guardedContentPatch
        && typeof baseRevision === 'string'
        && baseRevision.trim().length > 0;
      if (baseRevision !== this.snapshot.revision && !hasStaleGuardRevision) {
        throw new MlcError('revision_conflict', `Expected revision ${this.snapshot.revision}, received ${baseRevision ?? 'none'}.`);
      }
      const now = new Date().toISOString();
      const prepared = operation && typeof operation === 'object' ? { ...operation } : operation;
      if (prepared?.type === 'setBlock' || (prepared?.type === 'addNode' && prepared.block?.status === 'verified')) {
        prepared.at = now;
      }
      if (prepared?.type === 'addComment') {
        prepared.commentId = crypto.randomUUID();
        prepared.createdAt = now;
      }
      if (prepared?.type === 'createTurn') {
        prepared.turnId = crypto.randomUUID();
        prepared.createdAt = now;
        prepared.revision = this.snapshot.revision;
      }
      const graph = applyOperation(this.snapshot.graph, prepared);
      const source = writeSource(graph);
      if (source === this.validSource) return this.getSnapshot();
      await this.#parseValidSource(source);
      try {
        await atomicWrite(this.mapPath, source, this.validSource, this.dataRoot);
      } catch (error) {
        if (error.code === 'revision_conflict') await this.#reconcileSource();
        throw error;
      }
      const view = normalizeView(this.snapshot.view, graph);
      this.validSource = source;
      this.snapshot = this.#buildSnapshot(source, graph, view, clientId);
      this.emit('snapshot', this.getSnapshot());
      return this.getSnapshot();
    });
  }

  async updateView({ baseRevision, clientId, patch }) {
    return this.#runExclusive(async () => {
      if (typeof clientId !== 'string' || !clientId.trim()) throw validationError('clientId must be a non-empty string.');
      await this.#reconcileSource();
      if (!this.snapshot.sourceStatus.valid) {
        throw new MlcError('invalid_source', 'Canonical source is invalid; fix it before updating view state.', { error: this.snapshot.sourceStatus.error });
      }
      if (baseRevision !== this.snapshot.revision) {
        throw new MlcError('revision_conflict', `Expected revision ${this.snapshot.revision}, received ${baseRevision ?? 'none'}.`);
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw validationError('patch must be an object.');
      await this.#loadExternalView();
      const allowed = new Set(['positions', 'collapsedIds', 'viewport', 'workflow', 'shape']);
      for (const key of Object.keys(patch)) if (!allowed.has(key)) throw validationError(`Unsupported view patch field: ${key}`);
      let mergedPositions = this.snapshot.view.positions;
      if (patch.positions !== undefined) {
        if (!patch.positions || typeof patch.positions !== 'object' || Array.isArray(patch.positions)) throw validationError('positions must be an object.');
        mergedPositions = { ...mergedPositions, ...patch.positions };
      }
      let mergedWorkflow = this.snapshot.view.workflow;
      if (patch.workflow !== undefined) {
        if (!patch.workflow || typeof patch.workflow !== 'object' || Array.isArray(patch.workflow)) {
          throw validationError('workflow must be an object.');
        }
        const workflowAllowed = new Set(['collapsedIds', 'viewport']);
        for (const key of Object.keys(patch.workflow)) {
          if (!workflowAllowed.has(key)) throw validationError(`Unsupported workflow view patch field: ${key}`);
        }
        if (patch.workflow.collapsedIds !== undefined && !Array.isArray(patch.workflow.collapsedIds)) {
          throw validationError('workflow.collapsedIds must be an array.');
        }
        if (patch.workflow.viewport !== undefined
          && (!patch.workflow.viewport || typeof patch.workflow.viewport !== 'object'
            || Array.isArray(patch.workflow.viewport))) {
          throw validationError('workflow.viewport must be an object.');
        }
        mergedWorkflow = { ...(mergedWorkflow || {}) };
        if (patch.workflow.collapsedIds !== undefined) {
          mergedWorkflow.collapsedIds = patch.workflow.collapsedIds;
        }
        if (patch.workflow.viewport !== undefined) {
          mergedWorkflow.viewport = { ...(mergedWorkflow.viewport || {}), ...patch.workflow.viewport };
        }
      }
      let mergedShape = this.snapshot.view.shape;
      if (patch.shape !== undefined) {
        if (!patch.shape || typeof patch.shape !== 'object' || Array.isArray(patch.shape)) {
          throw validationError('shape must be an object.');
        }
        const shapeAllowed = new Set(['positions', 'collapsedIds', 'viewport', 'layoutVersion']);
        for (const key of Object.keys(patch.shape)) {
          if (!shapeAllowed.has(key)) throw validationError(`Unsupported shape view patch field: ${key}`);
        }
        mergedShape = { ...(mergedShape || {}) };
        if (patch.shape.layoutVersion !== undefined) {
          if (patch.shape.layoutVersion !== 2) throw validationError('shape.layoutVersion must be 2.');
          if (mergedShape.layoutVersion !== 2) { delete mergedShape.positions; delete mergedShape.viewport; }
          mergedShape.layoutVersion = 2;
        }
        if (patch.shape.positions !== undefined) {
          if (!patch.shape.positions || typeof patch.shape.positions !== 'object' || Array.isArray(patch.shape.positions)) {
            throw validationError('shape.positions must be an object.');
          }
          mergedShape.positions = { ...(mergedShape.positions || {}), ...patch.shape.positions };
        }
        if (patch.shape.collapsedIds !== undefined) {
          if (!Array.isArray(patch.shape.collapsedIds)) throw validationError('shape.collapsedIds must be an array.');
          mergedShape.collapsedIds = patch.shape.collapsedIds;
        }
        if (patch.shape.viewport !== undefined) {
          if (!patch.shape.viewport || typeof patch.shape.viewport !== 'object' || Array.isArray(patch.shape.viewport)) {
            throw validationError('shape.viewport must be an object.');
          }
          mergedShape.viewport = { ...(mergedShape.viewport || {}), ...patch.shape.viewport };
        }
      }
      const candidate = {
        positions: mergedPositions,
        collapsedIds: patch.collapsedIds ?? this.snapshot.view.collapsedIds,
        viewport: patch.viewport ? { ...this.snapshot.view.viewport, ...patch.viewport } : this.snapshot.view.viewport,
        ...(mergedWorkflow !== undefined ? { workflow: mergedWorkflow } : {}),
        ...(mergedShape !== undefined ? { shape: mergedShape } : {}),
      };
      const view = normalizeView(candidate, this.snapshot.graph);
      await atomicWrite(this.viewPath, `${JSON.stringify(view, null, 2)}\n`, undefined, this.dataRoot);
      this.snapshot = { ...this.snapshot, updatedAt: new Date().toISOString(), origin: clientId, view };
      this.emit('snapshot', this.getSnapshot());
      return this.getSnapshot();
    });
  }

  async close() {
    await this.watcher?.close();
  }
}

export async function createMapStore(options) {
  return new MapStore(options).init();
}
