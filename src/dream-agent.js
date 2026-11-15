/**
 * Dream as an agent.
 *
 * The host no longer slices transcripts and pushes them to an analyzer. It
 * gives the model a small tool surface and the candidate session ids; the
 * model decides what to search, reads only the memory pages it needs, and
 * writes a *shadow* copy. Human switch/undo is unchanged: a run still ends
 * with `.dreams/shadow` plus `state.shadowPending`.
 *
 * One run = one model tool loop. Memory bodies are never put in the prompt up
 * front; only MEMORY.md and the note metadata are. The agent must call
 * `memory_read` for a body.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from './lock.js';
import { runToolLoop } from './tool-loop.js';
import { resolveModel, describeLlmError } from './llm-call.js';
import {
  prepareShadow,
  diffShadow,
  shadowConflicts,
  shadowDirOf,
  clearShadow,
} from './dream-shadow.js';
import { newRunId, runDirOf, readRunManifest, writeRunManifest, shapeManifest } from './dream-run.js';
import { costLimitStatus, dreamCostModeOf, estimateInputTokens, maxTotalTokensLimit } from './dream.js';

const MAX_TURNS = 14;
const MAX_TOKENS = 2_000;
const TOOL_CHARS = 12_000;
const MAX_SEARCH = 12;
const MAX_READ = 8;
const MAX_EVIDENCE = 500;
const MAX_REJECTED_PROMPT = 20;
/** Shorter quotes match too easily to count as a check. */
const MIN_QUOTE_CHARS = 8;

const SYSTEM = `You are Dream, the consolidation agent for a project memory directory.
You are working on a **copy** (shadow) of the memory directory. Never assume a change is live.

Your job:
1. Read MEMORY.md and the note metadata first (memory_index).
2. Find recent work that may change or extend memories. Use session_list, then session_search and session_read. Search narrowly; do not read whole sessions.
3. Read only the memory pages you need (memory_read). A body is not in this prompt.
4. Write the consolidated result to the shadow copy with memory_write / memory_delete.
   - Merge duplicate facts; keep one canonical line.
   - A contradicted value replaces the old value; keep one short Superseded line in the body.
   - Remove clearly stale or wrong pages only when the evidence is in a session you read.
   - Add source annotations like ^[session#seq, YYYY-MM-DD] to new fact lines when you can.
   - Keep MEMORY.md index lines one line each, under ~150 chars.
5. Reply DONE when finished. If nothing durable changed, reply DONE without writing.

Rules:
- Only durable facts that cannot be read from the repository: user preferences, corrections, decisions, external references.
- Never save secrets, one-off task details, code patterns, file paths, or project structure.
- Use absolute dates.
- Do not write to the live store; you only have shadow tools.
- Prefer updating an existing page over creating a near-duplicate.
- Cite each new or changed fact with memory_write citations. Copy the quote verbatim from session_read output; quotes are checked against the session and a mismatch is flagged to the reviewer.
- Do not invent quotes. If uncertain, leave it for review.`;

