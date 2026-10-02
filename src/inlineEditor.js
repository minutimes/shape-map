const EMPTY = Object.freeze({ fields: {} });
const clone = (value) => value == null ? null : structuredClone(value);
const stable = (value) => value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value ?? null;
export const sameValue = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

export function contentValue(node, path) {
  return path.split('.').reduce((value, key) => value?.[key], node) ?? null;
}

export function normalizedValue(path, value) {
  if (path.endsWith('.executor') && value) {
    const result = { kind: value.kind };
    if (value.model?.trim()) result.model = value.model.trim();
    if (value.kind === 'llm' && value.effort?.trim()) result.effort = value.effort.trim();
    if (value.kind === 'jev' || value.language === 'en') result.language = 'en';
    return result;
  }
  if (typeof value !== 'string') return clone(value);
  const text = value.trim();
  return text || (path === 'label' ? '' : null);
}

/** Per-card drafts: typing does not rebuild the graph or send a map snapshot. */
export class InlineEditor {
  constructor({ send, storage, scope = '', debounceMs = 650, maxWaitMs = 4000 }) {
    this.scope = scope;
    this.send = send;
    this.storage = storage;
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    this.nodes = new Map();
    this.drafts = new Map();
    this.listeners = new Map();
    this.summaryListeners = new Set();
    this.states = new Map();
    this.composing = new Set();
    this.flight = null;
    this.running = false;
    this.generation = 0;
    this.flushWaiters = [];
    this.disposed = false;
    this.summary = { pending: 0, saving: 0, conflicts: 0, errors: 0, count: 0, storageError: null };
  }

  subscribe = (id, listener) => {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(listener);
    return () => this.listeners.get(id)?.delete(listener);
  };
  subscribeSummary = (listener) => {
    this.summaryListeners.add(listener);
    return () => this.summaryListeners.delete(listener);
  };
  getNodeState = (id) => this.states.get(id) || EMPTY;
  getSummary = () => this.summary;
  hasDrafts = () => this.drafts.size > 0;
  entries = () => [...this.drafts].map(([id, fields]) => ({ id, label: this.nodes.get(id)?.label || id, fields: clone(fields) }));

  refresh(snapshot) {
    if (!snapshot?.graph) return;
    this.snapshot = snapshot;
    this.nodes = new Map(snapshot.graph.nodes.map((node) => [node.id, node]));
    const key = `final-shape-map:inline-drafts:v1:${this.scope}${snapshot.mapPath}`;
    if (this.key !== key) {
      this.generation++;
      this.flight = null;
      if (this.key) this.persist();
      const oldIds = [...this.drafts.keys()];
      this.drafts.clear();
      this.states.clear();
      this.composing.clear();
      this.lastEditedId = null;
      clearTimeout(this.timer);
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
      oldIds.forEach((id) => this.publish(id));
      this.key = key;
      try {
        const saved = JSON.parse(this.storage?.getItem(key) || 'null');
        if (saved?.version === 1 && Array.isArray(saved.entries)) {
          for (const { id, fields } of saved.entries) {
            if (typeof id !== 'string' || !fields || typeof fields !== 'object') continue;
            const restored = {};
            for (const [path, draft] of Object.entries(fields)) {
              if (!draft || !Object.hasOwn(draft, 'value') || !Object.hasOwn(draft, 'before')) continue;
              restored[path] = { ...draft, status: draft.status === 'conflict' ? 'conflict' : 'pending', version: 0 };
            }
            if (Object.keys(restored).length) this.drafts.set(id, restored);
          }
        }
      } catch {
        this.storageError = '복구용 초안을 읽지 못했습니다. 이 창을 닫기 전에 내용을 복사해 주세요.';
      }
    }
    for (const [id, fields] of this.drafts) {
      const node = this.nodes.get(id);
      for (const [path, draft] of Object.entries(fields)) {
        if (!node) {
          fields[path] = { ...draft, status: 'error', code: 'deleted', message: '항목이 삭제됐지만 입력한 초안은 보존했습니다.' };
          continue;
        }
        const remote = contentValue(node, path);
        const sent = this.flight?.id === id ? this.flight.changes.find((change) => change.path === path) : null;
        // Removing a proposal can follow one of our own field saves. Advance
        // that guard only if the entire new proposal is exactly our change;
        // an unrelated concurrent edit must still require a choice.
        const descendants = this.flight?.id === id
          ? this.flight.changes.filter((change) => change.path.startsWith(`${path}.`)) : [];
        const expected = clone(draft.before) || {};
        const ownParentAck = descendants.length > 0 && descendants.every((change) => {
          const key = change.path.slice(path.length + 1);
          if (key.includes('.') || !sameValue(expected[key], change.before)) return false;
          if (change.after === null) delete expected[key];
          else expected[key] = clone(change.after);
          return true;
        }) && sameValue(remote, expected);
        const isComposing = this.composing.has(`${id}:${path}`);
        if (sameValue(remote, normalizedValue(path, draft.value)) && !isComposing) {
          delete fields[path];
        } else if ((sent && sameValue(remote, sent.after)) || ownParentAck) {
          fields[path] = { ...draft, before: clone(remote), status: 'pending', remote: undefined, message: undefined };
        } else if (!sameValue(remote, draft.before)) {
          fields[path] = { ...draft, status: 'conflict', remote: clone(remote), message: '같은 항목에 다른 변경이 있습니다.' };
        } else if (draft.code === 'deleted') {
          fields[path] = { ...draft, status: 'pending', code: undefined, message: undefined };
        }
      }
      if (!Object.keys(fields).length) this.drafts.delete(id);
      this.publish(id);
    }
    this.persist();
    this.schedule();
  }

