// Unsaved text per element and field. A draft lives here, outside the panel
// that shows it, so selecting another element never throws typing away. It
// leaves only when it is saved or the person discards it.

export const draftKey = (kind, id, field) => `${kind}:${id}:${field}`;

export function parseDraftKey(key) {
  const [kind, ...rest] = String(key).split(':');
  const field = rest.pop();
  return { kind, id: rest.join(':'), field };
}

export function createDraftStore() {
  const drafts = new Map();
  const listeners = new Set();
  let version = 0;
  const changed = () => { version += 1; for (const listener of listeners) listener(); };
  return {
    get: (key) => drafts.get(key) ?? null,
    /** Records text that differs from the saved value; `status` is editing, saving, or failed. */
    set(key, draft) {
      drafts.set(key, { status: 'editing', ...drafts.get(key), ...draft });
      changed();
    },
    /** Forgets a draft after it saved, or when the person chose the saved text instead. */
    clear(key) { if (drafts.delete(key)) changed(); },
    entries: () => [...drafts.entries()],
    failed: () => [...drafts.entries()].filter(([, draft]) => draft.status === 'failed'),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    version: () => version,
  };
}
