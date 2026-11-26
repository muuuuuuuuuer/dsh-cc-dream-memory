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
import { randomUUID } from 'node:crypto';
import { withFileLock } from './lock.js';

const STATE_VERSION = 1;
const MAX_SESSIONS = 200;
/** Notes corrected since the last Dream. */
const MAX_CORRECTED = 200;
const MAX_MAINTENANCE = 200;
const MAX_AGENT_NOTES = 1000;
/** Rejected Dream proposals kept so the same fact is not proposed again. */
const MAX_REJECTED = 2000;
const LOCK_TTL_MS = 10_000;
const LOCK_MAX_WAIT_MS = 3_000;
function emptyState() {
  return {
    version: STATE_VERSION,
    lastDreamAt: 0,
    lastDreamAttemptAt: 0,
    lastScanAt: 0,
    lastDreamSessions: 0,
    lastDreamOps: 0,
    lastDreamSummary: '',
    lastError: '',
    sessionsSince: [],
    // v0.10.8: sessions already consumed by a successful dream; the corpus
    // fallback must not re-read them unless they became active again.
    dreamProcessedSessions: [],
    // `agent:<preset>/<file>` -> content hash of the subagent note Dream last reviewed.
    dreamAgentNotes: {},
    // Scheduling only. A deferred review has not consumed any source events.
    dreamDeferredSessions: [],
    counters: { dreams: 0, skipped: 0, failures: 0 },
    // The pending memory copy a finished dream produced. `null` means no
    // switch is waiting; the human either switches to the copy or discards it.
    shadowPending: null,
    dreamRunOutcomes: [],
    lastDreamDecision: null,
    // Keys of Dream proposals the human did not pass (claim keys and
    // `retire:<file>`). Merge skips them, so they are never proposed again.
    dreamRejected: [],
    consecutiveFailures: 0,
    lastExtractAt: 0,
    lastExtractReason: '',
    // Per-session extraction cursors survive a Host restart. The in-memory
    // runtime map is only the fast path.
    extractSeqs: {},
    extractOffsets: {},
    // v0.24: note files whose body the user corrected in a live session since
    // the last Dream switch; the automatic Dream's focus list.
    correctedFiles: [],
    correctionVersions: {},
    // Input fingerprint of the last completed automatic no-op review per note.
    dreamMaintenance: {},
    // v0.24: why the last automatic Dream did not start ('no-focus', ...).
    lastDreamSkipReason: '',
    // v0.24: per-session switches; only the off values are stored,
    // `{ [sessionId]: { use?: false, learn?: false } }`.
    sessionFlags: {},
    // Files excluded from automatic recall by the user, keyed by session ID.
    recallDismissals: {},
  };
}

