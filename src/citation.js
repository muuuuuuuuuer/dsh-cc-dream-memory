/**
 * The one provenance check: does a quoted text exist where a citation says?
 *
 * Dream's `dream_submit` and the main-session `memory_save` / `memory_update`
 * (and so auto-extract) all cite sources with a quote. The host verifies only
 * what it can know: the quote is in that session event (not host-injected
 * context) or in a note, and who said it. Whether a note follows from its
 * quote is the model's call.
 */
import { normalizeForMatch } from './dream-evidence.js';
import { contentToText, isMemoryToolName, looksPasted, toolCallIdOf } from './dream-session-text.js';
import { scanSecrets } from './secrets.js';

const MAX_QUOTE = 500;
/** Shorter quotes match too easily to count as a check; CJK text is denser. */
const MIN_QUOTE_CHARS = 8;
const MIN_CJK_QUOTE_CHARS = 4;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MAX_CITATIONS = 20;
/** When no seq is given, the event with the strongest provenance wins. */
const ROLE_ORDER = ['user', 'user-pasted', 'assistant', 'tool-result', 'tool-call', 'tool'];

/** A note in a subagent's private store is named `agent:<preset>/<file>`. */
export const AGENT_NOTE_PREFIX = 'agent:';

const textOf = (value) => (typeof value === 'string' ? value : '');

function oneLine(value, max) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** True for plugin-injected prompt material, which is not independent evidence. */
export function isInjectedEvent(event) {
  const data = event?.data ?? event ?? {};
  const source = data?.message?.source ?? data?.source;
  const kind = source?.kind;
  return event?.type === 'system/message'
    || (typeof kind === 'string' && kind.startsWith('plugin:'))
    || ((event?.type === 'user/message' || (data.message ?? data).role === 'user')
      && kind !== undefined && kind !== 'user');
}

export function eventText(event) {
  const data = event?.data ?? event ?? {};
  const message = data.message ?? data;
  const text = contentToText(message?.content);
  // A tool call has no text, only arguments. Dream's work view shows them, so a quote from them must hold.
  if (text === '' && event?.type === 'tool/call' && data.arguments != null) {
    return typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments);
  }
  return text === '' && typeof data.snippet === 'string' ? data.snippet : text;
}

/**
 * Who said it: what the review panel shows beside a quoted event. A tool call is
 * the agent's own action (a claim); only a tool result is an observation.
 */
export function eventRole(event) {
  if (event?.type === 'user/message') return looksPasted(eventText(event)) ? 'user-pasted' : 'user';
  if (event?.type === 'assistant/message') return 'assistant';
  if (event?.type === 'tool/call') return 'tool-call';
  if (event?.type === 'tool/result') return 'tool-result';
  return 'tool';
}

/** Identify the producer of a tool event, including results that only name a call ID. */
function toolOrigin(event, events) {
  const data = event?.data ?? {};
  if (event?.type === 'tool/call') return textOf(data.name);
  if (event?.type !== 'tool/result') return '';
  const names = [data.name, data.toolName, data.message?.toolName];
  const memoryTool = names.find(isMemoryToolName);
  if (memoryTool) return memoryTool;
  const id = toolCallIdOf(event);
  if (id !== '') {
    for (const other of events.values()) {
      if (other?.type === 'tool/call' && toolCallIdOf(other) === id && other.data?.name) return textOf(other.data.name);
    }
  }
  return names.find((name) => typeof name === 'string' && name !== '') ?? '';
}

/**
 * Check one citation `{quote, session_id, seq?}` or `{quote, memory_file}`.
 * Existence and role only.
 *
 * @param {object} citation
 * @param {{session:(id:string)=>Map<number,object>|undefined|Promise<Map<number,object>|undefined>,
 *   note?:(file:string)=>string|Promise<string>, requireSeq?:boolean, requireToolOrigin?:(id:string)=>boolean}} source
 *   `session` returns the events of an allowed session by seq; `note` returns
 *   the text a note says now (omit it where notes are not citable).
 * @returns {Promise<{evidence?:object, problem?:string}>}
 */