function warn(scope, error) {
  try {
    console.warn(`[cc-memory] dream-agent ${scope}:`, error?.message ?? error);
  } catch {
    /* logging is best effort */
  }
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

function clip(value, max = TOOL_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}\n...[clipped]` : text;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const value = JSON.parse(String(raw ?? '{}'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function oneLine(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function eventSnippet(event) {
  const data = event?.data ?? event ?? {};
  if (typeof data.snippet === 'string' && data.snippet !== '') return oneLine(data.snippet, 500);
  const message = data.message ?? data;
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'tool-call') parts.push(`[tool ${block.name}]`);
  }
  return oneLine(parts.join(' ') || JSON.stringify(data), 500);
}

/** Whole text of one event (no clipping), for quote checks. */
function eventText(event) {
  const data = event?.data ?? event ?? {};
  const message = data.message ?? data;
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text);
  if (parts.length === 0 && typeof data.snippet === 'string') parts.push(data.snippet);
  return parts.join('\n');
}

/** Quotes compare case- and whitespace-insensitively; ellipses are cut marks. */
function normalizeQuote(value) {
  return String(value ?? '').replace(/[…]+$/u, '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function candidateState(state) {
  const raw = state?.state ?? state?.snapshot?.() ?? {};
  const processed = Array.isArray(raw.dreamProcessedSessions) ? raw.dreamProcessedSessions : [];
  return new Map(processed.map((item) => [item.id, item]));
}

async function candidatesOf({ ctx, pctx, config }) {
  const sessionQuery = ctx?.get?.('sessionQuery');
  if (!sessionQuery || typeof sessionQuery.filterSessions !== 'function') return [];
  const records = await sessionQuery.filterSessions([{ kind: 'cwd', values: [pctx.workspaceDir] }]);
  const processed = candidateState(pctx.state);
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    const header = record?.header ?? record?.session ?? record;
    const id = textOf(header?.id);
    if (id === '') continue;
    if (header?.parentSession || header?.origin === 'subagent') continue;
    const lastSeq = Number(header?.lastSeq) || 0;
    const mark = processed.get(id);
    const readSeq = Number(mark?.seq) || 0;
    // A reviewed session comes back only when it grew past the review mark.
    if (mark && mark.partial !== true && (lastSeq === 0 || readSeq >= lastSeq)) continue;
    out.push({
      id,
      createdAt: Number(header?.createdAt) || 0,
      lastSeq,
      readSeq,
      cwd: textOf(header?.cwd),
    });
  }
  out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return out.slice(-Math.max(1, Number(config.sessionLookback) || 8));
}

/**
 * One readable line per changed file. These are what a reject/discard stores
 * in `dreamRejected`, and what the next run is shown so it does not propose
 * the same change again.
 */
async function proposalLines(diff, shadowStore) {
  const described = new Map((await shadowStore.listEntries('project')).map((entry) => [entry.file, entry.description || '']));
  const out = {};
  for (const { file, action } of diff.files) {
    const description = described.get(file);
    out[file] = [oneLine(action === 'removed' || !description ? `${action} ${file}` : `${action} ${file}: ${description}`, 240)];
  }
  return out;
}

/** One candidate as the model sees it: where the unreviewed part starts. */
function sessionLine(item) {
  const created = new Date(item.createdAt || 0).toISOString();
  const range = item.readSeq > 0 ? `new events after seq ${item.readSeq}` : 'not reviewed yet';
  return `- ${item.id} created ${created}, ${range}${item.lastSeq > 0 ? `, last seq ${item.lastSeq}` : ''}`;
}

/**
 * Review marks for the end of a run. A run that finished on its own reviewed
 * every candidate up to the `lastSeq` it was offered: not reading a session is
 * the agent's judgment that nothing there matters. A run cut short (turn cap)
 * only marks what it actually read, as partial unless it reached the end.
 */
function reviewRecords(candidates, reads, finished) {
  const records = [];
  for (const item of candidates) {
    const read = Number(reads.get(item.id)) || 0;
    if (finished && item.lastSeq > 0) records.push({ id: item.id, seq: item.lastSeq, complete: true });
    else if (read > 0) records.push({ id: item.id, seq: read, complete: item.lastSeq > 0 && read >= item.lastSeq });
  }
  return records;
}

/** One tool surface, bound to the shadow store and the host session query. */
function toolsFor({ ctx, config, shadowStore, candidates, onRead, onReadSession: onSessionRead, onWrite, onEvidence }) {
  const recordEvidence = typeof onEvidence === 'function' ? onEvidence : () => {};
  const sessionQuery = ctx?.get?.('sessionQuery');
  const tools = [
    {
      name: 'memory_index',
      description: 'List the memory index and note metadata. Does not include page bodies.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'memory_read',
      description: 'Read one memory page body by file name.',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string', description: 'File name, e.g. feedback_style.md' } },
        required: ['file'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_search',
      description: 'Search memory page bodies. Returns short snippets and file names.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_write',
      description: 'Write or update a page in the shadow copy.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File name; omit to keep the existing name or derive one' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
          description: { type: 'string' },
          body: { type: 'string' },
          citations: {
            type: 'array',
            description: 'Evidence for this change: session id, event seq, and a short quote copied verbatim from that event (session_read output). Quotes are checked against the session.',
            items: {
              type: 'object',
              properties: {
                session_id: { type: 'string' },
                seq: { type: 'number' },
                quote: { type: 'string' },
              },
              required: ['session_id', 'seq'],
            },
          },
        },
        required: ['body'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_delete',
      description: 'Remove a stale/wrong/merged page from the shadow copy.',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string' } },
        required: ['file'],
        additionalProperties: false,
      },
    },
    {
      name: 'session_list',
      description: 'List candidate sessions (id, created time, last read event).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'session_search',
      description: 'Search one session for a narrow term. Returns matching snippets with event seq.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['session_id', 'query'],
        additionalProperties: false,
      },
    },
    {
      name: 'session_read',
      description: 'Read a small window around one session event.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          seq: { type: 'number' },
          before: { type: 'number' },
          after: { type: 'number' },
        },
        required: ['session_id', 'seq'],
        additionalProperties: false,
      },
    },
  ];

  async function execute(call) {
    const args = parseArgs(call.arguments);
    switch (call.name) {
      case 'memory_index': {
        const entries = await shadowStore.listEntries('project');
        const index = await shadowStore.indexText('project');
        const lines = entries.map(
          (entry) => `- [${entry.type || 'project'}] ${entry.file} (${entry.modified || 'unknown'}): ${entry.description || ''}`,
        );
        return clip(`INDEX:\n${index || '(empty)'}\n\nNOTES:\n${lines.join('\n') || '(none)'}`);
      }
      case 'memory_read': {
        const file = textOf(args.file);
        if (file === '') return 'ERROR: file is required';
        try {
          const entry = await shadowStore.readEntry(file, 'project');
          onRead(file);
          const meta = entry.frontmatter ?? {};
          return clip(`# ${meta.name} (${meta.type})\ndescription: ${meta.description || ''}\n\n${entry.body}`);
        } catch (error) {
          return `ERROR: ${error?.message ?? error}`;
        }
      }
      case 'memory_search': {
        const query = textOf(args.query);
        if (query === '') return 'ERROR: query is required';
        const limit = Math.max(1, Math.min(MAX_SEARCH, Number(args.limit) || 6));
        try {
          const hits = await shadowStore.search(query, { limit, scope: 'project', currentOnly: true });
          if (!Array.isArray(hits) || hits.length === 0) return 'No matches.';
          return clip(hits.map((hit) => `- ${hit.file}: ${oneLine(hit.snippets?.[0] ?? hit.description ?? hit.name, 300)}`).join('\n'));
        } catch (error) {
          return `ERROR: ${error?.message ?? error}`;
        }
      }
      case 'memory_write': {
        const body = textOf(args.body);
        if (body === '') return 'ERROR: body is required';
        const file = textOf(args.file);
        try {
          const result = await shadowStore.writeRawEntry(file, {
            scope: 'project',
            // Omitted fields keep the page's current value (new pages get the
            // store defaults); an empty string must not blank them.
            name: textOf(args.name),
            type: textOf(args.type) || undefined,
            description: textOf(args.description) || undefined,
            body,
            source: { via: 'dream-agent' },
          });
          onWrite(result.file, 'write');
          const citations = Array.isArray(args.citations) ? args.citations : [];
          let unverified = 0;
          for (const citation of citations) {
            const sessionId = textOf(citation?.session_id ?? citation?.sessionId);
            const seq = Number(citation?.seq);
            if (sessionId === '' || !Number.isFinite(seq)) continue;
            const quote = oneLine(textOf(citation?.quote), 500);
            const verified = await quoteMatches(sessionId, seq, quote);
            if (!verified) unverified += 1;
            recordEvidence({ sessionId, seq, quote, file: result.file, source: 'citation', verified });
          }
          return unverified > 0
            ? `WROTE ${result.file} (${unverified} citation(s) did not match the session text; quote it verbatim from session_read)`
            : `WROTE ${result.file}`;
        } catch (error) {
          return `ERROR: ${error?.message ?? error}`;
        }
      }
      case 'memory_delete': {
        const file = textOf(args.file);
        if (file === '') return 'ERROR: file is required';
        if (config?.dreamAllowDelete === false) return 'ERROR: page deletion is disabled';
        try {
          await shadowStore.trashEntry(file, { scope: 'project', reason: 'dream-agent delete' });
          onWrite(file, 'delete');
          return `DELETED ${file}`;
        } catch (error) {
          return `ERROR: ${error?.message ?? error}`;
        }
      }
      case 'session_list': {
        return clip(candidates.map(sessionLine).join('\n') || '(no sessions)');
      }
      case 'session_search': {
        const sessionId = textOf(args.session_id);
        const query = textOf(args.query);
        if (sessionId === '' || query === '') return 'ERROR: session_id and query are required';
        if (!candidates.some((item) => item.id === sessionId)) return 'ERROR: session_id is not a candidate';
        if (!sessionQuery || typeof sessionQuery.searchEvents !== 'function') return 'ERROR: session search unavailable';
        try {
          const page = await sessionQuery.searchEvents({
            sessionId,
            query,
            limit: Math.max(1, Math.min(MAX_SEARCH, Number(args.limit) || 8)),
          });
          const items = Array.isArray(page?.items) ? page.items : [];
          if (items.length === 0) return 'No matches.';
          let maxSeq = 0;
          const lines = items.map((hit) => {
            const seq = Number(hit?.seq ?? hit?.event?.seq ?? 0);
            if (seq > maxSeq) maxSeq = seq;
            return `- seq ${seq}: ${eventSnippet(hit?.event ?? hit)}`;
          });
          onReadSession(sessionId, maxSeq);
          return clip(lines.join('\n'));
        } catch (error) {
          return `ERROR: ${error?.message ?? error}`;
        }
      }
      case 'session_read': {
        const sessionId = textOf(args.session_id);
        const seq = Number(args.seq);
        if (sessionId === '' || !Number.isFinite(seq)) return 'ERROR: session_id and seq are required';
        if (!candidates.some((item) => item.id === sessionId)) return 'ERROR: session_id is not a candidate';
        if (!sessionQuery || typeof sessionQuery.readEvent !== 'function') return 'ERROR: session read unavailable';
        try {
          const page = await sessionQuery.readEvent({
            sessionId,
            seq,
            before: Math.max(0, Math.min(MAX_READ, Number(args.before) || 2)),
            after: Math.max(0, Math.min(MAX_READ, Number(args.after) || 4)),
          });
          const events = Array.isArray(page?.events) ? page.events : Array.isArray(page) ? page : [];
          if (events.length === 0) return 'No events.';
          let maxSeq = 0;
          const lines = events.map((event) => {
            const at = Number(event?.seq ?? 0);
            if (at > maxSeq) maxSeq = at;
            return `[${at}] ${event?.type ?? 'event'}: ${eventSnippet(event)}`;
          });
          onReadSession(sessionId, maxSeq);
          return clip(lines.join('\n'));
        } catch (error) {
          return `ERROR: ${error?.message ?? error}`;
        }
      }
      default:
        return `ERROR: unknown tool ${call.name}`;
    }
  }

  /**
   * A citation is verified only when its quote is in the cited event itself,
   * read back from the host. A missing quote, a non-candidate session or an
   * unavailable reader leaves it unverified; the reviewer sees which is which.
   */
  async function quoteMatches(sessionId, seq, quote) {
    const wanted = normalizeQuote(quote);
    if (wanted.length < MIN_QUOTE_CHARS) return false;
    if (!candidates.some((item) => item.id === sessionId)) return false;
    if (!sessionQuery || typeof sessionQuery.readEvent !== 'function') return false;
    try {
      const page = await sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 });
      const events = Array.isArray(page?.events) ? page.events : Array.isArray(page) ? page : [];
      const event = events.find((item) => Number(item?.seq) === seq);
      return Boolean(event) && normalizeQuote(eventText(event)).includes(wanted);
    } catch {
      return false;
    }
  }

  function onReadSession(sessionId, seq) {
    if (typeof onSessionRead === 'function' && sessionId && seq > 0) onSessionRead(sessionId, seq);
  }

  return { tools, execute };
}

