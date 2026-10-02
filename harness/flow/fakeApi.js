// Development-only stand-in for the server's flow map API: the same snapshot
// shape, revision checks, error bodies, and snapshot/source-error events.
import { OperationError, SourceError, applyOperation, graphOf, parseFlow, serializeFlow } from './flowModel.js';

function hash(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) { value ^= text.charCodeAt(index); value = Math.imul(value, 0x01000193); }
  return `fake-${(value >>> 0).toString(16).padStart(8, '0')}-${text.length}`;
}

function httpError(status, body) {
  const error = new Error(body.message);
  error.status = status; error.body = body;
  return error;
}

class FakeEventSource {
  constructor(hub) {
    this.hub = hub; this.listeners = new Map(); this.closed = false; this.onopen = null; this.onerror = null;
    hub.sources.add(this);
    setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0);
  }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, payload) { if (!this.closed) for (const listener of this.listeners.get(type) || []) listener({ data: JSON.stringify(payload) }); }
  close() { this.closed = true; this.hub.sources.delete(this); }
}

const hubs = new Map();
let installed = false;
function installEventSource() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const Native = window.EventSource;
  window.EventSource = function EventSourceShim(url, options) {
    if (String(url).startsWith('fake-flow://')) return new FakeEventSource(hubs.get(String(url)));
    return new Native(url, options);
  };
}

export function createFakeFlowApi(initialSource, { latency = 80, editable = true, mapPath = 'docs/maps/example.mmd' } = {}) {
  installEventSource();
  let source = initialSource;
  let model = parseFlow(source);
  let lastGood = model;
  let status = { valid: true, error: null };
  let revision = hash(source);
  let clock = Date.parse('2026-10-01T00:00:00.000Z');
  let updatedAt = new Date(clock).toISOString();
  let origin = 'startup';
  let delay = latency;
  let positions = {};
  const id = `fake-flow://events/${Math.random().toString(36).slice(2)}`;
  const hub = { sources: new Set() };
  hubs.set(id, hub);
  const tick = () => { clock = Math.max(clock + 1, Date.now()); updatedAt = new Date(clock).toISOString(); };
  const wait = () => new Promise((resolve) => setTimeout(resolve, delay));
  const snapshot = () => ({
    revision, updatedAt, origin, mapPath, kind: lastGood.header?.kind || 'user-flow', editable, source,
    graph: graphOf(lastGood), view: { flow: { positions: liveSpots() } }, sourceStatus: status,
  });
  // Placements of steps that no longer exist are dropped, as the server does.
  const liveSpots = () => {
    const ids = new Set(graphOf(lastGood).steps.map((step) => step.id));
    return Object.fromEntries(Object.entries(positions).filter(([id]) => ids.has(id)));
  };
  const emit = (type, payload) => { for (const listener of hub.sources) listener.dispatch(type, payload); };

  function commit(next, by) {
    const text = serializeFlow(next);
    if (text === source) return false;
    source = text; model = next; lastGood = next; revision = hash(text); origin = by; tick();
    emit('snapshot', snapshot());
    return true;
  }

  const api = {
    eventsUrl: id,
    async readMap(signal) {
      await wait();
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return snapshot();
    },
    async mutateMap({ baseRevision, clientId, operation }) {
      await wait();
      if (!editable) throw httpError(422, { code: 'read_only_map', message: 'This map is read-only.' });
      if (!status.valid) throw httpError(422, { code: 'invalid_source', message: 'Canonical source is invalid; fix it before applying mutations.', details: { error: status.error } });
      if (baseRevision !== revision) throw httpError(409, { code: 'revision_conflict', message: 'The map changed.', snapshot: snapshot() });
      let next;
      try { next = applyOperation(model, operation); } catch (error) {
        if (error instanceof OperationError) throw httpError(422, { code: 'validation_error', message: error.message, details: error.line ? { line: error.line } : {} });
        throw error;
      }
      commit(next, clientId);
      return snapshot();
    },
    async saveView({ baseRevision, clientId, patch }) {
      await wait();
      if (!editable) throw httpError(422, { code: 'read_only_map', message: 'This map is read-only.' });
      if (baseRevision !== revision) throw httpError(409, { code: 'revision_conflict', message: 'The map changed.', snapshot: snapshot() });
      const ids = new Set(graphOf(lastGood).steps.map((step) => step.id));
      const changes = patch?.flow?.positions || {};
      for (const id of Object.keys(changes)) if (!ids.has(id)) throw httpError(422, { code: 'validation_error', message: `flow.positions names a step that does not exist: ${id}` });
      const next = { ...liveSpots() };
      for (const [id, spot] of Object.entries(changes)) { if (spot) next[id] = { x: spot.x, y: spot.y }; else delete next[id]; }
      positions = next; origin = clientId; tick();
      emit('snapshot', snapshot());
      return snapshot();
    },
  };

  const harness = {
    api,
    snapshot,
    setLatency(ms) { delay = ms; },
    /** Another client edits the map. */
    external(operation) { commit(applyOperation(model, operation), 'external'); return snapshot(); },
    /** Someone saves the file directly; invalid text keeps the last good picture. */
    writeFile(text) {
      try {
        const next = parseFlow(text);
        source = text; model = next; lastGood = next; status = { valid: true, error: null }; revision = hash(text); origin = 'external'; tick();
        emit('snapshot', snapshot());
      } catch (error) {
        if (!(error instanceof SourceError)) throw error;
        source = text; status = { valid: false, error: error.message, line: error.line }; origin = 'external'; tick();
        emit('source-error', { message: error.message, snapshot: snapshot() });
      }
      return snapshot();
    },
  };
  return harness;
}
