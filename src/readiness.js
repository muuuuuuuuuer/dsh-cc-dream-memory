/**
 * Dream readiness, memory health and stale-proposal expiry for dsh-cc-dream-memory v9.
 *
 * This module is the single source of truth for "why is the dream not running?"
 * (`dreamReadiness`), "how healthy is this memory space?" (`memoryHealth`) and
 * "is a dream result waiting for the human?" (`pendingSwitch`). The status
 * service and the Web UI call these directly, so they must never throw and the
 * shapes must stay stable.
 *
 * `dreamReadiness` and `memoryHealth` are synchronous (cheap local file reads)
 * so they are safe to call on every status render and work with or without
 * `await`. Dream results wait for the human: nothing expires them.
 * durable state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive } from './lock.js';
import { resolveIdentity } from './identity.js';

const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MIN_SESSIONS = 5;
const DEFAULT_THROTTLE_MS = 600_000;
const DEFAULT_LOCK_TTL_MS = 3_600_000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
/** A dream older than this (and older than 3 * minHours) is "overdue". */
const DREAM_OVERDUE_MS = 7 * 24 * 60 * 60 * 1000;
/** Never-read ratio above this is a health suggestion. */
const MANY_NEVER_READ_RATIO = 0.5;

function warn(scope, error) {
  try {
    // eslint-disable-next-line no-console
    console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
  } catch {
    /* logging must never break a status render */
  }
}

