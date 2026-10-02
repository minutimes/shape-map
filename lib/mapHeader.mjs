import { validationError } from './errors.mjs';

/** Kinds this version can edit. Visible names live in the client (src/mapKinds.js). */
export const MAP_KINDS = Object.freeze(['features', 'user-flow', 'system-flow']);
export const MAP_HEADER_RE = /^%%\s*sm-map:\s*([^\r\n]*)$/;
export const MAP_TITLE_MAX = 80;
export const MAP_DESCRIPTION_MAX = 400;
const HEADER_KEYS = new Set(['kind', 'title', 'description']);

export function textLength(value) {
  return [...value].length;
}

/** Reads the header object; `kinds` limits which declared kinds are accepted. */
export function normalizeMapHeader(header, kinds = MAP_KINDS) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw validationError('Map header must be an object.');
  for (const key of Object.keys(header)) {
    if (!HEADER_KEYS.has(key)) throw validationError(`Unsupported map header field: ${key}`);
  }
  if (typeof header.kind !== 'string' || !header.kind) throw validationError('Map header needs a kind.');
  if (!kinds.includes(header.kind)) throw validationError(`Unsupported map kind: ${header.kind}`);
  const normalized = { kind: header.kind };
  if (header.title !== undefined) {
    if (typeof header.title !== 'string' || !header.title.trim()) throw validationError('Map title must be non-empty text.');
    if (textLength(header.title) > MAP_TITLE_MAX) throw validationError(`Map title must be at most ${MAP_TITLE_MAX} characters.`);
    if (/[\r\n]/.test(header.title)) throw validationError('Map title must be one line.');
    normalized.title = header.title;
  }
  if (header.description !== undefined) {
    if (typeof header.description !== 'string' || !header.description.trim()) throw validationError('Map description must be non-empty text.');
    if (textLength(header.description) > MAP_DESCRIPTION_MAX) throw validationError(`Map description must be at most ${MAP_DESCRIPTION_MAX} characters.`);
    if (/[\r\n]/.test(header.description)) throw validationError('Map description must be one line.');
    normalized.description = header.description;
  }
  return normalized;
}

export function writeMapHeader(header) {
  return `%% sm-map: ${JSON.stringify(normalizeMapHeader(header))}`;
}

/**
 * Finds the declared header without validating the rest of the file.
 * Returns { header, line } or { error, line } or null when the file has none.
 */
export function readDeclaredHeader(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  let found = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(MAP_HEADER_RE);
    if (!match) continue;
    if (found) return { ...found, error: `Line ${index + 1}: duplicate map header.`, line: index + 1 };
    let parsed;
    try { parsed = JSON.parse(match[1]); } catch { return { error: `Line ${index + 1}: invalid map header JSON.`, line: index + 1 }; }
    found = { raw: parsed, line: index + 1 };
  }
  return found;
}