function normalize(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const state = { ...base };
  for (const key of Object.keys(base)) {
    if (key !== 'version' && Object.hasOwn(raw, key)) state[key] = raw[key];
  }
  state.sessionsSince = Array.isArray(raw.sessionsSince)
    ? raw.sessionsSince
        .filter((entry) => entry && typeof entry.id === 'string' && entry.id !== '')
        .slice(-MAX_SESSIONS)
        .map((entry) => ({ id: entry.id, at: Number(entry.at) || 0,
          ...(entry.lastActivityAt ? { lastActivityAt: Number(entry.lastActivityAt) || 0 } : {}) }))
    : [];
  state.dreamProcessedSessions = Array.isArray(raw.dreamProcessedSessions)
    ? raw.dreamProcessedSessions
        .filter((entry) => entry && typeof entry.id === 'string' && entry.id !== '')
        .slice(-MAX_SESSIONS)
        .map((entry) => ({
          id: entry.id,
          at: Number(entry.at) || 0,
          seq: Math.max(0, Math.trunc(Number(entry.seq) || 0)),
          ...([1, 2].includes(entry.coverageVersion) ? { coverageVersion: entry.coverageVersion } : {}),
          ...(entry.partial === true ? { partial: true } : {}),
        }))
    : [];
  state.dreamAgentNotes = Object.fromEntries(Object.entries(raw.dreamAgentNotes && typeof raw.dreamAgentNotes === 'object' ? raw.dreamAgentNotes : {})
    .filter(([name, hash]) => name.startsWith('agent:') && typeof hash === 'string' && hash !== '')
    .slice(-MAX_AGENT_NOTES));
  state.counters = { ...base.counters, ...(raw.counters && typeof raw.counters === 'object' ? raw.counters : {}) };
  state.dreamDeferredSessions = Array.isArray(raw.dreamDeferredSessions)
    ? raw.dreamDeferredSessions.filter((item) => typeof item?.id === 'string' && Number.isFinite(item.at)).slice(-MAX_SESSIONS)
    : [];
  state.consecutiveFailures = Math.max(0, Math.trunc(Number(state.consecutiveFailures) || 0));
  for (const key of [
    'lastDreamAt',
    'lastDreamAttemptAt',
    'lastScanAt',
    'lastDreamSessions',
    'lastDreamOps',
    'lastExtractAt',
  ]) {
    state[key] = Number(state[key]) || 0;
  }
  for (const key of [
    'lastDreamSummary',
    'lastError',
    'lastExtractReason',
  ]) {
    state[key] = typeof state[key] === 'string' ? state[key] : '';
  }
  state.correctedFiles = Array.isArray(raw.correctedFiles)
    ? [...new Set(raw.correctedFiles.filter((file) => typeof file === 'string' && file !== ''))].slice(-MAX_CORRECTED)
    : [];
  state.correctionVersions = Object.fromEntries(state.correctedFiles.flatMap((file) => {
    const version = raw.correctionVersions?.[file];
    return typeof version === 'string' && version !== '' ? [[file, version]] : [];
  }));
  state.dreamMaintenance = Object.fromEntries(Object.entries(raw.dreamMaintenance ?? {})
    .filter(([file, key]) => file.endsWith('.md') && typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key))
    .slice(-MAX_MAINTENANCE));
  state.lastDreamSkipReason = typeof raw.lastDreamSkipReason === 'string' ? raw.lastDreamSkipReason : '';
  state.sessionFlags = Object.fromEntries(
    Object.entries(raw.sessionFlags && typeof raw.sessionFlags === 'object' && !Array.isArray(raw.sessionFlags) ? raw.sessionFlags : {})
      .map(([id, flags]) => [id, { ...(flags?.use === false ? { use: false } : {}), ...(flags?.learn === false ? { learn: false } : {}) }])
      .filter(([id, flags]) => id !== '' && Object.keys(flags).length > 0),
  );
  state.recallDismissals = Object.fromEntries(
    Object.entries(raw.recallDismissals ?? {})
      .filter(([id, files]) => id !== '' && Array.isArray(files))
      .map(([id, files]) => [id, [...new Set(files.filter((file) => typeof file === 'string'))]]),
  );
  state.dreamRejected = Array.isArray(raw.dreamRejected)
    ? raw.dreamRejected.filter((key) => typeof key === 'string' && key !== '').slice(-MAX_REJECTED)
    : [];
  state.extractSeqs = raw.extractSeqs && typeof raw.extractSeqs === 'object' && !Array.isArray(raw.extractSeqs)
    ? Object.fromEntries(
      Object.entries(raw.extractSeqs)
        .filter(([id, seq]) => id !== '' && Number.isFinite(Number(seq)) && Number(seq) >= 0)
        .slice(-MAX_SESSIONS)
        .map(([id, seq]) => [id, Math.max(0, Math.trunc(Number(seq)))]),
    )
    : {};
  state.extractOffsets = Object.fromEntries(Object.entries(raw.extractOffsets ?? {}).filter(([id, position]) =>
    Object.hasOwn(state.extractSeqs, id) && Number.isSafeInteger(position?.seq)
      && position.seq > state.extractSeqs[id] && Number.isSafeInteger(position.offset) && position.offset > 0));
  state.shadowPending = raw.shadowPending && typeof raw.shadowPending === 'object'
    && typeof raw.shadowPending.dir === 'string' && raw.shadowPending.dir !== ''
    ? { ...raw.shadowPending }
    : null;
  state.dreamRunOutcomes = Array.isArray(raw.dreamRunOutcomes)
    ? raw.dreamRunOutcomes.filter((item) => typeof item?.runId === 'string' && ['ready', 'done', 'failed'].includes(item.status)).slice(-20)
    : [];
  return state;
}

