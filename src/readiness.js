/**
 * Dream readiness, memory health and stale-proposal expiry for dsh-cc-dream-memory v9.
 *
 * This module is the single source of truth for "why is the dream not running?"
 * (`dreamReadiness`), "how healthy is this memory space?" (`memoryHealth`) and
 * "is a review proposal too old to keep?" (`expireStaleProposal`). The status
 * service and the Web UI call these directly, so they must never throw and the
 * shapes must stay stable.
 *
 * `dreamReadiness` and `memoryHealth` are synchronous (cheap local file reads)
 * so they are safe to call on every status render and work with or without
 * `await`. `expireStaleProposal` is async because it moves files and clears the
 * durable state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveIdentity } from './identity.js';

const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MIN_SESSIONS = 5;
const DEFAULT_THROTTLE_MS = 600_000;
const DEFAULT_LOCK_TTL_MS = 3_600_000;
const DEFAULT_PROPOSAL_TTL_HOURS = 72;
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
    const snapshot = typeof state?.snapshot === 'function' ? state.snapshot() : undefined;
    return snapshot && typeof snapshot === 'object' ? snapshot : {};
  } catch {
    return {};
  }
}

async function callState(state, method, ...args) {
  const fn = state?.[method];
  if (typeof fn !== 'function') return undefined;
  try {
    return await fn.apply(state, args);
  } catch (error) {
    warn(`state.${method}`, error);
    return undefined;
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

/** Current lock file owner, if any (sync stat; never throws). */
function lockInfo(paths, config, now) {
  const ttlMs = positiveNumber(config?.lockTtlMs, DEFAULT_LOCK_TTL_MS);
  const file = typeof paths?.lockFile === 'string' ? paths.lockFile : '';
  if (file === '') return { held: false, ageMs: 0, stale: false, mtimeMs: 0, ttlMs };
  try {
    const stat = fs.statSync(file);
    const ageMs = Math.max(0, now - stat.mtimeMs);
    return { held: ageMs < ttlMs, ageMs, stale: ageMs >= ttlMs, mtimeMs: stat.mtimeMs, ttlMs };
  } catch (error) {
    if (error && error.code !== 'ENOENT') warn('lock stat', error);
    return { held: false, ageMs: 0, stale: false, mtimeMs: 0, ttlMs };
  }
}

