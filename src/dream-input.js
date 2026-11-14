/**
 * Dream input gathering.
 *
 * Builds the bounded snapshot handed to the consolidation model: the unread part
 * of the mainline sessions that touched this workspace. Memory pages are read
 * once, in full, by `memoryPagesOf()` in `src/dream-pipeline.js`. Every read
 * failure degrades to an entry in `errors` instead of aborting the pass.
 *
 * Gathering is a pure read. It never touches project state, so a dry run leaves
 * no trace; what was read travels in `reads` and is written only when a plan is
 * applied.
 *
 * Sessions are never sampled: every candidate session is returned as ordered
 * chunks sized by the caller. One total budget (`dreamInputMaxChars`) bounds a
 * run; a session past it is deferred whole to the next run.
 *
 * Delegated sessions (subagents/teammates) are never part of the dream input:
 * their transcripts carry task-dispatch wording, not user preferences.
 */
import { buildSessionTranscript, chunkTranscript, isProbeSession } from './dream-session-text.js';
import { isDelegated } from './session-kind.js';

const DEFAULT_MAX_CHARS = 96_000;
const DEFAULT_CHUNK_CHARS = 24_000;
const DEFAULT_TOOL_CHARS = 4_000;

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function errorMessage(error) {
  return error && typeof error === 'object' && error.message ? String(error.message) : String(error);
}

function readSessionIdsFromState(state) {
  const ids = [];
  try {
    const snapshot = state?.snapshot();
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
    const snapshot = state?.snapshot();
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
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function' || !state) {
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
      const extracted = buildSessionTranscript(snapshot?.events);
      if (extracted.userChars === 0 || isProbeSession(extracted.userMessages)) probes.push(id);
    } catch {
      // A session that cannot be read is kept: better one extra dream than
      // silently forgetting a real conversation.
    }
  }
  if (probes.length > 0) {
    try {
      await state.dropSessions(probes);
    } catch {
      // Best effort: the gate still runs; at worst the next pass retries.
    }
  }
  return probes.length;
}

/**
 * Gather the dream input. Pure read: never writes project state.
 * @param {{ctx?:object, config?:object, workspaceDir?:string, state?:object, noSessions?:boolean, unitChars?:number}} params
 * @returns {Promise<{
 *   sessions: Array<{id:string,at:number|null,lastAt:number,chunks:Array<{text:string,firstSeq:number|null,lastSeq:number|null}>,baseSeq:number,maxSeq:number,chars:number}>,
 *   droppedSessions: string[],
 *   deferredSessions: string[],
 *   chars: number,
 *   truncated: boolean,
 *   skippedSessions: string[],
 *   errors: string[],
 * }>}
 */
export async function gatherDreamInput({
  ctx,
  config,
  workspaceDir,
  state,
  noSessions = false,
  // Transport unit size; each session is split into chunks of at most this many characters.
  unitChars = 0,
} = {}) {
  const maxChars = positiveInt(config?.dreamInputMaxChars, DEFAULT_MAX_CHARS, 1_000_000);
  const chunkChars = positiveInt(config?.dreamMapChunkChars, DEFAULT_CHUNK_CHARS, 500_000);
  const toolChars = Number.isFinite(Number(config?.dreamMaxToolChars)) ? Math.max(0, Number(config.dreamMaxToolChars)) : DEFAULT_TOOL_CHARS;
  const errors = [];
  const skippedSessions = [];
  const droppedSessions = [];
  const deferredSessions = [];
  let truncated = false;

  // Evaluation mode: pure consolidation of the existing memory only. Never
  // mine transcripts, so the result cannot be attributed to session gathering.
  if (noSessions === true) {
    return {
      sessions: [],
      droppedSessions,
      deferredSessions,
      chars: 0,
      truncated,
      skippedSessions,
      errors,
    };
  }

  // 1. Session candidates: state-recorded sessions first, then (only when more
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
        if (isDelegated(record)) {
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
  if (!canRead && queue.length > 0) {
    errors.push('sessionQuery.readSession unavailable; session transcripts skipped');
  }
  if (canRead) {
    for (;;) {
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
      if (candidates.some(isDelegated)) {
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
      // One total byte budget: nobody should be able to make a single run read the whole corpus.
      if (sessionsChars + whole.text.length > maxChars) {
        truncated = true;
        deferredSessions.push(id);
        continue;
      }
      sessions.push({
        id,
        at,
        lastAt: transcript.lastAt,
        chunks: chunkTranscript(transcript, {
          chunkChars: positiveInt(unitChars, chunkChars, 500_000),
          toolCharsPerChunk: toolChars,
        }),
        baseSeq,
        maxSeq: transcript.maxSeq,
        chars: whole.text.length,
      });
      sessionsChars += whole.text.length;
    }
  }

  return {
    sessions,
    droppedSessions,
    deferredSessions,
    chars: sessionsChars,
    truncated,
    skippedSessions,
    errors,
  };
}
