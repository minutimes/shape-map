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

export async function readMap(signal) {
  return decode(await fetch('/api/map', { signal, headers: { Accept: 'application/json' } }));
}

export async function mutateMap({ baseRevision, clientId, operation }) {
  return decode(
    await fetch('/api/mutations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ baseRevision, clientId, operation }),
    }),
  );
}

export async function saveView({ baseRevision, clientId, patch }) {
  return decode(
    await fetch('/api/view', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ baseRevision, clientId, patch }),
    }),
  );
}
