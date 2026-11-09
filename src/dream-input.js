/**
 * Dream input gathering.
 *
 * Builds the bounded snapshot handed to the consolidation model: the current
 * project memory (index + topic file bodies) and the unread part of the mainline
 * sessions that touched this workspace. Every read failure degrades to an entry
 * in `errors` instead of aborting the pass.
 *
 * Gathering is a pure read. It never touches project state, so a dry run leaves
 * no trace; what was read travels in `reads` and is written only when a plan is
 * applied.
 *
 * Memory files: a body longer than `dreamMaxFileChars` is only shown as
 * head+tail and reported in `truncatedFiles`, so validation can refuse a write
 * to it (a partial view must never become a full rewrite).
 *
 * Sessions are never sampled. A session that fits `dreamMaxSessionChars` is
 * passed whole. A longer one is returned as ordered chunks for the analysis pass
 * (`dream-map.js`), which reads as many as the budget allows and reports how far
 * it got; the rest stays unread for a later pass. A session that does not fit the
 * remaining budget is deferred whole.
 *
 * Delegated sessions (subagents/teammates) are never part of the dream input:
 * their transcripts carry task-dispatch wording, not user preferences.
 */
import { buildSessionTranscript, chunkTranscript, extractSessionText, isProbeSession } from './dream-session-text.js';

const DEFAULT_MAX_CHARS = 96_000;
const DEFAULT_FILE_CHARS = 20_000;
const DEFAULT_SESSION_CHARS = 12_000;
const DEFAULT_LOOKBACK = 8;
const DEFAULT_CHUNK_CHARS = 24_000;
const DEFAULT_TOOL_CHARS = 4_000;
/** Memory may use at most this share of the input, so sessions always get room. */
const MEMORY_SHARE = 0.7;
const TRUNCATION_MARKER = '\n...[truncated]...\n';

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function errorMessage(error) {
  return error && typeof error === 'object' && error.message ? String(error.message) : String(error);
}

/**
 * Cut a text to `maxChars` keeping a head and a tail slice with a marker in the
 * middle. Total length never exceeds `maxChars`.
 */
function headTail(text, maxChars, headRatio = 0.5) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= maxChars) return { text: value, truncated: false };
  if (maxChars <= 0) return { text: '', truncated: value.length > 0 };
  if (maxChars <= TRUNCATION_MARKER.length) return { text: value.slice(0, maxChars), truncated: true };
  const room = maxChars - TRUNCATION_MARKER.length;
  const ratio = Number.isFinite(headRatio) ? Math.min(1, Math.max(0, headRatio)) : 0.5;
  const headLength = Math.floor(room * ratio);
  const tailLength = room - headLength;
  const head = value.slice(0, headLength);
  const tail = tailLength > 0 ? value.slice(value.length - tailLength) : '';
  return { text: `${head}${TRUNCATION_MARKER}${tail}`, truncated: true };
}

/** A delegated child session (teammate/subagent) is not a user conversation. */
function isDelegatedHeader(header) {
  if (!header || typeof header !== 'object') return false;
  if (header.parentSession) return true;
  return header.origin === 'subagent';
}

function readSessionIdsFromState(state) {
  const ids = [];
  try {
    const snapshot = typeof state?.snapshot === 'function' ? state.snapshot() : undefined;
    const sessions = Array.isArray(snapshot?.sessionsSince) ? snapshot.sessionsSince : [];
    for (const entry of sessions) {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id);
    }
  } catch {
    // A broken state is not fatal: sessionQuery may still supply history.
  }
  return ids;
}

