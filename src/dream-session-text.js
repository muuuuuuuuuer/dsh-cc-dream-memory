/**
 * Session transcripts for Dream input.
 *
 * DSH appends injected context as `user/message` events whose `source.kind` is
 * not "user" (agent instructions, runtime context, skill catalog, other
 * plugins). Only `source.kind === "user"` (or a legacy event without a source)
 * is user speech, and of those a long structured message is labelled
 * `[user-pasted]`: it is material the user forwarded, not something they said.
 *
 * Memory readers only need what bears on memory. A transcript keeps every user
 * message verbatim, the one assistant message right before each user message
 * (what the user was answering or correcting), and failed tool calls with their
 * errors. Other assistant text, tool calls and tool output are left out: the
 * repository already records code, paths and how a fix worked.
 *
 * A transcript is read in event order and split into bounded chunks instead of
 * being sampled, so nothing in a long session is skipped for good: a chunk
 * reports the last event it fully covers (`lastSeq`) and a later pass resumes
 * from there; skipped events still count as covered.
 *
 * Dream's reading view (`{ work: true }`) also keeps the work: every tool call
 * with its clipped arguments and every tool result with its head and its tail
 * (the tail holds `[stderr]`, `[exit code: N]`, timeout and truncation markers),
 * and every assistant message. A tool result with an exit code is an
 * observation; an assistant saying "fixed" is a claim, and the view lets a
 * reader compare the two. Auto-extract does not ask for it: its window is small.
 *
 * Every line start inside a block is escaped, so transcript content cannot
 * forge a `[user]` line or a date marker. Tool calls come from the `tool/call`
 * event only (the assistant message repeats them); result ids come from
 * `data.message.toolCallId` / `data.message.source.callId`.
 */

import { scanSecrets } from './secrets.js';

const TOOL_ARGS_CLIP = 300;
const TOOL_RESULT_CLIP = 600;
/**
 * Work view clips. One call + result stays near 1.2k characters: the arguments
 * show what was run, the head of a result what it began with, and the tail the
 * ending that decides the outcome (stderr, exit code, timeout, truncation notes).
 */
const WORK_ARGS_CLIP = 400;
const WORK_RESULT_HEAD = 400;
const WORK_RESULT_TAIL = 400;
/** In the work view every assistant message is kept, so each one is clipped. */
const WORK_ASSISTANT_CLIP = 1500;
/** The assistant message a user replies to is context, not the subject: keep its gist. */
const ASSISTANT_CONTEXT_CLIP = 2000;
const PASTE_MIN_CHARS = 800;
const PASTE_MIN_LINES = 12;
const PASTE_MIN_STRUCTURED_LINES = 4;

export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text);
  }
  return parts.join('\n');
}

