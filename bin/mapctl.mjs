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

/**
 * Every server command works on the configured single map, or with
 * `--project KEY --map FILE` (or SHAPE_MAP_PROJECT and SHAPE_MAP_MAP) on one
 * map of a project opened through SHAPE_MAP_WORKSPACE_ROOT, such as a flow map.
 */
function mapPath(path, options = {}) {
  const project = options.project ?? process.env.SHAPE_MAP_PROJECT;
  const map = options.map ?? process.env.SHAPE_MAP_MAP;
  if (!project && !map) return path;
  if (!project || !map) throw new Error('--project and --map go together: --project KEY --map FILE.mmd');
  return `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams({ project, map })}`;
}
function withMap(command) {
  return command.option('--project <key>', 'project key from the project list (with --map)')
    .option('--map <file>', 'map file in the project docs/maps, such as 02-rooms.mmd (with --project)');
}
async function snapshot(options) { return request(mapPath('/api/map', options)); }
async function mutate(operation, options) {
  const current = await snapshot(options);
  return request(mapPath('/api/mutations', options), {
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
withMap(program.command('brief')).description('Print the discussion request for an AI: changes, proposals, and new memos')
  .option('--focus <id>', 'one feature, flow step, or lane')
  .option('--problem <text>').option('--purpose <text>').option('--success <text>', 'success criteria')
  .option('--approved', 'the person approved this request (needs --problem and --success)')
  .action(async (options) => {
    const body = { ...(options.focus ? { focus: options.focus } : {}), problem: options.problem || '', purpose: options.purpose || '',
      successCriteria: options.success || '', approved: Boolean(options.approved) };
    const { text } = await request(mapPath('/api/brief', options), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    process.stdout.write(`${text}\n`);
  });
withMap(program.command('comment')).arguments('<id> <body>').description('Leave a memo on a feature, flow step, or lane')
  .option('--kind <kind>', 'note, concern, or change', 'note')
  .option('--author <author>', 'comment author', 'AI')
  .action(async (id, body, options) => output(await mutate({ type: 'addComment', id, body, kind: options.kind, author: options.author }, options)));
withMap(program.command('propose')).arguments('<id>').description('Save the next change for a feature or flow step')
  .requiredOption('--reason <text>', 'the problem: why this should change')
  .option('--logic <text>', 'the desired change').option('--purpose <text>').option('--success <text>', 'success criteria')
  .action(async (id, options) => output(await mutate({ type: 'setProposal', id, proposal: { reason: options.reason,
    ...(options.logic ? { logic: options.logic } : {}), ...(options.purpose ? { purpose: options.purpose } : {}),
    ...(options.success ? { successCriteria: options.success } : {}) } }, options)));
withMap(program.command('turn')).arguments('<title>').description('Record the current map as a turn').option('--summary <text>', 'what changed and why')
  .action(async (title, options) => output(await mutate({ type: 'createTurn', title, ...(options.summary ? { summary: options.summary } : {}) }, options)));
withMap(program.command('show')).description('Show the current snapshot').action(async (options) => output(await snapshot(options)));
withMap(program.command('subtree')).arguments('<id>').option('-d, --depth <number>', 'maximum child depth', '2')
  .action(async (id, options) => output(await request(mapPath(`/api/subtree/${encodeURIComponent(id)}?depth=${encodeURIComponent(options.depth)}`, options))));
withMap(program.command('add')).arguments('<parentId> <label>')
  .option('--id <id>').requiredOption('--category <id>').option('--shape <shape>', 'rectangle or rounded', shapeOption, 'rectangle')
  .action(async (parentId, label, options) => output(await mutate({ type: 'addNode', parentId, label, id: options.id, shape: options.shape, category: options.category }, options)));
withMap(program.command('rename')).arguments('<id> <label>')
  .action(async (id, label, options) => output(await mutate({ type: 'renameNode', id, label }, options)));
withMap(program.command('move')).arguments('<id> <parentId>')
  .action(async (id, parentId, options) => output(await mutate({ type: 'moveNode', id, parentId }, options)));
withMap(program.command('style')).arguments('<id>').requiredOption('--shape <shape>', 'rectangle or rounded', shapeOption).requiredOption('--category <id>')
  .action(async (id, options) => output(await mutate({ type: 'setNodePresentation', id, shape: options.shape, category: options.category }, options)));

/** Map files in one file, a docs/maps folder, or a repository that has one. */
async function mapFiles(target) {
  const [{ default: fs }, { default: path }, { MAP_FILE_RE }] = await Promise.all([
    import('node:fs/promises'), import('node:path'), import('../lib/workspace.mjs')]);
  const resolved = path.resolve(target);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) return [resolved];
  const nested = path.join(resolved, 'docs', 'maps');
  const directory = await fs.stat(nested).then((item) => item.isDirectory() ? nested : resolved, () => resolved);
  return (await fs.readdir(directory)).filter((name) => MAP_FILE_RE.test(name)).sort().map((name) => path.join(directory, name));
}

program.command('check').arguments('<path>').description('Validate one map file or a docs/maps folder without a running server')
  .action(async (target) => {
    const [{ default: fs }, { default: path }, { classifyMap }] = await Promise.all([
      import('node:fs/promises'), import('node:path'), import('../lib/mapSource.mjs')]);
    const files = await mapFiles(target);
    if (!files.length) process.stdout.write(`No .mmd maps in ${target}\n`);
    let failed = false;
    for (const file of files) {
      const entry = await classifyMap(await fs.readFile(file, 'utf8'), path.basename(file));
      const kind = entry.declaredKind ? `other (${entry.declaredKind})` : entry.kind;
      const declaresShapeMap = entry.kind !== 'other' || /map header/.test(entry.error || '');
      if (!entry.editable && declaresShapeMap) failed = true;
      const status = entry.editable ? 'ok' : declaresShapeMap ? 'error' : 'view';
      const problem = entry.editable ? '' : `\n    ${entry.line ? `line ${entry.line}: ` : ''}${(entry.error || '').replace(/^Line \d+: /, '').split('\n')[0]}`;
      process.stdout.write(`${status.padEnd(5)} ${path.basename(file)}  ${kind}  "${entry.title}"${problem}\n`);
    }
    if (failed) process.exitCode = 1;
  });

program.command('format').arguments('<path>')
  .description('Rewrite editable maps in the canonical text Shape map writes, so later edits change only what people change')
  .option('--dry-run', 'list the maps that would change without writing them')
  .action(async (target, options) => {
    const [{ default: fs }, { default: path }, { default: crypto }, { readEditableMap }, { writeSource }, { writeFlowMap }] = await Promise.all([
      import('node:fs/promises'), import('node:path'), import('node:crypto'), import('../lib/mapSource.mjs'),
      import('../lib/format.mjs'), import('../lib/flowMap.mjs')]);
    const files = await mapFiles(target);
    if (!files.length) process.stdout.write(`No .mmd maps in ${target}\n`);
    for (const file of files) {
      const name = path.basename(file);
      const source = await fs.readFile(file, 'utf8');
      let parsed;
      // Files Shape map cannot edit are never rewritten.
      try { parsed = await readEditableMap(source); }
      catch { process.stdout.write(`skip  ${name}  (not editable; run check)\n`); continue; }
      const canonical = parsed.kind === 'features' ? writeSource(parsed.graph) : writeFlowMap(parsed.graph);
      if (canonical === source) { process.stdout.write(`same  ${name}\n`); continue; }
      await readEditableMap(canonical);
      if (!options.dryRun) {
        const temporary = path.join(path.dirname(file), `.${name}.${process.pid}.${crypto.randomUUID()}.tmp`);
        await fs.writeFile(temporary, canonical, 'utf8');
        if (await fs.readFile(file, 'utf8') !== source) {
          await fs.rm(temporary, { force: true });
          throw new Error(`${name} changed while it was being formatted; nothing was written.`);
        }
        await fs.rename(temporary, file);
      }
      process.stdout.write(`${options.dryRun ? 'would' : 'wrote'} ${name}\n`);
    }
  });

program.parseAsync().catch((error) => {
  const conflict = error.body?.code === 'revision_conflict' ? `\nLatest revision: ${error.body.snapshot?.revision}` : '';
  process.stderr.write(`mapctl: ${error.message}${conflict}\n`);
  process.exitCode = 1;
});
