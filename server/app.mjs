import express from 'express';
import { MlcError, validationError } from '../lib/errors.mjs';
import { readRepository } from '../lib/repository.mjs';
import { discussionBrief, flowDiscussionBrief } from '../lib/discussion.mjs';
import { FLOW_KINDS } from '../lib/flowMap.mjs';
import { assertKind } from '../lib/mapSource.mjs';
import { mapNotFound, projectNotFound } from '../lib/workspace.mjs';

function sendSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function openSse(request, response) {
  response.status(200);
  response.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  response.flushHeaders();
  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 20_000);
  request.on('close', () => clearInterval(heartbeat));
}

const NOT_FOUND_CODES = new Set(['project_not_found', 'map_not_found']);

/**
 * `store` serves the configured single map. With a `workspace`, every map route
 * also accepts `?project=KEY&map=FILE` and serves that project map instead.
 */
export function createApiApp(store, { workspace = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '17mb' }));

  async function mapStore(request) {
    const { project, map } = request.query;
    if (project === undefined && map === undefined) {
      if (!store) throw mapNotFound();
      request.mapStore = store;
      return store;
    }
    if (!workspace || typeof project !== 'string' || !project) throw projectNotFound();
    if (typeof map !== 'string' || !map) throw mapNotFound();
    const selected = await workspace.openMap(project, map);
    request.mapStore = selected;
    return selected;
  }

  app.get('/api/projects', async (_request, response, next) => {
    try {
      if (!workspace) { response.json({ workspace: false }); return; }
      response.json({ workspace: true, projects: await workspace.listProjects() });
    } catch (error) { next(error); }
  });
  app.get('/api/project', async (request, response, next) => {
    try {
      if (!workspace) throw projectNotFound();
      response.json(await workspace.listMaps(request.query.project));
    } catch (error) { next(error); }
  });
  app.get('/api/project/events', async (request, response, next) => {
    let unsubscribe;
    try {
      if (!workspace) throw projectNotFound();
      const key = request.query.project;
      const { maps } = await workspace.listMaps(key);
      unsubscribe = await workspace.subscribeMaps(key, (next) => sendSse(response, 'maps', next));
      openSse(request, response);
      sendSse(response, 'maps', maps);
      request.on('close', () => unsubscribe());
    } catch (error) {
      unsubscribe?.();
      next(error);
    }
  });

  app.get('/api/project/links', async (request, response, next) => {
    try {
      if (!workspace) throw projectNotFound();
      response.json(await workspace.projectLinks(request.query.project));
    } catch (error) { next(error); }
  });

  /** A features brief, or a flow brief that names the features its steps link to. */
  async function brief(selected, focus, request) {
    const snapshot = await selected.getFreshSnapshot();
    assertKind(snapshot, ['features', ...FLOW_KINDS], 'The brief route');
    if (!FLOW_KINDS.includes(snapshot.kind)) return discussionBrief(snapshot, focus, request);
    const labels = new Map();
    const known = new Set();
    if (workspace && selected.project?.key !== undefined) {
      const { features } = await workspace.projectLinks(selected.project.key);
      for (const map of features) {
        known.add(map.file);
        for (const node of map.nodes) labels.set(`${map.file}#${node.id}`, node.label);
      }
    }
    const featureLabel = (map, id) => labels.get(`${map}#${id}`) ?? (known.has(map) || workspace ? null : undefined);
    return flowDiscussionBrief(snapshot, focus, request, { featureLabel });
  }

  // Creating a map: a starter file in the project's docs/maps (see docs/API.md "Projects").
  app.post('/api/project/maps', async (request, response, next) => {
    try {
      if (!workspace) throw projectNotFound();
      response.status(201).json(await workspace.createMap(request.query.project, request.body));
    } catch (error) { next(error); }
  });

  app.get('/api/map', async (request, response, next) => {
    try { response.json(await (await mapStore(request)).getFreshSnapshot()); }
    catch (error) { next(error); }
  });
  app.get('/api/repository', async (request, response, next) => {
    try {
      const selected = await mapStore(request);
      const snapshot = await selected.getFreshSnapshot();
      const graph = snapshot.graph?.nodes ? snapshot.graph : { nodes: [] };
      response.json(selected.projectPath
        ? await readRepository(selected, graph, selected.projectPath)
        : await readRepository(selected, graph));
    } catch (error) { next(error); }
  });
  app.get('/api/health', async (request, response, next) => {
    try {
      const snapshot = await (await mapStore(request)).getFreshSnapshot();
      response.json({ ok: true, mapPath: snapshot.mapPath, revision: snapshot.revision, sourceValid: snapshot.sourceStatus.valid });
    } catch (error) { next(error); }
  });
  app.get('/api/brief', async (request, response, next) => {
    try {
      const focus = request.query.focus;
      if (focus !== undefined && (typeof focus !== 'string' || !focus)) throw validationError('focus must be a feature or step ID.');
      response.json(await brief(await mapStore(request), focus));
    }
    catch (error) { next(error); }
  });
  app.post('/api/brief', async (request, response, next) => {
    try {
      const selected = await mapStore(request);
      const { focus, problem = '', purpose = '', successCriteria = '', approved = false } = request.body || {};
      if (focus !== undefined && focus !== null && (typeof focus !== 'string' || !focus)) throw validationError('focus must be a feature or step ID.');
      if ([problem, purpose, successCriteria].some((value) => typeof value !== 'string' || value.length > 4000) || typeof approved !== 'boolean') throw validationError('Invalid discussion request.');
      if (approved && (!problem.trim() || !successCriteria.trim())) throw validationError('An approved request needs a problem and success criteria.');
      response.json(await brief(selected, focus ?? undefined, { problem, purpose, successCriteria, approved }));
    } catch (error) { next(error); }
  });
  app.get('/api/subtree/:id', async (request, response, next) => {
    try {
      const depth = request.query.depth === undefined ? 2 : Number(request.query.depth);
      response.json(await (await mapStore(request)).getFreshSubtree(request.params.id, depth));
    } catch (error) { next(error); }
  });
  app.post('/api/mutations', async (request, response, next) => {
    try { response.json(await (await mapStore(request)).mutate(request.body)); }
    catch (error) { next(error); }
  });
  app.put('/api/view', async (request, response, next) => {
    try { response.json(await (await mapStore(request)).updateView(request.body)); }
    catch (error) { next(error); }
  });
  app.get('/api/events', async (request, response, next) => {
    let selected;
    try { selected = await mapStore(request); }
    catch (error) { next(error); return; }
    openSse(request, response);
    sendSse(response, 'snapshot', selected.getSnapshot());
    const onSnapshot = (snapshot) => sendSse(response, 'snapshot', snapshot);
    const onSourceError = (payload) => sendSse(response, 'source-error', payload);
    selected.on('snapshot', onSnapshot);
    selected.on('source-error', onSourceError);
    request.on('close', () => {
      selected.off('snapshot', onSnapshot);
      selected.off('source-error', onSourceError);
    });
  });

  app.use((error, request, response, _next) => {
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      response.status(400).json({ code: 'invalid_json', message: 'Request body is not valid JSON.' });
      return;
    }
    if (error instanceof MlcError) {
      const conflict = error.code === 'revision_conflict' || error.code === 'field_conflict';
      const status = conflict ? 409 : NOT_FOUND_CODES.has(error.code) ? 404 : 422;
      const selected = request.mapStore || store;
      response.status(status).json({ code: error.code, message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(conflict && selected ? { snapshot: selected.getSnapshot() } : {}) });
      return;
    }
    console.error(error);
    response.status(500).json({ code: 'internal_error', message: 'Internal server error.' });
  });
  return app;
}
