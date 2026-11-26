import { h } from './react.js';

/** Data contract this page expects from the backend (`/status.uiApi`). */
export const UI_API = 5;

export function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isEntryLike(entry) {
  return Boolean(entry && typeof entry === 'object' && typeof entry.file === 'string');
}

function normalizeEntry(entry) {
  const meta = entry && typeof entry === 'object' ? entry : {};
  const verified =
    meta.verified && typeof meta.verified === 'object'
      ? {
          date: typeof meta.verified.date === 'string' ? meta.verified.date : '',
          source: typeof meta.verified.source === 'string' ? meta.verified.source : '',
        }
      : null;
  return {
    ...meta,
    file: typeof meta.file === 'string' ? meta.file : '',
    name: typeof meta.name === 'string' ? meta.name : '',
    description: typeof meta.description === 'string' ? meta.description : '',
    type: typeof meta.type === 'string' ? meta.type : 'user',
    modified: typeof meta.modified === 'string' ? meta.modified : '',
    bytes: asNumber(meta.bytes, 0),
    lines: asNumber(meta.lines, 0),
    via: typeof meta.via === 'string' ? meta.via : '',
    sourceSession: typeof meta.sourceSession === 'string' ? meta.sourceSession : '',
    created: typeof meta.created === 'string' ? meta.created : '',
    status: typeof meta.status === 'string' ? meta.status.toLowerCase() : '',
    current: meta.current !== false,
    verified,
    verifiedOutdated: meta.verifiedOutdated === true,
  };
}

/** Normalize one model usage object; only totalTokens is surfaced. */
function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const totalTokens = asNumber(value.totalTokens ?? value.total_tokens, 0);
  if (totalTokens <= 0) return null;
  return { totalTokens };
}

export function normalizeMetrics(raw) {
  const record = raw && typeof raw === 'object' ? raw : {};
  // `/status` pins `inject`; the raw `.metrics.json` summary uses
  // `injections` — accept either and expose both names downstream.
  const inject =
    record.injections && typeof record.injections === 'object'
      ? record.injections
      : record.inject && typeof record.inject === 'object'
        ? record.inject
        : {};
  const reads = record.reads && typeof record.reads === 'object' ? record.reads : {};
  const writes = record.writes && typeof record.writes === 'object' ? record.writes : {};
  const searches = record.searches && typeof record.searches === 'object' ? record.searches : {};
  const dreams = record.dreams && typeof record.dreams === 'object' ? record.dreams : {};
  const costs = record.costs && typeof record.costs === 'object' ? record.costs : {};
  const top = Array.isArray(reads.top)
    ? reads.top
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.file === 'string')
        .map((entry) => ({ file: entry.file, reads: asNumber(entry.reads, 0) }))
        .slice(0, 20)
    : [];
  const neverRead = Array.isArray(reads.neverRead)
    ? reads.neverRead.filter((file) => typeof file === 'string').slice(0, 20)
    : [];
  const applied = asNumber(dreams.applied, 0);
  const rejected = asNumber(dreams.rejected, 0);
  const considered = applied + rejected;
  // The host summary reports 0 for "no decisions yet"; display treats that
  // as "no rate" so the card can show a dash instead of a misleading 0%.
  let acceptanceRate = null;
  if (considered > 0) {
    acceptanceRate = Number.isFinite(Number(dreams.acceptanceRate))
      ? Math.max(0, Math.min(1, Number(dreams.acceptanceRate)))
      : applied / considered;
  }
  const injectBlock = { count: asNumber(inject.count, 0), lastAt: asNumber(inject.lastAt, 0) };
  const metrics = {
    since: asNumber(record.since, 0),
    updatedAt: asNumber(record.updatedAt, 0),
    inject: injectBlock,
    injections: injectBlock,
    reads: { total: asNumber(reads.total, 0), top, neverRead },
    writes: { total: asNumber(writes.total, 0) },
    searches: { count: asNumber(searches.count, 0), hits: asNumber(searches.hits, 0) },
    dreams: {
      proposed: asNumber(dreams.proposed, 0),
      applied,
      rejected,
      failed: asNumber(dreams.failed, 0),
      acceptanceRate,
      appliedOps: asNumber(dreams.appliedOps, 0),
    },
    costs: {
      lastDurationMs: asNumber(costs.lastDurationMs, 0),
      lastInputChars: asNumber(costs.lastInputChars, 0),
      lastOutputChars: asNumber(costs.lastOutputChars, 0),
      lastUsage: normalizeUsage(costs.lastUsage),
    },
  };
  metrics.hasData =
    metrics.injections.count > 0 ||
    metrics.reads.total > 0 ||
    metrics.writes.total > 0 ||
    metrics.searches.count > 0 ||
    metrics.dreams.proposed > 0 ||
    metrics.dreams.applied > 0 ||
    metrics.costs.lastDurationMs > 0 ||
    metrics.updatedAt > 0;
  metrics.trend = normalizeTrend(record.trend ?? record.daily ?? null);
  metrics.quality = normalizeQuality(record.quality ?? null);
  return metrics;
}