/** Watermarks by session id: `seq` read so far, `partial` when more remains. */
function readWatermarks(state) {
  const marks = new Map();
  try {
    const snapshot = typeof state?.snapshot === 'function' ? state.snapshot() : undefined;
    const entries = Array.isArray(snapshot?.dreamProcessedSessions) ? snapshot.dreamProcessedSessions : [];
    for (const entry of entries) {
      if (typeof entry === 'string') {
        marks.set(entry, { seq: 0, partial: false });
        continue;
      }
      const id = entry?.id;
      if (typeof id === 'string' && id !== '') {
        marks.set(id, { seq: Math.max(0, Math.trunc(Number(entry.seq) || 0)), partial: entry.partial === true });
      }
    }
  } catch {
    // A broken state is not fatal: the corpus fallback still applies.
  }
  return marks;
}

function createdAtOf(record) {
  const value = record?.header?.createdAt ?? record?.createdAt;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Drop probe-only sessions from `sessionsSince` before the minSessions gate.
 * Dream input gathering runs after the gate, so without this pre-pass a few
 * `Reply with exactly: OK` sessions can trigger an auto dream with no real
 * conversation to mine. Best effort: unreadable sessions stay eligible.
 * @returns {Promise<number>} number of sessions dropped.
 */
export async function pruneProbeSessions({ ctx, state } = {}) {
  const sessionQuery = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function' || !state || typeof state.snapshot !== 'function') {
    return 0;
  }
  let entries = [];
  try {
    const snapshot = state.snapshot();
    entries = Array.isArray(snapshot?.sessionsSince) ? snapshot.sessionsSince : [];
  } catch {
    return 0;
  }
  const ids = [];
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return 0;
  const probes = [];
  for (const id of ids) {
    try {
      const snapshot = await sessionQuery.readSession(id);
      const extracted = extractSessionText(snapshot?.events, { maxToolChars: 0 });
      if (extracted.userChars === 0 || isProbeSession(extracted.userMessages)) probes.push(id);
    } catch {
      // A session that cannot be read is kept: better one extra dream than
      // silently forgetting a real conversation.
    }
  }
  if (probes.length > 0) {
    try {
      await state.dropSessions?.(probes);
    } catch {
      // Best effort: the gate still runs; at worst the next pass retries.
    }
  }
  return probes.length;
}

/**
 * Gather the dream input. Pure read: never writes project state.
 * @param {{ctx?:object, store?:object, config?:object, workspaceDir?:string, state?:object, noSessions?:boolean}} params
 * @returns {Promise<{
 *   memory: {index:string, files:Array<{file:string,type:string,modified?:unknown,description:string,body:string,chars:number,truncated:boolean}>},
 *   sessions: Array<{id:string,at:number|null,lastAt:number,excerpt:string,chunks?:Array<{text:string,lastSeq:number}>,baseSeq:number,chars:number,truncated:boolean}>,
 *   reads: Array<{id:string,seq:number,complete:boolean}>,
 *   droppedSessions: string[],
 *   chars: number,
 *   truncated: boolean,
 *   truncatedFiles: string[],
 *   skippedSessions: string[],
 *   errors: string[],
 * }>}
 */
