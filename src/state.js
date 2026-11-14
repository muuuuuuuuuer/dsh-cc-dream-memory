/**
 * Durable per-project dream state.
 *
 * A single JSON file beside the memory directory tracks dream cadence, the
 * sessions touched since the last dream, and the last outcome. Writes are
 * serialized and atomic (temp file + rename) so a crash cannot leave a torn
 * state file.
 *
 * v6: state is shared by every Host process pointed at the same project, so
 * each mutation re-reads the file under a cross-process lock and merges into
 * the fresh copy instead of overwriting it with a stale in-memory snapshot.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;
const MAX_SESSIONS = 200;
const LOCK_TTL_MS = 10_000;
const LOCK_RETRY_MS = 15;
const LOCK_MAX_WAIT_MS = 3_000;
/** Token usage fields a dream cost record may carry (from `llm.stream` usage chunks). */
const USAGE_KEYS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
]);

function emptyState() {
  return {
    version: STATE_VERSION,
    lastDreamAt: 0,
    lastDreamAttemptAt: 0,
    lastScanAt: 0,
    lastDreamSessions: 0,
    lastDreamOps: 0,
    lastDreamFiles: 0,
    lastDreamSummary: '',
    lastError: '',
    sessionsSince: [],
    // v0.10.8: sessions already consumed by a successful dream; the corpus
    // fallback must not re-read them unless they became active again.
    dreamProcessedSessions: [],
    counters: { dreams: 0, skipped: 0, failures: 0 },
    // The pending memory copy a finished dream produced. `null` means no
    // switch is waiting; the human either switches to the copy or discards it.
    shadowPending: null,
    lastDreamMode: '',
    consecutiveFailures: 0,
    // v7: duration / cost of the last completed dream (0/null on old files).
    lastDreamDurationMs: 0,
    lastDreamInputChars: 0,
    lastDreamOutputChars: 0,
    lastDreamUsage: null,
    // v8: the last dream's usage exceeded `dreamMaxTotalTokens`.
    lastDreamCostExceeded: false,
    // v21: last automatic extraction outcome, so the UI can explain why the
    // Inbox is empty without asking the user to read host logs.
    lastExtractAt: 0,
    lastExtractAttemptAt: 0,
    lastExtractCount: 0,
    lastExtractReason: '',
    lastExtractError: '',
    lastExtractTrigger: '',
  };
}

/** Keep only known numeric token counters; arbitrary content is ignored. */
function normalizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  let seen = false;
  for (const key of USAGE_KEYS) {
    const n = Number(value[key]);
    if (Number.isFinite(n) && n >= 0) {
      usage[key] = n;
      seen = true;
    }
  }
  return seen ? usage : null;
}