/** Normalize the `rules` fragment shared by /status, /rules and /memory json. */
export function normalizeRules(raw) {
  const record = raw && typeof raw === 'object' ? raw : {};
  return {
    text: typeof record.text === 'string' ? record.text : '',
    source: typeof record.source === 'string' && record.source !== '' ? record.source : 'default',
    projectPath: typeof record.projectPath === 'string' ? record.projectPath : '',
    globalPath: typeof record.globalPath === 'string' ? record.globalPath : '',
    maxChars: asNumber(record.maxChars, 0),
    // `warn`-level secret matches come back with the saved rules. Dropping
    // them here made a warned save look clean in the panel.
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((item) => typeof item === 'string') : [],
  };
}

/** v9: dream readiness `{eligible,nextEligibleAt,reasons,gates}`. */
export function normalizeReadiness(raw) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const gates = record.gates && typeof record.gates === 'object' ? record.gates : {};
  const reasons = Array.isArray(record.reasons)
    ? record.reasons
        .filter((reason) => reason && typeof reason === 'object')
        .map((reason) => ({
          code: typeof reason.code === 'string' ? reason.code : 'unknown',
          message: typeof reason.message === 'string' ? reason.message : '',
        }))
    : [];
  const minHours =
    gates.minHours && typeof gates.minHours === 'object'
      ? { ok: Boolean(gates.minHours.ok), remainingMs: asNumber(gates.minHours.remainingMs, 0) }
      : null;
  const minSessions =
    gates.minSessions && typeof gates.minSessions === 'object'
      ? {
          ok: Boolean(gates.minSessions.ok),
          current: asNumber(gates.minSessions.current, 0),
          required: asNumber(gates.minSessions.required, 0),
        }
      : null;
  return {
    eligible: record.eligible === true,
    nextEligibleAt: asNumber(record.nextEligibleAt, 0),
    reasons,
    gates: {
      auto: Boolean(gates.auto),
      minHours,
      minSessions,
      throttleMs: asNumber(gates.throttleMs, 0),
      pendingSwitch: Boolean(gates.pendingSwitch),
      lock: Boolean(gates.lock),
    },
  };
}

/** v9: memory health `{score,dimensions,suggestions}` (score null = unknown). */
export function normalizeHealth(raw) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const dimensionsRaw = record.dimensions && typeof record.dimensions === 'object' ? record.dimensions : {};
  const dimensions = {};
  for (const [key, value] of Object.entries(dimensionsRaw)) {
    if (typeof key === 'string') dimensions[key] = asNumber(value, 0);
  }
  const suggestions = Array.isArray(record.suggestions)
    ? record.suggestions
        .filter((suggestion) => suggestion && typeof suggestion === 'object')
        .map((suggestion) => ({
          code: typeof suggestion.code === 'string' ? suggestion.code : '',
          message: typeof suggestion.message === 'string' ? suggestion.message : '',
        }))
    : [];
  const rawScore = record.score;
  const score =
    rawScore === undefined || rawScore === null || !Number.isFinite(Number(rawScore))
      ? null
      : Math.max(0, Math.min(100, Math.round(Number(rawScore))));
  return { score, dimensions, suggestions };
}