  change(id, path, value) {
    this.lastEditedId = id;
    const node = this.nodes.get(id);
    if (!node) return;
    const fields = this.drafts.get(id) || {};
    if (path === 'proposal' && value === null) {
      // The explicit removal supersedes local unsaved proposal fields. If one
      // is already in flight, let its acknowledgement update the removal guard.
      for (const key of Object.keys(fields)) {
        if (key.startsWith('proposal.')) { delete fields[key]; this.composing.delete(`${id}:${key}`); }
      }
    }
    const previous = fields[path];
    const before = previous ? previous.before : clone(contentValue(node, path));
    const sent = this.flight?.id === id && this.flight.changes.some((change) => change.path === path);
    if (!sent && sameValue(normalizedValue(path, value), before) && !this.composing.has(`${id}:${path}`)) {
      delete fields[path];
    } else {
      fields[path] = {
        before, value: clone(value), version: (previous?.version || 0) + 1,
        status: previous?.status === 'conflict' ? 'conflict' : 'pending',
        ...(previous?.status === 'conflict' ? { remote: previous.remote, message: previous.message } : {}),
      };
    }
    if (Object.keys(fields).length) this.drafts.set(id, fields);
    else this.drafts.delete(id);
    this.persist();
    this.publish(id);
    this.schedule();
  }

  setComposing(id, path, active) {
    const key = `${id}:${path}`;
    if (active) this.composing.add(key);
    else { this.composing.delete(key); this.schedule(); }
  }

  resolve(id, path, choice) {
    const fields = this.drafts.get(id);
    if (!fields?.[path]) return;
    if (choice === 'remote') delete fields[path];
    else fields[path] = { ...fields[path], before: clone(contentValue(this.nodes.get(id), path)),
      status: 'pending', remote: undefined, message: undefined, code: undefined };
    if (!Object.keys(fields).length) this.drafts.delete(id);
    this.persist();
    this.publish(id);
    if (choice === 'local') this.flush();
  }

  retry(id, networkOnly = false) {
    for (const [nodeId, fields] of this.drafts) {
      if (id && id !== nodeId) continue;
      for (const draft of Object.values(fields)) {
        if (draft.status === 'error' && (!networkOnly || draft.code === 'network')) {
          draft.status = 'pending';
          delete draft.message;
        }
      }
      this.publish(nodeId);
    }
    this.flush();
  }

