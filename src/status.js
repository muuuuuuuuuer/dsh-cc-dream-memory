/**
 * Shared status service: the single source of truth for the Host's two status
 * surfaces (`src/http.js` for the Web UI and `src/commands.js` for slash
 * commands).
 *
 * Before this module both surfaces assembled their own payloads, which drifted
 * apart. Everything project-facing now goes through `createStatusService`:
 * status/file/rules/toggle/dream/delete plus the v7 backup/trash/restore
 * operations. The service is stateless: each method receives the resolved
 * project context, and every method validates its input defensively so a caller
 * can never be tricked into reading or restoring outside the project directory.
 *
 * `status()` returns exactly the payload the HTTP `/status` endpoint has always
 * returned (plus the provenance fields v7 adds to `entries`).
 *
 * @module dsh-cc-dream-memory/status
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { VERSION, buildHealth } from './meta.js';
import { NEVER_READ_LIMIT, metricsSummary, metricsTrend, readMetrics, recordWrite } from './metrics.js';
import {
  SECRET_DETECTED,
  scanSecrets,
  secretScanDecision,
  secretScanMode,
  secretWarnings,
} from './secrets.js';
import { approvePendingWrite, listPendingWrites, rejectPendingWrite } from './pending-writes.js';
import { MEMORY_TYPES, slugify } from './store.js';

/** Changelog tail length used by the UI. */
export const DEFAULT_LOG_LINES = 40;
/** Days of daily metrics returned by the trend endpoints by default. */
export const DEFAULT_TREND_DAYS = 7;

/** Config fields the UI needs (no secrets, no paths beyond the memory root). */
export const CONFIG_FIELDS = Object.freeze([
  'enabled',
  'autoMemoryEnabled',
  'autoDreamEnabled',
  'dreamMode',
  'indexMaxLines',
  'indexMaxBytes',
  'dreamAllowDelete',
  'userMemoryEnabled',
  'injectionMode',
  'injectSubagents',
  'rulesMaxChars',
  'dreamMaxTotalTokens',
  'writeMode',
  'policyDuplicateThreshold',
  'policySuggestThreshold',
  'pendingProposalTtlHours',
  'dreamCostMode',
  'projectId',
  'userIndexMaxLines',
  'userIndexMaxBytes',
  'keepHistory',
  'historyMaxPerFile',
  'compactionDigest',
  'subagentWriteMode',
]);

/** State fields the UI needs. */
export const STATE_FIELDS = Object.freeze([
  'lastDreamAt',
  'lastDreamAttemptAt',
  'lastDreamSummary',
  'lastDreamSessions',
  'lastDreamOps',
  'lastDreamMode',
  'lastPlanPath',
  'pendingProposal',
  'lastError',
  'consecutiveFailures',
  'lastDreamDurationMs',
  'lastDreamCostExceeded',
  'lastDreamUsage',
  'counters',
  'sessionsSince',
]);

/** Boolean runtime overrides a caller may toggle. */
export const TOGGLE_FIELDS = Object.freeze([
  'enabled',
  'autoMemoryEnabled',
  'autoDreamEnabled',
  'userMemoryEnabled',
]);

/** Error codes that are caller mistakes (HTTP maps them to 400). */
export const BAD_REQUEST_CODES = Object.freeze([
  'invalid-kind',
  'invalid-id',
  'invalid-file',
  'invalid-files',
  'invalid-indexes',
  'invalid-scope',
  'invalid-query',
  'invalid-name',
  'invalid-path',
  'unknown-action',
  'no-toggle-field',
  'INVALID_ID',
]);

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function pick(source, fields) {
  const out = {};
  for (const field of fields) out[field] = source?.[field];
  return out;
}

