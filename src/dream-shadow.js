/**
 * Dream works on a copy of the memory directory.
 *
 * The analyzer and the organizer write into that copy, never into the live
 * notes. When the run finishes the human sees a file-level diff and either
 * switches to the copy or throws it away. This is the upstream dream shape: a
 * run produces a new store, and adopting it is one explicit step.
 *
 * Nothing in this module writes to the live memory directory except
 * `switchShadow`, which backs the live notes up first.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryStore } from './store.js';

/** Hash of one file's text, used to notice a note edited during a run. */
function hashText(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/** Directory holding the pending copy, beside the run artifacts. */
export function shadowDirOf(paths) {
  return path.join(paths.dreamsDir, 'shadow');
}

/** A paths object whose memory directory is the shadow copy. */
export function shadowPathsOf(paths) {
  const dir = shadowDirOf(paths);
  return {
    ...paths,
    memoryDir: dir,
    indexFile: path.join(dir, 'MEMORY.md'),
  };
}

/** Remove the pending copy, if any. */
export async function clearShadow(paths) {
  await fs.rm(shadowDirOf(paths), { recursive: true, force: true });
}

/**
 * Keep the copy that produced a switch, the way a managed dream keeps its
 * output store: the result stays inspectable after the human applied it.
 * @param {Record<string,string>} paths
 * @param {string} stamp
 */
export async function archiveShadow(paths, stamp) {
  const source = shadowDirOf(paths);
  const target = path.join(paths.dreamsDir, stamp || `switch-${Date.now()}`, 'output');
  if (!fs.existsSync(source)) return '';
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
  await clearShadow(paths);
  return target;
}

/**
 * Copy the live project notes into a fresh shadow directory.
 * @param {{store: import('./store.js').MemoryStore, paths: Record<string, string>}} input
 * @returns {Promise<{shadowStore: import('./store.js').MemoryStore, base: Record<string, string>}>}
 */
export async function prepareShadow({ store, paths, config }) {
  await clearShadow(paths);
  const shadowPaths = shadowPathsOf(paths);
  await fs.mkdir(shadowPaths.memoryDir, { recursive: true });
  const base = {};
  for (const entry of await store.listEntries('project')) {
    const live = await store.readEntry(entry.file, 'project');
    await fs.writeFile(path.join(shadowPaths.memoryDir, entry.file), live.raw, 'utf8');
    base[entry.file] = hashText(live.raw);
  }
  const indexText = await store.indexText('project');
  if (typeof indexText === 'string' && indexText !== '') {
    await fs.writeFile(shadowPaths.indexFile, indexText, 'utf8');
  }
  const shadowStore = new MemoryStore({ paths: shadowPaths, getConfig: () => config });
  return { shadowStore, base };
}

/**
 * Write merged pages into the shadow copy. Deleted notes go to the shadow's
 * trash directory, so a discarded run leaves the live notes untouched even
 * when it deleted something.
 * @param {{shadowStore: import('./store.js').MemoryStore, operations: Array<Record<string, unknown>>}} input
 */
export async function applyShadowOperations({ shadowStore, operations }) {
  const counts = { write: 0, delete: 0, index: 0 };
  const touched = new Set();
  for (const op of Array.isArray(operations) ? operations : []) {
    if (!op || typeof op !== 'object') continue;
    const scope = 'project';
    if (op.op === 'index') {
      await shadowStore.writeIndex(String(op.content ?? ''), scope);
      counts.index += 1;
      continue;
    }
    if (op.op === 'delete') {
      if (typeof op.file !== 'string' || op.file === '') continue;
      await shadowStore.trashEntry(op.file, { scope, reason: 'dream consolidation' });
      counts.delete += 1;
      touched.add(op.file);
      continue;
    }
    if (typeof op.file !== 'string' || op.file === '') continue;
    await shadowStore.writeRawEntry(op.file, {
      scope,
      type: op.type,
      name: op.name,
      description: op.description,
      body: typeof op.body === 'string' ? op.body : '',
      source: { via: 'dream' },
    });
    counts.write += 1;
    touched.add(op.file);
  }
  await shadowStore.refreshIndex('project').catch(() => {});
  return { counts, touched };
}

/**
 * File-level difference between the live notes and the pending copy.
 * @returns {Promise<{added: string[], changed: string[], removed: string[], files: Array<{file: string, action: 'added'|'changed'|'removed'}>}>}
 */
export async function diffShadow({ store, shadowStore }) {
  const live = new Map((await store.listEntries('project')).map((entry) => [entry.file, entry]));
  const copy = new Map((await shadowStore.listEntries('project')).map((entry) => [entry.file, entry]));
  const added = [];
  const changed = [];
  const removed = [];
  for (const [file, entry] of copy) {
    const before = live.get(file);
    if (!before) {
      added.push(file);
      continue;
    }
    // \`listEntries\` carries metadata only, so the body comparison reads both
    // sides in full (each store caches what it read for this operation).
    const [here, there] = await Promise.all([
      store.readEntry(file, 'project').then((item) => item.raw).catch(() => null),
      shadowStore.readEntry(file, 'project').then((item) => item.raw).catch(() => null),
    ]);
    if (
      before.name !== entry.name
      || before.description !== entry.description
      || hashText(here) !== hashText(there)
    ) changed.push(file);
  }
  for (const file of live.keys()) {
    if (!copy.has(file)) removed.push(file);
  }
  const files = [
    ...added.map((file) => ({ file, action: 'added' })),
    ...changed.map((file) => ({ file, action: 'changed' })),
    ...removed.map((file) => ({ file, action: 'removed' })),
  ];
  return { added, changed, removed, files };
}

/**
 * Notes edited while the run was building the copy.
 * @returns {Promise<Array<{file: string, reason: string}>>}
 */
export async function shadowConflicts({ store, base }) {
  const conflicts = [];
  for (const [file, hash] of Object.entries(base ?? {})) {
    let live = null;
    try {
      live = await store.readEntry(file, 'project');
    } catch {
      live = null;
    }
    if (!live) {
      conflicts.push({ file, reason: 'deleted while the dream ran' });
      continue;
    }
    if (hashText(live.raw) !== hash) conflicts.push({ file, reason: 'edited while the dream ran' });
  }
  return conflicts;
}

/**
 * Replace the live notes with the pending copy.
 *
 * Order matters: the backup is complete before the first live file changes, so
 * a failure part-way through is recoverable by restoring that directory.
 * @returns {Promise<{ok: boolean, error?: string, conflicts?: Array<{file:string,reason:string}>, backupDir?: string, counts?: Record<string, number>}>}
 */
export async function switchShadow({ store, shadowStore, paths, base, stamp = '' }) {
  const conflicts = await shadowConflicts({ store, base });
  if (conflicts.length > 0) return { ok: false, error: 'conflict', conflicts };
  const live = new Map((await store.listEntries('project')).map((entry) => [entry.file, entry]));
  const copy = new Map((await shadowStore.listEntries('project')).map((entry) => [entry.file, entry]));
  const backupDir = path.join(paths.dreamsDir, stamp || `switch-${Date.now()}`, 'memory');
  await fs.mkdir(backupDir, { recursive: true });
  await fs.cp(paths.memoryDir, backupDir, { recursive: true });
  for (const file of copy.keys()) {
    const page = await shadowStore.readEntry(file, 'project');
    await fs.writeFile(path.join(paths.memoryDir, file), page.raw, 'utf8');
  }
  for (const file of live.keys()) {
    if (copy.has(file)) continue;
    await store.trashEntry(file, { scope: 'project', reason: 'dream consolidation' }).catch(async () => {
      await fs.rm(path.join(paths.memoryDir, file), { force: true });
    });
  }
  // The shadow's index carries what the notes alone cannot say, such as
  // `MOVED TO` stubs for retired pages; copy it, then reconcile against the
  // files that actually landed.
  const shadowIndex = await shadowStore.indexText('project');
  if (shadowIndex.trim() !== '') await store.writeIndex(shadowIndex, 'project');
  await store.refreshIndex('project');
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const [file, entry] of copy) {
    const before = live.get(file);
    if (!before) counts.added += 1;
    else if (before.name !== entry.name
      || before.description !== entry.description
      || hashText(before.body) !== hashText(entry.body)) counts.changed += 1;
  }
  counts.removed = [...live.keys()].filter((file) => !copy.has(file)).length;
  return { ok: true, backupDir, counts };
}
