import express from 'express';
import { MlcError } from '../lib/errors.mjs';
import { readRepository } from '../lib/repository.mjs';
import { getBlockState } from '../lib/shape.mjs';

function sendSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function shapeBrief(snapshot) {
  const statuses = { neutral: '현재 기능', planned: '다음 수정 대상', verified: '사람 검수 완료', changed: '직전 턴 개선', concern: '검토 필요' };
  const commentKinds = { note: '남은 의견', concern: '검토 필요', change: '개선 의견' };
  const lines = [
    `Shape map · ${snapshot.graph.nodes.find((node) => node.parentId === null)?.label || '제품 지도'}`,
    `공통 원본: ${snapshot.mapPath}`,
    `현재 버전: ${snapshot.revision}`,
    '이 지도에서 기능별 의견과 다음 변경안을 함께 논의해 주세요.',
    '기능 ID를 유지하고, 실제로 구현한 변경을 설명에 반영해 주세요.',
    '사람 검수 완료는 사용자가 직접 확인한 뒤에만 표시합니다.',
    '',
  ];
  const graph = snapshot.graph;
  for (const node of graph.nodes) {
    const state = getBlockState(graph, node);
    lines.push(`[${node.id}] ${node.label}`);
    lines.push(`상태: ${statuses[state.status]}`);
    if (node.block?.summary) lines.push(`요약: ${node.block.summary}`);
    if (node.block?.files?.length) lines.push(`파일: ${node.block.files.join(', ')}`);
    const taskLabels = { logic: '하는 일', inputs: '들어오는 것', outputs: '만들어지는 것', ui: '사용자 경험', condition: '조건' };
    for (const [field, label] of Object.entries(taskLabels)) {
      if (node.task?.[field]) lines.push(`${label}: ${node.task[field]}`);
    }
    if (node.task?.executor) {
      const executor = node.task.executor;
      lines.push(`실행: ${[executor.kind, executor.model, executor.effort].filter(Boolean).join(' / ')}`);
    }
    if (node.proposal) {
      lines.push('다음 변경안:');
      for (const [field, label] of Object.entries(taskLabels)) {
        if (node.proposal[field]) lines.push(`- ${label}: ${node.proposal[field]}`);
      }
      if (node.proposal.reason) lines.push(`- 이유: ${node.proposal.reason}`);
      if (node.proposal.executor) {
        const executor = node.proposal.executor;
        lines.push(`- 실행: ${[executor.kind, executor.model, executor.effort].filter(Boolean).join(' / ')}`);
      }
    }
    const unresolved = (node.block?.comments || []).filter((comment) => !comment.resolved);
    for (const comment of unresolved) {
      lines.push(`${commentKinds[comment.kind]}: ${comment.body} (${comment.author})`);
    }
    lines.push('');
  }
  return { text: lines.join('\n').trimEnd(), mapPath: snapshot.mapPath, revision: snapshot.revision };
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
  app.get('/api/brief', async (_request, response, next) => {
    try { response.json(shapeBrief(await store.getFreshSnapshot())); }
    catch (error) { next(error); }
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
