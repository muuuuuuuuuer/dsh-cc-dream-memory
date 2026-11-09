/**
 * Path resolution and project identity for dsh-cc-dream-memory.
 *
 * Memory is per project: the repository root (or, without git, the workspace
 * directory) maps to a slug that mirrors the harness's own session directory
 * naming (`--C-Users-name-repo--`), so one project shares one memory directory
 * across all of its sessions.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

/** Maximum slug length before a hash suffix replaces the tail. */
const MAX_SLUG = 120;

/**
 * Turn an absolute directory into the harness-style project slug.
 * `C:\Users\me\repo` -> `--C-Users-me-repo--`.
 * @param {string} absPath absolute directory.
 * @returns {string} slug, never empty.
 */
export function projectSlug(absPath) {
  let resolved = normalizeDriveLetter(path.resolve(String(absPath ?? '.')));
  let body = resolved.replace(/^([A-Za-z]):/, '$1').replace(/[\\/]+/g, '-').replace(/-+/g, '-');
  body = body.replace(/^-+|-+$/g, '');
  if (body === '') body = 'root';
  if (body.length > MAX_SLUG) {
    const digest = createHash('sha1').update(resolved).digest('hex').slice(0, 10);
    body = `${body.slice(0, MAX_SLUG - 11)}-${digest}`;
  }
  return `--${body}--`;
}

/**
 * Sanitize an explicit project id for use as a directory name. Letters, digits,
 * CJK, dot, dash and underscore survive; everything else collapses to "-".
 * @param {string} value
 * @returns {string} safe id (empty when input is empty)
 */
export function sanitizeProjectId(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return '';
  const cleaned = raw
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (cleaned === '' ? 'project' : cleaned).slice(0, 80);
}

/** Uppercase a Windows drive letter so C:\ and c:\ cannot split the identity. */
export function normalizeDriveLetter(dir) {
  const value = String(dir ?? '');
  return /^[a-z]:/.test(value) ? value[0].toUpperCase() + value.slice(1) : value;
}

/**
 * Resolve the shared repository identity for a gitdir reached from a `.git`
 * file (linked worktree, bare repo worktree, `--separate-git-dir` checkout).
 *
 * `commondir` is the authoritative pointer: linked worktrees and worktrees
 * attached to a bare/separate git dir all read it. Without it, a real git dir
 * (contains HEAD) is used as its own shared identity so a main checkout and its
 * linked worktrees agree.
 * @param {string} worktreeDir directory containing the `.git` file.
 * @returns {string} shared repository root.
 */
function worktreeMainRoot(worktreeDir) {
  try {
    const marker = path.join(worktreeDir, '.git');
    if (!fs.statSync(marker).isFile()) return worktreeDir;
    const content = fs.readFileSync(marker, 'utf8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) return worktreeDir;
    const gitDir = normalizeDriveLetter(path.resolve(worktreeDir, match[1].trim()));
    const commonFile = path.join(gitDir, 'commondir');
    if (fs.existsSync(commonFile)) {
      const relative = fs.readFileSync(commonFile, 'utf8').trim();
      if (relative !== '') {
        const common = normalizeDriveLetter(path.resolve(gitDir, relative));
        return path.basename(common) === '.git' ? path.dirname(common) : common;
      }
    }
    if (path.basename(gitDir) === '.git') return path.dirname(gitDir);
    // `--separate-git-dir` (and submodule) checkouts point at a real git dir.
    if (fs.existsSync(path.join(gitDir, 'HEAD'))) return gitDir;
    // Legacy fallback for worktree paths without a readable commondir.
    const normalized = gitDir.replace(/\\/g, '/');
    const at = normalized.toLowerCase().lastIndexOf('/.git/worktrees/');
    if (at >= 0) return normalizeDriveLetter(path.normalize(normalized.slice(0, at)));
    return worktreeDir;
  } catch {
    return worktreeDir;
  }
}

/**
 * Find the project root: the nearest ancestor containing a `.git` marker.
 * A worktree `.git` file resolves to the shared main repository so all
 * worktrees of one repository use the same memory directory.
 * @param {string} workspaceDir session working directory.
 * @returns {string} absolute project root.
 */
export function resolveProjectRoot(workspaceDir) {
  let dir = normalizeDriveLetter(path.resolve(String(workspaceDir ?? '.')));
  const fallback = dir;
  for (let depth = 0; depth < 30; depth += 1) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        return normalizeDriveLetter(worktreeMainRoot(dir));
      }
    } catch {
      return fallback;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

/** Expand a leading `~` to the user home directory. */
function expandHome(value, homeDir) {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDir, value.slice(2));
  return value;
}

