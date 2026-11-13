/**
 * Deterministic dreaming for dsh-cc-dream-memory (v2).
 *
 * A dream is a consolidation pass over the project's auto-memory: the model is
 * only asked for a strict JSON plan, and this engine owns every side effect
 * (lock, validation, backup, apply, changelog, state). That keeps the pass
 * auditable and idempotent:
 *
 *   gates -> lock -> gather -> LLM -> parse -> validate -> backup ->
 *   apply | review | dry-run -> reconcile -> changelog -> state -> unlock
 *
 * Safety rules that matter beyond the happy path:
 * - a topic file whose body was truncated in the dream input can never be
 *   rewritten from that partial view (validation drops the write);
 * - every applying pass backs the memory directory up first, and any failure
 *   while writing/relinking memory restores the backup (new files go to the
 *   store trash) before the error is reported;
 * - delete operations go through `store.trashEntry` (soft delete) and only when
 *   `dreamAllowDelete` is on;
 * - after the index is written, `store.reconcileIndex()` removes orphaned
 *   index lines and re-adds missing files;
 * - a review-mode run only parks a proposal: it does not consume sessions or
 *   reset the dream cadence, and a second review run is skipped until the
 *   pending proposal is applied or rejected.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkWriteOperations } from './dream-write-evidence.js';
import { buildIndex } from './wiki-core.js';
import { recordVerification } from './verification-ledger.js';
import { currentFactLines } from './memory-body.js';
import { supportsStatement } from './support.js';
import { pageBodyHash } from './dream-merge.js';
import { buildEvidenceCorpus, checkPlanEvidence, automaticReviewReasons, bodyLineChanges, dropDestructiveDependents, normalizeForMatch } from './dream-evidence.js';

/** Topic file names accepted from the model. Mirrors the v2 memory store. */
const MEMORY_FILE_RE = /^[\p{L}\p{N}._-]+\.md$/u;
/** Files reserved for the host: the index and the dream changelog. */
const RESERVED_FILES = new Set(['MEMORY.md', '.dream-log.md']);
/** Memory types the store accepts. */
const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference']);
const MEMORY_TYPE_SET = new Set(MEMORY_TYPES);

const DEFAULT_LIMITS = Object.freeze({
  dreamMaxOps: 40,
  dreamAllowDelete: false,
  maxContentBytes: 128 * 1024,
  lockTtlMs: 60 * 60 * 1000,
  minHours: 24,
  minSessions: 5,
  llmMaxTokens: 16_384,
});

/** Hard ceiling for the one max-tokens retry (tokens, not chars). */
const MAX_RETRY_TOKENS = 32_768;
/** Files inside a dream backup directory that are bookkeeping, not memory. */
const BACKUP_BOOKKEEPING = new Set(['plan.json', 'meta.json']);

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function errorMessage(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

function positiveNumber(value, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function positiveInt(value, fallback) {
  return Math.trunc(positiveNumber(value, fallback));
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : String(value ?? ''), 'utf8');
}

/** SHA-256 of a file's raw content as `sha256:<hex>`, or `null` when missing. */
async function hashFileIfExists(filePath) {
  try {
    const content = await fs.readFile(filePath);
    return `sha256:${createHash('sha256').update(content).digest('hex')}`;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Writes whose page changed since the plan was built. `baseHash` is the hash
 * of the page body the merge read, so it is compared with the body on disk.
 */
async function staleWrites(store, operations) {
  const stale = [];
  for (const op of Array.isArray(operations) ? operations : []) {
    if (!op || op.op !== 'write' || typeof op.baseHash !== 'string' || op.baseHash === '') continue;
    const scope = op.scope === 'user' ? 'user' : 'project';
    const current = await store.readEntry(op.file, scope).catch(() => null);
    const actual = current ? pageBodyHash(current.body) : null;
    if (actual !== op.baseHash) {
      stale.push({ file: op.file, expected: op.baseHash, actual, reason: 'changed since the plan was built' });
    }
  }
  return stale;
}

/** Is this a safe top-level batch file name (no path traversal)? */
function isSafeBatchFileName(file) {
  return typeof file === 'string'
    && file !== ''
    && file !== '.'
    && file !== '..'
    && path.basename(file) === file
    && !BACKUP_BOOKKEEPING.has(file);
}

function oneLine(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, Math.max(0, max - 1)).trimEnd() : flat;
}

/** File-name slug, identical to the v2 memory store's unicode rule. */
function slugify(name) {
  const flat = typeof name === 'string' ? name.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  const slug = flat
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return slug === '' ? 'memory' : slug;
}

/** `2026-11-06T23:10:00.000Z` -> `2026-11-06T23-10-00` (colons are not portable). */
function timestampName(ms) {
  try {
    return new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-');
  } catch {
    return String(ms);
  }
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
  return await fn.apply(state, args);
}

function warn(scope, error) {
  try {
    // eslint-disable-next-line no-console
    console.warn(`[cc-memory] ${scope}:`, errorMessage(error));
  } catch {
    // Never let logging break a dream.
  }
}

// ---------------------------------------------------------------------------
// Dream cost / secret-scan helpers
// ---------------------------------------------------------------------------

/** Token usage fields recorded when `llm.stream` reports `usage` chunks. */
const USAGE_KEYS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
]);

/** Sum one usage chunk into an aggregate usage object; `null` when nothing seen. */
function mergeUsage(total, usage) {
  const source = usage && typeof usage === 'object' ? usage : null;
  if (!source) return total || null;
  const merged = total && typeof total === 'object' ? { ...total } : {};
  let seen = Boolean(total);
  for (const key of USAGE_KEYS) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value >= 0) {
      merged[key] = (Number(merged[key]) || 0) + value;
      seen = true;
    }
  }
  return seen ? merged : null;
}

/** Human-readable one-line token usage for the changelog. */
function usageLine(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const parts = [];
  for (const key of USAGE_KEYS) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value >= 0) parts.push(`${key}=${value}`);
  }
  return parts.join(', ');
}

/** Secret scan mode from config; the documented default is `warn`. */
function secretScanMode(config) {
  const mode = config && typeof config === 'object' ? config.secretScan : undefined;
  return mode === 'off' || mode === 'deny' || mode === 'warn' ? mode : 'warn';
}

/**
 * `src/secrets.js` is owned by memory-core and may not exist yet. Import it
 * lazily: a missing module (or missing `scanSecrets` export) disables the scan
 * with a single warning instead of blocking dreaming.
 */
let secretsModulePromise = null;

async function loadSecretsModule() {
  if (secretsModulePromise === null) {
    secretsModulePromise = import('./secrets.js').catch((error) => {
      warn('secret scan unavailable (src/secrets.js missing); dream writes are not scanned', error);
      return null;
    });
  }
  return secretsModulePromise;
}

/** Duration/cost fields persisted with a plan and copied into state on apply. */
function planMetrics(plan) {
  const source = plan && typeof plan === 'object' ? plan : {};
  return {
    durationMs: Math.max(0, Math.trunc(Number(source.durationMs) || 0)),
    inputChars: Math.max(0, Math.trunc(Number(source.inputChars) || 0)),
    outputChars: Math.max(0, Math.trunc(Number(source.outputChars) || 0)),
    usage: mergeUsage(null, source.usage),
  };
}

/**
 * `src/metrics.js` is owned by memory-core and may not exist yet. Metrics are
 * best-effort: a missing module (or missing `recordDream` export) emits one
 * warning and never blocks a dream.
 */
let metricsModulePromise = null;

async function loadMetricsModule() {
  if (metricsModulePromise === null) {
    metricsModulePromise = import('./metrics.js').catch((error) => {
      warn('dream metrics unavailable (src/metrics.js missing); metrics are not recorded', error);
      return null;
    });
  }
  return metricsModulePromise;
}

/**
 * Record one dream metrics event (`proposed`/`applied`/`rejected`/`failed`).
 * Await-ed so callers can rely on the counter being durable; failures never
 * propagate.
 * @param {object|undefined} paths project paths (metrics module owns the file).
 * @param {object} payload `{ event, ops?, durationMs?, inputChars?, outputChars?, usage? }`
 * @returns {Promise<boolean>} whether the event was recorded.
 */
export async function recordDreamEvent(paths, payload) {
  try {
    const module = await loadMetricsModule();
    const record = module && typeof module.recordDream === 'function' ? module.recordDream : null;
    if (!record || !paths) return false;
    await record(paths, payload);
    return true;
  } catch (error) {
    warn('record dream metrics', error);
    return false;
  }
}

/** Total tokens of one usage object (falls back to input+output). */
function totalTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const total = Number(usage.totalTokens);
  if (Number.isFinite(total) && total >= 0) return total;
  const input = Number(usage.inputTokens);
  const output = Number(usage.outputTokens);
  if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) return input + output;
  return null;
}

/**
 * Compare one usage record with `config.dreamMaxTotalTokens` (0 = off).
 * @returns {{exceeded:boolean, limit:number, totalTokens?:number, warning:string}}
 */
export function costLimitStatus(config, usage) {
  const limit = maxTotalTokensLimit(config);
  if (limit === 0) return { exceeded: false, limit: 0, warning: '' };
  const total = totalTokensOf(usage);
  if (!Number.isFinite(total) || total <= limit) return { exceeded: false, limit, warning: '' };
  return {
    exceeded: true,
    limit,
    totalTokens: total,
    warning: `cost-limit-exceeded: totalTokens ${total} > limit ${limit}`,
  };
}

/** Effective cost mode (`warn` applies anyway, `review` parks a proposal, `block` refuses). */
export function dreamCostModeOf(config) {
  const mode = config && typeof config === 'object' ? config.dreamCostMode : undefined;
  return mode === 'review' || mode === 'block' ? mode : 'warn';
}

/** Configured total-token ceiling; 0 means the limit is off. */
export function maxTotalTokensLimit(config) {
  const raw = Number(config && typeof config === 'object' ? config.dreamMaxTotalTokens : 0);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}

/** Preflight estimate used before the model call (contract: ceil(chars/4) + 1024). */
export function estimateInputTokens(inputChars) {
  return Math.ceil(Math.max(0, Number(inputChars) || 0) / 4) + 1024;
}

function normalizeConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    dreamMaxOps: positiveInt(source.dreamMaxOps, DEFAULT_LIMITS.dreamMaxOps),
    dreamAllowDelete: source.dreamAllowDelete === true,
    maxContentBytes: positiveInt(source.maxContentBytes, DEFAULT_LIMITS.maxContentBytes),
    dreamMaxFileChars: positiveInt(source.dreamMaxFileChars, 20_000),
  };
}

/** Fill in path fields for contexts built by a different/older runtime. */
function normalizePaths(paths) {
  if (!paths || typeof paths !== 'object') return null;
  const memoryDir = typeof paths.memoryDir === 'string' ? paths.memoryDir : '';
  if (!memoryDir) return null;
  const projectDir = typeof paths.projectDir === 'string' && paths.projectDir
    ? paths.projectDir
    : path.dirname(memoryDir);
  const pick = (key, fallback) => (typeof paths[key] === 'string' && paths[key] ? paths[key] : fallback);
  return {
    memoryDir,
    projectDir,
    lockFile: pick('lockFile', path.join(projectDir, '.consolidate-lock')),
    dreamsDir: pick('dreamsDir', path.join(projectDir, '.dreams')),
    pendingDir: pick('pendingDir', path.join(projectDir, '.pending')),
    trashRoot: pick('trashRoot', path.join(projectDir, '.trash')),
    changelogFile: pick('changelogFile', path.join(projectDir, '.dream-log.md')),
  };
}

function countOperations(operations) {
  const counts = { write: 0, delete: 0, index: 0, total: 0 };
  for (const op of operations) {
    if (!op || typeof op !== 'object') continue;
    counts.total += 1;
    if (op.op === 'write' || op.op === 'delete' || op.op === 'index') counts[op.op] += 1;
  }
  return counts;
}

function countFiles(operations) {
  const files = new Set();
  for (const op of operations) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'index') files.add(op.scope === 'user' ? 'user/MEMORY.md' : 'MEMORY.md');
    else if (typeof op.file === 'string' && op.file !== '') files.add(op.file);
  }
  return files.size;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === 'string' && item !== '' && !out.includes(item)) out.push(item);
  }
  return out;
}

/** Older v2 plans counted scheduled chunks as coverage and must be regenerated. */
export function dreamV2CoverageError(plan) {
  if (plan?.kind !== 'dream-v2') return '';
  const { sessions, reads, expectedSessions, processedSessions, failedSessions, partialSessions } = plan;
  if (plan.coverageVersion !== 1) return 'dream coverage unverified: regenerate the v2 plan';
  if (plan.coverageComplete !== true || !Array.isArray(sessions) || !Array.isArray(reads)
    || !Array.isArray(failedSessions) || failedSessions.length > 0
    || !Array.isArray(partialSessions) || partialSessions.length > 0
    || sessions.length !== expectedSessions || processedSessions !== expectedSessions
    || reads.length !== expectedSessions
    || reads.some(read => read?.complete !== true || !sessions.includes(read.id))
    || new Set(reads.map(read => read.id)).size !== expectedSessions) {
    return 'dream coverage incomplete: regenerate a complete v2 plan before applying';
  }
  return '';
}

