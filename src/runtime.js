/**
 * Runtime registry: one project context per workspace, one per live agent.
 *
 * Everything memory-facing resolves through this object so the store, state,
 * prompt cache, tools, commands and the dream scheduler all agree on the same
 * directory and the same cadence state.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createHash } from 'node:crypto';
import { buildPaths, resolveMemoryRoot } from './paths.js';
import { resolveIdentity } from './identity.js';
import { MemoryStore } from './store.js';
import { ProjectState } from './state.js';
import { loadRules, saveRulesFile, clearRulesFile } from './rules.js';

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

/**
 * Add the v7 UI summary fields to a dream run result:
 * `path` (plan/proposal/backup location), `ops` (operation count) and
 * `durationMs` (wall-clock duration of the run).
 */
function withDreamSummary(result) {
  if (!result || typeof result !== 'object') return result;
  const path = typeof result.planPath === 'string' && result.planPath !== ''
    ? result.planPath
    : (typeof result.proposalPath === 'string' && result.proposalPath !== ''
      ? result.proposalPath
      : (typeof result.backupDir === 'string' ? result.backupDir : ''));
  const ops = Array.isArray(result.operations)
    ? result.operations.length
    : (Number.isFinite(Number(result.operations)) ? Number(result.operations) : 0);
  const durationMs = Number.isFinite(Number(result.durationMs))
    ? Math.max(0, Math.trunc(Number(result.durationMs)))
    : Math.max(0, (Number(result.finishedAt) || 0) - (Number(result.startedAt) || 0));
  return { ...result, path, ops, durationMs };
}

/** Boolean runtime overrides users may toggle without editing the profile. */
const OVERRIDE_KEYS = ['enabled', 'autoMemoryEnabled', 'autoDreamEnabled', 'userMemoryEnabled'];

