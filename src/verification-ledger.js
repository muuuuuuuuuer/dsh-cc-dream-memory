/**
 * Host verification ledger.
 *
 * A `VERIFIED: <date>` line typed into a page proves nothing about who checked
 * it: any caller can write that line, and any caller can compute the hash the
 * page carries. The record that actually gates the hot set therefore lives
 * beside the memory files, is written only by the host after a
 * transcript-backed verification, and is fingerprinted over the exact name,
 * description and body that would be injected — so editing any of them
 * invalidates the record until the page is verified again.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stripVerification } from './memory-body.js';

export const LEDGER_FILE = 'verification.json';

function ledgerPath(store, scope) {
  const dir = typeof store?._scopeDir === 'function' ? store._scopeDir(scope) : store?.rootDir;
  return path.join(dir, LEDGER_FILE);
}

/** Fingerprint of exactly what the hot set would inject for this page. */
export function entryFingerprint({ name = '', description = '', body = '' } = {}) {
  const stamp = [String(name), String(description), stripVerification(String(body ?? ''))].join('\u0000');
  return crypto.createHash('sha256').update(stamp, 'utf8').digest('hex').slice(0, 16);
}

/** Read the ledger; a missing or unreadable file means "nothing verified". */
export async function readLedger(store, scope = 'project') {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath(store, scope), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
      ? { version: 1, entries: { ...parsed.entries } }
      : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

async function writeLedger(store, scope, ledger) {
  const file = ledgerPath(store, scope);
  const payload = `${JSON.stringify({ version: 1, entries: ledger.entries }, null, 2)}\n`;
  if (typeof store?._atomicWrite === 'function') {
    await store._atomicWrite(file, payload);
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, payload, 'utf8');
}

/**
 * Record that the host verified this exact page content. Called by the apply
 * layer after the bytes are on disk, never by a model-facing tool.
 */
export async function recordVerification({ store, scope = 'project', file, name = '', description = '', body = '', date, source = '' }) {
  if (typeof file !== 'string' || file === '') return null;
  const ledger = await readLedger(store, scope);
  const entry = {
    hash: entryFingerprint({ name, description, body }),
    date: typeof date === 'string' && date !== '' ? date : new Date().toISOString().slice(0, 10),
    source,
  };
  ledger.entries[file] = entry;
  await writeLedger(store, scope, ledger);
  return entry;
}

/**
 * Record the bytes on disk as verified, using the same name and description the
 * index shows. The fingerprint covers all three, so writing it from a different
 * source would leave the page permanently masked.
 */
export async function recordVerifiedEntry({ store, scope = 'project', file, date, source = 'user-explicit' }) {
  if (typeof file !== 'string' || file === '') return null;
  const read = await store.readEntry(file, scope);
  const meta = typeof store.listEntries === 'function'
    ? (await store.listEntries(scope)).find((candidate) => candidate.file === file)
    : null;
  return recordVerification({
    store,
    scope,
    file,
    name: meta?.name ?? '',
    description: meta?.description ?? '',
    body: read?.body ?? '',
    date,
    source,
  });
}

/**
 * True only when the ledger holds a record for this page whose fingerprint
 * matches the name, description and body about to be injected.
 */
export async function verifiedPage({ store, scope = 'project', entry, body = '' }) {
  if (!entry || typeof entry.file !== 'string') return false;
  const ledger = await readLedger(store, scope);
  const record = ledger.entries[entry.file];
  if (!record || typeof record.hash !== 'string') return false;
  return record.hash === entryFingerprint({ name: entry.name, description: entry.description, body });
}
