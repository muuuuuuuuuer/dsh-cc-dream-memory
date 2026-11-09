/**
 * Per-project effect metrics, dream cost accounting and 60-day daily buckets.
 *
 * One JSON document per project (`paths.metricsFile`, `.metrics.json` beside
 * the memory directory) records how often memory is injected, which files are
 * actually read (and newly adopted per session), how much is written, how
 * searches perform, what a dream cost and how good its plans were.
 *
 * Concurrency and robustness:
 * - writes are serialized in-process per metrics file and additionally guarded
 *   by `<metrics>.lock` (`open(..., 'wx')`, stale after 10 s) so two Host
 *   processes sharing one profile merge instead of clobbering;
 * - every mutation re-reads the document before changing it (read-merge-write)
 *   and persists with a temp file in the OS temp directory + rename (atomic, and
 *   it can never resurrect a project directory deleted by a test teardown);
 * - corrupt or missing files fall back to empty metrics; unknown fields are
 *   ignored; a failed write only warns and never disturbs the main flow.
 *
 * @module dsh-cc-dream-memory/metrics
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Schema version written by this module. */
export const METRICS_VERSION = 1;
/** Lock considered stale after this long (crashed writer). */
const LOCK_TTL_MS = 10_000;
/** Retry delay while another writer holds the lock. */
const LOCK_RETRY_MS = 15;
/** Give up waiting for the lock after this long and write unlocked. */
const LOCK_MAX_WAIT_MS = 1_500;
/** Default number of most-read files in a summary. */
export const TOP_READ_LIMIT = 5;
/** Default number of never-read files in a summary (v8 contract: <= 20). */
export const NEVER_READ_LIMIT = 20;
/** Daily buckets retained in the metrics file. */
export const DAILY_RETENTION_DAYS = 60;
/** Sessions remembered for per-session adoption tracking. */
const ADOPTION_SESSION_LIMIT = 200;
/** Files remembered per session for adoption tracking. */
const ADOPTION_FILES_PER_SESSION = 200;
/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** Token/cost usage fields mirrored from `ctx.llm.stream`. */
const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
];
/** Dream quality counters carried inside `dreams.quality`. */
const QUALITY_FIELDS = ['appliedOps', 'planOps', 'dropped', 'rollbacks'];

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

/** Non-negative integer, or the fallback. */
function nonNegativeInt(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.trunc(number));
}

