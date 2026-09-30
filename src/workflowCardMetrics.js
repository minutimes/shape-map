export const WORKFLOW_CARD_WIDTH = 360;
export const WORKFLOW_CARD_HORIZONTAL_PADDING = 20;
export const WORKFLOW_SECTION_PADDING = 0;
export const WORKFLOW_CHILD_TOP_GAP = 54;
export const WORKFLOW_CHILD_GAP = 132;

export function estimateWrappedLines(value, capacity) {
  return String(value || '').split('\n').reduce((total, line) => {
    const width = [...line].reduce((sum, char) => sum + (/^[\u0000-\u00ff]$/.test(char) ? .56 : 1), 0);
    return total + Math.max(1, Math.ceil(width / Math.max(1, capacity)));
  }, 0);
}

export function workflowHeaderColumns() { return 1; }

function optionalFieldEnabled(node, field) {
  const optionalFields = node.optionalFields ?? node.data?.optionalFields;
  return !Array.isArray(optionalFields) || optionalFields.includes(field);
}

/** Initial estimate only; the card's natural browser height replaces it. */
export function workflowCardHeight(node = {}) {
  const task = node.task || node.data?.task || {};
  const proposal = node.proposal ?? node.data?.proposal;
  const title = node.label || node.data?.label || '';
  const facts = (value, optional = false) => ['logic', 'inputs', 'outputs', 'ui']
    .filter((field) => !optional || value[field])
    .reduce((height, field) => height + estimateWrappedLines(value[field], 16) * 23 + 7, 0)
    + (optionalFieldEnabled(node, 'condition') && value.condition
      ? estimateWrappedLines(value.condition, 16) * 23 + 7 : 0);
  let height = 133 + estimateWrappedLines(title, 15) * 29 + facts(task);
  if (proposal !== undefined && proposal !== null) {
    height += 92 + facts(proposal, true) + estimateWrappedLines(proposal.reason, 20) * 23
      + (optionalFieldEnabled(node, 'executor') && proposal.executor ? 34 : 0);
  }
  return Math.ceil(height);
}
