/**
 * Dream engine: the filesystem half of a run.
 *
 * Analysis and merging live in `src/dream-pipeline.js`, which writes its result
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
   * Adopt the pending copy: back the live notes up, then replace them.
   * @returns {Promise<{ok:boolean, error?:string, conflicts?:object[], backupDir?:string, counts?:object}>}
   */
  async switchShadow({ pctx, agent } = {}) {
    const store = pctx?.store;
    const paths = pctx?.paths;
    const state = pctx?.state;
    if (!store || !paths || !state) return { ok: false, error: 'no-project' };
    const pending = await this.pendingSwitch(pctx);
    if (!pending) return { ok: false, error: 'no-pending' };
    const config = this.effectiveConfig;
    const shadowStore = new MemoryStore({ paths: shadowPathsOf(paths), getConfig: () => config });
    const stamp = timestampName(Date.now());
    const diff = await diffShadow({ store, shadowStore }).catch(() => ({ files: [] }));
    const result = await commitShadow({
      store,
      shadowStore,
      paths,
      base: pending.base,
      stamp,
    });
    if (result.ok !== true) {
      return { ok: false, error: result.error || 'switch-failed', conflicts: result.conflicts || [] };
    }
    // Notes whose facts were verified during the run become the trusted
    // version the first turn may summarize.
    for (const file of Array.isArray(pending.verifiedFiles) ? pending.verifiedFiles : []) {
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
    await writeSwitchMeta(paths, {
      stamp,
      backupDir: result.backupDir,
      counts: result.counts,
      files: diff.files,
      summary: typeof pending.summary === 'string' ? pending.summary : '',
      sessions: Array.isArray(pending.sessions) ? pending.sessions : [],
      runId: typeof pending.runId === 'string' ? pending.runId : '',
      verifiedFiles: Array.isArray(pending.verifiedFiles) ? pending.verifiedFiles : [],
    });
    await state.clearShadowPending().catch(() => {});
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
    return { ok: true, backupDir: result.backupDir, outputDir, counts: result.counts };
  }

  /** Throw the pending copy away; the live notes were never touched. */
  async discardShadow({ pctx } = {}) {
    const paths = pctx?.paths;
    if (!paths) return { ok: false, error: 'no-project' };
    const pending = await this.pendingSwitch(pctx);
    if (!pending) return { ok: false, error: 'no-pending' };
    await clearShadow(paths);
    await pctx.state.clearShadowPending().catch((error) => warn('clear pending copy', error));
    await recordDreamEvent(paths, { event: 'discarded', ops: 0 });
    return { ok: true, discarded: true };
  }

  /**
   * Undo the last switch: restore the notes the switch rewrote, move the ones
   * it created to the trash, and leave every other note alone.
   * @returns {Promise<{ok:boolean, error?:string, batch?:string, restored?:string[], trashed?:string[], conflicts?:Array<object>}>}
   */
  async undoLastDream({ pctx, agent } = {}) {
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
    const conflicts = [];
    for (const name of [...rewritten, ...created]) {
      const expected = hashes[name];
      let actual = 'missing';
      try {
        actual = `sha256:${hashText((await store.readEntry(name, 'project')).raw)}`;
      } catch {
        actual = 'missing';
      }
      if (actual !== expected) conflicts.push({ file: name, expected, actual, reason: 'edited since the switch' });
    }
    if (conflicts.length > 0) return { ok: false, error: 'conflict', conflicts };
    const restored = [];
    for (const name of rewritten) {
      try {
        await fs.copyFile(path.join(backupDir, name), path.join(paths.memoryDir, name));
        restored.push(name);
      } catch (error) {
        warn(`restore ${name}`, error);
      }
    }
    const trashed = [];
    for (const name of created) {
      try {
        await store.trashEntry(name, { scope: 'project', reason: 'dream undo' });
        trashed.push(name);
      } catch (error) {
        warn(`trash ${name}`, error);
      }
    }
    await store.refreshIndex('project');
    // The run consumed these sessions; an undo makes them eligible again so the
    // human can dream them once more.
    await state.restoreDreamProcessed(Array.isArray(meta.sessions) ? meta.sessions : []);
    await markSwitchUndone(paths, meta);
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
async function writeSwitchMeta(paths, payload) {
  const backupDir = payload.backupDir;
  const dir = path.dirname(backupDir);
  const hashes = {};
  for (const file of await listMemoryFiles(paths)) {
    try {
      hashes[file] = `sha256:${hashText(await fs.readFile(path.join(paths.memoryDir, file), 'utf8'))}`;
    } catch {
      // a file that vanished mid-switch is not undoable anyway
    }
  }
  await fs.mkdir(dir, { recursive: true });
  const diff = Array.isArray(payload.files) ? payload.files : [];
  const created = diff.filter((item) => item.action === 'added').map((item) => item.file);
  const rewritten = diff.filter((item) => item.action === 'changed').map((item) => item.file);
  const removed = diff.filter((item) => item.action === 'removed').map((item) => item.file);
  await fs.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify({
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
    backupDir,
    hashes,
  }, null, 2)}\n`, 'utf8');
}

/** Memory files currently on disk. */
async function listMemoryFiles(paths) {
  try {
    const names = await fs.readdir(paths.memoryDir);
    return names.filter((name) => name.endsWith('.md') && name !== 'MEMORY.md' && name !== 'SKILL.md');
  } catch {
    return [];
  }
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

/** Mark one switch as undone so the next undo reaches the one before it. */
async function markSwitchUndone(paths, meta) {
  try {
    const raw = JSON.parse(await fs.readFile(meta.file, 'utf8'));
    await fs.writeFile(meta.file, `${JSON.stringify({ ...raw, undone: true, undoneAt: Date.now() }, null, 2)}\n`, 'utf8');
  } catch (error) {
    warn('mark undo', error);
  }
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