export class MemoryRuntime {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {Readonly<Record<string, unknown>>} config
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.baseConfig = config;
    this.homeDir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    /** Global runtime override file; toggles apply immediately, no reload. */
    this.overrideFile = path.join(resolveMemoryRoot(config.memoryRoot, this.homeDir), '.plugin-state.json');
    this._overrideCache = { at: 0, data: {} };
    /** @type {Map<string, {workspaceDir:string, paths:ReturnType<typeof buildPaths>, store:MemoryStore, state:ProjectState}>} */
    this.byWorkspace = new Map();
    /** @type {Map<string, object>} */
    this.bySession = new Map();
    this.maxSessionCache = 500;
    /** @type {Map<string, object>} projectRoot -> one context per project (shared across subdirectories) */
    this.byProject = new Map();
    /** @type {Map<string, Promise<object>>} in-flight agent resolutions */
    this.agentPromises = new Map();
    /** @type {Map<string, Promise<object>>} in-flight workspace resolutions */
    this.workspacePromises = new Map();
    /** @type {Map<string, Promise<object>>} in-flight project resolutions, keyed by project directory */
    this.projectPromises = new Map();
    /** @type {Map<string, {projectId:string,projectRoot:string,source:string,markerPath?:string}>} */
    this.identityByWorkspace = new Map();
    /** @type {Map<string, 'live'|'auto'>} per-session injection mode (v9) */
    this.sessionModes = new Map();
    /** @type {Set<(info:{sessionId:string, agent?:object}) => void>} */
    this.listeners = new Set();
    this.enginePromise = null;
    /** Background promises tracked so dispose() can drain them. */
    this.pending = new Set();
  }

  /**
   * Effective configuration: the resolved row config merged with the live
   * runtime overrides written by `/memory plugin on|off` and the Web UI.
   * Read `runtime.config` everywhere so toggles apply without a reload.
   */
  get config() {
    const overrides = this.overrides();
    let merged = this.baseConfig;
    for (const key of OVERRIDE_KEYS) {
      if (typeof overrides[key] === 'boolean') {
        if (merged === this.baseConfig) merged = { ...this.baseConfig };
        merged[key] = overrides[key];
      }
    }
    return Object.freeze(merged === this.baseConfig ? this.baseConfig : merged);
  }

  /** Track one background promise so `drain()` can wait for it. */
  track(promise) {
    const pending = Promise.resolve(promise).catch(() => {}).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
    return pending;
  }

  /** Wait until every tracked background promise settled. */
  async drain() {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /** Snapshot of the persistent boolean overrides (1s cache, external edits visible). */
  overrides() {
    const now = Date.now();
    if (this._overrideCache && now - this._overrideCache.at < 1000) return this._overrideCache.data;
    let data = {};
    try {
      const stat = fsSync.statSync(this.overrideFile);
      if (stat.isFile()) {
        const parsed = JSON.parse(fsSync.readFileSync(this.overrideFile, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
      }
    } catch {
      data = {};
    }
    const clean = {};
    for (const key of OVERRIDE_KEYS) {
      if (typeof data[key] === 'boolean') clean[key] = data[key];
    }
    this._overrideCache = { at: now, data: clean };
    return clean;
  }

  /**
   * Merge and persist runtime overrides, then refresh every prompt cache.
   * @param {{enabled?:boolean, autoMemoryEnabled?:boolean, autoDreamEnabled?:boolean}} patch
   * @returns {Promise<object>} the persisted overrides.
   */
  async setOverrides(patch) {
    const next = { ...this.overrides() };
    for (const key of OVERRIDE_KEYS) {
      if (patch && typeof patch[key] === 'boolean') next[key] = patch[key];
    }
    await fs.mkdir(path.dirname(this.overrideFile), { recursive: true });
    const temporary = `${this.overrideFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.overrideFile);
    this._overrideCache = { at: Date.now(), data: next };
    this.invalidateAllInjections("config");
    return next;
  }

  /** True unless the master switch is off. */
  effectiveEnabled() {
    return this.config.enabled !== false;
  }

  /** Resolve the editable rules for one project (project > global > default). */
  rulesFor(projectContext) {
    const maxChars = Number(this.config.rulesMaxChars) || 8000;
    return loadRules(projectContext?.paths ?? {}, { maxChars });
  }

  /** Persist a rules override for one scope and refresh the prompt caches. */
  async saveRules(projectContext, scope, text, options = {}) {
    const file =
      scope === 'global'
        ? projectContext?.paths?.globalRulesFile
        : projectContext?.paths?.projectRulesFile;
    await saveRulesFile(file, text);
    await this._auditRulesChange(projectContext, scope, text, options.source || 'api');
    this.invalidateAllInjections("rules");
    return this.rulesFor(projectContext);
  }

  /** Remove one rules override (project or global). */
  async resetRules(projectContext, scope, options = {}) {
    const file =
      scope === 'global'
        ? projectContext?.paths?.globalRulesFile
        : projectContext?.paths?.projectRulesFile;
    await clearRulesFile(file);
    await this._auditRulesChange(projectContext, scope, '', options.source || 'api');
    this.invalidateAllInjections("rules");
    return this.rulesFor(projectContext);
  }

  /** Append one audit line for a rules change (persistent prompt surface). */
  async _auditRulesChange(projectContext, scope, text, source) {
    try {
      const file = projectContext?.paths?.rulesLogFile;
      if (!file) return;
      const value = typeof text === 'string' ? text : '';
      const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
      const line = `${new Date().toISOString()} scope=${scope} source=${source} bytes=${Buffer.byteLength(value)} sha256=${digest} preview=${JSON.stringify(value.slice(0, 120))}\n`;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, line, 'utf8');
    } catch (error) {
      warn('rules audit', error);
    }
  }

  /** Refresh every known session's injected prompt text. */
  invalidateAllInjections(reason = "config") {
    for (const sessionId of [...this.bySession.keys()]) {
      this.invalidateInjection(sessionId, reason);
    }
  }

  /** Drop every cached reference for one disposed session (v12 leak fix). */
  forgetSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    this.agentPromises.delete(sessionId);
    this.sessionModes.delete(sessionId);
    return this.bySession.delete(sessionId);
  }

  /** @returns {Promise<object|undefined>} project context for one live agent. */
  async forAgent(agent) {
    if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string') return undefined;
    const cached = this.bySession.get(agent.id);
    if (cached) {
      cached.agent = agent;
      return cached;
    }
    const pending = this.agentPromises.get(agent.id);
    if (pending) return pending;
    const promise = this._resolveAgent(agent).finally(() => this.agentPromises.delete(agent.id));
    this.agentPromises.set(agent.id, promise);
    return promise;
  }

  /** Resolve one agent once; `forAgent` dedupes concurrent first calls. */
  async _resolveAgent(agent) {
    let workspaceDir = '';
    try {
      const workingDirectory = this.ctx.get('workingDirectory');
      if (workingDirectory && typeof workingDirectory.ensure === 'function') {
        workspaceDir = await workingDirectory.ensure(agent);
      }
    } catch (error) {
      warn('workingDirectory.ensure', error);
    }
    if (!workspaceDir) {
      // Never guess a project from the Host process cwd: that would write this
      // session's memory into an unrelated project directory.
      warn('workingDirectory', new Error('no working directory for this session; memory features are disabled for it'));
      return undefined;
    }
    const projectContext = { ...(await this.storeFor(workspaceDir)), agent, sessionId: agent.id };
    this.bySession.delete(agent.id);
    this.bySession.set(agent.id, projectContext);
    while (this.bySession.size > this.maxSessionCache) {
      const oldest = this.bySession.keys().next().value;
      if (oldest === undefined) break;
      this.bySession.delete(oldest);
    }
    return projectContext;
  }

  /** @returns {Promise<object|undefined>} project context for a session id. */
  async forSessionId(sessionId, cwdHint) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    const cached = this.bySession.get(sessionId);
    if (cached) return cached;
    const pending = this.agentPromises.get(sessionId);
    if (pending) return pending;
    const promise = this._resolveSession(sessionId, cwdHint).finally(() => this.agentPromises.delete(sessionId));
    this.agentPromises.set(sessionId, promise);
    return promise;
  }

  /** Resolve one session once, preferring its live agent. */
  async _resolveSession(sessionId, cwdHint) {
    try {
      const agents = this.ctx.get('agents');
      const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
      if (agent) return this.forAgent(agent);
    } catch (error) {
      warn('agents.get', error);
    }
    if (!cwdHint) return undefined;
    const projectContext = { ...(await this.storeFor(cwdHint)), sessionId };
    this.bySession.set(sessionId, projectContext);
    return projectContext;
  }

  /**
   * Resolve (and cache) the project context for a workspace directory.
   *
   * Memory is keyed by the project root (the git repository root, or the
   * workspace itself without git), so `repo/` and `repo/pkg` share one store
   * and one state file instead of racing two instances over the same files.
   * @param {string} workspaceDir absolute working directory.
   */
  /** Resolve (and cache) the project identity for a workspace. */
  identityFor(workspaceDir) {
    const key = path.resolve(String(workspaceDir || process.cwd()));
    const cached = this.identityByWorkspace.get(key);
    if (cached) return cached;
    const identity = resolveIdentity({ workspaceDir: key, config: this.config });
    this.identityByWorkspace.set(key, identity);
    return identity;
  }

  async storeFor(workspaceDir) {
    const key = path.resolve(String(workspaceDir || process.cwd()));
    const cached = this.byWorkspace.get(key);
    if (cached) return cached;
    const pending = this.workspacePromises.get(key);
    if (pending) return pending;
    const identity = this.identityFor(key);
    const promise = this._openProject(key, identity).finally(() => this.workspacePromises.delete(key));
    this.workspacePromises.set(key, promise);
    return promise;
  }

  /** Open and cache one project; concurrent opens of one project share one promise. */
  async _openProject(workspaceKey, identity) {
    const resolvedIdentity = identity || this.identityFor(workspaceKey);
    const paths = buildPaths({
      memoryRoot: this.config.memoryRoot,
      homeDir: this.homeDir,
      workspaceDir: workspaceKey,
      projectId: resolvedIdentity.projectId,
    });
    const projectKey = path.resolve(paths.projectDir);
    const resident = this.byProject.get(projectKey);
    if (resident) {
      this.byWorkspace.set(workspaceKey, resident);
      return resident;
    }
    const pending = this.projectPromises.get(projectKey);
    if (pending) {
      const shared = await pending;
      this.byWorkspace.set(workspaceKey, shared);
      return shared;
    }
    const promise = (async () => {
      const store = new MemoryStore({
        paths,
        config: this.config,
        // Live provider: runtime toggles must reach an already-open store.
        getConfig: () => this.config,
      });
      await store.ensure();
      const state = new ProjectState(paths);
      await state.load();
      const projectContext = { workspaceDir: workspaceKey, paths, store, state, identity: resolvedIdentity };
      this.byProject.set(projectKey, projectContext);
      return projectContext;
    })().finally(() => this.projectPromises.delete(projectKey));
    this.projectPromises.set(projectKey, promise);
    const projectContext = await promise;
    this.byWorkspace.set(workspaceKey, projectContext);
    return projectContext;
  }

  /** Every resolved project context, one per project root (debugging/status). */
  projects() {
    return [...this.byProject.values()];
  }

  /** Notify prompt-cache owners that one session's memory changed. */
  invalidateInjection(sessionId, reason = "memory-write") {
    for (const listener of [...this.listeners]) {
      try {
        listener({ sessionId, agent: this.bySession.get(sessionId)?.agent, reason });
      } catch (error) {
        warn('invalidate listener', error);
      }
    }
  }

  /**
   * Per-session injection mode (v9): 'live' refreshes on every memory change,
   * 'auto' follows the configured injectionMode. Returns the effective mode.
   */
  setSessionMode(sessionId, mode) {
    if (typeof sessionId !== 'string' || sessionId === '') return 'auto';
    if (mode === 'live') this.sessionModes.set(sessionId, 'live');
    else this.sessionModes.delete(sessionId);
    this.invalidateInjection(sessionId, 'manual');
    return this.sessionMode(sessionId);
  }

  /** @returns {'live'|'auto'} */
  sessionMode(sessionId) {
    return this.sessionModes.get(sessionId) === 'live' ? 'live' : 'auto';
  }

  /** Force one session's injected text to be rebuilt now (manual refresh). */
  refreshSession(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') this.invalidateInjection(sessionId, 'manual');
    return { sessionId, live: this.sessionMode(sessionId) === 'live' };
  }

  /** Subscribe to memory-change notifications. @returns {() => void} dispose. */
  onInvalidate(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lazily construct the dream engine, which imports the dream module once. */
  async engine() {
    if (!this.enginePromise) {
      this.enginePromise = import('./dream.js').then(({ DreamEngine }) => new DreamEngine({
        ctx: this.ctx,
        runtime: this,
        config: this.config,
        // Live provider: toggles apply to the already-created engine too.
        getConfig: () => this.config,
      }));
    }
    return this.enginePromise;
  }

  async estimateDream(pctx, options = {}) {
    const engine = await this.engine();
    return engine.estimate({ pctx, ...options });
  }

  /**
   * Read the newest available dream plan: a review proposal first, then the last
   * dry-run plan. Both are plan JSON files recorded in the project state.
   * @param {object} projectContext
   * @returns {Promise<{path:string, plan?:object, error?:string}>}
   */
  async latestPlan(projectContext) {
    let snapshot = {};
    try {
      snapshot = projectContext?.state && typeof projectContext.state.snapshot === 'function'
        ? projectContext.state.snapshot()
        : {};
    } catch {
      snapshot = {};
    }
    const candidates = [snapshot.pendingProposal, snapshot.lastPlanPath]
      .filter((value) => typeof value === 'string' && value !== '');
    for (const file of candidates) {
      try {
        const plan = JSON.parse(await fs.readFile(file, 'utf8'));
        if (plan && typeof plan === 'object' && !Array.isArray(plan)) return { path: file, plan };
      } catch (error) {
        warn('read dream plan', error);
      }
    }
    return { path: '', plan: undefined, error: 'no-plan' };
  }

  /**
   * Diff the latest available plan against the current memory without applying
   * anything. Read-only; safe to call from the Web UI.
   * @param {object} pctx
   * @returns {Promise<{path:string, summary:string, ops:object[],
   *   truncatedFiles:string[], dropped:string[], error?:string}>}
   */
  async previewPlan(pctx) {
    const projectContext = pctx && typeof pctx === 'object' && pctx.paths ? pctx : pctx?.pctx;
    if (!projectContext) {
      return { path: '', summary: '', ops: [], truncatedFiles: [], dropped: [], error: 'no-project' };
    }
    const { path: planPath, plan, error } = await this.latestPlan(projectContext);
    if (!plan) {
      return { path: '', summary: '', ops: [], truncatedFiles: [], dropped: [], error: error || 'no-plan' };
    }
    const engine = await this.engine();
    if (typeof engine.previewPlan !== 'function') {
      return {
        path: planPath,
        summary: '',
        ops: [],
        truncatedFiles: [],
        dropped: [],
        error: 'engine-missing-previewPlan',
      };
    }
    return engine.previewPlan({ pctx: projectContext, plan, path: planPath });
  }

  /**
   * Apply a subset of the latest plan's operations by zero-based index.
   * @param {object} pctx
   * @param {{indexes?: number[], agent?: object}} [options]
   * @returns {Promise<{applied:boolean, ops:number, path:string,
   *   rolledBack?:boolean, error?:string}>}
   */
  async applyPlanOperations(pctx, options = {}) {
    const projectContext = pctx && typeof pctx === 'object' && pctx.paths ? pctx : pctx?.pctx;
    const opts = options && typeof options === 'object' ? options : {};
    if (!projectContext) return { applied: false, ops: 0, path: '', error: 'no-project' };
    const { path: planPath, plan, error } = await this.latestPlan(projectContext);
    if (!plan) return { applied: false, ops: 0, path: '', error: error || 'no-plan' };
    const engine = await this.engine();
    if (typeof engine.applyPlanOperations !== 'function') {
      return { applied: false, ops: 0, path: planPath, error: 'engine-missing-applyPlanOperations' };
    }
    return engine.applyPlanOperations({
      pctx: projectContext,
      agent: opts.agent ?? projectContext.agent,
      plan,
      path: planPath,
      indexes: opts.indexes,
    });
  }

  /**
   * Reject the pending review proposal (delete the proposal file, clear the
   * state pointer, count a `rejected` dream metric). The inline reject path in
   * `status.js` still works without this; new callers should prefer it.
   * @param {object} pctx
   * @returns {Promise<{rejected:boolean, proposalPath?:string, reason?:string, error?:string}>}
   */
  async rejectPendingPlan(pctx) {
    const projectContext = pctx && typeof pctx === 'object' && pctx.paths ? pctx : pctx?.pctx;
    if (!projectContext) return { rejected: false, reason: 'no-project' };
    const engine = await this.engine();
    if (typeof engine.rejectPlan !== 'function') {
      return { rejected: false, reason: 'engine-missing-rejectPlan' };
    }
    return engine.rejectPlan({ pctx: projectContext });
  }

  /** Alias for {@link rejectPendingPlan}. */
  async rejectPlan(pctx) {
    return this.rejectPendingPlan(pctx);
  }

  /**
   * Run one dream pass. `force` bypasses the time/session gates (manual runs).
   * @returns {Promise<object>} DreamRunResult as defined in INTERFACES.md.
   */
  async dream({ agent, pctx, sessionId, force = false, dryRun = false, trigger = 'auto', reason, signal, noSessions = false, focus = '' } = {}) {
    let projectContext = pctx;
    if (!projectContext) {
      projectContext = agent ? await this.forAgent(agent) : await this.forSessionId(sessionId);
    }
    if (!projectContext) {
      return { ran: false, skipped: true, skipReason: 'no-project', applied: false, dryRun: Boolean(dryRun) };
    }
    const engine = await this.engine();
    const result = await engine.run({
      pctx: projectContext,
      agent: agent ?? projectContext.agent,
      force,
      dryRun,
      trigger,
      reason,
      signal,
      noSessions: noSessions === true,
      focus,
    });
    // v7: `{ path, ops, durationMs }` for UI display (added on top of the full result).
    return withDreamSummary(result);
  }

  /** Apply the proposal written by a `review`-mode dream. */
  async applyPendingDream({ agent, pctx } = {}) {
    const projectContext = pctx ?? (agent ? await this.forAgent(agent) : undefined);
    if (!projectContext) return { applied: false, error: 'no-project' };
    const proposalPath = projectContext.state.snapshot().pendingProposal;
    if (!proposalPath) return { applied: false, error: 'no-pending-proposal' };
    let plan;
    try {
      plan = JSON.parse(await fs.readFile(proposalPath, 'utf8'));
    } catch (error) {
      return { applied: false, error: `proposal-unreadable: ${error?.message ?? error}` };
    }
    const engine = await this.engine();
    if (typeof engine.applyPending !== 'function') {
      return { applied: false, error: 'engine-missing-applyPending' };
    }
    return engine.applyPending({ pctx: projectContext, agent, plan, proposalPath });
  }

  /**
   * Apply the plan produced by the last dry run: the exact same plan object,
   * not a freshly generated one. Clears the recorded plan afterwards.
   */
  async applyLastPlan({ agent, pctx } = {}) {
    const projectContext = pctx ?? (agent ? await this.forAgent(agent) : undefined);
    if (!projectContext) return { applied: false, error: 'no-project' };
    const planPath = projectContext.state.snapshot().lastPlanPath;
    if (!planPath) return { applied: false, error: 'no-last-plan' };
    let plan;
    try {
      plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    } catch (error) {
      return { applied: false, error: `plan-unreadable: ${error?.message ?? error}` };
    }
    const engine = await this.engine();
    if (typeof engine.applyPending !== 'function') {
      return { applied: false, error: 'engine-missing-applyPending' };
    }
    const result = await engine.applyPending({
      pctx: projectContext,
      agent,
      plan,
      proposalPath: planPath,
      fromLastPlan: true,
    });
    // Only consume the saved plan when it was actually applied: a locked or
    // failed attempt must keep the pointer so the user can retry.
    if (result && result.applied === true) {
      try {
        await projectContext.state.clearLastPlan();
      } catch (error) {
        warn('state.clearLastPlan', error);
      }
    }
    return result;
  }

  /**
   * Undo the most recent applied dream batch (v10): restores the pre-apply
   * backup, trashes files created after it, restores the index and reconciles.
   * @param {object|string} projectContextOrAgent project context, or an agent.
   * @param {{agent?:object}} [options]
   */
  async undoLastDream(projectContextOrAgent, options = {}) {
    let projectContext = projectContextOrAgent;
    let agent = options.agent;
    const looksLikeContext =
      projectContext
      && typeof projectContext === 'object'
      && projectContext.paths
      && projectContext.store;
    if (!looksLikeContext) {
      const targetAgent = agent ?? projectContextOrAgent;
      projectContext = targetAgent ? await this.forAgent(targetAgent) : undefined;
      agent = targetAgent;
    }
    if (!projectContext) return { ok: false, error: 'no-project' };
    try {
      const engine = await this.engine();
      if (typeof engine.undoLastDream !== 'function') return { ok: false, error: 'not-ready' };
      const result = await engine.undoLastDream({ pctx: projectContext, agent: agent ?? projectContext.agent });
      try {
        this.invalidateAllInjections('undo');
      } catch {
        /* cache refresh is best-effort */
      }
      return result;
    } catch (error) {
      warn('undoLastDream', error);
      return { ok: false, error: 'undo-failed', message: String(error?.message ?? error) };
    }
  }
}