export async function gatherDreamInput({ ctx, store, config, workspaceDir, state, noSessions = false } = {}) {
  const maxChars = positiveInt(config?.dreamInputMaxChars, DEFAULT_MAX_CHARS, 1_000_000);
  const fileMaxChars = positiveInt(config?.dreamMaxFileChars, DEFAULT_FILE_CHARS, 500_000);
  const sessionMaxChars = positiveInt(config?.dreamMaxSessionChars, DEFAULT_SESSION_CHARS, 100_000);
  const chunkChars = positiveInt(config?.dreamMapChunkChars, DEFAULT_CHUNK_CHARS, 500_000);
  const toolChars = Number.isFinite(Number(config?.dreamMaxToolChars)) ? Math.max(0, Number(config.dreamMaxToolChars)) : DEFAULT_TOOL_CHARS;
  const lookback = positiveInt(config?.sessionLookback, DEFAULT_LOOKBACK, 100);
  const errors = [];
  const truncatedFiles = [];
  const skippedSessions = [];
  const droppedSessions = [];
  const reads = [];
  let truncated = false;

  const memory = { index: '', files: [] };
  let memoryChars = 0;

  // 1. Index first: it is the cheapest, highest-signal memory surface.
  if (store && typeof store.indexText === 'function') {
    try {
      memory.index = String((await store.indexText('project')) ?? '');
      memoryChars += memory.index.length;
    } catch (error) {
      errors.push(`memory index: ${errorMessage(error)}`);
    }
  }

  // 2. Topic files: metadata always, body bounded per file and by the total
  //    budget. A truncated body is recorded so the plan cannot rewrite it.
  let entries = [];
  if (store && typeof store.listEntries === 'function') {
    try {
      const listed = await store.listEntries('project');
      if (Array.isArray(listed)) entries = listed;
    } catch (error) {
      errors.push(`memory file list: ${errorMessage(error)}`);
    }
  }
  const fileBudgetCap = Math.floor(maxChars * MEMORY_SHARE);
  for (const entry of entries) {
    const file = typeof entry?.file === 'string' ? entry.file : '';
    if (!file) continue;
    const meta = {
      file,
      name: entry.name,
      type: typeof entry?.type === 'string' ? entry.type : 'user',
      modified: entry?.modified,
      description: typeof entry?.description === 'string' ? entry.description : '',
      body: '',
      chars: 0,
      truncated: false,
    };
    if (store && typeof store.readEntry === 'function') {
      try {
        const read = await store.readEntry(file, 'project');
        if (read && typeof read === 'object') {
          meta.name = read.frontmatter?.name ?? meta.name;
          meta.type = typeof read.frontmatter?.type === 'string' ? read.frontmatter.type : meta.type;
          meta.modified = read.frontmatter?.modified ?? meta.modified;
          meta.description = typeof read.frontmatter?.description === 'string'
            ? read.frontmatter.description
            : meta.description;
          const body = typeof read.body === 'string' ? read.body : '';
          meta.chars = body.length;
          const remaining = Math.max(0, fileBudgetCap - memoryChars);
          const allowance = Math.min(fileMaxChars, remaining);
          const result = headTail(body, allowance, 0.5);
          meta.body = result.text;
          meta.truncated = result.truncated;
          memoryChars += result.text.length;
          if (result.truncated) {
            truncated = true;
            if (!truncatedFiles.includes(file)) truncatedFiles.push(file);
          }
        }
      } catch (error) {
        errors.push(`memory ${file}: ${errorMessage(error)}`);
      }
    }
    memory.files.push(meta);
  }

  // Evaluation mode: pure consolidation of the existing memory only. Never
  // mine transcripts, so the result cannot be attributed to session gathering.
  if (noSessions === true) {
    return {
      memory,
      sessions: [],
      reads,
      droppedSessions,
      chars: memoryChars,
      truncated,
      truncatedFiles,
      skippedSessions,
      errors,
    };
  }

  // 3. Session candidates: state-recorded sessions first, then (only when more
  //    are needed) the session corpus filtered by the workspace cwd. Delegated
  //    child sessions are excluded from both sources.
  const sessionQuery = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
  const activeSessionIds = new Set(readSessionIdsFromState(state));
  const watermarks = readWatermarks(state);
  const queue = [...activeSessionIds];
  const tried = new Set();
  const createdAt = new Map();
  let recordsLoaded = false;
  const canRead = Boolean(sessionQuery && typeof sessionQuery.readSession === 'function');
  const loadRecords = async () => {
    if (!sessionQuery || typeof sessionQuery.filterSessions !== 'function' || !workspaceDir) return false;
    try {
      const records = await sessionQuery.filterSessions([{ kind: 'cwd', values: [workspaceDir] }]);
      if (!Array.isArray(records)) return false;
      for (const record of records) {
        const header = record?.header;
        const id = header?.id;
        if (typeof id !== 'string' || id === '') continue;
        if (isDelegatedHeader(header)) {
          if (!skippedSessions.includes(id)) skippedSessions.push(id);
          continue;
        }
        // Fully read by an earlier dream and not active again: skip it. A session
        // read only in part stays eligible until its end has been reached.
        const mark = watermarks.get(id);
        if (mark && !mark.partial && !activeSessionIds.has(id)) {
          if (!skippedSessions.includes(id)) skippedSessions.push(id);
          continue;
        }
        createdAt.set(id, createdAtOf(record));
        if (!tried.has(id) && !queue.includes(id)) queue.push(id);
      }
      return true;
    } catch (error) {
      errors.push(`session list: ${errorMessage(error)}`);
      return false;
    }
  };

  const sessions = [];
  let sessionsChars = 0;
  const sessionBudget = Math.max(0, maxChars - memoryChars);
  if (!canRead && queue.length > 0) {
    errors.push('sessionQuery.readSession unavailable; session transcripts skipped');
  }
  if (canRead) {
    while (sessions.length < lookback) {
      if (queue.length === 0) {
        if (recordsLoaded) break;
        recordsLoaded = true;
        await loadRecords();
        if (queue.length === 0) break;
        continue;
      }
      const id = queue.shift();
      if (typeof id !== 'string' || id === '' || tried.has(id)) continue;
      tried.add(id);
      let snapshot;
      try {
        snapshot = await sessionQuery.readSession(id);
      } catch (error) {
        errors.push(`session ${id}: ${errorMessage(error)}`);
        continue;
      }
      // `readSession()` returns `{session: header}` on the real host; some
      // fixtures/runtimes expose the header as `header` instead. Check both.
      const candidates = [snapshot?.session, snapshot?.header].filter(
        (value) => value && typeof value === 'object',
      );
      if (candidates.some((header) => isDelegatedHeader(header))) {
        if (!skippedSessions.includes(id)) skippedSessions.push(id);
        continue;
      }
      const header = candidates[0] ?? {};
      const hasEvents = Array.isArray(snapshot?.events);
      if (!hasEvents) {
        errors.push(`session ${id}: readSession returned no events`);
        if (!skippedSessions.includes(id)) skippedSessions.push(id);
        continue;
      }
      const baseSeq = watermarks.get(id)?.seq ?? 0;
      const transcript = buildSessionTranscript(
        snapshot.events.filter((event) => baseSeq <= 0 || Number(event?.seq || 0) > baseSeq),
      );
      // A first read with no human turn is a probe or an empty run. A resumed
      // session may legitimately continue without new user text.
      if (baseSeq <= 0 && (transcript.userChars === 0 || isProbeSession(transcript.userMessages))) {
        if (!skippedSessions.includes(id)) skippedSessions.push(id);
        if (activeSessionIds.has(id)) droppedSessions.push(id);
        continue;
      }
      if (transcript.blocks.length === 0) continue;
      const at = Number.isFinite(header.createdAt) ? header.createdAt : (createdAt.get(id) ?? null);
      const [whole] = chunkTranscript(transcript, { chunkChars: Infinity, toolCharsPerChunk: toolChars });
      if (whole.text.length > sessionMaxChars) {
        sessions.push({
          id,
          at,
          lastAt: transcript.lastAt,
          excerpt: '',
          chunks: chunkTranscript(transcript, { chunkChars, toolCharsPerChunk: toolChars }),
          baseSeq,
          chars: whole.text.length,
          truncated: false,
        });
        continue;
      }
      if (sessionsChars + whole.text.length > sessionBudget) {
        truncated = true;
        continue;
      }
      sessions.push({
        id,
        at,
        lastAt: transcript.lastAt,
        excerpt: whole.text,
        evidenceBlocks: whole.evidenceBlocks,
        baseSeq,
        chars: whole.text.length,
        truncated: false,
      });
      reads.push({ id, seq: transcript.maxSeq, complete: true });
      sessionsChars += whole.text.length;
    }
  }

  return {
    memory,
    sessions,
    reads,
    droppedSessions,
    chars: memoryChars + sessionsChars,
    truncated,
    truncatedFiles,
    skippedSessions,
    errors,
  };
}
