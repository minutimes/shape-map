import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
async function git(root, args) {
  const { stdout } = await run('git', ['-C', root, ...args], { timeout: 5000, maxBuffer: 512 * 1024 });
  return stdout.trim();
}

export function blocksForFiles(graph, files) {
  return graph.nodes.filter((node) => (node.block?.files || []).some((linked) =>
    files.some((file) => file === linked || (linked.endsWith('/') && file.startsWith(linked)))))
    .map(({ id, label }) => ({ id, label }));
}

/** Git is evidence, never an approval or an automatic claim that a feature is finished. */
export async function readRepository(store, graph, configuredRoot = process.env.SHAPE_MAP_REPOSITORY_ROOT) {
  const candidate = configuredRoot || (store.dataRoot === store.projectRoot ? store.projectRoot : null);
  if (!candidate) return { connected: false };
  try {
    const root = await git(path.resolve(candidate), ['rev-parse', '--show-toplevel']);
    const [branch, head, records, modified, untracked] = await Promise.all([
      git(root, ['branch', '--show-current']),
      git(root, ['rev-parse', 'HEAD']),
      git(root, ['log', '-12', '--format=%x1e%H%x1f%h%x1f%cI%x1f%s', '--name-only']),
      git(root, ['diff', 'HEAD', '--name-only']),
      git(root, ['ls-files', '--others', '--exclude-standard']),
    ]);
    const commits = records.split('\u001e').filter(Boolean).map((record) => {
      const [header, ...paths] = record.trim().split('\n');
      const [sha, shortSha, createdAt, title] = header.split('\u001f');
      const files = paths.filter(Boolean);
      return { sha, shortSha, createdAt, title, files, blocks: blocksForFiles(graph, files) };
    });
    const workingFiles = [...new Set([...modified.split('\n'), ...untracked.split('\n')].filter(Boolean))];
    return { connected: true, name: path.basename(root), branch: branch || '현재 커밋', head,
      commits, working: { files: workingFiles, blocks: blocksForFiles(graph, workingFiles) } };
  } catch { return { connected: false, error: '연결한 레포의 변경 기록을 읽지 못했습니다.' }; }
}
