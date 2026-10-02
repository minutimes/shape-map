import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { watch } from 'chokidar';
import { MlcError } from './errors.mjs';
import { classifyMap } from './mapSource.mjs';
import { createMapStore } from './store.mjs';

/*
 * A workspace root holds product repositories. Each Git repository directly
 * inside it is a project, and so is each of its Git worktrees that lies inside
 * the root and has maps. Projects keep their maps in docs/maps/*.mmd.
 * Shape map reads only inside the root and writes only the .mmd being edited;
 * canvas state goes to the state directory, never into a project.
 */

const run = promisify(execFile);
export const MAP_FILE_RE = /^[^./\\][^/\\]*\.mmd$/;
const DISCOVERY_TTL_MS = 2_000;

function isOutside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function git(cwd, args) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 5_000, maxBuffer: 1024 * 1024 });
  return stdout;
}

async function exists(candidate) {
  try { await fs.lstat(candidate); return true; } catch { return false; }
}

export function projectNotFound() {
  return new MlcError('project_not_found', 'Project not found.');
}

export function mapNotFound() {
  return new MlcError('map_not_found', 'Map not found.');
}

/** Map files directly in docs/maps whose real path stays inside the project. */
export async function listMapFiles(projectPath) {
  const directory = path.join(projectPath, 'docs', 'maps');
  let realDirectory;
  try { realDirectory = await fs.realpath(directory); } catch { return []; }
  if (isOutside(projectPath, realDirectory)) return [];
  let entries;
  try { entries = await fs.readdir(directory); } catch { return []; }
  const files = [];
  for (const name of entries) {
    // eslint-disable-next-line no-control-regex
    if (!MAP_FILE_RE.test(name) || /[\u0000-\u001f]/.test(name)) continue;
    const candidate = path.join(directory, name);
    try {
      const real = await fs.realpath(candidate);
      if (isOutside(projectPath, real)) continue;
      const stat = await fs.stat(real);
      if (!stat.isFile()) continue;
      files.push({ file: name, realPath: real, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino });
    } catch { /* Missing or unreadable entries are not maps. */ }
  }
  return files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function parseWorktrees(output) {
  const worktrees = [];
  let current = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice(9) }; worktrees.push(current); }
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (current && line === 'bare') current.bare = true;
  }
  return worktrees;
}

export class Workspace extends EventEmitter {
  constructor({ root, stateDir, watchFiles = true }) {
    super();
    this.root = realpathSync(path.resolve(root));
    this.stateDir = path.resolve(stateDir);
    this.watchFiles = watchFiles;
    this.discovery = null;
    this.stores = new Map();
    this.classifications = new Map();
    this.listWatchers = new Map();
  }

