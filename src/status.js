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
import { buildIdentity } from './build-id.js';
import { dreamReadiness, memoryHealth } from './readiness.js';
import { exportClaudeMemory, importClaudeMemory } from './import-export.js';
import { listRunManifests, summarizeRun } from './dream-run.js';
import { listSwitches } from './dream.js';
import { NEVER_READ_LIMIT, metricsSummary, metricsTrend, readMetrics, recordWrite } from './metrics.js';
import {
  SECRET_DETECTED,
  scanSecrets,
  secretScanDecision,
  secretScanMode,
  secretWarnings,
} from './secrets.js';
import { MEMORY_TYPES, entryVersion, normalizeScope } from './store.js';
import { memoryHash } from './write-review.js';
import { isCurrentPage } from './memory-body.js';
import { applyProposals } from './auto-extract.js';
import { listProposals, readProposal, removeProposal } from './inbox.js';
import { matchesRecord, readLedger, recordVerifiedEntry } from './verification-ledger.js';

/**
 * Version of the data contract between this backend and client.js. The page
 * compares it with its own and says so when the running backend is older
 * (the host keeps imported modules until it restarts).
 */
export const UI_API = 4;

/** Changelog tail length used by the UI. */
export const DEFAULT_LOG_LINES = 40;
/** Days of daily metrics returned by the trend endpoints by default. */
export const DEFAULT_TREND_DAYS = 7;

/** Config fields the UI needs (no secrets, no paths beyond the memory root). */
export const CONFIG_FIELDS = Object.freeze([
  'enabled',
  'autoMemoryEnabled',
  'autoDreamEnabled',
  'dreamAnalyzerModel',
  'dreamAnalyzerConcurrency',
  'indexMaxLines',
  'indexMaxBytes',
  'autoRecallMaxFiles',
  'autoRecallMaxChars',
  'recallMode',
  'recallModel',
  'autoExtract',
  'autoExtractEveryTurns',
  'autoExtractMaxItems',
  'subagentMemory',
  'agentMemoryPresets',
  'dreamAllowDelete',
  'rulesMaxChars',
  'dreamMaxTotalTokens',
  'policyDuplicateThreshold',
  'policySuggestThreshold',
  'dreamCostMode',
  'projectId',
  'keepHistory',
  'historyMaxPerFile',
]);

/** State fields the UI needs. */
export const STATE_FIELDS = Object.freeze([
  'lastDreamAt',
  'lastDreamAttemptAt',
  'lastDreamSummary',
  'lastDreamSessions',
  'lastDreamOps',
  'lastDreamMode',
  'shadowPending',
  'lastError',
  'consecutiveFailures',
  'lastDreamDurationMs',
  'lastDreamCostExceeded',
  'lastDreamUsage',
  'lastExtractAt',
  'lastExtractAttemptAt',
  'lastExtractCount',
  'lastExtractReason',
  'lastExtractError',
  'lastExtractTrigger',
  'counters',
  'sessionsSince',
]);

