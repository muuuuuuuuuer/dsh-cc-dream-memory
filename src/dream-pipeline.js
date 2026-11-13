/**
 * Dream: analyze every unit of every session, verify the quotes mechanically,
 * then merge the verified claims into pages on the host.
 *
 *   export transcripts
 *     -> analyzer per unit (concurrent, small JSON)
 *     -> host verifier (quote, source tag, date)
 *     -> host merge (append, replace with history, review)
 *     -> existing atomic apply / backup / undo
 *
 * A unit is one chunk of one session, keyed by
 * `sha256(sessionId, firstSeq, lastSeq, text)`; a truncated answer splits it
 * into two units rather than dropping the rest of the input.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { gatherDreamInput, pruneProbeSessions } from './dream-input.js';
import {
  costLimitStatus,
  dreamCostModeOf,
  dreamV2CoverageError,
  estimateInputTokens,
  maxTotalTokensLimit,
  recordDreamEvent,
  validateDreamPlan,
} from './dream.js';
import { ANALYZER_SYSTEM_PROMPT, buildAnalyzerPrompt, parseAnalyzerReply } from './dream-analyzer.js';
import { stampVerification, SUPERSEDED_LINE_RE } from './memory-body.js';
import { normalizeForMatch } from './dream-evidence.js';
import { supportsStatement } from './support.js';
import { verifyAnalysis } from './dream-verifier.js';import { buildEvidence, checkWriteOperations } from './dream-write-evidence.js';
import { mergeClaims } from './dream-merge.js';
import { buildIndex } from './wiki-core.js';
import { scanSecrets, secretScanDecision, secretWarnings } from './secrets.js';
import { resolveModel, streamText } from './llm-call.js';
import {
  newRunId,
  readRunManifest,
  readUnitRecord,
  runDirOf,
  shapeManifest,
  summarizeRun,
  unitIdOf,
  writeRunManifest,
  writeUnitRecord,
  listRunManifests,
} from './dream-run.js';

const LOCK_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ANALYZER_CALLS = 48;
// One unit is a transport-sized slice of a session, not a per-run budget.
// A unit that the model cannot finish is split, never truncated.
const UNIT_CHARS = 24_000;
const UNIT_MIN_SPLIT_CHARS = 3_000;

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function oneLine(value, max = 500) {
  const flat = text(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function errorMessage(error) {
  return error && typeof error === 'object' && error.message ? String(error.message) : String(error);
}

function timestampName(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-');
}

function mergeUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  const out = total && typeof total === 'object' ? { ...total } : {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (Number.isFinite(Number(usage[key]))) out[key] = (Number(out[key]) || 0) + Number(usage[key]);
  }
  return out;
}

function totalTokens(usage) {
  return Number(usage?.totalTokens) || (Number(usage?.inputTokens) || 0) + (Number(usage?.outputTokens) || 0);
}

function pageType(value, fallback = 'project') {
  return ['user', 'feedback', 'project', 'reference'].includes(value) ? value : fallback;
}

function safePage(file) {
  const name = oneLine(file, 200);
  if (!/^[\p{L}\p{N}._-]+\.md$/u.test(name) || name.includes('..')) return '';
  return name;
}

function pageMetaOf(file, body, entry = {}) {
  return {
    file,
    name: entry.name || file.replace(/\.md$/, ''),
    description: entry.description || '',
    type: pageType(entry.type),
    body,
  };
}

function mergeUnique(values, key) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(value);
  }
  return out;
}

async function mapLimit(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length || 1)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Simple cross-process lock using the existing `.consolidate-lock` path. */
async function acquireLock(file, ttlMs = LOCK_TTL_MS, { runId = '', takeOverRunId = '' } = {}) {
  const start = Date.now();
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: start, runId })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, 'wx');
      try {
        await handle.writeFile(payload, 'utf8');
      } finally {
        await handle.close();
      }
      return { ok: true, priorMtime: null };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, reason: errorMessage(error) };
      let stat;
      let held = '';
      try {
        stat = await fs.stat(file);
        held = text(JSON.parse(await fs.readFile(file, 'utf8'))?.runId);
      } catch {
        if (!stat) continue;
      }
      const age = Date.now() - stat.mtimeMs;
      // Resuming a run that this process no longer executes (crash, reload).
      if (takeOverRunId !== '' && held === takeOverRunId) {
        try {
          await fs.unlink(file);
        } catch {
          return { ok: false, reason: 'locked', age };
        }
        continue;
      }
      if (age < ttlMs) return { ok: false, reason: 'locked', age, runId: held };
      // Stale lock: remove it once and retry.
      try {
        await fs.unlink(file);
      } catch {
        return { ok: false, reason: 'locked', age };
      }
    }
  }
  return { ok: false, reason: 'locked' };
}

/** Renew the lock while a long run progresses; the TTL is an idle timeout. */
async function touchLock(file) {
  const now = new Date();
  try {
    await fs.utimes(file, now, now);
  } catch {
    // A vanished lock means the run lost its exclusivity; the next dream will
    // see no lock and start fresh, so this is not fatal for the current unit.
  }
}

/**
 * Halve a unit that the model could not finish. Both halves are analyzed, so
 * no text is dropped; only the transport size changes.
 */
function splitUnitText(unit) {
  const body = text(unit?.text).replace(/\r\n/gu, '\n');
  if (body.length < UNIT_MIN_SPLIT_CHARS * 2) return null;
  const lines = body.split('\n');
  let cut = 0;
  if (lines.length >= 4) {
    let used = 0;
    for (let index = 0; index < lines.length - 1; index += 1) {
      used += lines[index].length + 1;
      cut = used;
      if (used >= body.length / 2) break;
    }
  } else {
    // One long line: cut at the word boundary nearest the middle.
    const middle = Math.floor(body.length / 2);
    const space = body.indexOf(' ', middle);
    cut = space > 0 ? space + 1 : middle;
  }
  const first = body.slice(0, cut);
  const second = body.slice(cut);
  if (first.trim().length < UNIT_MIN_SPLIT_CHARS || second.trim().length < UNIT_MIN_SPLIT_CHARS) return null;
  const blocks = Array.isArray(unit?.evidenceBlocks) ? unit.evidenceBlocks : [];
  let offset = 0;
  let splitAt = blocks.length;
  for (let index = 0; index < blocks.length; index += 1) {
    const length = text(blocks[index]?.text).length;
    if (offset + length > cut) {
      splitAt = index;
      break;
    }
    offset += length + 1;
  }
  const headBlocks = blocks.slice(0, splitAt);
  const tailBlocks = blocks.slice(splitAt);
  return [
    { text: first, firstSeq: unit?.firstSeq ?? null, lastSeq: headBlocks.at(-1)?.seq ?? unit?.lastSeq ?? null, evidenceBlocks: headBlocks },
    { text: second, firstSeq: tailBlocks[0]?.seq ?? unit?.firstSeq ?? null, lastSeq: unit?.lastSeq ?? null, evidenceBlocks: tailBlocks },
  ];
}

