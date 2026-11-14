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
import { dreamReadiness } from './readiness.js';
import { isProcessAlive } from './lock.js';
import { gatherDreamInput, pruneProbeSessions } from './dream-input.js';
import {
  costLimitStatus,
  dreamCostModeOf,
  estimateInputTokens,
  maxTotalTokensLimit,
  recordDreamEvent,
} from './dream.js';
import {
  applyShadowOperations,
  clearShadow,
  diffShadow,
  prepareShadow,
  shadowDirOf,
} from './dream-shadow.js';
import { ANALYZER_SYSTEM_PROMPT, buildAnalyzerPrompt, parseAnalyzerReply } from './dream-analyzer.js';
import { stampVerification, SUPERSEDED_LINE_RE, CONFLICT_LINE_RE } from './memory-body.js';
import { normalizeForMatch } from './dream-evidence.js';
import { supportsStatement } from './support.js';
import { verifyAnalysis } from './dream-verifier.js';
import { buildEvidence, checkWriteOperations } from './dream-write-evidence.js';
import { mergeClaims } from './dream-merge.js';
import { buildIndex } from './wiki-core.js';
import { scanSecrets, secretScanDecision, secretWarnings } from './secrets.js';
import { resolveModel, streamText } from './llm-call.js';
import {
  digestOf,
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
      let owner;
      try {
        stat = await fs.stat(file);
        owner = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        if (!stat) continue;
      }
      const age = Date.now() - stat.mtimeMs;
      const held = text(owner?.runId);
      const ownerAlive = isProcessAlive(owner?.pid);
      const resumingOwner = takeOverRunId !== '' && held === takeOverRunId;
      if (ownerAlive || (age < ttlMs && !resumingOwner)) {
        return { ok: false, reason: 'locked', age, runId: held };
      }
      // A dead run can resume immediately. Other orphaned locks must age out.
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
  const merged = { summary: '', claims: [], patches: [], verify: [], retire: [], warnings: [], verifiedFiles: [] };
  for (const part of parts) {
    if (!part) continue;
    merged.summary = [merged.summary, text(part.summary)].filter(Boolean).join(' ').trim();
    merged.claims.push(...(Array.isArray(part.claims) ? part.claims : []));
    merged.patches.push(...(Array.isArray(part.patches) ? part.patches : []));
    merged.verify.push(...(Array.isArray(part.verify) ? part.verify : []));
    merged.retire.push(...(Array.isArray(part.retire) ? part.retire : []));
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

/**
 * Current project pages in the shape the analyzer prompt shows them.
 * A page that cannot be read is reported, not silently dropped: the run is
 * built from these bodies, so a missing page must block an apply.
 */
async function memoryPagesOf(store) {
  const pages = [];
  const errors = [];
  for (const entry of await store.listEntries('project')) {
    let read;
    try {
      read = await store.readEntry(entry.file, 'project');
    } catch (error) {
      errors.push(`memory ${entry.file}: ${errorMessage(error)}`);
      continue;
    }
    if (!read) continue;
    pages.push({
      file: entry.file,
      name: entry.name,
      description: entry.description,
      type: pageType(entry.type),
      body: read.body,
    });
  }
  return { pages, errors };
}

/** The transport units of one gathered session, in reading order. */
function unitsOf(session) {
  return (session?.chunks ?? [])
    .map((chunk) => ({ text: chunk.text, firstSeq: chunk.firstSeq, lastSeq: chunk.lastSeq, evidenceBlocks: chunk.evidenceBlocks }))
    .filter((unit) => text(unit.text) !== '');
}

/** The analyzer prompt input for one unit; the estimate counts the same prompt. */
function analyzerPromptInput(task, memoryPages, focus, config) {
  return {
    sessionId: task.sessionId,
    when: task.session?.at ? new Date(Number(task.session.at)).toISOString().slice(0, 10) : '',
    transcript: text(task.unit.text),
    memoryPages,
    focus,
    maxMemoryChars: Number(config.dreamAnalyzerMemoryChars) || 12_000,
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
  /**
   * @param {{ctx:object, runtime:{config:object, engine:() => Promise<object>, track:(p:Promise<any>) => any}}} options
   */
  constructor({ ctx, runtime } = {}) {
    this.ctx = ctx;
    this.runtime = runtime;
  }

  #activeRuns = new Map();

  /** @returns {string[]} run ids a worker in this process is executing now. */
  liveRunIds() {
    return Array.from(this.#activeRuns.values(), ({ runId }) => runId);
  }

  get config() {
    return this.runtime.config;
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
   * The only way a run starts: in the background, returning its id at once.
   * `done` resolves to the run's result for a caller that waits. A second start
   * for the same project while one is active returns the active run instead of
   * spawning a competing worker.
   */
  async start(options = {}) {
    const paths = options.pctx?.paths;
    if (!paths) return { ok: false, started: false, error: 'no-project' };
    const key = paths.projectDir;
    const active = this.#activeRuns.get(key);
    if (active) {
      return { ok: true, started: false, reused: true, runId: active.runId, status: 'running', done: active.promise };
    }
    const runId = options.runId && options.runId !== '' ? options.runId : newRunId();
    const controller = new AbortController();
    const external = options.signal;
    const onAbort = () => controller.abort(external.reason);
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', onAbort, { once: true });
    }
    const promise = this.#run({ ...options, runId, signal: controller.signal })
      .catch((error) => ({ ran: false, error: errorMessage(error), runId }))
      .finally(() => {
        external?.removeEventListener('abort', onAbort);
        this.#activeRuns.delete(key);
      });
    this.#activeRuns.set(key, { runId, controller, promise });
    this.runtime.track(promise);
    return { ok: true, started: true, runId, status: 'running', done: promise };
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
      config,
      workspaceDir: pctx.workspaceDir,
      state: pctx.state,
      noSessions: noSessions === true,
      unitChars: UNIT_CHARS,
    });
    const { pages: memoryPages, errors: memoryErrors } = await memoryPagesOf(pctx.store);
    const errors = [...(input.errors ?? []), ...memoryErrors];
    const focusText = String(focus ?? '');
    let inputChars = 0;
    let sessions = 0;
    let units = 0;
    const ranges = [];
    for (const session of input.sessions) {
      const sessionUnits = unitsOf(session);
      if (text(session?.id) === '' || sessionUnits.length === 0) continue;
      sessions += 1;
      units += sessionUnits.length;
      // The estimate pins the range it priced: a session that grows before the
      // start keeps the confirmed boundary instead of silently adding work.
      ranges.push({ id: text(session.id), lastSeq: Number(session.maxSeq) || null });
      for (const unit of sessionUnits) {
        inputChars += promptCharsOf({ sessionId: session.id, session, unit }, memoryPages, focusText, config);
      }
    }
    const inputId = digestOf(JSON.stringify({ focus: focusText, ranges }));
    return {
      estimatedTokens: estimateInputTokens(inputChars),
      inputChars,
      limit: maxTotalTokensLimit(config),
      costMode: dreamCostModeOf(config),
      rough: true,
      sessions,
      units,
      focus: focusText,
      inputId,
      ranges,
      warnings: errors,
    };
  }

  /** Wait for an active run to finish; resolves immediately when it is not running. */
  /** Status of one run, or of the newest run for a project. */
  async status(pctx, runId = '') {
    const paths = pctx?.paths;
    if (!paths) return { ok: false, error: 'no-project' };
    const key = paths.projectDir;
    const active = this.#activeRuns.get(key);
    const wanted = runId !== '' ? runId : active?.runId || '';
    if (wanted !== '') {
      const manifest = await readRunManifest(runDirOf(paths, wanted));
      const running = active?.runId === wanted;
      if (manifest) return { ok: true, running, ...summarizeRun(manifest, { running }) };
      if (active?.runId === wanted) return { ok: true, running: true, runId: wanted, status: 'starting', stage: 'prepare' };
      return { ok: false, error: 'unknown-run', runId: wanted };
    }
    const [newest] = await listRunManifests(paths, 1);
    if (!newest) return { ok: true, runId: '', status: 'none' };
    return { ok: true, running: false, ...summarizeRun(newest.manifest, { running: false }) };
  }

  /** Stop an active run. Finished units stay on disk for a later resume. */
  async cancel(pctx, runId = '') {
    const paths = pctx?.paths;
    if (!paths) return { ok: false, error: 'no-project' };
    const key = paths.projectDir;
    const active = this.#activeRuns.get(key);
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
    const key = paths.projectDir;
    const active = this.#activeRuns.get(key);
    if (active) {
      // A run that just persisted its final status may still be unwinding.
      await active.promise.catch(() => {});
      const stillActive = this.#activeRuns.get(key);
      if (stillActive) return { ok: false, error: 'running', runId: stillActive.runId };
    }
    return this.start({
      ...options,
      pctx,
      runId,
      resume: true,
      force: true,
      trigger: manifest.trigger || 'resume',
      reason: manifest.reason || 'resumed',
    });
  }

  /**
   * Run one v2 dream pass.
   * @param {{pctx:object, force?:boolean, trigger?:string,
   *   reason?:string, signal?:AbortSignal, noSessions?:boolean, focus?:string,
   *   runId?:string, resume?:boolean}} options
   */
  async #run({
    pctx,
    force = false,
    trigger = 'manual',
    reason = '',
    signal,
    noSessions = false,
    focus = '',
    runId: runRunId,
    resume = false,
    inputId = '',
    inputRanges = null,
  } = {}) {
    const startedAt = Date.now();
    const config = this.config;
    const base = {
      ran: false,
      ready: false,
      skipped: false,
      summary: '',
      counts: { added: 0, changed: 0, removed: 0 },
      files: [],
      sessionsReviewed: 0,
      startedAt,
    };
    const finish = (extra = {}) => ({ ...base, ...extra, durationMs: Math.max(0, Date.now() - startedAt), finishedAt: Date.now() });

    const store = pctx?.store;
    const state = pctx?.state;
    const paths = pctx?.paths;
    if (!store || !state || !paths) return finish({ skipped: true, skipReason: 'no-project', error: 'no-project' });
    const skip = async (extra) => {
      const dir = runDirOf(paths, runRunId);
      // Keep a stopped run's record when a resume is blocked.
      const existing = resume ? await readRunManifest(dir) : null;
      const manifest = existing
        ? { ...existing, skipReason: extra.skipReason, updatedAt: Date.now() }
        : {
          runId: runRunId,
          projectId: paths.projectDirName || paths.projectId || '',
          status: 'skipped',
          stage: 'prepare',
          trigger,
          reason,
          dryRun: false,
          startedAt,
          updatedAt: Date.now(),
          finishedAt: Date.now(),
          skipReason: extra.skipReason,
          error: text(extra.error),
        };
      await writeRunManifest(dir, shapeManifest(manifest)).catch((error) => warn('write run manifest', error));
      return finish({ ...extra, skipped: true, runId: runRunId });
    };
    if (signal?.aborted) return skip({ skipReason: 'aborted' });
    if (config.enabled === false) return skip({ skipReason: 'disabled' });
    if (config.autoMemoryEnabled === false) return skip({ skipReason: 'auto-memory-disabled' });
    const lock = await acquireLock(paths.lockFile, config.lockTtlMs, {
      runId: runRunId,
      takeOverRunId: resume ? runRunId : '',
    });
    if (!lock.ok) {
      const blocked = { skipReason: 'lock', lockAgeMs: lock.age };
      // An active worker owns this manifest, so a blocked resume cannot write it.
      if (lock.runId === runRunId) return finish({ ...blocked, skipped: true, runId: runRunId });
      return skip(blocked);
    }

    let failure = true;
    const runDir = runDirOf(paths, runRunId);
    let manifestWrites = Promise.resolve();
    let failureManifest = null;
    let stage = 'prepare';
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
      dryRun: false,
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
    try {
      const snapshot = await state.read();
      if (force && snapshot.shadowPending) {
        return await skip({ skipReason: 'pending-switch', shadow: snapshot.shadowPending });
      }
      if (!force) {
        const readiness = dreamReadiness(pctx, { config, checkLock: false });
        const blocking = readiness.reasons.find(({ code }) => code !== 'min-sessions');
        if (blocking) return await skip({ skipReason: blocking.code });
        // Probe-only sessions must not count toward the automatic trigger.
        await pruneProbeSessions({ ctx: this.ctx, state });
        const afterPrune = dreamReadiness(pctx, { config, checkLock: false });
        if (!afterPrune.eligible) return await skip({ skipReason: afterPrune.reasons[0].code });
        await state.noteScan();
      }
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
      await state.markDreamStart();
      modelAnalyzer = resolveModel(this.ctx, {
        provider: config.dreamAnalyzerProvider,
        model: config.dreamAnalyzerModel,
      });
      if (!modelAnalyzer) {
        failure = false;
        await saveManifest({ status: 'skipped', skipReason: 'llm-unavailable', finishedAt: Date.now() });
        return finish({ skipped: true, skipReason: 'llm-unavailable', runId: runRunId });
      }

      stage = 'analyze';
      await saveManifest({ stage, status: 'running' });
      const input = await gatherDreamInput({
        ctx: this.ctx,
        config,
        workspaceDir: pctx.workspaceDir,
        state,
        noSessions: noSessions === true,
        unitChars: UNIT_CHARS,
      });
      const { pages: memoryPages, errors: memoryErrors } = await memoryPagesOf(store);
      if (memoryErrors.length > 0) input.errors.push(...memoryErrors);
      // v23: the estimate pins the range it priced. Sessions that grew (or
      // appeared) between the estimate and the start must not change the work
      // the user confirmed; a rewrite inside the pinned range is a stale input.
      if (text(inputId) !== '') {
        const pinned = Array.isArray(inputRanges) ? inputRanges : [];
        const limits = new Map(pinned.map((range) => [text(range?.id), Number(range?.lastSeq)]));
        const kept = [];
        for (const session of input.sessions) {
          const id = text(session?.id);
          if (!limits.has(id)) continue;
          const limitSeq = limits.get(id);
          if (!Number.isFinite(limitSeq)) {
            kept.push(session);
            continue;
          }
          const units = unitsOf(session).filter((unit) => Number(unit.lastSeq) <= limitSeq);
          if (units.length === 0) continue;
          kept.push({ ...session, chunks: units, maxSeq: limitSeq });
        }
        const actual = digestOf(JSON.stringify({
          focus: String(focus ?? ''),
          ranges: kept.map((session) => ({ id: text(session.id), lastSeq: Number(session.maxSeq) || null })),
        }));
        if (actual !== inputId) {
          failure = false;
          await saveManifest({
            status: 'skipped',
            skipReason: 'input-changed',
            error: 'the sessions changed since the estimate; run a new estimate before starting',
            finishedAt: Date.now(),
          });
          return finish({
            ok: false,
            skipped: true,
            error: 'stale-input',
            skipReason: 'input-changed',
            inputId: text(inputId),
            runId: runRunId,
          });
        }
        input.sessions = kept;
      }
      const memoryChars = memoryPages.reduce((sum, page) => sum + page.body.length, 0);
      inputChars += memoryChars;

      const sessionIds = [];
      const reads = [];
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
        reads.push({ id, seq: 0, complete: false });
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
          analyses.set(task.sessionId, { sessionId: task.sessionId, summary: '', claims: [], patches: [], verify: [], retire: [], warnings: [] });
        }
        const row = analyses.get(task.sessionId);
        row.summary = [row.summary, verified.summary].filter(Boolean).join(' ').trim();
        row.claims.push(...verified.claims);
        row.patches.push(...verified.patches);
        row.verify.push(...verified.verify);
        row.retire.push(...(Array.isArray(verified.retire) ? verified.retire : []));
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
          const row = analyses.get(task.sessionId) || { sessionId: task.sessionId, summary: '', claims: [], patches: [], verify: [], retire: [], warnings: [], failures: 0 };
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
      // A stop must not slide into the merge and write a partial copy.
      if (signal?.aborted) {
        const aborted = new Error('cancelled by user');
        aborted.name = 'AbortError';
        throw aborted;
      }
      if (analyzerStage.calls === 0 && sessionIds.length === 0 && input.deferredSessions.length === 0 && !noSessions) {
        // This run already owns its manifest (a sync run has no requested id),
        // so close it here or it would read as interrupted forever.
        await saveManifest({ status: 'skipped', skipReason: 'nothing-new', finishedAt: Date.now(), counts: countUnits() });
        return finish({ skipped: true, skipReason: 'nothing-new', sessionsReviewed: 0, runId: runRunId });
      }
      await saveManifest({ stage: 'analyze', counts: countUnits() });

      // Merge per-session results and build coverage.
      const merged = [];
      const failedSessions = [];
      const partialSessions = [...input.deferredSessions];
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
            retire: mergeUnique(row.retire ?? [], (item) => item.file),
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
      const expectedSessions = sessionIds.length + input.deferredSessions.length;
      failureManifest = {
        startedAt,
        dryRun: false,
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
        if (decision.warn === true) secretWarningsList.push(...secretWarnings(scanSecrets(op.body).matches));
      }
      organizerCounts.writes = operations.filter((op) => op.op === 'write').length;
      organizerCounts.indexEntries = operations.filter((op) => op.op === 'index').length;
      // Claims the merge could not back with a verified citation are reported,
      // never queued: a run either writes a page or leaves the fact out.
      summaryText = operations.length > 0
        ? `${merged.length} session(s) placed ${organizerCounts.writes} page change(s)${reviewItems.length > 0 ? `; ${reviewItems.length} claim(s) left for review` : ''}`
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

      const warnings = [
        ...(input.errors || []),
        ...analyzerStage.failures.map((failure) => `${failure.sessionId}: ${failure.error}`),
        ...secretWarningsList,
      ];

      // Cost is judged on what the run actually spent, before anything is
      // written into the copy.
      const cost = costLimitStatus(config, usage);
      const costExceeded = cost.exceeded === true;
      if (costExceeded) {
        warnings.push(`cost-limit-exceeded: totalTokens ${cost.totalTokens} > limit ${cost.limit} (dreamCostMode=${costMode})`);
      }
      const coverageComplete = merged.length === expectedSessions
        && failedSessions.length === 0
        && partialSessions.length === 0
        && (input.errors?.length ?? 0) === 0;

      const manifestBase = {
        kind: 'dream',
        mode: 'v2',
        trigger,
        startedAt,
        finishedAt: 0,
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
        operations: operations.length,
        applied: false,
      };

      // A blocked run writes nothing: the cost guard stops after the model has
      // already answered, and a pending copy must not be produced then.
      if (costExceeded && costMode === 'block') {
        const message = `cost-limit: totalTokens ${cost.totalTokens} > limit ${cost.limit} (dreamCostMode=block); nothing was applied`;
        const blockedManifest = await saveManifest({
          ...manifestBase,
          stage: 'blocked',
          status: 'blocked',
          finishedAt: Date.now(),
          coverageComplete: false,
          counts: countUnits(),
          blockedReason: message,
          error: message,
        });
        await state.markDreamFailed(message);
        await state.noteCostExceeded(true);
        await recordDreamEvent(paths, {
          event: 'failed',
          durationMs: Date.now() - startedAt,
          inputChars,
          outputChars,
          usage,
          planOps: operations.length,
          rollback: false,
        });
        failure = false;
        return finish({
          ok: false,
          ran: true,
          ready: false,
          error: 'cost-limit',
          costExceeded: true,
          costMode,
          estimatedTokens,
          limit: cost.limit,
          totalTokens: cost.totalTokens,
          summary: summaryText,
          sessionsReviewed: merged.length,
          runId: runRunId,
          manifest: blockedManifest,
          warnings,
        });
      }

      // Units that never finished stop the run before any copy is produced:
      // a partial copy would look like a complete one to the human.
      if (failedSessions.length > 0 || partialSessions.length > 0) {
        const failedUnits = analyzerStage.failures.length;
        const message = `${failedUnits > 0 ? failedUnits : failedSessions.length + partialSessions.length} unit(s) failed; nothing was written`;
        const failedManifest = await saveManifest({
          ...manifestBase,
          stage: 'done',
          status: 'failed',
          finishedAt: Date.now(),
          coverageComplete: false,
          counts: countUnits(),
          error: message,
        });
        await state.markDreamFailed(message);
        failure = false;
        return finish({
          ok: false,
          ran: true,
          ready: false,
          error: message,
          summary: summaryText,
          sessionsReviewed: merged.length,
          runId: runRunId,
          manifest: failedManifest,
          warnings,
        });
      }

      // Write the merged pages into a copy of the memory directory. A run never
      // edits the live notes: it ends with a pending copy that the human either
      // switches to or throws away.
      stage = 'shadow';
      const { shadowStore, base } = await prepareShadow({ store, paths, config });
      const shadowed = await applyShadowOperations({ shadowStore, operations });
      const diff = await diffShadow({ store, shadowStore });
      const pageSummary = summaryText || `dream: ${operations.length} page change(s)`;
      const finishedAt = Date.now();
      if (diff.files.length === 0) {
        await clearShadow(paths);
        const manifest = await saveManifest({
          ...manifestBase,
          stage: 'done',
          status: 'skipped',
          skipReason: 'nothing-new',
          finishedAt,
          applied: false,
          coverageComplete,
          counts: countUnits(),
        });
        await state.markDreamDone({
          sessions: merged.length,
          ops: 0,
          files: 0,
          summary: pageSummary,
          mode: 'shadow',
          durationMs: finishedAt - startedAt,
          inputChars,
          outputChars,
          usage,
          costExceeded,
        });
        await state.clearSessions(sessionIds, { reads });
        failure = false;
        return finish({
          ok: true,
          ran: true,
          ready: false,
          skipped: true,
          skipReason: 'nothing-new',
          summary: pageSummary,
          sessionsReviewed: merged.length,
          runId: runRunId,
          manifest,
          warnings,
        });
      }
      const counts = {
        added: diff.added.length,
        changed: diff.changed.length,
        removed: diff.removed.length,
      };
      await state.setShadowPending({
        dir: shadowDirOf(paths),
        createdAt: finishedAt,
        runId: runRunId,
        summary: pageSummary,
        base,
        files: diff.files,
        counts,
        sessions: [...sessionIds],
        verifiedFiles: [...new Set(verifiedFiles)],
        verifiedClaims: verifiedClaims.filter((item) => verifiedFiles.includes(item.file)),
      });
      await state.markDreamDone({
        sessions: merged.length,
        ops: shadowed.counts.write + shadowed.counts.delete + shadowed.counts.index,
        files: shadowed.touched.size,
        summary: pageSummary,
        mode: 'shadow',
        durationMs: finishedAt - startedAt,
        inputChars,
        outputChars,
        usage,
        costExceeded,
      });
      // Only sessions this run actually read may move their watermark.
      await state.clearSessions(sessionIds, { reads });
      const manifest = await saveManifest({
        ...manifestBase,
        stage: 'done',
        status: 'ready',
        finishedAt,
        applied: false,
        coverageComplete,
        counts: countUnits(),
        applyCounts: shadowed.counts,
        error: '',
      });
      failure = false;
      return finish({
        ok: true,
        ran: true,
        ready: true,
        summary: pageSummary,
        counts,
        files: diff.files,
        sessionsReviewed: merged.length,
        runId: runRunId,
        ...(costExceeded ? { costExceeded: true } : {}),
        usage,
        inputChars,
        outputChars,
        provider: modelAnalyzer.provider,
        model: modelAnalyzer.model,
        manifest,
        warnings,
      });

    } catch (error) {
      const detail = errorMessage(error);
      const message = stage === 'merge' ? `Dream merge: ${detail}` : detail;
      const cancelled = signal?.aborted === true || error?.name === 'AbortError';
      try {
        await state.markDreamFailed(message);
      } catch (stateError) {
        warn('state.markDreamFailed', stateError);
      }
      // Claude Code parity: a failed run keeps its partial output store so the
      // human can inspect what it produced. The next run starts from a fresh
      // copy anyway (prepareShadow clears it first).
      const keptShadow = shadowDirOf(paths);
      if (!cancelled) {
        await recordDreamEvent(paths, {
          event: 'failed',
          durationMs: Date.now() - startedAt,
          inputChars,
          outputChars,
          usage,
          planOps: 0,
          dropped: 0,
          rollback: false,
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
        shadow: { dir: keptShadow, kept: true },
        manifest,
      });
    } finally {
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
    // Superseded and CONFLICT lines are derived, not claims about the present.
    .filter((line) => /\^\[/u.test(line) && !SUPERSEDED_LINE_RE.test(line) && !CONFLICT_LINE_RE.test(line));
  if (lines.length === 0) return false;
  return lines.every((line) => claims.some((item) => contains(item.claim, line)
    || supportsStatement(item.claim, line, { minRatio: 0.5, minMatched: 2 })
    // A `contradicts` verdict states the old value in `claim`; the line being
    // written carries the transcript's new value, so that is what has to match.
    || (item.result === 'contradicts' && (contains(item.quote, line)
      || supportsStatement(item.quote, line, { minRatio: 0.5, minMatched: 2 })))));
}
