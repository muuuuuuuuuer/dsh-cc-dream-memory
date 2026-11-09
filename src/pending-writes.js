/**
 * Pending-write queue: low-confidence or review-mode memory writes wait here
 * until a human approves or rejects them.
 *
 * One JSON document per proposal under `<projectDir>/.pending/writes/<id>.json`:
 * `{ id, createdAt, candidate, reasons, source }`. Approval writes the memory
 * through the store (so provenance, secret scanning, index upkeep and metrics
 * behave exactly like a regular write) and deletes the proposal; rejection moves
 * it to `.pending/expired/` where it is kept for seven days by the scheduler.
 *
 * Every path is derived from `paths` (the Lead's `paths.pendingWritesDir` /
 * `paths.pendingExpiredDir` when present, with a `.pending/writes` fallback) and
 * every caller-supplied id is validated as a single path component.
 *
 * @module dsh-cc-dream-memory/pending-writes
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { slugify } from './store.js';

const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference']);
/** Milliseconds a rejected proposal is retained in `.pending/expired/`. */
export const EXPIRED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Writes directory for one project. */
export function pendingWritesDir(paths) {
  const value = paths?.pendingWritesDir;
  if (typeof value === 'string' && value !== '') return path.resolve(value);
  const pending = paths?.pendingDir;
  if (typeof pending === 'string' && pending !== '') return path.join(path.resolve(pending), 'writes');
  const projectDir = paths?.projectDir;
  if (typeof projectDir === 'string' && projectDir !== '') {
    return path.join(path.resolve(projectDir), '.pending', 'writes');
  }
  return '';
}

/** Rejected-proposal archive for one project. */
export function pendingExpiredDir(paths) {
  const value = paths?.pendingExpiredDir;
  if (typeof value === 'string' && value !== '') return path.resolve(value);
  const writes = pendingWritesDir(paths);
  return writes === '' ? '' : path.join(path.dirname(writes), 'expired');
}

/** Validate a proposal id as one safe path component. */
function validateId(id) {
  if (typeof id !== 'string' || id.trim() === '') throw coded('INVALID_ID', 'pending write id is required');
  const value = id.trim();
  if (value.includes('/') || value.includes('\\') || value.includes('..') || path.isAbsolute(value)) {
    throw coded('INVALID_ID', `invalid pending write id: ${String(id)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw coded('INVALID_ID', `invalid pending write id: ${String(id)}`);
  return value;
}

/** Generate one `<timestamp>-<random>` id. */
function newId() {
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${Date.now()}-${random}`;
}

/** Group path for one id. */
function recordPath(paths, id) {
  const dir = pendingWritesDir(paths);
  if (dir === '') throw coded('UNAVAILABLE', 'the pending-write directory is unavailable');
  return path.join(dir, `${id}.json`);
}

/** Atomic JSON write (temp file + rename). */
async function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch {
      /* temp file may not exist */
    }
    throw error;
  }
}

function isMissing(error) {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/**
 * Preserve one provenance `source` exactly as supplied: the tools pass an
 * object, callers/tests may pass a plain string like `'tool:memory_save'`.
 */
function normalizeSourceValue(value) {
  if (typeof value === 'string') return value.slice(0, 200);
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  return '';
}

/** Normalize one stored proposal into the public shape. */
function normalizeRecord(raw, fallbackId) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const candidate = value.candidate && typeof value.candidate === 'object' ? value.candidate : {};
  return {
    id: typeof value.id === 'string' && value.id !== '' ? value.id : fallbackId,
    createdAt: Number(value.createdAt) || 0,
    // v12: confirm-mode reviews can be saves or in-place updates.
    action: value.action === 'update' || value.action === 'delete' ? value.action : 'save',
    file: typeof value.file === 'string' ? value.file : '',
    // Top-level rename target (approval applies it together with content).
    name: value.action === 'update'
      ? (typeof value.name === 'string' ? value.name : '')
      : (typeof value.name === 'string' && value.name !== '' ? value.name : (typeof candidate.name === 'string' ? candidate.name : '')),
    content: typeof value.content === 'string' ? value.content : null,
    description: typeof value.description === 'string' ? value.description : null,
    candidate: {
      scope: candidate.scope === 'user' ? 'user' : 'project',
      name: typeof value.name === 'string' && value.name !== '' ? value.name : (typeof candidate.name === 'string' ? candidate.name : ''),
      type: MEMORY_TYPES.includes(candidate.type) ? candidate.type : 'user',
      description: typeof candidate.description === 'string' ? candidate.description : '',
      content: typeof candidate.content === 'string' ? candidate.content : '',
    },
    reasons: Array.isArray(value.reasons)
      ? value.reasons.filter((reason) => typeof reason === 'string')
      : [],
    source: normalizeSourceValue(value.source),
    ...(typeof value.expectedHash === 'string' && /^[a-f0-9]{64}$/.test(value.expectedHash) ? { expectedHash: value.expectedHash } : {}),
  };
}