/** Boolean runtime overrides a caller may toggle. */
export const TOGGLE_FIELDS = Object.freeze([
  'enabled',
  'autoMemoryEnabled',
  'autoDreamEnabled',
  'autoExtract',
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

/**
 * Record a save the user made deliberately: a `/remember` command, a panel
 * save, or an `/memory edit`. All three mean "the user looked at these exact
 * bytes and committed them", so they share one post-save step — count the write
 * and mark the bytes verified, which is what lets a later session show the
 * note's summary in its first-turn index. Model-inferred writes keep going
 * through the pending-write review instead. Both records are best-effort: a
 * note that is written but not recorded is still listed by name.
 * @param {{store:object, paths?:object, scope?:string, file?:string,
 *   entry?:{name?:string, description?:string, bodyHash?:string}}} [options]
 * @returns {Promise<'recorded'|'pending'>} whether this exact version is in the
 *   ledger now; `pending` means the bytes are on disk but the index will only
 *   show the name until the next write
 */
export async function recordUserConfirmedSave({ store, paths, scope = 'project', file, entry } = {}) {
  if (typeof file !== 'string' || file === '') return 'pending';
  try {
    await recordWrite(paths, file);
  } catch {
    /* metrics are best-effort */
  }
  if (!entry || typeof entry.bodyHash !== 'string' || entry.bodyHash === '') return 'pending';
  try {
    const record = await recordVerifiedEntry({
      store,
      scope,
      file,
      name: entry.name ?? '',
      description: entry.description ?? '',
      bodyHash: entry.bodyHash,
    });
    return record ? 'recorded' : 'pending';
  } catch {
    /* a note that is written but not recorded stays listed by name */
    return 'pending';
  }
}

/**
 * Trust facts for the UI, per entry: the explicit `STATUS:` marker, whether the
 * page is current, whether the host ledger verified exactly this content (or
 * verified an older version). Read-only; an unreadable page reports as
 * unverified.
 * @returns {Promise<object[]>}
 */
export async function annotateTrust(store, entries, { scope = 'project' } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const ledger = await readLedger(store, scope);
  const out = [];
  for (const entry of list) {
    let body = null;
    try {
      const read = await store.readEntry(entry.file, scope);
      body = typeof read?.body === 'string' ? read.body : '';
    } catch {
      body = null;
    }
    const marker = /^\s*STATUS:\s*([a-z-]+)/imu.exec(body ?? '');
    const record = ledger.entries[entry.file];
    const trusted = body !== null
      && matchesRecord(record, { name: entry.name, description: entry.description, body });
    out.push({
      ...entry,
      status: marker ? marker[1].toLowerCase() : '',
      current: body === null ? true : isCurrentPage(body),
      verified: trusted ? { date: String(record.date ?? ''), source: String(record.source ?? '') } : null,
      verifiedOutdated: Boolean(record) && !trusted,
    });
  }
  return out;
}

/**
 * Dream readiness (gates and next eligible time).
 * @returns {Promise<object|null>}
 */
export async function readinessFor(pctx, config) {
  try {
    return lossless(await dreamReadiness(pctx, { config, now: Date.now() }));
  } catch {
    return null;
  }
}

/**
 * Memory health (score/dimensions/suggestions).
 * @returns {Promise<object|null>}
 */
export async function memoryHealthFor(pctx, config) {
  try {
    return lossless(await memoryHealth(pctx, { config }));
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
 * Build the status service for one runtime.
 * @param {object} runtime `MemoryRuntime`.
 * @returns {{status:Function, file:Function, rules:Function, saveRules:Function,
 *   toggle:Function, dream:Function, deleteFile:Function,
 *   backups:Function, trash:Function, restore:Function}}
 */
export function createStatusService(runtime) {
  const rt = runtime;

  const configOf = () => rt.config;

  function requireStore(pctx) {
    const store = pctx?.store;
    if (!store || typeof store !== 'object') {
      throw coded('no-project', 'the memory store is unavailable for this project');
    }
    return store;
  }

  function overridesOf() {
    return { ...rt.overrides() };
  }

  function invalidate(pctx, reason) {
    rt.invalidateInjection(pctx?.sessionId ?? '', reason);
  }

  function invalidateAll(reason) {
    rt.invalidateAllInjections(reason);
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
      // Browsing the current value is the default; `history: true` is the
      // explicit way to look at what a page used to say.
      currentOnly: options.history !== true,
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
    const expectedHash = typeof input.expectedHash === 'string' ? input.expectedHash.trim() : '';
    const source = { via: 'api:edit', sessionId: typeof pctx?.sessionId === 'string' ? pctx.sessionId : '' };
    if (file === '') {
      // A client that submits a baseline is editing a page that existed when it
      // opened the editor. Recreating it here would undo the delete or rename.
      if (expectedHash !== '') {
        throw coded('stale-write', 'the memory file no longer exists; reload the list before creating it');
      }
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
      const verification = await recordUserConfirmedSave({
        store,
        paths: pctx?.paths,
        scope,
        file: result.file,
        entry: result,
      });
      invalidate(pctx, 'edit');
      invalidateAll('edit');
      return {
        ok: true,
        file: result.file,
        entry,
        created: result.created === true,
        version: result.version,
        expectedHash: memoryHash(entry.raw),
        verification,
      };
    }
    let existing = null;
    try {
      existing = await store.readEntry(file, scope);
    } catch (error) {
      if (error?.code !== 'NOT_FOUND') throw error;
      existing = null;
    }
    if (existing === null) {
      throw coded('stale-write', `memory file not found: ${file}; reload the list before saving`);
    }
    if (expectedHash === '') {
      throw coded('stale-write', `re-read ${file} before saving; an edit baseline is required`);
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
      // The store compares this under its write lock, so a page changed in
      // another window fails here instead of overwriting the newer text.
      expectedHash,
    });
    const entry = await store.readEntry(result.file, scope);
    const verification = await recordUserConfirmedSave({
      store,
      paths: pctx?.paths,
      scope,
      file: result.file,
      entry: result,
    });
    invalidate(pctx, 'edit');
    invalidateAll('edit');
    return {
      ok: true,
      file: result.file,
      entry,
      created: result.created === true,
      version: result.version,
      expectedHash: memoryHash(entry.raw),
      verification,
    };
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
    const audit = await store.reconcileIndex(scope);
    const reconciled = {
      missing: Array.isArray(audit?.appended) ? audit.appended : [],
      dangling: Array.isArray(audit?.removed) ? audit.removed : [],
    };
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
    const planRefs = (await listSwitches(pctx.paths))
      .filter((meta) => Array.isArray(meta.files) && meta.files.includes(target))
      .map((meta) => ({ type: 'dream', id: meta.batch, appliedAt: Number(meta.appliedAt) || 0, ops: meta.files.length }));
    return { ok: true, file: target, provenance, changelog: changelog.slice(-20), planRefs };
  }

  /**
   * Dream switches (newest first). Only the newest one not undone yet can be
   * undone, because undo always reverts that one.
   * @param {object} pctx
   */
  async function dreamHistory(pctx) {
    const switches = await listSwitches(pctx.paths);
    const target = switches.find((meta) => meta.undone !== true);
    const items = switches.map((meta) => ({
      ts: meta.batch,
      appliedAt: Number(meta.appliedAt) || 0,
      summary: typeof meta.summary === 'string' ? meta.summary : '',
      files: Array.isArray(meta.files) ? meta.files : [],
      ops: Array.isArray(meta.files) ? meta.files.length : 0,
      undoable: meta === target,
      undone: meta.undone === true,
    }));
    return { ok: true, items };
  }

  /**
   * Import a Claude Code memory directory through `src/import-export.js`.
   * @param {object} pctx
   * @param {{sourceDir?:string,path?:string}} [request]
   */
  async function importMemory(pctx, request = {}) {
    const store = requireStore(pctx);
    const sourceDir = String(request?.sourceDir ?? request?.path ?? '').trim();
    if (sourceDir === '') throw coded('invalid-path', 'a source directory path is required');
    const result = await importClaudeMemory({ paths: pctx.paths, sourceDir, store });
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
   * `src/import-export.js`.
   * @param {object} pctx
   * @param {{targetDir?:string,path?:string}} [request]
   */
  async function exportMemory(pctx, request = {}) {
    const store = requireStore(pctx);
    const targetDir = String(request?.targetDir ?? request?.path ?? '').trim();
    if (targetDir === '') throw coded('invalid-path', 'a target directory path is required');
    const result = await exportClaudeMemory({ paths: pctx.paths, targetDir, store });
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

  /**
   * One inbox proposal → the shape the panel renders. `items` is carried whole
   * (the user needs the proposed text before accepting) and `count` saves the
   * client from recomputing it.
   */
  function inboxSummary(record) {
    const items = Array.isArray(record?.items) ? record.items : [];
    return {
      id: String(record?.id ?? ''),
      createdAt: Number(record?.createdAt) || 0,
      sessionId: String(record?.sessionId ?? ''),
      cwd: String(record?.cwd ?? ''),
      trigger: String(record?.trigger ?? ''),
      model: String(record?.model ?? ''),
      status: String(record?.status ?? 'pending'),
      count: items.length,
      // The dock polls /status every 60s; keep the payload bounded. The full
      // note body stays on disk and is available through `/memory inbox show`.
      items: items.slice(0, 20).map((item) => ({
        name: String(item?.name ?? ''),
        type: String(item?.type ?? ''),
        description: String(item?.description ?? ''),
        content: String(item?.content ?? '').slice(0, 400),
      })),
    };
  }

  /** Proposals the v20 extractor staged; an unreadable inbox is simply empty. */
  async function inboxSnapshot(pctx) {
    try {
      const records = await listProposals(pctx?.paths);
      return { count: records.length, items: records.map(inboxSummary) };
    } catch {
      return { count: 0, items: [] };
    }
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
    let trashCount = 0;
    try {
      trashCount = await store.countTrash();
    } catch {
      trashCount = 0;
    }
    const changelogTail = await readTail(pctx?.paths?.changelogFile, DEFAULT_LOG_LINES);
    const rulesValue = rules(pctx);
    const metricsValue = await metricsForEntries(pctx, entries);
    const health = await buildHealth({ runtime: rt, projectContext: pctx, rules: rulesValue });
    const snapshot =
      pctx?.state?.snapshot() ?? {};

    const stateView = pick(snapshot, STATE_FIELDS);
    const readiness = await readinessFor(pctx, config);
    const memoryHealth = await memoryHealthFor(pctx, config);
    const healthValue = health && typeof health === 'object' ? { ...health } : health;
    if (healthValue && memoryHealth) healthValue.memoryHealth = memoryHealth;
    // v10: 7-day daily trend rides along with the metrics view (the UI renders
    // it; `GET /metrics?days=N` returns the same trend for other windows).
    const metricsTrendValue = metricsTrend(await readMetrics(pctx?.paths), { days: DEFAULT_TREND_DAYS });
    const metricsView = { ...metricsValue, trend: metricsTrendValue };
    const inboxValue = await inboxSnapshot(pctx);

    // Per-entry trust (ledger, STATUS).
    let trustedEntries = entries;
    try {
      trustedEntries = await annotateTrust(store, entries, { scope: 'project' });
    } catch {
      /* trust facts are optional; the plain entries still describe the store */
    }

    // Phase 2: resumable Dream runs (newest five) so a stopped run is visible
    // and can be continued from the panel or `/dream status`.
    let dreamRuns = [];
    try {
      const manifests = await listRunManifests(pctx?.paths, 5);
      const live = new Set(await rt.liveDreamRunIds());
      dreamRuns = manifests.map((entry) => summarizeRun(entry.manifest, { running: live.has(entry.manifest?.runId) }));
    } catch {
      dreamRuns = [];
    }

    return {
      ok: true,
      version: VERSION,
      uiApi: UI_API,
      build: buildIdentity(),
      capabilities: {
        dreamPipeline: 'v2',
        dreamRuns: true,
        claimMerge: true,
        explicitSaveLedger: true,
      },
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
      injection: {
        recallMode: typeof config.recallMode === 'string' ? config.recallMode : 'model',
        autoExtract: config.autoExtract === true,
        subagentMemory: config.subagentMemory === 'shared' || config.subagentMemory === 'own' ? config.subagentMemory : 'off',
      },
      entries: trustedEntries,
      inbox: inboxValue,
      state: stateView,
      dreamRuns,
      changelogTail,
      trashCount,
      rules: rulesValue,
      metrics: metricsView,
      readiness,
      healthScore: memoryHealth && Number.isFinite(Number(memoryHealth.score)) ? Number(memoryHealth.score) : null,
      subagentPolicy: {
        mode: config.subagentMemory === 'shared' || config.subagentMemory === 'own' ? config.subagentMemory : 'off',
        agentMemoryPresets: Array.isArray(config.agentMemoryPresets) ? config.agentMemoryPresets : [],
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
    const entry = await store.readEntry(file.trim(), normalizeScope(scope));
    return {
      ...entry,
      // `version` labels the content in receipts; `expectedHash` is the token an
      // editor sends back so the store can refuse a stale overwrite.
      version: entryVersion({
        name: entry.frontmatter?.name ?? '',
        description: entry.frontmatter?.description ?? '',
        body: entry.body ?? '',
      }),
      expectedHash: memoryHash(entry.raw),
    };
  }

  /** The rules actually injected for this project. */
  function rules(pctx) {
    return normalizeRules(rt.rulesFor(pctx), pctx);
  }

  /**
   * Persist one rules override; empty text removes it. `deny` secret scanning
   * refuses the write with code `SECRET_DETECTED`; `warn` returns the rules plus a
   * `warnings` array.
   */
  async function saveRules(pctx, scope, text, options = {}) {
    const targetScope = scope === undefined || scope === null ? 'project' : String(scope).toLowerCase();
    if (targetScope !== 'project' && targetScope !== 'global') {
      throw coded('invalid-scope', `rules scope must be "project" or "global": ${String(scope)}`);
    }
    const value = typeof text === 'string' ? text : '';
    const warnings = scanRulesText(value);
    const updated = await rt.saveRules(pctx, targetScope, value, { source: options?.source || 'api' });
    const normalized = normalizeRules(updated, pctx);
    if (warnings.length > 0) normalized.warnings = warnings;
    return normalized;
  }

  /**
   * Merge boolean runtime overrides and report the effective config.
   * @param {object} targetRuntime runtime to mutate (defaults to the service's).
   * @param {{enabled?:boolean,autoMemoryEnabled?:boolean,autoDreamEnabled?:boolean}} patch
   */
  async function toggle(targetRuntime, patch) {
    const target = targetRuntime && typeof targetRuntime === 'object' ? targetRuntime : rt;
    const clean = {};
    for (const key of TOGGLE_FIELDS) {
      if (patch && typeof patch[key] === 'boolean') clean[key] = patch[key];
    }
    if (Object.keys(clean).length === 0) {
      throw coded('no-toggle-field', `patch must set one of ${TOGGLE_FIELDS.join(', ')}`);
    }
    const overrides = await target.setOverrides(clean);
    return { overrides, config: pick(target.config, TOGGLE_FIELDS) };
  }

  /**
   * Dispatch one dream action. `start` launches a background run and returns
   * its id; `run` launches the same way and waits for the result.
   * @param {object} pctx
   * @param {{agent?:object,sessionId?:string,action?:string,runId?:string,
   *   trigger?:string,reason?:string,focus?:string,noSessions?:boolean,
   *   inputId?:string,inputRanges?:Array}} [options]
   */
  async function dream(pctx, options = {}) {
    const action = String(options.action ?? 'start').toLowerCase();
    const agent = options.agent ?? pctx?.agent;
    const runId = String(options.runId ?? '');
    const launch = {
      agent,
      sessionId: options.sessionId,
      force: true,
      trigger: options.trigger || 'manual',
      reason: options.reason || '',
      focus: typeof options.focus === 'string' ? options.focus : '',
      noSessions: options.noSessions === true,
      // v23: an estimate hands back an id and the ranges it priced; starting
      // with them keeps the confirmed scope even if sessions move meanwhile.
      inputId: typeof options.inputId === 'string' ? options.inputId : '',
      inputRanges: Array.isArray(options.inputRanges) ? options.inputRanges : null,
    };
    /** A started run's `done` promise stays in-process. */
    const launched = ({ done, ...info }) => ({ ok: true, result: lossless(info) });
    switch (action) {
      case 'estimate':
        return { ok: true, result: lossless(await rt.estimateDream(pctx, { focus: launch.focus })) };
      case 'start':
      case 'run': {
        const started = await rt.startDream(pctx, launch);
        if (action === 'run' && started.done) return { ok: true, result: lossless(await started.done) };
        return launched(started);
      }
      case 'status':
        return { ok: true, result: lossless(await rt.dreamRun(pctx, runId)) };
      case 'cancel':
        return { ok: true, result: lossless(await rt.cancelDreamRun(pctx, runId)) };
      case 'resume':
        return launched(await rt.resumeDreamRun(pctx, runId, { agent, sessionId: options.sessionId }));
      case 'switch': {
        const result = await rt.switchDream({ pctx, agent });
        if (result?.switched === true) invalidateAll('dream-switch');
        return { ok: true, result: lossless(result) };
      }
      case 'discard':
        return { ok: true, result: lossless(await rt.discardDream({ pctx, agent })) };
      case 'undo': {
        const result = await rt.undoLastDream(pctx, { agent });
        invalidateAll('dream-undo');
        return { ok: true, result: lossless(result) };
      }
      default:
        throw coded('unknown-action', `unknown dream action: ${action}`);
    }
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
    const audit = await store.reconcileIndex('project');
    const reconciled = {
      missing: Array.isArray(audit?.appended) ? audit.appended : [],
      dangling: Array.isArray(audit?.removed) ? audit.removed : [],
    };
    const changelog = [
      `## ${new Date().toISOString()}`,
      `- restore: kind=${kind} id=${id} files=${restored.length}${requestedFile === '' ? '' : ` file=${requestedFile}`}`,
    ].join('\n');
    try {
      await store.writeChangelog(changelog);
    } catch {
      /* the restore already happened; the audit line is best-effort */
    }
    invalidateAll('restore');
    return { restored, reconciled };
  }

  /**
   * List, accept, or discard automatic-extraction proposals. Accepting reuses
   * the normal `memory_save` gates (duplicate/secret/budget/evidence) instead
   * of writing files directly, so an accepted proposal is indistinguishable
   * from a model-authored note.
   * @param {object} pctx
   * @param {{action?:'list'|'accept'|'discard',id?:string,agent?:object}} [request]
   */
  async function inbox(pctx, request = {}) {
    const action = String(request?.action ?? 'list').toLowerCase();
    const paths = pctx?.paths ?? {};
    if (action === 'list') {
      const snapshot = await inboxSnapshot(pctx);
      return { ok: true, ...snapshot };
    }
    const id = safeComponent(request?.id, 'proposal id');
    if (action === 'discard') {
      const removed = await removeProposal(paths, id);
      if (!removed) throw coded('not-found', `unknown inbox proposal: ${id}`);
      invalidateAll('inbox');
      return { ok: true, id, discarded: true };
    }
    if (action === 'accept') {
      const record = await readProposal(paths, id);
      const items = Array.isArray(record?.items) ? record.items : [];
      const agent = request?.agent ?? pctx?.agent ?? { id: record.sessionId };
      const results = await applyProposals({
        runtime: rt,
        items,
        sessionId: record.sessionId,
        agent,
      });
      const applied = results.filter((item) => item && item.ok === true).length;
      const ok = items.length > 0 && applied === results.length;
      if (ok) {
        await removeProposal(paths, id);
        invalidateAll('inbox');
      }
      return {
        ok,
        id,
        applied,
        failed: results.length - applied,
        results,
      };
    }
    throw coded('unknown-action', `unknown inbox action: ${action}`);
  }

  return {
    status,
    file,
    rules,
    saveRules,
    toggle,
    inbox,
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
  };
}
