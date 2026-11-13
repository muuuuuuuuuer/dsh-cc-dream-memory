/**
 * Dream run records.
 *
 * A run is a directory under `<project>/.dreams/<runId>/`. The manifest is
 * written before any model call, so a later session can see what a run planned,
 * which units finished, and why it stopped. Verified analyzer units are stored
 * one file per unit and reused on resume, which is what makes resumption
 * incremental instead of a full re-analysis.
 *
 * The format version is part of every unit id: a reader that does not
 * understand the current format never reuses an old record.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const RUN_FORMAT_VERSION = 2;

function text(value) {
  return typeof value === 'string' ? value : '';
}

function stamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-');
}

/** A sortable, unique run id: `2026-11-12T09-20-31-ab12cd`. */
export function newRunId(now = Date.now()) {
  return `${stamp(now)}-${randomBytes(3).toString('hex')}`;
}

export function digestOf(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/** Stable across runs only when the format, source range, and text all match. */
export function unitIdOf({ sessionId, firstSeq, lastSeq, text: body }) {
  return digestOf(`${RUN_FORMAT_VERSION}\0${text(sessionId)}\0${firstSeq ?? ''}\0${lastSeq ?? ''}\0${text(body)}`);
}

export function runDirOf(paths, runId) {
  return path.join(paths.dreamsDir, runId);
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Unique per call: several units can finish in the same millisecond, and a
  // shared temp name would make one rename fail with ENOENT after the other
  // already moved the file away.
  const tmp = `${file}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  // Windows refuses to rename onto a file another reader has open. Status polls
  // read the manifest constantly, so retry briefly instead of losing an update.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (error) {
      const transient = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES';
      if (!transient || attempt >= 24) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(20 * (attempt + 1), 150)));
    }
  }
}

export async function readRunManifest(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export async function writeRunManifest(dir, manifest) {
  await writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
  return manifest;
}

/** Newest first; unreadable run directories are skipped, not fatal. */
export async function listRunManifests(paths, limit = 20) {
  let names = [];
  try {
    names = await fs.readdir(paths.dreamsDir);
  } catch {
    return [];
  }
  const dirs = [];
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f]{6}$/u.test(name)) continue;
    dirs.push(name);
  }
  dirs.sort().reverse();
  const out = [];
  for (const name of dirs.slice(0, Math.max(1, limit))) {
    const dir = path.join(paths.dreamsDir, name);
    const manifest = await readRunManifest(dir);
    if (!manifest) continue;
    out.push({ dir, runId: manifest.runId || name, manifest });
  }
  return out;
}

export function unitFile(dir, sessionId, unitId) {
  // Session ids are host-generated but still go through a whitelist so a
  // malformed id can never escape the run directory.
  const safeSession = text(sessionId).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120);
  return path.join(dir, 'analysis', safeSession, `${unitId}.json`);
}

export async function readUnitRecord(dir, sessionId, unitId) {
  try {
    const raw = await fs.readFile(unitFile(dir, sessionId, unitId), 'utf8');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    if (value.unitId !== unitId) return null;
    if (value.formatVersion !== RUN_FORMAT_VERSION) return null;
    return value;
  } catch {
    return null;
  }
}

export async function writeUnitRecord(dir, sessionId, unitId, record) {
  const file = unitFile(dir, sessionId, unitId);
  await writeJsonAtomic(file, { ...record, unitId, formatVersion: RUN_FORMAT_VERSION });
  return file;
}

/**
 * The manifest is written often (once per unit). Keep it small: unit records
 * carry the payloads, the manifest carries ranges and status.
 */
export function shapeManifest(base = {}) {
  return {
    kind: 'dream',
    mode: 'v2',
    formatVersion: RUN_FORMAT_VERSION,
    runId: '',
    projectId: '',
    status: 'running',
    stage: 'prepare',
    trigger: 'manual',
    reason: '',
    dryRun: false,
    startedAt: 0,
    updatedAt: 0,
    finishedAt: 0,
    models: { analyzer: '', organizer: '' },
    input: { sessions: [], expectedUnits: 0, memoryFiles: 0 },
    usage: {},
    counts: { done: 0, failed: 0, pending: 0 },
    errors: [],
    planPath: '',
    applied: false,
    coverageComplete: null,
    skipReason: '',
    blockedReason: '',
    error: '',
    ...base,
  };
}

export function summarizeRun(manifest, { running = false } = {}) {
  if (!manifest) return null;
  // A manifest still marked running with no worker behind it was left by a
  // process that stopped mid-run. It can only be resumed, so it reads as failed.
  const interrupted = manifest.status === 'running' && !running;
  return {
    runId: manifest.runId,
    status: interrupted ? 'failed' : manifest.status,
    interrupted,
    stage: manifest.stage,
    trigger: manifest.trigger,
    reason: manifest.reason,
    dryRun: manifest.dryRun,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    models: manifest.models,
    input: {
      expectedUnits: Number(manifest.input?.expectedUnits) || 0,
      memoryFiles: Number(manifest.input?.memoryFiles) || 0,
      sessions: (manifest.input?.sessions ?? []).map((session) => session.id),
    },
    counts: manifest.counts,
    coverageComplete: manifest.coverageComplete,
    planPath: manifest.planPath,
    applied: manifest.applied,
    error: interrupted && !manifest.error ? 'stopped before finishing (the host process ended); resume to continue' : manifest.error,
    blockedReason: manifest.blockedReason,
    skipReason: manifest.skipReason,
    usage: manifest.usage,
    errors: manifest.errors ?? [],
    sessions: (manifest.input?.sessions ?? []).map((session) => ({
      id: session.id,
      units: (session.units ?? []).length,
      done: (session.units ?? []).filter((unit) => unit.status === 'done').length,
      failed: (session.units ?? []).filter((unit) => unit.status === 'failed').length,
    })),
    pendingUnits: (manifest.input?.sessions ?? []).flatMap((session) => (session.units ?? [])
      .filter((unit) => unit.status !== 'done')
      .map((unit) => ({ sessionId: session.id, ...unit }))),
  };
}
