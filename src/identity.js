/**
 * Project identity resolution for dsh-cc-dream-memory (v9).
 *
 * Priority: explicit config.projectId > workspace marker (searched upwards) >
 * git repository root > plain workspace directory. The identity decides which
 * memory directory a session reads and writes, so non-git workspaces can be
 * split with a marker instead of accidentally sharing one memory space.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './paths.js';

const MARKER_JSON = '.cc-memory.json';
const MARKER_TEXT = '.dsh-memory-project';
const MAX_DEPTH = 30;

function readMarker(dir) {
  try {
    const jsonFile = path.join(dir, MARKER_JSON);
    if (fs.existsSync(jsonFile)) {
      const parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      const id = typeof parsed === 'object' && parsed !== null
        ? parsed.projectId ?? parsed.id ?? parsed.name
        : undefined;
      if (typeof id === 'string' && id.trim() !== '') {
        return { projectId: id.trim(), markerPath: jsonFile };
      }
    }
  } catch {
    /* malformed marker: fall through to the text marker */
  }
  try {
    const textFile = path.join(dir, MARKER_TEXT);
    if (fs.existsSync(textFile)) {
      const id = fs.readFileSync(textFile, 'utf8').trim();
      if (id !== '') return { projectId: id, markerPath: textFile };
    }
  } catch {
    /* unreadable marker: ignore */
  }
  return null;
}

/**
 * @param {{workspaceDir?: string, config?: object, projectRoot?: string}} input
 * @returns {{projectId:string, projectRoot:string, source:'config'|'marker'|'git'|'workspace', markerPath?:string}}
 */
/** True for a normal checkout, a raw gitdir/bare repo, or a separate-git-dir root. */
function looksLikeGitRoot(root) {
  try {
    if (fs.existsSync(path.join(root, '.git'))) return true;
    // Bare repositories and --separate-git-dir roots have HEAD + objects, but
    // no .git child; treating them as workspace causes false sharing warnings.
    return fs.existsSync(path.join(root, 'HEAD')) && fs.existsSync(path.join(root, 'objects'));
  } catch {
    return false;
  }
}

export function resolveIdentity({ workspaceDir, config, projectRoot } = {}) {
  const workspace = path.resolve(String(workspaceDir || '.'));
  const configured = typeof config?.projectId === 'string' ? config.projectId.trim() : '';
  if (configured !== '') {
    return { projectId: configured, projectRoot: projectRoot || resolveProjectRoot(workspace), source: 'config' };
  }
  let dir = workspace;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const marker = readMarker(dir);
    if (marker) {
      return { projectId: marker.projectId, projectRoot: dir, source: 'marker', markerPath: marker.markerPath };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const root = projectRoot || resolveProjectRoot(workspace);
  const hasGit = looksLikeGitRoot(root);
  return { projectId: '', projectRoot: root, source: hasGit ? 'git' : 'workspace' };
}