  publish(id) {
    const fields = this.drafts.get(id);
    this.states.set(id, fields ? { fields: clone(fields), storageError: this.storageError } : EMPTY);
    this.listeners.get(id)?.forEach((listener) => listener());
    const next = { pending: 0, saving: 0, conflicts: 0, errors: 0, count: 0, storageError: this.storageError || null };
    for (const drafts of this.drafts.values()) {
      for (const draft of Object.values(drafts)) {
        next.count++;
        next[draft.status === 'conflict' ? 'conflicts' : draft.status === 'error' ? 'errors' : draft.status === 'saving' ? 'saving' : 'pending']++;
      }
    }
    if (!sameValue(next, this.summary)) {
      this.summary = next;
      this.summaryListeners.forEach((listener) => listener());
    }
  }

  persist() {
    if (!this.key) return;
    try {
      if (!this.storage) throw new Error('unavailable');
      if (!this.drafts.size) this.storage.removeItem(this.key);
      else this.storage.setItem(this.key, JSON.stringify({ version: 1, entries: this.entries() }));
      this.storageError = null;
    } catch {
      this.storageError = '브라우저에 복구용 초안을 보관하지 못했습니다. 저장이 끝날 때까지 이 창을 유지해 주세요.';
    }
  }

  schedule() {
    if (this.disposed || !this.drafts.size) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    if (!this.maxTimer) this.maxTimer = setTimeout(() => this.flush(), this.maxWaitMs);
  }

  async flush() {
    clearTimeout(this.timer);
    clearTimeout(this.maxTimer);
    this.maxTimer = null;
    if (this.disposed) return;
    if (this.running) return new Promise((resolve) => this.flushWaiters.push(resolve));
    this.running = true;
    try {
      while (!this.disposed) {
        let job;
        for (const [id, fields] of this.drafts) {
          const paths = Object.keys(fields).filter((path) => fields[path].status === 'pending'
            && !this.composing.has(`${id}:${path}`));
          // Creating/removing the proposal and editing its children use separate
          // guarded transactions, never an overlapping patch.
          const eligible = paths.filter((path) => !paths.some((parent) => parent !== path && path.startsWith(`${parent}.`)));
          if (eligible.length) {
            job = { id, generation: this.generation, changes: eligible.map((path) => ({ path, before: clone(fields[path].before),
              after: normalizedValue(path, fields[path].value), version: fields[path].version })) };
            break;
          }
        }
        if (!job) break;
        this.flight = job;
        const fields = this.drafts.get(job.id);
        job.changes.forEach(({ path }) => { fields[path].status = 'saving'; });
        this.publish(job.id);
        try {
          const snapshot = await this.send({ type: 'patchNodeContent', id: job.id,
            changes: job.changes.map(({ version, ...change }) => change) });
          if (job.generation !== this.generation) continue;
          this.refresh(snapshot);
          // If the server normalized a value, keep subsequent keystrokes and
          // advance their base to the acknowledged value.
          const remaining = this.drafts.get(job.id);
          for (const change of job.changes) {
            const draft = remaining?.[change.path];
            if (!draft || draft.status === 'conflict') continue;
            if (draft.version === change.version) delete remaining[change.path];
            else Object.assign(draft, { before: clone(contentValue(this.nodes.get(job.id), change.path)), status: 'pending' });
          }
          if (remaining && !Object.keys(remaining).length) this.drafts.delete(job.id);
        } catch (error) {
          if (job.generation !== this.generation) continue;
          if (error.body?.snapshot) this.refresh(error.body.snapshot);
          const remaining = this.drafts.get(job.id);
          const splitConflict = error.body?.code === 'field_conflict'
            && job.changes.some(({ path }) => remaining?.[path]?.status === 'conflict');
          for (const { path } of job.changes) {
            const draft = remaining?.[path];
            if (!draft || draft.status === 'conflict') continue;
            if (splitConflict) {
              Object.assign(draft, { status: 'pending', code: undefined, message: undefined });
              continue;
            }
            const code = error.status ? 'validation' : 'network';
            Object.assign(draft, { status: 'error', code,
              message: code === 'network' ? '연결되면 다시 저장합니다. 초안은 이 브라우저에 보관됩니다.' : (error.message || '저장하지 못했습니다.') });
          }
        } finally {
          if (job.generation === this.generation) {
            this.flight = null;
            this.persist();
            this.publish(job.id);
          }
        }
      }
    } finally {
      this.running = false;
      this.flushWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.maxTimer);
    this.persist();
  }
}