  async #discoverNow() {
    let entries;
    try { entries = await fs.readdir(this.root, { withFileTypes: true }); } catch { entries = []; }
    const found = new Map();
    const repositories = [];
    await Promise.all(entries.filter((entry) => !entry.name.startsWith('.')).map(async (entry) => {
      const candidate = path.join(this.root, entry.name);
      let real;
      try { real = await fs.realpath(candidate); } catch { return; }
      if (isOutside(this.root, real) || real === this.root) return;
      try { if (!(await fs.stat(real)).isDirectory()) return; } catch { return; }
      const dotGit = path.join(real, '.git');
      if (!(await exists(dotGit))) return;
      const linked = (await fs.lstat(dotGit)).isFile();
      let branch = null;
      try { branch = (await git(real, ['branch', '--show-current'])).trim() || null; } catch { /* Not readable as Git. */ }
      const maps = await listMapFiles(real);
      found.set(real, { key: entry.name, name: entry.name, branch, worktree: linked, mapCount: maps.length, path: real });
      repositories.push({ name: entry.name, path: real });
    }));
    await Promise.all(repositories.map(async (repository) => {
      let worktrees = [];
      try { worktrees = parseWorktrees(await git(repository.path, ['worktree', 'list', '--porcelain'])); } catch { return; }
      for (const worktree of worktrees) {
        if (worktree.bare) continue;
        let real;
        try { real = await fs.realpath(worktree.path); } catch { continue; }
        if (found.has(real) || isOutside(this.root, real) || real === this.root) continue;
        const maps = await listMapFiles(real);
        if (!maps.length) continue;
        const key = path.relative(this.root, real).split(path.sep).join('/');
        found.set(real, { key, name: repository.name, branch: worktree.branch || null, worktree: true, mapCount: maps.length, path: real });
      }
    }));
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || Number(a.worktree) - Number(b.worktree) || a.key.localeCompare(b.key));
  }

  async #discover(fresh = false) {
    if (fresh || !this.discovery || Date.now() - this.discovery.at > DISCOVERY_TTL_MS) {
      const pending = this.#discoverNow();
      this.discovery = { at: Date.now(), pending };
      pending.catch(() => { if (this.discovery?.pending === pending) this.discovery = null; });
    }
    return this.discovery.pending;
  }

  async listProjects() {
    const projects = await this.#discover(true);
    return projects.map(({ path: _path, ...project }) => project);
  }

  async findProject(key) {
    if (typeof key !== 'string' || !key || key.includes('\0')) throw projectNotFound();
    let project = (await this.#discover()).find((item) => item.key === key);
    if (!project) project = (await this.#discover(true)).find((item) => item.key === key);
    if (!project) throw projectNotFound();
    // The listing is cached briefly; confirm the folder still resolves inside the root.
    let real;
    try { real = await fs.realpath(path.join(this.root, ...key.split('/'))); } catch { throw projectNotFound(); }
    if (real !== project.path || isOutside(this.root, real)) throw projectNotFound();
    return project;
  }

  async #classify(file) {
    const cacheKey = file.realPath;
    const cached = this.classifications.get(cacheKey);
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size && cached.ino === file.ino) return cached.entry;
    const source = await fs.readFile(file.realPath, 'utf8');
    const entry = await classifyMap(source, file.file);
    this.classifications.set(cacheKey, { mtimeMs: file.mtimeMs, size: file.size, ino: file.ino, entry });
    return entry;
  }

  async listMaps(key) {
    const project = await this.findProject(key);
    const files = await listMapFiles(project.path);
    const maps = [];
    for (const file of files) {
      try { maps.push(await this.#classify(file)); } catch { /* Removed while listing. */ }
    }
    return { project: this.#publicProject(project, maps.length), maps };
  }

  #publicProject(project, mapCount = project.mapCount) {
    const { path: _path, ...rest } = project;
    return { ...rest, mapCount };
  }

  async openMap(key, file) {
    const project = await this.findProject(key);
    if (typeof file !== 'string' || !MAP_FILE_RE.test(file)) throw mapNotFound();
    const files = await listMapFiles(project.path);
    const storeKey = `${project.path}\0${file}`;
    if (!files.some((item) => item.file === file)) {
      const stale = this.stores.get(storeKey);
      if (stale) { this.stores.delete(storeKey); stale.then((store) => store.close()).catch(() => {}); }
      throw mapNotFound();
    }
    if (!this.stores.has(storeKey)) {
      const pending = (async () => {
        const viewRoot = path.join(this.stateDir, 'projects', encodeURIComponent(key));
        await fs.mkdir(viewRoot, { recursive: true });
        const store = await createMapStore({
          projectRoot: project.path,
          dataRoot: project.path,
          mapPath: `docs/maps/${file}`,
          watchFiles: this.watchFiles,
          projectMap: true,
          viewRoot,
          viewPath: path.join(viewRoot, file.replace(/\.mmd$/, '.view.json')),
        });
        store.on('watch-error', (error) => this.emit('watch-error', error));
        store.project = this.#publicProject(project);
        store.projectPath = project.path;
        return store;
      })();
      this.stores.set(storeKey, pending);
      pending.catch(() => { if (this.stores.get(storeKey) === pending) this.stores.delete(storeKey); });
    }
    return this.stores.get(storeKey);
  }

  /** Map-list events for one project; returns an unsubscribe function. */
  async subscribeMaps(key, listener) {
    const project = await this.findProject(key);
    let entry = this.listWatchers.get(project.path);
    if (!entry) {
      entry = { listeners: new Set(), last: null, timer: null, watcher: null, poll: null };
      this.listWatchers.set(project.path, entry);
      const refresh = () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.#publishMaps(key, entry).catch((error) => this.emit('watch-error', error)), 120);
      };
      entry.refresh = refresh;
      if (this.watchFiles) {
        const directory = path.join(project.path, 'docs', 'maps');
        const startWatcher = () => {
          if (entry.watcher) return;
          entry.watcher = watch(directory, { depth: 0, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 } });
          for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir']) entry.watcher.on(event, refresh);
          entry.watcher.on('error', (error) => this.emit('watch-error', error));
        };
        // A folder created later is picked up by the periodic check.
        if (await exists(directory)) startWatcher();
        entry.poll = setInterval(async () => {
          if (!entry.watcher && await exists(directory)) startWatcher();
          refresh();
        }, 5_000);
        entry.poll.unref?.();
      }
      const { maps } = await this.listMaps(key);
      entry.last = JSON.stringify(maps);
    }
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size) return;
      clearTimeout(entry.timer); clearInterval(entry.poll);
      entry.watcher?.close().catch(() => {});
      this.listWatchers.delete(project.path);
    };
  }

  async #publishMaps(key, entry) {
    let maps;
    try { ({ maps } = await this.listMaps(key)); } catch { maps = []; }
    const serialized = JSON.stringify(maps);
    if (serialized === entry.last) return;
    entry.last = serialized;
    for (const listener of entry.listeners) listener(maps);
  }

  /** Re-reads a project's maps and notifies subscribers when the list changed. */
  async refreshMaps(key) {
    const project = await this.findProject(key);
    const entry = this.listWatchers.get(project.path);
    if (entry) await this.#publishMaps(key, entry);
  }

  async close() {
    for (const entry of this.listWatchers.values()) {
      clearTimeout(entry.timer); clearInterval(entry.poll);
      await entry.watcher?.close().catch(() => {});
    }
    this.listWatchers.clear();
    const stores = [...this.stores.values()];
    this.stores.clear();
    await Promise.all(stores.map((pending) => pending.then((store) => store.close()).catch(() => {})));
  }
}

export async function createWorkspace(options) {
  const workspace = new Workspace(options);
  await fs.mkdir(workspace.stateDir, { recursive: true });
  return workspace;
}