export class DreamAgent {
  constructor({ ctx, runtime }) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.active = new Map();
  }

  get config() {
    return this.runtime.config;
  }

  /** Start in the background and resolve `done` with the run result. */
  async start(options = {}) {
    const paths = options.pctx?.paths;
    if (!paths) return { ok: false, started: false, error: 'no-project' };
    const key = paths.projectDir;
    const active = this.active.get(key);
    if (active) {
      return { ok: true, started: false, reused: true, runId: active.runId, status: 'running', done: active.promise };
    }
    const runId = options.runId || newRunId();
    const controller = new AbortController();
    const external = options.signal;
    const onAbort = () => controller.abort(external.reason);
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', onAbort, { once: true });
    }
    const promise = this.#run({ ...options, runId, signal: controller.signal })
      .catch((error) => ({ ran: false, error: error?.message ?? String(error), runId }))
      .finally(() => {
        external?.removeEventListener('abort', onAbort);
        this.active.delete(key);
      });
    this.active.set(key, { runId, controller, promise });
    return { ok: true, started: true, runId, status: 'running', done: promise };
  }

  liveRunIds() {
    return [...this.active.values()].filter((item) => item.runId).map((item) => item.runId);
  }

  async cancel(pctx, runId = '') {
    const active = this.active.get(pctx?.paths?.projectDir);
    if (!active || (runId !== '' && active.runId !== runId)) return { ok: false, error: 'not-running', runId };
    active.controller.abort(new Error('cancelled by user'));
    return { ok: true, runId: active.runId, status: 'cancelling' };
  }

  async status(pctx, runId = '') {
    const paths = pctx?.paths;
    if (!paths) return { ok: false, error: 'no-project' };
    const active = this.active.get(paths.projectDir);
    const wanted = runId || active?.runId || '';
    if (wanted === '') return { ok: true, runId: '', status: 'none' };
    if (active?.runId === wanted) return { ok: true, running: true, runId: wanted, status: 'running', stage: 'agent' };
    const manifest = await readRunManifest(runDirOf(paths, wanted));
    if (!manifest) return { ok: true, running: false, runId: wanted, status: 'unknown' };
    return {
      ok: true,
      running: false,
      runId: wanted,
      status: String(manifest.status || 'unknown'),
      stage: String(manifest.stage || ''),
      skipReason: manifest.skipReason ? String(manifest.skipReason) : undefined,
      error: manifest.error ? String(manifest.error) : undefined,
      counts: manifest.counts,
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
    };
  }

  async estimate({ pctx } = {}) {
    if (!pctx?.paths) throw new Error('no-project');
    const candidates = await candidatesOf({ ctx: this.ctx, pctx, config: this.config });
    const index = await pctx.store.indexText('project');
    const chars = String(index || '').length + candidates.length * 120 + 1_500;
    return {
      estimatedTokens: Math.ceil(chars / 4),
      inputChars: chars,
      limit: Math.max(0, Math.floor(Number(this.config.dreamMaxTotalTokens) || 0)),
      rough: true,
      sessions: candidates.length,
      units: candidates.length,
      warnings: [],
    };
  }

  async #run({ pctx, runId, signal, trigger = 'manual', reason = '', noSessions = false, focus = '' } = {}) {
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
    const finish = (extra = {}) => ({ ...base, ...extra, durationMs: Date.now() - startedAt, finishedAt: Date.now() });
    const store = pctx?.store;
    const state = pctx?.state;
    const paths = pctx?.paths;
    if (!store || !state || !paths) return finish({ skipped: true, skipReason: 'no-project', error: 'no-project' });
    if (signal?.aborted) return finish({ skipped: true, skipReason: 'aborted' });
    if (config.enabled === false) return finish({ skipped: true, skipReason: 'disabled' });
    if (config.autoMemoryEnabled === false) return finish({ skipped: true, skipReason: 'auto-memory-disabled' });

    // A pending shadow is the human's review queue. Never let a manual or
    // scheduled run replace it (and wipe its directory) before switch/discard.
    const pending = state.snapshot?.().shadowPending;
    if (pending && typeof pending.dir === 'string' && pending.dir !== '') {
      let pendingExists = false;
      try {
        await fs.stat(pending.dir);
        pendingExists = true;
      } catch {
        pendingExists = false;
      }
      if (pendingExists) return finish({ skipped: true, skipReason: 'pending-switch' });
      // Stale state pointing at a deleted directory must not block forever.
      await state.clearShadowPending?.();
    }

    return withFileLock(paths.lockFile, async () => {
      const runDir = runDirOf(paths, runId);
      let manifest = shapeManifest({
        runId,
        projectId: paths.projectDirName || paths.projectId || '',
        trigger,
        reason,
        startedAt,
        status: 'running',
        stage: 'agent',
      });
      const save = async (patch = {}) => {
        manifest = shapeManifest({ ...manifest, ...patch, runId, startedAt, updatedAt: Date.now() });
        await writeRunManifest(runDir, manifest).catch((error) => warn('manifest', error));
        return manifest;
      };
      const timeoutSignal = AbortSignal.timeout(Math.max(1_000, Number(config.dreamTimeoutMs) || 600_000));
      const loopSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      try {
        await save();
        await state.markDreamStart?.();
        const candidates = noSessions ? [] : await candidatesOf({ ctx: this.ctx, pctx, config });
        const model = resolveModel(this.ctx, {
          provider: config.dreamAnalyzerProvider,
          model: config.dreamAnalyzerModel,
        });
        if (!model) {
          await save({ status: 'skipped', skipReason: 'llm-unavailable', finishedAt: Date.now() });
          return finish({ skipped: true, skipReason: 'llm-unavailable', runId });
        }

        const { shadowStore, base: shadowBase } = await prepareShadow({ store, paths, config });
        const reads = new Map();
        const writes = [];
        const evidence = [];
        const onEvidence = (item) => {
          if (!item || evidence.length >= MAX_EVIDENCE) return;
          const sessionId = String(item.sessionId || '');
          const seq = Number(item.seq);
          if (sessionId === '' || !Number.isFinite(seq)) return;
          evidence.push({
            sessionId,
            seq,
            quote: String(item.quote || '').slice(0, 500),
            ...(item.file ? { file: String(item.file) } : {}),
            source: item.source || 'citation',
            verified: item.verified === true,
          });
        };
        let touched = false;
        const onRead = (file) => {
          touched = true;
          reads.set(`memory:${file}`, 0);
        };
        const onReadSession = (sessionId, seq) => {
          touched = true;
          reads.set(sessionId, Math.max(Number(reads.get(sessionId)) || 0, Number(seq) || 0));
        };
        const onWrite = (file, op) => {
          touched = true;
          writes.push({ file, op });
        };
        const { tools, execute } = toolsFor({
          ctx: this.ctx,
          config,
          shadowStore,
          candidates,
          onRead,
          onReadSession,
          onWrite,
          onEvidence,
        });
        const index = await shadowStore.indexText('project');
        const indexHead = String(index || '').slice(0, 8_000);
        const sessionLines = candidates.map(sessionLine).join('\n');
        const rejected = (state.snapshot?.().dreamRejected ?? [])
          .filter((item) => typeof item === 'string' && item !== '')
          .slice(-MAX_REJECTED_PROMPT);
        const prompt = [
          `Project: ${pctx.workspaceDir}`,
          focus ? `Focus: ${focus}` : '',
          'Candidate sessions:\n' + (sessionLines || '(none)'),
          'MEMORY.md (head):\n' + (indexHead || '(empty)'),
          rejected.length > 0
            ? 'Changes the reviewer rejected before (do not propose them again unless a session you read gives new evidence):\n'
              + rejected.map((item) => `- ${item}`).join('\n')
            : '',
          'Use memory_index for the note list. Use session_search/session_read for evidence. Write only the shadow copy. Reply DONE when finished.',
        ].filter(Boolean).join('\n\n');

        // dreamMaxTotalTokens: the loop stops once usage reaches it. `block`
        // also refuses a run whose first prompt alone is over it, and throws
        // away a copy built past it; `warn` keeps the copy and flags it.
        const tokenLimit = maxTotalTokensLimit(config);
        const blockOverLimit = dreamCostModeOf(config) === 'block';
        if (tokenLimit > 0 && blockOverLimit && estimateInputTokens(SYSTEM.length + prompt.length) > tokenLimit) {
          await clearShadow(paths);
          await state.noteCostExceeded?.(true);
          await save({ status: 'skipped', skipReason: 'cost-limit', stage: 'agent', finishedAt: Date.now() });
          return finish({ skipped: true, skipReason: 'cost-limit', runId });
        }

        const loop = await runToolLoop({
          ctx: this.ctx,
          model,
          system: SYSTEM,
          prompt,
          tools,
          executeTool: execute,
          maxTurns: MAX_TURNS,
          maxTokens: MAX_TOKENS,
          purpose: 'cc-memory-dream',
          signal: loopSignal,
          maxTotalTokens: tokenLimit,
        });
        const cost = costLimitStatus(config, loop.usage);
        const costExceeded = loop.stopped === 'budget' || cost.exceeded;
        if (costExceeded && blockOverLimit && !loopSignal.aborted) {
          await clearShadow(paths);
          await state.noteCostExceeded?.(true);
          await state.markDreamFailed?.('cost-limit-exceeded');
          await save({ status: 'failed', stage: 'agent', error: 'cost-limit-exceeded', usage: loop.usage, finishedAt: Date.now() });
          return finish({ ok: false, error: 'cost-limit-exceeded', usage: loop.usage, runId });
        }

        if (loopSignal.aborted) {
          const reason = timeoutSignal.aborted ? 'timeout' : 'cancelled';
          await clearShadow(paths);
          await save({ status: 'cancelled', stage: 'agent', finishedAt: Date.now(), error: reason });
          await state.clearDreamError?.();
          return finish({ ok: false, error: reason, runId });
        }

        // Diff against the snapshot: only what the agent changed counts. A note
        // saved live meanwhile is not a removal, and conflicts only matter for
        // pages the agent touched.
        const diff = await diffShadow({ store, shadowStore, base: shadowBase });
        const changed = new Set(diff.files.map((item) => item.file));
        const conflicts = (await shadowConflicts({ store, base: shadowBase })).filter((item) => changed.has(item.file));
        if (conflicts.length > 0) {
          await save({ status: 'failed', stage: 'agent', error: 'conflict', finishedAt: Date.now() });
          await state.markDreamFailed?.('notes changed while Dream ran');
          return finish({ ok: false, error: 'conflict', conflicts, runId });
        }
        const records = reviewRecords(candidates, reads, loop.stopped === 'stop');
        if (diff.files.length === 0) {
          await clearShadow(paths);
          await state.clearShadowPending?.();
          if (records.length > 0) await state.clearSessions?.(records.map((item) => item.id), { reads: records });
          await state.markDreamDone?.({
            sessions: 0,
            ops: 0,
            files: 0,
            summary: 'Dream agent: nothing to change',
            mode: 'shadow',
            durationMs: Date.now() - startedAt,
            inputChars: prompt.length,
            outputChars: loop.text.length,
            usage: loop.usage,
            costExceeded,
          });
          await save({ status: 'skipped', skipReason: 'nothing-new', stage: 'done', finishedAt: Date.now() });
          return finish({ ok: true, skipped: true, skipReason: 'nothing-new', summary: 'nothing to change', runId });
        }
        const counts = {
          added: diff.added.length,
          changed: diff.changed.length,
          removed: diff.removed.length,
        };
        const summary = `Dream agent: ${diff.files.length} page(s) changed`;
        await state.setShadowPending({
          dir: shadowDirOf(paths),
          createdAt: Date.now(),
          runId,
          summary,
          base: shadowBase,
          files: diff.files,
          counts,
          sessions: candidates.map((item) => item.id),
          proposals: await proposalLines(diff, shadowStore),
          links: {},
          evidence,
          verifiedFiles: [],
          verifiedClaims: [],
        });
        if (records.length > 0) await state.clearSessions?.(records.map((item) => item.id), { reads: records });
        await state.markDreamDone?.({
          sessions: candidates.length,
          ops: writes.length,
          files: diff.files.length,
          summary,
          mode: 'shadow',
          durationMs: Date.now() - startedAt,
          inputChars: prompt.length,
          outputChars: loop.text.length,
          usage: loop.usage,
          costExceeded,
        });
        await save({ status: 'ready', stage: 'done', finishedAt: Date.now(), counts: diff.files.length });
        return finish({
          ok: true,
          ready: true,
          summary,
          counts,
          files: diff.files,
          sessionsReviewed: candidates.length,
          runId,
          usage: loop.usage,
          turns: loop.turns,
          ...(costExceeded ? { costExceeded: true, warning: cost.warning || `cost-limit-reached: stopped at ${tokenLimit} total tokens` } : {}),
        });
      } catch (error) {
        if (loopSignal?.aborted) {
          const reason = timeoutSignal?.aborted ? 'timeout' : 'cancelled';
          await clearShadow(paths).catch(() => {});
          await save({ status: 'cancelled', stage: 'agent', error: reason, finishedAt: Date.now() }).catch(() => {});
          await state.clearDreamError?.().catch(() => {});
          return finish({ ok: false, error: reason, runId });
        }
        const message = describeLlmError(error);
        await state.markDreamFailed?.(message).catch(() => {});
        await save({ status: 'failed', stage: 'agent', error: message, finishedAt: Date.now() }).catch(() => {});
        return finish({ ok: false, error: message, runId });
      }
    }, { ttlMs: config.lockTtlMs, waitMs: 2_000, strict: true });
  }
}