/** True when the error means "the file does not exist". */
function isMissing(error) {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** `YYYY-MM-DD` UTC key for one timestamp. */
export function dayKey(at = Date.now()) {
  return new Date(Number(at) || Date.now()).toISOString().slice(0, 10);
}

/** Normalize one usage object (all-zero/absent columns become `null`). */
function normalizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const field of USAGE_FIELDS) {
    if (Number.isFinite(Number(value[field]))) usage[field] = nonNegativeInt(value[field]);
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

/** A fresh empty daily bucket. */
function emptyDay() {
  return {
    injections: 0,
    reads: 0,
    writes: 0,
    searches: 0,
    adopted: 0,
    dreams: { proposed: 0, applied: 0, rejected: 0, failed: 0 },
  };
}

/**
 * A fresh empty metrics document.
 * @param {number} [since] first-observation timestamp (0 until the first write).
 * @returns {object}
 */
export function emptyMetrics(since = 0) {
  return {
    version: METRICS_VERSION,
    since: nonNegativeInt(since),
    updatedAt: 0,
    injections: { count: 0, lastAt: 0 },
    entries: {},
    searches: { count: 0, hits: 0 },
    // `appliedOps` and `quality` are added by the first dream event (schema
    // stays minimal until then, matching the v8 contract example document).
    dreams: { proposed: 0, applied: 0, rejected: 0, failed: 0 },
    costs: { lastDurationMs: 0, lastInputChars: 0, lastOutputChars: 0, lastUsage: null },
    daily: {},
    adoptions: { count: 0, lastAt: 0, sessions: {} },
  };
}

/** Normalize one daily bucket into the current schema. */
function normalizeDay(raw) {
  const bucket = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const dreams = bucket.dreams && typeof bucket.dreams === 'object' ? bucket.dreams : {};
  return {
    injections: nonNegativeInt(bucket.injections, 0),
    reads: nonNegativeInt(bucket.reads, 0),
    writes: nonNegativeInt(bucket.writes, 0),
    searches: nonNegativeInt(bucket.searches, 0),
    adopted: nonNegativeInt(bucket.adopted, 0),
    dreams: {
      proposed: nonNegativeInt(dreams.proposed, 0),
      applied: nonNegativeInt(dreams.applied, 0),
      rejected: nonNegativeInt(dreams.rejected, 0),
      failed: nonNegativeInt(dreams.failed, 0),
    },
  };
}

/**
 * Normalize one parsed document into the current schema: unknown fields are
 * dropped, invalid counters become 0 and a broken entries map becomes empty.
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeMetrics(raw) {
  const metrics = emptyMetrics(0);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return metrics;
  const source = raw;
  metrics.since = nonNegativeInt(source.since, 0);
  metrics.updatedAt = nonNegativeInt(source.updatedAt, 0);
  metrics.injections = {
    count: nonNegativeInt(source.injections?.count, 0),
    lastAt: nonNegativeInt(source.injections?.lastAt, 0),
  };
  metrics.searches = {
    count: nonNegativeInt(source.searches?.count, 0),
    hits: nonNegativeInt(source.searches?.hits, 0),
  };
  // Added by the first automatic recall, like the dream quality fields.
  if (source.recalls && typeof source.recalls === 'object') {
    metrics.recalls = {
      count: nonNegativeInt(source.recalls.count, 0),
      files: nonNegativeInt(source.recalls.files, 0),
      lastAt: nonNegativeInt(source.recalls.lastAt, 0),
    };
  }
  metrics.dreams = {
    proposed: nonNegativeInt(source.dreams?.proposed, 0),
    applied: nonNegativeInt(source.dreams?.applied, 0),
    rejected: nonNegativeInt(source.dreams?.rejected, 0),
    failed: nonNegativeInt(source.dreams?.failed, 0),
  };
  if (source.dreams && source.dreams.appliedOps !== undefined) {
    metrics.dreams.appliedOps = nonNegativeInt(source.dreams.appliedOps, 0);
  }
  if (source.dreams && source.dreams.quality && typeof source.dreams.quality === 'object') {
    metrics.dreams.quality = {};
    for (const field of QUALITY_FIELDS) {
      metrics.dreams.quality[field] = nonNegativeInt(source.dreams.quality[field], 0);
    }
  }
  metrics.costs = {
    lastDurationMs: nonNegativeInt(source.costs?.lastDurationMs, 0),
    lastInputChars: nonNegativeInt(source.costs?.lastInputChars, 0),
    lastOutputChars: nonNegativeInt(source.costs?.lastOutputChars, 0),
    lastUsage: normalizeUsage(source.costs?.lastUsage),
  };
  const entries =
    source.entries && typeof source.entries === 'object' && !Array.isArray(source.entries)
      ? source.entries
      : {};
  for (const [file, value] of Object.entries(entries)) {
    if (typeof file !== 'string' || file === '' || !value || typeof value !== 'object') continue;
    metrics.entries[file] = {
      reads: nonNegativeInt(value.reads, 0),
      writes: nonNegativeInt(value.writes, 0),
      lastReadAt: nonNegativeInt(value.lastReadAt, 0),
      lastWriteAt: nonNegativeInt(value.lastWriteAt, 0),
    };
  }
  const dailySource =
    source.daily && typeof source.daily === 'object' && !Array.isArray(source.daily) ? source.daily : {};
  const dailyKeys = Object.keys(dailySource)
    .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort()
    .slice(-DAILY_RETENTION_DAYS);
  for (const key of dailyKeys) metrics.daily[key] = normalizeDay(dailySource[key]);
  const adoptionsSource =
    source.adoptions && typeof source.adoptions === 'object' && !Array.isArray(source.adoptions)
      ? source.adoptions
      : {};
  metrics.adoptions = {
    count: nonNegativeInt(adoptionsSource.count, 0),
    lastAt: nonNegativeInt(adoptionsSource.lastAt, 0),
    sessions: {},
  };
  const sessionSource =
    adoptionsSource.sessions && typeof adoptionsSource.sessions === 'object'
      ? adoptionsSource.sessions
      : {};
  const sessionIds = Object.keys(sessionSource).slice(-ADOPTION_SESSION_LIMIT);
  for (const sessionId of sessionIds) {
    if (typeof sessionId !== 'string' || sessionId === '') continue;
    const files = Array.isArray(sessionSource[sessionId])
      ? sessionSource[sessionId].filter((file) => typeof file === 'string' && file !== '')
      : [];
    if (files.length > 0) metrics.adoptions.sessions[sessionId] = [...new Set(files)];
  }
  return metrics;
}

/** Absolute metrics file for one project ('' when paths are unusable). */
function metricsFileOf(paths) {
  const file = paths?.metricsFile;
  if (typeof file === 'string' && file !== '') return path.resolve(file);
  const projectDir = paths?.projectDir;
  if (typeof projectDir === 'string' && projectDir !== '') {
    return path.join(path.resolve(projectDir), '.metrics.json');
  }
  return '';
}

/** Absolute lock file for one project's metrics file. */
function metricsLockFileOf(paths, metricsFile) {
  const file = paths?.metricsLockFile;
  if (typeof file === 'string' && file !== '') return path.resolve(file);
  return metricsFile === '' ? '' : `${metricsFile}.lock`;
}

/**
 * Read and normalize one project's metrics. A missing or corrupt document is
 * reported as empty metrics instead of throwing.
 * @param {object} paths `buildPaths()` result
 * @returns {Promise<object>}
 */
export async function readMetrics(paths) {
  const file = metricsFileOf(paths);
  if (file === '') return emptyMetrics();
  try {
    const text = await fs.readFile(file, 'utf8');
    return normalizeMetrics(JSON.parse(text));
  } catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) warn('read metrics', error);
    return emptyMetrics();
  }
}

