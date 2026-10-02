import { validationError } from './errors.mjs';
import { writeFlowMap } from './flowMap.mjs';
import { writeSource } from './format.mjs';
import { MAP_KINDS, normalizeMapHeader } from './mapHeader.mjs';

/*
 * Starter files for maps created from the app, and their file names.
 * Documented in docs/FORMAT.md "Creating a map". Every starter is written by
 * the same canonical writers that edits use, so `mapctl format` leaves it as is.
 */

const NEW_MAP_FIELDS = new Set(['kind', 'title', 'description']);

/** Shape map's own words for the starter content. Plain Korean, easy to replace. */
const STARTER_WORDS = Object.freeze({
  features: { category: { id: 'feature', label: '기능', description: '제품이 하는 일' } },
  'user-flow': { lane: '사용자', step: '시작' },
  'system-flow': { lane: '서비스', step: '시작' },
});

/** Validates `{ kind, title, description? }` from a create request. */
export function normalizeNewMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw validationError('A new map needs a kind and a title.');
  for (const key of Object.keys(input)) {
    if (!NEW_MAP_FIELDS.has(key)) throw validationError(`Unsupported new map field: ${key}`);
  }
  if (!MAP_KINDS.includes(input.kind)) throw validationError(`Unsupported map kind: ${input.kind ?? ''}`);
  if (typeof input.title !== 'string' || !input.title.trim()) throw validationError('Map title must be non-empty text.');
  const header = { kind: input.kind, title: input.title.trim() };
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') throw validationError('Map description must be text.');
    if (input.description.trim()) header.description = input.description.trim();
  }
  return normalizeMapHeader(header);
}

/** Mermaid cannot read a double quote inside a label; the header keeps the exact title. */
function labelFrom(title) {
  return title.replace(/"/g, '”');
}

/** The canonical starter source for a validated header. */
export function starterSource(header) {
  const map = normalizeMapHeader(header);
  if (map.kind === 'features') {
    const { category } = STARTER_WORDS.features;
    return writeSource({
      direction: 'LR',
      map,
      nodes: [{ id: 'root', label: labelFrom(map.title || '제품'), parentId: null, shape: 'rounded', category: category.id, layout: { mode: 'fit' } }],
      categories: [{ ...category, fill: '#FFFFFF', stroke: '#D9D9DE', textColor: '#28282C', strokeWidth: 1 }],
    });
  }
  const words = STARTER_WORDS[map.kind];
  return writeFlowMap({
    map,
    direction: 'LR',
    lanes: [{ id: 'lane-1', title: words.lane, tags: [] }],
    steps: [{ id: 'step-1', label: words.step, shape: 'milestone', lane: 'lane-1', tags: [] }],
    arrows: [],
    tags: [],
  });
}

const KIND_SLUGS = Object.freeze({ features: 'features', 'user-flow': 'user-flow', 'system-flow': 'system-flow' });
const SLUG_MAX = 40;

/** ASCII words of the title, or the kind when the title has none (a Korean title, for example). */
export function mapSlug(title, kind) {
  const ascii = String(title).normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '');
  return ascii || KIND_SLUGS[kind] || 'map';
}

/** The leading number of a file name such as `03-rooms.mmd`, or null. */
function prefixOf(name) {
  const match = /^(\d+)[-_ .]/.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Candidate names for a new map, in the order they should be tried. The number
 * comes after every numbered name already in the folder, so the new map is
 * listed last in its tab. `existing` holds every entry name in the folder.
 */
export function* mapFileNames(title, kind, existing) {
  const slug = mapSlug(title, kind);
  const highest = existing.reduce((max, name) => Math.max(max, prefixOf(name) ?? 0), 0);
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  for (let number = highest + 1, tries = 0; tries < 50; number += 1, tries += 1) {
    const name = `${String(number).padStart(2, '0')}-${slug}.mmd`;
    if (!taken.has(name.toLowerCase())) yield name;
  }
}