/**
 * Replace a v2 plan's index operation with a host-built catalog from the
 * current pages plus the operations that passed the evidence gate. MEMORY.md
 * headings are therefore controlled values (memory type), never organizer text.
 */
function withControlledIndex(currentPages, operations) {
  const pages = new Map();
  for (const page of Array.isArray(currentPages) ? currentPages : []) {
    if (!page || typeof page.file !== 'string') continue;
    pages.set(page.file, {
      file: page.file,
      name: page.name || page.file.replace(/\.md$/, ''),
      description: typeof page.description === 'string' ? page.description : '',
      type: page.type || 'project',
      body: typeof page.body === 'string' ? page.body : '',
    });
  }
  for (const op of Array.isArray(operations) ? operations : []) {
    if (op?.op === 'write' && typeof op.file === 'string') {
      const previous = pages.get(op.file);
      pages.set(op.file, {
        file: op.file,
        name: op.name || previous?.name || op.file.replace(/\.md$/, ''),
        description: typeof op.description === 'string' ? op.description : (previous?.description || ''),
        type: op.type || previous?.type || 'project',
        body: typeof op.body === 'string' ? op.body : (previous?.body || ''),
      });
    } else if (op?.op === 'delete' && typeof op.file === 'string') {
      pages.delete(op.file);
    }
  }
  const content = buildIndex({
    pages: [...pages.values()].map((page) => ({ ...page, slug: page.file.replace(/\.md$/, '') })),
    style: 'memory',
    groupBy: 'type',
  });
  const kept = (Array.isArray(operations) ? operations : []).filter((op) => op?.op !== 'index');
  kept.push({ op: 'index', scope: 'project', content });
  return kept;
}

/** Number of operations a failed `executePlan` had already applied. */

function partialOperationCount(error) {
  const counts = error && error.partialCounts && typeof error.partialCounts === 'object' ? error.partialCounts : {};
  return (Number(counts.write) || 0) + (Number(counts.delete) || 0) + (Number(counts.index) || 0);
}

/**
 * Normalize a plan-operation selection for `applyPlanOperations`.
 * @returns {{ok:true, indexes:number[]}|{ok:false, error:string}}
 */
function normalizeIndexes(indexes, length) {
  if (!Array.isArray(indexes)) return { ok: false, error: 'invalid-indexes' };
  const picked = [];
  for (const raw of indexes) {
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= length) {
      return { ok: false, error: 'invalid-indexes' };
    }
    if (!picked.includes(value)) picked.push(value);
  }
  if (picked.length === 0) return { ok: false, error: 'no-operations-selected' };
  return { ok: true, indexes: picked.sort((left, right) => left - right) };
}

// ---------------------------------------------------------------------------
// Plan validation and JSON extraction (exported for tests)
// ---------------------------------------------------------------------------

/** Normalize the `existingFiles` argument into `Map<scope, Set<file>>`. */
function normalizeExistingFiles(existingFiles) {
  if (existingFiles === undefined || existingFiles === null) return null;
  const map = new Map([
    ['project', new Set()],
    ['user', new Set()],
  ]);
  const add = (scope, file) => {
    if (typeof file !== 'string' || file === '') return;
    map.get(scope === 'user' ? 'user' : 'project').add(file);
  };
  if (Array.isArray(existingFiles)) {
    for (const item of existingFiles) {
      if (typeof item === 'string') add('project', item);
      else if (item && typeof item === 'object') add(item.scope, item.file);
    }
    return map;
  }
  if (typeof existingFiles === 'object') {
    for (const [scope, list] of Object.entries(existingFiles)) {
      if (Array.isArray(list)) {
        for (const item of list) add(scope, typeof item === 'string' ? item : item?.file);
      }
    }
    return map;
  }
  return null;
}

/** `file -> frontmatter name` for project entries passed as `{file, name}` objects. */
function existingNameMap(existingFiles) {
  const names = new Map();
  const list = Array.isArray(existingFiles) ? existingFiles : existingFiles?.project;
  if (!Array.isArray(list)) return names;
  for (const item of list) {
    if (!item || typeof item.file !== 'string' || typeof item.name !== 'string') continue;
    if (item.scope === 'user') continue;
    names.set(item.file, item.name);
  }
  return names;
}

/**
 * Validate and normalize a model-proposed dream plan.
 *
 * Structural problems reject the whole plan (`ok:false`); individual bad
 * operations are dropped and reported so one hallucinated path cannot poison an
 * otherwise useful consolidation.
 *
 * `truncatedFiles` lists files whose body was only partially shown to the model;
 * writes targeting them are always dropped (a partial view must never become a
 * full rewrite, and must not be deleted either).
 *
 * `existingFiles` entries may be `{file, name}` objects; then a write without an
 * explicit `file` whose derived file belongs to a differently named memory is
 * dropped instead of overwriting it.
 *
 * @param {unknown} plan parsed JSON plan.
 * @param {{config?: object, existingFiles?: string[]|object, truncatedFiles?: string[]}} [options]
 * @returns {{ok:boolean, plan:{summary:string, operations:object[], notes:string}, dropped:string[], error?:string}}
 */
export function validateDreamPlan(plan, options = {}) {
  const cfg = normalizeConfig(options && options.config);
  const truncated = new Set(normalizeStringArray(options && options.truncatedFiles));
  const dropped = [];
  const normalized = { summary: '', operations: [], notes: '' };

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, plan: normalized, dropped, error: 'dream plan is not a JSON object' };
  }
  normalized.summary = oneLine(plan.summary, 1000);
  normalized.notes = oneLine(plan.notes, 2000);
  if (typeof plan.skill === 'string' && plan.skill.trim() !== '') normalized.skill = plan.skill.slice(0, 20_000);
  // v0.12.0: retain the v2 evidence bundle and plan kind so the final apply
  // path can re-run the evidence gate instead of trusting the dry-run process.
  if (plan.kind === 'dream-v2') {
    normalized.kind = 'dream-v2';
    for (const key of ['sessions', 'reads', 'expectedSessions', 'processedSessions', 'failedSessions', 'partialSessions']) {
      if (plan[key] !== undefined) normalized[key] = plan[key];
    }
    for (const key of ['coverageVersion', 'coverageComplete', 'evidenceRequired']) {
      if (plan[key] !== undefined) normalized[key] = plan[key];
    }
  }
  if (plan.kind === 'dream-v2' && plan.evidenceRequired !== false) normalized.evidenceRequired = true;
  if (Array.isArray(plan.evidence)) normalized.evidence = plan.evidence;

  const operations = plan.operations;
  if (!Array.isArray(operations)) {
    return { ok: false, plan: normalized, dropped, error: 'dream plan "operations" is not an array' };
  }
  if (operations.length > cfg.dreamMaxOps) {
    return {
      ok: false,
      plan: normalized,
      dropped,
      error: `dream plan has ${operations.length} operations, the limit is ${cfg.dreamMaxOps}`,
    };
  }

  const existing = normalizeExistingFiles(options && options.existingFiles);
  const existingNames = existingNameMap(options && options.existingFiles);

  for (let index = 0; index < operations.length; index += 1) {
    const label = `operation #${index + 1}`;
    const op = operations[index];
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      dropped.push(`${label}: not a JSON object`);
      continue;
    }
    const kind = op.op;
    if (kind !== 'write' && kind !== 'delete' && kind !== 'index') {
      dropped.push(`${label}: unknown op ${JSON.stringify(op.op) ?? 'undefined'}`);
      continue;
    }
    const scope = op.scope === 'user' ? 'user' : 'project';
    if (scope === 'user') {
      // A dream consolidates the per-repository memory only. The cross-project
      // user scope is not part of the dream input or output.
      dropped.push(`${label}: user scope is not supported by dreaming (project only)`);
      continue;
    }

    if (kind === 'write') {
      let type = typeof op.type === 'string' ? op.type.trim().toLowerCase() : '';
      if (type === '') type = MEMORY_TYPES[0];
      if (!MEMORY_TYPE_SET.has(type)) {
        dropped.push(`${label}: write needs a type in ${MEMORY_TYPES.join('|')}`);
        continue;
      }
      let name = oneLine(op.name, 200);
      let file = typeof op.file === 'string' ? op.file.trim() : '';
      const derived = file === '';
      if (file === '' && name !== '') file = `${type}_${slugify(name)}.md`;
      if (file === '') {
        dropped.push(`${label}: write needs a "name" or "file"`);
        continue;
      }
      if (!MEMORY_FILE_RE.test(file) || RESERVED_FILES.has(file) || file.includes('..')) {
        dropped.push(`${label}: invalid write file ${JSON.stringify(file)}`);
        continue;
      }
      if (truncated.has(file)) {
        dropped.push(`${label}: source file was truncated in the dream input; refusing to rewrite ${file}`);
        continue;
      }
      if (derived && existingNames.has(file) && existingNames.get(file) !== name) {
        // Same slug, different memory (the store keeps those apart with a hash
        // suffix): a derived name must not overwrite the other memory.
        dropped.push(
          `${label}: derived file ${file} already holds a different memory `
            + `(${JSON.stringify(existingNames.get(file))}); set "file" explicitly`,
        );
        continue;
      }
      // `deploy_command` is the same note as "Deploy command", not a rename.
      const currentName = existingNames.get(file);
      if (!derived && currentName !== undefined && slugify(currentName) === slugify(name)) name = currentName;
      const body = typeof op.body === 'string' ? op.body : (typeof op.content === 'string' ? op.content : '');
      if (byteLength(body) > cfg.maxContentBytes) {
        dropped.push(`${label}: write body is ${byteLength(body)} bytes, limit is ${cfg.maxContentBytes}`);
        continue;
      }
      if (body.length > cfg.dreamMaxFileChars) {
        dropped.push(`${label}: write body exceeds the full-read limit (dreamMaxFileChars=${cfg.dreamMaxFileChars}); split the memory before consolidation`);
        continue;
      }
      const evidence = Array.isArray(op.evidence)
        ? op.evidence.slice(0, 40).flatMap((item) => {
          if (typeof item === 'string' && item.trim()) return [item.slice(0, 300)];
          if (item && typeof item.statement === 'string' && typeof item.quote === 'string') {
            return [{ statement: item.statement.slice(0, 4000), quote: item.quote.slice(0, 300) }];
          }
          return [];
        }) : [];
      normalized.operations.push({
        op: 'write',
        scope,
        type,
        file,
        name: name !== '' ? name : file.replace(/\.md$/, ''),
        description: oneLine(op.description, 160),
        body,
        ...(evidence.length > 0 ? { evidence } : {}),
        // The hash of the page this write was built on; apply refuses the write
        // when the page changed since (a human edit must never be overwritten).
        ...(typeof op.baseHash === 'string' && /^[0-9a-f]{64}$/.test(op.baseHash) ? { baseHash: op.baseHash } : {}),
      });
      continue;
    }

    if (kind === 'delete') {
      const file = typeof op.file === 'string' ? op.file.trim() : '';
      if (!MEMORY_FILE_RE.test(file) || RESERVED_FILES.has(file) || file.includes('..')) {
        dropped.push(`${label}: invalid delete file ${JSON.stringify(file)}`);
        continue;
      }
      if (!cfg.dreamAllowDelete) {
        dropped.push(`${label}: delete is disabled (dreamAllowDelete=false)`);
        continue;
      }
      if (truncated.has(file)) {
        // Deleting a partially seen file after "absorbing" its excerpt elsewhere
        // would lose the unseen part just like a rewrite would.
        dropped.push(`${label}: source file was truncated in the dream input; refusing to delete ${file}`);
        continue;
      }
      if (existing !== null) {
        const files = existing.get(scope) ?? new Set();
        if (!files.has(file)) {
          dropped.push(`${label}: delete target does not exist: ${file}`);
          continue;
        }
      }
      normalized.operations.push({
        op: 'delete',
        scope,
        file,
        reason: oneLine(op.reason, 300),
      });
      continue;
    }

    // kind === 'index'
    const content = typeof op.content === 'string' ? op.content : (typeof op.body === 'string' ? op.body : '');
    if (content.trim() === '') {
      dropped.push(`${label}: index content is empty`);
      continue;
    }
    if (byteLength(content) > cfg.maxContentBytes) {
      dropped.push(`${label}: index content is ${byteLength(content)} bytes, limit is ${cfg.maxContentBytes}`);
      continue;
    }
    normalized.operations.push({
      op: 'index',
      scope,
      content: content.endsWith('\n') ? content : `${content}\n`,
    });
  }

  const targets = new Set();
  for (const op of normalized.operations) {
    if (op.op === 'index') continue;
    const target = `${op.scope}:${op.file.toLowerCase()}`;
    if (targets.has(target)) return { ok: false, plan: normalized, dropped, error: `multiple mutations target the same memory file: ${op.file}` };
    targets.add(target);
  }
  return { ok: true, plan: normalized, dropped };
}

/**
 * Extract the first JSON plan from a model response: the first fenced
 * ```json block, then the first `{` to the last `}`. Returns `null` when no
 * parseable JSON object is present.
 * @param {unknown} text model output.
 * @returns {object|null}
 */
