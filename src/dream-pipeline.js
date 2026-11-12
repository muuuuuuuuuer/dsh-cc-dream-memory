/**
 * Dream v2: analyze one transcript at a time, verify mechanically, then organize.
 *
 * This module replaces the single monolithic consolidation call with a bounded
 * pipeline:
 *
 *   export transcripts
 *     -> analyzer per session (concurrent, small JSON)
 *     -> host verifier (quotes, source tag, date)
 *     -> organizer (one call, page writes)
 *     -> existing atomic apply / backup / undo
 *
 * The existing `DreamEngine` remains the apply layer and the classic pipeline is
 * still available for compatibility. v2 is selected by `dreamPipeline: 'v2'`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { gatherDreamInput } from './dream-input.js';
import { dreamV2CoverageError, validateDreamPlan } from './dream.js';
import { ANALYZER_SYSTEM_PROMPT, buildAnalyzerPrompt, parseAnalyzerReply } from './dream-analyzer.js';
import { stampVerification, SUPERSEDED_LINE_RE } from './memory-body.js';
import { normalizeForMatch } from './dream-evidence.js';
import { supportsStatement } from './support.js';
import { bodyHasStatement, verifyAnalysis } from './dream-verifier.js';
import { buildEvidence, checkWriteOperations } from './dream-write-evidence.js';
import { ORGANIZER_SYSTEM_PROMPT, buildOrganizerPrompt, parseOrganizerReply, renderRelatedLinks } from './dream-organizer.js';
import { buildIndex, buildSkill, citationToken } from './wiki-core.js';
import { scanSecrets, secretScanDecision, secretWarnings } from './secrets.js';
import { resolveModel, streamText } from './llm-call.js';

const LOCK_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ANALYZER_CALLS = 48;

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

/**
 * Turn analyzer `verify: contradicts` results into a deterministic replacement:
 * the old value stays as a dated Superseded line that records where the
 * correction came from, the new claim becomes current with its own citation.
 * The organizer's page text is amended before the final evidence gate.
 *
 * The old value is read from `originalPages` (the pages as they were before the
 * organizer wrote): the writes below replace whole bodies, so a page that
 * already carries the new value no longer contains the text to supersede.
 */
