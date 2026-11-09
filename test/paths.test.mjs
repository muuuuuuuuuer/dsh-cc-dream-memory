/**
 * Tests for src/paths.js (Lead-owned module, already implemented).
 *
 * Contract: INTERFACES.md "src/paths.js" — slug mirrors the harness session
 * directory naming, project root is the nearest `.git` ancestor, every built
 * path is absolute and the memory dir lives inside the plugin root.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isInsidePath, loadModule, makeTempDir } from './helpers.mjs';

const PATH_EXPORTS = ['projectSlug', 'resolveProjectRoot', 'defaultMemoryRoot', 'buildPaths', 'isInside'];
let pathsModulePromise;

function pathsModule() {
  if (!pathsModulePromise) pathsModulePromise = loadModule('../src/paths.js', { requireExports: PATH_EXPORTS });
  return pathsModulePromise;
}

test('projectSlug mirrors the harness session directory naming', async () => {
  const { projectSlug } = await pathsModule();
  if (process.platform === 'win32') {
    assert.equal(projectSlug('C:\\Users\\a\\b'), '--C-Users-a-b--');
    assert.equal(projectSlug('C:/Users/a/b'), '--C-Users-a-b--', 'forward slashes normalize identically');
    assert.equal(projectSlug('C:\\Users\\12345\\x'), '--C-Users-12345-x--');
  }
  const abs = path.join(os.tmpdir(), 'cc-memory', 'ws');
  const slug = projectSlug(abs);
  assert.equal(slug.startsWith('--'), true, `slug starts with --: ${slug}`);
  assert.equal(slug.endsWith('--'), true, `slug ends with --: ${slug}`);
  assert.equal(/[\\/:]/.test(slug), false, `slug must not contain path separators: ${slug}`);
  assert.equal(slug.length > 4, true, 'slug body must not be empty');
  assert.equal(projectSlug(abs), slug, 'slug is deterministic');
});

test('projectSlug keeps over-long paths within a bounded length', async () => {
  const { projectSlug } = await pathsModule();
  const longPath = process.platform === 'win32'
    ? `C:\\${'deep-folder\\'.repeat(40)}`
    : `/${'deep-folder/'.repeat(40)}`;
  const slug = projectSlug(longPath);
  assert.equal(slug.length <= 130, true, `slug should be bounded, got length ${slug.length}`);
  assert.ok(slug.startsWith('--') && slug.endsWith('--'));
});

test('resolveProjectRoot finds the nearest .git ancestor directory', async (t) => {
  const { resolveProjectRoot } = await pathsModule();
  const tmp = await makeTempDir(t);
  const repo = path.join(tmp, 'repo');
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await mkdir(path.join(repo, 'src', 'deep', 'nested'), { recursive: true });
  assert.equal(resolveProjectRoot(path.join(repo, 'src', 'deep', 'nested')), repo);
  assert.equal(resolveProjectRoot(repo), repo);
});

test('projectSlug normalizes Windows drive-letter case', async () => {
  const { projectSlug } = await pathsModule();
  if (process.platform !== 'win32') return;
  assert.equal(projectSlug('c:\\Users\\a\\b'), projectSlug('C:\\Users\\a\\b'));
  assert.equal(projectSlug('c:\\Users\\a\\b'), '--C-Users-a-b--');
});

test('resolveProjectRoot treats a .git file (worktree) as a marker', async (t) => {
  const { resolveProjectRoot } = await pathsModule();
  const tmp = await makeTempDir(t);
  const main = path.join(tmp, 'main-repo');
  await mkdir(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  const worktree = path.join(tmp, 'worktree');
  await mkdir(path.join(worktree, 'sub'), { recursive: true });
  await writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`, 'utf8');
  // All worktrees of one repository share the main repository memory root.
  assert.equal(resolveProjectRoot(path.join(worktree, 'sub')), resolveProjectRoot(main));
  assert.equal(resolveProjectRoot(worktree), resolveProjectRoot(main));
});

test('resolveProjectRoot reads worktree commondir for bare and separate git dirs', async (t) => {
  const { resolveProjectRoot } = await pathsModule();
  const tmp = await makeTempDir(t);

  // Bare repository + linked worktree: commondir points at the bare repo.
  const bare = path.join(tmp, 'bare.git');
  await mkdir(path.join(bare, 'objects'), { recursive: true });
  await writeFile(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  const bareWorktree = path.join(tmp, 'bare-wt');
  await mkdir(path.join(bareWorktree), { recursive: true });
  const bareGitDir = path.join(bare, 'worktrees', 'bare-wt');
  await mkdir(bareGitDir, { recursive: true });
  await writeFile(path.join(bareGitDir, 'commondir'), '../..\n', 'utf8');
  await writeFile(path.join(bareWorktree, '.git'), `gitdir: ${bareGitDir}\n`, 'utf8');
  assert.equal(resolveProjectRoot(bareWorktree), resolveProjectRoot(bare), 'bare-repo worktrees share the bare repo identity');

  // --separate-git-dir main checkout + linked worktree: main points at the
  // separate git dir (no commondir); linked uses commondir to the same dir.
  const sepGit = path.join(tmp, 'sep-gitdir');
  await mkdir(path.join(sepGit, 'objects'), { recursive: true });
  await writeFile(path.join(sepGit, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  const main = path.join(tmp, 'sep-main');
  await mkdir(main, { recursive: true });
  await writeFile(path.join(main, '.git'), `gitdir: ${sepGit}\n`, 'utf8');
  const linked = path.join(tmp, 'sep-linked');
  await mkdir(linked, { recursive: true });
  const linkedGitDir = path.join(sepGit, 'worktrees', 'linked');
  await mkdir(linkedGitDir, { recursive: true });
  await writeFile(path.join(linkedGitDir, 'commondir'), '../..\n', 'utf8');
  await writeFile(path.join(linked, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8');
  assert.equal(resolveProjectRoot(main), resolveProjectRoot(linked), 'separate-git-dir checkout and linked worktree share identity');
  assert.equal(resolveProjectRoot(main), resolveProjectRoot(sepGit));
});

test('resolveProjectRoot falls back to the workspace dir when no .git is found', async (t) => {
  const { resolveProjectRoot } = await pathsModule();
  const tmp = await makeTempDir(t);
  const plain = path.join(tmp, 'plain', 'a', 'b');
  await mkdir(plain, { recursive: true });
  assert.equal(resolveProjectRoot(plain), path.resolve(plain));
});

test('defaultMemoryRoot is <homeDir>/cc-memory', async (t) => {
  const { defaultMemoryRoot } = await pathsModule();
  const home = await makeTempDir(t);
  assert.equal(defaultMemoryRoot(home), path.join(home, 'cc-memory'));
});

test('buildPaths produces absolute paths with the documented layout', async (t) => {
  const { buildPaths, defaultMemoryRoot, projectSlug, isInside } = await pathsModule();
  const tmp = await makeTempDir(t);
  const home = path.join(tmp, 'home');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const memoryRoot = path.join(tmp, 'data-root');

  const p = buildPaths({ memoryRoot, homeDir: home, workspaceDir });
  const keys = [
    'root',
    'userMemoryDir',
    'userIndexFile',
    'projectRoot',
    'projectDir',
    'memoryDir',
    'indexFile',
    'stateFile',
    'lockFile',
    'changelogFile',
    'dreamsDir',
    'pendingDir',
  ];
  for (const key of keys) {
    assert.equal(typeof p[key], 'string', `paths.${key} must be a string`);
    assert.equal(path.isAbsolute(p[key]), true, `paths.${key} must be absolute: ${p[key]}`);
  }

  assert.equal(p.root, path.resolve(memoryRoot));
  assert.equal(p.projectRoot, path.resolve(workspaceDir));
  assert.equal(p.projectDir, path.join(p.root, 'projects', projectSlug(p.projectRoot)));
  assert.equal(p.memoryDir, path.join(p.projectDir, 'memory'));
  assert.equal(path.basename(p.memoryDir), 'memory');
  assert.equal(p.indexFile, path.join(p.memoryDir, 'MEMORY.md'));
  assert.equal(p.userMemoryDir, path.join(p.root, 'user', 'memory'));
  assert.equal(p.userIndexFile, path.join(p.userMemoryDir, 'MEMORY.md'));

  // Plugin metadata lives beside the memory directory (see src/paths.js).
  assert.equal(path.basename(p.stateFile), '.state.json');
  assert.equal(path.basename(p.lockFile), '.consolidate-lock');
  assert.equal(path.basename(p.changelogFile), '.dream-log.md');
  assert.equal(path.basename(p.dreamsDir), '.dreams');
  for (const key of ['stateFile', 'lockFile', 'changelogFile', 'dreamsDir', 'pendingDir']) {
    assert.equal(isInside(p.projectDir, p[key]), true, `paths.${key} must live under projectDir`);
  }

  // Containment rules from INTERFACES.md.
  assert.equal(isInside(p.root, p.memoryDir), true, 'memoryDir must be inside root');
  assert.equal(isInside(p.projectDir, p.memoryDir), true, 'memoryDir must be inside projectDir');
  assert.equal(isInside(p.root, p.projectDir), true, 'projectDir must be inside root');
  assert.equal(isInside(p.root, p.userMemoryDir), true, 'userMemoryDir must be inside root');
  assert.equal(isInside(p.memoryDir, p.root), false, 'root is not inside memoryDir');

  // The default-root fallback also keeps everything under defaultMemoryRoot(home).
  const emptyRoot = buildPaths({ memoryRoot: '', homeDir: home, workspaceDir });
  assert.equal(emptyRoot.root, path.resolve(defaultMemoryRoot(home)));
  assert.equal(isInside(emptyRoot.root, emptyRoot.memoryDir), true);
});

test('buildPaths expands a leading ~/ against homeDir and finds the git root', async (t) => {
  const { buildPaths, projectSlug } = await pathsModule();
  const tmp = await makeTempDir(t);
  const home = path.join(tmp, 'home');
  const repo = path.join(tmp, 'repo');
  await mkdir(path.join(repo, '.git'), { recursive: true });
  const nestedWorkspace = path.join(repo, 'packages', 'app');
  await mkdir(nestedWorkspace, { recursive: true });

  const p = buildPaths({ memoryRoot: '~/cc-memory-data', homeDir: home, workspaceDir: nestedWorkspace });
  assert.equal(p.root, path.join(home, 'cc-memory-data'));
  assert.equal(p.projectRoot, repo);
  assert.equal(p.projectDir, path.join(p.root, 'projects', projectSlug(repo)));
});

test('isInside is a strict containment predicate', async (t) => {
  const { isInside } = await pathsModule();
  const tmp = await makeTempDir(t);
  assert.equal(isInside(tmp, path.join(tmp, 'a', 'b')), true);
  assert.equal(isInside(tmp, tmp), true);
  assert.equal(isInside(path.join(tmp, 'a'), tmp), false);
  assert.equal(isInside(tmp, path.join(tmp, '..', 'sibling')), false);
  assert.equal(isInside(tmp, 'relative/path'), false);
});

test('resolveProjectRoot stops after a bounded number of ancestor levels', async (t) => {
  const { resolveProjectRoot } = await pathsModule();
  const tmp = await makeTempDir(t);
  // .git at the temp root, workspace 35 levels below it: beyond the documented
  // 30-level search, so the fallback (workspace dir) must be returned.
  await mkdir(path.join(tmp, '.git'), { recursive: true });
  let deep = tmp;
  for (let i = 0; i < 35; i += 1) deep = path.join(deep, `d${i}`);
  await mkdir(deep, { recursive: true });
  assert.equal(resolveProjectRoot(deep), path.resolve(deep));
});
