/**
 * Cross-session lookup for the Dream child: a thin wrapper over the host's
 * `ctx.sessionQuery` (ranked full-text search plus exact event reads).
 *
 * The host knows nothing of this plugin's exclusions, so every result is cut
 * down to the sessions Dream may use (`allowed`: same project, not learn-off,
 * not git-ignored, not delegated) and host-injected events never appear. The
 * wrapper only searches and reads; what a pattern across sessions means is the
 * model's call. Events shown by `readEvent` are handed to `remember`, which is
 * what makes a quote from them citable.
 */
import { isInjectedEvent } from './citation.js';
import { buildSessionTranscript, renderTranscriptPage } from './dream-session-text.js';
import { scanSecrets } from './secrets.js';
import { memoryHash } from './write-review.js';

const SESSION_HITS = 10;
const EVENT_HITS = 20;
const SNIPPET_CHARS = 300;
const TITLE_CHARS = 80;
const QUERY_CHARS = 240;
const WINDOW_DEFAULT = { before: 2, after: 4 };
const WINDOW_MAX = 20;
const DAY_MS = 86_400_000;

const isDate = (value) => Number.isFinite(value);
function iso(time) {
  const stamp = Number(time);
  const date = new Date(stamp);
  return stamp > 0 && isDate(date.getTime()) ? date.toISOString().slice(0, 10) : 'unknown date';
}

function oneLine(value, max) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A snippet the child may see: one short line, or a note that it was left out. */
function snippetOf(value) {
  const text = oneLine(value, SNIPPET_CHARS);
  return scanSecrets(text).matches.length > 0 ? '[sensitive passage omitted]' : text;
}

/** Latest host title per session id; sessions without one are simply absent. */
export async function sessionTitles(sessionQuery, ids) {
  const titles = new Map();
  if (typeof sessionQuery?.readTitleSnapshots !== 'function' || ids.length === 0) return titles;
  try {
    const results = await sessionQuery.readTitleSnapshots(ids);
    results.forEach((result, index) => {
      const title = result?.status === 'fulfilled' ? result.value?.title?.title : undefined;
      if (typeof title === 'string' && ids[index]) titles.set(ids[index], title);
    });
  } catch {
    /* untitled rows fall back to the first message */
  }
  return titles;
}

/** Search needs a backend; exact reads alone are not enough to offer the tools. */
export function searchAvailable(sessionQuery) {
  return ['searchSessions', 'searchEvents', 'readEvent'].every((name) => typeof sessionQuery?.[name] === 'function');
}

/** `2026-11-20` or a full timestamp. A bare `until` date covers that whole day. */
function parseTime(value, endOfDay) {
  if (value === undefined || value === null || value === '') return { time: undefined };
  const text = String(value).trim();
  const time = Date.parse(text);
  if (!isDate(time)) return { error: `${text} is not a date; use YYYY-MM-DD or an ISO timestamp` };
  return { time: endOfDay && /^\d{4}-\d{2}-\d{2}$/u.test(text) ? time + DAY_MS - 1 : time };
}

const integerOf = (value) => (typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) ? Number(value) : value);

/**
 * @param {{sessionQuery:object, allowed:()=>Promise<Set<string>>, offered:Set<string>,
 *   remember:(sessionId:string, events:object[])=>void, signal?:AbortSignal}} options
 * @returns {{searchSessions:Function, searchEvents:Function, readEvent:Function, eventDelivered:Function}}
 */