function clip(value, maxChars) {
  const text = String(value ?? '');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** Keep the start and the end of a long text; the end carries the outcome markers. */
function clipEnds(value, head, tail) {
  const text = String(value ?? '');
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}
… (${text.length - head - tail} characters omitted) …
${text.slice(-tail)}`;
}

/** Escape line-start tags and date markers so content cannot pose as structure. */
export function escapeToolText(text) {
  return String(text ?? '').replace(/^([^\S\r\n\u2028\u2029]*)(\[|---)/gm, '$1\\$2');
}

/** This plugin's own tools: their arguments and output are memory text, not evidence. */
export const isMemoryToolName = (name) => typeof name === 'string' && /^memory_/u.test(name);

const MEMORY_OP = ' (memory operation, not citable)';
const workName = (name) => (isMemoryToolName(name) ? name + MEMORY_OP : name);

export function toolCallIdOf(event) {
  const data = event?.data ?? {};
  return (
    (typeof data.message?.toolCallId === 'string' && data.message.toolCallId)
    || (typeof data.toolCallId === 'string' && data.toolCallId)
    || (typeof data.message?.source?.callId === 'string' && data.message.source.callId)
    || (typeof data.callId === 'string' && data.callId)
    || ''
  );
}

function isErrorResult(event) {
  const data = event?.data ?? {};
  return data.message?.isError === true || data.isError === true || data.message?.error != null || data.error != null;
}

const EXIT_MARKER = /\[exit code: (-?\d+)\]/g;

/** Whether a tool result reports a failure: an error, or a non-zero `[exit code: N]` marker. */
function isFailedResult(event) {
  if (isErrorResult(event)) return true;
  const text = contentToText(event?.data?.message?.content ?? event?.data?.content);
  return [...text.matchAll(EXIT_MARKER)].some((match) => Number(match[1]) !== 0);
}

/** How many tool results of a session failed (error, or non-zero exit code). */
export function countFailedToolResults(events) {
  return (Array.isArray(events) ? events : []).filter((event) => event?.type === 'tool/result'
    && event.data && typeof event.data === 'object' && isFailedResult(event)).length;
}

/** A long, structured message is forwarded material rather than the user's own words. */
export function looksPasted(value) {
  if (value.length < PASTE_MIN_CHARS) return false;
  const lines = value.split(/\r\n|\r|\n/);
  if (lines.length >= PASTE_MIN_LINES) return true;
  const structured = lines.filter((line) => /^\s*(#{1,6}\s|\||```|[-*]\s|\d+\.\s|>)/.test(line)).length;
  return structured >= PASTE_MIN_STRUCTURED_LINES;
}

/** Local calendar date of an event, the date the user would call it. */
function localDate(time) {
  const value = Number(time);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Turn one session's events into ordered blocks. Text blocks hold user messages
 * and the assistant message each one answers; tool blocks hold one failed call
 * with its error.
 * @param {Array<object>} events session event log.
 * @param {{work?:boolean}} [options] `work` keeps every tool call, tool result and assistant message (Dream's view).
 * @returns {{blocks:object[], userMessages:string[], userChars:number, maxSeq:number, lastAt:number}}
 */
export function buildSessionTranscript(events, { work = false } = {}) {
  const blocks = [];
  const userMessages = [];
  const calls = new Map();
  let pendingAssistant = null;
  let userChars = 0;
  let maxSeq = 0;
  let lastAt = 0;
  if (!Array.isArray(events)) return { blocks, userMessages, userChars, maxSeq, lastAt };
  const text = (event, tag, value) => {
    blocks.push({
      kind: 'text',
      tag,
      seq: Number(event.seq) || 0,
      time: Number(event.time) || 0,
      text: `[${tag}] ${escapeToolText(value)}`,
    });
  };
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    const seq = Number(event.seq);
    if (Number.isFinite(seq)) maxSeq = Math.max(maxSeq, seq);
    if (event.type === 'user/message') {
      const kind = event.data?.message?.source?.kind ?? event.data?.source?.kind;
      if (kind !== undefined && kind !== 'user') continue;
      const value = contentToText(event.data?.message?.content ?? event.data?.content).trim();
      if (value === '') continue;
      userChars += value.length;
      userMessages.push(value);
      if (pendingAssistant) {
        text(pendingAssistant.event, 'assistant', clip(pendingAssistant.value, ASSISTANT_CONTEXT_CLIP));
        pendingAssistant = null;
      }
      text(event, looksPasted(value) ? 'user-pasted' : 'user', value);
      lastAt = Math.max(lastAt, Number(event.time) || 0);
    } else if (event.type === 'assistant/message') {
      const content = event.data?.message?.content ?? event.data?.content;
      const value = contentToText(content).trim();
      if (value === '') continue;
      if (work) {
        text(event, 'assistant', clip(value, WORK_ASSISTANT_CLIP));
        lastAt = Math.max(lastAt, Number(event.time) || 0);
        continue;
      }
      // Kept only if a user message follows it.
      pendingAssistant = { event, value };
      lastAt = Math.max(lastAt, Number(event.time) || 0);
    } else if (event.type === 'tool/call' && event.data && typeof event.data === 'object') {
      const name = typeof event.data.name === 'string' ? event.data.name : 'tool';
      const id = toolCallIdOf(event);
      const rawArgs = typeof event.data.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data.arguments ?? {});
      if (work) {
        if (id !== '') calls.set(id, { seq: Number(event.seq) || 0, name });
        text(event, 'tool-call', `${workName(name)} ${clip(rawArgs, WORK_ARGS_CLIP)}`);
        continue;
      }
      // A call only appears in the transcript if it fails.
      if (id !== '') {
        calls.set(id, {
          seq: Number(event.seq) || 0,
          name,
          call: `[tool-call] ${name} ${escapeToolText(clip(rawArgs, TOOL_ARGS_CLIP))}`,
        });
      }
    } else if (event.type === 'tool/result' && event.data && typeof event.data === 'object') {
      if (work) {
        const error = event.data.error ?? event.data.message?.error;
        const value = contentToText(event.data.message?.content ?? event.data.content).trim()
          || [error?.name, error?.code].filter((part) => typeof part === 'string' && part !== '').join(' ');
        if (value === '') continue;
        const id = toolCallIdOf(event);
        text(event, isErrorResult(event) ? 'tool-error' : 'tool-result',
          `${workName((id !== '' && calls.get(id)?.name) || 'tool')}: ${clipEnds(value, WORK_RESULT_HEAD, WORK_RESULT_TAIL)}`);
        continue;
      }
      if (!isErrorResult(event)) continue;
      const value = contentToText(event.data.message?.content ?? event.data.content).trim();
      if (value === '') continue;
      const id = toolCallIdOf(event);
      const owner = id !== '' ? calls.get(id) : undefined;
      blocks.push({
        kind: 'tool',
        callSeq: owner?.seq ?? (Number(event.seq) || 0),
        resultSeq: Number(event.seq) || 0,
        seq: Number(event.seq) || 0,
        time: Number(event.time) || 0,
        name: owner?.name ?? 'tool',
        call: owner?.call ?? '',
        result: `[tool-error] ${owner?.name ?? 'tool'}: ${escapeToolText(clip(value, TOOL_RESULT_CLIP))}`,
        error: true,
      });
    }
  }
  return { blocks, userMessages, userChars, maxSeq, lastAt };
}

