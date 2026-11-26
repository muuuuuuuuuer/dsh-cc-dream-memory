/**
 * Host verification ledger.
 *
 * A `VERIFIED: <date>` line typed into a page proves nothing: any caller can
 * write that line. The record behind the trust badge in the Memory panel
 * therefore lives beside the memory files and is written only by the host, from
 * the exact version that was just written. It means the note cites words the
 * user actually wrote (a held citation of a user message) or that the user
 * saved it themselves. It does not mean the content was checked.
 *
 * Each record holds one fingerprint per part of the line a later session would
 * show — name, description and body — so a summary edited without touching the
 * body stops counting as verified instead of riding along on a whole-page hash.
 * Only per-field records count: a record without those fingerprints is dropped
 * when the ledger is read.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stripVerification } from './memory-body.js';

// A dot file, so the memory folder a user opens or copies holds only notes.
export const LEDGER_FILE = '.verification.json';
/** Where versions up to 0.20.0 kept the ledger; read as a fallback, removed on the next write. */
const LEGACY_LEDGER_FILE = 'verification.json';
export const LEDGER_VERSION = 2;

function ledgerPath(store, scope) {
  return path.join(store._scopeDir(scope), LEDGER_FILE);
}

function legacyLedgerPath(store, scope) {
  return path.join(store._scopeDir(scope), LEGACY_LEDGER_FILE);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Hash of a page body as the ledger sees it. Host markers do not count, so
 * re-stamping a page does not invalidate a record.
 * @param {string} [body]
 * @returns {string}
 */
export function bodyHashOf(body = '') {
  return digest(stripVerification(String(body ?? '')));
}

/**
 * Fingerprints of the three parts of a note: name, summary and body.
 * @param {{name?:string, description?:string, body?:string}} [page]
 * @returns {{nameHash:string, descriptionHash:string, bodyHash:string}}
 */
export function fieldHashes({ name = '', description = '', body = '' } = {}) {
  return {
    nameHash: digest(name),
    descriptionHash: digest(description),
    bodyHash: bodyHashOf(body),
  };
}

/** True when one ledger record covers exactly this name, summary and body. */
export function matchesRecord(record, { name = '', description = '', body = '' } = {}) {
  if (!isFieldRecord(record)) return false;
  const hashes = fieldHashes({ name, description, body });
  return (
    record.nameHash === hashes.nameHash
    && record.descriptionHash === hashes.descriptionHash
    && record.bodyHash === hashes.bodyHash
  );
}

/** True when a record carries the per-field fingerprints. */
function isFieldRecord(record) {
  return Boolean(record)
    && typeof record.nameHash === 'string'
    && typeof record.descriptionHash === 'string';
}

/** Read the ledger; a missing or unreadable file means "nothing verified". */
export async function readLedger(store, scope = 'project') {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(ledgerPath(store, scope), 'utf8'));
  } catch (error) {
    try {
      if (error?.code !== 'ENOENT') throw error;
      parsed = JSON.parse(await fs.readFile(legacyLedgerPath(store, scope), 'utf8'));
    } catch {
      return { version: LEDGER_VERSION, entries: {} };
    }
  }
  const entries = {};
  for (const [file, record] of Object.entries(parsed?.entries ?? {})) {
    if (isFieldRecord(record)) entries[file] = record;
  }
  return { version: LEDGER_VERSION, entries };
}

async function writeLedger(store, scope, ledger) {
  await store._atomicWrite(ledgerPath(store, scope), `${JSON.stringify({ version: LEDGER_VERSION, entries: ledger.entries }, null, 2)}\n`);
  await fs.rm(legacyLedgerPath(store, scope), { force: true });
}

// One ledger per scope and scope directory: two verifications racing in the same
// scope must both survive, so the read-modify-write runs one at a time.
const queues = new Map();

function serialized(key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(key, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Store one record, serialized per ledger file and stamped with today's date.
 * @returns {Promise<object>} the stored record
 */
async function writeRecord({ store, scope, file, record }) {
  const key = ledgerPath(store, scope);
  const dated = {
    ...record,
    date: typeof record.date === 'string' && record.date !== ''
      ? record.date
      : new Date().toISOString().slice(0, 10),
  };
  return serialized(key, async () => {
    const ledger = await readLedger(store, scope);
    ledger.entries[file] = dated;
    await writeLedger(store, scope, ledger);
    return dated;
  });
}

/**
 * Record that the host verified this exact page content. Called by the write and
 * apply layers after the bytes are on disk, never by a model-facing tool.
 * @returns {Promise<object|null>} the ledger record
 */
export async function recordVerification({
  store,
  scope = 'project',
  file,
  name = '',
  description = '',
  body = '',
  date,
  source = '',
}) {
  if (typeof file !== 'string' || file === '') return null;
  return writeRecord({
    store,
    scope,
    file,
    record: { ...fieldHashes({ name, description, body }), date, source },
  });
}

/**
 * Record the version a write just produced. The caller passes what the store
 * reported about the bytes it wrote (name, description, bodyHash) — never the
 * file: re-reading here could record another session's edit as if the user had
 * approved it.
 * @param {{store:object, scope?:string, file:string, name?:string,
 *   description?:string, bodyHash:string, date?:string, source?:string}} options
 * @returns {Promise<object|null>}
 */
export async function recordVerifiedEntry({
  store,
  scope = 'project',
  file,
  name = '',
  description = '',
  bodyHash,
  date,
  source = 'user-explicit',
}) {
  if (typeof file !== 'string' || file === '') return null;
  if (typeof bodyHash !== 'string' || bodyHash === '') {
    throw new Error('recordVerifiedEntry needs the written body hash');
  }
  return writeRecord({
    store,
    scope,
    file,
    record: {
      nameHash: digest(name),
      descriptionHash: digest(description),
      bodyHash,
      date,
      source,
    },
  });
}

/**
 * True only when the ledger holds a record whose name, summary and body all
 * match what is about to be injected.
 */
export async function verifiedPage({ store, scope = 'project', entry, body = '' }) {
  if (!entry || typeof entry.file !== 'string') return false;
  const ledger = await readLedger(store, scope);
  return matchesRecord(ledger.entries[entry.file], {
    name: entry.name,
    description: entry.description,
    body,
  });
}