export async function checkCitation(citation, { session, note, requireSeq = false, requireToolOrigin }) {
  const quote = oneLine(textOf(citation?.quote), MAX_QUOTE);
  const wanted = normalizeForMatch(quote);
  if (scanSecrets(quote).matches.length > 0) return { problem: 'the quote contains a sensitive passage' };
  const minimum = CJK.test(quote) ? MIN_CJK_QUOTE_CHARS : MIN_QUOTE_CHARS;
  if (quote.length < minimum || wanted === '') return { problem: `the quote is too short to identify anything (at least ${minimum} characters)` };
  const memoryFile = textOf(citation?.memory_file ?? citation?.memoryFile);
  if (memoryFile !== '') {
    if (!note) return { problem: 'a citation can only quote the conversation' };
    if (!normalizeForMatch(await note(memoryFile)).includes(wanted)) return { problem: `${memoryFile} does not contain the quote` };
    // A subagent's note is that subagent's claim: the quote exists, but nobody confirmed it.
    if (memoryFile.startsWith(AGENT_NOTE_PREFIX)) return { evidence: { memoryFile, quote, source: 'agent-memory', role: 'subagent', verified: true } };
    return { evidence: { memoryFile, quote, source: 'memory', verified: true } };
  }
  const sessionId = textOf(citation?.session_id ?? citation?.sessionId);
  const given = citation?.seq !== undefined && citation?.seq !== null && citation?.seq !== '';
  const seq = typeof citation?.seq === 'string' && /^\d+$/u.test(citation.seq) ? Number(citation.seq) : citation?.seq;
  if (!sessionId || ((given || requireSeq) && (!Number.isSafeInteger(seq) || seq < 0))) {
    return { problem: requireSeq ? 'a citation needs session_id and seq, or memory_file' : 'seq must be an integer when given' };
  }
  const events = await session(sessionId);
  if (!events) return { problem: `session ${sessionId} was not offered` };
  const hold = (event) => ({ evidence: { sessionId, seq: event.seq, quote, source: 'citation', verified: true, eventType: event.type, role: eventRole(event),
    ...(Number.isSafeInteger(event.time) ? { eventTime: event.time } : {}) } });
  if (given || requireSeq) {
    const event = events.get(seq);
    if (!event) return { problem: `session ${sessionId} has no event ${seq}` };
    if (isInjectedEvent(event)) return { problem: `event ${seq} of ${sessionId} is host-injected context, not something said in the session` };
    const tool = toolOrigin(event, events);
    if (isMemoryToolName(tool)) return { problem: `event ${seq} of ${sessionId} is a memory tool call or result: memory text cannot be cited as evidence` };
    if (event.type === 'tool/result' && tool === '' && requireToolOrigin?.(sessionId)) {
      return { problem: `event ${seq} of ${sessionId} is a tool result, but Dream could not identify its call. Read more context around the result.` };
    }
    if (!normalizeForMatch(eventText(event)).includes(wanted)) return { problem: `the quote is not in event ${seq} of ${sessionId}` };
    return hold(event);
  }
  let best = null;
  for (const event of events.values()) {
    if (isInjectedEvent(event) || !normalizeForMatch(eventText(event)).includes(wanted) || isMemoryToolName(toolOrigin(event, events))) continue;
    if (best === null || ROLE_ORDER.indexOf(eventRole(event)) < ROLE_ORDER.indexOf(eventRole(best))) best = event;
  }
  return best ? hold(best) : { problem: `the quote is not in any event of session ${sessionId}` };
}

/** Every citation of one change: those that hold, and why the others do not. */
export async function checkCitations(raw, source) {
  const evidence = [];
  const problems = [];
  for (const citation of (Array.isArray(raw) ? raw : []).slice(0, MAX_CITATIONS)) {
    const result = await checkCitation(citation, source);
    if (result.evidence) evidence.push(result.evidence);
    else problems.push(result.problem);
  }
  return { evidence, problems };
}

/**
 * Citations of a main-session write: the quote must be in the calling session.
 * The model supplies only `{quote, seq?}`; the session is never its choice.
 * @param {{ctx?:object, sessionId?:string, citations?:unknown}} input
 * @returns {Promise<{evidence:object[], problems:string[]}>}
 */
export async function checkSessionCitations({ ctx, sessionId, citations }) {
  if (!Array.isArray(citations) || citations.length === 0) return { evidence: [], problems: [] };
  const own = (citation) => ({ quote: citation?.quote, seq: citation?.seq, session_id: sessionId });
  const sessionQuery = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
  let events;
  let failure = '';
  if (!sessionId) failure = 'no session id: the host cannot check a quote';
  else if (typeof sessionQuery?.readSession !== 'function') failure = 'session transcript unavailable: the host cannot check a quote';
  else {
    try {
      const snapshot = await sessionQuery.readSession(sessionId);
      events = new Map((Array.isArray(snapshot?.events) ? snapshot.events : [])
        .filter((event) => Number.isSafeInteger(event?.seq)).map((event) => [event.seq, event]));
    } catch (error) {
      failure = `session ${sessionId} could not be read: ${error?.message ?? error}`;
    }
  }
  if (failure !== '') return { evidence: [], problems: citations.slice(0, MAX_CITATIONS).map(() => failure) };
  return checkCitations(citations.map(own), { session: () => events });
}