/** Convert any result into lossless JSON. */
function lossless(value) {
  try {
    const text = JSON.stringify(value ?? null);
    return text === undefined ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeScope(scope) {
  return scope === 'user' ? 'user' : 'project';
}

/**
 * Shape the v8 metrics summary for the status/web surfaces.
 * The canonical summary keys are kept (the v8 tests read `metrics.injections`),
 * and `inject` is added as the short alias the contract lists for `/status`.
 * @param {object} summary `metricsSummary()` result
 */
function buildMetricsView(summary) {
  const value = summary && typeof summary === 'object' ? summary : {};
  const injections = value.injections ?? { count: 0, lastAt: 0 };
  const dreams = value.dreams && typeof value.dreams === 'object' ? value.dreams : {};
  return {
    since: Number(value.since) || 0,
    updatedAt: Number(value.updatedAt) || 0,
    // Never alias the same object twice: the payload must stay lossless JSON
    // (a shared reference would make status JSON.stringify throw on cycles).
    injections: { ...injections },
    inject: { ...injections },
    reads: value.reads ?? { total: 0, top: [], neverRead: [] },
    writes: value.writes ?? { total: 0 },
    searches: value.searches ?? { count: 0, hits: 0 },
    recalls: value.recalls ?? { count: 0, files: 0, lastAt: 0 },
    adoptions: value.adoptions ?? { count: 0, lastAt: 0 },
    dreams: {
      proposed: Number(dreams.proposed) || 0,
      applied: Number(dreams.applied) || 0,
      rejected: Number(dreams.rejected) || 0,
      failed: Number(dreams.failed) || 0,
      acceptanceRate: Number(dreams.acceptanceRate) || 0,
      appliedOps: Number(dreams.appliedOps) || 0,
      quality: dreams.quality && typeof dreams.quality === 'object'
        ? {
            appliedOps: Number(dreams.quality.appliedOps) || 0,
            planOps: Number(dreams.quality.planOps) || 0,
            dropped: Number(dreams.quality.dropped) || 0,
            rollbacks: Number(dreams.quality.rollbacks) || 0,
            applyRate: Number(dreams.quality.applyRate) || 0,
            dropRate: Number(dreams.quality.dropRate) || 0,
          }
        : { appliedOps: 0, planOps: 0, dropped: 0, rollbacks: 0, applyRate: 0, dropRate: 0 },
    },
    costs: value.costs ?? {
      lastDurationMs: 0,
      lastInputChars: 0,
      lastOutputChars: 0,
      lastUsage: null,
    },
  };
}

/** Cached dynamic import of the dream-engine readiness module (may not exist yet). */
let readinessModulePromise = null;
function loadReadinessModule() {
  if (readinessModulePromise === null) {
    readinessModulePromise = import('./readiness.js').catch(() => null);
  }
  return readinessModulePromise;
}

/** Cached dynamic import of the Claude Code import/export module (v10). */
let importExportModulePromise = null;
function loadImportExportModule() {
  if (importExportModulePromise === null) {
    importExportModulePromise = import('./import-export.js').catch(() => null);
  }
  return importExportModulePromise;
}

/**
 * Is this agent a delegated subagent? v9/v10 rely on the session header the
 * Host attaches to child sessions; every access is defensive because tests and
 * older Host builds may use a partial agent shape.
 * @param {object|undefined} agent
 * @returns {boolean}
 */
export function isSubagentAgent(agent) {
  if (!agent || typeof agent !== 'object') return false;
  const session = agent.session;
  const header = session && typeof session === 'object' ? session.header : undefined;
  if (header && typeof header === 'object') {
    if (typeof header.parentSession === 'string' && header.parentSession !== '') return true;
    if (header.origin === 'subagent') return true;
  }
  if (session && typeof session === 'object' && session.origin === 'subagent') return true;
  return agent.origin === 'subagent';
}

/**
 * Should a write be refused because this is a read-only subagent?
 * @param {object|undefined} agent
 * @param {object} config resolved plugin config
 * @returns {boolean}
 */
export function subagentWriteBlocked(agent, config) {
  const mode = config && typeof config === 'object' ? config.subagentWriteMode : undefined;
  return mode === 'off' && isSubagentAgent(agent);
}

/**
 * Compact pending-write view shared by `/status`, `GET /pending-writes` and the
 * commands/UI. `includeContent` adds the candidate body (needed by nothing that
 * only lists; approve reads the record itself).
 * @param {object[]} records `listPendingWrites()` output
 * @param {{limit?:number, includeContent?:boolean}} [options]
 * @returns {{count:number, items:object[]}}
 */
export function pendingWritesView(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const limitValue = Number(options.limit);
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.trunc(limitValue) : 50;
  const includeContent = options.includeContent === true;
  const items = list.slice(0, limit).map((record) => ({
    id: record.id,
    createdAt: record.createdAt,
    reasons: Array.isArray(record.reasons) ? record.reasons : [],
    candidate: {
      name: record.candidate?.name ?? '',
      type: record.candidate?.type ?? '',
      description: record.candidate?.description ?? '',
      ...(includeContent
        ? { content: record.candidate?.content ?? '', scope: record.candidate?.scope ?? 'project' }
        : {}),
    },
    source: typeof record.source === 'string'
      ? record.source
      : record.source && typeof record.source === 'object'
        ? { ...record.source }
        : '',
  }));
  return { count: list.length, items };
}

/**
 * Dream readiness from the dream-engine readiness module, when installed.
 * @returns {Promise<object|null>}
 */
export async function readinessFor(pctx, config) {
  const module = await loadReadinessModule();
  if (!module || typeof module.dreamReadiness !== 'function') return null;
  try {
    return lossless(await module.dreamReadiness(pctx, { config, now: Date.now() }));
  } catch {
    return null;
  }
}

/**
 * Memory health (score/dimensions/suggestions) from the readiness module, when
 * installed.
 * @returns {Promise<object|null>}
 */
export async function memoryHealthFor(pctx, config) {
  const module = await loadReadinessModule();
  if (!module || typeof module.memoryHealth !== 'function') return null;
  try {
    return lossless(await module.memoryHealth(pctx, { config }));
  } catch {
    return null;
  }
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Last `count` non-empty lines of a text file ('' when the file is absent). */
export async function readTail(file, count) {
  try {
    const text = await fs.readFile(file, 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line !== '');
    return lines.slice(-Math.max(1, Math.trunc(count))).join('\n');
  } catch {
    return '';
  }
}

/** Parse a dream-batch directory name into a millisecond timestamp. */
function backupTimestamp(name) {
  const iso = name.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1T$2:$3:$4');
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Normalize one `rulesFor()` result into the stable rules payload.
 * @param {unknown} value
 * @param {object} pctx
 */
function normalizeRules(value, pctx) {
  const projectPath = String(pctx?.paths?.projectRulesFile ?? '');
  const globalPath = String(pctx?.paths?.globalRulesFile ?? '');
  if (!value || typeof value !== 'object') {
    return { text: '', source: 'unavailable', projectPath, globalPath, maxChars: 0, truncated: false };
  }
  return {
    text: typeof value.text === 'string' ? value.text : '',
    source: typeof value.source === 'string' ? value.source : 'default',
    projectPath: typeof value.projectPath === 'string' ? value.projectPath : projectPath,
    globalPath: typeof value.globalPath === 'string' ? value.globalPath : globalPath,
    maxChars: Number(value.maxChars) || 0,
    truncated: value.truncated === true,
  };
}

/**
 * Validate one single path component (a backup/trash batch id or a file name).
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function safeComponent(value, label) {
  if (typeof value !== 'string') throw coded('invalid-id', `${label} is required`);
  const name = value.trim();
  if (
    name === '' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    path.isAbsolute(name)
  ) {
    throw coded('invalid-id', `invalid ${label}: ${String(value)}`);
  }
  return name;
}

/** Parse a batch directory name into a millisecond timestamp. */
function timestampOf(name, fallback) {
  const iso = name.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1T$2:$3:$4');
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * List timestamped batches (dream backups or trash batches) newest first.
 * @param {string} baseDir
 * @returns {Promise<Array<{id:string, at:number, files:string[]}>>}
 */
export async function listBatches(baseDir) {
  if (typeof baseDir !== 'string' || baseDir === '') return [];
  let names;
  try {
    names = await fs.readdir(baseDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const items = [];
  for (const name of names) {
    const dir = path.join(baseDir, name);
    let info;
    try {
      info = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    let files = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((file) => !file.endsWith('.reason.txt'))
        .sort();
    } catch {
      files = [];
    }
    items.push({ id: name, at: timestampOf(name, info.mtimeMs), files });
  }
  items.sort((left, right) => right.at - left.at || right.id.localeCompare(left.id));
  return items;
}

/**
 * Normalize operation indexes from an array, a comma string or a whitespace
 * string. Returns `undefined` for invalid input.
 * @param {unknown} value
 * @returns {number[]|undefined}
 */
export function normalizeIndexes(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/u).filter((item) => item !== '')
      : undefined;
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set();
  const indexes = [];
  for (const item of raw) {
    const number = Number(item);
    if (!Number.isInteger(number) || number < 0) return undefined;
    if (!seen.has(number)) {
      seen.add(number);
      indexes.push(number);
    }
  }
  return indexes.length > 0 ? indexes : undefined;
}

/**
 * Build the status service for one runtime.
 * @param {object} runtime `MemoryRuntime` (or a minimal object with the same
 *   methods); every method degrades to a coded error instead of crashing.
 * @returns {{status:Function, file:Function, rules:Function, saveRules:Function,
 *   resetRules:Function, toggle:Function, dream:Function, deleteFile:Function,
 *   backups:Function, trash:Function, restore:Function}}
 */
export function createStatusService(runtime) {
  const rt = runtime && typeof runtime === 'object' ? runtime : {};

  const configOf = () => (rt.config && typeof rt.config === 'object' ? rt.config : {});

  function requireStore(pctx) {
    const store = pctx?.store;
    if (!store || typeof store !== 'object') {
      throw coded('no-project', 'the memory store is unavailable for this project');
    }
    return store;
  }

  function overridesOf() {
    try {
      if (typeof rt.overrides === 'function') {
        const value = rt.overrides();
        if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
      }
    } catch {
      /* fall through to an empty override set */
    }
    return {};
  }

  function invalidate(pctx, reason) {
    try {
      if (typeof rt.invalidateInjection === 'function') {
        rt.invalidateInjection(pctx?.sessionId ?? '', reason);
      }
    } catch {
      /* cache invalidation is best-effort */
    }
  }

  function invalidateAll(reason) {
    try {
      if (typeof rt.invalidateAllInjections === 'function') rt.invalidateAllInjections(reason);
    } catch {
      /* cache invalidation is best-effort */
    }
  }

  /** Scan rules text and enforce the v11 secret-severity policy. */
  function scanRulesText(text) {
    const config = configOf();
    const mode = secretScanMode(config);
    if (mode === 'off') return [];
    const scan = scanSecrets(text);
    const decision = secretScanDecision(scan, config);
    const warnings = secretWarnings(scan.matches);
    if (decision.block) {
      const error = coded(SECRET_DETECTED, `refusing to save rules: possible secret detected (${warnings.join('; ')})`);
      error.matches = scan.matches;
      throw error;
    }
    return warnings;
  }

  /**
   * Build the `/status` metrics view from one already-loaded entry list.
   * @param {object} pctx
   * @param {object[]} entries current project entries
   */
  async function metricsForEntries(pctx, entries) {
    const files = (Array.isArray(entries) ? entries : [])
      .map((entry) => (entry && typeof entry.file === 'string' ? entry.file : ''))
      .filter((file) => file !== '');
    const raw = await readMetrics(pctx?.paths);
    return buildMetricsView(
      metricsSummary(raw, { files, topLimit: 5, neverReadLimit: NEVER_READ_LIMIT }),
    );
  }

  /**
   * Effect metrics for one project: injections, reads (with top/neverRead),
   * writes, searches, dream acceptance and the last dream cost.
   * @param {object} pctx project context
   */
  async function metrics(pctx) {
    const store = requireStore(pctx);
    const entries = await store.listEntries('project');
    return metricsForEntries(pctx, entries);
  }

  /**
   * Full metrics report: canonical summary, 7-day (default) daily trend and
   * dream quality. The status/web view is included for convenience.
   * @param {object} pctx
   * @param {{days?:number}} [options]
   */
  async function metricsReport(pctx, options = {}) {
    const store = requireStore(pctx);
    const entries = await store.listEntries('project');
    const raw = await readMetrics(pctx?.paths);
    const files = entries.map((entry) => entry.file).filter((file) => typeof file === 'string' && file !== '');
    const summary = metricsSummary(raw, { files, topLimit: 5, neverReadLimit: NEVER_READ_LIMIT });
    const daysValue = Number(options.days);
    const days =
      Number.isFinite(daysValue) && daysValue > 0 ? Math.min(60, Math.trunc(daysValue)) : DEFAULT_TREND_DAYS;
    const trend = metricsTrend(raw, { days });
    return {
      summary,
      trend,
      quality: summary.dreams.quality,
      days,
      metrics: { ...buildMetricsView(summary), trend },
    };
  }

  /**
   * Ranked search with pagination. The store computes the ranked hits; `total`
   * is the number of matches before the offset/limit window.
   * @param {object} pctx
   * @param {{query:string,limit?:number,offset?:number,type?:string,scope?:string}} [options]
   */
  async function search(pctx, options = {}) {
    const store = requireStore(pctx);
    const query = typeof options.query === 'string' ? options.query : '';
    if (query.trim() === '') throw coded('invalid-query', 'a search query is required');
    const limitValue = Number(options.limit);
    const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(200, Math.trunc(limitValue)) : 20;
    const offsetValue = Number(options.offset);
    const offset = Number.isFinite(offsetValue) && offsetValue > 0 ? Math.trunc(offsetValue) : 0;
    const all = await store.search(query, {
      scope: normalizeScope(options.scope),
      type: options.type,
      limit: 200,
      offset: 0,
    });
    return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
  }

  /**
   * Create or update one memory file from the editor (v10).
   * Updates keep the original `created`/provenance and record `via:'api:edit'`;
   * creation names the file exactly like a tool save. Secret scanning and size
   * limits are enforced by the store.
   * @param {object} pctx
   * @param {{file?:string,scope?:string,name?:string,type?:string,
   *   description?:string,content?:string}} [input]
   */
  async function writeFile(pctx, input = {}) {
    const store = requireStore(pctx);
    const scope = normalizeScope(input.scope);
    const file = typeof input.file === 'string' ? input.file.trim() : '';
    const source = { via: 'api:edit', sessionId: typeof pctx?.sessionId === 'string' ? pctx.sessionId : '' };
    if (file === '') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name === '') throw coded('invalid-name', 'a memory name is required to create a file');
      const type = MEMORY_TYPES.includes(input.type) ? input.type : 'user';
      const result = await store.saveEntry({
        scope,
        name,
        type,
        description: typeof input.description === 'string' ? input.description : '',
        content: typeof input.content === 'string' ? input.content : '',
        source,
      });
      const entry = await store.readEntry(result.file, scope);
      try {
        await recordWrite(pctx?.paths, result.file);
      } catch {
        /* metrics are best-effort */
      }
      invalidate(pctx, 'edit');
      invalidateAll('edit');
      return { ok: true, file: result.file, entry, created: result.created === true };
    }
    let existing = null;
    try {
      existing = await store.readEntry(file, scope);
    } catch (error) {
      if (error?.code !== 'NOT_FOUND') throw error;
      existing = null;
    }
    const name =
      typeof input.name === 'string' && input.name.trim() !== ''
        ? input.name.trim()
        : existing?.frontmatter?.name;
    if (typeof name !== 'string' || name === '') {
      throw coded('not-found', `memory file not found: ${file}`);
    }
    const type = MEMORY_TYPES.includes(input.type) ? input.type : existing?.frontmatter?.type ?? 'user';
    const description =
      typeof input.description === 'string'
        ? input.description
        : typeof existing?.frontmatter?.description === 'string'
          ? existing.frontmatter.description
          : '';
    const content = typeof input.content === 'string' ? input.content : existing?.body ?? '';
    const result = await store.writeRawEntry(file, {
      scope,
      type,
      name,
      description,
      body: content,
      source,
    });
    const entry = await store.readEntry(result.file, scope);
    try {
      await recordWrite(pctx?.paths, result.file);
    } catch {
      /* metrics are best-effort */
    }
    invalidate(pctx, 'edit');
    invalidateAll('edit');
    return { ok: true, file: result.file, entry, created: result.created === true };
  }

  /**
   * Merge two or more memory files into one: each source body becomes a
   * `## <name>` section of the new file, the sources move to the trash and the
   * index is reconciled.
   * @param {object} pctx
   * @param {{files:string[],scope?:string,name?:string,type?:string,description?:string}} [input]
   */
  async function mergeFiles(pctx, input = {}) {
    const store = requireStore(pctx);
    const scope = normalizeScope(input.scope);
    const requested = Array.isArray(input.files) ? input.files : [];
    const files = [...new Set(requested.map((file) => (typeof file === 'string' ? file.trim() : '')).filter(Boolean))];
    if (files.length < 2) throw coded('invalid-files', 'at least two memory files are required to merge');
    const name =
      typeof input.name === 'string' && input.name.trim() !== ''
        ? input.name.trim()
        : files.map((file) => file.replace(/\.md$/i, '')).join(' + ').slice(0, 200);
    const type = MEMORY_TYPES.includes(input.type) ? input.type : 'user';
    const description =
      typeof input.description === 'string' && input.description !== ''
        ? input.description
        : `Merged from ${files.length} memories`;
    const sections = [];
    for (const file of files) {
      let entry;
      try {
        entry = await store.readEntry(file, scope);
      } catch (error) {
        throw coded('not-found', `memory file not found: ${file}`);
      }
      const sectionName =
        typeof entry.frontmatter?.name === 'string' && entry.frontmatter.name !== ''
          ? entry.frontmatter.name
          : file.replace(/\.md$/i, '');
      const body = typeof entry.body === 'string' ? entry.body.trim() : '';
      sections.push(`## ${sectionName}\n\n${body}`);
    }
    const result = await store.saveEntry({
      scope,
      name,
      type,
      description,
      content: sections.join('\n\n'),
      source: { via: 'api:merge', sessionId: typeof pctx?.sessionId === 'string' ? pctx.sessionId : '' },
    });
    const trashed = [];
    for (const file of files) {
      if (file === result.file) continue;
      try {
        const trashedEntry = await store.trashEntry(file, {
          scope,
          reason: `merged into ${result.file}`,
        });
        trashed.push(trashedEntry.file);
      } catch (error) {
        if (error?.code !== 'NOT_FOUND') throw error;
      }
    }
    let reconciled = { missing: [], dangling: [] };
    if (typeof store.reconcileIndex === 'function') {
      const audit = await store.reconcileIndex(scope);
      reconciled = {
        missing: Array.isArray(audit?.appended) ? audit.appended : [],
        dangling: Array.isArray(audit?.removed) ? audit.removed : [],
      };
    }
    try {
      await recordWrite(pctx?.paths, result.file);
    } catch {
      /* metrics are best-effort */
    }
    invalidateAll('merge');
    const entry = await store.readEntry(result.file, scope);
    return { ok: true, file: result.file, entry, trashed, reconciled };
  }

  /**
   * Audit one memory file: provenance, changelog lines that mention it and the
   * dream/pending plan references that include it.
   * @param {object} pctx
   * @param {string} file
   */
  async function fileHistory(pctx, file) {
    const store = requireStore(pctx);
    const target = typeof file === 'string' ? file.trim() : '';
    if (target === '') throw coded('invalid-file', 'a memory file name is required');
    let entry;
    try {
      entry = await store.readEntry(target, 'project');
    } catch (error) {
      throw coded('not-found', `memory file not found: ${target}`);
    }
    const provenance = {
      created: entry.frontmatter?.created ?? '',
      sourceSession: entry.frontmatter?.source_session ?? '',
      via: entry.frontmatter?.via ?? '',
    };
    const changelog = [];
    try {
      const text = await fs.readFile(pctx.paths.changelogFile, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed !== '' && trimmed.includes(target)) changelog.push(trimmed);
      }
    } catch {
      /* no changelog yet */
    }
    const planRefs = [];
    try {
      const names = await fs.readdir(pctx.paths.dreamsDir);
      for (const name of names) {
        const batchDir = path.join(pctx.paths.dreamsDir, name);
        let info;
        try {
          info = await fs.stat(batchDir);
        } catch {
          continue;
        }
        if (!info.isDirectory()) continue;
        let meta = null;
        try {
          const parsed = JSON.parse(await fs.readFile(path.join(batchDir, 'meta.json'), 'utf8'));
          if (parsed && typeof parsed === 'object') meta = parsed;
        } catch {
          meta = null;
        }
        let files = Array.isArray(meta?.files) ? meta.files.filter((item) => typeof item === 'string') : null;
        if (files === null) {
          try {
            files = (await fs.readdir(batchDir)).filter((name2) => name2.endsWith('.md'));
          } catch {
            files = [];
          }
        }
        if (!files.includes(target)) continue;
        planRefs.push({
          type: 'dream',
          id: name,
          ts: typeof meta?.ts === 'string' ? meta.ts : name,
          kind: typeof meta?.kind === 'string' ? meta.kind : '',
          appliedAt: Number(meta?.appliedAt) || 0,
          ops: Number(meta?.ops) || 0,
        });
      }
    } catch {
      /* no dream batches */
    }
    try {
      const records = await listPendingWrites(pctx.paths);
      for (const record of records) {
        const candidate = record.candidate;
        if (!candidate || typeof candidate.name !== 'string' || candidate.name === '') continue;
        const type = MEMORY_TYPES.includes(candidate.type) ? candidate.type : 'user';
        if (`${type}_${slugify(candidate.name)}.md` === target) {
          planRefs.push({
            type: 'pending',
            id: record.id,
            createdAt: record.createdAt,
            reasons: record.reasons,
          });
        }
      }
    } catch {
      /* pending queue unavailable */
    }
    planRefs.sort((left, right) => {
      const leftAt = Number(left.appliedAt || left.createdAt || 0);
      const rightAt = Number(right.appliedAt || right.createdAt || 0);
      return rightAt - leftAt;
    });
    return { ok: true, file: target, provenance, changelog: changelog.slice(-20), planRefs };
  }

  /**
   * Dream batches (newest first) from `<projectDir>/.dreams/`. Old batches
   * without `meta.json` are listed read-only (`undoable:false`).
   * @param {object} pctx
   */
  async function dreamHistory(pctx) {
    const dir = pctx?.paths?.dreamsDir;
    if (typeof dir !== 'string' || dir === '') return { ok: true, items: [] };
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, items: [] };
      throw error;
    }
    const items = [];
    for (const name of names) {
      const batchDir = path.join(dir, name);
      let info;
      try {
        info = await fs.stat(batchDir);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      let meta = null;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(batchDir, 'meta.json'), 'utf8'));
        if (parsed && typeof parsed === 'object') meta = parsed;
      } catch {
        meta = null;
      }
      let files = Array.isArray(meta?.files) ? meta.files.filter((item) => typeof item === 'string') : null;
      if (files === null) {
        try {
          files = (await fs.readdir(batchDir)).filter((file) => file.endsWith('.md'));
        } catch {
          files = [];
        }
      }
      const kind = typeof meta?.kind === 'string' ? meta.kind : '';
      const appliedAt = Number(meta?.appliedAt) || 0;
      // v11: alignment with dream.js — only batches with a non-empty `hashes`
      // map can be undone safely (old-format batches are listed read-only).
      const hashes = meta?.hashes && typeof meta.hashes === 'object' && !Array.isArray(meta.hashes)
        ? meta.hashes
        : null;
      const applied =
        meta !== null &&
        Number.isFinite(appliedAt) &&
        appliedAt > 0 &&
        (kind === 'apply' || kind === 'apply-ops') &&
        hashes !== null &&
        Object.keys(hashes).length > 0;

      items.push({
        ts: name,
        at: backupTimestamp(name) || info.mtimeMs,
        kind,
        appliedAt,
        ops: Number(meta?.ops) || 0,
        summary: typeof meta?.summary === 'string' ? meta.summary : '',
        files,
        // An already-undone batch stays listed but cannot be undone again.
        undoable: applied && meta?.undone !== true,
        undone: meta?.undone === true,
        hasMeta: meta !== null,
        durationMs: Number(meta?.durationMs) || 0,
        inputChars: Number(meta?.inputChars) || 0,
        outputChars: Number(meta?.outputChars) || 0,
        usage: meta?.usage && typeof meta.usage === 'object' ? { ...meta.usage } : null,
      });
    }
    items.sort(
      (left, right) => right.appliedAt - left.appliedAt || right.at - left.at || right.ts.localeCompare(left.ts),
    );
    return { ok: true, items };
  }

  /**
   * Import a Claude Code memory directory through `src/import-export.js`
   * (dynamic import; older builds answer `not-ready`).
   * @param {object} pctx
   * @param {{sourceDir?:string,path?:string}} [request]
   */
  async function importMemory(pctx, request = {}) {
    const store = requireStore(pctx);
    const sourceDir = String(request?.sourceDir ?? request?.path ?? '').trim();
    if (sourceDir === '') throw coded('invalid-path', 'a source directory path is required');
    const module = await loadImportExportModule();
    if (!module || typeof module.importClaudeMemory !== 'function') {
      throw coded('not-ready', 'Claude Code memory import is not available in this build');
    }
    const result = await module.importClaudeMemory({ paths: pctx.paths, sourceDir, store });
    if (result && result.ok === false) {
      throw coded(
        typeof result.error === 'string' ? result.error : 'import-failed',
        `import failed: ${result.error ?? 'unknown error'}`,
      );
    }
    const imported = Array.isArray(result?.imported) ? result.imported : [];
    for (const file of imported) {
      try {
        await recordWrite(pctx.paths, file);
      } catch {
        /* metrics are best-effort */
      }
    }
    invalidateAll('import');
    return {
      ok: true,
      imported,
      skipped: Array.isArray(result?.skipped) ? result.skipped : [],
      errors: Array.isArray(result?.errors) ? result.errors : [],
      sourceDir: typeof result?.sourceDir === 'string' ? result.sourceDir : sourceDir,
    };
  }

  /**
   * Export this project's memory into a Claude Code layout through
   * `src/import-export.js` (dynamic import; older builds answer `not-ready`).
   * @param {object} pctx
   * @param {{targetDir?:string,path?:string}} [request]
   */
  async function exportMemory(pctx, request = {}) {
    const store = requireStore(pctx);
    const targetDir = String(request?.targetDir ?? request?.path ?? '').trim();
    if (targetDir === '') throw coded('invalid-path', 'a target directory path is required');
    const module = await loadImportExportModule();
    if (!module || typeof module.exportClaudeMemory !== 'function') {
      throw coded('not-ready', 'Claude Code memory export is not available in this build');
    }
    const result = await module.exportClaudeMemory({ paths: pctx.paths, targetDir, store });
    if (result && result.ok === false) {
      throw coded(
        typeof result.error === 'string' ? result.error : 'export-failed',
        `export failed: ${result.error ?? 'unknown error'}`,
      );
    }
    const exportedFiles = Array.isArray(result?.exported) ? result.exported : [];
    return {
      ok: true,
      // The HTTP contract reports a count; the file list rides along for the UI.
      exported: exportedFiles.length,
      exportedFiles,
      targetDir,
      rules: result?.rules === true,
    };
  }

  /** Per-session injection mode view (`live` when the session override is on). */
  function sessionView(pctx, sessionId) {
    const id = typeof sessionId === 'string' && sessionId !== ''
      ? sessionId
      : typeof pctx?.sessionId === 'string'
        ? pctx.sessionId
        : typeof pctx?.agent?.id === 'string'
          ? pctx.agent.id
          : '';
    let live = false;
    try {
      if (typeof rt.sessionMode === 'function') live = rt.sessionMode(id) === 'live';
    } catch {
      live = false;
    }
    return { live, mode: live ? 'live' : 'auto' };
  }

  /**
   * The canonical `/status` payload.
   * @param {object} pctx project context
   * @param {{sessionId?:string}} [options]
   */
  async function status(pctx, options = {}) {
    const config = configOf();
    const store = requireStore(pctx);
    const index = await store.injectedIndex('project');
    const entries = await store.listEntries('project');
    let userEntries = [];
    let userUsage = {
      lines: 0,
      bytes: 0,
      truncated: false,
      overflow: false,
      maxLines: Number(config.userIndexMaxLines) || 30,
      maxBytes: Number(config.userIndexMaxBytes) || 4096,
    };
    if (config.userMemoryEnabled === true) {
      try {
        userEntries = await store.listEntries('user');
      } catch {
        userEntries = [];
      }
      try {
        const injectedUser = await store.injectedIndex('user');
        userUsage = {
          lines: injectedUser.lines,
          bytes: injectedUser.bytes,
          truncated: injectedUser.truncated,
          overflow: injectedUser.overflow,
          maxLines: injectedUser.maxLines,
          maxBytes: injectedUser.maxBytes,
        };
      } catch {
        /* keep the empty usage shape */
      }
    }
    let trashCount = 0;
    try {
      trashCount = typeof store.countTrash === 'function' ? await store.countTrash() : 0;
    } catch {
      trashCount = 0;
    }
    const changelogTail = await readTail(pctx?.paths?.changelogFile, DEFAULT_LOG_LINES);
    const rulesValue = rules(pctx);
    const metricsValue = await metricsForEntries(pctx, entries);
    const health = await buildHealth({ runtime: rt, projectContext: pctx, rules: rulesValue });
    const snapshot =
      pctx?.state && typeof pctx.state.snapshot === 'function' ? pctx.state.snapshot() : {};

    // v9: pending-write queue, dream readiness / memory health (defensive: the
    // readiness module may not be installed yet) and per-session live mode.
    let pendingWrites = { count: 0, items: [] };
    try {
      pendingWrites = pendingWritesView(await listPendingWrites(pctx?.paths), { limit: 50 });
    } catch {
      pendingWrites = { count: 0, items: [] };
    }
    const readiness = await readinessFor(pctx, config);
    const memoryHealth = await memoryHealthFor(pctx, config);
    const session = sessionView(pctx, options?.sessionId);
    const healthValue = health && typeof health === 'object' ? { ...health } : health;
    if (healthValue && memoryHealth) healthValue.memoryHealth = memoryHealth;
    // v10: 7-day daily trend rides along with the metrics view (the UI renders
    // it; `GET /metrics?days=N` returns the same trend for other windows).
    const metricsTrendValue = metricsTrend(await readMetrics(pctx?.paths), { days: DEFAULT_TREND_DAYS });
    const metricsView = { ...metricsValue, trend: metricsTrendValue };

    return {
      ok: true,
      version: VERSION,
      project: {
        projectRoot: String(pctx?.paths?.projectRoot ?? ''),
        memoryDir: String(pctx?.paths?.memoryDir ?? ''),
        projectId: String(pctx?.paths?.projectId ?? pctx?.identity?.projectId ?? ''),
      },
      config: pick(config, CONFIG_FIELDS),
      overrides: overridesOf(),
      index: {
        text: index.text,
        lines: index.lines,
        bytes: index.bytes,
        truncated: index.truncated,
        overflow: index.overflow,
        maxLines: index.maxLines,
        maxBytes: index.maxBytes,
      },
      entries,
      userScope: {
        enabled: config.userMemoryEnabled === true,
        entries: userEntries,
        budgets: {
          maxLines: Number(config.userIndexMaxLines) || 0,
          maxBytes: Number(config.userIndexMaxBytes) || 0,
        },
        usage: userUsage,
      },
      state: pick(snapshot, STATE_FIELDS),
      changelogTail,
      trashCount,
      rules: rulesValue,
      metrics: metricsView,
      pendingWrites,
      readiness,
      healthScore: memoryHealth && Number.isFinite(Number(memoryHealth.score)) ? Number(memoryHealth.score) : null,
      session,
      subagentPolicy: {
        injectSubagents: config.injectSubagents !== false,
        mode: config.subagentWriteMode === 'off' ? 'off' : 'shared',
      },
      health: healthValue,
    };
  }

  /** Full contents of one memory file (provenance included in `frontmatter`). */
  async function file(pctx, file, scope) {
    const store = requireStore(pctx);
    if (typeof file !== 'string' || file.trim() === '') {
      throw coded('invalid-file', 'a memory file name is required');
    }
    return store.readEntry(file.trim(), normalizeScope(scope));
  }

  /** The rules actually injected for this project. */
  function rules(pctx) {
    try {
      if (typeof rt.rulesFor === 'function') return normalizeRules(rt.rulesFor(pctx), pctx);
    } catch {
      /* fall through to the unavailable shape */
    }
    return normalizeRules(undefined, pctx);
  }

  /**
   * Persist one rules override. `deny` secret scanning refuses the write with
   * code `SECRET_DETECTED`; `warn` returns the rules plus a `warnings` array.
   */
  async function saveRules(pctx, scope, text, options = {}) {
    const targetScope = scope === undefined || scope === null ? 'project' : String(scope).toLowerCase();
    if (targetScope !== 'project' && targetScope !== 'global') {
      throw coded('invalid-scope', `rules scope must be "project" or "global": ${String(scope)}`);
    }
    const value = typeof text === 'string' ? text : '';
    const warnings = scanRulesText(value);
    if (typeof rt.saveRules !== 'function') {
      throw coded('unavailable', 'this runtime cannot persist rules');
    }
    const updated = await rt.saveRules(pctx, targetScope, value, { source: options?.source || 'api' });
    const normalized = normalizeRules(updated, pctx);
    if (warnings.length > 0) normalized.warnings = warnings;
    return normalized;
  }

  /** Remove one rules override and return the effective rules. */
  async function resetRules(pctx, scope, options = {}) {
    const targetScope = scope === undefined || scope === null ? 'project' : String(scope).toLowerCase();
    if (targetScope !== 'project' && targetScope !== 'global') {
      throw coded('invalid-scope', `rules scope must be "project" or "global": ${String(scope)}`);
    }
    if (typeof rt.resetRules !== 'function') {
      throw coded('unavailable', 'this runtime cannot reset rules');
    }
    const updated = await rt.resetRules(pctx, targetScope, { source: options?.source || 'api' });
    return normalizeRules(updated, pctx);
  }

  /**
   * Merge boolean runtime overrides and report the effective config.
   * @param {object} targetRuntime runtime to mutate (defaults to the service's).
   * @param {{enabled?:boolean,autoMemoryEnabled?:boolean,autoDreamEnabled?:boolean}} patch
   */
  async function toggle(targetRuntime, patch) {
    const target = targetRuntime && typeof targetRuntime === 'object' ? targetRuntime : rt;
    if (typeof target.setOverrides !== 'function') {
      throw coded('unavailable', 'runtime overrides are unavailable in this build');
    }
    const clean = {};
    for (const key of TOGGLE_FIELDS) {
      if (patch && typeof patch[key] === 'boolean') clean[key] = patch[key];
    }
    if (Object.keys(clean).length === 0) {
      throw coded('no-toggle-field', `patch must set one of ${TOGGLE_FIELDS.join(', ')}`);
    }
    const overrides = await target.setOverrides(clean);
    const config = target.config && typeof target.config === 'object' ? target.config : {};
    return { overrides, config: pick(config, TOGGLE_FIELDS) };
  }

  /**
   * Dispatch one dream action. Returns `{ok:true, result}` on success and
   * `{ok:false, error:'not-ready'}` when the v7 dream-engine methods are not
   * installed yet, so new endpoints/commands never crash an older build.
   * @param {object} pctx
   * @param {{agent?:object,sessionId?:string,action?:string,indexes?:unknown,
   *   trigger?:string,reason?:string}} [options]
   */
  async function dream(pctx, options = {}) {
    const action = String(options.action ?? 'run').toLowerCase();
    const agent = options.agent ?? pctx?.agent;
    if (action === 'estimate') {
      if (typeof rt.estimateDream !== 'function') return { ok: false, error: 'not-ready', message: 'Dream cost preview is unavailable' };
      return { ok: true, result: lossless(await rt.estimateDream(pctx, { focus: options.focus ?? '' })) };
    }
    if (action === 'preview') {
      if (typeof rt.previewPlan !== 'function') {
        return {
          ok: false,
          error: 'not-ready',
          message: 'dream plan preview is not available in this build yet (waiting for the dream engine)',
        };
      }
      return { ok: true, result: lossless(await rt.previewPlan(pctx)) };
    }
    if (action === 'apply-ops' || action === 'apply-operations') {
      if (typeof rt.applyPlanOperations !== 'function') {
        return {
          ok: false,
          error: 'not-ready',
          message: 'per-operation apply is not available in this build yet (waiting for the dream engine)',
        };
      }
      const indexes = normalizeIndexes(options.indexes);
      if (indexes === undefined) {
        throw coded('invalid-indexes', 'indexes must be a non-empty array of operation numbers');
      }
      return { ok: true, result: lossless(await rt.applyPlanOperations(pctx, { indexes, agent })) };
    }
    if (action === 'run' || action === 'dry-run') {
      if (typeof rt.dream !== 'function') {
        return { ok: false, error: 'dream-unavailable', message: 'this runtime has no dream engine' };
      }
      const result = await rt.dream({
        pctx,
        agent,
        force: true,
        dryRun: action === 'dry-run',
        trigger: options.trigger || 'manual',
        reason: options.reason || '',
        focus: typeof options.focus === 'string' ? options.focus : '',
      });
      return { ok: true, result: lossless(result) };
    }
    if (action === 'apply-last') {
      if (typeof rt.applyLastPlan !== 'function') {
        return { ok: false, error: 'dream-unavailable', message: 'this host build cannot apply a dry-run plan' };
      }
      return { ok: true, result: lossless(await rt.applyLastPlan({ pctx, agent })) };
    }
    if (action === 'apply-pending') {
      if (typeof rt.applyPendingDream !== 'function') {
        return { ok: false, error: 'dream-unavailable', message: 'this host build cannot apply a pending proposal' };
      }
      return { ok: true, result: lossless(await rt.applyPendingDream({ pctx, agent })) };
    }
    if (action === 'reject') {
      const pending =
        pctx?.state && typeof pctx.state.snapshot === 'function'
          ? String(pctx.state.snapshot().pendingProposal ?? '')
          : '';
      if (pending === '') {
        return { ok: true, result: { rejected: false, reason: 'no-pending-proposal' } };
      }
      try {
        await fs.unlink(pending);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      try {
        if (typeof pctx?.state?.clearPendingProposal === 'function') await pctx.state.clearPendingProposal();
      } catch {
        /* the proposal file is gone; state cleanup is best-effort */
      }
      invalidateAll('dream-reject');
      return { ok: true, result: { rejected: true, proposalPath: pending } };
    }
    if (action === 'undo') {
      if (typeof rt.undoLastDream !== 'function') {
        return {
          ok: false,
          error: 'not-ready',
          message: 'dream undo is not available in this build yet (waiting for the dream engine)',
        };
      }
      const result = await rt.undoLastDream(pctx, { agent });
      invalidateAll('dream-undo');
      return { ok: true, result: lossless(result) };
    }
    throw coded('unknown-action', `unknown dream action: ${action}`);
  }

  /** Soft-delete one memory file (still gated by `dreamAllowDelete`). */
  async function deleteFile(pctx, file, scope) {
    const store = requireStore(pctx);
    if (typeof file !== 'string' || file.trim() === '') {
      throw coded('invalid-file', 'a memory file name is required');
    }
    if (configOf().dreamAllowDelete !== true) {
      throw coded('delete-disabled', 'set dreamAllowDelete: true to delete memories (moves them to trash)');
    }
    if (typeof store.trashEntry !== 'function') {
      throw coded('unavailable', 'this store build cannot trash files');
    }
    const result = await store.trashEntry(file.trim(), {
      scope: normalizeScope(scope),
      reason: 'delete',
    });
    invalidate(pctx, 'delete');
    invalidateAll('delete');
    return {
      file: result.file,
      trashed: result.trashed === true,
      trashPath: result.trashPath,
    };
  }

  /** Dream backups under `<projectDir>/.dreams/`, newest first. */
  async function backups(pctx) {
    return { items: await listBatches(pctx?.paths?.dreamsDir) };
  }

  /** Trash batches under `<projectDir>/.trash/`, newest first. */
  async function trash(pctx) {
    return { items: await listBatches(pctx?.paths?.trashRoot) };
  }

  /**
   * Restore one dream backup or trashed file back into the memory directory and
   * repair the index. Writes a changelog audit line.
   * @param {object} pctx
   * @param {{kind?:'backup'|'trash',id?:string,file?:string}} [request]
   * @returns {Promise<{restored:string[], reconciled:{missing:string[],dangling:string[]}}>}
   */
  async function restore(pctx, request = {}) {
    const store = requireStore(pctx);
    const paths = pctx?.paths ?? {};
    const kind = String(request?.kind ?? '').toLowerCase();
    if (kind !== 'backup' && kind !== 'trash') {
      throw coded('invalid-kind', 'restore kind must be "backup" or "trash"');
    }
    const id = safeComponent(request?.id, 'restore id');
    const baseDir = kind === 'backup' ? paths.dreamsDir : paths.trashRoot;
    if (typeof baseDir !== 'string' || baseDir === '') {
      throw coded('unavailable', `the ${kind} directory is unavailable`);
    }
    const sourceDir = path.resolve(baseDir, id);
    if (!isInside(baseDir, sourceDir)) throw coded('invalid-id', `unknown ${kind}: ${id}`);
    let info;
    try {
      info = await fs.stat(sourceDir);
    } catch {
      throw coded('not-found', `unknown ${kind}: ${id}`);
    }
    if (!info.isDirectory()) throw coded('not-found', `unknown ${kind}: ${id}`);
    const requestedFile =
      request?.file === undefined || request?.file === null || request?.file === ''
        ? ''
        : safeComponent(request.file, 'restore file');
    let names;
    try {
      names = await fs.readdir(sourceDir, { withFileTypes: true });
    } catch (error) {
      throw error;
    }
    const available = names
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => !name.endsWith('.reason.txt'));
    const selected = requestedFile === '' ? available : available.filter((name) => name === requestedFile);
    if (selected.length === 0) {
      throw coded('not-found', `the ${kind} batch ${id} has no matching files`);
    }
    const memoryDir = typeof paths.memoryDir === 'string' ? paths.memoryDir : '';
    if (memoryDir === '') throw coded('no-project', 'the memory directory is unavailable');
    await fs.mkdir(memoryDir, { recursive: true });
    const restored = [];
    for (const name of selected) {
      const source = path.join(sourceDir, name);
      const target = path.join(memoryDir, name);
      if (path.dirname(target) !== path.resolve(memoryDir)) continue;
      if (kind === 'trash') {
        try {
          await fs.rename(source, target);
        } catch {
          await fs.copyFile(source, target);
          await fs.unlink(source);
        }
        try {
          await fs.unlink(`${source}.reason.txt`);
        } catch {
          /* the sidecar may not exist */
        }
      } else {
        await fs.copyFile(source, target);
      }
      restored.push(name);
    }
    let reconciled = { missing: [], dangling: [] };
    if (typeof store.reconcileIndex === 'function') {
      const result = await store.reconcileIndex('project');
      reconciled = {
        missing: Array.isArray(result?.appended) ? result.appended : [],
        dangling: Array.isArray(result?.removed) ? result.removed : [],
      };
    }
    const changelog = [
      `## ${new Date().toISOString()}`,
      `- restore: kind=${kind} id=${id} files=${restored.length}${requestedFile === '' ? '' : ` file=${requestedFile}`}`,
    ].join('\n');
    try {
      if (typeof store.writeChangelog === 'function') await store.writeChangelog(changelog);
    } catch {
      /* the restore already happened; the audit line is best-effort */
    }
    invalidateAll('restore');
    return { restored, reconciled };
  }

  /** Pending-write queue summary (v9 write-review flow). */
  async function pendingWrites(pctx) {
    requireStore(pctx);
    const records = await listPendingWrites(pctx?.paths);
    return pendingWritesView(records, { limit: 100 });
  }

  /**
   * Approve one queued write: write it through the store (normal provenance,
   * secret scan, index upkeep and metrics) and report the final file.
   * @param {object} pctx
   * @param {string} id pending-write id
   * @param {{sessionId?:string}} [options]
   */
  async function approveWrite(pctx, id, options = {}) {
    const store = requireStore(pctx);
    const sessionId =
      typeof options?.sessionId === 'string' && options.sessionId !== ''
        ? options.sessionId
        : typeof pctx?.sessionId === 'string'
          ? pctx.sessionId
          : '';
    const result = await approvePendingWrite(pctx?.paths, id, {
      store,
      source: { sessionId, via: 'tool:memory_save' },
    });
    try {
      await recordWrite(pctx?.paths, result.file);
    } catch {
      /* metrics are best-effort */
    }
    invalidate(pctx, 'pending-approve');
    invalidateAll('pending-approve');
    return { written: true, id: result.id, file: result.file };
  }

  /**
   * Reject one queued write: archive it under `.pending/expired/`.
   * @param {object} pctx
   * @param {string} id pending-write id
   * @param {string} [reason]
   */
  async function rejectWrite(pctx, id, reason = '') {
    requireStore(pctx);
    const result = await rejectPendingWrite(pctx?.paths, id, typeof reason === 'string' ? reason : '');
    return { rejected: true, id: result.id, path: result.path };
  }

  return {
    status,
    file,
    rules,
    saveRules,
    resetRules,
    toggle,
    dream,
    deleteFile,
    backups,
    trash,
    restore,
    metrics,
    metricsReport,
    search,
    writeFile,
    mergeFiles,
    fileHistory,
    dreamHistory,
    importMemory,
    exportMemory,
    pendingWrites,
    approveWrite,
    rejectWrite,
  };
}