function applyDreamCoverage(state, drop, reads) {
  const processed = Array.isArray(state.dreamProcessedSessions) ? state.dreamProcessedSessions : [];
  const captured = new Map();
  for (const read of reads) {
    if (typeof read?.id !== 'string' || read.id === '') continue;
    if (read.agentNote === true) {
      // A reviewed subagent note, not a session: remember the content Dream saw.
      state.dreamAgentNotes = Object.fromEntries(Object.entries({ ...state.dreamAgentNotes, [read.id]: read.hash }).slice(-MAX_AGENT_NOTES));
      continue;
    }
    const seq = Math.max(0, Math.trunc(Number(read.seq) || 0));
    const partial = read.complete !== true;
    const coverageVersion = read.capturedAt ? (read.coverageVersion === 2 ? 2 : 1) : undefined;
    const existing = processed.find((item) => item.id === read.id);
    if (existing) {
      existing.seq = coverageVersion && ![1, 2].includes(existing.coverageVersion) ? seq : Math.max(Number(existing.seq) || 0, seq);
      if (coverageVersion) existing.coverageVersion = Math.max(coverageVersion, existing.coverageVersion || 0);
      existing.at = Date.now();
      if (partial) existing.partial = true;
      else delete existing.partial;
    } else {
      processed.push({ id: read.id, at: Date.now(), seq, ...(partial ? { partial: true } : {}),
        ...(coverageVersion ? { coverageVersion } : {}) });
    }
    if (read.capturedAt) captured.set(read.id, read.capturedAt);
    drop.add(read.id);
  }
  state.dreamProcessedSessions = processed.slice(-MAX_SESSIONS);
  state.dreamDeferredSessions = state.dreamDeferredSessions.filter((item) => !drop.has(item.id));
  state.sessionsSince = state.sessionsSince.filter((entry) =>
    !drop.has(entry.id) || (captured.has(entry.id) && (entry.lastActivityAt || entry.at) >= captured.get(entry.id)));
}

function recordRunOutcome(state, outcome) {
  state.dreamRunOutcomes = [...state.dreamRunOutcomes.filter((item) => item.runId !== outcome.runId), outcome].slice(-20);
}

function recordDreamMaintenance(state, maintenance) {
  if (maintenance.length === 0) return;
  const recent = new Map(Object.entries(state.dreamMaintenance));
  for (const { file, key } of maintenance) {
    recent.delete(file);
    recent.set(file, key);
  }
  state.dreamMaintenance = Object.fromEntries([...recent].slice(-MAX_MAINTENANCE));
}