function proposalInfo(pendingPath) {
  if (typeof pendingPath !== 'string' || pendingPath === '') {
    return { present: false, path: '', ageMs: 0, missing: false, mtimeMs: 0 };
  }
  try {
    const stat = fs.statSync(pendingPath);
    return { present: true, path: pendingPath, ageMs: Math.max(0, Date.now() - stat.mtimeMs), missing: false, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error && error.code !== 'ENOENT') warn('proposal stat', error);
    return { present: true, path: pendingPath, ageMs: 0, missing: true, mtimeMs: 0 };
  }
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

/**
 * Why is (or isn't) an automatic dream eligible right now?
 *
 * @param {object} pctx project context (`{workspaceDir, paths, store, state, identity?}`).
 * @param {{config?:object, now?:number}} [options]
 * @returns {{
 *   eligible:boolean,
 *   nextEligibleAt:number|null,
 *   reasons:Array<{code:string, message:string}>,
 *   gates:{
 *     auto:boolean,
 *     minHours:{ok:boolean, remainingMs:number},
 *     minSessions:{ok:boolean, current:number, required:number},
 *     throttleMs:number,
 *     pendingProposal:string|false,
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
  const pendingTtlMs = positiveNumber(config.pendingProposalTtlHours, DEFAULT_PROPOSAL_TTL_HOURS) * 60 * 60 * 1000;

  const lastDreamAt = toTimestamp(snapshot.lastDreamAt);
  const lastScanAt = toTimestamp(snapshot.lastScanAt);
  const lastAttemptAt = toTimestamp(snapshot.lastDreamAttemptAt);
  const failures = Math.max(0, Math.trunc(positiveNumber(snapshot.consecutiveFailures, 0)));
  const pendingProposal = typeof snapshot.pendingProposal === 'string' && snapshot.pendingProposal !== ''
    ? snapshot.pendingProposal
    : false;
  const proposal = proposalInfo(pendingProposal);
  const lock = lockInfo(paths, config, now);

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
    pendingProposal,
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
    if (pendingProposal !== false) {
      if (proposal.missing) {
        reasons.push({ code: 'pending-proposal', message: 'a review proposal is recorded but its file is missing' });
      } else {
        if (proposal.mtimeMs > 0) timeTargets.push(proposal.mtimeMs + pendingTtlMs);
        const ageHours = (proposal.ageMs / 3_600_000).toFixed(1);
        reasons.push({
          code: 'pending-proposal',
          message: `a review proposal is waiting for a human decision (${ageHours}h old); the scheduler expires it after ${Math.round(pendingTtlMs / 3_600_000)}h`,
        });
      }
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
 * @param {{config?:object, now?:number}} [options]
 * @returns {{
 *   score:number,
 *   dimensions:{
 *     indexBudget:object, neverReadRatio:number, dreamStaleness:object,
 *     pendingProposal:object, truncatedFiles:object, rules:object, identity:object,
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
  if (dreamOverdue) {
    score -= 20;
    suggestions.push({
      code: 'dream-overdue',
      message: lastDreamAt === 0
        ? 'memory has never been consolidated by a dream'
        : `the last dream was ${Math.round((hoursSince ?? 0) * 10) / 10}h ago (threshold ${dreamStaleness.thresholdHours}h)`,
    });
  }

  // --- pending proposal ----------------------------------------------------
  const pendingPath = typeof snapshot.pendingProposal === 'string' ? snapshot.pendingProposal : '';
  const pendingTtlHours = positiveNumber(config.pendingProposalTtlHours, DEFAULT_PROPOSAL_TTL_HOURS);
  const proposal = proposalInfo(pendingPath);
  const pendingAgeHours = proposal.present ? Math.round((proposal.ageMs / 3_600_000) * 10) / 10 : 0;
  const pendingStale = proposal.present && !proposal.missing && pendingAgeHours > pendingTtlHours;
  const pendingProposal = {
    present: proposal.present,
    ageHours: pendingAgeHours,
    stale: pendingStale,
    ttlHours: pendingTtlHours,
  };
  if (pendingStale) {
    score -= 10;
    suggestions.push({
      code: 'pending-stale',
      message: `a review proposal has been pending for ${pendingAgeHours}h (ttl ${pendingTtlHours}h); it will be expired by the scheduler`,
    });
  }

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
      pendingProposal,
      truncatedFiles,
      rules,
      identity: identityDimension,
    },
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Stale proposal expiry
// ---------------------------------------------------------------------------

function uniqueTarget(dir, baseName) {
  const direct = path.join(dir, baseName);
  if (!fs.existsSync(direct)) return direct;
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  return path.join(dir, `${stamp}-${baseName}`);
}

function expiryChangelog({ at, proposalPath, movedTo, ageMs, ttlHours }) {
  const lines = [
    `## ${new Date(at).toISOString()}`,
    `- pending-proposal expired: ${path.basename(proposalPath)} (age ${(ageMs / 3_600_000).toFixed(1)}h > ttl ${ttlHours}h)`,
    `- moved to: ${path.join('.pending', 'expired', path.basename(movedTo))}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** Clear the pending-pointer synchronously (expiry path; never counts as rejected). */
function clearStatePendingSync(state, silent) {
  try {
    if (state && typeof state.clearPendingProposalSync === 'function') {
      state.clearPendingProposalSync({ silent });
      return;
    }
  } catch (error) {
    warn('state.clearPendingProposalSync', error);
  }
  try {
    if (state && state.state && typeof state.state === 'object') state.state.pendingProposal = '';
  } catch {
    /* best effort: the archived proposal is what matters */
  }
}

/**
 * Move an over-age review proposal out of the way (`.pending/expired/`), clear
 * the durable pointer and append a `pending-proposal expired` changelog entry.
 *
 * Deliberately synchronous: the scheduler calls it on the turn-end path and the
 * status/UI layers want the result immediately. Expiry is not a rejection and
 * never counts towards the rejected metric.
 *
 * @param {object} pctx project context.
 * @param {{config?:object, now?:number}} [options]
 * @returns {{expired:boolean, path?:string, movedTo?:string, ageMs?:number, ttlHours?:number, reason?:string}}
 */
export function expireStaleProposal(pctx, options = {}) {
  const config = configOf(pctx, options);
  const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
  const state = pctx && typeof pctx === 'object' ? pctx.state : undefined;
  const paths = pathsOf(pctx);
  const snapshot = safeSnapshot(state);
  const pendingPath = typeof snapshot.pendingProposal === 'string' ? snapshot.pendingProposal : '';
  const ttlHours = positiveNumber(config.pendingProposalTtlHours, DEFAULT_PROPOSAL_TTL_HOURS);
  const ttlMs = ttlHours * 60 * 60 * 1000;

  if (pendingPath === '') return { expired: false, reason: 'no-pending-proposal' };

  let stat;
  try {
    stat = fs.statSync(pendingPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      // Dangling pointer (file already deleted elsewhere): just clear it.
      clearStatePendingSync(state, true);
      return { expired: false, path: pendingPath, reason: 'proposal-file-missing' };
    }
    warn('proposal stat', error);
    return { expired: false, path: pendingPath, reason: 'proposal-unreadable' };
  }

  const ageMs = Math.max(0, now - stat.mtimeMs);
  if (ageMs <= ttlMs) {
    return { expired: false, path: pendingPath, ageMs, ttlHours };
  }

  const expiredDir = typeof paths.pendingExpiredDir === 'string' && paths.pendingExpiredDir !== ''
    ? paths.pendingExpiredDir
    : path.join(paths.pendingDir || path.dirname(pendingPath), 'expired');
  let movedTo = '';
  try {
    fs.mkdirSync(expiredDir, { recursive: true });
    movedTo = uniqueTarget(expiredDir, path.basename(pendingPath));
    try {
      fs.renameSync(pendingPath, movedTo);
    } catch (renameError) {
      if (renameError && renameError.code === 'ENOENT') {
        clearStatePendingSync(state, true);
        return { expired: false, path: pendingPath, reason: 'proposal-file-missing' };
      }
      // Cross-device move or locked file: copy + unlink.
      fs.copyFileSync(pendingPath, movedTo);
      fs.unlinkSync(pendingPath);
    }
  } catch (error) {
    warn('expire pending proposal', error);
    return { expired: false, path: pendingPath, reason: 'move-failed' };
  }

  clearStatePendingSync(state, true);

  const entry = expiryChangelog({ at: now, proposalPath: pendingPath, movedTo, ageMs, ttlHours });
  try {
    if (typeof paths.changelogFile === 'string' && paths.changelogFile !== '') {
      fs.mkdirSync(path.dirname(paths.changelogFile), { recursive: true });
      fs.appendFileSync(paths.changelogFile, entry, 'utf8');
    } else if (pctx?.store && typeof pctx.store.writeChangelog === 'function') {
      const pending = pctx.store.writeChangelog(entry);
      if (pending && typeof pending.catch === 'function') pending.catch((error) => warn('expiry changelog', error));
    }
  } catch (error) {
    warn('expiry changelog', error);
  }

  return {
    expired: true,
    path: pendingPath,
    movedTo,
    ageMs,
    ttlHours,
  };
}
