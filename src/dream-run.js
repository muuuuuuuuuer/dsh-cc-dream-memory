/**
 * Dream run records.
 *
 * A run is a directory under `<project>/.dreams/<runId>/`. The manifest is
 * records the run's progress and outcome. A separate checkpoint keeps the
 * session ranges and draft work needed to resume an interrupted run.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const RUN_FORMAT_VERSION = 2;

function stamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-');
}

/** A sortable, unique run id: `2026-11-12T09-20-31-ab12cd`. */
export function newRunId(now = Date.now()) {
  return `${stamp(now)}-${randomBytes(3).toString('hex')}`;
}

export function runDirOf(paths, runId) {
  return path.join(paths.dreamsDir, runId);
}

export function validRunId(runId) {
  return typeof runId === 'string' && /^[a-z0-9_-]{1,100}$/iu.test(runId);
}

const checkpointFile = (dir) => path.join(dir, 'checkpoint.json');

export async function readRunCheckpoint(dir) {
  try {
    const record = JSON.parse(await fs.readFile(checkpointFile(dir), 'utf8'));
    if (record?.version !== 1 || !Array.isArray(record.work) || record.work.length === 0
      || !Array.isArray(record.sessionIds) || !Array.isArray(record.bases) || !Array.isArray(record.draft?.pages)
      || typeof record.draft.index !== 'string' || !Array.isArray(record.evidence)) return null;
    const valid = record.sessionIds.every((id) => typeof id === 'string' && id !== '')
      && record.work.every((item) => record.sessionIds.includes(item?.id) && Number.isSafeInteger(item.seq)
        && (item.readSeq === null || Number.isSafeInteger(item.readSeq))
        && typeof item.sourceHash === 'string' && typeof item.summary === 'string')
      && record.bases.every((item) => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string'
        && (item[1] === null || typeof item[1] === 'string'))
      && record.draft.pages.every((item) => typeof item?.file === 'string' && (item.raw === null || typeof item.raw === 'string'))
      && record.evidence.every((item) => item && typeof item.quote === 'string');
    return valid ? record : null;
  } catch {
    return null;
  }
}

export function writeRunCheckpoint(dir, record) {
  return writeJsonAtomic(checkpointFile(dir), { version: 1, ...record });
}

export function clearRunCheckpoint(dir) {
  return fs.rm(checkpointFile(dir), { force: true });
}

/** Repair interrupted bookkeeping before a later run may evict its outcome. */
export async function reconcileRunOutcomes(paths, state) {
  for (const outcome of state?.snapshot?.().dreamRunOutcomes ?? []) {
    if (!validRunId(outcome.runId)) continue;
    const dir = runDirOf(paths, outcome.runId);
    if (!await fs.stat(checkpointFile(dir)).then((stat) => stat.isFile(), () => false)) continue;
    const manifest = await readRunManifest(dir);
    if (manifest && ['running', 'paused'].includes(manifest.status)) {
      await writeRunManifest(dir, { ...manifest, ...outcome, stage: 'done' });
    }
    await clearRunCheckpoint(dir);
  }
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Unique per call: several units can finish in the same millisecond, and a
  // shared temp name would make one rename fail with ENOENT after the other
  // already moved the file away.
  const tmp = `${file}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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
    out.push({ dir, runId: manifest.runId || name, manifest,
      checkpoint: ['running', 'paused'].includes(manifest.status) && Boolean(await readRunCheckpoint(dir)) });
  }
  return out;
}

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
    startedAt: 0,
    updatedAt: 0,
    finishedAt: 0,
    models: { agent: '' },
    input: { sessions: [], memoryFiles: 0 },
    usage: {},
    skipReason: '',
    error: '',
    ...base,
  };
}

export function dreamRunOutcome(state, runId) {
  return state?.snapshot?.().dreamRunOutcomes?.find((item) => item.runId === runId);
}

export function summarizeRun(manifest, { running = false, checkpoint = false, outcome } = {}) {
  if (!manifest) return null;
  if (outcome && ['running', 'paused'].includes(manifest.status)) manifest = { ...manifest, ...outcome, stage: 'done' };
  // A paused run requires a readable checkpoint. Honor conflicts written by older versions.
  if (manifest.status === 'paused' && (!checkpoint || manifest.error === 'checkpoint-conflict')) {
    manifest = { ...manifest, status: 'failed',
      error: manifest.error === 'checkpoint-conflict' ? manifest.error : 'checkpoint-unavailable' };
  }
  // A manifest still marked running with no worker behind it was left by a
  // process that stopped mid-run. A published checkpoint lets it resume.
  const interrupted = manifest.status === 'running' && !running;
  const resumable = !running && checkpoint && ['running', 'paused'].includes(manifest.status);
  return {
    runId: manifest.runId,
    status: resumable ? 'paused' : interrupted ? 'failed' : manifest.status,
    interrupted,
    resumable,
    checkpointed: Number(manifest.checkpointed) || 0,
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
    error: interrupted && !resumable && !manifest.error ? 'stopped before finishing (the host process ended); run Dream again' : manifest.error,
    blockedReason: manifest.blockedReason,
    skipReason: manifest.skipReason,
    sessionsReviewed: Number(manifest.sessionsReviewed) || 0,
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
