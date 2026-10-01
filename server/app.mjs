import express from 'express';
import { MlcError, validationError } from '../lib/errors.mjs';
import { readRepository } from '../lib/repository.mjs';
import { getBlockState } from '../lib/shape.mjs';

function sendSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function shapeBrief(snapshot, focusId) {
  const graph = snapshot.graph;
  const focus = focusId && graph.nodes.find((node) => node.id === focusId);
  if (focusId && !focus) throw validationError('The requested feature does not exist.');
  const ids = new Set(focus ? [focus.id] : graph.nodes.map((node) => node.id));
  if (focus) {
    const visit = (id) => graph.nodes.filter((node) => node.parentId === id).forEach((node) => { ids.add(node.id); visit(node.id); });
    visit(focus.id);
  }
  const statuses = { neutral: '현재 기능', planned: '다음 수정 대상', verified: '사람 검수 완료', changed: '직전 턴 개선', concern: '검토 필요' };
  const commentKinds = { note: '남은 의견', concern: '검토 필요', change: '개선 의견' };
  const lines = [
    `Shape map · ${snapshot.graph.nodes.find((node) => node.parentId === null)?.label || '제품 지도'}`,
    `공통 원본: ${snapshot.mapPath}`,
    `현재 버전: ${snapshot.revision}`,
    '사람이 남긴 기능별 메모와 다음 변경안을 읽고, 수정 이유와 원하는 동작을 반영해 주세요.',
    '기능 ID를 유지하고, 실제로 구현한 변경을 설명에 반영해 주세요.',
    '사람 검수 완료는 사용자가 직접 확인한 뒤에만 표시합니다.',
    '',
  ];
  if (focus) lines.push(`논의할 기능: [${focus.id}] ${focus.label}`, '이 기능과 내부 기능을 중심으로 수정하고, 연결된 다른 기능에 미치는 영향도 확인해 주세요.', '');
  const links = (graph.links || []).filter((link) => ids.has(link.source) || ids.has(link.target));
  if (links.length) {
    lines.push('기능 사이의 연결:');
    links.forEach((link) => lines.push(`- [${link.source}] → [${link.target}]: ${link.label}${link.condition ? ` / 조건: ${link.condition}` : ''}`));
    lines.push('');
  }
  for (const lens of focus ? [] : graph.lenses || []) {
    lines.push(`${lens.label}별 구성 (설명용 선택이며 실행 설정을 바꾸지 않음):`);
    lens.options.forEach((option) => lines.push(`- ${option.label}: ${option.description || ''} / 관련 기능: ${option.roots.join(', ')}${option.custom?.length ? ` / 고유 로직: ${option.custom.join(', ')}` : ''}${option.pending?.length ? ` / 설계·미연결: ${option.pending.join(', ')}` : ''}`));
    lines.push('');
  }
  for (const node of graph.nodes.filter((node) => ids.has(node.id))) {
    const state = getBlockState(graph, node);
    lines.push(`[${node.id}] ${node.label}`);
    if (node.parentId) lines.push(`소속: [${node.parentId}] ${graph.nodes.find((parent) => parent.id === node.parentId)?.label || ''}`);
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
  app.get('/api/brief', async (request, response, next) => {
    try {
      const focus = request.query.focus;
      if (focus !== undefined && (typeof focus !== 'string' || !focus)) throw validationError('focus must be a feature ID.');
      response.json(shapeBrief(await store.getFreshSnapshot(), focus));
    }
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
