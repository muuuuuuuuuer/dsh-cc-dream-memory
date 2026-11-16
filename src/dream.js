/**
 * Dream engine: the filesystem half of a run.
 *
 * Analysis and model work live in `src/dream-agent.js`, which writes its result
 * into a copy of the memory directory (see `src/dream-shadow.js`). This module
 * owns what happens to that copy: the human either switches to it or throws it
 * away, and a switch can be undone from the backup taken right before it.
 *
 * There is no per-page review step. A run ends with a pending copy and a
 * file-level diff; adopting it is one explicit action, exactly like upstream
 * dream, where a run produces a new store the human then uses or discards.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryStore } from './store.js';
import { withFileLock } from './lock.js';
import { recordDream } from './metrics.js';
import { bodyHashOf, recordVerifiedEntry } from './verification-ledger.js';
import {
  clearShadow,
  archiveShadow,
  diffShadow,
  shadowDirOf,
  shadowPathsOf,
  switchShadow as commitShadow,
} from './dream-shadow.js';

/** Hash of one file's text. */
function hashText(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/** Message of an unknown thrown value. */
function errorMessage(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

/** Collapse arbitrary text to one trimmed line of at most `max` characters. */
function oneLine(value, max = 400) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** Directory-name timestamp for one backup batch. */
function timestampName(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/** Best-effort warning; never throws. */
function warn(scope, error) {
  try {
    console.warn(`[dsh-cc-memory] ${scope}: ${errorMessage(error)}`);
  } catch {
    // stderr may be unavailable
  }
}

/**
 * Record one dream metrics event (`applied`/`discarded`/`undone`/`failed`).
 * @param {object|undefined} paths project paths (metrics module owns the file).
 * @param {object} payload `{ event, ops?, durationMs?, inputChars?, outputChars?, usage? }`
 * @returns {Promise<boolean>} whether the event was recorded.
 */
export async function recordDreamEvent(paths, payload) {
  try {
    if (!paths) return false;
    await recordDream(paths, payload);
    return true;
  } catch (error) {
    warn('record dream metrics', error);
    return false;
  }
}

/** Total tokens of one usage object (falls back to input+output). */
function totalTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const total = Number(usage.totalTokens);
  if (Number.isFinite(total) && total >= 0) return total;
  const input = Number(usage.inputTokens);
  const output = Number(usage.outputTokens);
  if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) return input + output;
  return null;
}

/**
 * Compare one usage record with `config.dreamMaxTotalTokens` (0 = off).
 * @returns {{exceeded:boolean, limit:number, totalTokens?:number, warning:string}}
 */
export function costLimitStatus(config, usage) {
  const limit = maxTotalTokensLimit(config);
  if (limit === 0) return { exceeded: false, limit: 0, warning: '' };
  const total = totalTokensOf(usage);
  if (!Number.isFinite(total) || total <= limit) return { exceeded: false, limit, warning: '' };
  return {
    exceeded: true,
    limit,
    totalTokens: total,
    warning: `cost-limit-exceeded: totalTokens ${total} > limit ${limit}`,
  };
}

/** Effective cost mode (`warn` continues, `block` refuses before writing). */
export function dreamCostModeOf(config) {
  return config?.dreamCostMode === 'block' ? 'block' : 'warn';
}

/** Configured total-token ceiling; 0 means the limit is off. */
export function maxTotalTokensLimit(config) {
  const raw = Number(config && typeof config === 'object' ? config.dreamMaxTotalTokens : 0);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}

/** Preflight estimate used before the model call (contract: ceil(chars/4) + 1024). */
export function estimateInputTokens(inputChars) {
  return Math.ceil(Math.max(0, Number(inputChars) || 0) / 4) + 1024;
}

/** Drop one session's cached injection so the next turn re-reads memory. */
function invalidate(runtime, agent) {
  try {
    const sessionId = typeof agent?.session?.id === 'string'
      ? agent.session.id
      : typeof agent?.id === 'string' ? agent.id : '';
    if (sessionId && runtime && typeof runtime.invalidateInjection === 'function') {
      runtime.invalidateInjection(sessionId);
    }
  } catch (error) {
    warn('invalidate injection', error);
  }
}

/** Proposal keys the pending copy recorded for these files. */
function proposalsOf(pending, files) {
  const byFile = pending?.proposals && typeof pending.proposals === 'object' ? pending.proposals : {};
  return files.flatMap((file) => (Array.isArray(byFile[file]) ? byFile[file] : []));
}

/** Read the pending copy's state, or null when there is none. */
function pendingOf(state) {
  const snapshot = state?.snapshot() ?? {};
  const pending = snapshot.shadowPending;
  if (!pending || typeof pending !== 'object' || typeof pending.dir !== 'string') return null;
  return pending;
}

/**
 * The dream engine.
 */
export class DreamEngine {
  constructor({ runtime } = {}) {
    this.runtime = runtime;
  }

  /** Current settings, honoring runtime overrides. */
  get effectiveConfig() {
    return this.runtime.config;
  }

  /** The pending copy and its diff, or null. */
  async pendingSwitch(pctx = {}) {
    const pending = pendingOf(pctx.state);
    if (!pending) return null;
    try {
      await fs.stat(pending.dir);
    } catch {
      return null;
    }
    return pending;
  }

  /**
   * Apply the pending copy. Every changed file is passed unless it is named in
   * `reject` or `defer`. A rejected file stays as it is, and the change it
   * proposed is remembered so a later Dream does not propose it again. A
   * deferred file also stays as it is but nothing is remembered: it may come
   * back. A passed change without a checked source applies only when it is in
   * `confirm`, which the reviewer sends after reading that file's diff; the
   * run id and the page revisions still bind the decision to those exact bytes.
   * Rejecting every file is the same as {@link discardShadow} with a rejection.
   * @param {{pctx:object, agent?:object, reject?:string[], defer?:string[], confirm?:string[], runId?:string}} options
   * @returns {Promise<{ok:boolean, error?:string, conflicts?:object[], backupDir?:string, counts?:object, rejected?:string[], deferred?:string[], confirmedWithoutSource?:string[]}>}
   */
  async switchShadow({ pctx, agent, reject = [], defer = [], confirm = [], runId = '' } = {}) {
    if (!pctx?.paths) return { ok: false, error: 'no-project' };
    return withFileLock(pctx.paths.lockFile, async () => {
      await pctx.state?.read?.();
      return this.#switchShadow({ pctx, agent, reject, defer, confirm, runId });
    }, { strict: true });
  }

  async #switchShadow({ pctx, agent, reject, defer, confirm, runId }) {
    const store = pctx?.store;
    const paths = pctx?.paths;
    const state = pctx?.state;
    if (!store || !paths || !state) return { ok: false, error: 'no-project' };
    const pending = await this.pendingSwitch(pctx);
    if (runId && pending?.runId !== runId) {
      return { ok: false, error: 'stale-dream', message: 'The pending Dream changed. Refresh the Memory page.' };
    }
    if (!pending) return { ok: false, error: 'no-pending' };
    const config = this.effectiveConfig;
    const shadowStore = new MemoryStore({ paths: shadowPathsOf(paths), getConfig: () => config });
    const stamp = timestampName(Date.now());
    const diff = await diffShadow({ store, shadowStore, base: pending.base });
    // A retired page and the page its facts moved into are one decision.
    const withLinked = (files) => {
      const together = new Set(files);
      let previousSize;
      do {
        previousSize = together.size;
        for (const [retiredFile, into] of Object.entries(pending.links ?? {})) {
          if (together.has(retiredFile) || together.has(into)) {
            together.add(retiredFile);
            together.add(into);
          }
        }
      } while (together.size !== previousSize);
      return together;
    };
    const rejected = withLinked(reject);
    const deferred = withLinked(defer);
    for (const file of rejected) deferred.delete(file);
    const passed = diff.files.filter((item) => !rejected.has(item.file) && !deferred.has(item.file));
    const changedFiles = diff.files.map((item) => item.file);
    if (passed.length === 0) {
      if (deferred.size === 0) return this.#discardShadow(pctx, runId, 'rejected');
      // Nothing to apply, but only the explicit rejections are remembered.
      const rejectedFiles = changedFiles.filter((file) => rejected.has(file));
      await state.settleShadowPending(pending.runId, 'deferred', proposalsOf(pending, rejectedFiles));
      await clearShadow(paths);
      await recordDreamEvent(paths, { event: 'discarded', ops: 0 });
      return { ok: true, discarded: true, decision: 'deferred', rejected: rejectedFiles, deferred: changedFiles.filter((file) => deferred.has(file)) };
    }
    const proofs = new Map((pending.proofs ?? []).map((item) => [item.file, item]));
    const confirmed = new Set(confirm);
    const sourced = ({ file, action }) => {
      const proof = proofs.get(file);
      return proof?.action === action && ['citation', 'preserved'].includes(proof.kind);
    };
    const unsupported = passed.filter((item) => {
      const proof = proofs.get(item.file);
      // A confirmation needs a proof record to bind the reviewed bytes to.
      return !sourced(item) && !(confirmed.has(item.file) && proof?.action === item.action);
    });
    if (unsupported.length > 0) return { ok: false, error: 'evidence-required',
      files: unsupported.map(({ file }) => file),
      message: 'Reject, defer, or confirm after reading the diff, the changes without checked sources: ' + unsupported.map(({ file }) => file).join(', ') };
    const confirmedWithoutSource = passed.filter((item) => !sourced(item)).map(({ file }) => file);
    const passedFiles = new Set(passed.map((item) => item.file));
    const settledSessions = rejected.size === 0 && deferred.size === 0 ? (pending.reviewRecords ?? []).map(({ id }) => id) : [];
    const verifiedFiles = (pending.verifiedFiles ?? []).filter((file) => passedFiles.has(file));
    const result = await commitShadow({
      store,
      shadowStore,
      paths,
      base: pending.base,
      stamp,
      files: passedFiles,
      revisions: new Map(passed.map(({ file }) => [file, proofs.get(file).revision])),
      dependencies: passed.map(({ file }) => proofs.get(file).dependsOn).filter(Boolean),
      recordSwitch: ({ backupDir, counts }) => writeSwitchMeta(store, paths, {
        stamp, backupDir, counts, files: passed, summary: pending.summary,
        sessions: settledSessions, runId: pending.runId, verifiedFiles, confirmedWithoutSource,
      }),
    });
    if (result.ok !== true) {
      return result;
    }
    // Notes whose facts were verified during the run become the trusted
    // version the first turn may summarize.
    for (const file of verifiedFiles) {
      try {
        const entry = await store.readEntry(file, 'project');
        await recordVerifiedEntry({
          store,
          scope: 'project',
          file,
          name: entry.name,
          description: entry.description,
          bodyHash: bodyHashOf(entry.body),
        });
      } catch (error) {
        warn(`record verification for ${file}`, error);
      }
    }
    const rejectedFiles = changedFiles.filter((file) => rejected.has(file));
    const deferredFiles = changedFiles.filter((file) => deferred.has(file));
    await state.settleShadowPending(pending.runId, rejectedFiles.length > 0 || deferredFiles.length > 0 ? 'partially-applied' : 'applied',
      proposalsOf(pending, rejectedFiles));
    // Claude Code parity: the applied result is kept next to the backup so the
    // human can inspect what the dream produced after switching to it.
    const outputDir = await archiveShadow(paths, stamp).catch(() => '');
    await recordDreamEvent(paths, {
      event: 'applied',
      ops: (result.counts.added ?? 0) + (result.counts.changed ?? 0) + (result.counts.removed ?? 0),
      sessions: Array.isArray(pending.sessions) ? pending.sessions.length : 0,
    });
    this.runtime?.invalidateAllInjections?.('dream-switch');
    invalidate(this.runtime, agent);
    return { ok: true, backupDir: result.backupDir, outputDir, counts: result.counts, rejected: rejectedFiles, deferred: deferredFiles, confirmedWithoutSource };
  }

  /**
   * Defer the pending copy without consuming its evidence or rejecting its facts.
   */
  async discardShadow({ pctx, runId = '' } = {}) {
    if (!pctx?.paths) return { ok: false, error: 'no-project' };
    return withFileLock(pctx.paths.lockFile, async () => {
      await pctx.state?.read?.();
      return this.#discardShadow(pctx, runId);
    }, { strict: true });
  }

  async #discardShadow(pctx, runId = '', decision = 'deferred') {
    const paths = pctx?.paths;
    if (!paths) return { ok: false, error: 'no-project' };
    const pending = await this.pendingSwitch(pctx);
    if (runId && pending?.runId !== runId) {
      return { ok: false, error: 'stale-dream', message: 'The pending Dream changed. Refresh the Memory page.' };
    }
    if (!pending) return { ok: false, error: 'no-pending' };
    await pctx.state.settleShadowPending(pending.runId, decision,
      decision === 'rejected' ? proposalsOf(pending, Object.keys(pending.proposals ?? {})) : []);
    await clearShadow(paths);
    await recordDreamEvent(paths, { event: 'discarded', ops: 0 });
    return { ok: true, discarded: true, decision };
  }

  /**
   * Undo the last switch: restore the notes the switch rewrote, move the ones
   * it created to the trash, and leave every other note alone.
   * @returns {Promise<{ok:boolean, error?:string, batch?:string, restored?:string[], trashed?:string[], conflicts?:Array<object>}>}
   */
  async undoLastDream({ pctx, agent } = {}) {
    if (!pctx?.store || !pctx?.paths) return { ok: false, error: 'no-project' };
    return withFileLock(pctx.paths.lockFile,
      () => pctx.store.withWriteTransaction(() => this.#undoLastDream(pctx, agent)), { strict: true });
  }

  async #undoLastDream(pctx, agent) {
    const store = pctx?.store;
    const paths = pctx?.paths;
    const state = pctx?.state;
    if (!store || !paths || !state) return { ok: false, error: 'no-project' };
    const meta = (await listSwitches(paths)).find((item) => item.undone !== true);
    if (!meta) return { ok: false, error: 'no-undoable-batch' };
    const hashes = meta.hashes && typeof meta.hashes === 'object' ? meta.hashes : {};
    const backupDir = meta.backupDir;
    const rewritten = Array.isArray(meta.rewritten) ? meta.rewritten.filter((name) => hashes[name]) : [];
    const created = Array.isArray(meta.created) ? meta.created.filter((name) => hashes[name]) : [];
    // Pages the switch removed come back from the backup, unless a page of
    // that name exists again (then it is the human's, and undo stops).
    const removed = Array.isArray(meta.removed) ? meta.removed.filter((name) => typeof name === 'string' && name !== '') : [];
    const conflicts = [];
    const alreadyRestored = new Set();
    const removing = new Set(Array.isArray(meta.undoRemoving) ? meta.undoRemoving : []);
    const saveUndoMeta = async (patch) => {
      const { file, batch, ...data } = meta;
      await store._atomicWrite(file, `${JSON.stringify({ ...data, ...patch }, null, 2)}\n`);
    };
    const backupHash = async (name) => {
      try {
        return `sha256:${hashText(await fs.readFile(path.join(backupDir, name), 'utf8'))}`;
      } catch {
        return '';
      }
    };
    for (const name of removed) {
      if (await fs.stat(path.join(paths.memoryDir, name)).then(() => true, () => false)) {
        // A retry after a partial undo: the backup is already live again.
        if ((await backupHash(name)) === `sha256:${hashText(await fs.readFile(path.join(paths.memoryDir, name), 'utf8'))}`) {
          alreadyRestored.add(name);
          continue;
        }
        conflicts.push({ file: name, expected: 'missing', actual: 'present', reason: 'recreated since the switch' });
      }
    }
    for (const name of [...rewritten, ...created]) {
      if (alreadyRestored.has(name)) continue;
      const expected = hashes[name];
      let actual = 'missing';
      try {
        actual = `sha256:${hashText((await store.readEntry(name, 'project')).raw)}`;
      } catch {
        if (actual === 'missing' && created.includes(name) && removing.has(name)
          && !(await store._exists(path.join(paths.memoryDir, name)))) continue;
      }
      if (actual !== expected) {
        if (actual === (await backupHash(name))) {
          alreadyRestored.add(name);
          continue;
        }
        conflicts.push({ file: name, expected, actual, reason: 'edited since the switch' });
      }
    }
    if (conflicts.length > 0) return { ok: false, error: 'conflict', conflicts };
    const restored = [];
    const failed = [];
    for (const name of [...rewritten, ...removed]) {
      if (alreadyRestored.has(name)) {
        restored.push(name);
        continue;
      }
      try {
        const raw = await fs.readFile(path.join(backupDir, name), 'utf8');
        await store._atomicWrite(path.join(paths.memoryDir, name), raw);
        restored.push(name);
      } catch (error) {
        failed.push({ file: name, error: error?.message ?? String(error) });
        warn(`restore ${name}`, error);
      }
    }
    const trashed = [];
    for (const name of created) {
      try {
        if (removing.has(name) && !(await store._exists(path.join(paths.memoryDir, name)))) {
          trashed.push(name);
          continue;
        }
        removing.add(name);
        await saveUndoMeta({ undoRemoving: [...removing] });
        await store.trashEntry(name, { scope: 'project', reason: 'dream undo', expectedHash: hashes[name].slice(7) });
        trashed.push(name);
      } catch (error) {
        failed.push({ file: name, error: error?.message ?? String(error) });
        warn(`trash ${name}`, error);
      }
    }
    if (failed.length > 0) {
      // Keep the batch undoable: the retry sees restored files as already done.
      await store.refreshIndex('project').catch(() => {});
      this.runtime.invalidateAllInjections('dream-undo');
      invalidate(this.runtime, agent);
      return { ok: false, error: 'undo-partial', partial: true, restored, trashed, failed, backupDir };
    }
    await store.refreshIndex('project');
    // The run consumed these sessions; an undo makes them eligible again so the
    // human can dream them once more.
    await state.restoreDreamProcessed(Array.isArray(meta.sessions) ? meta.sessions : []);
    await saveUndoMeta({ undoRemoving: [...removing], undone: true, undoneAt: Date.now() });
    const batch = path.basename(path.dirname(backupDir));
    await recordDreamEvent(paths, { event: 'undone', ops: restored.length + trashed.length });
    await store
      .writeChangelog(
        [
          '',
          `## ${new Date().toISOString()} undo of ${batch}`,
          `- restored: ${restored.length === 0 ? 'nothing' : restored.join(', ')}`,
          `- trashed: ${trashed.length === 0 ? 'nothing' : trashed.join(', ')}`,
        ].join('\n'),
      )
      .catch((error) => warn('undo changelog', error));
    this.runtime.invalidateAllInjections('dream-undo');
    invalidate(this.runtime, agent);
    return { ok: true, batch, restored, trashed, backupDir };
  }
}

