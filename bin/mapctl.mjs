#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
const baseUrl = (process.env.FINAL_SHAPE_MAP_URL || process.env.MLC_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');
const clientId = process.env.FINAL_SHAPE_MAP_CLIENT_ID || process.env.MLC_CLIENT_ID || `shape-map-${process.pid}`;

async function request(path, options) {
  let response;
  try { response = await fetch(`${baseUrl}${path}`, options); }
  catch (error) { throw new Error(`Cannot reach ${baseUrl}: ${error.message}`); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `HTTP ${response.status}`);
    error.body = body;
    throw error;
  }
  return body;
}

async function snapshot() { return request('/api/map'); }
async function mutate(operation) {
  const current = await snapshot();
  return request('/api/mutations', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: current.revision, clientId, operation }),
  });
}
function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function shapeOption(value) {
  if (!['rectangle', 'rounded'].includes(value)) throw new Error('shape must be rectangle or rounded');
  return value;
}

program.name('shape-map').description('Read and edit the shared Shape map with revision checks');
program.command('brief').description('Print the current product discussion for an AI').action(async () => {
  const { text } = await request('/api/brief'); process.stdout.write(`${text}\n`);
});
program.command('comment').arguments('<id> <body>').option('--kind <kind>', 'note, concern, or change', 'note')
  .option('--author <author>', 'comment author', 'AI')
  .action(async (id, body, options) => output(await mutate({ type: 'addComment', id, body, kind: options.kind, author: options.author })));
program.command('propose').arguments('<id>').requiredOption('--reason <text>', 'why this feature should change')
  .option('--logic <text>', 'how the feature should work')
  .action(async (id, options) => output(await mutate({ type: 'setProposal', id, proposal: { reason: options.reason, ...(options.logic ? { logic: options.logic } : {}) } })));
program.command('turn').arguments('<title>').option('--summary <text>', 'what changed and why')
  .action(async (title, options) => output(await mutate({ type: 'createTurn', title, summary: options.summary })));
program.command('show').description('Show the current snapshot').action(async () => output(await snapshot()));
program.command('subtree').arguments('<id>').option('-d, --depth <number>', 'maximum child depth', '2')
  .action(async (id, options) => output(await request(`/api/subtree/${encodeURIComponent(id)}?depth=${encodeURIComponent(options.depth)}`)));
program.command('add').arguments('<parentId> <label>')
  .option('--id <id>').requiredOption('--category <id>').option('--shape <shape>', 'rectangle or rounded', shapeOption, 'rectangle')
  .action(async (parentId, label, options) => output(await mutate({ type: 'addNode', parentId, label, id: options.id, shape: options.shape, category: options.category })));
program.command('rename').arguments('<id> <label>')
  .action(async (id, label) => output(await mutate({ type: 'renameNode', id, label })));
program.command('move').arguments('<id> <parentId>')
  .action(async (id, parentId) => output(await mutate({ type: 'moveNode', id, parentId })));
program.command('style').arguments('<id>').requiredOption('--shape <shape>', 'rectangle or rounded', shapeOption).requiredOption('--category <id>')
  .action(async (id, options) => output(await mutate({ type: 'setNodePresentation', id, shape: options.shape, category: options.category })));

program.parseAsync().catch((error) => {
  const conflict = error.body?.code === 'revision_conflict' ? `\nLatest revision: ${error.body.snapshot?.revision}` : '';
  process.stderr.write(`mapctl: ${error.message}${conflict}\n`);
  process.exitCode = 1;
});