/** v10: per-day metrics trend (`[{date,injections,reads,writes,searches,dreams,adopted}]`). */
export function normalizeTrend(raw) {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? raw.trend ?? raw.days : null;
  const list = Array.isArray(source) ? source : [];
  const days = list
    .filter((day) => day && typeof day === 'object')
    .map((day) => {
      const dreams = day.dreams && typeof day.dreams === 'object' ? day.dreams : {};
      return {
        date: typeof day.date === 'string' ? day.date : typeof day.day === 'string' ? day.day : '',
        injections: asNumber(day.injections, 0),
        reads: asNumber(day.reads, 0),
        writes: asNumber(day.writes, 0),
        searches: asNumber(day.searches, 0),
        adopted: asNumber(day.adopted, 0),
        dreams: {
          proposed: asNumber(dreams.proposed, 0),
          applied: asNumber(dreams.applied, 0),
          rejected: asNumber(dreams.rejected, 0),
          failed: asNumber(dreams.failed, 0),
        },
      };
    })
    .filter((day) => day.date !== '')
    .slice(-31);
  return { days };
}

/** v10: dream quality `{appliedOps,planOps,dropped,rollbacks}` + derived rates. */
function normalizeQuality(raw) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const appliedOps = asNumber(record.appliedOps, 0);
  const planOps = asNumber(record.planOps, 0);
  const dropped = asNumber(record.dropped, 0);
  const rollbacks = asNumber(record.rollbacks, 0);
  return {
    appliedOps,
    planOps,
    dropped,
    rollbacks,
    applyRate: planOps > 0 ? Math.max(0, Math.min(1, (planOps - dropped) / planOps)) : null,
    droppedRate: planOps > 0 ? Math.max(0, Math.min(1, dropped / planOps)) : null,
  };
}

/** GET /dream-history: `{items:[{ts,appliedAt,ops,summary,files,undoable,undone}]}`, newest first. */
export function normalizeDreamHistory(raw) {
  const list = raw && Array.isArray(raw.items) ? raw.items : [];
  const items = list
    .filter((item) => item && typeof item === 'object' && typeof item.ts === 'string' && item.ts !== '')
    .map((item) => ({
      ts: item.ts,
      appliedAt: asNumber(item.appliedAt, 0),
      ops: asNumber(item.ops, 0),
      summary: typeof item.summary === 'string' ? item.summary : '',
      files: Array.isArray(item.files) ? item.files.filter((name) => typeof name === 'string') : [],
      undoable: item.undoable === true,
      undone: item.undone === true,
    }));
  return { items };
}

/** v10: ranked search `{query,total,items:[{file,name,description,type,score,snippets}]}`. */
export function normalizeSearch(raw) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const source = record.result && typeof record.result === 'object' ? record.result : record;
  const list = Array.isArray(source.items) ? source.items : Array.isArray(source.results) ? source.results : [];
  const items = list
    .filter((item) => item && typeof item === 'object' && typeof item.file === 'string')
    .map((item) => ({
      file: item.file,
      name: typeof item.name === 'string' ? item.name : '',
      description: typeof item.description === 'string' ? item.description : '',
      type: typeof item.type === 'string' ? item.type : 'user',
      score: asNumber(item.score, 0),
      snippets: Array.isArray(item.snippets)
        ? item.snippets
            .map((snippet) => (typeof snippet === 'string' ? snippet : snippet && typeof snippet.text === 'string' ? snippet.text : ''))
            .filter((snippet) => snippet !== '')
        : [],
      via: typeof item.via === 'string' ? item.via : '',
      sourceSession: typeof item.sourceSession === 'string' ? item.sourceSession : '',
    }));
  return { query: typeof source.query === 'string' ? source.query : '', total: asNumber(source.total, items.length), items };
}

/** A dream result waiting for the human to switch to it or discard it. */
export function normalizePendingSwitch(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.dir !== 'string' || raw.dir === '') return null;
  const unsupported = Array.isArray(raw.proofs)
