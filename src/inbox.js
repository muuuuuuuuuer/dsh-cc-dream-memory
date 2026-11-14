/**
 * Staged auto-extraction proposals ("Inbox").
 *
 * Auto-extract never needs to touch the main memory store: it writes one JSON
 * record per session tail under `<projectDir>/inbox/`, and a human accepts or
 * discards it. Accepting goes through the same `memory_save` gates (secret
 * scan, policy, budget) as a model-initiated write.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 1;
const ID_RE = /^[A-Za-z0-9._-]+$/;
/** The inbox is a small decision queue, not an archive. */
const MAX_PROPOSALS = 5;

export function inboxDir(paths) {
  return path.join(paths.projectDir, 'inbox');
}

function proposalFile(paths, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    const error = new Error('invalid inbox id');
    error.code = 'INVALID_ID';
    throw error;
  }
  return path.join(inboxDir(paths), `${id}.json`);
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '';
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (name === '' || content === '') return null;
  const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, 240) : '';
  const type = ['user', 'feedback', 'project', 'reference'].includes(raw.type) ? raw.type : 'project';
  return { name, type, description, content };
}

/**
 * Persist one extraction result. Returns the stored record (with `id`).
 * @param {object} paths buildPaths() result
 * @param {{sessionId?:string, cwd?:string, items:object[], model?:object|null, trigger?:string, createdAt?:number}} input
 */
export async function writeProposal(paths, input) {
  const items = Array.isArray(input?.items)
    ? input.items.map(normalizeItem).filter(Boolean).slice(0, 20)
    : [];
  if (items.length === 0) return null;
  const createdAt = Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : Date.now();
  const id = `${createdAt.toString(36)}-${randomUUID().slice(0, 8)}`;
  const record = {
    version: VERSION,
    id,
    createdAt,
    updatedAt: createdAt,
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
    cwd: typeof input.cwd === 'string' ? input.cwd : '',
    trigger: typeof input.trigger === 'string' ? input.trigger : 'auto',
    model: input.model && typeof input.model === 'object'
      ? { provider: String(input.model.provider ?? ''), model: String(input.model.model ?? '') }
      : null,
    status: 'pending',
    items,
  };
  const dir = inboxDir(paths);
  await fs.mkdir(dir, { recursive: true });

  let existing = [];
  try {
    existing = await listProposals(paths);
  } catch {
    // A read-only or partially written inbox must not block the new proposal.
  }

  // Merge into the same session's pending proposal instead of replacing it.
  // Overwriting an unread decision is data loss; duplicates are merged by name.
  const same = record.sessionId === ''
    ? null
    : existing.find((old) => old.sessionId === record.sessionId && old.status !== 'accepted');
  if (same) {
    const merged = mergeItems(same.items, items);
    const updated = {
      ...same,
      updatedAt: createdAt,
      trigger: record.trigger,
      model: record.model ?? same.model,
      items: merged,
    };
    await writeRecord(dir, updated);
    return updated;
  }

  // The queue is a bounded decision list, not an archive. Never evict an
  // unread proposal to make room; a full Inbox simply refuses new sessions.
  if (existing.filter((old) => old.status !== 'accepted').length >= MAX_PROPOSALS) return null;

  await writeRecord(dir, record);
  return record;
}

/** Merge new items into an existing proposal, newest content wins by name. */
function mergeItems(oldItems, newItems) {
  const merged = [];
  const byName = new Map();
  for (const item of [...(Array.isArray(oldItems) ? oldItems : []), ...newItems]) {
    const key = String(item.name).trim().toLowerCase();
    const previous = byName.get(key);
    if (previous) {
      Object.assign(previous, item);
      continue;
    }
    byName.set(key, item);
    merged.push(item);
  }
  // Keep the newest 20; the proposal is a hint, not an archive.
  return merged.slice(-20);
}

async function writeRecord(dir, record) {
  const file = path.join(dir, `${record.id}.json`);
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 6)}`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

/** Every stored proposal, newest first; malformed files are skipped. */
export async function listProposals(paths) {
  const dir = inboxDir(paths);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      const record = JSON.parse(raw);
      if (record && typeof record.id === 'string' && Array.isArray(record.items)) records.push(record);
    } catch {
      // A half-written or hand-edited file must not break `/memory inbox`.
    }
  }
  records.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  return records;
}

/** Read one proposal or throw `NOT_FOUND`. */
export async function readProposal(paths, id) {
  const file = proposalFile(paths, id);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const missing = new Error(`inbox item ${id} was not found`);
      missing.code = 'NOT_FOUND';
      throw missing;
    }
    throw error;
  }
  return JSON.parse(raw);
}

/** Delete one proposal after it was accepted or discarded. */
export async function removeProposal(paths, id) {
  const file = proposalFile(paths, id);
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}