function positiveNumber(value, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function toTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function safeSnapshot(state) {
  try {
    const snapshot = state?.snapshot();
    return snapshot && typeof snapshot === 'object' ? snapshot : {};
  } catch {
    return {};
  }
}

function configOf(pctx, options) {
  if (options && options.config && typeof options.config === 'object') return options.config;
  if (pctx && pctx.config && typeof pctx.config === 'object') return pctx.config;
  return {};
}

function pathsOf(pctx) {
  return pctx && typeof pctx === 'object' && pctx.paths && typeof pctx.paths === 'object' ? pctx.paths : {};
}

/** Exponential backoff for consecutive dream failures, capped at 6 hours. */
function failureBackoffMs(config, failures) {
  const base = Math.max(60_000, Number(config?.scanThrottleMs) || DEFAULT_THROTTLE_MS);
  return Math.min(base * 2 ** Math.min(failures, 6), BACKOFF_CAP_MS);
}

function distinctSessionCount(snapshot) {
  const sessions = Array.isArray(snapshot.sessionsSince) ? snapshot.sessionsSince : [];
  const ids = new Set();
  for (const entry of sessions) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return ids.size;
}

/** One lock file's age, without throwing when it is missing. */
function lockInfo(paths, config, now) {
  const ttlMs = positiveNumber(config?.lockTtlMs, DEFAULT_LOCK_TTL_MS);
  const file = typeof paths?.lockFile === 'string' ? paths.lockFile : '';
  if (file === '') return { held: false, ageMs: 0, stale: false, mtimeMs: 0, ttlMs };
  try {
    const stat = fs.statSync(file);
    const ageMs = Math.max(0, now - stat.mtimeMs);
    let pid;
    try {
      pid = JSON.parse(fs.readFileSync(file, 'utf8'))?.pid;
    } catch {
      // A just-created lock can be empty until its owner writes metadata.
    }
    const stale = ageMs >= ttlMs && !isProcessAlive(pid);
    return { held: !stale, ageMs, stale, mtimeMs: stat.mtimeMs, ttlMs };
  } catch (error) {
    if (error && error.code !== 'ENOENT') warn('lock stat', error);
    return { held: false, ageMs: 0, stale: false, mtimeMs: 0, ttlMs };
  }
}

/**
 * Why is (or isn't) an automatic dream eligible right now?
 *
 * @param {object} pctx project context (`{workspaceDir, paths, store, state, identity?}`).
 * @param {{config?:object, now?:number, checkLock?:boolean}} [options]
 * @returns {{
 *   eligible:boolean,
 *   nextEligibleAt:number|null,
 *   reasons:Array<{code:string, message:string}>,
 *   gates:{
 *     auto:boolean,
 *     minHours:{ok:boolean, remainingMs:number},
 *     minSessions:{ok:boolean, current:number, required:number},
 *     throttleMs:number,
 *     pendingSwitch:object|false,
 *     lock:false|{held:true, ageMs:number, stale:boolean},
 *   },
 * }}
 */
export function dreamReadiness(pctx, options = {}) {
  const config = configOf(pctx, options);
  const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
  const snapshot = safeSnapshot(pctx?.state);
  const paths = pathsOf(pctx);

  const minHours = positiveNumber(config.minHours, DEFAULT_MIN_HOURS);
  const minSessions = Math.max(1, Math.trunc(positiveNumber(config.minSessions, DEFAULT_MIN_SESSIONS)));
  const throttleWindowMs = positiveNumber(config.scanThrottleMs, DEFAULT_THROTTLE_MS);

  const lastDreamAt = toTimestamp(snapshot.lastDreamAt);
  const lastScanAt = toTimestamp(snapshot.lastScanAt);
  const lastAttemptAt = toTimestamp(snapshot.lastDreamAttemptAt);
  const failures = Math.max(0, Math.trunc(positiveNumber(snapshot.consecutiveFailures, 0)));
  // One pending copy at a time: the human switches to it or discards it. It
  // never expires on its own, because discarding it is their decision.
  const pendingSwitch = snapshot.shadowPending && typeof snapshot.shadowPending === 'object'
    && typeof snapshot.shadowPending.dir === 'string' && snapshot.shadowPending.dir !== ''
    ? snapshot.shadowPending
    : false;
  const lock = options.checkLock === false ? { held: false } : lockInfo(paths, config, now);

  const minHoursRemaining = lastDreamAt > 0
    ? Math.max(0, lastDreamAt + minHours * 60 * 60 * 1000 - now)
    : 0;
  const sessionCount = distinctSessionCount(snapshot);
  const throttleRemaining = lastScanAt > 0
    ? Math.max(0, lastScanAt + throttleWindowMs - now)
    : 0;
  const backoffMs = failures > 0 && lastAttemptAt > 0
    ? Math.max(0, lastAttemptAt + failureBackoffMs(config, failures) - now)
    : 0;

  const auto = config.enabled !== false
    && config.autoMemoryEnabled !== false
    && config.autoDreamEnabled === true;
  const gates = {
    auto,
    minHours: { ok: minHoursRemaining === 0, remainingMs: minHoursRemaining },
    minSessions: {
      ok: sessionCount >= minSessions,
      current: sessionCount,
      required: minSessions,
    },
    throttleMs: throttleRemaining,
    pendingSwitch,
    lock: lock.held
      ? { held: true, ageMs: Math.round(lock.ageMs), stale: lock.stale }
      : false,
  };

  const reasons = [];
  const timeTargets = [];
  if (config.enabled === false) {
    reasons.push({ code: 'disabled', message: 'the plugin is disabled (enabled: false)' });
  } else if (!auto) {
    reasons.push({ code: 'auto-dream-off', message: 'auto dream is off (enable it in /memory or the plugin config)' });
  } else {
    if (!gates.minHours.ok) {
      timeTargets.push(lastDreamAt + minHours * 60 * 60 * 1000);
      reasons.push({
        code: 'min-hours',
        message: `waiting for the minimum interval between dreams (${(minHoursRemaining / 3_600_000).toFixed(1)}h left)`,
      });
    }
    if (!gates.minSessions.ok) {
      reasons.push({
        code: 'min-sessions',
        message: `only ${sessionCount} of ${minSessions} sessions since the last dream`,
      });
    }
    if (throttleRemaining > 0) {
      timeTargets.push(lastScanAt + throttleWindowMs);
      reasons.push({
        code: 'throttle',
        message: `scan throttle is active (${Math.ceil(throttleRemaining / 1000)}s left)`,
      });
    }
    if (backoffMs > 0) {
      timeTargets.push(lastAttemptAt + failureBackoffMs(config, failures));
      reasons.push({
        code: 'backoff',
        message: `backing off after ${failures} consecutive failure(s) (${Math.ceil(backoffMs / 1000)}s left)`,
      });
    }
    if (pendingSwitch !== false) {
      reasons.push({
        code: 'pending-switch',
        message: 'a dream result is waiting for the human to switch to it or discard it',
      });
    }
    if (lock.held) {
      timeTargets.push(lock.mtimeMs + lock.ttlMs);
      reasons.push({
        code: 'lock',
        message: `another dream holds the consolidation lock (${Math.ceil(lock.ageMs / 1000)}s old)`,
      });
    }
  }

  const eligible = reasons.length === 0;
  let nextEligibleAt = null;
  if (!eligible && timeTargets.length > 0) {
    const target = Math.max(...timeTargets);
    if (Number.isFinite(target) && target > now) nextEligibleAt = Math.round(target);
  }

  return { eligible, nextEligibleAt, reasons, gates };
}

// ---------------------------------------------------------------------------
// Memory health
// ---------------------------------------------------------------------------

function summarizeIndex(paths, config) {
  const maxLines = Math.max(1, Math.trunc(positiveNumber(config.indexMaxLines, 100)));
  const maxBytes = Math.max(1, Math.trunc(positiveNumber(config.indexMaxBytes, 8 * 1024)));
  const file = typeof paths.indexFile === 'string' ? paths.indexFile : '';
  let text = '';
  if (file !== '') {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code !== 'ENOENT') warn('index read', error);
    }
  }
  const lines = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
  const bytes = Buffer.byteLength(text, 'utf8');
  const ratio = Math.max(lines / maxLines, bytes / maxBytes);
  const overflow = lines > maxLines || bytes > maxBytes;
  return {
    ok: !overflow,
    lines,
    bytes,
    maxLines,
    maxBytes,
    overflow,
    ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : 0,
  };
}