? raw.proofs.filter((item) => item?.kind === 'missing'
  || (item?.kind === 'citation' && item.unsupportedClaims?.length !== 0)).map((item) => item.file) : [];
  const files = Array.isArray(raw.files)
? raw.files
    .filter((item) => item && typeof item.file === 'string' && item.file !== '')
    .map((item) => ({
      file: item.file,
      action: item.action === 'added' || item.action === 'removed' ? item.action : 'changed',
    }))
: [];
  const counts = raw.counts && typeof raw.counts === 'object' ? raw.counts : {};
  const counted = (name, action) => {
const value = Number(counts[name]);
if (Number.isFinite(value) && value >= 0) return value;
return files.filter((item) => item.action === action).length;
  };
  return {
dir: raw.dir,
createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
summary: typeof raw.summary === 'string' ? raw.summary : '',
runId: typeof raw.runId === 'string' ? raw.runId : '',
unsupported,
matchedSources: [...new Set((Array.isArray(raw.evidence) ? raw.evidence : [])
  .filter((entry) => entry?.verified === true && typeof entry.file === 'string').map((entry) => entry.file))],
// What the human rejected on these pages before, per file.
rejectedBefore: raw.rejectedBefore && typeof raw.rejectedBefore === 'object'
  ? Object.fromEntries(Object.entries(raw.rejectedBefore)
    .filter(([file, items]) => typeof file === 'string' && Array.isArray(items))
    .map(([file, items]) => [file, items.filter((item) => typeof item === 'string').slice(-3)]))
  : {},
// A retired page and the page its facts moved into: one decision.
links: raw.links && typeof raw.links === 'object'
  ? Object.fromEntries(Object.entries(raw.links).filter(([from, to]) => typeof from === 'string' && typeof to === 'string'))
  : {},
// Wiki size before -> after, as [before, after] pairs.
wiki: raw.wiki && typeof raw.wiki === 'object'
  ? Object.fromEntries(['pages', 'chars'].map((key) => [key, Array.isArray(raw.wiki[key]) && raw.wiki[key].length === 2
    ? raw.wiki[key].map((value) => (Number.isFinite(Number(value)) ? Number(value) : 0)) : [0, 0]]))
  : null,
added: counted('added', 'added'),
changed: counted('changed', 'changed'),
removed: counted('removed', 'removed'),
evidence: Array.isArray(raw.evidence)
  ? raw.evidence
      .filter((item) => item && (typeof item.memoryFile === 'string'
        || (typeof item.sessionId === 'string' && Number.isFinite(Number(item.seq)))))
      .slice(0, 100)
      .map((item) => ({
        ...(typeof item.memoryFile === 'string'
          ? { memoryFile: item.memoryFile }
          : { sessionId: item.sessionId, seq: Number(item.seq) || 0 }),
        quote: typeof item.quote === 'string' ? item.quote : '',
        source: typeof item.source === 'string' ? item.source : 'citation',
        verified: item.verified === true,
        ...(typeof item.file === 'string' ? { file: item.file } : {}),
      }))
  : [],
files,
  };
}

export function errorKey(code = '', message = '') {
  const probe = `${code} ${message}`.toLowerCase().replace(/_/gu, '-');
  if (probe.includes('lock-busy') || probe.includes('dream-locked')) return 'locked';
  if (probe.includes('stale-dream') || probe.includes('stale-plan')) return 'stale';
  if (probe.includes('delete-disabled')) return 'deleteDisabled';
  if (probe.includes('dream-task-session')) return 'dreamTaskSession';
  if (probe.includes('plugin-disabled')) return 'pluginOff';
  if (probe.includes('auto-memory-disabled')) return 'autoMemoryOff';
  // A backend loaded before this page was updated: unknown routes/actions, or
  // a module graph mixing old and new files.
  if (probe.includes('unknown-action') || probe.includes('does not provide an export named')) {
return 'backendStale';
  }
  return '';
}