/**
 * Write `meta.json` beside the backup copy: what changed, which files, the
 * hashes the switch produced (undo refuses when a note moved since).
 */
async function writeSwitchMeta(store, paths, payload) {
  const backupDir = payload.backupDir;
  const dir = path.dirname(backupDir);
  const diff = Array.isArray(payload.files) ? payload.files : [];
  const created = diff.filter((item) => item.action === 'added').map((item) => item.file);
  const rewritten = diff.filter((item) => item.action === 'changed').map((item) => item.file);
  const removed = diff.filter((item) => item.action === 'removed').map((item) => item.file);
  const hashes = {};
  for (const file of [...created, ...rewritten]) {
    hashes[file] = `sha256:${hashText(await fs.readFile(path.join(paths.memoryDir, file), 'utf8'))}`;
  }
  await store._atomicWrite(path.join(dir, 'meta.json'), `${JSON.stringify({
    kind: 'dream-switch',
    stamp: payload.stamp,
    appliedAt: Date.now(),
    runId: payload.runId,
    summary: payload.summary,
    sessions: payload.sessions,
    counts: payload.counts,
    files: diff.map((item) => item.file),
    created,
    rewritten,
    removed,
    verifiedFiles: payload.verifiedFiles,
    // Changes the reviewer accepted after reading the diff, without a checked source.
    confirmedWithoutSource: Array.isArray(payload.confirmedWithoutSource) ? payload.confirmedWithoutSource : [],
    backupDir,
    hashes,
  }, null, 2)}\n`);
}