function listTopicFiles(paths) {
  const dir = typeof paths.memoryDir === 'string' ? paths.memoryDir : '';
  if (dir === '') return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith('.md') && name !== 'MEMORY.md' && !name.startsWith('.'));
  } catch (error) {
    if (error && error.code !== 'ENOENT') warn('memory list', error);
    return [];
  }
}

function readMetricsSync(paths) {
  const file = typeof paths?.metricsFile === 'string' ? paths.metricsFile : '';
  if (file === '') return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    if (error && error.code !== 'ENOENT') warn('metrics read', error);
    return null;
  }
}

function readTextLength(file) {
  if (typeof file !== 'string' || file === '') return null;
  try {
    return fs.readFileSync(file, 'utf8').length;
  } catch (error) {
    if (error && error.code !== 'ENOENT') warn('rules read', error);
    return null;
  }
}

function identityOf(pctx, config, paths) {
  const provided = pctx && typeof pctx === 'object' ? pctx.identity : undefined;
  if (provided && typeof provided === 'object' && typeof provided.source === 'string') return provided;
  try {
    return resolveIdentity({
      workspaceDir: pctx?.workspaceDir,
      config,
      projectRoot: paths.projectRoot,
    });
  } catch (error) {
    warn('identity resolve', error);
    return { source: 'workspace', projectId: '', projectRoot: paths.projectRoot || '' };
  }
}

/**
 * Health score (0..100) + per-dimension detail + actionable suggestions.
 *
 * Synchronous by design: the status page and `memory_status` call it on demand
 * and only local files are inspected.
 *
 * @param {object} pctx project context.
 * @param {{config?:object, now?:number, checkLock?:boolean}} [options]
 * @returns {{
 *   score:number,
 *   dimensions:{
 *     indexBudget:object, neverReadRatio:number, dreamStaleness:object,
 *     pendingSwitch:object, truncatedFiles:object, rules:object, identity:object,
 *   },
 *   suggestions:Array<{code:string, message:string}>,
 * }}
 */