export function normalizeDreamTasks(raw) {
  const sessions = (Array.isArray(raw?.sessions) ? raw.sessions : [])
.filter((item) => item && typeof item.id === 'string')
.map((item) => ({
  id: item.id,
  title: typeof item.title === 'string' ? item.title : '',
  createdAt: asNumber(item.createdAt, 0),
  dreamedAt: asNumber(item.dreamedAt, 0),
  status: typeof item.status === 'string' ? item.status : 'todo',
}));
  return { total: sessions.length, sessions };
}

export function normalizeStatus(raw) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const config = record.config && typeof record.config === 'object' ? record.config : {};
  const stateRecord = record.state && typeof record.state === 'object' ? record.state : {};
  return {
    project: record.project && typeof record.project === 'object' ? record.project : {},
    config: {
      enabled: config.enabled !== false,
      autoMemoryEnabled: config.autoMemoryEnabled !== false,
      autoDreamEnabled: Boolean(config.autoDreamEnabled),
      indexMaxLines: asNumber(config.indexMaxLines, 0),
      indexMaxBytes: asNumber(config.indexMaxBytes, 0),
      dreamAllowDelete: Boolean(config.dreamAllowDelete),
      minHours: asNumber(config.minHours, 0),
      minSessions: asNumber(config.minSessions, 0),
      recallMode: config.recallMode === 'off' || config.recallMode === 'model' ? config.recallMode : 'model',
      autoExtract: config.autoExtract === true,
      autoExtractEveryTurns: asNumber(config.autoExtractEveryTurns, 3),
      autoExtractMaxItems: asNumber(config.autoExtractMaxItems, 5),
      subagentMemory:
        config.subagentMemory === 'shared' || config.subagentMemory === 'own' ? config.subagentMemory : 'off',
      agentMemoryPresets: Array.isArray(config.agentMemoryPresets)
        ? config.agentMemoryPresets.filter((name) => typeof name === 'string')
        : [],
    },
    version: typeof record.version === 'string' ? record.version : '',
    uiApi: asNumber(record.uiApi, 0),
    build:
      record.build && typeof record.build === 'object'
        ? {
            id: typeof record.build.id === 'string' ? record.build.id : '',
            packageVersion:
              typeof record.build.packageVersion === 'string' ? record.build.packageVersion : '',
          }
        : null,
    capabilities:
      record.capabilities && typeof record.capabilities === 'object'
        ? {
            dreamPipeline:
              record.capabilities.dreamPipeline === 'v2' ? 'v2' : 'classic',
            dreamRuns: record.capabilities.dreamRuns === true,
            explicitSaveLedger: record.capabilities.explicitSaveLedger === true,
          }
        : null,
    // Dream runs (newest first) with the progress and actions shown in the panel.
    dreamRuns: Array.isArray(record.dreamRuns)
      ? record.dreamRuns
          .filter((run) => run && typeof run === 'object')
          .map((run) => ({
            runId: typeof run.runId === 'string' ? run.runId : '',
            status: typeof run.status === 'string' ? run.status : '',
            decision: typeof run.decision === 'string' ? run.decision : '',
            error: typeof run.error === 'string' ? run.error : '',
            skipReason: typeof run.skipReason === 'string' ? run.skipReason : '',
            resumable: run.resumable === true,
            checkpointed: asNumber(run.checkpointed, 0),
            sessionsReviewed: asNumber(run.sessionsReviewed, 0),
            sessionsOffered: Array.isArray(run.input?.sessions) ? run.input.sessions.length : asNumber(run.sessionsOffered, 0),
            usage: run.usage && typeof run.usage === 'object' ? run.usage : {},
          }))
      : [],
    // Conversations of this workspace and where Dream stands with each.
    dreamTasks: record.dreamTasks == null ? null : normalizeDreamTasks(record.dreamTasks),
    injection: (() => {
      const injection = record.injection && typeof record.injection === 'object' ? record.injection : {};
      return {
        recallMode: injection.recallMode === 'off' || injection.recallMode === 'model' ? injection.recallMode : 'model',
        autoExtract: injection.autoExtract === undefined ? config.autoExtract === true : injection.autoExtract === true,
        subagentMemory:
          injection.subagentMemory === 'shared' || injection.subagentMemory === 'own'
            ? injection.subagentMemory
            : config.subagentMemory,
      };
    })(),
    overrides: record.overrides && typeof record.overrides === 'object' ? record.overrides : {},
    index:
      record.index && typeof record.index === 'object'
        ? {
            text: typeof record.index.text === 'string' ? record.index.text : '',
            lines: asNumber(record.index.lines, 0),
            bytes: asNumber(record.index.bytes, 0),
            truncated: Boolean(record.index.truncated),
            overflow: Boolean(record.index.overflow),
          }
        : { text: '', lines: 0, bytes: 0, truncated: false, overflow: false },
    entries: Array.isArray(record.entries) ? record.entries.filter(isEntryLike).map(normalizeEntry) : [],
    state: {
      lastDreamAt: asNumber(stateRecord.lastDreamAt, 0),
      lastDreamAttemptAt: asNumber(stateRecord.lastDreamAttemptAt, 0),
      lastDreamSummary:
        typeof stateRecord.lastDreamSummary === 'string' ? stateRecord.lastDreamSummary : '',
      lastDreamSessions: asNumber(stateRecord.lastDreamSessions, 0),
      lastDreamOps: asNumber(stateRecord.lastDreamOps, 0),
      pendingSwitch: normalizePendingSwitch(stateRecord.shadowPending),
      lastError: typeof stateRecord.lastError === 'string' ? stateRecord.lastError : '',
      consecutiveFailures: asNumber(stateRecord.consecutiveFailures, 0),
      sessionsSince: Array.isArray(stateRecord.sessionsSince)
        ? stateRecord.sessionsSince.length
        : asNumber(stateRecord.sessionsSince, 0),
      counters: stateRecord.counters && typeof stateRecord.counters === 'object' ? stateRecord.counters : {},
      lastExtractAt: asNumber(stateRecord.lastExtractAt, 0),
      lastExtractReason:
        typeof stateRecord.lastExtractReason === 'string' ? stateRecord.lastExtractReason : '',
    },
    changelogTail: typeof record.changelogTail === 'string' ? record.changelogTail : '',
    trashCount: asNumber(record.trashCount, 0),
    rules: normalizeRules(record.rules),
    metrics: normalizeMetrics(record.metrics),
    readiness: normalizeReadiness(record.readiness),
    health: (() => {
      const candidate =
        record.health && typeof record.health === 'object'
          ? record.health.memoryHealth && typeof record.health.memoryHealth === 'object'
            ? record.health.memoryHealth
            : record.health
          : null;
      let normalized;
      if (
        candidate !== null &&
        (candidate.score !== undefined ||
          Array.isArray(candidate.suggestions) ||
          (candidate.dimensions && typeof candidate.dimensions === 'object'))
      ) {
        normalized = normalizeHealth(candidate);
      } else {
        normalized = normalizeHealth(
          record.healthScore === undefined || record.healthScore === null
            ? candidate
            : { score: record.healthScore },
        );
      }
      // Keep the nested `memoryHealth` block for consumers (verifier/API
      // parity) while the card reads the flattened fields above.
      const nested = {
        score: normalized.score,
        dimensions: normalized.dimensions,
        suggestions: normalized.suggestions,
      };
      const outer = record.health && typeof record.health === 'object' ? record.health : {};
      return {
        ...normalized,
        ok: outer.ok === true,
        warnings: Array.isArray(outer.warnings) ? outer.warnings : [],
        memoryHealth: nested,
      };
    })(),
    session: {
      live:
        record.session && typeof record.session === 'object' && typeof record.session.live === 'boolean'
          ? record.session.live
          : null,
    },
    dreamHistory: normalizeDreamHistory(record.dreamHistory),
    subagentPolicy: {
      mode:
        record.subagentPolicy && (record.subagentPolicy.mode === 'shared' || record.subagentPolicy.mode === 'own')
          ? record.subagentPolicy.mode
          : 'off',
      agentMemoryPresets:
        record.subagentPolicy && Array.isArray(record.subagentPolicy.agentMemoryPresets)
          ? record.subagentPolicy.agentMemoryPresets.filter((name) => typeof name === 'string')
          : [],
    },
  };
}