/**
 * Every Dream switch recorded under `.dreams/`, newest first. This is the only
 * reader of switch metadata: undo takes the newest one not undone yet, and the
 * history lists them all. A folder without switch metadata is a run artifact,
 * not a switch.
 * @param {{dreamsDir:string}} paths
 * @returns {Promise<Array<object>>} each meta plus `batch` (its folder name)
 */
export async function listSwitches(paths) {
  let names = [];
  try {
    names = await fs.readdir(paths.dreamsDir);
  } catch {
    return [];
  }
  const metas = [];
  for (const name of names) {
    const file = path.join(paths.dreamsDir, name, 'meta.json');
    try {
      const meta = JSON.parse(await fs.readFile(file, 'utf8'));
      if (meta?.kind === 'dream-switch') metas.push({ ...meta, file, batch: name });
    } catch {
      /* not a switch */
    }
  }
  return metas.sort((left, right) => (Number(right.appliedAt) || 0) - (Number(left.appliedAt) || 0));
}

/** Where the pending copy lives, for diagnostics. */
export function pendingShadowDir(paths) {
  return shadowDirOf(paths);
}

/** One-line description of the pending copy for status output. */
export function describePending(pending) {
  if (!pending) return '';
  const counts = pending.counts && typeof pending.counts === 'object' ? pending.counts : {};
  const parts = [];
  if (counts.added) parts.push(`+${counts.added}`);
  if (counts.changed) parts.push(`~${counts.changed}`);
  if (counts.removed) parts.push(`-${counts.removed}`);
  return oneLine(`${parts.join(' ') || 'no file changes'}${pending.summary ? ` — ${pending.summary}` : ''}`, 200);
}
