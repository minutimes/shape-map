import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineEditor } from '../src/inlineEditor.js';

const storageKey = (mapPath = 'maps/test.mmd') => `final-shape-map:inline-drafts:v1:${mapPath}`;

function snapshot({ mapPath = 'maps/test.mmd', label = 'Original', ui = 'Before', proposal, includeNode = true } = {}) {
  return {
    mapPath,
    revision: 'revision',
    graph: {
      nodes: includeNode ? [{ id: 'node', label, task: { logic: 'old', ui }, ...(proposal === undefined ? {} : { proposal }) }] : [],
    },
  };
}

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
    value: (key) => values.get(key),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function editor({ send = vi.fn(), storage = memoryStorage(), options = {} } = {}) {
  const instance = new InlineEditor({ send, storage, ...options });
  instance.refresh(snapshot());
  return instance;
}

afterEach(() => vi.useRealTimers());

describe('InlineEditor autosave', () => {
  it('batches rapid changes into one request with only the current values', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async ({ changes }) => snapshot({
      label: changes.find((change) => change.path === 'label')?.after ?? 'Original',
      ui: changes.find((change) => change.path === 'task.ui')?.after ?? 'Before',
    }));
    const instance = editor({ send });

    instance.change('node', 'label', 'O');
    instance.change('node', 'label', 'One');
    instance.change('node', 'label', 'One final');
    instance.change('node', 'task.ui', 'Changed');
    await vi.advanceTimersByTimeAsync(650);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual({
      type: 'patchNodeContent', id: 'node', changes: [
        { path: 'label', before: 'Original', after: 'One final' },
        { path: 'task.ui', before: 'Before', after: 'Changed' },
      ],
    });
    expect(instance.hasDrafts()).toBe(false);
  });

  it('flushes continuous typing at the maximum wait rather than delaying forever', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async ({ changes }) => snapshot({ label: changes[0].after }));
    const instance = editor({ send, options: { debounceMs: 650, maxWaitMs: 4000 } });

    for (let index = 0; index < 8; index++) {
      instance.change('node', 'label', `draft ${index}`);
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].changes[0]).toMatchObject({ after: 'draft 7' });
  });

  it('does not submit an IME composition until composition ends', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async ({ changes }) => snapshot({ label: changes[0].after }));
    const instance = editor({ send });

    instance.setComposing('node', 'label', true);
    instance.change('node', 'label', '가');
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();

    instance.setComposing('node', 'label', false);
    await vi.advanceTimersByTimeAsync(650);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].changes[0].after).toBe('가');
  });

  it('keeps keystrokes made during an in-flight request and sends them next', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    const send = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const instance = editor({ send });

    instance.change('node', 'label', 'First');
    await vi.advanceTimersByTimeAsync(650);
    expect(send).toHaveBeenCalledOnce();
    instance.change('node', 'label', 'Second');
    first.resolve(snapshot({ label: 'First' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].changes).toEqual([{ path: 'label', before: 'First', after: 'Second' }]);
    second.resolve(snapshot({ label: 'Second' }));
    await Promise.resolve();
    expect(instance.hasDrafts()).toBe(false);
  });

  it('acknowledges a retry after a lost response without leaving a duplicate draft', async () => {
    vi.useFakeTimers();
    const lostResponse = new Error('offline');
    const send = vi.fn()
      .mockRejectedValueOnce(lostResponse)
      // The server already applied the first operation, so retry reads its canonical result.
      .mockResolvedValueOnce(snapshot({ label: 'Saved once' }));
    const instance = editor({ send });

    instance.change('node', 'label', 'Saved once');
    await vi.advanceTimersByTimeAsync(650);
    expect(instance.getNodeState('node').fields.label).toMatchObject({ status: 'error', code: 'network' });

    instance.retry('node', true);
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    expect(instance.hasDrafts()).toBe(false);
  });

  it('automatically retries only the non-conflicting field from a partially conflicted batch', async () => {
    vi.useFakeTimers();
    const savedUi = deferred();
    const conflict = Object.assign(new Error('same field changed'), {
      status: 409,
      body: { code: 'field_conflict', snapshot: snapshot({ label: 'Remote title', ui: 'Before' }) },
    });
    const send = vi.fn().mockRejectedValueOnce(conflict).mockReturnValueOnce(savedUi.promise);
    const instance = editor({ send });

    instance.change('node', 'label', 'Local title');
    instance.change('node', 'task.ui', 'Local UI');
    await vi.advanceTimersByTimeAsync(650);
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual({
      type: 'patchNodeContent', id: 'node', changes: [{ path: 'task.ui', before: 'Before', after: 'Local UI' }],
    });
    expect(instance.getNodeState('node').fields.label).toMatchObject({
      status: 'conflict', value: 'Local title', remote: 'Remote title',
    });

    savedUi.resolve(snapshot({ label: 'Remote title', ui: 'Local UI' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.getNodeState('node').fields).toEqual({
      label: expect.objectContaining({ status: 'conflict', value: 'Local title', remote: 'Remote title' }),
    });
  });

  it('continues an explicit proposal removal after its own child-field save is acknowledged', async () => {
    vi.useFakeTimers();
    const savedLogic = deferred();
    const removed = deferred();
    const send = vi.fn().mockReturnValueOnce(savedLogic.promise).mockReturnValueOnce(removed.promise);
    const instance = editor({ send });
    instance.refresh(snapshot({ proposal: { logic: 'Old logic' } }));

    instance.change('node', 'proposal.logic', 'Saved logic');
    await vi.advanceTimersByTimeAsync(650);
    instance.change('node', 'proposal', null);
    savedLogic.resolve(snapshot({ proposal: { logic: 'Saved logic' } }));
    await vi.advanceTimersByTimeAsync(0);

    expect(instance.getNodeState('node').fields.proposal).toMatchObject({ status: 'saving', value: null });
    expect(send.mock.calls[1][0].changes).toEqual([{
      path: 'proposal', before: { logic: 'Saved logic' }, after: null,
    }]);
    removed.resolve(snapshot({ proposal: undefined }));
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.hasDrafts()).toBe(false);
  });

  it('marks proposal removal conflicted when an external proposal field changes during its child save', async () => {
    vi.useFakeTimers();
    const savedLogic = deferred();
    const send = vi.fn(() => savedLogic.promise);
    const instance = editor({ send });
    instance.refresh(snapshot({ proposal: { logic: 'Old logic', ui: 'Old UI' } }));

    instance.change('node', 'proposal.logic', 'Saved logic');
    await vi.advanceTimersByTimeAsync(650);
    instance.change('node', 'proposal', null);
    savedLogic.resolve(snapshot({ proposal: { logic: 'Saved logic', ui: 'Third-party UI' } }));
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledOnce();
    expect(instance.getNodeState('node').fields.proposal).toMatchObject({
      status: 'conflict', value: null, remote: { logic: 'Saved logic', ui: 'Third-party UI' },
    });
  });

  it('restores drafts only for the current map and marks a same-field external edit as a conflict', () => {
    const stored = JSON.stringify({ version: 1, entries: [{ id: 'node', fields: {
      label: { before: 'Original', value: 'Local draft', status: 'pending' },
    } }] });
    const storage = memoryStorage({ [storageKey()]: stored, [storageKey('maps/other.mmd')]: stored });
    const instance = editor({ storage });

    expect(instance.getNodeState('node').fields.label).toMatchObject({ value: 'Local draft', status: 'pending' });
    instance.refresh(snapshot({ label: 'AI changed this field' }));
    expect(instance.getNodeState('node').fields.label).toMatchObject({
      status: 'conflict', remote: 'AI changed this field', before: 'Original', value: 'Local draft',
    });
  });

  it('does not carry an in-memory draft into a different map', () => {
    const instance = editor();
    instance.change('node', 'label', 'Draft for the first map');

    instance.refresh(snapshot({ mapPath: 'maps/second.mmd', label: 'Second map label' }));

    expect(instance.hasDrafts()).toBe(false);
    expect(instance.getNodeState('node').fields).toEqual({});
  });

  it('does not let an old map response replace the map selected during its save', async () => {
    vi.useFakeTimers();
    const response = deferred();
    const nextResponse = deferred();
    const send = vi.fn().mockReturnValueOnce(response.promise).mockReturnValueOnce(nextResponse.promise);
    const instance = editor({ send });
    instance.change('node', 'label', 'A draft');
    await vi.advanceTimersByTimeAsync(650);
    expect(send).toHaveBeenCalledOnce();

    instance.refresh(snapshot({ mapPath: 'maps/second.mmd', label: 'B current' }));
    instance.change('node', 'label', 'B draft');
    response.resolve(snapshot({ label: 'A draft' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(instance.snapshot.mapPath).toBe('maps/second.mmd');
    expect(instance.snapshot.graph.nodes[0].label).toBe('B current');
    expect(instance.getNodeState('node').fields.label).toMatchObject({ value: 'B draft', status: 'saving' });
    nextResponse.resolve(snapshot({ mapPath: 'maps/second.mmd', label: 'B draft' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.hasDrafts()).toBe(false);
  });

  it('preserves a local draft through unrelated external changes and applies explicit conflict choices', async () => {
    const send = vi.fn(async ({ changes }) => snapshot({ label: changes[0].after, ui: 'AI changed UI' }));
    const instance = editor({ send });

    instance.change('node', 'label', 'Local draft');
    instance.refresh(snapshot({ ui: 'AI changed UI' }));
    expect(instance.getNodeState('node').fields.label).toMatchObject({ status: 'pending', value: 'Local draft' });

    instance.refresh(snapshot({ label: 'AI label', ui: 'AI changed UI' }));
    instance.resolve('node', 'label', 'remote');
    expect(instance.hasDrafts()).toBe(false);

    instance.change('node', 'label', 'Another local');
    instance.refresh(snapshot({ label: 'Another AI label', ui: 'AI changed UI' }));
    instance.resolve('node', 'label', 'local');
    await Promise.resolve();
    await Promise.resolve();
    expect(send.mock.calls.at(-1)[0].changes).toEqual([{ path: 'label', before: 'Another AI label', after: 'Another local' }]);
  });

  it('surfaces browser storage failure while retaining the in-memory draft', () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn(() => { throw new Error('quota'); }), removeItem: vi.fn() };
    const instance = editor({ storage });

    instance.change('node', 'label', 'Unsaved locally');
    expect(instance.getSummary().storageError).toMatch(/보관하지 못했습니다/);
    expect(instance.getNodeState('node').fields.label.value).toBe('Unsaved locally');
  });

  it('retains a draft for a deleted node as a visible error instead of discarding it', () => {
    const instance = editor();
    instance.change('node', 'label', 'Keep this');
    instance.refresh(snapshot({ includeNode: false }));

    expect(instance.entries()).toEqual([{ id: 'node', label: 'node', fields: expect.objectContaining({
      label: expect.objectContaining({ value: 'Keep this', status: 'error', code: 'deleted' }),
    }) }]);
  });
});
