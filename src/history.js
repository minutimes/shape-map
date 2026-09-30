import { descendantsOf } from './layout.js';
import { applyOperation } from '../lib/graph.mjs';

function clone(value) {
  return structuredClone(value);
}

function contentValue(node, path) {
  if (path === 'label') return node.label;
  if (path === 'proposal' || path === 'workflow' || path === 'section') return node[path] === undefined ? null : clone(node[path]);
  const [owner, field] = path.split('.');
  return node[owner]?.[field] === undefined ? null : clone(node[owner][field]);
}

export function historyEntryForOperation(operation, snapshot) {
  const node = snapshot?.graph.nodes.find((item) => item.id === operation.id);
  let undo = null;
  if (operation.type === 'setMapSettings') undo = { type: 'setMapSettings', settings: snapshot.graph.settings ? clone(snapshot.graph.settings) : null };
  else if (operation.type === 'addNode') undo = { type: 'deleteLeaf', id: operation.id };
  else if (operation.type === 'setNodeTask' && node) undo = { type: 'setNodeTask', id: node.id, task: node.task ? clone(node.task) : null };
  else if (operation.type === 'setNodeWorkflow' && node) undo = { type: 'setNodeWorkflow', id: node.id, workflow: node.workflow ? clone(node.workflow) : null };
  else if (operation.type === 'patchNodeContent' && node && Array.isArray(operation.changes)) {
    const afterNode = applyOperation(snapshot.graph, operation).nodes.find((item) => item.id === node.id);
    const canonicalChanges = operation.changes.map((change) => ({
      path: change.path,
      before: contentValue(node, change.path),
      after: contentValue(afterNode, change.path),
    }));
    undo = {
      type: 'patchNodeContent',
      id: node.id,
      changes: canonicalChanges.map((change) => ({
        path: change.path,
        before: clone(change.after),
        after: clone(change.before),
      })),
    };
    operation = { type: 'patchNodeContent', id: node.id, changes: canonicalChanges };
  }
  else if (operation.type === 'setChildOrder' && node) {
    undo = { type: 'setChildOrder', id: node.id, childIds: snapshot.graph.nodes.filter((child) => child.parentId === node.id).map((child) => child.id) };
  }
  else if (operation.type === 'renameNode' && node) undo = { type: 'renameNode', id: node.id, label: node.label };
  else if (operation.type === 'moveNode' && node) undo = { type: 'moveNode', id: node.id, parentId: node.parentId };
  else if (operation.type === 'moveNodes' && Array.isArray(operation.items)) {
    const nodesById = new Map(snapshot?.graph.nodes.map((item) => [item.id, item]));
    const items = operation.items
      .filter((item) => nodesById.has(item.id))
      .map((item) => ({ id: item.id, parentId: nodesById.get(item.id).parentId }));
    if (items.length === operation.items.length && items.length) undo = { type: 'moveNodes', items };
  }
  else if (operation.type === 'setNodePresentation' && node) {
    undo = { type: 'setNodePresentation', id: node.id, shape: node.shape, category: node.category };
  } else if (operation.type === 'setNodeLayouts' && Array.isArray(operation.items)) {
    const nodesById = new Map(snapshot?.graph.nodes.map((item) => [item.id, item]));
    const items = operation.items
      .filter((item) => nodesById.has(item.id))
      .map((item) => ({ id: item.id, layout: clone(nodesById.get(item.id).layout || { mode: 'fit' }) }));
    if (items.length === operation.items.length && items.length) undo = { type: 'setNodeLayouts', items };
  } else if (operation.type === 'upsertCategory') {
    const category = snapshot?.graph.categories.find((item) => item.id === operation.category.id);
    if (category) undo = { type: 'upsertCategory', category: clone(category) };
  }
  if (!undo) return null;
  if (operation.type === 'moveNode' || operation.type === 'moveNodes') {
    const nodesById = new Map(snapshot.graph.nodes.map((item) => [item.id, item]));
    const moves = operation.type === 'moveNode' ? [operation] : operation.items;
    if (operation.order || moves.some((move) => (
      nodesById.get(move.parentId)?.workflow?.mode === 'sequence'
      || nodesById.get(nodesById.get(move.id)?.parentId)?.workflow?.mode === 'sequence'
    ))) undo.order = snapshot.graph.nodes.map((item) => item.id);
  }
  return { label: operation.type, undo, redo: clone(operation) };
}

function hasSelectedAncestor(id, selected, nodesById) {
  let cursor = nodesById.get(id);
  while (cursor?.parentId) {
    if (selected.has(cursor.parentId)) return true;
    cursor = nodesById.get(cursor.parentId);
  }
  return false;
}

export function deletionHistoryEntry(snapshot, selectedIds) {
  if (!snapshot?.graph?.nodes?.length) return null;
  const nodes = snapshot.graph.nodes;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const selected = new Set(selectedIds.filter((id) => nodesById.get(id)?.parentId !== null));
  const roots = [...selected].filter((id) => !hasSelectedAncestor(id, selected, nodesById));
  if (!roots.length) return null;

  const deletedIds = new Set();
  roots.forEach((id) => {
    deletedIds.add(id);
    descendantsOf(id, nodes).forEach((descendantId) => deletedIds.add(descendantId));
  });
  const deletedNodes = nodes.filter((node) => deletedIds.has(node.id)).map(clone);
  const positions = Object.fromEntries(deletedNodes
    .filter((node) => snapshot.view?.positions?.[node.id])
    .map((node) => [node.id, clone(snapshot.view.positions[node.id])]));
  return {
    label: 'delete-subtrees',
    undo: {
      type: 'restoreNodes',
      nodes: deletedNodes,
      order: nodes.map((node) => node.id),
      ...(snapshot.graph.links !== undefined ? { links: clone(snapshot.graph.links) } : {}),
      ...(snapshot.graph.lenses !== undefined ? { lenses: clone(snapshot.graph.lenses) } : {}),
    },
    redo: { type: 'deleteSubtrees', ids: roots },
    undoView: {
      positions,
      collapsedIds: [...(snapshot.view?.collapsedIds || [])],
      ...(snapshot.view?.workflow ? { workflow: clone(snapshot.view.workflow) } : {}),
    },
    deletedIds: [...deletedIds],
    rootCount: roots.length,
  };
}

export function viewHistoryEntry(label, undoView, redoView) {
  return {
    label,
    undoView: clone(undoView),
    redoView: clone(redoView),
  };
}