/**
 * List pending writes, newest first. Missing directory → `[]`; corrupt records
 * are skipped with a warning.
 * @param {object} paths
 * @returns {Promise<Array<{id:string,createdAt:number,candidate:object,reasons:string[],source:object}>>}
 */
export async function listPendingWrites(paths) {
  const dir = pendingWritesDir(paths);
  if (dir === '') return [];
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      records.push(normalizeRecord(raw, id));
    } catch (error) {
      if (!(error instanceof SyntaxError)) warn('pending writes', error);
    }
  }
  records.sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  return records;
}

/**
 * Read one pending write.
 * @param {object} paths
 * @param {string} id
 * @returns {Promise<object|null>} the record, or `null` when absent.
 */
export async function readPendingWrite(paths, id) {
  const safeId = validateId(id);
  try {
    const raw = JSON.parse(await fs.readFile(recordPath(paths, safeId), 'utf8'));
    return normalizeRecord(raw, safeId);
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Queue one candidate write for review. `action:'update'` records an in-place
 * update of an existing file (v12 confirm mode): `file` plus the new
 * `content`/`description` are stored alongside the usual candidate snapshot.
 * @param {object} paths
 * @param {{candidate:object, reasons?:string[], source?:object,
 *   action?:'save'|'update', file?:string, content?:string, description?:string}} input
 * @returns {Promise<{id:string, file:string, record:object}>}
 */
export async function queuePendingWrite(paths, input = {}) {
  const dir = pendingWritesDir(paths);
  if (dir === '') throw coded('UNAVAILABLE', 'the pending-write directory is unavailable');
  const candidate = input.candidate && typeof input.candidate === 'object' ? input.candidate : {};
  const record = normalizeRecord(
    {
      id: newId(),
      createdAt: Date.now(),
      action: input.action === 'update' || input.action === 'delete' ? input.action : 'save',
      file: typeof input.file === 'string' ? input.file : '',
      name: typeof input.name === 'string' ? input.name : '',
      content: typeof input.content === 'string' ? input.content : null,
      description: typeof input.description === 'string' ? input.description : null,
      candidate,
      expectedHash: input.expectedHash,
      reasons: Array.isArray(input.reasons) ? input.reasons : [],
      source: input.source && typeof input.source === 'object' ? input.source : {},
    },
    '',
  );
  if (record.id === '') record.id = newId();
  const file = path.join(dir, `${record.id}.json`);
  await writeJsonAtomic(file, record);
  return { id: record.id, file, record };
}

/**
 * Approve one pending write: write it through the store, then remove it from the
 * queue. The caller supplies the store so the write goes through the normal
 * provenance/secret-scan/index path.
 * @param {object} paths
 * @param {string} id
 * @param {{store:object, source?:object}} options
 * @returns {Promise<{written:true, id:string, file:string}>}
 */
export async function approvePendingWrite(paths, id, options = {}) {
  const safeId = validateId(id);
  const record = await readPendingWrite(paths, safeId);
  if (record === null) throw coded('NOT_FOUND', `pending write not found: ${safeId}`);
  const store = options.store;
  if (!store || typeof store.writeRawEntry !== 'function') {
    throw coded('UNAVAILABLE', 'the memory store cannot write this pending entry');
  }
  const candidate = record.candidate;
  const recordSource = record.source;
  const recordVia =
    typeof recordSource === 'string'
      ? recordSource
      : recordSource && typeof recordSource.via === 'string'
        ? recordSource.via
        : '';
  const recordSession =
    recordSource && typeof recordSource === 'object' && typeof recordSource.sessionId === 'string'
      ? recordSource.sessionId
      : '';
  const source = {
    sessionId:
      typeof options.source?.sessionId === 'string' && options.source.sessionId !== ''
        ? options.source.sessionId
        : recordSession,
    via:
      typeof options.source?.via === 'string' && options.source.via !== ''
        ? options.source.via
        : recordVia !== ''
          ? recordVia
          : 'tool:memory_save',
  };
  // v12 Bug 2: an update queued under writeMode:'confirm' is approved through
  // store.updateEntry so `created`/provenance are preserved.
  if (record.action === 'delete') {
    if (record.file === '' || typeof store.trashEntry !== 'function') {
      throw coded('INVALID_FILE', 'pending review has no target file to delete');
    }
    await store.trashEntry(record.file, { scope: candidate.scope, reason: 'approved pending delete', expectedHash: record.expectedHash });
    try {
      await fs.unlink(recordPath(paths, safeId));
    } catch (error) {
      if (!isMissing(error)) warn('pending writes', error);
    }
    return { written: true, action: 'delete', id: safeId, file: record.file };
  }
  if (record.action === 'update') {
    const targetFile =
      record.file !== ''
        ? record.file
        : typeof candidate.file === 'string' && candidate.file !== ''
          ? candidate.file
          : '';
    if (targetFile === '') throw coded('INVALID_FILE', 'pending review has no target file to update');
    if (typeof store.updateEntry !== 'function') {
      throw coded('UNAVAILABLE', 'the memory store cannot update this pending entry');
    }
    const changes = {
      scope: candidate.scope,
      source,
      expectedHash: record.expectedHash,
      // Approval keeps whatever `created`/provenance the file already had
      // (including a legacy file's absent `created`) instead of stamping new
      // provenance on a human review action.
      preserveCreatedAbsence: true,
    };
    if (record.content !== null) changes.content = record.content;
    if (record.description !== null) changes.description = record.description;
    let updated;
    if (typeof record.name === 'string' && record.name !== '' && typeof store.renameEntry === 'function') {
      // One atomic store operation: validate content/description, write the new
      // slug, then move the old file to trash. No half-renamed state.
      updated = await store.renameEntry(targetFile, record.name, {
        scope: candidate.scope,
        source,
        expectedHash: record.expectedHash,
        content: changes.content,
        description: changes.description,
      });
    } else {
      updated = await store.updateEntry(targetFile, changes);
    }
    const finalFile = typeof updated?.file === 'string' ? updated.file : targetFile;
    try {
      await fs.unlink(recordPath(paths, safeId));
    } catch (error) {
      if (!isMissing(error)) warn('pending writes', error);
    }
    return {
      written: true,
      action: 'update',
      id: safeId,
      file: finalFile,
    };
  }
  const type = MEMORY_TYPES.includes(candidate.type) ? candidate.type : 'user';
  const memoryDir = paths?.memoryDir;
  if (typeof memoryDir !== 'string' || memoryDir === '') {
    throw coded('UNAVAILABLE', 'the memory directory is unavailable');
  }
  const file = await pickFileName(memoryDir, `${type}_${slugify(candidate.name || 'memory')}`);
  await store.writeRawEntry(file, {
    scope: candidate.scope,
    type,
    name: candidate.name,
    description: candidate.description,
    body: candidate.content,
    source,
  });
  try {
    await fs.unlink(recordPath(paths, safeId));
  } catch (error) {
    if (!isMissing(error)) warn('pending writes', error);
  }
  return { written: true, action: 'save', id: safeId, file };
}

/** First free topic-file name (base, base-hash6, base-hash6-2…). */
async function pickFileName(memoryDir, base) {
  let existing = new Set();
  try {
    existing = new Set(await fs.readdir(memoryDir));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const digest = createHash('sha1').update(base).digest('hex').slice(0, 6);
  const candidates = [`${base}.md`, `${base}-${digest}.md`];
  for (let attempt = 2; attempt <= 5; attempt += 1) candidates.push(`${base}-${digest}-${attempt}.md`);
  for (const candidate of candidates) if (!existing.has(candidate)) return candidate;
  return `${base}-${digest}-${Date.now().toString(36)}.md`;
}

/**
 * Reject one pending write: move it into `.pending/expired/` with a rejection
 * reason so the scheduler can prune it after the retention window.
 * @param {object} paths
 * @param {string} id
 * @param {string} [reason]
 * @returns {Promise<{rejected:true, id:string, path:string|null}>}
 */
export async function rejectPendingWrite(paths, id, reason = '') {
  const safeId = validateId(id);
  const record = await readPendingWrite(paths, safeId);
  if (record === null) throw coded('NOT_FOUND', `pending write not found: ${safeId}`);
  const archived = {
    ...record,
    rejectedAt: Date.now(),
    reason: typeof reason === 'string' ? reason.slice(0, 500) : '',
    expiresAt: Date.now() + EXPIRED_RETENTION_MS,
  };
  const expiredDir = pendingExpiredDir(paths);
  const source = recordPath(paths, safeId);
  let target = null;
  if (expiredDir !== '') {
    try {
      await fs.mkdir(expiredDir, { recursive: true });
      target = path.join(expiredDir, `${safeId}.json`);
      await writeJsonAtomic(target, archived);
    } catch (error) {
      warn('pending writes', error);
      target = null;
    }
  }
  try {
    await fs.unlink(source);
  } catch (error) {
    if (!isMissing(error)) warn('pending writes', error);
  }
  return { rejected: true, id: safeId, path: target };
}

/** Delete expired entries older than the retention window. */
export async function pruneExpiredWrites(paths, now = Date.now()) {
  const dir = pendingExpiredDir(paths);
  if (dir === '') return { pruned: 0 };
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (isMissing(error)) return { pruned: 0 };
    throw error;
  }
  let pruned = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      const expiresAt = Number(raw?.expiresAt) || 0;
      if (expiresAt > 0 && expiresAt > now) continue;
      await fs.unlink(file);
      pruned += 1;
    } catch (error) {
      if (error instanceof SyntaxError) {
        try {
          await fs.unlink(file);
          pruned += 1;
        } catch {
          /* best effort */
        }
      }
    }
  }
  return { pruned };
}