export function createDreamSearch({ sessionQuery, allowed, offered, remember, signal }) {
  const pendingReads = new Map();
  const readKey = ({ session_id, seq, before, after }) => JSON.stringify([session_id, seq, before, after]);
  function eventDelivered(args, text) {
    const key = readKey(args);
    const page = pendingReads.get(key);
    pendingReads.delete(key);
    if (page && typeof text === 'string' && memoryHash(text) === page.hash) remember(args.session_id, page.events);
  }
  const eventOf = async (sessionId, seq) => {
    try {
      const target = (await sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 }))?.target;
      return target?.seq === seq ? target : null;
    } catch {
      return null;
    }
  };
  /** Hits that are real session events, not host-injected context. */
  const realHits = async (sessionId, hits) => {
    const checked = await Promise.all(hits.map(async (hit) => {
      if (!Number.isSafeInteger(hit?.seq) || hit.seq < 0) return null;
      const target = await eventOf(sessionId, hit.seq);
      return target && !isInjectedEvent(target) ? hit : null;
    }));
    return checked.filter(Boolean);
  };
  const shape = (hit) => ({ seq: hit.seq, type: hit.type, date: iso(hit.time), snippet: snippetOf(hit.snippet) });

  async function searchSessions(args) {
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, QUERY_CHARS) : '';
    if (query === '') return 'ERROR: query is required';
    const since = parseTime(args.since, false);
    const until = parseTime(args.until, true);
    if (since.error || until.error) return `ERROR: ${since.error ?? until.error}`;
    const ids = await allowed();
    if (ids.size === 0) return JSON.stringify({ items: [] });
    const page = await sessionQuery.searchSessions({
      query,
      sessionFilters: [
        { kind: 'id', values: [...ids] },
        ...(since.time !== undefined || until.time !== undefined
          ? [{ kind: 'created-at', ...(since.time !== undefined ? { from: since.time } : {}), ...(until.time !== undefined ? { to: until.time } : {}) }] : []),
      ],
      limit: SESSION_HITS,
    }, { signal });
    const hits = (Array.isArray(page?.items) ? page.items : []).filter((hit) => ids.has(hit?.header?.id));
    const titles = await sessionTitles(sessionQuery, hits.map((hit) => hit.header.id));
    const items = [];
    for (const hit of hits) {
      const sessionId = hit.header.id;
      // The best match may be injected context; look for a real one in the session.
      let [match] = await realHits(sessionId, [hit.bestMatch]);
      if (!match) {
        const more = await sessionQuery.searchEvents({ sessionId, query, limit: 5 }, { signal }).catch(() => null);
        [match] = await realHits(sessionId, Array.isArray(more?.items) ? more.items : []);
      }
      if (!match) continue;
      items.push({
        ...shape(match),
        session_id: sessionId,
        date: iso(hit.header.createdAt),
        ...(titles.has(sessionId) ? { title: oneLine(titles.get(sessionId), TITLE_CHARS) } : {}),
        offered: offered.has(sessionId),
      });

    }
    return JSON.stringify({ items });
  }

  async function searchEvents(args) {
    const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, QUERY_CHARS) : '';
    if (sessionId === '' || query === '') return 'ERROR: session_id and query are required';
    if (!(await allowed()).has(sessionId)) return 'ERROR: session_id is not a session of this project that Dream may use';
    const page = await sessionQuery.searchEvents({ sessionId, query, limit: EVENT_HITS }, { signal });
    const hits = await realHits(sessionId, Array.isArray(page?.items) ? page.items : []);
    return JSON.stringify({ session_id: sessionId, items: hits.map(shape), more: Boolean(page?.nextCursor) });
  }

  async function readEvent(args) {
    const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
    const seq = integerOf(args.seq);
    const span = (value, fallback) => {
      const number = integerOf(value ?? fallback);
      return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, WINDOW_MAX) : null;
    };
    const before = span(args.before, WINDOW_DEFAULT.before);
    const after = span(args.after, WINDOW_DEFAULT.after);
    if (sessionId === '' || !Number.isSafeInteger(seq) || seq < 0 || before === null || after === null) {
      return 'ERROR: session_id and a non-negative integer seq are required; before and after are non-negative integers';
    }
    if (!(await allowed()).has(sessionId)) return 'ERROR: session_id is not a session of this project that Dream may use';
    let found;
    try {
      found = await sessionQuery.readEvent({ sessionId, seq, before, after });
    } catch (error) {
      return `ERROR: ${error?.message ?? error}`;
    }
    if (found?.target?.seq !== seq) return 'ERROR: that event could not be read';
    if (isInjectedEvent(found.target)) return 'ERROR: that event is host-injected context, not something said in the session';
    const events = (Array.isArray(found.events) ? found.events : []).filter((event) => Number.isSafeInteger(event?.seq) && !isInjectedEvent(event));
    const transcript = buildSessionTranscript(events, { work: true });
    const page = renderTranscriptPage(transcript, { limit: 100 });
    const shown = new Set(transcript.blocks.filter(({ seq }) => seq <= page.lastSeq).map(({ seq }) => seq));
    const text = JSON.stringify({ session_id: sessionId, seq, from_seq: found.startSeq, to_seq: found.endSeq, offered: offered.has(sessionId), shown_messages: page.count, truncated: page.nextFromSeq !== null })
      + '\n' + page.text;
    pendingReads.set(readKey(args), { hash: memoryHash(text), events: events.filter(({ seq }) => shown.has(seq)) });
    return text;
  }

  return { searchSessions, searchEvents, readEvent, eventDelivered };
}