function recordRunDecision(state, runId, decision) {
  if (!runId) return;
  const prior = state.dreamRunOutcomes.find((item) => item.runId === runId);
  recordRunOutcome(state, { ...prior, runId, status: 'done', decision,
    applied: decision === 'applied' || decision === 'partially-applied' });
}

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

  /** Mutate the latest persisted state under a cross-process lock. */
  async _mutate(mutator) {
    return withFileLock(this.lockFile, async () => {
      const fresh = normalize(await this._readForMutation());
      await mutator(fresh);
      await this._writeState(fresh);
      this.state = fresh;
      this.loaded = true;
      return fresh;
    }, { ttlMs: LOCK_TTL_MS, waitMs: LOCK_MAX_WAIT_MS, strict: true, reclaimDeadOwner: true });
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
      state.dreamDeferredSessions = state.dreamDeferredSessions.filter((item) => item.id !== sessionId || item.at > at);
      const prior = state.sessionsSince.find((entry) => entry.id === sessionId);
      if (prior) {
        prior.lastActivityAt = Math.max(prior.lastActivityAt || prior.at, Number(at) || Date.now());
        return;
      }
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
      applyDreamCoverage(state, drop, reads);
    });
  }

  /** Undo restores session eligibility: remove processed watermarks from a batch. */
  async restoreDreamProcessed(ids, { runId } = {}) {
    const restore = new Set((ids ?? []).filter((id) => typeof id === 'string'));
    if (restore.size === 0 && !runId) return;
    await this._mutate((state) => {
      state.dreamProcessedSessions = (Array.isArray(state.dreamProcessedSessions) ? state.dreamProcessedSessions : [])
        .filter((entry) => !restore.has(entry.id));
      state.dreamAgentNotes = Object.fromEntries(Object.entries(state.dreamAgentNotes ?? {}).filter(([name]) => !restore.has(name)));
      recordRunDecision(state, runId, 'undone');
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
    summary = '',
  } = {}) {
    await this._mutate((state) => {
      state.lastDreamAt = Date.now();
      state.lastDreamSessions = Number(sessions) || 0;
      state.lastDreamOps = Number(ops) || 0;
      state.lastDreamSummary = String(summary ?? '').slice(0, 2000);
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

  async markExtractResult({ ok = false, reason = '' } = {}) {
    await this._mutate((state) => {
      state.lastExtractReason = String(reason).slice(0, 200);
      if (ok) state.lastExtractAt = Date.now();
    });
  }

  /** Persist one session's extraction cursor (max event seq already processed). */
  async noteExtractSeq(sessionId, seq, nextOffset) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const value = Math.max(0, Math.trunc(Number(seq) || 0));
    await this._mutate((state) => {
      state.extractSeqs = state.extractSeqs && typeof state.extractSeqs === 'object' ? state.extractSeqs : {};
      if (value < Number(state.extractSeqs[sessionId] ?? 0)) return;
      const offsets = state.extractOffsets;
      const previous = offsets[sessionId];
      if (nextOffset && previous?.seq === nextOffset.seq && previous.offset > nextOffset.offset) return;
      if (nextOffset) offsets[sessionId] = nextOffset;
      else delete offsets[sessionId];
      state.extractSeqs[sessionId] = value;
      const keys = Object.keys(state.extractSeqs);
      if (keys.length > MAX_SESSIONS) {
        for (const key of keys.slice(0, keys.length - MAX_SESSIONS)) {
          delete state.extractSeqs[key];
          delete offsets[key];
        }
      }
    });
  }

  /**
   * Record the pending copy produced by a finished run: its directory, the
   * baseline hashes it was built from, and the file-level diff the panel shows.
   */
  async setShadowPending(pending = null, outcome, maintenance = []) {
    await this._mutate((state) => {
      state.shadowPending = pending && typeof pending === 'object' && typeof pending.dir === 'string'
        ? { ...pending }
        : null;
      if (state.shadowPending && outcome) {
        recordRunOutcome(state, outcome);
        recordDreamMaintenance(state, maintenance);
      }
    });
  }

  /** Publish a terminal result and its covered input in the same state write. */
  async completeDreamRun(outcome, reads, maintenance = []) {
    await this._mutate((state) => {
      if (reads.length > 0) applyDreamCoverage(state, new Set(), reads);
      recordDreamMaintenance(state, maintenance);
      recordRunOutcome(state, outcome);
    });
  }

  /** Remember proposals the human did not pass. */
  async rejectDreamProposals(keys = []) {
    const add = keys.filter((key) => typeof key === 'string' && key !== '');
    if (add.length === 0) return;
    await this._mutate((state) => {
      const merged = [...new Set([...(state.dreamRejected ?? []), ...add])];
      state.dreamRejected = merged.slice(-MAX_REJECTED);
    });
  }

  /** Save the human decision and any accepted progress in one state write. */
  async settleShadowPending(runId, decision, rejected = [], { reads, appliedFiles } = {}) {
    await this._mutate((state) => {
      const pending = state.shadowPending;
      if (!pending || pending.runId !== runId) throw new Error('pending Dream changed before settlement');
      const settleAll = ['applied', 'rejected'].includes(decision) && Array.isArray(pending.reviewRecords);
      const settled = reads ?? (settleAll ? pending.reviewRecords : []);
      if (settled.length > 0) applyDreamCoverage(state, new Set(), settled);
      if (decision === 'deferred' || decision === 'partially-applied') {
        const consumed = new Set(settled.map(({ id }) => id));
        const held = (pending.reviewRecords ?? []).filter(({ id }) => !consumed.has(id));
        const deferred = new Map(state.dreamDeferredSessions.map((item) => [item.id, item]));
        const activity = new Map(state.sessionsSince.map((item) => [item.id, item.lastActivityAt || item.at]));
        for (const { id, capturedAt, agentNote } of held) {
          if (agentNote) continue;
          deferred.delete(id);
          const at = capturedAt || pending.createdAt || Date.now();
          if ((activity.get(id) || 0) < at) deferred.set(id, { id, at });
        }
        state.dreamDeferredSessions = [...deferred.values()].slice(-MAX_SESSIONS);
      }
      state.dreamRejected = [...new Set([...state.dreamRejected, ...rejected])].slice(-MAX_REJECTED);
      if (decision === 'applied' || decision === 'partially-applied') {
        const observed = new Map((Array.isArray(pending.corrected) ? pending.corrected : [])
          .map((item) => typeof item === 'string' ? [item, null] : [item?.file, item?.version ?? null]));
        state.correctedFiles = state.correctedFiles.filter((file) => {
          if (decision === 'partially-applied' && appliedFiles && !appliedFiles.has(file)) return true;
          if (!observed.has(file) || observed.get(file) !== (state.correctionVersions[file] ?? null)) return true;
          delete state.correctionVersions[file];
          return false;
        });
      }
      state.lastDreamDecision = { runId, decision, reads: settled, at: Date.now() };
      recordRunDecision(state, runId, decision);
      state.shadowPending = null;
    });
  }

  async clearShadowPending() {
    await this._mutate((state) => {
      state.shadowPending = null;
    });
  }

  /**
   * Drop a pending record whose copy is gone. `dreamReadiness` trusts the
   * record, so a deleted directory would otherwise block every automatic run
   * forever; the run that could repair it is the one readiness refuses to
   * start. Returns true when a stale record was cleared.
   * @returns {Promise<boolean>}
   */
  async dropStaleShadowPending() {
    const pending = this.snapshot?.().shadowPending;
    if (!pending || typeof pending.dir !== 'string' || pending.dir === '') return false;
    try {
      await fs.stat(pending.dir);
      return false;
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }
    let dropped = false;
    await this._mutate(async (state) => {
      const current = state.shadowPending;
      if (current?.runId !== pending.runId || current?.dir !== pending.dir || current?.createdAt !== pending.createdAt) return;
      // Another run can reuse the directory while this instance waits for the
      // state lock. Check both the record and the directory under that lock.
      try {
        await fs.stat(current.dir);
      } catch (error) {
        if (error?.code !== 'ENOENT') return;
        state.shadowPending = null;
        dropped = true;
      }
    });
    return dropped;
  }

  async noteScan() {
    await this._mutate((state) => {
      state.lastScanAt = Date.now();
    });
  }

  async markSkipped(reason = '') {
    await this._mutate((state) => {
      state.counters.skipped = (Number(state.counters.skipped) || 0) + 1;
      if (reason !== '') state.lastDreamSkipReason = String(reason).slice(0, 80);
    });
  }

  /** Read dismissals without refreshing the unrelated cached project state. */
  async readRecallDismissals(sessionId) {
    const state = await this._readForMutation() ?? this.state;
    const files = state.recallDismissals?.[sessionId];
    return new Set(Array.isArray(files) ? files : []);
  }

  /** Add one scoped file once and report whether it was newly dismissed. */
  async dismissRecall(sessionId, ref) {
    let added = false;
    await this._mutate((state) => {
      const dismissals = state.recallDismissals;
      const files = Object.hasOwn(dismissals, sessionId) ? dismissals[sessionId] : [];
      if (files.includes(ref)) return;
      state.recallDismissals = { ...dismissals, [sessionId]: [...files, ref] };
      added = true;
    });
    return added;
  }

  /** Remember that the user corrected this note in a live session. */
  async noteCorrected(file) {
    if (typeof file !== 'string' || file === '') return;
    await this._mutate((state) => {
      state.correctedFiles = [...state.correctedFiles.filter((item) => item !== file), file].slice(-MAX_CORRECTED);
      state.correctionVersions = { ...state.correctionVersions, [file]: randomUUID() };
      for (const key of Object.keys(state.correctionVersions)) {
        if (!state.correctedFiles.includes(key)) delete state.correctionVersions[key];
      }
    });
  }

  /** Explicitly clear correction tracking for the named files or the whole project. */
  async clearCorrected(files) {
    if (this.state.correctedFiles.length === 0) return;
    const consumed = Array.isArray(files) ? new Set(files) : null;
    await this._mutate((state) => {
      state.correctedFiles = consumed ? state.correctedFiles.filter((file) => !consumed.has(file)) : [];
      for (const file of Object.keys(state.correctionVersions)) {
        if (!consumed || consumed.has(file)) delete state.correctionVersions[file];
      }
    });
  }

  /** The per-session switches of one session (`true` = on, the default). */
  flagsOf(sessionId) {
    const stored = this.state.sessionFlags?.[sessionId] ?? {};
    return { use: stored.use !== false, learn: stored.learn !== false };
  }

  /** Switch one session's `use` or `learn`; the on value drops the record. */
  async setSessionFlag(sessionId, key, value) {
    if (typeof sessionId !== 'string' || sessionId === '' || !['use', 'learn'].includes(key)) return;
    await this._mutate((state) => {
      const flags = { ...(state.sessionFlags[sessionId] ?? {}) };
      if (value === false) flags[key] = false;
      else delete flags[key];
      delete state.sessionFlags[sessionId];
      if (Object.keys(flags).length > 0) state.sessionFlags = { ...state.sessionFlags, [sessionId]: flags };
    });
  }
}