export function extractJsonPlan(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (value === '') return null;
  const candidates = [];

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fence.exec(value)) !== null) {
    const body = match[1] ? match[1].trim() : '';
    if (body !== '') candidates.push(body);
  }
  const first = value.indexOf('{');
  const last = value.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(value.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/** Resolve provider/model for the dream call, or `null` when unavailable. */
function resolveModel(ctx, config) {
  let llm;
  try {
    llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
  } catch {
    llm = undefined;
  }
  if (!llm || typeof llm.stream !== 'function') return null;

  const provider = typeof config?.dreamProvider === 'string' ? config.dreamProvider.trim() : '';
  const model = typeof config?.dreamModel === 'string' ? config.dreamModel.trim() : '';
  if (provider !== '' && model !== '') return { provider, model };

  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined;
    if (
      selection
      && typeof selection.provider === 'string'
      && selection.provider !== ''
      && typeof selection.model === 'string'
      && selection.model !== ''
    ) {
      const resolved = { provider: selection.provider, model: selection.model };
      if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== null) {
        resolved.reasoningEffort = selection.reasoningEffort;
      }
      return resolved;
    }
  } catch {
    // Fall through: unavailable model routing skips the dream, it never throws.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lock handling
// ---------------------------------------------------------------------------

async function writeLockFile(lockFile) {
  const handle = await fs.open(lockFile, 'wx');
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Claim the dream lock. A fresh lock (`mtime` younger than the TTL) means
 * another pass is running; an expired lock is taken over, remembering its mtime
 * so a failed pass can give the old timestamp back.
 * @returns {Promise<{ok:true, priorMtime:number|null}|{ok:false, age:number}>}
 */
async function acquireLock(lockFile, ttlMs) {
  if (!lockFile) throw new Error('lock file path is unavailable');
  try {
    await writeLockFile(lockFile);
    return { ok: true, priorMtime: null };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  let info;
  try {
    info = await fs.stat(lockFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      await writeLockFile(lockFile);
      return { ok: true, priorMtime: null };
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') return { ok: false, age: 0 };
      throw retryError;
    }
  }

  const age = Math.max(0, Date.now() - info.mtimeMs);
  if (age < ttlMs) return { ok: false, age };

  const priorMtime = Number.isFinite(info.mtimeMs) ? info.mtimeMs : null;
  try {
    await fs.unlink(lockFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await writeLockFile(lockFile);
    return { ok: true, priorMtime };
  } catch (error) {
    if (error?.code === 'EEXIST') return { ok: false, age: 0 };
    throw error;
  }
}

/**
 * Release the dream lock. A successful pass removes it. A failed pass restores
 * the takeover timestamp when it replaced an expired lock; a lock this pass
 * created itself is simply removed so a failure never blocks the next attempt.
 */
async function releaseLock(lockFile, { failure = false, priorMtime = null } = {}) {
  if (!lockFile) return;
  if (!failure) {
    try {
      await fs.unlink(lockFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }
  if (Number.isFinite(priorMtime) && priorMtime > 0) {
    const stamp = new Date(priorMtime);
    try {
      await fs.utimes(lockFile, stamp, stamp);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }
  try {
    await fs.unlink(lockFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers: backup, changelog, apply, rollback
// ---------------------------------------------------------------------------

async function uniqueChildName(baseDir, baseName) {
  for (let index = 0; index < 100; index += 1) {
    const name = index === 0 ? baseName : `${baseName}-${index}`;
    try {
      await fs.lstat(path.join(baseDir, name));
    } catch (error) {
      if (error?.code === 'ENOENT') return name;
      throw error;
    }
  }
  return `${baseName}-${Date.now()}`;
}

/** Top-level regular file names in a directory (`[]` when it does not exist). */
async function listTopLevelFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

/**
 * Content hash of every top-level memory file (MEMORY.md included). A plan
 * records the fingerprint of the memory it was computed from; applying it is
 * refused once the directory no longer matches, so a stale plan can never
 * overwrite edits made after it was produced.
 */
async function memoryFingerprint(memoryDir) {
  const fingerprint = {};
  for (const name of (await listTopLevelFiles(memoryDir)).sort()) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    try {
      fingerprint[name] = createHash('sha1').update(await fs.readFile(path.join(memoryDir, name))).digest('hex');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return fingerprint;
}

/** Files added, removed or changed between two fingerprints, sorted. */
function changedFiles(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}

/** Copy every top-level memory file into a fresh backup directory. */
async function backupMemory(store, paths, backupDir) {
  if (store && typeof store.ensure === 'function') {
    try {
      await store.ensure();
    } catch {
      // The copy below reports a real failure if the directory is unusable.
    }
  }
  await fs.mkdir(backupDir, { recursive: true });
  const names = await listTopLevelFiles(paths.memoryDir);
  for (const name of names) {
    const source = path.join(paths.memoryDir, name);
    const target = path.join(backupDir, name);
    try {
      await fs.copyFile(source, target);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return backupDir;
}

function formatChangelog({
  at,
  trigger,
  sessions,
  counts,
  backupName,
  summary,
  notes,
  dropped,
  rollback,
  rollbackConflicts,
  note,
  error,
  durationMs,
  inputChars,
  outputChars,
  usage,
  costExceeded,
  costMode,
  estimatedTokens,
  totalTokens,
  limit,
}) {
  const safeCounts = counts && typeof counts === 'object'
    ? { write: Number(counts.write) || 0, delete: Number(counts.delete) || 0, index: Number(counts.index) || 0 }
    : { write: 0, delete: 0, index: 0 };
  const total = safeCounts.write + safeCounts.delete + safeCounts.index;
  const lines = [
    `## ${new Date(at).toISOString()}`,
    `- trigger: ${trigger}, sessions: ${sessions}, ops: ${total} (write ${safeCounts.write}, delete ${safeCounts.delete}, index ${safeCounts.index}), backup: ${backupName ? `.dreams/${backupName}` : 'none'}, rollback: ${rollback === true}`,
  ];
  if (summary) lines.push(`- summary: ${oneLine(summary, 500)}`);
  if (note) lines.push(`- note: ${oneLine(note, 300)}`);
  if (notes) lines.push(`- notes: ${oneLine(notes, 300)}`);
  if (Array.isArray(dropped) && dropped.length > 0) {
    lines.push(`- dropped: ${oneLine(dropped.slice(0, 5).join('; '), 500)}`);
  }
  if (durationMs !== undefined || inputChars !== undefined || outputChars !== undefined) {
    lines.push(
      `- cost: durationMs ${Math.max(0, Math.trunc(Number(durationMs) || 0))}, `
        + `inputChars ${Math.max(0, Math.trunc(Number(inputChars) || 0))}, `
        + `outputChars ${Math.max(0, Math.trunc(Number(outputChars) || 0))}`,
    );
  }
  const tokens = usageLine(usage);
  if (tokens) lines.push(`- usage: ${tokens}`);
  if (costExceeded === true) {
    const details = [];
    if (typeof costMode === 'string' && costMode !== '') details.push(`mode=${costMode}`);
    if (Number.isFinite(Number(estimatedTokens))) details.push(`estimatedTokens=${Math.trunc(Number(estimatedTokens))}`);
    if (Number.isFinite(Number(totalTokens))) details.push(`totalTokens=${Math.trunc(Number(totalTokens))}`);
    if (Number.isFinite(Number(limit))) details.push(`limit=${Math.trunc(Number(limit))}`);
    lines.push(`- costExceeded: true${details.length > 0 ? ` (${details.join(', ')})` : ''}`);
  }
  if (Array.isArray(rollbackConflicts) && rollbackConflicts.length > 0) {
    lines.push(
      `- rollback conflicts: ${oneLine(rollbackConflicts.slice(0, 5).map((item) => `${item.file}: ${item.reason}`).join('; '), 500)}`,
    );
  }
  if (error) lines.push(`- error: ${oneLine(error, 400)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Build the `.dreams/<ts>/meta.json` payload for one applied batch. `ts` is the
 * backup directory name, which is also the batch id reported by dream history.
 */
function buildDreamBatchMeta({
  ts,
  kind,
  ops,
  planOps,
  summary,
  sessions,
  files,
  counts,
  durationMs,
  inputChars,
  outputChars,
  usage,
  costExceeded,
  costMode,
  trigger,
  operations,
  created,
  rewritten,
  deleted,
  hashes,
}) {
  const cost = {
    durationMs: Math.max(0, Math.trunc(Number(durationMs) || 0)),
    inputChars: Math.max(0, Math.trunc(Number(inputChars) || 0)),
    outputChars: Math.max(0, Math.trunc(Number(outputChars) || 0)),
    usage: usage && typeof usage === 'object' ? { ...usage } : null,
  };
  const normalizeFileList = (list) => (Array.isArray(list)
    ? [...new Set(list.filter((file) => typeof file === 'string' && file !== ''))]
    : []);
  const normalizedOps = Array.isArray(operations)
    ? operations
      .filter((op) => op && typeof op.file === 'string' && op.file !== '')
      .map((op) => ({
        file: op.file,
        op: op.op === 'delete' ? 'delete' : 'write',
        hashAfter: typeof op.hashAfter === 'string' ? op.hashAfter : null,
      }))
    : [];
  const normalizedHashes = {};
  if (hashes && typeof hashes === 'object' && !Array.isArray(hashes)) {
    for (const [file, hash] of Object.entries(hashes)) {
      if (typeof file !== 'string' || file === '') continue;
      normalizedHashes[file] = typeof hash === 'string' ? hash : null;
    }
  }
  const totalOps = Math.max(0, Math.trunc(Number(ops) || 0));
  const appliedAt = Date.now();
  return {
    ts,
    kind: kind === 'apply-ops' ? 'apply-ops' : 'apply',
    appliedAt,
    appliedAtIso: new Date(appliedAt).toISOString(),
    appliedAtMs: appliedAt,
    ops: totalOps,
    planOps: Number.isFinite(Number(planOps)) ? Math.max(0, Math.trunc(Number(planOps))) : totalOps,
    summary: oneLine(String(summary ?? ''), 2000),
    sessions: Array.isArray(sessions) ? sessions.filter((id) => typeof id === 'string') : [],
    files: Array.isArray(files)
      ? [...new Set(files.filter((file) => typeof file === 'string' && file !== ''))].sort()
      : [],
    counts: counts && typeof counts === 'object'
      ? { write: Number(counts.write) || 0, delete: Number(counts.delete) || 0, index: Number(counts.index) || 0 }
      : { write: 0, delete: 0, index: 0 },
    // v11 P1-6: post-apply hashes make an undo safe (conflict detection).
    operations: normalizedOps,
    created: normalizeFileList(created),
    rewritten: normalizeFileList(rewritten),
    deleted: normalizeFileList(deleted),
    hashes: normalizedHashes,
    trigger: typeof trigger === 'string' ? trigger : '',
    costExceeded: costExceeded === true,
    costMode: typeof costMode === 'string' ? costMode : '',
    durationMs: cost.durationMs,
    inputChars: cost.inputChars,
    outputChars: cost.outputChars,
    ...(cost.usage ? { usage: cost.usage } : {}),
    cost,
    undone: false,
  };
}

/** Write one batch `meta.json` (best-effort: bookkeeping must not fail an apply). */
async function writeDreamMeta(paths, backupName, meta) {
  try {
    const dir = path.join(paths.dreamsDir, backupName);
    await fs.mkdir(dir, { recursive: true });
    const metaPath = path.join(dir, 'meta.json');
    await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return metaPath;
  } catch (error) {
    warn('write dream batch meta', error);
    return null;
  }
}

/** Read one batch `meta.json`; `null` for legacy batches without metadata. */
async function readDreamMeta(paths, batchName) {
  try {
    const text = await fs.readFile(path.join(paths.dreamsDir, batchName, 'meta.json'), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    if (error && error.code !== 'ENOENT') warn('read dream batch meta', error);
    return null;
  }
}

/** Dream batch directory names, newest first (timestamp names sort lexically). */
async function listDreamBatches(paths) {
  try {
    const entries = await fs.readdir(paths.dreamsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (error && error.code !== 'ENOENT') warn('list dream batches', error);
    return [];
  }
}

/** Changelog block for one undo (contract: undo of <batch> + restored/trashed). */
function formatUndoChangelog({ at = Date.now(), batch, restored, trashed }) {
  return [
    `## ${new Date(at).toISOString()}`,
    `- undo of ${batch}`,
    `- restored: ${restored.length}, trashed: ${trashed.length}`,
  ].join('\n') + '\n';
}

/** Apply one normalized operation through the memory store. */
async function applyOperation(store, op, counts, touched, config) {
  if (op.op === 'write') {
    await store.writeRawEntry(op.file, {
      scope: op.scope,
      type: op.type,
      name: op.name,
      description: op.description,
      body: op.body,
      // Provenance contract: consolidated files record that dreaming wrote them.
      source: { via: 'dream' },
    });
    counts.write += 1;
    touched.add(op.file);
    return;
  }
  if (op.op === 'delete') {
    if (!config || config.dreamAllowDelete !== true) return;
    if (typeof store.trashEntry === 'function') {
      await store.trashEntry(op.file, { scope: op.scope, reason: op.reason || 'dream consolidation' });
    } else {
      // Pre-v2 store without soft delete; validation already guaranteed the
      // delete is allowed, so fall back to the legacy hard delete.
      await store.deleteEntry(op.file, op.scope);
    }
    counts.delete += 1;
    touched.add(op.file);
    return;
  }
  if (op.op === 'index') {
    await store.writeIndex(op.content, op.scope);
    counts.index += 1;
    touched.add(op.scope === 'user' ? 'user/MEMORY.md' : 'MEMORY.md');
  }
}

/**
 * Reconcile MEMORY.md with the files on disk (removes dangling lines, adds
 * orphaned files). A store without the v2 helper is reported, not failed.
 */
async function reconcileStoreIndex(store) {
  if (!store || typeof store.reconcileIndex !== 'function') {
    return { supported: false, result: undefined };
  }
  const result = await store.reconcileIndex('project');
  return {
    supported: true,
    result: result && typeof result === 'object' ? result : undefined,
  };
}

/**
 * Record host verification for the pages this dream run verified. The ledger —
 * not a `VERIFIED AGAINST` line inside the page — is what promotes a page into
 * the hot set, and it is fingerprinted over the name, description and body now
 * on disk, so any later edit drops the page out again.
 */
async function recordDreamVerifications({ store, plan, operations }) {
  const verified = new Set(Array.isArray(plan?.verifiedFiles) ? plan.verifiedFiles : []);
  if (verified.size === 0 || !store || typeof store.readEntry !== 'function') return;
  const written = new Set(operations
    .filter((op) => op && op.op === 'write' && typeof op.file === 'string' && op.file !== '')
    .map((op) => op.file));
  const claims = (Array.isArray(plan?.verifiedClaims) ? plan.verifiedClaims : [])
    .filter((item) => item && typeof item.claim === 'string' && item.claim !== '');
  for (const file of verified) {
    if (!written.has(file)) continue;
    try {
      const entry = await store.readEntry(file, 'project');
      const name = entry?.frontmatter?.name;
      const description = entry?.frontmatter?.description;
      const body = entry?.body;
      // The stamp only covers the facts a verdict supported. The name and the
      // description are index metadata: a person typed them or a verified claim
      // proposed them, so they are not re-litigated against this transcript.
      const facts = currentFactLines(body);
      const vouched = claims.filter((item) => item.file === file);
      // A `contradicts` verdict names the wrong value in `claim` and the right
      // one in the transcript quote, so only the quote is evidence for the new
      // page: the old value must never license the new one.
      const evidence = vouched.map((item) => (item.result === 'contradicts'
        ? item.quote
        : `${item.claim}\n${item.quote}`));
      const lumps = evidence.map((text) => normalizeForMatch(text)).filter((text) => text.length >= 2);
      const supported = (value) => lumps.some((lump) => normalizeForMatch(value).includes(lump))
        || evidence.some((text) => supportsStatement(value, text, { minRatio: 0.5, minMatched: 2 }));
      const gaps = facts.filter((value) => typeof value === 'string' && value.trim() !== '' && !supported(value));
      if (facts.length === 0 || vouched.length === 0 || gaps.length > 0) {
        if (gaps.length > 0) warn(`verification ledger ${file}`, `unsupported: ${gaps.slice(0, 3).join(' | ')}`);
        continue;
      }
      await recordVerification({
        store,
        scope: 'project',
        file,
        name,
        description,
        body,
        source: 'dream',
      });
    } catch (error) {
      warn(`verification ledger ${file}`, error);
    }
  }
}

/** Move one memory file out of the memory directory into a trash location. */
async function moveToTrash(store, paths, file) {
  if (store && typeof store.trashEntry === 'function') {
    try {
      const result = await store.trashEntry(file, { scope: 'project', reason: 'dream rollback' });
      return { file, via: 'store', trashPath: result?.trashPath };
    } catch {
      // Fall through to the local trash directory.
    }
  }
  const trashRoot = paths.trashRoot || path.join(paths.projectDir, '.trash');
  const trashDir = path.join(trashRoot, `${timestampName(Date.now())}-rollback`);
  await fs.mkdir(trashDir, { recursive: true });
  const source = path.join(paths.memoryDir, file);
  const target = path.join(trashDir, file);
  try {
    await fs.rename(source, target);
  } catch {
    await fs.copyFile(source, target);
    await fs.unlink(source);
  }
  return { file, via: 'fs', trashPath: target };
}

/**
 * v12 Bug 3: selective rollback of a failed dream apply.
 *
 * Only the files this plan actually touched are considered. Each one is rolled
 * back only while its current content still matches what the dream wrote
 * (`expectedHashes`); a file changed concurrently is left alone and reported as
 * a conflict. Files the plan never touched are never modified.
 *
 * Before changing anything the current memory directory is snapshotted to
 * `.dreams/<ts>-rollback/` for forensics.
 */
async function selectiveRollbackFromBackup({ store, paths, backupDir, batchName, expectedHashes, preNames }) {
  // 1. Snapshot the current memory state for forensics (best-effort).
  let rollbackDir = null;
  try {
    rollbackDir = path.join(paths.dreamsDir, `${batchName}-rollback`);
    await fs.rm(rollbackDir, { recursive: true, force: true });
    await fs.mkdir(rollbackDir, { recursive: true });
    for (const name of await listTopLevelFiles(paths.memoryDir)) {
      await fs.copyFile(path.join(paths.memoryDir, name), path.join(rollbackDir, name));
    }
  } catch (error) {
    warn('rollback snapshot', error);
  }

  const restoredFiles = [];
  const extrasTrashed = [];
  const conflicts = [];
  for (const file of expectedHashes.keys()) {
    const expected = expectedHashes.get(file);
    let current;
    try {
      current = await hashFileIfExists(path.join(paths.memoryDir, file));
    } catch (error) {
      conflicts.push({ file, reason: `hash check failed: ${errorMessage(error)}` });
      continue;
    }
    if (current !== expected) {
      // A concurrent write landed after the dream touched this file: keep it.
      conflicts.push({
        file,
        reason: `changed after the dream wrote it (expected ${expected ?? 'deleted'}, found ${current ?? 'deleted'})`,
      });
      continue;
    }
    try {
      if (preNames.has(file)) {
        // rewritten or deleted by the plan: copy the pre-apply version back.
        await fs.copyFile(path.join(backupDir, file), path.join(paths.memoryDir, file));
        restoredFiles.push(file);
      } else if (current !== null) {
        // created by the plan: move it out of memory/.
        const moved = await moveToTrash(store, paths, file);
        extrasTrashed.push(moved.file ?? file);
      }
    } catch (error) {
      conflicts.push({ file, reason: `rollback failed: ${errorMessage(error)}` });
    }
  }

  // 2. Reconcile the index so lines of trashed/restored files match the disk.
  try {
    await reconcileStoreIndex(store);
  } catch (error) {
    warn('rollback reconcile', error);
  }
  return { restored: true, extrasTrashed, restoredFiles, conflicts, rollbackDir };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class DreamEngine {
  /**
   * @param {{ctx?: object, runtime?: object, config?: object,
   *   getConfig?: () => object}} [options]
   */
  constructor({ ctx, runtime, config, getConfig } = {}) {
    this.ctx = ctx;
    this.runtime = runtime;
    this._config = config && typeof config === 'object' ? config : {};
    this._getConfig = typeof getConfig === 'function' ? getConfig : null;
  }

  /**
   * Effective config. A `getConfig` provider (v12 Bug 1) makes runtime toggles
   * visible to an engine that was created before the change; without one the
   * constructor snapshot is used.
   */
  get config() {
    if (this._getConfig) {
      try {
        const live = this._getConfig();
        if (live && typeof live === 'object') return live;
      } catch (error) {
        warn('dream getConfig', error);
      }
    }
    return this._config;
  }

  /** Effective dream mode for this deployment. */
  get mode() {
    return this.config.dreamMode === 'review' ? 'review' : 'apply';
  }

  /**
   * v0.12.0: one evidence gate shared by full apply, apply-last, review apply and
   * selective apply-ops. Missing evidence on a v2 transcript plan fails closed;
   * pure-consolidation plans still allow moving existing lines but not new facts.
   * @returns {Promise<{ok:boolean, operations?:object[], error?:string}>}
   */
  async checkV2Evidence({ plan, operations, store }) {
    if (!plan || plan.kind !== 'dream-v2') return { ok: true, operations };
    const expected = Number(plan.expectedSessions) || 0;
    const hasEvidence = Array.isArray(plan.evidence);
    if (expected > 0 && !hasEvidence) {
      return { ok: false, error: 'evidence-rejected: plan has no evidence bundle; regenerate a v2 dry-run' };
    }
    const currentPages = await this.readCurrentPages(store);
    if (currentPages === null) {
      return { ok: false, error: 'evidence-rejected: current memory could not be read' };
    }
    const checked = checkWriteOperations({
      operations: Array.isArray(operations) ? operations : [],
      currentPages,
      evidence: hasEvidence ? plan.evidence : [],
    });
    if (checked.dropped.length > 0) {
      return { ok: false, error: `evidence-rejected: ${checked.dropped.slice(0, 5).join('; ')}` };
    }
    return { ok: true, operations: withControlledIndex(currentPages, checked.operations) };
  }

  /** Current project pages as the evidence gate sees them; null when unreadable. */
  async readCurrentPages(store) {
    const currentPages = [];
    try {
      const entries = await store.listEntries('project');
      for (const entry of Array.isArray(entries) ? entries : []) {
        const read = await store.readEntry(entry.file, 'project').catch(() => undefined);
        if (read) {
          currentPages.push({
            file: entry.file,
            body: read.body,
            type: entry.type,
            name: entry.name,
            description: entry.description,
          });
        }
      }
    } catch {
      return null;
    }
    return currentPages;
  }

  /**
   * The per-operation checks `applyPlanOperations` runs (single-operation
   * validation, then the v2 evidence gate), evaluated for the review screen so
   * an operation that would be refused is marked before anyone selects it.
   * Read-only. `byIndex` maps a raw operation index to its refusal reason;
   * `error` is a plan-level refusal that blocks every operation.
   * @returns {Promise<{error:string, byIndex:Map<number,string>}>}
   */
  async previewVerdicts({ plan, store }) {
    const byIndex = new Map();
    const rawOperations = Array.isArray(plan?.operations) ? plan.operations : [];
    const truncatedFiles = normalizeStringArray(plan?.truncatedFiles);
    const existingFiles = await this.existingFiles(store, this.config);
    const validated = [];
    rawOperations.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const validation = validateDreamPlan(
        { summary: '', operations: [raw] },
        { config: this.config, existingFiles, truncatedFiles },
      );
      if (!validation.ok || validation.plan.operations.length !== 1) {
        byIndex.set(index, validation.ok
          ? (validation.dropped[0] || 'operation was dropped by validation')
          : (validation.error || 'invalid operation'));
        return;
      }
      validated.push({ index, op: validation.plan.operations[0] });
    });
    if (plan?.kind !== 'dream-v2') return { error: '', byIndex };
    const hasEvidence = Array.isArray(plan.evidence);
    if ((Number(plan.expectedSessions) || 0) > 0 && !hasEvidence) {
      return { error: 'plan has no evidence bundle; regenerate a v2 dry-run', byIndex };
    }
    const currentPages = await this.readCurrentPages(store);
    if (currentPages === null) return { error: 'current memory could not be read', byIndex };
    const checked = checkWriteOperations({
      operations: validated.map((item) => item.op),
      currentPages,
      evidence: hasEvidence ? plan.evidence : [],
    });
    for (const reason of checked.dropped) {
      const hit = validated.find((item) => (item.op.op === 'index'
        ? reason.startsWith('index:')
        : reason.startsWith(`${item.op.file}: `)));
      if (hit && !byIndex.has(hit.index)) byIndex.set(hit.index, reason);
    }
    // The merge-dependency guard of apply-ops, against the largest selection
    // the user can still make: a delete whose facts were meant to move into a
    // refused write would lose them, so it is refused too.
    const selectable = validated.filter((item) => !byIndex.has(item.index)).map((item) => item.op);
    for (const item of validated) {
      if (byIndex.has(item.index) || item.op.op !== 'delete') continue;
      let source;
      try { source = await store.readEntry(item.op.file, 'project'); } catch { continue; }
      const lines = String(source.body ?? '').split(/\r?\n/).filter((line) => line.trim());
      const destinations = rawOperations.filter((op) => op?.op === 'write' && op.file !== item.op.file
        && !selectable.some((other) => other.op === 'delete' && other.file === op.file));
      const plannedLines = new Set(destinations.flatMap((op) => String(op.body ?? '').split(/\r?\n/)));
      const omittedWrite = destinations.some((destination) => !selectable.some((op) => op.op === 'write' && op.file === destination.file));
      const moved = omittedWrite ? lines : lines.filter((line) => plannedLines.has(line));
      if (moved.length === 0) continue;
      const surviving = new Set();
      for (const destination of destinations) {
        const write = selectable.find((op) => op.op === 'write' && op.file === destination.file);
        let body = write?.body;
        if (body === undefined) {
          try { body = (await store.readEntry(destination.file, 'project')).body; } catch { body = ''; }
        }
        for (const line of String(body).split(/\r?\n/)) surviving.add(line);
      }
      if (moved.some((line) => !surviving.has(line))) {
        byIndex.set(item.index, `merge dependency: its facts were meant to move into a change that cannot be applied, so deleting ${item.op.file} would lose them`);
      }
    }
    return { error: '', byIndex };
  }

  /**
   * Apply a previously produced plan (review proposal or the last dry-run plan).
   * The model is never called again: the plan is validated, backed up, applied,
   * reconciled and recorded exactly like a direct apply.
   *
   * @param {{pctx?:object, agent?:object, plan?:object, proposalPath?:string,
   *   fromLastPlan?:boolean}} options
   * @returns {Promise<{applied:boolean, summary?:string, filesTouched?:number,
   *   operations?:number, error?:string, rolledBack?:boolean, backupDir?:string,
   *   reconciled?:boolean}>}
   */
  async applyPending({ pctx, agent, plan, proposalPath, fromLastPlan = false } = {}) {
    const project = pctx;
    const paths = project && typeof project === 'object' ? normalizePaths(project.paths) : null;
    const store = project && typeof project === 'object' ? project.store : undefined;
    const state = project && typeof project === 'object' ? project.state : undefined;
    const fail = (error) => ({ applied: false, rolledBack: false, error });

    if (!paths || !store || typeof store.writeRawEntry !== 'function') return fail('no-project');
    if (!this.config.enabled) return fail('disabled');
    if (this.config.autoMemoryEnabled === false) return fail('auto-memory-disabled');
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return fail('invalid-proposal');
    const coverageError = dreamV2CoverageError(plan);
    if (coverageError) return fail(coverageError);
    if (Array.isArray(plan.dropped) && plan.dropped.length > 0
      && Array.isArray(plan.operations) && plan.operations.some(op => op?.op === 'delete' || op?.op === 'index')) {
      return fail('incomplete plan contains destructive operations after filtering; reject it and regenerate a new dry-run plan');
    }

    // One dream at a time: auto dream uses the same `.consolidate-lock`, so a
    // manual apply must not run concurrently with it (TTL: lockTtlMs, 1h).
    let lock;
    try {
      lock = await acquireLock(paths.lockFile, positiveInt(this.config.lockTtlMs, DEFAULT_LIMITS.lockTtlMs));
    } catch (error) {
      return fail(`dream lock unavailable: ${errorMessage(error)}`);
    }
    if (!lock.ok) return fail('dream-locked');

    let failure = true;
    const metrics = planMetrics(plan);
    const cost = costLimitStatus(this.config, metrics.usage);
    const costExceeded = cost.exceeded;
    try {
      if (plan.inputFingerprint && typeof plan.inputFingerprint === 'object') {
        const changed = changedFiles(plan.inputFingerprint, await memoryFingerprint(paths.memoryDir));
        if (changed.length > 0) {
          return fail(`stale-plan: memory changed since this plan was made (${changed.join(', ')}); run a new dry-run`);
        }
      }

      const rawSessions = normalizeStringArray(plan.sessions);
      const truncatedFiles = normalizeStringArray(plan.truncatedFiles);
      const existingFiles = await this.existingFiles(store, this.config);
      const validation = validateDreamPlan(plan, {
        config: this.config,
        existingFiles,
        truncatedFiles,
      });
      if (!validation.ok) {
        return fail(`invalid proposal: ${validation.error ?? 'unknown error'}`);
      }
      const normalized = validation.plan;

      // Claim-level plans record the body each page had when the merge read it.
      // Compare before the evidence filter: a page edited after the dry-run must
      // report a stale plan, not a citation error caused by the newer text.
      const stale = await staleWrites(store, normalized.operations);
      if (stale.length > 0) {
        return fail(`stale-plan: memory changed since this plan was made (${stale.map((item) => item.file).join(', ')}); run a new dry-run`);
      }

      // v0.12.0: the final write path re-checks organizer-added lines against
      // the evidence bundle. A plan cannot become applyable just because its
      // dry-run JSON was edited or its organizer paraphrased pasted material.
      const evidenceChecked = await this.checkV2Evidence({
        plan: normalized,
        operations: normalized.operations,
        store,
      });
      if (!evidenceChecked.ok) return fail(evidenceChecked.error);
      normalized.operations = evidenceChecked.operations;

      // Secret scan on the writes that are about to be persisted.
      const secretScan = await this.scanOperationSecrets(normalized.operations, this.config);
      const dependencies = dropDestructiveDependents(plan.operations, secretScan.operations);
      normalized.operations = dependencies.operations;
      const dropped = [...(Array.isArray(plan.dropped) ? plan.dropped : []), ...validation.dropped, ...secretScan.dropped, ...dependencies.dropped];
      const notes = secretScan.warnings.length > 0
        ? oneLine([normalized.notes, ...secretScan.warnings].filter(Boolean).join(' — '), 2000)
        : normalized.notes;
      normalized.notes = notes;
      const warnings = [...secretScan.warnings];
      if (cost.warning !== '') warnings.push(cost.warning);
      const warningList = warnings.length > 0 ? warnings : undefined;
      const summary = normalized.summary;
      const note = fromLastPlan
        ? `applied last dry-run plan${proposalPath ? ` ${path.basename(proposalPath)}` : ''}`
        : (proposalPath ? `applied pending proposal ${path.basename(proposalPath)}` : 'applied reviewed plan');

      // Nothing to change: still consume the pending/last-plan pointers.
      if (normalized.operations.length === 0) {
        await recordDreamEvent(paths, {
          event: 'applied',
          ops: 0,
          ...metrics,
          planOps: normalized.operations.length,
          dropped: dropped.length,
        });
        await callState(state, 'markDreamDone', {
          sessions: rawSessions.length,
          ops: 0,
          files: 0,
          summary,
          mode: 'apply',
          costExceeded,
          ...metrics,
        });
        if (dropped.length === 0) await callState(state, 'clearSessions', [...rawSessions, ...normalizeStringArray(plan.droppedSessions)].filter((id) => (Array.isArray(plan.reads) ? plan.reads : []).some((read) => read?.id === id)), { reads: Array.isArray(plan.reads) ? plan.reads : [] });
        await callState(state, 'clearPendingProposal', { silent: true });
        await callState(state, 'clearLastPlan');
        failure = false;
        return {
          applied: true,
          summary,
          filesTouched: 0,
          operations: 0,
          rolledBack: false,
          reconciled: null,
          costExceeded,
          dropped,
          warnings: warningList,
          ...metrics,
        };
      }

      let execution;
      try {
        execution = await this.executePlan({
          store,
          paths,
          plan: normalized,
          config: this.config,
          skill: typeof normalized.skill === 'string' ? normalized.skill : '',
          changelog: {
            at: Date.now(),
            trigger: 'manual',
            sessions: rawSessions.length,
            summary,
            notes,
            dropped,
            note,
            costExceeded,
            costMode: dreamCostModeOf(this.config),
            estimatedTokens: estimateInputTokens(metrics.inputChars),
            totalTokens: cost.totalTokens,
            limit: cost.limit,
            ...metrics,
          },
          meta: {
            kind: 'apply',
            planOps: normalized.operations.length,
            summary,
            sessions: rawSessions,
            durationMs: metrics.durationMs,
            inputChars: metrics.inputChars,
            outputChars: metrics.outputChars,
            usage: metrics.usage,
            costExceeded,
            costMode: dreamCostModeOf(this.config),
            trigger: 'manual',
          },
        });
      } catch (error) {
        const message = errorMessage(error);
        await this.handleApplyFailure(state, store, error, {
          trigger: 'manual',
          sessions: rawSessions.length,
          summary,
          notes,
          dropped,
          note,
          costExceeded,
          costMode: dreamCostModeOf(this.config),
          estimatedTokens: estimateInputTokens(metrics.inputChars),
          totalTokens: cost.totalTokens,
          limit: cost.limit,
          ...metrics,
        });
        await recordDreamEvent(paths, {
          event: 'failed',
          ...metrics,
          planOps: normalized.operations.length,
          dropped: dropped.length,
          rollback: error?.rolledBack === true,
        });
        return {
          applied: false,
          rolledBack: error?.rolledBack === true,
          conflicts: Array.isArray(error?.rollbackConflicts) ? error.rollbackConflicts : [],
          rollbackError: error?.rollbackError,
          error: message,
          summary,
          backupDir: error?.backupDir,
          operations: partialOperationCount(error),
          filesTouched: error?.partialTouched instanceof Set ? error.partialTouched.size : 0,
          costExceeded,
          dropped,
          warnings: warningList,
        };
      }

      // A page edited after the plan was built: refuse instead of overwriting.
      if (execution && execution.ok === false) {
        const conflicts = Array.isArray(execution.conflicts) ? execution.conflicts : [];
        return {
          applied: false,
          rolledBack: false,
          error: execution.error === 'conflict'
            ? `stale-plan: memory changed since this plan was made (${conflicts.map((item) => item.file).join(', ')}); run a new dry-run`
            : String(execution.error ?? 'apply-failed'),
          conflicts,
          ops: 0,
          path: typeof proposalPath === 'string' ? proposalPath : '',
        };
      }

      const total = execution.counts.write + execution.counts.delete + execution.counts.index;
      await recordDreamEvent(paths, {
        event: 'applied',
        ops: total,
        ...metrics,
        planOps: normalized.operations.length,
        dropped: dropped.length,
      });
      await callState(state, 'markDreamDone', {
        sessions: rawSessions.length,
        ops: total,
        files: execution.touched.size,
        summary,
        mode: 'apply',
        costExceeded,
        ...metrics,
      });
      if (dropped.length === 0) await callState(state, 'clearSessions', [...rawSessions, ...normalizeStringArray(plan.droppedSessions)].filter((id) => (Array.isArray(plan.reads) ? plan.reads : []).some((read) => read?.id === id)), { reads: Array.isArray(plan.reads) ? plan.reads : [] });
      await callState(state, 'clearPendingProposal', { silent: true });
      await callState(state, 'clearLastPlan');
      this.invalidate(agent, project);
      failure = false;

      return {
        applied: true,
        summary,
        filesTouched: execution.touched.size,
        operations: total,
        rolledBack: false,
        backupDir: execution.backupDir,
        reconciled: execution.reconcile.supported,
        reconcile: execution.reconcile.result,
        counts: execution.counts,
        costExceeded,
        dropped,
        warnings: warningList,
        ...metrics,
      };
    } finally {
      try {
        await releaseLock(paths.lockFile, { failure, priorMtime: lock.priorMtime });
      } catch (error) {
        warn('dream lock release', error);
      }
    }
  }

  /**
   * Reject the pending review proposal: delete its file, clear the state pointer
   * and count a `rejected` dream metric. Called by `runtime.rejectPendingPlan()`
   * (status/commands may route their reject action here).
   * @param {{pctx?:object}} options
   * @returns {Promise<{rejected:boolean, proposalPath?:string, reason?:string, error?:string}>}
   */
  async rejectPlan({ pctx } = {}) {
    const project = pctx;
    const paths = project && typeof project === 'object' ? normalizePaths(project.paths) : null;
    const state = project && typeof project === 'object' ? project.state : undefined;
    if (!paths || !state) return { rejected: false, reason: 'no-project' };
    const snapshot = safeSnapshot(state);
    const pending = typeof snapshot.pendingProposal === 'string' ? snapshot.pendingProposal : '';
    if (pending === '') return { rejected: false, reason: 'no-pending-proposal' };
    try {
      await fs.unlink(pending);
    } catch (error) {
      if (error?.code !== 'ENOENT') return { rejected: false, error: errorMessage(error) };
    }
    // Silent: the explicit recordDreamEvent below is the single `rejected` count.
    await callState(state, 'clearPendingProposal', { silent: true });
    await recordDreamEvent(paths, { event: 'rejected' });
    return { rejected: true, proposalPath: pending };
  }

  /**
   * Persist one review-style plan (normal review run, or an apply run demoted to
   * review by `dreamCostMode:'review'`). Returns the proposal path.
   */
  async saveReviewProposal({
    paths,
    plan,
    provider,
    model,
    summary,
    notes,
    dropped,
    truncatedFiles,
    durationMs,
    inputChars,
    outputChars,
    costExceeded,
    costMode,
    estimatedTokens,
    usage,
    warningList,
    inputFingerprint,
    sessionIds,
    reads,
    droppedSessions,
    inputStats,
    trigger,
    reviewReason,
    costLimit,
  }) {
    const proposalPath = path.join(paths.pendingDir, `${timestampName(Date.now())}.json`);
    await fs.mkdir(paths.pendingDir, { recursive: true });
    const payload = {
      createdAt: new Date().toISOString(),
      trigger,
      mode: 'review',
      review: true,
      dryRun: false,
      applied: false,
      provider,
      model,
      summary,
      notes,
      operations: plan.operations,
      dropped,
      truncatedFiles,
      durationMs,
      inputChars,
      outputChars,
      costExceeded: costExceeded === true,
      costMode,
      estimatedTokens,
      ...(usage ? { usage } : {}),
      ...(Array.isArray(warningList) && warningList.length > 0 ? { warnings: warningList } : {}),
      ...(reviewReason ? { reviewReason } : {}),
      ...(costLimit ? { costLimit } : {}),
      inputFingerprint,
      sessions: sessionIds,
      reads,
      droppedSessions,
      input: inputStats,
    };
    await fs.writeFile(proposalPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return proposalPath;
  }

  /**
   * Persist a blocked plan for audit (cost mode `block` after the model call):
   * `.dreams/<ts>/plan.json` with `blocked:true` and the cost details.
   */
  async writeBlockedPlan({
    paths,
    plan,
    summary,
    notes,
    dropped,
    truncatedFiles,
    cost,
    costMode,
    estimatedTokens,
    usage,
    inputChars,
    outputChars,
    durationMs,
    sessionIds,
  }) {
    const planDirName = await uniqueChildName(paths.dreamsDir, timestampName(Date.now()));
    const planDir = path.join(paths.dreamsDir, planDirName);
    await fs.mkdir(planDir, { recursive: true });
    const planPath = path.join(planDir, 'plan.json');
    const payload = {
      createdAt: new Date().toISOString(),
      blocked: true,
      applied: false,
      error: 'cost-limit',
      costExceeded: true,
      costMode,
      estimatedTokens,
      totalTokens: cost && Number.isFinite(Number(cost.totalTokens)) ? Number(cost.totalTokens) : null,
      limit: cost && Number.isFinite(Number(cost.limit)) ? Number(cost.limit) : 0,
      durationMs,
      inputChars,
      outputChars,
      ...(usage ? { usage } : {}),
      summary,
      notes,
      operations: plan.operations,
      dropped,
      truncatedFiles,
      sessions: sessionIds,
    };
    await fs.writeFile(planPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return planPath;
  }

  /** Append one cost-mode changelog entry (best-effort; never fails the dream). */
  async writeCostModeChangelog({
    store,
    paths,
    at = Date.now(),
    trigger = 'manual',
    sessions = 0,
    summary = '',
    notes = '',
    note = '',
    error = '',
    durationMs,
    inputChars,
    outputChars,
    usage,
    costExceeded,
    costMode,
    estimatedTokens,
    totalTokens,
    limit,
  }) {
    const entry = formatChangelog({
      at,
      trigger,
      sessions,
      counts: { write: 0, delete: 0, index: 0 },
      backupName: '',
      summary,
      notes,
      dropped: [],
      rollback: false,
      note,
      error,
      durationMs,
      inputChars,
      outputChars,
      usage,
      costExceeded,
      costMode,
      estimatedTokens,
      totalTokens,
      limit,
    });
    try {
      if (store && typeof store.writeChangelog === 'function') {
        await store.writeChangelog(entry);
        return true;
      }
      if (paths && typeof paths.changelogFile === 'string' && paths.changelogFile !== '') {
        await fs.mkdir(path.dirname(paths.changelogFile), { recursive: true });
        await fs.appendFile(paths.changelogFile, entry, 'utf8');
        return true;
      }
    } catch (writeError) {
      warn('cost-mode changelog', writeError);
    }
    return false;
  }

  /**
   * Diff the latest available plan against the current memory without applying
   * anything (read-only; no lock).
   *
   * @param {{pctx?:object, plan?:object, path?:string}} options
   * @returns {Promise<{path:string, summary:string, ops:object[],
   *   truncatedFiles:string[], dropped:string[], error?:string}>}
   */
  async previewPlan({ pctx, plan, path: planPath } = {}) {
    const project = pctx;
    const paths = project && typeof project === 'object' ? normalizePaths(project.paths) : null;
    const store = project && typeof project === 'object' ? project.store : undefined;
    const empty = { path: '', summary: '', ops: [], truncatedFiles: [], dropped: [] };
    if (!paths || !store) return { ...empty, error: 'no-project' };
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ...empty, error: 'invalid-plan' };

    const rawOperations = Array.isArray(plan.operations) ? plan.operations : [];
    const context = {
      path: typeof planPath === 'string' ? planPath : '',
      summary: typeof plan.summary === 'string' ? plan.summary : '',
      ops: [],
      truncatedFiles: normalizeStringArray(plan.truncatedFiles),
      dropped: Array.isArray(plan.dropped) ? plan.dropped.filter((entry) => typeof entry === 'string') : [],
    };
    // v8: carry the plan's cost fields so the UI can show them in the diff panel.
    for (const key of ['durationMs', 'inputChars', 'outputChars', 'usage', 'estimatedTokens', 'limit', 'costMode', 'warnings']) {
      if (plan[key] !== undefined) context[key] = plan[key];
    }
    // Dream v2: session coverage and verification, so the review shows what was read.
    for (const key of ['kind', 'coverageComplete', 'expectedSessions', 'processedSessions', 'failedSessions',
      'partialSessions', 'verifiedFiles', 'evidenceWarnings']) {
      if (plan[key] !== undefined) context[key] = plan[key];
    }
    if (plan.costExceeded === true) context.costExceeded = true;
    // Claims the host merge left for a person to decide (classic plans set a boolean).
    if (Array.isArray(plan.review)) context.review = plan.review;

    const readCurrent = async (file) => {
      if (typeof store.readEntry !== 'function' || typeof file !== 'string' || file === '') {
        return { exists: false, raw: '', body: '' };
      }
      try {
        const current = await store.readEntry(file, 'project');
        return {
          exists: true,
          raw: typeof current?.raw === 'string' ? current.raw : '',
          body: typeof current?.body === 'string' ? current.body : '',
        };
      } catch (error) {
        if (error && (error.code === 'NOT_FOUND' || error.code === 'ENOENT')) {
          return { exists: false, raw: '', body: '' };
        }
        warn(`preview read ${file}`, error);
        return { exists: false, raw: '', body: '' };
      }
    };

    for (let index = 0; index < rawOperations.length; index += 1) {
      const raw = rawOperations[index];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const kind = raw.op;
      if (kind !== 'write' && kind !== 'delete' && kind !== 'index') continue;
      const scope = raw.scope === 'user' ? 'user' : 'project';
      const op = {
        index,
        op: kind,
        scope,
        file: '',
        type: '',
        before: '',
        after: '',
        changed: false,
      };
      if (kind === 'write') {
        op.type = typeof raw.type === 'string' ? raw.type : '';
        op.file = typeof raw.file === 'string' ? raw.file : '';
        op.after = typeof raw.body === 'string' ? raw.body : '';
        const current = await readCurrent(op.file);
        op.before = current.raw;
        op.changed = !current.exists || current.body !== op.after;
        Object.assign(op, bodyLineChanges(current.body, op.after));
      } else if (kind === 'delete') {
        op.file = typeof raw.file === 'string' ? raw.file : '';
        op.after = '';
        const current = await readCurrent(op.file);
        op.before = current.raw;
        op.changed = current.exists;
        Object.assign(op, bodyLineChanges(current.body, ''));
      } else {
        op.file = scope === 'user' ? 'user/MEMORY.md' : 'MEMORY.md';
        try {
          op.before = typeof store.indexText === 'function' ? String((await store.indexText(scope)) ?? '') : '';
        } catch (error) {
          warn('preview index', error);
          op.before = '';
        }
        op.after = typeof raw.content === 'string' ? raw.content : '';
        op.changed = op.before !== op.after;
      }
      if (Array.isArray(raw.evidence) && raw.evidence.length > 0) op.evidence = raw.evidence;
      context.ops.push(op);
    }
    // Mark what apply-ops would refuse, so review never offers a change that
    // makes the whole batch fail at apply time.
    try {
      const verdicts = await this.previewVerdicts({ plan, store });
      if (verdicts.error !== '') context.evidenceError = verdicts.error;
      for (const op of context.ops) {
        const reason = verdicts.byIndex.get(op.index);
        if (reason) op.rejected = reason;
      }
    } catch (error) {
      warn('preview verdicts', error);
    }
    return context;
  }

  /**
   * Apply a subset of the latest plan's operations. The selected operations are
   * re-validated individually and secret-scanned, then run through the same
   * backup/reconcile/changelog/state flow as a full apply.
   *
   * @param {{pctx?:object, agent?:object, plan?:object, path?:string,
   *   indexes?:number[]}} options
   * @returns {Promise<{applied:boolean, ops:number, path:string,
   *   rolledBack?:boolean, error?:string}>}
   */
  async applyPlanOperations({ pctx, agent, plan, path: planPath, indexes } = {}) {
    const project = pctx;
    const paths = project && typeof project === 'object' ? normalizePaths(project.paths) : null;
    const store = project && typeof project === 'object' ? project.store : undefined;
    const state = project && typeof project === 'object' ? project.state : undefined;
    const resolvedPath = typeof planPath === 'string' ? planPath : '';
    const fail = (error, extra = {}) => ({ applied: false, ops: 0, path: resolvedPath, rolledBack: false, ...extra, error });

    if (!paths || !store || typeof store.writeRawEntry !== 'function') return fail('no-project');
    if (!this.config.enabled) return fail('disabled');
    if (this.config.autoMemoryEnabled === false) return fail('auto-memory-disabled');
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return fail('invalid-plan');
    const coverageError = dreamV2CoverageError(plan);
    if (coverageError) return fail(coverageError);

    const rawOperations = Array.isArray(plan.operations) ? plan.operations : [];
    const selection = normalizeIndexes(indexes, rawOperations.length);
    if (!selection.ok) return fail(selection.error);
    if (Array.isArray(plan.dropped) && plan.dropped.length > 0
      && selection.indexes.some(index => ['delete', 'index'].includes(rawOperations[index]?.op))) {
      return fail('incomplete plan contains destructive operations after filtering; reject it and regenerate a new dry-run plan');
    }

    let lock;
    try {
      lock = await acquireLock(paths.lockFile, positiveInt(this.config.lockTtlMs, DEFAULT_LIMITS.lockTtlMs));
    } catch (error) {
      return fail(`dream lock unavailable: ${errorMessage(error)}`);
    }
    // Contract shape for apply-ops is `{applied, ops, path, error?}`.
    if (!lock.ok) return fail('dream-locked');

    let failure = true;
    const metrics = planMetrics(plan);
    const cost = costLimitStatus(this.config, metrics.usage);
    const costExceeded = cost.exceeded;
    try {
      if (plan.inputFingerprint && typeof plan.inputFingerprint === 'object') {
        const changed = changedFiles(plan.inputFingerprint, await memoryFingerprint(paths.memoryDir));
        if (changed.length > 0) {
          return fail(`stale-plan: memory changed since this plan was made (${changed.join(', ')}); run a new dry-run`);
        }
      }

      const rawSessions = normalizeStringArray(plan.sessions);
      const truncatedFiles = normalizeStringArray(plan.truncatedFiles);
      const existingFiles = await this.existingFiles(store, this.config);

      // Re-validate each selected operation individually (same rules as a full
      // plan, so truncated files / derived-name collisions / disabled deletes
      // are still refused).
      let selected = [];
      const dropped = [];
      for (const index of selection.indexes) {        const validation = validateDreamPlan(
          { summary: '', operations: [rawOperations[index]] },
          { config: this.config, existingFiles, truncatedFiles },
        );
        if (!validation.ok || validation.plan.operations.length !== 1) {
          const reason = validation.ok
            ? (validation.dropped[0] || 'operation was dropped by validation')
            : (validation.error || 'invalid operation');
          dropped.push(`operation #${index + 1}: ${reason}`);
          continue;
        }
        selected.push(validation.plan.operations[0]);
      }
      const combinedValidation = validateDreamPlan({ operations: selected }, { config: this.config, existingFiles, truncatedFiles });
      if (!combinedValidation.ok) return fail(combinedValidation.error);
      const evidenceChecked = await this.checkV2Evidence({ plan, operations: selected, store });
      if (!evidenceChecked.ok) return fail(evidenceChecked.error);
      selected = evidenceChecked.operations;
      // A selective apply must not remove facts awaiting an unselected merge write.
      for (const deletion of selected.filter(op => op.op === 'delete')) {
        let source;
        try { source = await store.readEntry(deletion.file, 'project'); } catch { continue; }
        const lines = String(source.body ?? '').split(/\r?\n/).filter(line => line.trim());
        const destinations = rawOperations.filter(op => op?.op === 'write' && op.file !== deletion.file
          && !selected.some(other => other.op === 'delete' && other.file === op.file));
        const plannedLines = new Set(destinations.flatMap(op => String(op.body ?? '').split(/\r?\n/)));
        const omittedWrite = destinations.some(destination => !selected.some(op => op.op === 'write' && op.file === destination.file));
        // Paraphrased merges have no safe lexical dependency signal. Treat any
        // omitted destination as dependent unless the original facts survive.
        const moved = omittedWrite ? lines : lines.filter(line => plannedLines.has(line));
        if (moved.length === 0) continue;
        const surviving = new Set();
        for (const destination of destinations) {
          const write = selected.find(op => op.op === 'write' && op.file === destination.file);
          let body = write?.body;
          if (body === undefined) {
            try { body = (await store.readEntry(destination.file, 'project')).body; } catch { body = ''; }
          }
          for (const line of String(body).split(/\r?\n/)) surviving.add(line);
        }
        if (moved.some(line => !surviving.has(line))) return fail(`merge dependency: select the destination write before deleting ${deletion.file}`);
      }
      const secretScan = await this.scanOperationSecrets(selected, this.config);
      dropped.push(...secretScan.dropped);
      const dependencies = dropDestructiveDependents(selection.indexes.map(index => rawOperations[index]), secretScan.operations);
      dropped.push(...dependencies.dropped);
      const warnings = [...secretScan.warnings];
      if (cost.warning !== '') warnings.push(cost.warning);
      const warningList = warnings.length > 0 ? warnings : undefined;
      const operations = dependencies.operations;
      if (operations.length === 0) {
        return fail('no-operations-selected', { dropped, warnings: warningList, costExceeded });
      }

      const note = `applied ${operations.length} selected operation(s)${resolvedPath ? ` from ${path.basename(resolvedPath)}` : ''}`;
      const summary = typeof plan.summary === 'string' && plan.summary !== ''
        ? plan.summary
        : note;
      const notes = secretScan.warnings.length > 0
        ? oneLine([typeof plan.notes === 'string' ? plan.notes : '', ...secretScan.warnings].filter(Boolean).join(' — '), 2000)
        : (typeof plan.notes === 'string' ? plan.notes : '');

      let execution;
      try {
        execution = await this.executePlan({
          store,
          paths,
          plan,
          config: this.config,
          operations,
          changelog: {
            at: Date.now(),
            trigger: 'manual',
            sessions: rawSessions.length,
            summary,
            notes,
            dropped,
            note,
            costExceeded,
            costMode: dreamCostModeOf(this.config),
            estimatedTokens: estimateInputTokens(metrics.inputChars),
            totalTokens: cost.totalTokens,
            limit: cost.limit,
            ...metrics,
          },
          meta: {
            kind: 'apply-ops',
            planOps: operations.length,
            summary,
            sessions: rawSessions,
            durationMs: metrics.durationMs,
            inputChars: metrics.inputChars,
            outputChars: metrics.outputChars,
            usage: metrics.usage,
            costExceeded,
            costMode: dreamCostModeOf(this.config),
            trigger: 'manual',
          },
        });
      } catch (error) {
        const message = errorMessage(error);
        await this.handleApplyFailure(state, store, error, {
          trigger: 'manual',
          sessions: rawSessions.length,
          summary,
          notes,
          dropped,
          note,
          costExceeded,
          costMode: dreamCostModeOf(this.config),
          estimatedTokens: estimateInputTokens(metrics.inputChars),
          totalTokens: cost.totalTokens,
          limit: cost.limit,
          ...metrics,
        });
        await recordDreamEvent(paths, {
          event: 'failed',
          ...metrics,
          planOps: plan.operations.length,
          dropped: dropped.length,
          rollback: error?.rolledBack === true,
        });
        return {
          applied: false,
          ops: partialOperationCount(error),
          path: resolvedPath,
          rolledBack: error?.rolledBack === true,
          conflicts: Array.isArray(error?.rollbackConflicts) ? error.rollbackConflicts : [],
          rollbackError: error?.rollbackError,
          error: message,
          backupDir: error?.backupDir,
          costExceeded,
          dropped,
          warnings: warningList,
        };
      }

      // A page edited after the plan was built: refuse instead of overwriting.
      if (execution && execution.ok === false) {
        const conflicts = Array.isArray(execution.conflicts) ? execution.conflicts : [];
        return {
          applied: false,
          rolledBack: false,
          error: execution.error === 'conflict'
            ? `stale-plan: memory changed since this plan was made (${conflicts.map((item) => item.file).join(', ')}); run a new dry-run`
            : String(execution.error ?? 'apply-failed'),
          conflicts,
          ops: 0,
          path: resolvedPath,
        };
      }

      const total = execution.counts.write + execution.counts.delete + execution.counts.index;
      await recordDreamEvent(paths, {
        event: 'applied',
        ops: total,
        ...metrics,
        planOps: plan.operations.length,
        dropped: dropped.length,
      });
      await callState(state, 'markDreamDone', {
        sessions: rawSessions.length,
        ops: total,
        files: execution.touched.size,
        summary,
        mode: 'apply',
        costExceeded,
        ...metrics,
      });
      // Partial apply: the unapplied operations may hold what those sessions
      // taught, so no watermark moves and they stay re-readable.
      await callState(state, 'clearSessions', rawSessions);
      await callState(state, 'clearPendingProposal', { silent: true });
      await callState(state, 'clearLastPlan');
      this.invalidate(agent, project);
      failure = false;

      return {
        applied: true,
        ops: total,
        path: resolvedPath,
        rolledBack: false,
        summary,
        filesTouched: execution.touched.size,
        operations: total,
        backupDir: execution.backupDir,
        reconciled: execution.reconcile.supported,
        reconcile: execution.reconcile.result,
        counts: execution.counts,
        costExceeded,
        dropped,
        warnings: warningList,
        ...metrics,
      };
    } finally {
      try {
        await releaseLock(paths.lockFile, { failure, priorMtime: lock.priorMtime });
      } catch (error) {
        warn('dream lock release', error);
      }
    }
  }

  /**
   * Backup the memory directory, apply the given operations, reconcile the
   * index and append the changelog. Any failure rolls the memory directory back
   * from the backup and rethrows an error carrying `rolledBack`/`partialCounts`.
   *
   * On success a v10 batch `meta.json` is written into the backup directory
   * (`.dreams/<ts>/meta.json`), which makes the batch discoverable/undoable.
   * @param {{store:object, paths:object, plan:object, config:object,
   *   changelog:object, operations?:object[], meta?:object|null}} options
   */
  async executePlan({ store, paths, plan, config, changelog, operations = plan.operations, meta = null, skill = '' }) {
    const counts = { write: 0, delete: 0, index: 0 };
    const touched = new Set();
    const skillText = typeof skill === 'string' ? skill.trim() : '';
    // Claim-level plans carry the page body they were built from. A page edited
    // after the plan was built must not be silently overwritten: the merge saw
    // an older body and its `Superseded` history would describe the wrong value.
    const stale = await staleWrites(store, operations);
    if (stale.length > 0) return { ok: false, error: 'conflict', conflicts: stale };
    // v12 Bug 3: post-apply hash per touched file, used for selective rollback.
    const expectedHashes = new Map();
    const backupName = await uniqueChildName(paths.dreamsDir, timestampName(Date.now()));
    const backupDir = path.join(paths.dreamsDir, backupName);
    await backupMemory(store, paths, backupDir);
    // The backup directory is the pre-apply snapshot: used both to classify
    // rollback targets and to build the success-path meta.
    const preNames = new Set(
      (await listTopLevelFiles(backupDir)).filter((name) => !BACKUP_BOOKKEEPING.has(name)),
    );

    try {
      for (const op of operations) {
        await applyOperation(store, op, counts, touched, config);
        if (op && typeof op.file === 'string' && op.file !== '' && (op.op === 'write' || op.op === 'delete')) {
          try {
            expectedHashes.set(op.file, await hashFileIfExists(path.join(paths.memoryDir, op.file)));
          } catch (error) {
            warn(`rollback hash ${op.file}`, error);
            expectedHashes.set(op.file, undefined);
          }
        }
      }
      await recordDreamVerifications({ store, plan, operations });
      let skillApplied = false;
      if (skillText !== '') {
        const skillPath = path.join(paths.memoryDir, 'SKILL.md');
        await fs.writeFile(skillPath, `${skillText}\n`, 'utf8');
        touched.add('SKILL.md');
        skillApplied = true;
        expectedHashes.set('SKILL.md', await hashFileIfExists(skillPath));
      }
      const reconcile = await reconcileStoreIndex(store);
      await store.writeChangelog(formatChangelog({
        ...changelog,
        counts,
        backupName,
        rollback: false,
      }));
      // v10/v11 P1-6: the batch is only undoable once its metadata + hashes exist.
      let metaPath = null;
      let batchMeta = null;
      if (meta) {
        const appliedFileOps = operations.filter((op) => op
          && typeof op.file === 'string'
          && op.file !== ''
          && (op.op === 'write' || op.op === 'delete'));
        if (skillApplied) appliedFileOps.push({ op: 'write', file: 'SKILL.md' });
        const touchedFiles = [...new Set(appliedFileOps.map((op) => op.file))];
        const postHashes = new Map();
        for (const file of touchedFiles) {
          postHashes.set(file, await hashFileIfExists(path.join(paths.memoryDir, file)));
        }
        const created = [];
        const rewritten = [];
        const deleted = [];
        for (const file of touchedFiles) {
          const existedBefore = preNames.has(file);
          const existsAfter = postHashes.get(file) !== null;
          if (!existedBefore && existsAfter) created.push(file);
          else if (existedBefore && existsAfter) rewritten.push(file);
          else if (existedBefore && !existsAfter) deleted.push(file);
          // !existedBefore && !existsAfter: net no-op (created then deleted).
        }
        const hashes = {};
        for (const file of [...created, ...rewritten]) hashes[file] = postHashes.get(file);
        for (const file of deleted) hashes[file] = null;
        const operationsMeta = appliedFileOps.map((op) => ({
          file: op.file,
          op: op.op,
          hashAfter: hashes[op.file] ?? null,
        }));
        batchMeta = buildDreamBatchMeta({
          ts: backupName,
          kind: meta.kind,
          ops: counts.write + counts.delete + counts.index,
          planOps: meta.planOps,
          summary: meta.summary,
          sessions: meta.sessions,
          files: [...touched],
          counts,
          durationMs: meta.durationMs,
          inputChars: meta.inputChars,
          outputChars: meta.outputChars,
          usage: meta.usage,
          costExceeded: meta.costExceeded,
          costMode: meta.costMode,
          trigger: meta.trigger,
          operations: operationsMeta,
          created,
          rewritten,
          deleted,
          hashes,
        });
        metaPath = await writeDreamMeta(paths, backupName, batchMeta);
      }
      return { counts, touched, backupDir, backupName, reconcile, metaPath, batchMeta };
    } catch (error) {
      let rollback = null;
      let rollbackError = '';
      try {
        rollback = await selectiveRollbackFromBackup({
          store,
          paths,
          backupDir,
          batchName: backupName,
          expectedHashes,
          preNames,
        });
      } catch (rollbackFailure) {
        rollbackError = errorMessage(rollbackFailure);
        warn('dream rollback', rollbackFailure);
      }
      const failure = new Error(errorMessage(error));
      failure.rolledBack = rollbackError === '';
      failure.rollback = rollback;
      failure.rollbackConflicts = Array.isArray(rollback?.conflicts) ? rollback.conflicts : [];
      failure.rollbackError = rollbackError || undefined;
      failure.backupDir = backupDir;
      failure.backupName = backupName;
      failure.partialCounts = { ...counts };
      failure.partialTouched = touched;
      throw failure;
    }
  }

  /**
   * Undo the most recent applied dream batch (v11 P1-6, hash-guarded).
   *
   * Finds the newest `.dreams/<ts>/meta.json` batch that has not been undone and
   * has v11 per-file hashes. Every recorded hash is compared with the current
   * memory first: any difference aborts the whole undo (`conflict`) without
   * touching disk. After the check the current memory is snapshotted to
   * `.dreams/<ts>-undo-backup/`, files the dream created move to
   * `.trash/<ts>-undo/`, rewritten/deleted files are restored from the batch
   * backup, and `store.reconcileIndex()` repairs the index (MEMORY.md is never
   * overwritten from the backup). Files the dream did not touch (including ones
   * created after the dream) are left exactly as they are.
   *
   * Legacy batches without hashes return `{ok:false, error:'legacy-batch'}`.
   *
   * @param {{pctx?:object, agent?:object}} [options]
   * @returns {Promise<{ok:boolean, batch?:string, restored?:string[],
   *   trashed?:string[], reconciled?:{missing:string[],dangling:string[]},
   *   conflicts?:Array<{file:string,expected:string|null,actual:string|null}>,
   *   error?:string}>}
   */
  async undoLastDream({ pctx, agent } = {}) {
    const project = pctx;
    const paths = project && typeof project === 'object' ? normalizePaths(project.paths) : null;
    const store = project && typeof project === 'object' ? project.store : undefined;
    const state = project && typeof project === 'object' ? project.state : undefined;
    if (!paths || !store || typeof store.writeRawEntry !== 'function') {
      return { ok: false, error: 'no-project' };
    }

    // Same single-writer lock as an apply: undo must not race a dream/tool write.
    let lock;
    try {
      lock = await acquireLock(paths.lockFile, positiveInt(this.config.lockTtlMs, DEFAULT_LIMITS.lockTtlMs));
    } catch (error) {
      return { ok: false, error: 'dream-locked', message: errorMessage(error) };
    }
    if (!lock.ok) return { ok: false, error: 'dream-locked' };

    let failure = true;
    try {
      const batches = await listDreamBatches(paths);
      let batch = '';
      let meta = null;
      for (const name of batches) {
        const candidate = await readDreamMeta(paths, name);
        if (!candidate || candidate.undone === true) continue;
        if (candidate.kind !== 'apply' && candidate.kind !== 'apply-ops') continue;
        batch = name;
        meta = candidate;
        break;
      }
      if (batch === '' || !meta) {
        failure = false;
        return { ok: false, error: 'no-undoable-batch' };
      }

      // v11 P1-6: only batches with per-file hashes are safe to undo.
      const hashes = meta.hashes && typeof meta.hashes === 'object' && !Array.isArray(meta.hashes)
        ? meta.hashes
        : null;
      if (!hashes) {
        failure = false;
        return { ok: false, error: 'legacy-batch' };
      }
      const createdList = Array.isArray(meta.created) ? meta.created.filter(isSafeBatchFileName) : [];
      const rewrittenList = Array.isArray(meta.rewritten) ? meta.rewritten.filter(isSafeBatchFileName) : [];
      const deletedList = Array.isArray(meta.deleted) ? meta.deleted.filter(isSafeBatchFileName) : [];

      // 1. Verify every recorded hash before touching anything: any mismatch
      // aborts the whole undo (no partial restore).
      const conflicts = [];
      for (const [file, expected] of Object.entries(hashes)) {
        if (!isSafeBatchFileName(file)) {
          conflicts.push({ file, expected: typeof expected === 'string' ? expected : null, actual: 'unsafe-path' });
          continue;
        }
        const actual = await hashFileIfExists(path.join(paths.memoryDir, file));
        const expectedHash = typeof expected === 'string' ? expected : null;
        if (actual !== expectedHash) {
          conflicts.push({ file, expected: expectedHash, actual });
        }
      }
      if (conflicts.length > 0) {
        failure = false;
        return { ok: false, error: 'conflict', conflicts };
      }

      const backupDir = path.join(paths.dreamsDir, batch);
      const trashRoot = paths.trashRoot || path.join(paths.projectDir, '.trash');
      const undoTrashDir = path.join(trashRoot, `${batch}-undo`);

      // 2. Snapshot the current memory directory before changing it.
      const undoBackupDir = path.join(paths.dreamsDir, `${batch}-undo-backup`);
      try {
        await fs.rm(undoBackupDir, { recursive: true, force: true });
        await fs.mkdir(undoBackupDir, { recursive: true });
        for (const name of await listTopLevelFiles(paths.memoryDir)) {
          await fs.copyFile(path.join(paths.memoryDir, name), path.join(undoBackupDir, name));
        }
      } catch (error) {
        warn('undo pre-backup', error);
      }

      // 3. Files the dream created: move them to `.trash/<ts>-undo/`.
      const trashed = [];
      if (createdList.length > 0) {
        await fs.mkdir(undoTrashDir, { recursive: true });
      }
      for (const file of createdList) {
        const source = path.join(paths.memoryDir, file);
        const target = path.join(undoTrashDir, file);
        try {
          await fs.rename(source, target);
          trashed.push(file);
        } catch (renameError) {
          if (renameError && renameError.code === 'ENOENT') continue;
          try {
            await fs.copyFile(source, target);
            await fs.unlink(source);
            trashed.push(file);
          } catch (copyError) {
            if (copyError && copyError.code === 'ENOENT') continue;
            warn(`undo trash ${file}`, copyError);
          }
        }
      }

      // 4. Rewritten/deleted files: copy the pre-dream version back from the
      //    batch backup (the hash check above guarantees the current file is
      //    exactly what the dream left, so this cannot clobber newer edits).
      const restored = [];
      for (const file of [...rewrittenList, ...deletedList]) {
        try {
          await fs.copyFile(path.join(backupDir, file), path.join(paths.memoryDir, file));
          restored.push(file);
        } catch (error) {
          if (error && error.code === 'ENOENT') {
            warn(`undo restore ${file}`, new Error('missing in batch backup'));
            continue;
          }
          throw error;
        }
      }

      // 5. Index: reconcile repairs dangling/created lines and re-adds restored
      //    files. MEMORY.md itself is never overwritten from the backup.
      try {
        await reconcileStoreIndex(store);
      } catch (error) {
        warn('undo reconcile', error);
      }
      let reconciled = { missing: [], dangling: [] };
      if (typeof store.auditIndex === 'function') {
        try {
          const audit = await store.auditIndex('project');
          if (audit && typeof audit === 'object') {
            reconciled = {
              missing: Array.isArray(audit.missing)
                ? audit.missing
                  .map((item) => (typeof item === 'string' ? item : item?.file))
                  .filter((file) => typeof file === 'string')
                : [],
              dangling: Array.isArray(audit.dangling)
                ? audit.dangling.filter((item) => typeof item === 'string')
                : [],
            };
          }
        } catch (error) {
          warn('undo audit', error);
        }
      }

      // Changelog: `undo of <batch>` + restored/trashed counts.
      try {
        const entry = formatUndoChangelog({ at: Date.now(), batch, restored, trashed });
        if (typeof store.writeChangelog === 'function') {
          await store.writeChangelog(entry);
        } else {
          await fs.mkdir(path.dirname(paths.changelogFile), { recursive: true });
          await fs.appendFile(paths.changelogFile, entry, 'utf8');
        }
      } catch (error) {
        warn('undo changelog', error);
      }

      // The last dry-run plan is stale now; drop a pending proposal tied to it.
      await callState(state, 'clearLastPlan');
      try {
        const snapshot = safeSnapshot(state);
        const pendingPath = typeof snapshot.pendingProposal === 'string' ? snapshot.pendingProposal : '';
        if (pendingPath !== '') {
          let proposal = null;
          try {
            proposal = JSON.parse(await fs.readFile(pendingPath, 'utf8'));
          } catch {
            proposal = null;
          }
          const references = [
            pendingPath,
            proposal?.batch,
            proposal?.undoOf,
            proposal?.batchTs,
            proposal?.ts,
          ].filter((value) => typeof value === 'string' && value !== '');
          if (references.includes(batch) || proposal?.batch === batch) {
            try {
              await fs.unlink(pendingPath);
            } catch (error) {
              if (!error || error.code !== 'ENOENT') warn('undo pending proposal', error);
            }
            await callState(state, 'clearPendingProposal', { silent: true });
          }
        }
      } catch (error) {
        warn('undo pending cleanup', error);
      }

      // Mark the batch undone so the next undo walks one batch further back.
      try {
        const updated = { ...meta, undone: true, undoneAt: new Date().toISOString() };
        await fs.writeFile(path.join(backupDir, 'meta.json'), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      } catch (error) {
        warn('undo batch meta', error);
      }

      try {
        if (Array.isArray(meta?.sessions) && typeof state?.restoreDreamProcessed === 'function') {
          await state.restoreDreamProcessed(meta.sessions);
        }
      } catch (error) {
        warn('undo session watermark', error);
      }
      this.invalidate(agent, project);
      failure = false;
      return {
        ok: true,
        batch,
        restored,
        trashed,
        reconciled,
        conflicts: [],
        meta,
      };
    } finally {
      try {
        await releaseLock(paths.lockFile, { failure, priorMtime: lock.priorMtime });
      } catch (error) {
        warn('dream lock release', error);
      }
    }
  }

  /** Record one failed applying pass: failure state plus a rollback changelog. */
  async handleApplyFailure(state, store, error, meta) {
    const message = errorMessage(error);
    try {
      await callState(state, 'markDreamFailed', message);
    } catch (stateError) {
      warn('state.markDreamFailed', stateError);
    }
    const backupName = error?.backupDir ? path.basename(error.backupDir) : '';
    const rollbackConflicts = Array.isArray(error?.rollbackConflicts) ? error.rollbackConflicts : [];
    try {
      await store.writeChangelog(formatChangelog({
        at: Date.now(),
        trigger: meta.trigger,
        sessions: meta.sessions,
        counts: error?.partialCounts,
        backupName,
        summary: meta.summary,
        notes: meta.notes,
        dropped: meta.dropped,
        rollback: error?.rolledBack === true,
        rollbackConflicts,
        note: [
          meta.note,
          error?.rolledBack === true
            ? (rollbackConflicts.length > 0
              ? `apply failed; memory restored from backup, ${rollbackConflicts.length} concurrently changed file(s) skipped`
              : 'apply failed; memory restored from backup')
            : 'apply failed; rollback incomplete',
        ].filter(Boolean).join('; '),
        error: message,
      }));
    } catch (changelogError) {
      warn('rollback changelog', changelogError);
    }
  }

  /** Ask the runtime to refresh injected memory for the affected session. */
  invalidate(agent, project) {
    const sessionId = agent && typeof agent.id === 'string'
      ? agent.id
      : (project && typeof project.sessionId === 'string' ? project.sessionId : undefined);
    if (!sessionId || !this.runtime || typeof this.runtime.invalidateInjection !== 'function') return;
    try {
      this.runtime.invalidateInjection(sessionId);
    } catch (error) {
      warn('invalidateInjection', error);
    }
  }

  /**
   * Scan write operations for secrets before they are persisted.
   *
   * `src/secrets.js` is memory-core's module; when it (or its `scanSecrets`
   * export) is unavailable a single warning is emitted and the scan is skipped,
   * so dreaming never blocks on a missing module. `warn` keeps the operation
   * and reports a note; `deny` drops it; `off` skips scanning entirely.
   *
   * @param {object[]} operations normalized operations.
   * @param {object} config resolved plugin config.
   * @returns {Promise<{operations:object[], dropped:string[], warnings:string[], supported:boolean}>}
   */
  async scanOperationSecrets(operations, config) {
    const mode = secretScanMode(config);
    const list = Array.isArray(operations) ? operations : [];
    if (mode === 'off') return { operations: list, dropped: [], warnings: [], supported: false };
    const module = await loadSecretsModule();
    const scan = module && typeof module.scanSecrets === 'function' ? module.scanSecrets : null;
    if (!scan) return { operations: list, dropped: [], warnings: [], supported: false };

    const kept = [];
    const dropped = [];
    const warnings = [];
    for (let index = 0; index < list.length; index += 1) {
      const op = list[index];
      if (!op || op.op !== 'write') {
        kept.push(op);
        continue;
      }
      let scanResult = null;
      try {
        const text = [op.name, op.description, op.body]
          .filter((part) => typeof part === 'string' && part !== '')
          .join('\n');
        scanResult = scan(text);
      } catch (error) {
        warn('secret scan', error);
        kept.push(op);
        continue;
      }
      const matches = Array.isArray(scanResult?.matches) ? scanResult.matches : [];
      if (matches.length === 0 && scanResult?.hasDeny !== true && scanResult?.hasWarn !== true) {
        kept.push(op);
        continue;
      }
      const rules = [...new Set(
        matches
          .map((match) => (match && typeof match.rule === 'string' && match.rule !== '' ? match.rule : 'secret')),
      )];
      const ruleText = rules.join(', ') || 'secret';
      // v11 severity model: unambiguous credential formats always block the
      // write (even in `warn` mode); heuristics only warn, and `deny` mode
      // blocks those too. This mirrors the memory store's policy so a dream op
      // is dropped up-front instead of tripping the store mid-apply.
      let block;
      let shouldWarn;
      if (typeof module.secretScanDecision === 'function') {
        try {
          const decision = module.secretScanDecision(scanResult, config);
          block = decision?.block === true;
          shouldWarn = decision?.warn === true;
        } catch (error) {
          warn('secret scan decision', error);
          block = mode === 'deny';
          shouldWarn = !block;
        }
      } else {
        block = mode === 'deny';
        shouldWarn = !block;
      }
      if (block) {
        dropped.push(`operation #${index + 1}: secret detected (${ruleText}); refused to write ${op.file}`);
        continue;
      }
      if (!shouldWarn) {
        kept.push(op);
        continue;
      }
      // Prefer memory-core's canonical warning text, fall back to a local form.
      let moduleWarnings = [];
      if (typeof module.secretWarnings === 'function') {
        try {
          const lines = module.secretWarnings(matches);
          if (Array.isArray(lines)) {
            moduleWarnings = lines.filter((line) => typeof line === 'string' && line !== '');
          }
        } catch {
          moduleWarnings = [];
        }
      }
      if (moduleWarnings.length > 0) {
        warnings.push(...moduleWarnings);
      } else {
        // Never log the value itself: excerpts are already truncated by the scanner.
        const excerpts = matches
          .map((match) => (match && typeof match.excerpt === 'string' ? match.excerpt.replace(/\s+/g, ' ').trim().slice(0, 12) : ''))
          .filter((excerpt) => excerpt !== '')
          .join(' ');
        warnings.push(`secret-scan: ${ruleText}${excerpts !== '' ? ` (${excerpts})` : ''}`);
      }
      kept.push(op);
    }
    return { operations: kept, dropped, warnings, supported: true };
  }

  /** Existing memory files per scope, for delete validation. */
  async existingFiles(store, config) {
    if (!store || typeof store.listEntries !== 'function') return undefined;
    try {
      const projectEntries = await store.listEntries('project');
      const files = {
        // Names travel with the files so validation can tell a derived write
        // that updates a memory from one that would clobber a same-slug memory.
        project: Array.isArray(projectEntries)
          ? projectEntries
            .filter((entry) => typeof entry?.file === 'string' && entry.file !== '')
            .map((entry) => ({ file: entry.file, name: typeof entry.name === 'string' ? entry.name : '' }))
          : [],
        user: [],
      };
      if (config && config.userMemoryEnabled) {
        try {
          const userEntries = await store.listEntries('user');
          files.user = Array.isArray(userEntries)
            ? userEntries.map((entry) => entry?.file).filter((file) => typeof file === 'string' && file !== '')
            : [];
        } catch {
          files.user = [];
        }
      }
      return files;
    } catch (error) {
      warn('dream existing files', error);
      return undefined;
    }
  }
}