/** Default plugin data root: `<DSH_HOME>/cc-memory`. */
export function defaultMemoryRoot(homeDir) {
  return path.join(homeDir, 'cc-memory');
}

/**
 * Resolve the configured memory root (empty means the default under home).
 * @param {string} [memoryRoot] configured root, may be empty or start with `~`.
 * @param {string} [homeDir] harness home, defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns {string} absolute memory root.
 */
export function resolveMemoryRoot(memoryRoot = '', homeDir = '') {
  const home = homeDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const configured = memoryRoot ? expandHome(String(memoryRoot), home) : '';
  return path.resolve(configured || defaultMemoryRoot(home));
}

/**
 * Build every absolute path this plugin uses for one project.
 * @param {{memoryRoot?: string, homeDir?: string, workspaceDir: string, projectId?: string}} input
 * @returns {{root:string, userMemoryDir:string, userIndexFile:string, projectRoot:string,
 *   projectDir:string, memoryDir:string, indexFile:string, stateFile:string,
 *   lockFile:string, changelogFile:string, dreamsDir:string, pendingDir:string,
 *   trashRoot:string, projectRulesFile:string, globalRulesFile:string,
 *   rulesLogFile:string, pluginStateFile:string, apiTokenFile:string,
 *   metricsFile:string, metricsLockFile:string}}
 */
export function buildPaths({ memoryRoot = '', homeDir = '', workspaceDir = '.', projectId = '' } = {}) {
  const home = homeDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const root = resolveMemoryRoot(memoryRoot, home);
  const projectRoot = resolveProjectRoot(workspaceDir);
  // Explicit identity (config.projectId or a workspace marker) wins over the
  // path-derived slug, so non-git workspaces and monorepos can be split.
  const explicitId = sanitizeProjectId(projectId);
  const projectDirName = explicitId !== '' ? explicitId : projectSlug(projectRoot);
  const projectDir = path.join(root, 'projects', projectDirName);
  const memoryDir = path.join(projectDir, 'memory');
  return {
    root,
    homes: { home, memoryRoot: root },
    userMemoryDir: path.join(root, 'user', 'memory'),
    userIndexFile: path.join(root, 'user', 'memory', 'MEMORY.md'),
    projectRoot,
    projectId: explicitId,
    projectDirName,
    projectDir,
    memoryDir,
    indexFile: path.join(memoryDir, 'MEMORY.md'),
    // Plugin metadata lives beside the memory files so the memory directory
    // keeps only human-readable memory, exactly like Claude Code's layout.
    stateFile: path.join(projectDir, '.state.json'),
    lockFile: path.join(projectDir, '.consolidate-lock'),
    writeLockFile: path.join(projectDir, '.write.lock'),
    changelogFile: path.join(projectDir, '.dream-log.md'),
    dreamsDir: path.join(projectDir, '.dreams'),
    pendingDir: path.join(projectDir, '.pending'),
    pendingWritesDir: path.join(projectDir, '.pending', 'writes'),
    pendingExpiredDir: path.join(projectDir, '.pending', 'expired'),
    trashRoot: path.join(projectDir, '.trash'),
    projectRulesFile: path.join(projectDir, 'memory-rules.md'),
    globalRulesFile: path.join(root, 'memory-rules.md'),
    rulesLogFile: path.join(projectDir, '.memory-rules.log'),
    pluginStateFile: path.join(root, '.plugin-state.json'),
    apiTokenFile: path.join(root, '.api-token'),
    // v8 effect metrics: one JSON document plus a cross-process write lock.
    metricsFile: path.join(projectDir, '.metrics.json'),
    metricsLockFile: path.join(projectDir, '.metrics.lock'),
  };
}

/**
 * Is `child` inside `parent` (or equal)? Both must be absolute.
 * @param {string} parent
 * @param {string} child
 */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