function mergeVerified(parts) {
  const merged = { summary: '', claims: [], patches: [], verify: [], warnings: [], verifiedFiles: [] };
  for (const part of parts) {
    if (!part) continue;
    merged.summary = [merged.summary, text(part.summary)].filter(Boolean).join(' ').trim();
    merged.claims.push(...(Array.isArray(part.claims) ? part.claims : []));
    merged.patches.push(...(Array.isArray(part.patches) ? part.patches : []));
    merged.verify.push(...(Array.isArray(part.verify) ? part.verify : []));
    merged.warnings.push(...(Array.isArray(part.warnings) ? part.warnings : []));
    merged.verifiedFiles.push(...(Array.isArray(part.verifiedFiles) ? part.verifiedFiles : []));
  }
  return merged;
}

async function releaseLock(file) {
  try {
    await fs.unlink(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') warn('release dream lock', error);
  }
}

/** Current project pages in the shape the analyzer prompt shows them. */
async function memoryPagesOf(store) {
  const pages = [];
  for (const entry of await store.listEntries('project')) {
    const read = await store.readEntry(entry.file, 'project').catch(() => undefined);
    if (!read) continue;
    pages.push({
      file: entry.file,
      name: entry.name,
      description: entry.description,
      type: pageType(entry.type),
      body: read.body,
    });
  }
  return pages;
}

/** The transport units of one gathered session, in reading order. */
function unitsOf(session) {
  const units = Array.isArray(session?.chunks) && session.chunks.length > 0
    ? session.chunks.map((chunk) => ({
      text: chunk.text,
      firstSeq: chunk.firstSeq,
      lastSeq: chunk.lastSeq,
      evidenceBlocks: chunk.evidenceBlocks,
    }))
    : [{ text: text(session?.excerpt), firstSeq: session?.baseSeq ?? null, lastSeq: null, evidenceBlocks: session?.evidenceBlocks }];
  return units.filter((unit) => text(unit.text) !== '');
}

/** The analyzer prompt input for one unit; the estimate counts the same prompt. */
function analyzerPromptInput(task, memoryPages, focus, config) {
  return {
    sessionId: task.sessionId,
    when: task.session?.at ? new Date(Number(task.session.at)).toISOString().slice(0, 10) : '',
    transcript: text(task.unit.text),
    memoryPages,
    focus,
    maxMemoryChars: Number(config.dreamAnalyzerMemoryChars) || 48_000,
    maxTranscriptChars: Number.MAX_SAFE_INTEGER,
  };
}

/** Characters one analyzer call sends, system prompt included. */
function promptCharsOf(task, memoryPages, focus, config) {
  return ANALYZER_SYSTEM_PROMPT.length + buildAnalyzerPrompt(analyzerPromptInput(task, memoryPages, focus, config)).length;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

/**
 * Dream v2 engine.
 */
export class DreamPipeline {
  constructor({ ctx, runtime, config, getConfig, engine } = {}) {
    this.ctx = ctx;
    this.runtime = runtime;
    this._config = config && typeof config === 'object' ? config : {};
    this._getConfig = typeof getConfig === 'function' ? getConfig : null;
    this._engine = engine || null;
    // Run ids executing in this process, whichever entry point started them
    // (background start, a synchronous run or the scheduler).
    this._liveRuns = new Set();
  }

  /** @returns {string[]} run ids a worker in this process is executing now. */
  liveRunIds() {
    return [...this._liveRuns];
  }

  get config() {
    if (this._getConfig) {
      try {
        const live = this._getConfig();
        if (live && typeof live === 'object') return live;
      } catch {
        // fall through
      }
    }
    return this._config;
  }

  async engine() {
    if (this._engine) return this._engine;
    if (!this.runtime || typeof this.runtime.engine !== 'function') throw new Error('dream engine unavailable');
    this._engine = await this.runtime.engine();
    return this._engine;
  }

  _stageModel() {
    const config = this.config;
    const explicit = { provider: config.dreamAnalyzerProvider, model: config.dreamAnalyzerModel };
    if (!explicit.provider || !explicit.model) {
      explicit.provider = config.dreamProvider;
      explicit.model = config.dreamModel;
    }
    return resolveModel(this.ctx, config, explicit);
  }

  /**
   * One analyzer call for one transport unit. The retry prompt only compacts
   * injected memory; it never shortens the transcript.
   */
  async _analyzeUnit({ task, model, memoryPages, focus, config, signal, stats, stage, onUsage }) {
    const promptInput = analyzerPromptInput(task, memoryPages, focus, config);
    const prompt = buildAnalyzerPrompt(promptInput);
    stats.input += prompt.length;
    stage.calls += 1;
    const reply = await streamText({
      ctx: this.ctx,
      model,
      system: ANALYZER_SYSTEM_PROMPT,
      prompt,
      signal,
      maxTokens: Number(config.dreamAnalyzerMaxTokens) || 8192,
      purpose: 'cc-memory-dream-analyze',
      onUsage,
      retryPrompt: () => {
        const compact = buildAnalyzerPrompt({
          ...promptInput,
          maxMemoryChars: Math.min(promptInput.maxMemoryChars, 12_000),
        });
        const retry = `Compact retry: return only the most durable evidence. Use a one-sentence summary, at most 8 claims and 8 verdicts, and leave patches empty (the host merges claims into pages). Return empty arrays when appropriate.\n\n${compact}`;
        stage.retries += 1;
        stats.input += retry.length;
        return retry;
      },
    });
    stats.output += reply.text.length;
    const parsed = parseAnalyzerReply(reply.text, { maxClaims: Number.MAX_SAFE_INTEGER });
    if (!parsed) throw new Error('analyzer reply was not JSON');
    const verified = verifyAnalysis({
      analysis: parsed,
      transcript: text(task.unit.text),
      sessionId: task.sessionId,
      memoryFiles: memoryPages,
      evidenceBlocks: task.unit.evidenceBlocks,
      maxPatches: Number.MAX_SAFE_INTEGER,
      maxPatchChars: Number(config.dreamMaxFileChars) || 20_000,
    });
    return { verified };
  }

  /**
   * Start a run in the background and return its id immediately. A second
   * start for the same project while one is active returns the active id
   * instead of spawning a competing worker.
   */
  async start(options = {}) {
    const paths = options.pctx?.paths;
    if (!paths) return { ok: false, started: false, error: 'no-project' };
    const key = paths.projectDir || paths.memoryDir;
    const active = this._activeRuns?.get(key);
    if (active) {
      return { ok: true, started: false, reused: true, runId: active.runId, status: 'running' };
    }
    const runId = options.runId && options.runId !== '' ? options.runId : newRunId();
    const controller = new AbortController();
    const external = options.signal;
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', () => controller.abort(external.reason), { once: true });
    }
    this._activeRuns = this._activeRuns || new Map();
    const promise = this.run({ ...options, runId, signal: controller.signal })
      .catch((error) => ({ ran: false, error: errorMessage(error), runId }))
      .finally(() => {
        if (this._activeRuns?.get(key)?.runId === runId) this._activeRuns.delete(key);
      });
    this._activeRuns.set(key, { runId, controller, promise });
    if (this.runtime && typeof this.runtime.track === 'function') this.runtime.track(promise);
    return { ok: true, started: true, runId, status: 'running' };
  }

  /**
   * Read-only preflight: what the next run would send to the analyzer. No model
   * call, lock, metrics or session-watermark write.
   */
  async estimate({ pctx, noSessions = false, focus = '' } = {}) {
    if (!pctx?.store || !pctx?.state) throw new Error('no-project');
    const config = this.config;
    const input = await gatherDreamInput({
      ctx: this.ctx,
      store: pctx.store,
      config,
      workspaceDir: pctx.workspaceDir,
      state: pctx.state,
      noSessions: noSessions === true,
      unboundedSessions: true,
      unitChars: UNIT_CHARS,
    });
    const memoryPages = await memoryPagesOf(pctx.store);
    const focusText = String(focus ?? '');
    let inputChars = 0;
    let sessions = 0;
    for (const session of input.sessions) {
      const units = unitsOf(session);
      if (text(session?.id) === '' || units.length === 0) continue;
      sessions += 1;
      for (const unit of units) {
        inputChars += promptCharsOf({ sessionId: session.id, session, unit }, memoryPages, focusText, config);
      }
    }
    return {
      estimatedTokens: estimateInputTokens(inputChars),
      inputChars,
      limit: maxTotalTokensLimit(config),
      costMode: dreamCostModeOf(config),
      rough: true,
      sessions,
      warnings: input.errors ?? [],
    };
  }

  /** Wait for an active run to finish; resolves immediately when it is not running. */
  async settled(pctx, runId = '') {
    const paths = pctx?.paths;
    if (!paths) return { ok: false, error: 'no-project' };
    const key = paths.projectDir || paths.memoryDir;
    const active = this._activeRuns?.get(key);
    if (active && (runId === '' || active.runId === runId)) {
      await active.promise.catch(() => {});
      return { ok: true, runId: active.runId };
    }
    return { ok: true, runId };
  }

  /** Status of one run, or of the newest run for a project. */
  async status(pctx, runId = '') {
    const paths = pctx?.paths;
    if (!paths) return { ok: false, error: 'no-project' };
    const key = paths.projectDir || paths.memoryDir;
    const active = this._activeRuns?.get(key);
    const wanted = runId !== '' ? runId : active?.runId || '';
    if (wanted !== '') {
      const manifest = await readRunManifest(runDirOf(paths, wanted));
      const running = active?.runId === wanted || this._liveRuns.has(wanted);
      if (manifest) return { ok: true, running, ...summarizeRun(manifest, { running }) };
      if (active?.runId === wanted) return { ok: true, running: true, runId: wanted, status: 'starting', stage: 'prepare' };
      return { ok: false, error: 'unknown-run', runId: wanted };
    }
    const [newest] = await listRunManifests(paths, 1);
    if (!newest) return { ok: true, runId: '', status: 'none' };
    const running = this._liveRuns.has(newest.manifest?.runId);
    return { ok: true, running, ...summarizeRun(newest.manifest, { running }) };
  }

  /** Stop an active run. Finished units stay on disk for a later resume. */
  async cancel(pctx, runId = '') {
    const paths = pctx?.paths;
    if (!paths) return { ok: false, error: 'no-project' };
    const key = paths.projectDir || paths.memoryDir;
    const active = this._activeRuns?.get(key);
    if (!active) return { ok: false, error: 'not-running', runId };
    if (runId !== '' && active.runId !== runId) return { ok: false, error: 'not-running', runId };
    active.controller.abort(new Error('cancelled by user'));
    return { ok: true, runId: active.runId, status: 'cancelling' };
  }

  /** Re-drive a failed or cancelled run, reusing every verified unit. */
  async resume(pctx, runId, options = {}) {
    const paths = pctx?.paths;
    if (!paths) return { ok: false, error: 'no-project' };
    if (typeof runId !== 'string' || runId === '') return { ok: false, error: 'run-id-required' };
    const manifest = await readRunManifest(runDirOf(paths, runId));
    if (!manifest) return { ok: false, error: 'unknown-run', runId };
    if (manifest.status === 'done') return { ok: false, error: 'already-done', runId };
    const key = paths.projectDir || paths.memoryDir;
    const active = this._activeRuns?.get(key);
    if (active) {
      // A run that just persisted its final status may still be unwinding.
      await active.promise.catch(() => {});
      const stillActive = this._activeRuns?.get(key);
      if (stillActive) return { ok: false, error: 'running', runId: stillActive.runId };
    }
    return this.start({
      ...options,
      pctx,
      runId,
      resume: true,
      force: true,
      dryRun: manifest.dryRun === true,
      trigger: manifest.trigger || 'resume',
      reason: manifest.reason || 'resumed',
    });
  }

  /**
   * Run one v2 dream pass.
   * @param {{pctx:object, agent?:object, force?:boolean, dryRun?:boolean, trigger?:string,
   *   reason?:string, signal?:AbortSignal, noSessions?:boolean, focus?:string,
   *   runId?:string, resume?:boolean}} options
   */
  async run({
    pctx,
    agent,
    force = false,
    dryRun = false,
    trigger = 'manual',
    reason = '',
    signal,
    noSessions = false,
    focus = '',
    runId: requestedRunId = '',
    resume = false,
  } = {}) {
    const startedAt = Date.now();
    const config = this.config;
    const base = {
      ran: false,
      applied: false,
      rolledBack: false,
      mode: config.dreamMode === 'review' ? 'review' : 'apply',
      dryRun: dryRun === true,
      summary: '',
      operations: 0,
      filesTouched: 0,
      sessionsReviewed: 0,
      startedAt,
    };
    const finish = (extra = {}) => ({ ...base, ...extra, durationMs: Math.max(0, Date.now() - startedAt), finishedAt: Date.now() });

    const store = pctx?.store;
    const state = pctx?.state;
    const paths = pctx?.paths;
    if (!store || !state || !paths) return finish({ skipped: true, skipReason: 'no-project', error: 'no-project' });
    // A requested run id means the caller already holds this run's identity
    // (start/resume). Record the skip so `dream status` can explain it.
    const skip = async (extra) => {
      if (requestedRunId !== '') {
        const dir = runDirOf(paths, requestedRunId);
        // A resume that cannot start keeps the stopped run's record (status,
        // units, counts) so it can still be resumed once the blocker clears.
        const existing = resume === true ? await readRunManifest(dir) : null;
        const manifest = existing
          ? { ...existing, skipReason: extra.skipReason, updatedAt: Date.now() }
          : {
            runId: requestedRunId,
            projectId: paths.projectDirName || paths.projectId || '',
            status: 'skipped',
            stage: 'prepare',
            trigger,
            reason,
            dryRun: dryRun === true,
            startedAt,
            updatedAt: Date.now(),
            finishedAt: Date.now(),
            skipReason: extra.skipReason,
            error: text(extra.error),
          };
        await writeRunManifest(dir, shapeManifest(manifest)).catch((error) => warn('write run manifest', error));
      }
      return finish({ ...extra, skipped: true, runId: requestedRunId });
    };
    if (signal?.aborted) return skip({ skipReason: 'aborted' });
    if (config.enabled === false) return skip({ skipReason: 'disabled' });
    if (config.autoMemoryEnabled === false) return skip({ skipReason: 'auto-memory-disabled' });
    if (!force) {
      // Probe-only sessions are not conversations; drop them before the
      // minSessions gate so a few health checks cannot wake Dream.
      try {
        await pruneProbeSessions({ ctx: this.ctx, state });
      } catch (error) {
        warn('prune probe sessions', error);
      }
    }

    const snapshot = typeof state.snapshot === 'function' ? state.snapshot() : {};
    if (typeof snapshot.pendingProposal === 'string' && snapshot.pendingProposal !== '') {
      return skip({ skipReason: 'pending-proposal', proposalPath: snapshot.pendingProposal });
    }
    if (!force) {
      const lastDreamAt = Number(snapshot.lastDreamAt) || 0;
      const minHours = Number(config.minHours) || 0;
      if (lastDreamAt > 0 && Date.now() - lastDreamAt < minHours * 60 * 60 * 1000) {
        return skip({ skipReason: 'hours', lastDreamAt });
      }
      const sessions = Array.isArray(snapshot.sessionsSince) ? snapshot.sessionsSince : [];
      const distinct = new Set(sessions.map((item) => (typeof item === 'string' ? item : item?.id)).filter(Boolean));
      const minSessions = Number(config.minSessions) || 0;
      if (distinct.size < minSessions) {
        return skip({ skipReason: 'sessions', sessionsSince: distinct.size, minSessions });
      }
    }

    const runRunId = requestedRunId !== '' ? requestedRunId : newRunId(startedAt);
    const lock = await acquireLock(paths.lockFile, Number(config.lockTtlMs) || LOCK_TTL_MS, {
      runId: runRunId,
      takeOverRunId: resume === true ? runRunId : '',
    });
    if (!lock.ok) return skip({ skipReason: 'lock', lockAgeMs: lock.age, runId: lock.runId || '' });
    this._liveRuns.add(runRunId);

    let failure = true;
    const runDir = runDirOf(paths, runRunId);
    let manifestWrites = Promise.resolve();
    let failureManifest = null;
    let stage = 'prepare';
    let plan = null;
    let usage = null;
    let inputChars = 0;
    let outputChars = 0;
    let modelAnalyzer = null;
    let countUnits = () => ({ done: 0, failed: 0, pending: 0 });
    let costMode = 'warn';
    let tokenLimit = 0;
    let estimatedTokens = 0;
    let runManifest = shapeManifest({
      runId: runRunId,
      projectId: paths.projectDirName || paths.projectId || '',
      trigger,
      reason,
      dryRun: dryRun === true,
      startedAt,
      updatedAt: startedAt,
      status: 'running',
      stage: 'prepare',
    });
    const saveManifest = async (patch = {}) => {
      runManifest = shapeManifest({
        ...runManifest,
        ...patch,
        runId: runRunId,
        startedAt,
        usage,
        updatedAt: Date.now(),
      });
      // Units finish in parallel and each one persists progress. Windows cannot
      // rename over a manifest another writer still holds, so serialize writes.
      const snapshot = structuredClone(runManifest);
      manifestWrites = manifestWrites
        .then(() => writeRunManifest(runDir, snapshot))
        .catch((error) => warn('write run manifest', error));
      await manifestWrites;
      return runManifest;
    };
    const priorManifest = resume === true ? await readRunManifest(runDir) : null;
    if (priorManifest && typeof priorManifest === 'object') {
      runManifest = shapeManifest({
        ...priorManifest,
        runId: runRunId,
        status: 'running',
        stage: 'prepare',
        startedAt,
        finishedAt: 0,
        error: '',
        blockedReason: '',
        updatedAt: startedAt,
      });
    }
    await saveManifest();

    // Claim-level merge is the default: the host places every verified claim
    // command, where a whole-library rewrite is the point.

    try {
      if (typeof state.markDreamStart === 'function') await state.markDreamStart();
      modelAnalyzer = this._stageModel('analyzer');
      if (!modelAnalyzer) {
        failure = false;
        await saveManifest({ status: 'skipped', skipReason: 'llm-unavailable', finishedAt: Date.now() });
        return finish({ skipped: true, skipReason: 'llm-unavailable', runId: runRunId });
      }

      stage = 'analyze';
      await saveManifest({ stage, status: 'running' });
      const input = await gatherDreamInput({
        ctx: this.ctx,
        store,
        config,
        workspaceDir: pctx.workspaceDir,
        state,
        noSessions: noSessions === true,
        unboundedSessions: true,
        unitChars: UNIT_CHARS,
      });
      const memoryPages = await memoryPagesOf(store);
      const memoryChars = memoryPages.reduce((sum, page) => sum + page.body.length, 0);
      inputChars += memoryChars;

      const sessionIds = [];
      const reads = [];
      const readMarks = new Map((Array.isArray(input.reads) ? input.reads : []).map((read) => [read.id, read]));
      const tasks = [];
      const expectedUnits = new Map();
      const manifestSessions = [];
      const unitState = new Map();
      const priorUnits = new Map();
      for (const session of priorManifest?.input?.sessions ?? []) {
        for (const unit of session?.units ?? []) priorUnits.set(unit.unitId, { ...unit, sessionId: session.id });
      }
      for (const session of input.sessions) {
        const id = text(session?.id);
        if (id === '') continue;
        const usable = unitsOf(session);
        if (usable.length === 0) continue;
        sessionIds.push(id);
        expectedUnits.set(id, usable.length);
        reads.push({ id, seq: Number(readMarks.get(id)?.seq) || 0, complete: false });
        const record = { id, baseSeq: Number(session.baseSeq) || 0, lastSeq: Number(session.maxSeq) || null, units: [] };
        for (const unit of usable) {
          const unitId = unitIdOf({ sessionId: id, firstSeq: unit.firstSeq, lastSeq: unit.lastSeq, text: unit.text });
          const prior = priorUnits.get(unitId);
          const kept = prior && prior.status === 'done' ? 'done' : 'pending';
          record.units.push({
            unitId,
            firstSeq: unit.firstSeq ?? null,
            lastSeq: unit.lastSeq ?? null,
            chars: text(unit.text).length,
            status: kept,
          });
          unitState.set(unitId, record.units.at(-1));
          tasks.push({ session, sessionId: id, unit, unitId, index: record.units.length });
        }
        manifestSessions.push(record);
      }
      const pendingCount = tasks.filter((task) => unitState.get(task.unitId)?.status !== 'done').length;
      await saveManifest({
        stage: 'analyze',
        input: {
          sessions: manifestSessions,
          expectedUnits: tasks.length,
          memoryFiles: memoryPages.length,
        },
        models: {
          analyzer: `${modelAnalyzer.provider}/${modelAnalyzer.model}`,
          organizer: '',
        },
        counts: { done: tasks.length - pendingCount, failed: 0, pending: pendingCount },
      });

      // Preflight cost guard: block mode never pays for a model call.
      costMode = dreamCostModeOf(config);
      tokenLimit = maxTotalTokensLimit(config);
      estimatedTokens = estimateInputTokens(tasks
        .filter((task) => unitState.get(task.unitId)?.status !== 'done')
        .reduce((sum, task) => sum + promptCharsOf(task, memoryPages, focus, config), 0));
      if (costMode === 'block' && tokenLimit > 0 && estimatedTokens > tokenLimit) {
        failure = false;
        const message = `estimated ${estimatedTokens} tokens > limit ${tokenLimit} (dreamCostMode=block); no model was called`;
        await saveManifest({ status: 'skipped', skipReason: 'cost-limit', error: message, finishedAt: Date.now() });
        return finish({
          ok: false,
          skipped: true,
          skipReason: 'cost-limit',
          error: 'cost-limit',
          costMode,
          estimatedTokens,
          limit: tokenLimit,
          runId: runRunId,
        });
      }

      const analyzerStage = {
        name: 'analyze',
        model: `${modelAnalyzer.provider}/${modelAnalyzer.model}`,
        calls: 0,
        retries: 0,
        splits: 0,
        reused: 0,
        failures: [],
        durationMs: 0,
      };
      const analyzerStarted = Date.now();
      const analyses = new Map();
      const analysisRows = [];
      const concurrency = Math.max(1, Number(config.dreamAnalyzerConcurrency) || 3);
      const countUnitsForRun = () => {
        const units = [...unitState.values()];
        return {
          done: units.filter((unit) => unit.status === 'done').length,
          failed: units.filter((unit) => unit.status === 'failed').length,
          pending: units.filter((unit) => unit.status !== 'done' && unit.status !== 'failed').length,
        };
      };
      countUnits = countUnitsForRun;
      const applyVerified = (task, verified, meta = {}) => {
        if (!analyses.has(task.sessionId)) {
          analyses.set(task.sessionId, { sessionId: task.sessionId, summary: '', claims: [], patches: [], verify: [], warnings: [] });
        }
        const row = analyses.get(task.sessionId);
        row.summary = [row.summary, verified.summary].filter(Boolean).join(' ').trim();
        row.claims.push(...verified.claims);
        row.patches.push(...verified.patches);
        row.verify.push(...verified.verify);
        row.warnings.push(...verified.warnings);
        row.lastSeq = Math.max(row.lastSeq ?? 0, task.unit.lastSeq ?? 0);
        row.units = (row.units || 0) + 1;
        row.failures = row.failures || 0;
        analysisRows.push({ sessionId: task.sessionId, unitId: task.unitId, ...verified, ...meta });
      };
      const runUnit = async (task) => {
        if (signal?.aborted) throw new Error('dream aborted');
        const stateRow = unitState.get(task.unitId);
        const cached = await readUnitRecord(runDir, task.sessionId, task.unitId);
        if (cached?.status === 'done' && cached.verified) {
          if (stateRow) stateRow.status = 'done';
          analyzerStage.reused += 1;
          applyVerified(task, cached.verified, { reused: true });
          return;
        }
        if (stateRow) stateRow.status = 'running';
        const stats = { input: 0, output: 0 };
        let verified;
        try {
          ({ verified } = await this._analyzeUnit({
            task,
            model: modelAnalyzer,
            memoryPages,
            focus,
            config,
            signal,
            stats,
            stage: analyzerStage,
            onUsage: (attemptUsage) => { usage = mergeUsage(usage, attemptUsage); },
          }));
        } catch (error) {
          const parts = error?.code === 'LLM_MAX_TOKENS' ? splitUnitText(task.unit) : null;
          if (!parts) throw error;
          // Shrink the transport unit and analyze both halves: nothing is
          // dropped, the range is only re-read in smaller pieces.
          analyzerStage.splits += 1;
          const halves = [];
          for (const part of parts) {
            const { verified: half } = await this._analyzeUnit({
              task: { ...task, unit: part },
              model: modelAnalyzer,
              memoryPages,
              focus,
              config,
              signal,
              stats,
              stage: analyzerStage,
              onUsage: (attemptUsage) => { usage = mergeUsage(usage, attemptUsage); },
            });
            halves.push(half);
          }
          verified = mergeVerified(halves);
        }
        inputChars += stats.input;
        outputChars += stats.output;
        await writeUnitRecord(runDir, task.sessionId, task.unitId, {
          sessionId: task.sessionId,
          status: 'done',
          firstSeq: task.unit.firstSeq ?? null,
          lastSeq: task.unit.lastSeq ?? null,
          chars: text(task.unit.text).length,
          verified,
          completedAt: Date.now(),
        });
        if (stateRow) stateRow.status = 'done';
        applyVerified(task, verified);
        await touchLock(paths.lockFile);
        await saveManifest({ stage: 'analyze', counts: countUnits() });
      };
      await mapLimit(tasks, concurrency, async (task) => {
        const stateRow = unitState.get(task.unitId);
        try {
          await runUnit(task);
        } catch (error) {
          const reason = oneLine(errorMessage(error), 300);
          if (stateRow) {
            stateRow.status = 'failed';
            stateRow.error = reason;
          }
          analyzerStage.failures.push({ sessionId: task.sessionId, unitId: task.unitId, error: reason });
          const row = analyses.get(task.sessionId) || { sessionId: task.sessionId, summary: '', claims: [], patches: [], verify: [], warnings: [], failures: 0 };
          row.failures = (row.failures || 0) + 1;
          analyses.set(task.sessionId, row);
          await saveManifest({
            stage: 'analyze',
            counts: countUnits(),
            errors: [...(runManifest.errors ?? []), `${task.sessionId}: ${reason}`].slice(-20),
          });
        }
      });
      analyzerStage.durationMs = Date.now() - analyzerStarted;
      // A stop must not slide into the merge and apply a partial plan.
      if (signal?.aborted) {
        const aborted = new Error('cancelled by user');
        aborted.name = 'AbortError';
        throw aborted;
      }
      if (analyzerStage.calls === 0 && sessionIds.length === 0 && !input.deferredSessions?.length && !noSessions) {
        // This run already owns its manifest (a sync run has no requested id),
        // so close it here or it would read as interrupted forever.
        await saveManifest({ status: 'skipped', skipReason: 'nothing-new', finishedAt: Date.now(), counts: countUnits() });
        return finish({ skipped: true, skipReason: 'nothing-new', sessionsReviewed: 0, runId: runRunId });
      }
      await saveManifest({ stage: 'analyze', counts: countUnits() });

      // Merge per-session results and build coverage.
      const merged = [];
      const failedSessions = [];
      const partialSessions = [...(input.deferredSessions ?? [])];
      for (const sessionId of sessionIds) {
        const row = analyses.get(sessionId);
        if (!row || !row.units) {
          (row?.failures ? failedSessions : partialSessions).push(sessionId);
          continue;
        }
        const completedUnits = Number(row.units) || 0;
        const complete = completedUnits === expectedUnits.get(sessionId) && (Number(row.failures) || 0) === 0;
        const read = reads.find((item) => item.id === sessionId);
        if (read) {
          read.seq = Number(row.lastSeq) || read.seq;
          read.complete = complete;
        }
        if (complete) {
          merged.push({
            sessionId,
            summary: row.summary,
            claims: mergeUnique(row.claims, (item) => item.text),
            patches: row.patches,
            verify: row.verify,
            warnings: row.warnings,
          });
        } else {
          partialSessions.push(sessionId);
        }
      }
      if (noSessions) {
        merged.length = 0;
        reads.length = 0;
      }

      // Persist per-session analysis artifacts for replay and debugging.
      await fs.mkdir(runDir, { recursive: true });
      for (const row of analysisRows) {
        await writeJson(path.join(runDir, 'analysis', `${row.sessionId}.json`), row).catch((error) => warn('write analysis', error));
      }

      // Preserve analyzer diagnostics even when the merge produced nothing.
      const expectedSessions = sessionIds.length + (input.deferredSessions?.length ?? 0);
      failureManifest = {
        startedAt,
        dryRun: dryRun === true,
        expected: expectedSessions,
        processed: merged.length,
        failed: failedSessions,
        partial: partialSessions,
        stages: [analyzerStage],
      };
      const secretWarningsList = [];
      let operations = [];
      let reviewItems = [];
      let summaryText = '';
      const organizerCounts = { writes: 0, deletes: 0, conflicts: 0, indexEntries: 0 };
      stage = 'merge';
      await saveManifest({ stage: 'merge', counts: countUnits() });
      const mergedResult = mergeClaims({
        analyses: merged,
        memoryPages,
        indexText: '',
        title: '',
      });
      operations = mergedResult.operations;
      reviewItems = mergedResult.review;
      for (const warning of mergedResult.warnings) {
        if (!failureManifest.stages[0].warnings) failureManifest.stages[0].warnings = [];
        failureManifest.stages[0].warnings.push(warning);
      }
      for (const op of operations) {
        if (op.op !== 'write') continue;
        const decision = secretScanDecision(scanSecrets(op.body), config);
        if (decision.block) {
          throw new Error(`secret scan refused ${op.file}: a credential-like value would be persisted`);
        }
      }
      organizerCounts.writes = operations.filter((op) => op.op === 'write').length;
      organizerCounts.indexEntries = operations.filter((op) => op.op === 'index').length;
      summaryText = operations.length > 0
        ? `${merged.length} session(s) placed ${organizerCounts.writes} page change(s); ${reviewItems.length} item(s) need review`
        : 'nothing new to remember';

      // Final write gate: new lines must be backed by claims the
      // analyzer actually verified. Pure consolidation (no transcripts read)
      // has no fresh evidence and is exempt.
      const evidence = buildEvidence(merged);
      let evidenceWarnings = [];
      // Pure consolidation has no fresh evidence, but moving an existing line is
      // allowed; a genuinely new fact still needs a verified citation. Partial
      // coverage is blocked before apply, so it keeps its preview path.
      if (noSessions || (merged.length > 0 && failedSessions.length === 0 && partialSessions.length === 0)) {
        const checked = checkWriteOperations({ operations, currentPages: memoryPages, evidence });
        if (checked.dropped.length > 0) {
          const error = new Error(`EVIDENCE_REJECTED: ${checked.dropped.slice(0, 5).join('; ')}`);
          error.code = 'EVIDENCE_REJECTED';
          error.dropped = checked.dropped;
          throw error;
        }
        operations = checked.operations;
        evidenceWarnings = checked.warnings;
      }

      // Host-only verification stamp. A page qualifies only when *every* cited
      // fact line in it is matched by a verdict the analyzer actually supported;
      // one verified fact does not vouch for the rest of the page. Only the host
      // writes this line, and the apply layer records the same fact set.
      const verifiedClaims = [];
      for (const analysis of merged) {
        for (const item of Array.isArray(analysis?.verify) ? analysis.verify : []) {
          if (typeof item?.file !== 'string' || !item.source) continue;
          if (item.result !== 'holds' && item.result !== 'contradicts') continue;
          verifiedClaims.push({
            file: item.file,
            claim: item.claim,
            result: item.result,
            quote: typeof item.quote === 'string' ? item.quote : '',
          });
        }
      }
      const verifiedFiles = [];
      if (verifiedClaims.length > 0) {
        const stampDate = new Date().toISOString().slice(0, 10);
        operations = operations.map((op) => {
          if (op.op !== 'write') return op;
          const claims = verifiedClaims.filter((item) => item.file === op.file);
          if (claims.length === 0 || !pageFullyVerified(op.body, claims)) return op;
          verifiedFiles.push(op.file);
          return { ...op, body: stampVerification(op.body, stampDate) };
        });
      }

      const validation = validateDreamPlan(
        { summary: summaryText || `dream: ${operations.length} operation(s)`, operations },
        {
          config,
          existingFiles: memoryPages.map((page) => ({ file: page.file, name: page.name, scope: 'project' })),
          truncatedFiles: input.truncatedFiles,
        },
      );
      if (!validation.ok) throw new Error(`invalid dream v2 plan: ${validation.error ?? 'unknown error'}`);
      const coverageComplete = merged.length === expectedSessions && failedSessions.length === 0
        && partialSessions.length === 0 && validation.dropped.length === 0 && (input.errors?.length ?? 0) === 0;
      plan = {
        ...validation.plan,
        kind: 'dream-v2',
        coverageVersion: 1,
        coverageComplete,
        createdAt: new Date().toISOString(),
        dryRun: dryRun === true,
        applied: false,
        trigger,
        reason,
        verifiedFiles: [...new Set(verifiedFiles)],
        // The verdict text each stamped fact was checked against; the apply
        // layer re-checks the stored page against it before recording a
        // verification, because the page also carries facts no verdict covered.
        verifiedClaims: verifiedClaims.filter((item) => verifiedFiles.includes(item.file)),
        provider: modelAnalyzer.provider,
        model: modelAnalyzer.model,
        sessions: [...sessionIds, ...(input.deferredSessions ?? [])],
        reads: reads.filter((read) => read.complete === true),
        droppedSessions: input.droppedSessions || [],
        expectedSessions,
        processedSessions: merged.length,
        failedSessions,
        partialSessions,
        analysis: [...analyses.values()].map((row) => ({ ...row, patches: undefined })),
        evidence,
        evidenceWarnings,
        evidenceRequired: merged.length > 0,
        review: reviewItems,
        warnings: [...(input.errors || []), ...analyzerStage.failures.map((failure) => `${failure.sessionId}: ${failure.error}`), ...secretWarningsList],
        dropped: validation.dropped,
      };

      const manifestBase = {
        kind: 'dream',
        mode: 'v2',
        trigger,
        startedAt,
        finishedAt: 0,
        dryRun: dryRun === true,
        expected: expectedSessions,
        coverageComplete,
        processed: merged.length,
        failed: failedSessions,
        partial: partialSessions,
        organizer: {
          calls: 0,
          writes: organizerCounts.writes,
          deletes: organizerCounts.deletes,
          conflicts: organizerCounts.conflicts,
          indexEntries: organizerCounts.indexEntries,
          merge: 'host',
        },
        stages: [analyzerStage],
        operations: plan.operations.length,
        dropped: validation.dropped,
        applied: false,
      };

      // Usage and cost travel with the plan so preview and a later apply report them.
      const cost = costLimitStatus(config, usage);
      const costExceeded = cost.exceeded === true;
      Object.assign(plan, {
        durationMs: Date.now() - startedAt,
        inputChars,
        outputChars,
        usage,
        costMode,
        estimatedTokens,
        limit: tokenLimit,
        ...(costExceeded ? { costExceeded: true } : {}),
      });
      if (cost.warning !== '') plan.warnings.push(cost.warning);
      const dreamMetrics = { durationMs: plan.durationMs, inputChars, outputChars, usage };
      await recordDreamEvent(paths, { event: 'proposed', ops: plan.operations.length, planOps: plan.operations.length });
      if (costExceeded) await state.noteCostExceeded?.(true);

      // `block` refuses a plan whose real usage went over the limit: nothing is
      // applied and the plan stays in the run folder for inspection only.
      if (costExceeded && costMode === 'block' && !dryRun) {
        const message = `cost-limit: totalTokens ${cost.totalTokens} > limit ${cost.limit} (dreamCostMode=block); nothing was applied`;
        const planPath = path.join(runDir, 'plan.json');
        const manifest = await saveManifest({
          ...manifestBase,
          stage: 'blocked',
          status: 'blocked',
          finishedAt: Date.now(),
          planPath,
          coverageComplete,
          counts: countUnits(),
          blockedReason: message,
          error: message,
        });
        await writeJson(planPath, { ...plan, applied: false, manifest, blocked: true, blockedReason: message });
        await state.markDreamFailed(message);
        await recordDreamEvent(paths, { event: 'failed', ...dreamMetrics, planOps: plan.operations.length, dropped: validation.dropped.length, rollback: false });
        failure = false;
        return finish({
          ok: false,
          ran: true,
          applied: false,
          error: 'cost-limit',
          costExceeded: true,
          costMode,
          estimatedTokens,
          limit: cost.limit,
          totalTokens: cost.totalTokens,
          blockedPlanPath: planPath,
          summary: plan.summary,
          sessionsReviewed: merged.length,
          runId: runRunId,
          manifest,
          warnings: plan.warnings,
        });
      }

      const coverageError = dreamV2CoverageError(plan);
      if (dryRun || coverageError) {
        const planPath = path.join(runDir, 'plan.json');
        // A unit that ran out of retries is a failed run, not a plan the user
        // simply cannot apply yet: resuming retries only those units.
        const failedSessions = Array.isArray(plan.failedSessions) ? plan.failedSessions.length : 0;
        const failedUnits = countUnits().failed;
        const failedRun = !dryRun && failedUnits > 0;
        const runStatus = failedRun ? 'failed' : coverageError ? 'blocked' : 'ready';
        const manifest = await saveManifest({
          ...manifestBase,
          stage: failedRun ? 'analyze' : coverageError ? 'blocked' : 'ready',
          status: runStatus,
          finishedAt: Date.now(),
          planPath,
          coverageComplete,
          counts: countUnits(),
          blockedReason: coverageError || '',
          failedStage: failedRun ? 'analyze' : '',
          error: failedRun
            ? `${failedUnits} unit(s) failed; /memory dream resume ${runRunId} retries only those units`
            : '',
        });
        await writeJson(planPath, {
          ...plan,
          applied: false,
          manifest,
          ...(coverageError ? { blocked: true, blockedReason: coverageError } : {}),
        });
        await state.setLastPlan(planPath, 'dry-run');
        await state.clearDreamError();
        failure = false;
        return finish({
          ran: true,
          applied: false,
          dryRun: dryRun === true,
          mode: 'apply',
          summary: plan.summary,
          operations: plan.operations.length,
          filesTouched: 0,
          sessionsReviewed: merged.length,
          runId: runRunId,
          planPath,
          backupDir: runDir,
          manifest,
          ...(coverageError && !dryRun ? { error: coverageError } : {}),
          usage,
          inputChars,
          outputChars,
          review: plan.review ?? [],
          provider: modelAnalyzer.provider,
          model: modelAnalyzer.model,
          warnings: plan.warnings,
        });
      }

      // Review mode can also be requested by config; dry-run is checked first.
      if (wantsReview(config) || (costExceeded && costMode === 'review')) {
        const proposalPath = path.join(paths.pendingDir, `${timestampName(Date.now())}.json`);
        const manifest = await saveManifest({
          ...manifestBase,
          stage: 'review',
          status: 'review',
          finishedAt: Date.now(),
          planPath: proposalPath,
          coverageComplete,
          counts: countUnits(),
          error: '',
        });
        // Keep plan.review (the claims left for a person) instead of a boolean
        // `review` flag, which nothing reads.
        await writeJson(proposalPath, { ...plan, manifest });
        await state.setPendingProposal(proposalPath);
        failure = false;
        return finish({
          ran: true,
          applied: false,
          mode: 'review',
          summary: plan.summary,
          proposalPath,
          runId: runRunId,
          manifest,
          ...(costExceeded ? { costExceeded: true, reviewReason: 'cost-limit' } : {}),
          warnings: plan.warnings,
        });
      }

      const engine = await this.engine();
      if (signal?.aborted) {
        const aborted = new Error('cancelled by user');
        aborted.name = 'AbortError';
        throw aborted;
      }
      stage = 'apply';
      const execution = await engine.executePlan({
        store,
        paths,
        plan,
        config,
        operations: plan.operations,
        skill: '',
        changelog: {
          at: Date.now(),
          trigger,
          sessions: sessionIds.length,
          summary: plan.summary,
          notes: '',
          dropped: validation.dropped,
          durationMs: Date.now() - startedAt,
          inputChars,
          outputChars,
          usage,
          costExceeded,
          costMode: config.dreamCostMode || 'warn',
        },
        meta: {
          kind: 'dream-v2',
          planOps: plan.operations.length,
          summary: plan.summary,
          // Session ids, not a count: undo reopens exactly these sessions.
          sessions: [...sessionIds],
          durationMs: Date.now() - startedAt,
          inputChars,
          outputChars,
          usage,
          costExceeded,
          costMode: config.dreamCostMode || 'warn',
          trigger,
        },
      });

      // A page edited after the plan was built is a conflict the user must
      // resolve, not a write to force: report it and keep the run resumable.
      if (execution && execution.ok === false && execution.error === 'conflict') {
        const error = new Error('a memory page changed since this plan was built; run a fresh dream');
        error.code = 'CONFLICT';
        error.conflicts = execution.conflicts;
        throw error;
      }

      // SKILL.md is applied inside executePlan so it shares the batch backup and
      // undo metadata with the notes and index.
      // Only sessions this run actually read may move their watermark; a session
    // dropped from the input stays in `sessionsSince` so its turns are not lost.
    await state.clearSessions(sessionIds, { reads });
      await recordDreamEvent(paths, {
        event: 'applied',
        ops: execution.counts.write + execution.counts.delete + execution.counts.index,
        ...dreamMetrics,
        planOps: plan.operations.length,
        dropped: validation.dropped.length,
      });
      await state.markDreamDone({
        sessions: merged.length,
        ops: plan.operations.length,
        files: execution.touched.size,
        summary: plan.summary,
        mode: 'apply',
        durationMs: Date.now() - startedAt,
        inputChars,
        outputChars,
        usage,
        costExceeded,
      });
      await state.clearPendingProposal({ silent: true }).catch(() => {});
      await state.clearLastPlan().catch(() => {});
      try {
        this.runtime?.invalidateAllInjections?.('dream-v2');
      } catch {
        // best effort
      }
      const manifest = await saveManifest({
        ...manifestBase,
        stage: 'done',
        status: 'done',
        finishedAt: Date.now(),
        applied: true,
        coverageComplete,
        counts: countUnits(),
        inputChars,
        outputChars,
        backupDir: execution.backupDir,
        applyCounts: execution.counts,
        error: '',
      });
      failure = false;
      return finish({
        ran: true,
        applied: true,
        mode: 'apply',
        summary: plan.summary,
        operations: execution.counts.write + execution.counts.delete + execution.counts.index,
        filesTouched: execution.touched.size,
        sessionsReviewed: merged.length,
        runId: runRunId,
        backupDir: execution.backupDir,
        changelogPath: paths.changelogFile,
        manifest,
        ...(costExceeded ? { costExceeded: true } : {}),
        usage,
        inputChars,
        outputChars,
        provider: modelAnalyzer.provider,
        model: modelAnalyzer.model,
        warnings: plan.warnings,
      });
    } catch (error) {
      const detail = errorMessage(error);
      const message = stage === 'merge' ? `Dream merge: ${detail}` : detail;
      const cancelled = signal?.aborted === true || error?.name === 'AbortError';
      // A failed write is recorded once, by handleApplyFailure below: calling
      // markDreamFailed here too would count one failure twice and push the
      // auto-dream backoff two steps for a single bad apply.
      const applyFailure = stage === 'apply' && Boolean(error?.backupDir);
      try {
        if (!applyFailure) await state.markDreamFailed(message);
      } catch (stateError) {
        warn('state.markDreamFailed', stateError);
      }
      // A write that failed mid-apply rolled the batch back: record what was
      // restored or skipped, as every other apply path does.
      if (applyFailure) {
        try {
          await (await this.engine()).handleApplyFailure(state, store, error, {
            trigger,
            sessions: Array.isArray(plan?.sessions) ? plan.sessions.length : 0,
            summary: plan?.summary ?? '',
            notes: '',
            dropped: Array.isArray(plan?.dropped) ? plan.dropped : [],
          });
        } catch (failureError) {
          warn('record apply failure', failureError);
        }
      }
      if (!cancelled) {
        await recordDreamEvent(paths, {
          event: 'failed',
          durationMs: Date.now() - startedAt,
          inputChars,
          outputChars,
          usage,
          planOps: plan?.operations?.length ?? 0,
          dropped: 0,
          rollback: error?.rolledBack === true,
        });
      }
      const manifest = await saveManifest({
        ...(failureManifest || {}),
        stage,
        status: cancelled ? 'cancelled' : 'failed',
        finishedAt: Date.now(),
        applied: false,
        failedStage: stage,
        error: cancelled ? 'cancelled by user' : message,
        counts: countUnits(),
        inputChars,
        outputChars,
      });
      return finish({
        ran: true,
        error: message,
        applied: false,
        summary: '',
        operations: 0,
        sessionsReviewed: 0,
        runId: runRunId,
        manifest,
        ...(stage === 'apply' && error?.backupDir ? {
          rolledBack: error?.rolledBack === true,
          conflicts: Array.isArray(error?.rollbackConflicts) ? error.rollbackConflicts : [],
          rollbackError: error?.rollbackError,
          backupDir: error.backupDir,
        } : {}),
      });
    } finally {
      this._liveRuns.delete(runRunId);
      await releaseLock(paths.lockFile);
    }
  }
}

/**
 * Every cited fact line must be backed by one supported verdict: a page is not
 * verified because one line of it was, and a page without cited facts cannot be
 * verified at all.
 */
function pageFullyVerified(body, claims) {
  const contains = (text, line) => {
    const needle = normalizeForMatch(text);
    return needle.length >= 2 && normalizeForMatch(line).includes(needle);
  };
  const lines = String(body ?? '')
    .split(/\r?\n/u)
    // Superseded lines are derived history, not claims about the present.
    .filter((line) => /\^\[/u.test(line) && !SUPERSEDED_LINE_RE.test(line));
  if (lines.length === 0) return false;
  return lines.every((line) => claims.some((item) => contains(item.claim, line)
    || supportsStatement(item.claim, line, { minRatio: 0.5, minMatched: 2 })
    // A `contradicts` verdict states the old value in `claim`; the line being
    // written carries the transcript's new value, so that is what has to match.
    || (item.result === 'contradicts' && (contains(item.quote, line)
      || supportsStatement(item.quote, line, { minRatio: 0.5, minMatched: 2 })))));
}

function wantsReview(config) {
  return config.dreamMode === 'review';
}