function normalize(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const state = { ...base, ...raw };
  state.version = STATE_VERSION;
  state.sessionsSince = Array.isArray(raw.sessionsSince)
    ? raw.sessionsSince
        .filter((entry) => entry && typeof entry.id === 'string' && entry.id !== '')
        .slice(-MAX_SESSIONS)
        .map((entry) => ({ id: entry.id, at: Number(entry.at) || 0 }))
    : [];
  state.dreamProcessedSessions = Array.isArray(raw.dreamProcessedSessions)
    ? raw.dreamProcessedSessions
        .filter((entry) => entry && typeof entry.id === 'string' && entry.id !== '')
        .slice(-MAX_SESSIONS)
        .map((entry) => ({
          id: entry.id,
          at: Number(entry.at) || 0,
          seq: Math.max(0, Math.trunc(Number(entry.seq) || 0)),
          ...(entry.partial === true ? { partial: true } : {}),
        }))
    : [];
  state.counters = { ...base.counters, ...(raw.counters && typeof raw.counters === 'object' ? raw.counters : {}) };
  state.consecutiveFailures = Math.max(0, Math.trunc(Number(state.consecutiveFailures) || 0));
  for (const key of [
    'lastDreamAt',
    'lastDreamAttemptAt',
    'lastScanAt',
    'lastDreamSessions',
    'lastDreamOps',
    'lastDreamFiles',
    'lastDreamDurationMs',
    'lastDreamInputChars',
    'lastDreamOutputChars',
    'lastExtractAt',
    'lastExtractAttemptAt',
    'lastExtractCount',
  ]) {
    state[key] = Number(state[key]) || 0;
  }
  state.lastDreamUsage = normalizeUsage(raw.lastDreamUsage);
  state.lastDreamCostExceeded = state.lastDreamCostExceeded === true;
  for (const key of [
    'lastDreamSummary',
    'lastError',
    'lastDreamMode',
    'lastExtractReason',
    'lastExtractError',
    'lastExtractTrigger',
  ]) {
    state[key] = typeof state[key] === 'string' ? state[key] : '';
  }
  state.shadowPending = raw.shadowPending && typeof raw.shadowPending === 'object'
    && typeof raw.shadowPending.dir === 'string' && raw.shadowPending.dir !== ''
    ? { ...raw.shadowPending }
    : null;
  return state;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ProjectState {
  /** @param {{stateFile:string}} paths */
  constructor(paths) {
    this.paths = paths;
    this.stateFile = paths.stateFile;
    this.lockFile = `${paths.stateFile}.lock`;
    this.state = emptyState();
    this.loaded = false;
    this.saving = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this.state;
    this.loaded = true;
    try {
      const text = await fs.readFile(this.stateFile, 'utf8');
      this.state = normalize(JSON.parse(text));
    } catch {
      this.state = emptyState();
    }
    return this.state;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  /** Read the authoritative state from disk (used by mutations and callers). */
  async read() {
    try {
      const text = await fs.readFile(this.stateFile, 'utf8');
      this.state = normalize(JSON.parse(text));
    } catch {
      // Missing/unreadable file: keep the in-memory state (first writer wins).
    }
    this.loaded = true;
    return this.state;
  }

  async _writeState(state) {
    const payload = JSON.stringify(state, null, 2);
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, this.stateFile);
  }

  /**
   * Run `fn` while holding the state lock, with a freshly read state object.
   * Falls back to a lockless write if the lock cannot be acquired in time so a
   * stale lock can never wedge dreaming.
   */
  async _mutate(mutator) {
    await this.load();
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    let handle = null;
    while (handle === null && Date.now() < deadline) {
      try {
        handle = await fs.open(this.lockFile, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          try {
            const stat = await fs.stat(this.lockFile);
            if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
              await fs.unlink(this.lockFile);
              continue;
            }
          } catch {
            /* lock vanished: retry */
          }
          await sleep(LOCK_RETRY_MS);
          continue;
        }
        // Not a lock contention problem: mutate without the lock.
        break;
      }
    }
    try {
      const fresh = normalize(await this._readForMutation());
      mutator(fresh);
      await this._writeState(fresh);
      this.state = fresh;
      return fresh;
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          /* already closed */
        }
        try {
          await fs.unlink(this.lockFile);
        } catch {
          /* lock already removed by a TTL steal */
        }
      }
    }
  }

  async _readForMutation() {
    try {
      return JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** Write the current in-memory state (kept for callers that need an explicit flush). */
  async save() {
    const write = async () => {
      await this._mutate(() => {});
      return this.state;
    };
    this.saving = this.saving.then(write, write);
    return this.saving;
  }

  /** Record that a session produced a turn; distinct ids only. */
  async ensureSession(sessionId, at = Date.now()) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    await this._mutate((state) => {
      if (state.sessionsSince.some((entry) => entry.id === sessionId)) return;
      state.sessionsSince.push({ id: sessionId, at: Number(at) || Date.now() });
      if (state.sessionsSince.length > MAX_SESSIONS) {
        state.sessionsSince = state.sessionsSince.slice(-MAX_SESSIONS);
      }
    });
  }

  /** The most recent `count` session ids, newest last, without consuming them. */
  consumeSessions(count) {
    const n = Math.max(0, Math.trunc(Number(count) || 0));
    if (n === 0) return [];
    return this.state.sessionsSince.slice(-n).map((entry) => entry.id);
  }

  /** Forget sessions that are probes/empty without watermarking them. */
  async dropSessions(ids) {
    const drop = new Set((ids ?? []).filter((id) => typeof id === 'string'));
    if (drop.size === 0) return;
    await this._mutate((state) => {
      state.sessionsSince = state.sessionsSince.filter((entry) => !drop.has(entry.id));
    });
  }

  /**
   * Remove handled sessions after a successful dream and record how far each was
   * read. `reads` comes from the applied plan: `seq` is the last event read and
   * `complete:false` keeps the session eligible for the remainder. Without read
   * records no watermark moves, so nothing is skipped.
   */
  async clearSessions(ids, options = {}) {
    const drop = new Set((ids ?? []).filter((id) => typeof id === 'string'));
    const reads = Array.isArray(options.reads) ? options.reads : [];
    if (drop.size === 0 && reads.length === 0) return;
    await this._mutate((state) => {
      const processed = Array.isArray(state.dreamProcessedSessions) ? state.dreamProcessedSessions : [];
      for (const read of reads) {
        if (typeof read?.id !== 'string' || read.id === '') continue;
        const seq = Math.max(0, Math.trunc(Number(read.seq) || 0));
        const partial = read.complete !== true;
        const existing = processed.find((item) => item.id === read.id);
        if (existing) {
          existing.seq = Math.max(Number(existing.seq) || 0, seq);
          existing.at = Date.now();
          if (partial) existing.partial = true;
          else delete existing.partial;
        } else {
          processed.push({ id: read.id, at: Date.now(), seq, ...(partial ? { partial: true } : {}) });
        }
        drop.add(read.id);
      }
      state.dreamProcessedSessions = processed.slice(-MAX_SESSIONS);
      state.sessionsSince = state.sessionsSince.filter((entry) => !drop.has(entry.id));
    });
  }

  /** Undo restores session eligibility: remove processed watermarks from a batch. */
  async restoreDreamProcessed(ids) {
    const restore = new Set((ids ?? []).filter((id) => typeof id === 'string'));
    if (restore.size === 0) return;
    await this._mutate((state) => {
      state.dreamProcessedSessions = (Array.isArray(state.dreamProcessedSessions) ? state.dreamProcessedSessions : [])
        .filter((entry) => !restore.has(entry.id));
    });
  }

  /** A successful dry-run is not a failure; drop a stale error from an earlier attempt. */
  async clearDreamError() {
    await this._mutate((state) => {
      state.lastError = '';
    });
  }

  async markDreamStart() {
    await this._mutate((state) => {
      state.lastDreamAttemptAt = Date.now();
    });
  }

  async markDreamDone({
    sessions = 0,
    ops = 0,
    files = 0,
    summary = '',
    mode = '',
    durationMs = 0,
    inputChars = 0,
    outputChars = 0,
    usage = null,
    costExceeded = false,
  } = {}) {
    await this._mutate((state) => {
      state.lastDreamAt = Date.now();
      state.lastDreamSessions = Number(sessions) || 0;
      state.lastDreamOps = Number(ops) || 0;
      state.lastDreamFiles = Number(files) || 0;
      state.lastDreamSummary = String(summary ?? '').slice(0, 2000);
      state.lastDreamMode = typeof mode === 'string' ? mode : '';
      state.lastDreamDurationMs = Math.max(0, Math.trunc(Number(durationMs) || 0));
      state.lastDreamInputChars = Math.max(0, Math.trunc(Number(inputChars) || 0));
      state.lastDreamOutputChars = Math.max(0, Math.trunc(Number(outputChars) || 0));
      state.lastDreamUsage = normalizeUsage(usage);
      state.lastDreamCostExceeded = costExceeded === true;
      state.lastError = '';
      state.consecutiveFailures = 0;
      state.counters.dreams = (Number(state.counters.dreams) || 0) + 1;
    });
  }

  async markDreamFailed(reason) {
    await this._mutate((state) => {
      state.lastError = String(reason?.message ?? reason ?? 'dream failed').slice(0, 2000);
      state.counters.failures = (Number(state.counters.failures) || 0) + 1;
      state.consecutiveFailures = Math.max(0, Number(state.consecutiveFailures) || 0) + 1;
    });
  }

  /** Record the start of one automatic extraction attempt. */
  async markExtractStart(trigger = 'auto') {
    await this._mutate((state) => {
      state.lastExtractAttemptAt = Date.now();
      state.lastExtractTrigger = typeof trigger === 'string' ? trigger.slice(0, 40) : 'auto';
    });
  }

  /**
   * Record the outcome of one automatic extraction. `reason` stays a short
   * machine code (`ok`, `no-proposals`, `timeout`, ...) so the status line can
   * render it without leaking provider error bodies into the UI.
   */
  async markExtractResult({ ok = false, count = 0, reason = '', error = '', trigger = 'auto', at = Date.now() } = {}) {
    await this._mutate((state) => {
      const finishedAt = Number(at) || Date.now();
      state.lastExtractAttemptAt = Math.max(Number(state.lastExtractAttemptAt) || 0, finishedAt);
      state.lastExtractTrigger = typeof trigger === 'string' ? trigger.slice(0, 40) : 'auto';
      state.lastExtractCount = Math.max(0, Math.trunc(Number(count) || 0));
      state.lastExtractReason = String(reason ?? '').slice(0, 200);
      state.lastExtractError = ok ? '' : String(error?.message ?? error ?? '').slice(0, 2000);
      if (ok) state.lastExtractAt = finishedAt;
    });
  }

  /**
   * Record whether the last dream/cost decision exceeded `dreamMaxTotalTokens`
   * without touching the rest of the dream fields (used by cost-mode review/block
   * decisions that do not complete a dream).
   */
  async noteCostExceeded(exceeded = true) {
    await this._mutate((state) => {
      state.lastDreamCostExceeded = exceeded === true;
    });
  }

  /**
   * Record the pending copy produced by a finished run: its directory, the
   * baseline hashes it was built from, and the file-level diff the panel shows.
   */
  async setShadowPending(pending = null) {
    await this._mutate((state) => {
      state.shadowPending = pending && typeof pending === 'object' && typeof pending.dir === 'string'
        ? { ...pending }
        : null;
      if (state.shadowPending) state.lastDreamMode = 'shadow';
    });
  }

  async clearShadowPending() {
    await this._mutate((state) => {
      state.shadowPending = null;
    });
  }

  async noteScan() {
    await this._mutate((state) => {
      state.lastScanAt = Date.now();
    });
  }

  async markSkipped() {
    await this._mutate((state) => {
      state.counters.skipped = (Number(state.counters.skipped) || 0) + 1;
    });
    }
}
