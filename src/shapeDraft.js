export const BLOCK_DRAFT_FIELDS = ['label', 'summary', 'reason', 'purpose', 'successCriteria', 'logic', 'files'];

export function blockDraftValues(node) {
  return { label: node.label, summary: node.block?.summary || node.task?.logic || '',
    reason: node.proposal?.reason || '', purpose: node.proposal?.purpose || '', successCriteria: node.proposal?.successCriteria || '', logic: node.proposal?.logic || '', files: (node.block?.files || []).join('\n') };
}

export function draftConflicts(draft, base, current) {
  return BLOCK_DRAFT_FIELDS.filter((field) => draft[field] !== base[field] && current[field] !== base[field] && current[field] !== draft[field]);
}

/** Merge externally changed untouched fields; retain both versions of a contested edit. */
export function reconcileDraft(draft, base, current) {
  const next = { ...draft }; const nextBase = { ...base };
  for (const field of BLOCK_DRAFT_FIELDS) {
    if (draft[field] === base[field]) { next[field] = current[field]; nextBase[field] = current[field]; }
    else if (draft[field] === current[field]) nextBase[field] = current[field];
  }
  return { draft: next, base: nextBase, conflicts: draftConflicts(next, nextBase, current) };
}