/** Per-metrics-file in-process serialization queue. */
const queues = new Map();

/**
 * Run one task after every earlier task for the same file settled.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function serialized(key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

/** Sleep helper. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the cross-process lock. Returns false when another process keeps it
 * past the wait budget; a stale lock (crashed writer) is reclaimed.
 * @param {string} lockFile
 * @returns {Promise<boolean>}
 */
async function acquireLock(lockFile) {
  if (lockFile === '') return false;
  const started = Date.now();
  for (;;) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      try {
        const info = await fs.stat(lockFile);
        if (Date.now() - info.mtimeMs > LOCK_TTL_MS) {
          await fs.unlink(lockFile).catch(() => {});
          continue;
        }
      } catch {
        continue; // the lock vanished between open and stat: retry now
      }
      if (Date.now() - started >= LOCK_MAX_WAIT_MS) return false;
      await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * 10));
    }
  }
}

/** Best-effort lock release. */
async function releaseLock(lockFile) {
  if (lockFile === '') return;
  try {
    await fs.unlink(lockFile);
  } catch {
    /* an already-released lock is fine */
  }
}

/** Atomically persist one metrics document (temp file + rename). */
async function writeMetricsAtomic(file, metrics) {
  const dir = path.dirname(file);
  // Never resurrect a project directory that was deleted between the read and
  // the write (for example a test tearing its temp project down while a tracked
  // metrics write is still in flight). The store creates the directory before
  // any metrics write, so a missing directory means the project is gone.
  const info = await fs.stat(dir);
  if (!info.isDirectory()) {
    const error = new Error('the metrics directory is not a directory');
    error.code = 'ENOTDIR';
    throw error;
  }
  // The temporary file lives in the OS temp directory, not beside the target:
  // if the project directory is being removed concurrently, rename fails with
  // ENOENT and never leaves a stray file inside the project tree.
  const temporary = path.join(os.tmpdir(), `cc-memory-metrics-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(metrics, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.rename(temporary, file);
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
      // Cross-device project root: fall back to a direct atomic-enough write.
      await fs.writeFile(file, `${JSON.stringify(metrics, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch {
      /* the temporary file may never have been created */
    }
    throw error;
  }
}

/**
 * Read-merge-write one mutation under the in-process queue and the file lock.
 * Never rejects; a failed write only warns and returns the last read shape.
 * @param {object} paths
 * @param {(metrics: object) => object} change
 * @returns {Promise<object>} the persisted metrics (or empty on failure)
 */
function mutate(paths, change) {
  const file = metricsFileOf(paths);
  if (file === '') return Promise.resolve(emptyMetrics());
  return serialized(file, async () => {
    const lockFile = metricsLockFileOf(paths, file);
    let locked = false;
    try {
      locked = await acquireLock(lockFile);
    } catch (error) {
      warn('metrics lock', error);
    }
    if (!locked && lockFile !== '') {
      // A contended lock degrades to a best-effort unlocked write; losing one
      // counter is better than failing the memory operation that produced it.
      warn('metrics lock', new Error('lock busy; recording metrics without it'));
    }
    try {
      const current = await readMetrics(paths);
      const next = change(current);
      next.version = METRICS_VERSION;
      next.updatedAt = Date.now();
      if (!next.since || next.since <= 0) next.since = next.updatedAt;
      pruneDaily(next);
      await writeMetricsAtomic(file, next);
      return next;
    } catch (error) {
      // A vanished project directory is a teardown race, not a metrics failure.
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') warn('record metrics', error);
      return emptyMetrics();
    } finally {
      if (locked) await releaseLock(lockFile);
    }
  });
}

/** Get (or create and return) the daily bucket for one date. */
function ensureDay(metrics, at = Date.now()) {
  if (!metrics.daily || typeof metrics.daily !== 'object') metrics.daily = {};
  const date = dayKey(at);
  const existing = metrics.daily[date];
  if (existing && typeof existing === 'object') {
    const normalized = normalizeDay(existing);
    metrics.daily[date] = normalized;
    return normalized;
  }
  const created = emptyDay();
  metrics.daily[date] = created;
  return created;
}

/** Keep the newest 60 daily buckets. */
function pruneDaily(metrics) {
  if (!metrics.daily || typeof metrics.daily !== 'object') {
    metrics.daily = {};
    return;
  }
  const keys = Object.keys(metrics.daily).sort();
  if (keys.length <= DAILY_RETENTION_DAYS) return;
  for (const key of keys.slice(0, keys.length - DAILY_RETENTION_DAYS)) delete metrics.daily[key];
}

/** Get (or create and return) the dream quality counters. */
function ensureQuality(metrics) {
  if (!metrics.dreams || typeof metrics.dreams !== 'object') metrics.dreams = emptyMetrics().dreams;
  const dreams = metrics.dreams;
  if (!dreams.quality || typeof dreams.quality !== 'object') dreams.quality = {};
  for (const field of QUALITY_FIELDS) dreams.quality[field] = nonNegativeInt(dreams.quality[field], 0);
  return dreams.quality;
}

/** Get or create the per-file counter row. */
function entryOf(metrics, file) {
  if (!metrics.entries || typeof metrics.entries !== 'object') metrics.entries = {};
  const existing = metrics.entries[file];
  if (existing && typeof existing === 'object') {
    existing.reads = nonNegativeInt(existing.reads, 0);
    existing.writes = nonNegativeInt(existing.writes, 0);
    existing.lastReadAt = nonNegativeInt(existing.lastReadAt, 0);
    existing.lastWriteAt = nonNegativeInt(existing.lastWriteAt, 0);
    return existing;
  }
  const created = { reads: 0, writes: 0, lastReadAt: 0, lastWriteAt: 0 };
  metrics.entries[file] = created;
  return created;
}

/** Count one non-empty prompt injection. */
export async function recordInjection(paths) {
  return mutate(paths, (metrics) => {
    metrics.injections.count += 1;
    metrics.injections.lastAt = Date.now();
    ensureDay(metrics, metrics.injections.lastAt).injections += 1;
    return metrics;
  });
}

/** Count one automatic recall and the memories it attached. */
export async function recordRecall(paths, fileCount) {
  return mutate(paths, (metrics) => {
    const recalls = metrics.recalls ?? { count: 0, files: 0, lastAt: 0 };
    recalls.count += 1;
    recalls.files += Math.max(0, Number(fileCount) || 0);
    recalls.lastAt = Date.now();
    metrics.recalls = recalls;
    return metrics;
  });
}

/** Count one read of one memory file. */
export async function recordRead(paths, file) {
  if (typeof file !== 'string' || file === '') return readMetrics(paths);
  return mutate(paths, (metrics) => {
    const now = Date.now();
    const entry = entryOf(metrics, file);
    entry.reads += 1;
    entry.lastReadAt = now;
    ensureDay(metrics, now).reads += 1;
    return metrics;
  });
}

/** Count one write of one memory file. */
export async function recordWrite(paths, file) {
  if (typeof file !== 'string' || file === '') return readMetrics(paths);
  return mutate(paths, (metrics) => {
    const now = Date.now();
    const entry = entryOf(metrics, file);
    entry.writes += 1;
    entry.lastWriteAt = now;
    ensureDay(metrics, now).writes += 1;
    return metrics;
  });
}

/**
 * Record one adoption: the first read of a file inside one session. Repeated
 * reads of the same file in the same session do not count again.
 * @param {object} paths
 * @param {string} file memory file name
 * @param {string} [sessionId]
 * @returns {Promise<object>}
 */
export async function recordAdoption(paths, file, sessionId) {
  if (typeof file !== 'string' || file === '') return readMetrics(paths);
  const sessionKey = typeof sessionId === 'string' && sessionId !== '' ? sessionId.slice(0, 200) : '';
  return mutate(paths, (metrics) => {
    if (!metrics.adoptions || typeof metrics.adoptions !== 'object') {
      metrics.adoptions = { count: 0, lastAt: 0, sessions: {} };
    }
    const adoptions = metrics.adoptions;
    if (!adoptions.sessions || typeof adoptions.sessions !== 'object') adoptions.sessions = {};
    const files = Array.isArray(adoptions.sessions[sessionKey]) ? adoptions.sessions[sessionKey] : [];
    if (files.includes(file)) return metrics;
    files.push(file);
    adoptions.sessions[sessionKey] = files.slice(-ADOPTION_FILES_PER_SESSION);
    const sessionIds = Object.keys(adoptions.sessions);
    if (sessionIds.length > ADOPTION_SESSION_LIMIT) {
      for (const key of sessionIds.slice(0, sessionIds.length - ADOPTION_SESSION_LIMIT)) {
        delete adoptions.sessions[key];
      }
    }
    const now = Date.now();
    adoptions.count = nonNegativeInt(adoptions.count, 0) + 1;
    adoptions.lastAt = now;
    ensureDay(metrics, now).adopted += 1;
    return metrics;
  });
}

/** Count one search and the number of hits it returned. */
export async function recordSearch(paths, hits = 0) {
  const count = nonNegativeInt(hits, 0);
  return mutate(paths, (metrics) => {
    const now = Date.now();
    metrics.searches.count += 1;
    metrics.searches.hits += count;
    ensureDay(metrics, now).searches += 1;
    return metrics;
  });
}

/**
 * Record one dream lifecycle event.
 *
 * `proposed` only increments the proposal counter. `applied`, `rejected` and
 * `failed` increment their counter and refresh the cost block when cost fields
 * are supplied; `applied` also accumulates `dreams.appliedOps` when `ops` is a
 * number. The optional quality fields accumulate plan/applied operation counts,
 * dropped operations and rollbacks. This function never touches state or the
 * changelog.
 *
 * @param {object} paths
 * @param {{event:'proposed'|'applied'|'rejected'|'failed', ops?:number,
 *   planOps?:number, dropped?:number|string[], rollback?:boolean,
 *   durationMs?:number, inputChars?:number, outputChars?:number, usage?:object|null}} [event]
 * @returns {Promise<object>}
 */
export async function recordDream(paths, event = {}) {
  const type = String(event?.event ?? '');
  if (!['proposed', 'applied', 'rejected', 'failed'].includes(type)) return readMetrics(paths);
  return mutate(paths, (metrics) => {
    const now = Date.now();
    metrics.dreams[type] = nonNegativeInt(metrics.dreams[type], 0) + 1;
    const planOps = Number.isFinite(Number(event.planOps)) ? nonNegativeInt(event.planOps, 0) : 0;
    const dropped = Array.isArray(event.dropped)
      ? event.dropped.length
      : Number.isFinite(Number(event.dropped))
        ? nonNegativeInt(event.dropped, 0)
        : 0;
    const rollback = event.rollback === true;
    const quality = ensureQuality(metrics);
    quality.planOps += planOps;
    quality.dropped += dropped;
    if (rollback) quality.rollbacks += 1;
    if (type === 'applied' && Number.isFinite(Number(event.ops))) {
      metrics.dreams.appliedOps = nonNegativeInt(metrics.dreams.appliedOps, 0) + nonNegativeInt(event.ops, 0);
      quality.appliedOps += nonNegativeInt(event.ops, 0);
    }
    if (type !== 'proposed') {
      if (Number.isFinite(Number(event.durationMs))) {
        metrics.costs.lastDurationMs = nonNegativeInt(event.durationMs, 0);
      }
      if (Number.isFinite(Number(event.inputChars))) {
        metrics.costs.lastInputChars = nonNegativeInt(event.inputChars, 0);
      }
      if (Number.isFinite(Number(event.outputChars))) {
        metrics.costs.lastOutputChars = nonNegativeInt(event.outputChars, 0);
      }
      if ('usage' in event) metrics.costs.lastUsage = normalizeUsage(event.usage);
    }
    ensureDay(metrics, now).dreams[type] += 1;
    return metrics;
  });
}

/**
 * Human/UI summary of one metrics document.
 * @param {unknown} metrics parsed or normalized metrics
 * @param {{files?:string[], topLimit?:number, neverReadLimit?:number}} [options]
 *   `files` is the current on-disk memory file list used for `neverRead`.
 * @returns {object}
 */
export function metricsSummary(metrics, options = {}) {
  const normalized = normalizeMetrics(metrics);
  const topLimit = nonNegativeInt(options.topLimit, TOP_READ_LIMIT) || TOP_READ_LIMIT;
  const neverReadLimit = nonNegativeInt(options.neverReadLimit, NEVER_READ_LIMIT) || NEVER_READ_LIMIT;
  const rows = Object.entries(normalized.entries).map(([file, value]) => ({
    file,
    reads: value.reads,
    writes: value.writes,
    lastReadAt: value.lastReadAt,
    lastWriteAt: value.lastWriteAt,
  }));
  const readTotal = rows.reduce((total, row) => total + row.reads, 0);
  const writeTotal = rows.reduce((total, row) => total + row.writes, 0);
  const top = rows
    .filter((row) => row.reads > 0)
    .sort((left, right) => right.reads - left.reads || left.file.localeCompare(right.file))
    .slice(0, topLimit)
    .map((row) => ({ file: row.file, reads: row.reads }));
  const candidates =
    Array.isArray(options.files) && options.files.length >= 0
      ? options.files.filter((file) => typeof file === 'string' && file !== '')
      : rows.map((row) => row.file);
  const neverRead = candidates
    .filter((file) => (normalized.entries[file]?.reads ?? 0) === 0)
    .sort()
    .slice(0, neverReadLimit);
  const decided = normalized.dreams.applied + normalized.dreams.rejected;
  const qualitySource =
    normalized.dreams.quality && typeof normalized.dreams.quality === 'object'
      ? normalized.dreams.quality
      : { appliedOps: normalized.dreams.appliedOps ?? 0, planOps: 0, dropped: 0, rollbacks: 0 };
  const appliedOps = nonNegativeInt(qualitySource.appliedOps, 0);
  const planOps = nonNegativeInt(qualitySource.planOps, 0);
  const droppedOps = nonNegativeInt(qualitySource.dropped, 0);
  const rate = (numerator, denominator) =>
    denominator <= 0 ? 0 : Math.round(Math.min(1, numerator / denominator) * 1000) / 1000;
  return {
    since: normalized.since,
    updatedAt: normalized.updatedAt,
    injections: { count: normalized.injections.count, lastAt: normalized.injections.lastAt },
    reads: { total: readTotal, top, neverRead },
    writes: { total: writeTotal },
    searches: { count: normalized.searches.count, hits: normalized.searches.hits },
    recalls: {
      count: normalized.recalls?.count ?? 0,
      files: normalized.recalls?.files ?? 0,
      lastAt: normalized.recalls?.lastAt ?? 0,
    },
    adoptions: { count: normalized.adoptions.count, lastAt: normalized.adoptions.lastAt },
    dreams: {
      proposed: normalized.dreams.proposed,
      applied: normalized.dreams.applied,
      rejected: normalized.dreams.rejected,
      failed: normalized.dreams.failed,
      acceptanceRate: decided === 0 ? 0 : Math.round((normalized.dreams.applied / decided) * 1000) / 1000,
      appliedOps,
      quality: {
        appliedOps,
        planOps,
        dropped: droppedOps,
        rollbacks: nonNegativeInt(qualitySource.rollbacks, 0),
        applyRate: rate(appliedOps, planOps || appliedOps),
        dropRate: rate(droppedOps, planOps || droppedOps),
      },
    },
    costs: {
      lastDurationMs: normalized.costs.lastDurationMs,
      lastInputChars: normalized.costs.lastInputChars,
      lastOutputChars: normalized.costs.lastOutputChars,
      lastUsage: normalized.costs.lastUsage,
    },
  };
}

/**
 * Daily trend for the last `days` days (oldest first, missing days zero-filled).
 * @param {unknown} metrics
 * @param {{days?:number, now?:number}} [options]
 * @returns {Array<{date:string,injections:number,reads:number,writes:number,
 *   searches:number,adopted:number,dreams:{proposed:number,applied:number,
 *   rejected:number,failed:number}}>}
 */
export function metricsTrend(metrics, options = {}) {
  const normalized = normalizeMetrics(metrics);
  const daysValue = Number(options.days);
  const days = Number.isFinite(daysValue) && daysValue > 0 ? Math.min(DAILY_RETENTION_DAYS, Math.trunc(daysValue)) : 7;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const trend = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = dayKey(now - offset * DAY_MS);
    const bucket = normalized.daily[date] ?? emptyDay();
    trend.push({
      date,
      injections: bucket.injections,
      reads: bucket.reads,
      writes: bucket.writes,
      searches: bucket.searches,
      adopted: bucket.adopted,
      dreams: { ...bucket.dreams },
    });
  }
  return trend;
}
