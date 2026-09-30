import { describe, expect, it } from 'vitest';
import { parseSource, writeSource } from '../lib/format.mjs';
import { applyOperation } from '../lib/graph.mjs';
import { captureTurn, getBlockState } from '../lib/shape.mjs';
import { readingStates } from '../lib/diagram.mjs';
import { deletionHistoryEntry } from '../src/history.js';

const graph = () => parseSource(`flowchart LR
%% mlc-format: 1
root["Product"]
form["Input"]
asr["Speech"]
render["Render"]
root --> form
form --> asr
root --> render
classDef part fill:#FFFFFF,stroke:#BBBBBB,color:#222222,stroke-width:1px
class root,form,asr,render part
%% mlc-legend: part|Feature|Feature
%% sm-link: {"id":"sound","source":"asr","target":"render","kind":"data","label":"Timed speech"}
%% sm-lens: {"id":"format","label":"Video format","options":[{"id":"spoken","label":"Spoken","roots":["form","render"],"custom":["asr"]},{"id":"silent","label":"Silent","roots":["render"],"pending":["render"]}]}
`);

describe('saved connections and reading conditions', () => {
  it('round trips cross-feature links without changing hierarchy and rejects missing or duplicate endpoints', () => {
    const source = graph(); expect(parseSource(writeSource(source))).toEqual(source);
    expect(source.nodes.find((node) => node.id === 'render').parentId).toBe('root');
    expect(() => applyOperation(source, { type: 'upsertLink', link: { ...source.links[0], target: 'missing' } })).toThrow(/missing feature/);
    expect(() => applyOperation(source, { type: 'setMapLinks', links: [source.links[0], source.links[0]] })).toThrow(/Duplicate/);
  });
  it('replays connections and conditions and marks actual connection changes in a turn', () => {
    const source = graph(); const first = captureTurn(source, { id: 'one', title: 'First', createdAt: '2026-09-30T10:00:00Z', revision: 'first' });
    const changed = applyOperation(source, { type: 'upsertLink', link: { ...source.links[0], label: 'Aligned speech' } });
    const second = captureTurn(changed, { id: 'two', title: 'Second', createdAt: '2026-09-30T11:00:00Z', revision: 'second' });
    expect(first.links[0].label).toBe('Timed speech'); expect(second.lenses).toEqual(source.lenses);
    changed.turns = [first, second];
    expect(getBlockState(changed, changed.nodes.find((node) => node.id === 'asr')).status).toBe('changed');
  });
  it('highlights relevant branches and custom logic while preserving authored data', () => {
    const source = graph(); const before = structuredClone(source);
    expect(readingStates(source, { format: 'silent' })).toMatchObject({ root: { active: true }, form: { active: false }, asr: { active: false }, render: { active: true, pending: true } });
    expect(readingStates(source, { format: 'spoken' }).asr).toMatchObject({ active: true, custom: true });
    expect(source).toEqual(before);
  });
  it('removes dangling connections on deletion and restores them with undo', () => {
    const source = graph(); const history = deletionHistoryEntry({ graph: source, view: {} }, ['form']);
    const deleted = applyOperation(source, history.redo); expect(deleted.links).toBeUndefined();
    expect(deleted.lenses[0].options[0].roots).toEqual(['render']);
    expect(applyOperation(deleted, history.undo)).toEqual(source);
  });
  it('retains newer unrelated connections and reading descriptions when undoing a deletion', () => {
    const source = graph(); const history = deletionHistoryEntry({ graph: source, view: {} }, ['form']);
    let deleted = applyOperation(source, history.redo);
    deleted = applyOperation(deleted, { type: 'upsertLink', link: { id: 'new', source: 'root', target: 'render', label: 'New connection', kind: 'data' } });
    const lenses = structuredClone(deleted.lenses); lenses[0].options[0].description = 'Updated by another author';
    deleted = applyOperation(deleted, { type: 'setMapLenses', lenses });
    const restored = applyOperation(deleted, history.undo);
    expect(restored.links.map((link) => link.id)).toEqual(['sound', 'new']);
    expect(restored.lenses[0].options[0]).toMatchObject({ roots: ['form', 'render'], custom: ['asr'], description: 'Updated by another author' });
  });
});