function applyVerificationCorrections({ finalPages, originalPages, analyses }) {
  const claims = [];
  for (const analysis of Array.isArray(analyses) ? analyses : []) {
    for (const claim of Array.isArray(analysis?.claims) ? analysis.claims : []) {
      claims.push({ ...claim, sessionId: analysis.sessionId });
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const analysis of Array.isArray(analyses) ? analyses : []) {
    for (const item of Array.isArray(analysis?.verify) ? analysis.verify : []) {
      if (item?.result !== 'contradicts') continue;
      const page = finalPages.get(item.file);
      if (!page) continue;
      const oldNorm = normalizeForMatch(item.claim);
      if (oldNorm.length < 6) continue;
      const before = originalPages?.get(item.file) ?? page;
      const oldLine = before.body.split(/\r?\n/).find((line) => normalizeForMatch(line).includes(oldNorm));
      if (oldLine === undefined) continue;
      const oldValue = oldLine.replace(/^\s*[-*]\s*/u, '').trim();
      if (oldValue === '') continue;
      const replacement = claims.find((claim) => claim.sessionId === analysis.sessionId
        && Number.isFinite(Number(claim.seq))
        && (Number(claim.seq) === Number(item.seq)
          || normalizeForMatch(String(claim.quote ?? '')) === normalizeForMatch(String(item.quote ?? '')))
        && normalizeForMatch(String(claim.text ?? '')) !== oldNorm);
      if (!replacement) continue;
      const citation = citationToken({
        source: analysis.sessionId,
        locator: String(replacement.seq),
        date: replacement.date || item.date || today,
      });
      const trace = ['source: dream',
        analysis.sessionId ? `session ${analysis.sessionId}` : '',
        item.source ? `quote ${item.source}` : ''].filter(Boolean).join(', ');
      const superseded = `- Superseded: ${oldValue} (until ${replacement.date || today}) — ${trace}`;
      const lines = page.body.split(/\r?\n/);
      const index = lines.findIndex((line) => normalizeForMatch(line).includes(oldNorm));
      if (index >= 0) {
        lines[index] = `- ${replacement.text} ${citation}`;
        lines.splice(index + 1, 0, superseded);
      } else {
        // The organizer already replaced (or dropped) the statement in its own
        // write. The correction still has to leave the same history behind.
        const kept = [];
        if (!bodyHasStatement(page.body, replacement.text)) kept.push(`- ${replacement.text} ${citation}`);
        if (!normalizeForMatch(page.body).includes(normalizeForMatch(superseded))) kept.push(superseded);
        if (kept.length === 0) continue;
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
        if (lines.length > 0) lines.push('');
        lines.push(...kept);
      }
      page.body = `${lines.join('\n').replace(/\n+$/, '')}\n`;
    }
  }
}

/** Simple cross-process lock using the existing `.consolidate-lock` path. */
async function acquireLock(file, ttlMs = LOCK_TTL_MS) {
  const start = Date.now();
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: start })}`;
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
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      const age = Date.now() - stat.mtimeMs;
      if (age < ttlMs) return { ok: false, reason: 'locked', age };
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

async function releaseLock(file) {
  try {
    await fs.unlink(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') warn('release dream lock', error);
  }
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

  _stageModel(stage) {
    const config = this.config;
    const explicit = stage === 'analyzer'
      ? { provider: config.dreamAnalyzerProvider, model: config.dreamAnalyzerModel }
      : { provider: config.dreamOrganizerProvider, model: config.dreamOrganizerModel };
    if (!explicit.provider || !explicit.model) {
      explicit.provider = config.dreamProvider;
      explicit.model = config.dreamModel;
    }
    return resolveModel(this.ctx, config, explicit);
  }

  /**
   * Run one v2 dream pass.
   * @param {{pctx:object, agent?:object, force?:boolean, dryRun?:boolean, trigger?:string,
   *   reason?:string, signal?:AbortSignal, noSessions?:boolean, focus?:string}} options
   */
  async run({ pctx, agent, force = false, dryRun = false, trigger = 'manual', reason = '', signal, noSessions = false, focus = '' } = {}) {
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
    if (signal?.aborted) return finish({ skipped: true, skipReason: 'aborted' });
    if (config.enabled === false) return finish({ skipped: true, skipReason: 'disabled' });
    if (config.autoMemoryEnabled === false) return finish({ skipped: true, skipReason: 'auto-memory-disabled' });

    const snapshot = typeof state.snapshot === 'function' ? state.snapshot() : {};
    if (typeof snapshot.pendingProposal === 'string' && snapshot.pendingProposal !== '') {
      return finish({ skipped: true, skipReason: 'pending-proposal', proposalPath: snapshot.pendingProposal });
    }
    if (!force) {
      const lastDreamAt = Number(snapshot.lastDreamAt) || 0;
      const minHours = Number(config.minHours) || 0;
      if (lastDreamAt > 0 && Date.now() - lastDreamAt < minHours * 60 * 60 * 1000) {
        return finish({ skipped: true, skipReason: 'hours', lastDreamAt });
      }
      const sessions = Array.isArray(snapshot.sessionsSince) ? snapshot.sessionsSince : [];
      const distinct = new Set(sessions.map((item) => (typeof item === 'string' ? item : item?.id)).filter(Boolean));
      const minSessions = Number(config.minSessions) || 0;
      if (distinct.size < minSessions) {
        return finish({ skipped: true, skipReason: 'sessions', sessionsSince: distinct.size, minSessions });
      }
    }

    const lock = await acquireLock(paths.lockFile, Number(config.lockTtlMs) || LOCK_TTL_MS);
    if (!lock.ok) return finish({ skipped: true, skipReason: 'lock', lockAgeMs: lock.age });

    let failure = true;
    let runDir = '';
    let failureManifest = null;
    let stage = 'prepare';
    let plan = null;
    let usage = null;
    let inputChars = 0;
    let outputChars = 0;
    let modelAnalyzer = null;
    let modelOrganizer = null;

    try {
      if (typeof state.markDreamStart === 'function') await state.markDreamStart();
      modelAnalyzer = this._stageModel('analyzer');
      modelOrganizer = this._stageModel('organizer');
      if (!modelAnalyzer || !modelOrganizer) {
        failure = false;
        return finish({ skipped: true, skipReason: 'llm-unavailable' });
      }

      const input = await gatherDreamInput({
        ctx: this.ctx,
        store,
        config,
        workspaceDir: pctx.workspaceDir,
        state,
        noSessions: noSessions === true,
      });
      const memoryEntries = await store.listEntries('project');
      const memoryPages = [];
      for (const entry of memoryEntries) {
        const read = await store.readEntry(entry.file, 'project').catch(() => undefined);
        if (!read) continue;
        memoryPages.push({
          file: entry.file,
          name: entry.name,
          description: entry.description,
          type: pageType(entry.type),
          body: read.body,
        });
      }
      const memoryChars = memoryPages.reduce((sum, page) => sum + page.body.length, 0);
      inputChars += memoryChars;

      const sessionIds = [];
      const reads = [];
      const readMarks = new Map((Array.isArray(input.reads) ? input.reads : []).map((read) => [read.id, read]));
      const tasks = [];
      const expectedUnits = new Map();
      const maxCalls = Math.max(1, Number(config.dreamMaxAnalyzerCalls) || DEFAULT_MAX_ANALYZER_CALLS);
      const maxTranscriptChars = Number(config.dreamAnalyzerTranscriptChars) || 72_000;
      for (const session of input.sessions) {
        const id = text(session?.id);
        if (id === '') continue;
        const units = Array.isArray(session.chunks) && session.chunks.length > 0
          ? session.chunks.map((chunk) => ({ text: chunk.text, lastSeq: chunk.lastSeq, evidenceBlocks: chunk.evidenceBlocks }))
          : [{ text: text(session.excerpt), lastSeq: null, evidenceBlocks: session.evidenceBlocks }];
        const usable = units.filter((unit) => text(unit.text) !== '');
        if (usable.length === 0) continue;
        sessionIds.push(id);
        expectedUnits.set(id, usable.length);
        reads.push({ id, seq: Number(readMarks.get(id)?.seq) || 0, complete: false });
        for (const unit of usable) {
          if (tasks.length >= maxCalls || text(unit.text).length > maxTranscriptChars) break;
          tasks.push({ session, sessionId: id, unit, index: tasks.length + 1 });
        }
      }

      const analyzerStage = {
        name: 'analyze',
        model: `${modelAnalyzer.provider}/${modelAnalyzer.model}`,
        calls: 0,
        retries: 0,
        failures: [],
        durationMs: 0,
      };
      const analyzerStarted = Date.now();
      const analyses = new Map();
      const analysisRows = [];
      const concurrency = Math.max(1, Number(config.dreamAnalyzerConcurrency) || 3);
      await mapLimit(tasks, concurrency, async (task) => {
        if (signal?.aborted) throw new Error('dream aborted');
        const promptInput = {
          sessionId: task.sessionId,
          when: task.session?.at ? new Date(Number(task.session.at)).toISOString().slice(0, 10) : '',
          transcript: text(task.unit.text),
          memoryPages,
          focus,
          maxMemoryChars: Number(config.dreamAnalyzerMemoryChars) || 48_000,
          maxTranscriptChars,
        };
        const prompt = buildAnalyzerPrompt(promptInput);
        inputChars += prompt.length;
        analyzerStage.calls += 1;
        try {
          const reply = await streamText({
            ctx: this.ctx,
            model: modelAnalyzer,
            system: ANALYZER_SYSTEM_PROMPT,
            prompt,
            signal,
            maxTokens: Number(config.dreamAnalyzerMaxTokens) || 8192,
            purpose: 'cc-memory-dream-analyze',
            onUsage: (attemptUsage) => { usage = mergeUsage(usage, attemptUsage); },
            retryPrompt: () => {
              const compact = buildAnalyzerPrompt({
                ...promptInput,
                maxMemoryChars: Math.min(promptInput.maxMemoryChars, 12_000),
              });
              const retry = `Compact retry: return only the most durable evidence. Use a one-sentence summary, at most 8 claims and 8 verdicts, and leave patches empty (the organizer writes pages). Return empty arrays when appropriate.\n\n${compact}`;
              analyzerStage.retries += 1;
              inputChars += retry.length;
              return retry;
            },
          });
          outputChars += reply.text.length;
          const parsed = parseAnalyzerReply(reply.text, { maxClaims: Number(config.dreamMaxClaimsPerSession) || 40 });
          if (!parsed) throw new Error('analyzer reply was not JSON');
          const verified = verifyAnalysis({
            analysis: parsed,
            transcript: text(task.unit.text),
            sessionId: task.sessionId,
            memoryFiles: memoryPages,
            evidenceBlocks: task.unit.evidenceBlocks,
            maxPatches: Number(config.dreamMaxPatchesPerSession) || 24,
            maxPatchChars: Number(config.dreamMaxFileChars) || 20_000,
          });
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
          analysisRows.push({ sessionId: task.sessionId, ...verified });
        } catch (error) {
          analyzerStage.failures.push({ sessionId: task.sessionId, error: errorMessage(error) });
          const row = analyses.get(task.sessionId) || { sessionId: task.sessionId, summary: '', claims: [], patches: [], verify: [], warnings: [], failures: 0 };
          row.failures = (row.failures || 0) + 1;
          analyses.set(task.sessionId, row);
        }
      });
      analyzerStage.durationMs = Date.now() - analyzerStarted;
      if (analyzerStage.calls === 0 && sessionIds.length === 0 && !input.deferredSessions?.length && !noSessions) {
        throw new Error('no transcripts were available to analyze');
      }

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
      runDir = path.join(paths.dreamsDir, timestampName(Date.now()));
      await fs.mkdir(runDir, { recursive: true });
      for (const row of analysisRows) {
        await writeJson(path.join(runDir, 'analysis', `${row.sessionId}.json`), row).catch((error) => warn('write analysis', error));
      }

      // Preserve analyzer diagnostics even when no organizer response is usable.
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
      stage = 'organize';
      const organizerInput = {
        analyses: merged,
        memoryPages,
        index: input.memory?.index || '',
        focus,
        limits: {
          maxPageChars: Number(config.dreamMaxFileChars) || 20_000,
          maxCurrentChars: Number(config.dreamOrganizerCurrentChars) || 60_000,
          maxAnalysisChars: Number(config.dreamOrganizerAnalysisChars) || 60_000,
          maxPages: Number(config.dreamMaxOps) || 40,
        },
      };
      const organizerPrompt = buildOrganizerPrompt(organizerInput);
      inputChars += organizerPrompt.length;
      const organizerStarted = Date.now();
      let organizerRetries = 0;
      const organizerReply = await streamText({
        ctx: this.ctx,
        model: modelOrganizer,
        system: ORGANIZER_SYSTEM_PROMPT,
        prompt: organizerPrompt,
        signal,
        maxTokens: Number(config.llmMaxTokens) || 16_384,
        purpose: 'cc-memory-dream-organize',
        onUsage: (attemptUsage) => { usage = mergeUsage(usage, attemptUsage); },
        retryPrompt: () => {
          const compact = buildOrganizerPrompt({
            ...organizerInput,
            limits: {
              ...organizerInput.limits,
              maxAnalysisChars: Math.min(organizerInput.limits.maxAnalysisChars, 16_000),
            },
          });
          const retry = `Compact retry: prioritize new, supported facts and corrections. Return only necessary changed pages. Omit index and skill (the host builds them), leave deletions empty, and skip optional merges and rearrangements.\n\n${compact}`;
          organizerRetries += 1;
          inputChars += retry.length;
          return retry;
        },
      });
      outputChars += organizerReply.text.length;
      const organized = parseOrganizerReply(organizerReply.text, {
        maxWrites: Number(config.dreamMaxOps) || 40,
        maxPageChars: Number(config.dreamMaxFileChars) || 20_000,
        maxDeletes: Number(config.dreamMaxOps) || 40,
        maxLinks: 80,
        maxConflicts: 40,
      });
      if (!organized) throw new Error('organizer reply was not JSON');
      const organizerStage = {
        name: 'organize',
        model: `${modelOrganizer.provider}/${modelOrganizer.model}`,
        calls: 1,
        retries: organizerRetries,
        durationMs: Date.now() - organizerStarted,
        writes: organized.writes.length,
        deletes: organized.deletes.length,
        conflicts: organized.conflicts.length,
      };

      failureManifest.stages.push(organizerStage);
      stage = 'validate';
      // Compose final pages from analyzer patches and organizer writes.
      const finalPages = new Map();
      for (const page of memoryPages) finalPages.set(page.file, { ...page });
      // Snapshot before any write: corrections read the old value from here,
      // because the writes below replace whole page bodies.
      const originalPages = new Map([...finalPages].map(([file, page]) => [file, { ...page }]));
      const applyPatch = (patch) => {
        const file = safePage(patch?.file);
        if (file === '') return;
        const existing = finalPages.get(file) || {
          file,
          name: file.replace(/\.md$/, ''),
          description: '',
          type: 'project',
          body: '',
        };
        const content = text(patch.content).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        existing.body = patch.op === 'replace' ? content : `${existing.body.trimEnd()}\n\n${content}`.trim();
        finalPages.set(file, existing);
      };
      for (const analysis of merged) for (const patch of analysis.patches) applyPatch(patch);
      for (const write of organized.writes) {
        finalPages.set(write.file, {
          file: write.file,
          name: write.name,
          description: write.description,
          type: pageType(write.type),
          body: write.body,
        });
      }
      for (const conflict of organized.conflicts) {
        const page = finalPages.get(conflict.file);
        if (!page) continue;
        page.body = `${page.body.trimEnd()}\n\n${conflict.content}\n`;
      }
      if (organizerRetries === 0) {
        for (const deletion of organized.deletes) finalPages.delete(deletion.file);
      }
      // Cross-links are host-rendered (one structural `Related:` line, only to
      // pages that still exist), so no model-written text rides along with them.
      renderRelatedLinks(finalPages, organized.links);
      applyVerificationCorrections({ finalPages, originalPages, analyses: merged });

      const finalList = [...finalPages.values()].sort((a, b) => a.file.localeCompare(b.file));
      const secretWarningsList = [];
      for (const page of finalList) {
        const decision = secretScanDecision(scanSecrets(page.body), config);
        if (decision.block) {
          throw new Error(`secret scan refused ${page.file}: a credential-like value would be persisted`);
        }
        if (decision.warn) secretWarningsList.push(...secretWarnings(scanSecrets(page.body)));
      }
      const indexText = buildIndex({
        pages: finalList.map((page) => ({ ...page, slug: page.file.replace(/\.md$/, ''), links: [], citations: [] })),
        style: 'memory',
        groupBy: 'type',
      });
      const skillText = (organizerRetries === 0 && organized.skill) || buildSkill({
        title: 'Project memory',
        description: 'Topic files from dreaming, with links and provenance.',
        domains: [...new Set(finalList.map((page) => page.type))].filter(Boolean),
        style: 'memory',
      });

      // Convert to the existing plan shape so apply/backup/undo stay unchanged.
      const currentByFile = new Map(memoryPages.map((page) => [page.file, page]));
      let operations = [];
      for (const page of finalList) {
        const current = currentByFile.get(page.file);
        const changed = !current
          || current.body !== page.body
          || current.name !== page.name
          || current.description !== page.description
          || current.type !== page.type;
        if (!changed) continue;
        operations.push({
          op: 'write',
          scope: 'project',
          type: pageType(page.type),
          file: page.file,
          name: page.name,
          description: page.description,
          body: page.body,
        });
      }
      for (const file of currentByFile.keys()) {
        if (finalPages.has(file)) continue;
        operations.push({ op: 'delete', scope: 'project', file, reason: 'absorbed by the organizer' });
      }
      operations.push({ op: 'index', scope: 'project', content: indexText });

      // Final write gate: organizer-added lines must be backed by claims the
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
        { summary: organized.summary || `dream: ${operations.length} operation(s)`, operations },
        {
          config,
          existingFiles: memoryEntries.map((entry) => ({ file: entry.file, name: entry.name, scope: 'project' })),
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
        provider: modelOrganizer.provider,
        model: modelOrganizer.model,
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
        skill: skillText,
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
          calls: 1,
          writes: organized.writes.length,
          deletes: organized.deletes.length,
          conflicts: organized.conflicts.length,
          indexEntries: finalList.length,
        },
        stages: [analyzerStage, organizerStage],
        operations: plan.operations.length,
        dropped: validation.dropped,
        applied: false,
      };

      const coverageError = dreamV2CoverageError(plan);
      if (dryRun || coverageError) {
        const planPath = path.join(runDir, 'plan.json');
        const manifest = { ...manifestBase, finishedAt: Date.now() };
        await writeJson(path.join(runDir, 'manifest.json'), manifest);
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
          planPath,
          backupDir: runDir,
          manifest,
          ...(coverageError && !dryRun ? { error: coverageError } : {}),
          usage,
          inputChars,
          outputChars,
          provider: modelOrganizer.provider,
          model: modelOrganizer.model,
          warnings: plan.warnings,
        });
      }

      // Review mode can also be requested by config; dry-run is checked first.
      if (wantsReview(config)) {
        const proposalPath = path.join(paths.pendingDir, `${timestampName(Date.now())}.json`);
        await writeJson(proposalPath, { ...plan, review: true, manifest: manifestBase });
        await state.setPendingProposal(proposalPath);
        failure = false;
        return finish({ ran: true, applied: false, mode: 'review', summary: plan.summary, proposalPath });
      }

      const engine = await this.engine();
      const execution = await engine.executePlan({
        store,
        paths,
        plan,
        config,
        operations: plan.operations,
        skill: skillText,
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
          costExceeded: false,
          costMode: config.dreamCostMode || 'warn',
        },
        meta: {
          kind: 'dream-v2',
          planOps: plan.operations.length,
          summary: plan.summary,
          sessions: sessionIds.length,
          durationMs: Date.now() - startedAt,
          inputChars,
          outputChars,
          usage,
          costExceeded: false,
          costMode: config.dreamCostMode || 'warn',
          trigger,
        },
      });

      // SKILL.md is applied inside executePlan so it shares the batch backup and
      // undo metadata with the notes and index.
      await state.clearSessions([...sessionIds, ...(input.droppedSessions || [])], { reads });
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
        costExceeded: false,
      });
      await state.clearPendingProposal({ silent: true }).catch(() => {});
      await state.clearLastPlan().catch(() => {});
      try {
        this.runtime?.invalidateAllInjections?.('dream-v2');
      } catch {
        // best effort
      }
      const manifest = {
        ...manifestBase,
        finishedAt: Date.now(),
        applied: true,
        usage,
        inputChars,
        outputChars,
        backupDir: execution.backupDir,
        counts: execution.counts,
      };
      await writeJson(path.join(runDir, 'manifest.json'), manifest);
      failure = false;
      return finish({
        ran: true,
        applied: true,
        mode: 'apply',
        summary: plan.summary,
        operations: execution.counts.write + execution.counts.delete + execution.counts.index,
        filesTouched: execution.touched.size,
        sessionsReviewed: merged.length,
        backupDir: execution.backupDir,
        changelogPath: paths.changelogFile,
        manifest,
        usage,
        inputChars,
        outputChars,
        provider: modelOrganizer.provider,
        model: modelOrganizer.model,
        warnings: plan.warnings,
      });
    } catch (error) {
      const detail = errorMessage(error);
      const message = stage === 'organize' ? `Dream organizer: ${detail}` : detail;
      try {
        await state.markDreamFailed(message);
      } catch (stateError) {
        warn('state.markDreamFailed', stateError);
      }
      if (runDir !== '') {
        await writeJson(path.join(runDir, 'manifest.json'), {
          ...(failureManifest || {}),
          kind: 'dream',
          mode: 'v2',
          trigger,
          finishedAt: Date.now(),
          applied: false,
          failedStage: stage,
          error: message,
          usage,
        }).catch(() => {});
      }
      return finish({ ran: true, error: message, applied: false, summary: '', operations: 0, sessionsReviewed: 0 });
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
  const lines = String(body ?? '')
    .split(/\r?\n/u)
    // Superseded lines are derived history, not claims about the present.
    .filter((line) => /\^\[/u.test(line) && !SUPERSEDED_LINE_RE.test(line));
  if (lines.length === 0) return false;
  return lines.every((line) => claims.some((item) => supportsStatement(item.claim, line, { minRatio: 0.5, minMatched: 2 })
    // A `contradicts` verdict states the old value in `claim`; the line being
    // written carries the transcript's new value, so that is what has to match.
    || (item.result === 'contradicts' && supportsStatement(item.quote, line, { minRatio: 0.5, minMatched: 2 }))));
}

function wantsReview(config) {
  return config.dreamMode === 'review';
}
