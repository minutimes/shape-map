import { MlcError, validationError } from './errors.mjs';
import { parseSource } from './format.mjs';
import { FLOW_KINDS, parseFlowMap } from './flowMap.mjs';
import { MAP_KINDS, readDeclaredHeader } from './mapHeader.mjs';
import { mermaidErrorLine, validateMermaid } from './mermaid-validator.mjs';

/*
 * One place decides what a project map file is: its kind, whether Shape map can
 * edit it, and if not, why (with the line at fault when there is one).
 */

export function errorLine(error) {
  const fromDetails = error?.details?.line ?? error?.line;
  if (Number.isInteger(fromDetails)) return fromDetails;
  const match = String(error?.message || '').match(/^Line (\d+):/);
  if (match) return Number(match[1]);
  return mermaidErrorLine(error?.message);
}

function diagramType(source) {
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%') || line === '---') continue;
    return line.split(/\s+/)[0];
  }
  return '';
}

/** Kind detection reads the header (or the v1 marker) without validating the rest. */
export function detectMapKind(source) {
  const header = readDeclaredHeader(source);
  if (header?.error) return { kind: 'other', error: header.error, line: header.line };
  if (header) {
    const declared = header.raw?.kind;
    if (MAP_KINDS.includes(declared)) return { kind: declared, headerLine: header.line };
    if (typeof declared === 'string' && declared) {
      return { kind: 'other', declaredKind: declared, error: `Line ${header.line}: map kind ${declared} is not supported by this version of Shape map.`, line: header.line };
    }
    return { kind: 'other', error: `Line ${header.line}: the map header needs a kind.`, line: header.line };
  }
  const lines = source.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim());
  if (lines.includes('%% mlc-format: 1')) return { kind: 'features' };
  const type = diagramType(source);
  if (type === 'flowchart' || type === 'graph') {
    return { kind: 'other', error: 'This flowchart has no %% sm-map: header, so Shape map shows it without editing.' };
  }
  return { kind: 'other', diagramType: type || null, error: `Shape map shows ${type || 'this'} diagrams without editing.` };
}

export class MapSourceError extends MlcError {
  constructor(message, { kind, declaredKind, line } = {}) {
    super('validation_error', message, line !== undefined ? { line } : undefined);
    this.kind = kind;
    if (declaredKind !== undefined) this.declaredKind = declaredKind;
    if (line !== undefined) this.line = line;
  }
}

/** Parses an editable map. Throws MapSourceError naming the kind and line. */
export function parseMapSource(source) {
  const detected = detectMapKind(source);
  if (detected.kind === 'other') throw new MapSourceError(detected.error, detected);
  try {
    const graph = FLOW_KINDS.includes(detected.kind) ? parseFlowMap(source) : parseSource(source);
    return { kind: detected.kind, graph };
  } catch (error) {
    throw new MapSourceError(error.message, { kind: detected.kind, line: errorLine(error) });
  }
}

export async function validateMapMermaid(source, kind) {
  try { await validateMermaid(source); }
  catch (error) { throw new MapSourceError(error.message, { kind, line: errorLine(error) }); }
}

/** Parse and Mermaid-validate. */
export async function readEditableMap(source) {
  const parsed = parseMapSource(source);
  await validateMapMermaid(source, parsed.kind);
  return parsed;
}

export function mapTitle(kind, graph, file) {
  if (graph?.map?.title) return graph.map.title;
  if (kind === 'features' && graph) return graph.nodes.find((node) => node.parentId === null)?.label || file.replace(/\.mmd$/, '');
  return file.replace(/\.mmd$/, '');
}

function declaredHeader(source) {
  const header = readDeclaredHeader(source);
  return header && !header.error && header.raw && typeof header.raw === 'object' ? header.raw : null;
}

/** Map list entry as documented in docs/API.md "Projects". */
export async function classifyMap(source, file) {
  const entry = { file, path: `docs/maps/${file}` };
  try {
    const { kind, graph } = await readEditableMap(source);
    return { ...entry, kind, title: mapTitle(kind, graph, file),
      ...(graph.map?.description ? { description: graph.map.description } : {}), editable: true };
  } catch (error) {
    const kind = error.kind || 'other';
    const header = declaredHeader(source);
    const title = typeof header?.title === 'string' && header.title.trim() ? header.title.slice(0, 80) : file.replace(/\.mmd$/, '');
    const description = typeof header?.description === 'string' && header.description.trim() ? header.description.slice(0, 400) : undefined;
    const line = error.line ?? errorLine(error);
    return { ...entry, kind, title, ...(description ? { description } : {}), editable: false,
      ...(error.declaredKind ? { declaredKind: error.declaredKind } : {}),
      error: error.message || 'This map cannot be read.', ...(Number.isInteger(line) ? { line } : {}) };
  }
}

export function assertKind(snapshot, kinds, route) {
  if (snapshot.editable === false) {
    throw new MlcError('read_only_map', 'This map cannot be edited until its source is fixed.', { error: snapshot.sourceStatus?.error, ...(snapshot.sourceStatus?.line ? { line: snapshot.sourceStatus.line } : {}) });
  }
  const kind = snapshot.kind || 'features';
  if (!kinds.includes(kind)) throw new MlcError('unsupported_map_kind', `${route} supports ${kinds.join(' and ')} maps only; this is a ${kind} map.`);
}

export { validationError };
