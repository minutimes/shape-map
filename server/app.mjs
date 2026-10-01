import express from 'express';
import { MlcError, validationError } from '../lib/errors.mjs';
import { readRepository } from '../lib/repository.mjs';
import { discussionBrief } from '../lib/discussion.mjs';

function sendSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createApiApp(store) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/map', async (_request, response, next) => {
    try { response.json(await store.getFreshSnapshot()); }
    catch (error) { next(error); }
  });
  app.get('/api/repository', async (_request, response, next) => {
    try {
      const snapshot = await store.getFreshSnapshot();
      response.json(await readRepository(store, snapshot.graph));
    } catch (error) { next(error); }
  });
  app.get('/api/health', async (_request, response, next) => {
    try {
      const snapshot = await store.getFreshSnapshot();
      response.json({ ok: true, mapPath: snapshot.mapPath, revision: snapshot.revision, sourceValid: snapshot.sourceStatus.valid });
    } catch (error) { next(error); }
  });
  app.get('/api/brief', async (request, response, next) => {
    try {
      const focus = request.query.focus;
      if (focus !== undefined && (typeof focus !== 'string' || !focus)) throw validationError('focus must be a feature ID.');
      response.json(discussionBrief(await store.getFreshSnapshot(), focus));
    }
    catch (error) { next(error); }
  });
  app.post('/api/brief', async (request, response, next) => {
    try {
      const { focus, problem = '', purpose = '', successCriteria = '', approved = false } = request.body || {};
      if (focus !== undefined && focus !== null && (typeof focus !== 'string' || !focus)) throw validationError('focus must be a feature ID.');
      if ([problem, purpose, successCriteria].some((value) => typeof value !== 'string' || value.length > 4000) || typeof approved !== 'boolean') throw validationError('Invalid discussion request.');
      if (approved && (!problem.trim() || !successCriteria.trim())) throw validationError('An approved request needs a problem and success criteria.');
      response.json(discussionBrief(await store.getFreshSnapshot(), focus, { problem, purpose, successCriteria, approved }));
    } catch (error) { next(error); }
  });
  app.get('/api/subtree/:id', async (request, response, next) => {
    try {
      const depth = request.query.depth === undefined ? 2 : Number(request.query.depth);
      response.json(await store.getFreshSubtree(request.params.id, depth));
    } catch (error) { next(error); }
  });
  app.post('/api/mutations', async (request, response, next) => {
    try { response.json(await store.mutate(request.body)); }
    catch (error) { next(error); }
  });
  app.put('/api/view', async (request, response, next) => {
    try { response.json(await store.updateView(request.body)); }
    catch (error) { next(error); }
  });
  app.get('/api/events', (request, response) => {
    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    response.flushHeaders();
    sendSse(response, 'snapshot', store.getSnapshot());
    const onSnapshot = (snapshot) => sendSse(response, 'snapshot', snapshot);
    const onSourceError = (payload) => sendSse(response, 'source-error', payload);
    store.on('snapshot', onSnapshot);
    store.on('source-error', onSourceError);
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 20_000);
    request.on('close', () => {
      clearInterval(heartbeat);
      store.off('snapshot', onSnapshot);
      store.off('source-error', onSourceError);
    });
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      response.status(400).json({ code: 'invalid_json', message: 'Request body is not valid JSON.' });
      return;
    }
    if (error instanceof MlcError) {
      const status = error.code === 'revision_conflict' || error.code === 'field_conflict' ? 409 : 422;
      response.status(status).json({ code: error.code, message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(status === 409 ? { snapshot: store.getSnapshot() } : {}) });
      return;
    }
    console.error(error);
    response.status(500).json({ code: 'internal_error', message: 'Internal server error.' });
  });
  return app;
}
