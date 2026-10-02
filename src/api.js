async function decode(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || '요청을 완료하지 못했습니다.');
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

/**
 * Every request of one open map goes through one binding, so a pending request
 * or a delayed save can never reach another map. `binding` is null for the
 * single configured map, or `{ project, map }` for a project map.
 */
export function createMapApi(binding = null) {
  const params = binding ? new URLSearchParams({ project: binding.project, map: binding.map }).toString() : '';
  const url = (path) => (params ? `${path}${path.includes('?') ? '&' : '?'}${params}` : path);
  const json = { 'Content-Type': 'application/json', Accept: 'application/json' };
  return Object.freeze({
    binding,
    url,
    eventsUrl: url('/api/events'),
    // Browser drafts are keyed by project as well as map path.
    storagePrefix: binding ? `project:${binding.project}:` : '',
    editorHref: params ? `/?${params}&editor=1` : '?editor=1',
    workspaceHref: params ? `/?${params}` : '/',
    readMap: async (signal) => decode(await fetch(url('/api/map'), { signal, headers: { Accept: 'application/json' } })),
    mutateMap: async ({ baseRevision, clientId, operation }) => decode(await fetch(url('/api/mutations'), {
      method: 'POST', headers: json, body: JSON.stringify({ baseRevision, clientId, operation }),
    })),
    saveView: async ({ baseRevision, clientId, patch }) => decode(await fetch(url('/api/view'), {
      method: 'PUT', headers: json, body: JSON.stringify({ baseRevision, clientId, patch }),
    })),
    requestBrief: async (request) => decode(await fetch(url('/api/brief'), {
      method: 'POST', headers: json, body: JSON.stringify(request),
    })),
    // Explicit links between flow steps and features of this project (project maps only).
    readLinks: binding ? async () => decode(await fetch(`/api/project/links?${new URLSearchParams({ project: binding.project })}`, { headers: { Accept: 'application/json' } })) : null,
  });
}

export const legacyMapApi = createMapApi(null);
export const { readMap, mutateMap, saveView } = legacyMapApi;

export async function readJson(path, signal) {
  return decode(await fetch(path, { signal, headers: { Accept: 'application/json' } }));
}