const toolCost = (block) => block.call.length + block.result.length + 2;

/** Pick tool blocks for one chunk: errors first (60% of the budget), then evenly spread. */
function selectToolBlocks(blocks, budget) {
  const selected = new Set();
  if (!(budget > 0) || blocks.length === 0) return selected;
  let spent = 0;
  for (const block of blocks) {
    if (!block.error) continue;
    const cost = toolCost(block);
    if (spent + cost > budget * 0.6) continue;
    selected.add(block);
    spent += cost;
  }
  const others = blocks.filter((block) => !block.error);
  if (others.length === 0 || spent >= budget) return selected;
  const average = others.reduce((sum, block) => sum + toolCost(block), 0) / others.length;
  const slots = Math.max(1, Math.min(others.length, Math.floor((budget - spent) / Math.max(1, average))));
  const step = Math.max(1, Math.floor(others.length / slots));
  for (let index = 0; index < others.length; index += step) {
    const cost = toolCost(others[index]);
    if (spent + cost > budget) continue;
    selected.add(others[index]);
    spent += cost;
  }
  return selected;
}

/** Cut a long string without splitting a surrogate pair. */
function splitText(text, size) {
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

/** Host-owned event locations for exactly the text a chunk renders. */
export function transcriptEvidenceBlocks(items) {
  return items.flatMap((item) => item.kind === 'text' ? [item] : [
    ...(item.call ? [{ tag: 'tool-call', seq: item.callSeq ?? item.seq, text: item.call }] : []),
    ...(item.result ? [{ tag: item.error ? 'tool-error' : 'tool-result', seq: item.resultSeq ?? item.seq, text: item.result }] : []),
  ]);
}

function renderChunk(items, toolBudget) {
  const selected = selectToolBlocks(items.filter((item) => item.kind === 'tool'), toolBudget);
  const lines = [];
  let date = '';
  for (const item of items) {
    if (item.kind === 'tool' && !selected.has(item)) continue;
    const day = localDate(item.time);
    if (day !== '' && day !== date) {
      lines.push(`--- ${day} ---`);
      date = day;
    }
    if (item.kind === 'text') {
      lines.push(item.text);
    } else {
      if (item.call !== '') lines.push(item.call);
      if (item.result !== '') lines.push(item.result);
    }
  }
  return lines.join('\n');
}

/**
 * Split a transcript into bounded chunks, in order.
 * @param {ReturnType<typeof buildSessionTranscript>} transcript
 * @param {{chunkChars:number, toolCharsPerChunk:number}} options
 * @returns {Array<{text:string, firstSeq:number, lastSeq:number}>} `lastSeq` is the
 *   last event this chunk fully covers; a message split across chunks only counts
 *   as read in the chunk holding its final piece.
 */
export function chunkTranscript(transcript, { chunkChars, toolCharsPerChunk, resume }) {
  const blocks = Array.isArray(transcript?.blocks) ? transcript.blocks : [];
  if (blocks.length === 0) return [];
  const limit = Number.isFinite(chunkChars) && chunkChars > 0 ? chunkChars : Infinity;
  // Conversation comes first: tool evidence may use at most a third of a chunk.
  const toolBudget = Number.isFinite(toolCharsPerChunk) && toolCharsPerChunk > 0 && blocks.some((item) => item.kind === 'tool')
    ? Math.min(toolCharsPerChunk, limit / 3) : 0;
  // Date markers and tags live inside the text budget.
  const textLimit = Math.max(200, limit - toolBudget - 32);
  const chunks = [];
  let items = [];
  let textChars = 0;
  let firstSeq = 0;
  let lastSeq = 0;
  const close = (nextOffset) => {
    if (items.length === 0) return;
    chunks.push({ text: renderChunk(items, toolBudget), firstSeq, lastSeq, evidenceBlocks: transcriptEvidenceBlocks(items),
      ...(nextOffset ? { nextOffset } : {}) });
    items = [];
    textChars = 0;
    firstSeq = 0;
  };
  const add = (item, coveredSeq) => {
    items.push(item);
    if (firstSeq === 0) firstSeq = Number(item.seq) || 0;
    lastSeq = Math.max(lastSeq, coveredSeq);
  };
  for (const original of blocks) {
    const prefix = original.kind === 'text' ? `[${original.tag}] ` : '';
    const offset = original.kind === 'text' && resume?.seq === original.seq ? resume.offset : 0;
    const block = offset > 0 ? { ...original, text: prefix + original.text.slice(prefix.length + offset) } : original;
    if (block.kind === 'tool') {
      add(block, block.seq);
      continue;
    }
    const length = block.text.length + 17;
    if (length <= textLimit) {
      if (textChars + length > textLimit) close();
      add(block, block.seq);
      textChars += length;
      continue;
    }
    // Longer than a whole chunk: split it. Continuation pieces repeat the tag so
    // a cut can never leave content sitting at a line start.
    close();
    const pieces = splitText(block.text.slice(prefix.length), textLimit - prefix.length - 17);
    let next = offset;
    pieces.forEach((piece, index) => {
      const isLast = index === pieces.length - 1;
      add({ ...block, text: `${prefix}${escapeToolText(piece)}` }, isLast ? block.seq : Math.max(lastSeq, block.seq - 1));
      textChars += piece.length + prefix.length + 17;
      next += piece.length;
      if (!isLast) close({ seq: block.seq, offset: next });
    });
  }
  close();
  chunks[chunks.length - 1].lastSeq = Math.max(chunks[chunks.length - 1].lastSeq, Number(transcript.maxSeq) || 0);
  return chunks;
}

const PAGE_BLOCKS = 40;
const PAGE_CHARS = 24_000;
/** One message longer than this is shown cut, with the omitted length stated. */
const BLOCK_CHARS = 12_000;

function shown(line) {
  if (scanSecrets(line).matches.length > 0) return '[sensitive passage omitted]';
  return line.length <= BLOCK_CHARS ? line : `${line.slice(0, BLOCK_CHARS)} […${line.length - BLOCK_CHARS} more characters not shown]`;
}

/**
 * One page of a session transcript for a Dream worker: each block with the
 * `seq` of the event it came from, from `fromSeq` on, in event order. Secrets
 * are replaced; a text block keeps its `[user]` / `[user-pasted]` / `[assistant]`
 * label.
 * @param {ReturnType<typeof buildSessionTranscript>} transcript
 * @param {{fromSeq?:number, limit?:number}} [options]
 * @returns {{text:string, count:number, lastSeq:number, nextFromSeq:number|null}}
 *   `nextFromSeq` is the cursor for the rest, or null when the page reaches the end.
 */
export function renderTranscriptPage(transcript, { fromSeq = 0, limit = PAGE_BLOCKS } = {}) {
  const blocks = (Array.isArray(transcript?.blocks) ? transcript.blocks : [])
    .filter((block) => block.seq >= fromSeq)
    .sort((a, b) => a.seq - b.seq);
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : PAGE_BLOCKS;
  const lines = [];
  let date = '';
  let chars = 0;
  let count = 0;
  let lastSeq = fromSeq - 1;
  for (const block of blocks) {
    const body = block.kind === 'text'
      ? [`[seq ${block.seq}] ${shown(block.text)}`]
      : [
        ...(block.call ? [`[seq ${block.callSeq ?? block.seq}] ${shown(block.call)}`] : []),
        `[seq ${block.resultSeq ?? block.seq}] ${shown(block.result)}`,
      ];
    const day = localDate(block.time);
    const marker = day !== '' && day !== date ? [`--- ${day} ---`] : [];
    const size = [...marker, ...body].reduce((sum, line) => sum + line.length + 1, 0);
    if (count > 0 && (count >= cap || chars + size > PAGE_CHARS)) {
      return { text: lines.join('\n'), count, lastSeq, nextFromSeq: block.seq };
    }
    lines.push(...marker, ...body);
    if (marker.length > 0) date = day;
    chars += size;
    count += 1;
    lastSeq = block.seq;
  }
  return { text: lines.join('\n'), count, lastSeq, nextFromSeq: null };
}

/**
 * One bounded view of a whole session (used where a single text is enough).
 * @param {Array<object>} events session event log.
 * @param {{maxToolChars?:number}} [options]
 * @returns {{text:string, userChars:number, userMessages:string[], maxSeq:number}}
 */
export function extractSessionText(events, options = {}) {
  const transcript = buildSessionTranscript(events);
  const maxToolChars = Number.isFinite(options.maxToolChars) && options.maxToolChars >= 0 ? options.maxToolChars : 4000;
  const [chunk] = chunkTranscript(transcript, { chunkChars: Infinity, toolCharsPerChunk: maxToolChars });
  return {
    text: chunk?.text ?? '',
    userChars: transcript.userChars,
    userMessages: transcript.userMessages,
    maxSeq: transcript.maxSeq,
  };
}

const PROBE_LINE = /^(reply|respond) with exactly|^reply with (just|only)|^say ok$|^reply ok$/i;

/** Sessions that are just API/probe checks; a single probe line in a long real session is not enough. */
export function isProbeSession(userMessages) {
  if (!Array.isArray(userMessages) || userMessages.length === 0) return true;
  const messages = userMessages.map((item) => String(item).trim()).filter(Boolean);
  if (messages.length === 0) return true;
  if (messages.every((message) => PROBE_LINE.test(message))) return true;
  return messages.length === 1 && messages[0].length < 12 && /^(ok|okay|ping|test|hello|hi)$/i.test(messages[0]);
}
