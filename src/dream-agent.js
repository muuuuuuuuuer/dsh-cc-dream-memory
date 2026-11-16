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
import { bodyLineChanges, reviewProofs } from './dream-evidence.js';
import { memoryHash } from './write-review.js';
import { currentBody } from './memory-body.js';
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
const PAGE_CHARS = 8_000;
const MAX_SEARCH = 12;
const MAX_READ = 8;
const MAX_EVIDENCE = 500;
/** Typical tool call plus result added to the context per turn, for estimates. */
const ESTIMATE_TURN_CHARS = 3_000;
const ESTIMATE_SESSION_TURNS = 3;
const MAX_REJECTED_PROMPT = 20;
/** How much of a rejected change is kept: enough to tell two edits of one page apart. */
const REJECTED_DIFF_LINES = 3;
const REJECTED_LINE_CHARS = 120;
const REJECTED_ENTRY_CHARS = 700;
/** Shorter quotes match too easily to count as a check. */
const MIN_QUOTE_CHARS = 8;

function textPageEnd(text, offset, length) {
  const end = Math.min(text.length, offset + length);
  const last = text.charCodeAt(end - 1);
  return end < text.length && last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

const SYSTEM = `You are Dream, the consolidation agent for a project memory directory.
You are working on a **copy** (shadow) of the memory directory. Never assume a change is live.

Your job:
1. Read MEMORY.md and the note metadata first (memory_index).
2. Compare the current pages with each other before reading any session. Read (memory_read) the pages that share a subject; when they repeat or contradict each other, fix that in the copy right away (step 4). Do this every run, even when there are new sessions: your turns are limited and sessions you do not finish stay for the next run.
3. Then review sessions. Search narrowly; if session_search returns an error, page through the session with session_read (at most 8 events before/after per call). Before marking a session reviewed, use session_read to cover its unread text events. session_done reports the next missing seqs; when nearing the turn limit, call it to checkpoint the reviewed prefix.
   A page body is not in this prompt; read only the pages you need.
4. Write the consolidated result to the shadow copy with memory_write / memory_delete.
   - Merge duplicate facts; keep one canonical line.
   - A contradicted value replaces the old value; keep one short Superseded line in the body.
   - When two current pages contradict each other, keep the value that another page or a session explicitly states supersedes the other (for example "X is retired"); otherwise keep the more recently modified page. If neither is clear, change nothing.
   - When a page you keep says the other page's value is retired or replaced, that page is the evidence: delete or correct the other page now and cite it as {memory_file, quote}. Do not wait for a session to repeat it.
   - Remove clearly stale or wrong pages only when the evidence is in a session you read or in another current page that you keep.
   - Add source annotations like ^[session#seq, YYYY-MM-DD] to new fact lines when you can.
   - Keep MEMORY.md index lines one line each, under ~150 chars.
5. Reply DONE when finished. If nothing durable changed, reply DONE without writing.

Rules:
- Only durable facts that cannot be read from the repository: user preferences, corrections, decisions, external references.
- Never save secrets, one-off task details, code patterns, file paths, or project structure.
- Use absolute dates.
- Do not write to the live store; you only have shadow tools.
- Prefer updating an existing page over creating a near-duplicate.
- Cite each new or changed fact and any deletion that loses information. In the write/delete tool call pass citations: [{session_id, seq, quote}] with quotes copied verbatim from session_read, or [{memory_file, quote}] with a quote copied verbatim from the current text of another page that stays (from memory_read). Without a matched quote on the final page version, only fact-preserving changes can be applied. If a citation fails, correct it before finishing.
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

/** True for plugin-injected prompt material, which is not independent evidence. */
function isInjectedEvent(event) {
  const data = event?.data ?? event ?? {};
  const source = data?.message?.source ?? data?.source;
  const kind = source?.kind;
  return event?.type === 'system/message'
    || (typeof kind === 'string' && kind.startsWith('plugin:'))
    || ((event?.type === 'user/message' || (data.message ?? data).role === 'user')
      && kind !== undefined && kind !== 'user');
}

function eventSnippet(event) {
  const data = event?.data ?? event ?? {};
  const message = data.message ?? data;
  const source = message?.source ?? data.source;
  const kind = typeof source?.kind === 'string' ? source.kind : '';
  const label = kind === 'user' ? 'user' : kind === 'model' || kind === 'assistant' ? 'assistant' : kind.startsWith('plugin:') ? 'plugin' : kind || 'event';
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'tool-call') parts.push(`[tool ${block.name}]`);
  }
  return oneLine(`${label}: ${data.snippet || parts.join(' ') || JSON.stringify(data)}`, 500);
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
  return new Map(processed.filter((item) => item.coverageVersion === 1).map((item) => [item.id, item]));
}

async function sessionBounds(sessionQuery, id) {
  try {
    const events = await sessionQuery.listEvents(id);
    if (!Array.isArray(events)) return null;
    const seqs = events.filter((event) => Number.isSafeInteger(event?.seq) && event.seq >= 0);
    return {
      lastSeq: seqs.reduce((max, event) => Math.max(max, event.seq), 0),
      required: seqs.filter((event) => !event.type || ['user/message', 'assistant/message', 'tool/result'].includes(event.type))
        .map((event) => event.seq).sort((a, b) => a - b),
    };
  } catch {
    return null;
  }
}

async function candidatesOf({ ctx, pctx, config, metadataOnly = false, signal }) {
  const sessionQuery = ctx?.get?.('sessionQuery');
  if (typeof sessionQuery?.filterSessions !== 'function') return [];
  const records = await sessionQuery.filterSessions([{ kind: 'cwd', values: [pctx.workspaceDir] }], signal);
  const processed = candidateState(pctx.state);
  const active = new Set((pctx.state.snapshot?.().sessionsSince ?? []).map((item) => item.id));
  const candidates = [];
  for (const record of Array.isArray(records) ? records : []) {
    const header = record?.header ?? record?.session ?? record;
    const id = textOf(header?.id);
    if (!id || header?.parentSession || header?.origin === 'subagent') continue;
    const mark = processed.get(id);
    if (mark && !mark.partial && !active.has(id)) continue;
    candidates.push({ id, createdAt: Number(header?.createdAt) || 0, readSeq: mark?.seq ?? null, checkedAt: mark?.at ?? 0 });
  }
  candidates.sort((a, b) => a.checkedAt - b.checkedAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const selected = candidates.slice(0, Math.max(1, Number(config.sessionLookback) || 8));
  if (metadataOnly) return selected;
  return Promise.all(selected.map(async (candidate) => ({ ...candidate, bounds: await sessionBounds(sessionQuery, candidate.id) })));
}

/**
 * One readable line per changed file. These are what a reject/discard stores
 * in `dreamRejected`, and what the next run is shown so it does not propose
 * the same change again. Each line names the page version it was made
 * against and the lines it removed and added, so two different edits of one
 * page ("Thursday -> Monday", "Chinese -> English") stay distinguishable.
 */
async function proposalLines(diff, shadowStore, store) {
  const read = (from, file) => from.readEntry(file).catch(() => null);
  const quoteLines = (items) => items.slice(0, REJECTED_DIFF_LINES)
    .map((item) => `"${oneLine(item.text, REJECTED_LINE_CHARS)}"`).join(', ');
  const out = {};
  for (const { file, action } of diff.files) {
    const before = action === 'added' ? null : await read(store, file);
    const after = action === 'removed' ? null : await read(shadowStore, file);
    const version = before ? ` (page ${memoryHash(before.raw).slice(0, 8)})` : '';
    const description = after?.frontmatter?.description || before?.frontmatter?.description || '';
    const { addedLines, removedLines } = bodyLineChanges(currentBody(before?.body ?? ''), currentBody(after?.body ?? ''));
    const parts = [`${action} ${file}${version}${description ? `: ${description}` : ''}`];
    if (removedLines.length > 0) parts.push(`removed ${quoteLines(removedLines)}`);
    if (addedLines.length > 0) parts.push(`added ${quoteLines(addedLines)}`);
    out[file] = [oneLine(parts.join('; '), REJECTED_ENTRY_CHARS)];
  }
  return out;
}

/** The page a `dreamRejected` line is about ("changed a.md (page …): …" -> "a.md"). */
function rejectedFileOf(line) {
  return /^(?:added|changed|removed) (\S+?)(?::|;|\s|$)/u.exec(String(line ?? ''))?.[1] ?? '';
}

function sessionLine(item) {
  const created = new Date(item.createdAt || 0).toISOString();
  const range = item.readSeq !== null ? 'new events after seq ' + item.readSeq : 'not reviewed yet';
  const first = item.bounds?.required.find((seq) => seq > (item.readSeq ?? -1));
  const next = first === undefined ? '' : ', first unreviewed text event seq ' + first;
  return '- ' + item.id + ' created ' + created + ', ' + range + next;
}

function reviewProgress(candidate, reads) {
  if (!candidate.bounds) return null;
  const required = candidate.bounds.required.filter((seq) => seq > (candidate.readSeq ?? -1));
  const next = required.findIndex((seq) => !reads?.has(seq));
  if (next === -1) return { seq: candidate.bounds.lastSeq, complete: true };
  const seq = next > 0 ? required[next - 1] : candidate.readSeq;
  return { seq, complete: false, missing: required.slice(next).filter((seq) => !reads?.has(seq)).slice(0, 8) };
}

function reviewRecords(candidates, reads, doneSessions, capturedAt) {
  return candidates.flatMap((item) => {
    if (!doneSessions.has(item.id)) return [];
    const progress = reviewProgress(item, reads.get(item.id));
    return progress && (progress.complete || (progress.seq !== null && progress.seq !== item.readSeq))
      ? [{ id: item.id, seq: progress.seq, complete: progress.complete, capturedAt }]
      : [];
  });
}

/** One tool surface, bound to the shadow store and the host session query. */
function toolsFor({ ctx, config, shadowStore, liveStore, candidates, onReadSession: onSessionRead, onWrite, onEvidence, onSessionDone, onLink, reads, seenSessions, signal }) {
  const recordEvidence = typeof onEvidence === 'function' ? onEvidence : () => {};
  const sessionQuery = ctx?.get?.('sessionQuery');
  const citationSchema = {
    type: 'array',
    description: 'Evidence for this change: either session_id + seq with a short quote copied verbatim from session_read, or memory_file with a short quote copied verbatim from the current text of another page that stays.',
    items: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        seq: { type: 'integer', minimum: 0 },
        memory_file: { type: 'string', description: 'Another current memory page whose text supports this change.' },
        quote: { type: 'string' },
      },
      required: ['quote'],
    },
  };
  const pageReads = new Map();
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
        properties: {
          file: { type: 'string', description: 'File name, e.g. feedback_style.md' },
          offset: { type: 'integer', minimum: 0 },
          version: { type: 'string', description: 'Version returned with offset 0; required to continue.' },
        },
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
          version: { type: 'string', description: 'Read version required when replacing a long page.' },
          citations: citationSchema,
          merges: {
            type: 'array',
            description: 'Files whose facts you moved into this page. Each is one review unit with this write.',
            items: { type: 'string' },
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
        properties: {
          file: { type: 'string' },
          moved_to: { type: 'string', description: 'When merging, the file that now holds these facts.' },
          citations: citationSchema,
        },
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
          offset: { type: 'integer', minimum: 0, description: 'Read one long event at this offset. Start at 0 and follow the returned next offset.' },
        },
        required: ['session_id', 'seq'],
        additionalProperties: false,
      },
    },
    {
      name: 'session_done',
      description: 'Mark one candidate session reviewed. Call this only after reading the relevant events; unread sessions stay candidates for the next run.',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
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
          const version = memoryHash(entry.raw);
          const offset = Number(args.offset ?? 0);
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.body.length) return 'ERROR: invalid offset';
          if (offset > 0 && args.version !== version) return 'ERROR: page version changed; start at offset 0';
          const end = textPageEnd(entry.body, offset, PAGE_CHARS);
          const read = pageReads.get(entry.file);
          if (offset === 0 || (read?.version === version && offset <= read.end)) {
            pageReads.set(entry.file, { version, end: Math.max(end, read?.version === version ? read.end : 0) });
          }
          const next = end < entry.body.length ? end : null;
          return JSON.stringify({ file: entry.file, version, description: entry.frontmatter.description.slice(0, 250), next })
            + '\n' + entry.body.slice(offset, end);
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
          const previous = await shadowStore.readEntry(file).catch((error) => {
            if (error?.code !== 'NOT_FOUND') throw error;
            return null;
          });
          if (previous) {
            const version = memoryHash(previous.raw);
            const read = pageReads.get(previous.file);
            if (args.version && args.version !== version) return 'ERROR: page changed; read the new version before replacing it';
            if (previous.body.length > PAGE_CHARS && (args.version !== version || read?.version !== version || read.end < previous.body.length)) {
              return 'ERROR: read all pages of this memory and pass its version before replacing it';
            }
          }
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
          for (const source of Array.isArray(args.merges) ? args.merges : []) {
            const from = textOf(source);
            if (from !== '' && from !== result.file && typeof onLink === 'function') onLink(from, result.file);
          }
          const revision = memoryHash((await shadowStore.readEntry(result.file)).raw);
          return 'WROTE ' + result.file + await checkCitations(args.citations, result.file, revision);
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
          const into = textOf(args.moved_to);
          if (into !== '' && into !== file && typeof onLink === 'function') onLink(file, into);
          return 'DELETED ' + file + await checkCitations(args.citations, file, 'removed');
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
          const lines = [];
          for (const hit of items) {
            const seq = Number(hit?.seq ?? hit?.event?.seq);
            if (!Number.isSafeInteger(seq) || seq < 0) continue;
            const event = await readExactEvent(sessionId, seq);
            if (!event || isInjectedEvent(event)) continue;
            lines.push(`- seq ${seq}: ${eventSnippet(hit?.snippet ? { ...event, data: { ...event.data, snippet: hit.snippet } } : event)}`);
          }
          if (lines.length === 0) return 'No matches.';
          seenSessions.add(sessionId);
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
          const paged = args.offset !== undefined;
          const offset = Math.max(0, Math.trunc(Number(args.offset) || 0));
          const width = (value, fallback) => Math.max(0, Math.min(MAX_READ, Math.trunc(Number(value ?? fallback) || 0)));
          const page = await sessionQuery.readEvent({
            sessionId, seq, before: paged ? 0 : width(args.before, 2), after: paged ? 0 : width(args.after, 4),
          }, signal);
          const events = Array.isArray(page?.events) ? page.events : Array.isArray(page) ? page : [];
          const lines = [];
          for (const event of events) {
            const at = event.seq;
            if (!Number.isSafeInteger(at) || (paged && at !== seq)) continue;
            if (isInjectedEvent(event)) {
              onReadSession(sessionId, at);
              continue;
            }
            const text = eventText(event);
            if (!text) {
              onReadSession(sessionId, at);
              continue;
            }
            const from = paged ? offset : 0;
            const end = Math.min(text.length, from + (paged ? 8000 : 600));
            const source = event.data?.message?.source?.kind ?? event.data?.source?.kind;
            const label = oneLine('[' + at + '] ' + event.type + (source ? ' (' + source + ')' : ''), 80) + ': ';
            const hint = end < text.length ? '\n[More text at offset ' + end + ']' : '';
            lines.push(label + text.slice(from, end) + hint);
            onReadSession(sessionId, at, { from, end, length: text.length });
          }
          if (lines.length > 0) seenSessions.add(sessionId);
          return lines.length ? clip(lines.join('\n')) : 'No visible text in this window.';
        } catch (error) {
          return `ERROR: ${error?.message ?? error}`;
        }
      }
      case 'session_done': {
        const sessionId = textOf(args.session_id);
        if (sessionId === '') return 'ERROR: session_id is required';
        if (!candidates.some((item) => item.id === sessionId)) return 'ERROR: session_id is not a candidate';
        const item = candidates.find((candidate) => candidate.id === sessionId);
        const progress = reviewProgress(item, reads.get(sessionId));
        if (!progress) return 'ERROR: session bounds unavailable; it will be retried.';
        onSessionDone(sessionId);
        return progress.complete ? 'DONE ' + sessionId : 'INCOMPLETE ' + sessionId + ': next unread seqs ' + progress.missing.join(', ');
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
  async function checkCitations(raw, file, revision) {
    const citations = (Array.isArray(raw) ? raw : []).slice(0, 20);
    let matched = 0;
    let unverified = 0;
    for (const citation of citations) {
      const quote = oneLine(textOf(citation?.quote), 500);
      const memoryFile = textOf(citation?.memory_file ?? citation?.memoryFile);
      if (memoryFile !== '' && quote) {
        const verified = await memoryQuoteMatches(memoryFile, file, quote);
        if (verified) matched++;
        else unverified++;
        recordEvidence({ memoryFile, quote, file, revision, source: 'memory', verified });
        continue;
      }
      const sessionId = textOf(citation?.session_id ?? citation?.sessionId);
      const seq = Number(citation?.seq);
      if (!sessionId || !Number.isSafeInteger(seq) || !quote) continue;
      const verified = await quoteMatches(sessionId, seq, quote);
      if (verified) matched++;
      else unverified++;
      recordEvidence({ sessionId, seq, quote, file, revision, source: 'citation', verified });
    }
    if (unverified > 0) return ' (' + unverified + ' citation(s) did not match the cited session or page text)';
    return matched > 0 ? '' : ' (no checked citation; only fact-preserving edits can be applied without one)';
  }

  async function readExactEvent(sessionId, seq) {
    try {
      const page = await sessionQuery?.readEvent?.({ sessionId, seq, before: 0, after: 0 }, signal);
      const events = Array.isArray(page?.events) ? page.events : Array.isArray(page) ? page : [];
      return events.find((item) => Number(item?.seq) === seq);
    } catch {
      return undefined;
    }
  }

  async function quoteMatches(sessionId, seq, quote) {
    const wanted = normalizeQuote(quote);
    if (wanted.length < MIN_QUOTE_CHARS || !candidates.some((item) => item.id === sessionId)) return false;
    const event = await readExactEvent(sessionId, seq);
    return Boolean(event) && !isInjectedEvent(event) && normalizeQuote(eventText(event)).includes(wanted);
  }

  /**
   * A page quote counts only when it is in the current text (not History) of
   * another page as it was before this run. The review step checks again that
   * the page still says it in the copy being applied.
   */
  async function memoryQuoteMatches(memoryFile, file, quote) {
    const wanted = normalizeQuote(quote);
    if (wanted.length < MIN_QUOTE_CHARS || !liveStore) return false;
    try {
      const entry = await liveStore.readEntry(memoryFile);
      if (entry.file === file) return false;
      return normalizeQuote(currentBody(entry.body)).includes(wanted);
    } catch {
      return false;
    }
  }

  function onReadSession(sessionId, seq, page) {
    if (Number.isSafeInteger(seq) && seq >= 0) onSessionRead(sessionId, seq, page);
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
      usage: manifest.usage,
      sessionsReviewed: Number(manifest.sessionsReviewed) || 0,
      sessionsOffered: Array.isArray(manifest.input?.sessions) ? manifest.input.sessions.length : 0,
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
    };
  }

  async estimate({ pctx, noSessions = false } = {}) {
    if (!pctx?.paths) throw new Error('no-project');
    // Metadata only: an estimate must not load session logs.
    const candidates = noSessions ? [] : await candidatesOf({ ctx: this.ctx, pctx, config: this.config, metadataOnly: true });
    const index = await pctx.store.indexText('project');
    const pages = (await pctx.store.listEntries('project')).length;
    // The run is a tool loop: every turn re-sends the system prompt, the tool
    // schemas and the conversation so far, so the total grows with the number
    // of turns, not with the size of the first prompt.
    const { tools } = toolsFor({ ctx: this.ctx, config: this.config, candidates: [] });
    const firstPrompt = SYSTEM.length + JSON.stringify(tools).length + String(index || '').length
      + candidates.length * 120 + 1_500;
    // Without the logs, assume a search, a read and a checkpoint per session.
    const turns = Math.min(MAX_TURNS, 2 + Math.ceil(pages / 2) + candidates.length * ESTIMATE_SESSION_TURNS);
    const chars = turns * firstPrompt + ESTIMATE_TURN_CHARS * (turns * (turns + 1)) / 2;
    return {
      estimatedTokens: Math.ceil(chars / 4),
      inputChars: chars,
      turns,
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
    let ran = false;
    const finish = (extra = {}) => ({ ...base, ran, ...extra, durationMs: Date.now() - startedAt, finishedAt: Date.now() });
    const store = pctx?.store;
    const state = pctx?.state;
    const paths = pctx?.paths;
    if (!store || !state || !paths) return finish({ skipped: true, skipReason: 'no-project', error: 'no-project' });
    if (signal?.aborted) return finish({ skipped: true, skipReason: 'aborted' });
    if (config.enabled === false) return finish({ skipped: true, skipReason: 'disabled' });
    if (config.autoMemoryEnabled === false) return finish({ skipped: true, skipReason: 'auto-memory-disabled' });

    return withFileLock(paths.lockFile, async () => {
      await state.read?.();
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
        const capturedAt = Date.now();
        const candidates = noSessions ? [] : await candidatesOf({ ctx: this.ctx, pctx, config, signal: loopSignal });
        // A session with no unreviewed text (one that only ran a slash command,
        // say) has nothing to read. Settle it here instead of offering it to the
        // agent, which would otherwise spend its turns paging through nothing.
        const settled = candidates.filter((item) => item.bounds
          && !item.bounds.required.some((seq) => seq > (item.readSeq ?? -1)));
        const offered = candidates.filter((item) => !settled.includes(item));
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
        const seenSessions = new Set();
        const doneSessions = new Set(settled.map((item) => item.id));
        const writes = [];
        const links = {};
        const evidence = [];
        const evidenceKeys = new Set();
        const failedWrites = new Set();
        const onEvidence = (item) => {
          if (!item || evidence.length >= MAX_EVIDENCE) return;
          const quote = String(item.quote || '').slice(0, 500);
          if (item.source === 'memory') {
            const memoryFile = String(item.memoryFile || '');
            if (memoryFile === '') return;
            const key = JSON.stringify(['memory', memoryFile, item.file, quote, item.revision]);
            if (evidenceKeys.has(key)) return;
            evidenceKeys.add(key);
            evidence.push({
              memoryFile,
              quote,
              revision: item.revision,
              ...(item.file ? { file: String(item.file) } : {}),
              source: 'memory',
              verified: item.verified === true,
            });
            return;
          }
          const sessionId = String(item.sessionId || '');
          const seq = Number(item.seq);
          if (sessionId === '' || !Number.isFinite(seq)) return;
          const key = JSON.stringify([sessionId, seq, item.file, quote, item.revision]);
          if (evidenceKeys.has(key)) return;
          evidenceKeys.add(key);
          evidence.push({
            sessionId,
            seq,
            quote,
            revision: item.revision,
            ...(item.file ? { file: String(item.file) } : {}),
            source: item.source || 'citation',
            verified: item.verified === true,
          });
        };
        const offsets = new Map();
        const onReadSession = (id, seq, page) => {
          if (page) {
            const key = id + ':' + seq;
            const next = offsets.get(key) ?? 0;
            if (page.from > next) return;
            const end = Math.max(next, page.end);
            if (end < page.length) {
              offsets.set(key, end);
              return;
            }
            offsets.delete(key);
          }
          if (!reads.has(id)) reads.set(id, new Set());
          reads.get(id).add(seq);
        };
        const onWrite = (file, op) => writes.push({ file, op });
        const { tools, execute } = toolsFor({
          ctx: this.ctx,
          config,
          shadowStore,
          liveStore: store,
          candidates: offered,
          reads,
          seenSessions,
          signal: loopSignal,
          onReadSession,
          onWrite,
          onEvidence,
          onSessionDone: (sessionId) => doneSessions.add(String(sessionId)),
          onLink: (from, into) => {
            if (from && into && from !== into) links[String(from)] = String(into);
          },
        });
        const index = await shadowStore.indexText('project');
        const indexHead = String(index || '').slice(0, 8_000);
        const sessionLines = offered.map(sessionLine).join('\n');
        // Rejections of pages that still exist come last (nearest the cut):
        // those are the ones this run could propose again.
        const allRejected = (state.snapshot?.().dreamRejected ?? [])
          .filter((item) => typeof item === 'string' && item !== '');
        const pageFiles = new Set((await shadowStore.listEntries('project')).map((entry) => entry.file));
        const rejected = [
          ...allRejected.filter((item) => !pageFiles.has(rejectedFileOf(item))),
          ...allRejected.filter((item) => pageFiles.has(rejectedFileOf(item))),
        ].slice(-MAX_REJECTED_PROMPT);
        const rules = String(this.runtime.rulesFor?.(pctx)?.text || '');
        const prompt = [
          `Project: ${pctx.workspaceDir}`,
          focus ? `Focus: ${focus}` : '',
          rules.trim() === '' ? '' : `Project memory rules (follow these over your defaults):\n${rules}`,
          'Candidate sessions:\n' + (sessionLines || '(none)'),
          'MEMORY.md (head):\n' + (indexHead || '(empty)'),
          rejected.length > 0
            ? 'Changes the reviewer rejected before. Each names the page version it was made against and the lines it removed and added. Do not propose the same change again. Propose it again only with evidence the reviewer has not seen (a session you read or a current page you quote), and cite that evidence. Other changes to the same page are fine:\n'
              + rejected.map((item) => `- ${item}`).join('\n')
            : '',
          'Use memory_index for the note list. Use session_search/session_read for evidence. When you merge facts into another page, list the source files in `merges` (or `moved_to` on delete) so one review decision covers the whole move. Call session_done after you finish reviewing a session; unread sessions stay for the next run. Write only the shadow copy. Reply DONE when finished.',
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

        ran = true;
        const loop = await runToolLoop({
          ctx: this.ctx,
          model,
          system: SYSTEM,
          prompt,
          tools,
          executeTool: async (call) => {
            const result = await execute(call);
            if (call.name === 'memory_write' || call.name === 'memory_delete') {
              const file = textOf(call.arguments?.file);
              if (result.startsWith('ERROR:')) failedWrites.add(file);
              else failedWrites.delete(file);
            }
            return result;
          },
          maxTurns: MAX_TURNS,
          maxTokens: MAX_TOKENS,
          purpose: 'cc-memory-dream',
          signal: loopSignal,
          maxTotalTokens: tokenLimit,
        });
        // The run record keeps what the run actually used, whatever its outcome.
        await save({
          usage: loop.usage ?? {},
          models: { agent: `${model.provider}/${model.model}` },
          input: {
            sessions: candidates.map(({ id }) => ({ id })),
            expectedUnits: 0,
            memoryFiles: (await store.listEntries('project').catch(() => [])).length,
          },
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
        const records = failedWrites.size ? [] : reviewRecords(candidates, reads, doneSessions, capturedAt);
        const coverage = {
          sessionsOffered: candidates.length,
          sessionsRead: seenSessions.size,
          sessionsReviewed: records.filter((item) => item.complete).length,
          sessionsPartial: candidates.filter((item) => seenSessions.has(item.id) && !records.some((record) => record.id === item.id && record.complete)).length,
        };
        if (diff.files.length === 0) {
          // Running out of turns is not the same answer as "nothing to change".
          const unfinished = loop.stopped === 'max-turns' || loop.stopped === 'budget';
          const outcome = unfinished ? 'unfinished' : 'nothing-new';
          await clearShadow(paths);
          await state.clearShadowPending?.();
          if (records.length > 0) await state.clearSessions?.(records.map((item) => item.id), { reads: records });
          await state.markDreamDone?.({
            sessions: coverage.sessionsReviewed,
            ops: 0,
            files: 0,
            summary: unfinished ? 'Dream agent: stopped at the turn limit before proposing changes' : 'Dream agent: nothing to change',
            mode: 'shadow',
            durationMs: Date.now() - startedAt,
            inputChars: prompt.length,
            outputChars: loop.text.length,
            usage: loop.usage,
            costExceeded,
          });
          // The agent ran (and either found nothing or ran out of turns): that
          // is a finished run, not a skipped one.
          await save({ status: 'done', skipReason: outcome, stage: 'done', sessionsReviewed: coverage.sessionsReviewed, finishedAt: Date.now() });
          return finish({
            ...coverage,
            ok: true,
            skipped: true,
            skipReason: outcome,
            summary: unfinished ? 'stopped at the turn limit before proposing changes' : 'nothing to change',
            runId,
          });
        }
        const counts = {
          added: diff.added.length,
          changed: diff.changed.length,
          removed: diff.removed.length,
        };
        const summary = `Dream agent: proposed changes to ${diff.files.length} page(s)`;
        const proofs = await reviewProofs({ diff, store, shadowStore, links, evidence });
        const finalRevisions = new Map(proofs.map((item) => [item.file, item.revision]));
        await state.setShadowPending({
          dir: shadowDirOf(paths),
          createdAt: Date.now(),
          runId,
          summary,
          base: shadowBase,
          files: diff.files,
          counts,
          sessions: candidates.map((item) => item.id),
          reviewRecords: records,
          proposals: await proposalLines(diff, shadowStore, store),
          // Shown beside a change so the reviewer sees what they turned down before.
          rejectedBefore: Object.fromEntries(diff.files
            .map(({ file }) => [file, allRejected.filter((item) => rejectedFileOf(item) === file).slice(-3)])
            .filter(([, items]) => items.length > 0)),
          links,
          proofs,
          evidence: evidence.filter((item) => finalRevisions.get(item.file) === item.revision),
          verifiedFiles: [],
          verifiedClaims: [],
        });
        await state.markDreamDone?.({
          sessions: coverage.sessionsReviewed,
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
        await save({ status: 'ready', stage: 'done', sessionsReviewed: coverage.sessionsReviewed, finishedAt: Date.now(), counts: diff.files.length });
        return finish({
          ok: true,
          ready: true,
          summary,
          counts,
          files: diff.files,
          ops: writes.length,
          ...coverage,
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
        // A failed run leaves nothing to review; do not keep its partial copy.
        await clearShadow(paths).catch(() => {});
        return finish({ ok: false, error: message, runId });
      }
    }, { ttlMs: config.lockTtlMs, waitMs: 2_000, strict: true });
  }
}