/** Normalize a /file payload (with v7 provenance read from either level). */
export function normalizeFile(raw) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const rawText = typeof record.raw === 'string' ? record.raw : '';
  const frontmatter =
    record.frontmatter && typeof record.frontmatter === 'object' ? record.frontmatter : null;
  const via =
    typeof record.via === 'string'
      ? record.via
      : frontmatter && typeof frontmatter.via === 'string'
        ? frontmatter.via
        : '';
  const sourceSession =
    typeof record.sourceSession === 'string'
      ? record.sourceSession
      : frontmatter && typeof frontmatter.source_session === 'string'
        ? frontmatter.source_session
        : '';
  return {
    file: typeof record.file === 'string' ? record.file : '',
    frontmatter,
    body: typeof record.body === 'string' ? record.body : rawText,
    raw: rawText,
    // The edit baseline: `expectedHash` goes back on save so the store can
    // refuse an overwrite of a page another window changed meanwhile.
    version: typeof record.version === 'string' ? record.version : '',
    expectedHash: typeof record.expectedHash === 'string' ? record.expectedHash : '',
    via,
    sourceSession,
    created:
      typeof record.created === 'string'
        ? record.created
        : frontmatter && typeof frontmatter.created === 'string'
          ? frontmatter.created
          : '',
  };
}