export function memoryHealth(pctx, options = {}) {
  const config = configOf(pctx, options);
  const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
  const snapshot = safeSnapshot(pctx?.state);
  const paths = pathsOf(pctx);
  const suggestions = [];
  let score = 100;

  // --- index budget --------------------------------------------------------
  const indexBudget = summarizeIndex(paths, config);
  if (indexBudget.overflow) {
    score -= 25;
    suggestions.push({
      code: 'over-budget',
      message: `MEMORY.md is over budget (${indexBudget.lines}/${indexBudget.maxLines} lines, `
        + `${indexBudget.bytes}/${indexBudget.maxBytes} bytes); run a dream to consolidate it`,
    });
  }

  // --- never read ratio ----------------------------------------------------
  const files = listTopicFiles(paths);
  const metrics = readMetricsSync(paths);
  const entryMetrics = metrics && metrics.entries && typeof metrics.entries === 'object' ? metrics.entries : {};
  let neverRead = 0;
  for (const file of files) {
    const entry = entryMetrics[file];
    if (!entry || !(Number(entry.reads) > 0)) neverRead += 1;
  }
  const total = files.length;
  const neverReadRatio = total > 0 ? Math.round((neverRead / total) * 100) / 100 : 0;
  if (total > 0 && neverReadRatio >= MANY_NEVER_READ_RATIO) {
    score -= 15;
    suggestions.push({
      code: 'many-never-read',
      message: `${neverRead}/${total} memory files were never read; prune or merge them`,
    });
  } else if (total > 0 && neverReadRatio >= 0.25) {
    score -= 8;
  }

  // --- dream staleness -----------------------------------------------------
  const minHours = positiveNumber(config.minHours, DEFAULT_MIN_HOURS);
  const overdueThresholdMs = Math.max(DREAM_OVERDUE_MS, minHours * 3 * 60 * 60 * 1000);
  const lastDreamAt = toTimestamp(snapshot.lastDreamAt);
  const hoursSince = lastDreamAt > 0 ? (now - lastDreamAt) / 3_600_000 : null;
  const dreamOverdue = lastDreamAt === 0 || (now - lastDreamAt) > overdueThresholdMs;
  const dreamStaleness = {
    lastDreamAt,
    hoursSince: hoursSince === null ? null : Math.round(hoursSince * 10) / 10,
    overdue: dreamOverdue,
    thresholdHours: Math.round(overdueThresholdMs / 3_600_000),
  };
  // v23: how long the dream has been idle is readiness, not health. It stays
  // as a reported number, but it no longer lowers the daily score or adds a
  // suggestion — `dreamReadiness` answers "why is the dream not running?".

  // --- pending copy --------------------------------------------------------
  // A finished dream leaves a copy of memory next to the live one; the human
  // switches to it or discards it. Nothing expires it for them.
  const waiting = snapshot.shadowPending && typeof snapshot.shadowPending === 'object'
    && typeof snapshot.shadowPending.dir === 'string' && snapshot.shadowPending.dir !== ''
    ? snapshot.shadowPending
    : null;
  const pendingAgeHours = waiting && Number(waiting.createdAt) > 0
    ? Math.round(((now - Number(waiting.createdAt)) / 3_600_000) * 10) / 10
    : 0;
  const pendingSwitch = {
    present: waiting !== null,
    ageHours: Math.max(0, pendingAgeHours),
    files: waiting && Array.isArray(waiting.files) ? waiting.files.length : 0,
  };

  // --- files that will be truncated in the next dream input ----------------
  const maxFileChars = Math.max(1, Math.trunc(positiveNumber(config.dreamMaxFileChars, 20_000)));
  let truncatedCount = 0;
  let truncatedBytes = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(paths.memoryDir, file));
      if (stat.size > maxFileChars) {
        truncatedCount += 1;
        truncatedBytes += stat.size;
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') warn('file stat', error);
    }
  }
  const truncatedFiles = {
    count: truncatedCount,
    bytes: truncatedBytes,
    maxFileChars,
  };
  if (truncatedCount > 0) score -= 5;

  // --- rules ---------------------------------------------------------------
  const maxRulesChars = Math.max(1, Math.trunc(positiveNumber(config.rulesMaxChars, 8000)));
  const projectChars = readTextLength(paths.projectRulesFile);
  const globalChars = readTextLength(paths.globalRulesFile);
  const rulesChars = Math.max(projectChars ?? 0, globalChars ?? 0);
  const rulesOverBudget = rulesChars > maxRulesChars;
  const rules = {
    overBudget: rulesOverBudget,
    chars: rulesChars,
    maxChars: maxRulesChars,
    source: projectChars !== null ? 'project' : (globalChars !== null ? 'global' : 'default'),
  };
  if (rulesOverBudget) {
    score -= 10;
    suggestions.push({
      code: 'rules-truncated',
      message: `memory rules are ${rulesChars} chars, above rulesMaxChars (${maxRulesChars}); the injected text is truncated`,
    });
  }

  // --- identity ------------------------------------------------------------
  const identity = identityOf(pctx, config, paths);
  const identityShared = identity.source === 'workspace';
  const identityDimension = {
    source: identity.source || 'workspace',
    projectId: typeof identity.projectId === 'string' ? identity.projectId : '',
    shared: identityShared,
  };
  if (identityShared) {
    score -= 10;
    suggestions.push({
      code: 'non-git-sharing',
      message: 'workspace is not a git repository and has no memory marker; '
        + 'sessions in sibling directories share this memory (add .cc-memory.json {"projectId":"..."} to split)',
    });
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: clamped,
    dimensions: {
      indexBudget,
      neverReadRatio,
      dreamStaleness,
      pendingSwitch,
      truncatedFiles,
      rules,
      identity: identityDimension,
    },
    suggestions,
  };
}