function normalizePreviewLines(value) {
  return Array.isArray(value) ? value
    .filter((item) => item && Number.isInteger(item.line) && item.line > 0 && typeof item.text === 'string')
    .map((item) => ({ line: item.line, text: item.text })) : [];
}

/** One `/file-history` response → `{changes:[...], refs:[...]}`. */
export function normalizeFileHistory(raw) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const source = record.result && typeof record.result === 'object' ? record.result : record;
  const refs = Array.isArray(source.planRefs) ? source.planRefs : Array.isArray(source.refs) ? source.refs : [];
  return {
    changelog: Array.isArray(source.changelog) ? source.changelog.filter((line) => typeof line === 'string').slice(-20) : [],
    refs: refs
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        type: 'dream',
        id: typeof item.id === 'string' ? item.id : '',
        at: asNumber(item.appliedAt ?? item.createdAt, 0),
        ops: asNumber(item.ops, 0),
         confirmedWithoutSource: item.confirmedWithoutSource === true,
         evidence: Array.isArray(item.evidence) ? item.evidence : [],
      }))
      .slice(0, 20),
  };
}

export function dreamEvidenceRows(items, t) {
  return items.map((item, index) => h('div', { key: index, className: 'ccm-evidence-row' },
    h('code', null, item.memoryFile || `${item.sessionId} #${item.seq}${item.role || item.eventType ? ` (${item.role || item.eventType})` : ''}`),
    item.quote ? h('span', null, ' — ' + item.quote) : null,
    item.verified === true ? null : h('span', { className: 'ccm-note-error' }, ` (${t('tidy.quoteUnchecked')})`),
    Array.isArray(item.claims) && item.claims.length > 0
      ? h('ul', null, ...item.claims.map((claim) => h('li', { key: claim }, claim))) : null));
}

/** Normalize a `/backups` or `/trash` response into `[{id,at,files[]}]`. */
export function normalizeBackupList(raw) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const source = record.result && typeof record.result === 'object' ? record.result : record;
  const items = Array.isArray(source.items) ? source.items : [];
  return items
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : String(item.name ?? ''),
      at: asNumber(item.at, 0),
      files: Array.isArray(item.files) ? item.files.filter((file) => typeof file === 'string') : [],
    }));
}

/** Cap one diff pane for display; the dialog itself never loads giant text. */
function truncatePreview(text) {
  const value = String(text === undefined || text === null ? '' : text);
  return value.length > 2000 ? value.slice(0, 2000) : value;
}
