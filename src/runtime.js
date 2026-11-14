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
import { buildPaths, projectLayout, resolveMemoryRoot } from './paths.js';
import { resolveIdentity } from './identity.js';
import { MemoryStore } from './store.js';
import { DreamEngine } from './dream.js';
import { DreamPipeline } from './dream-pipeline.js';
import { isDelegated } from './session-kind.js';
import { ProjectState } from './state.js';
import { loadRules, saveRulesFile } from './rules.js';

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

/**
 * The preset name doubles as the per-agent memory namespace. The host session
 * header has no stable agent-name field, so `agentPreset` is the durable name;
 * fall back to an explicit `name` for embedders that provide one.
 */
function agentNamespace(agent) {
  const header = agent?.session?.header ?? agent?.header ?? {};
  const preset = typeof header.agentPreset === 'string' ? header.agentPreset.trim() : '';
  if (preset) return preset;
  return typeof agent?.name === 'string' ? agent.name.trim() : '';
}

/** Keep the directory name portable and inside `agents/`. */
function safeAgentDirName(name) {
  const safe = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\.+$/u, '')
    .trim()
    .slice(0, 80);
  return safe || '';
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
const OVERRIDE_KEYS = [
  'enabled',
  'autoMemoryEnabled',
  'autoDreamEnabled',
  'autoExtract',
];

export class MemoryRuntime {
  #dreamEngine;
  #dreamPipeline;

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
    /** @type {Map<string, object>} projectDir/agents/<preset> -> one store per named agent */
    this.agentProjects = new Map();
    /** @type {Map<string, Promise<object>>} in-flight per-agent store resolutions */
    this.agentProjectPromises = new Map();
    /** @type {Map<string, Promise<object>>} in-flight agent resolutions */
    this.agentPromises = new Map();
    /** @type {Map<string, Promise<object>>} in-flight workspace resolutions */
    this.workspacePromises = new Map();
    /** @type {Map<string, Promise<object>>} in-flight project resolutions, keyed by project directory */
    this.projectPromises = new Map();
    /** @type {Map<string, {projectId:string,projectRoot:string,source:string,markerPath?:string}>} */
    this.identityByWorkspace = new Map();
    /** @type {Map<string, {turns:number, writeSeq:number, consumedWriteSeq:number, lastTurnAt:number}>} */
    this.turnState = new Map();
    /** Last event seq each session has already offered to auto-extract. */
    this.extractCursors = new Map();
    /** @type {Set<(info:{sessionId:string, agent?:object}) => void>} */
    this.listeners = new Set();
    this.#dreamEngine = new DreamEngine({ runtime: this });
    this.#dreamPipeline = new DreamPipeline({ ctx, runtime: this });
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
    this.turnState.delete(sessionId);
    this.extractCursors.delete(sessionId);
    return this.bySession.delete(sessionId);
  }

  /**
   * Record that this session's model wrote memory during the current turn.
   * Auto-extract uses it as a mutex: if the main agent already saved, a second
   * extractor pass would just duplicate its work.
   */
  noteMemoryWrite(sessionId, at = Date.now()) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const state = this.turnState.get(sessionId) ?? {
      turns: 0,
      writeSeq: 0,
      consumedWriteSeq: 0,
      lastTurnAt: 0,
    };
    state.writeSeq += 1;
    state.lastWriteAt = Number(at) || Date.now();
    this.turnState.set(sessionId, state);
  }

  /**
   * Advance the turn counter at `turn/end` and report whether this turn had a
   * model write after the previous turn ended. The counter is per session and
   * only advanced for mainline (non-delegated) sessions by the scheduler.
   */
  noteTurnEnd(sessionId, at = Date.now()) {
    if (typeof sessionId !== 'string' || sessionId === '') return { turns: 0, wrote: false };
    const state = this.turnState.get(sessionId) ?? {
      turns: 0,
      writeSeq: 0,
      consumedWriteSeq: 0,
      lastTurnAt: 0,
    };
    state.turns += 1;
    const wrote = state.writeSeq > state.consumedWriteSeq;
    state.consumedWriteSeq = state.writeSeq;
    state.lastTurnAt = Number(at) || Date.now();
    this.turnState.set(sessionId, state);
    return { turns: state.turns, wrote };
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

  /**
   * The preset namespace for an agent that opted into private memory, or ''.
   *
   * Only delegated sessions qualify: the main session already owns the shared
   * project store, and `subagentMemory:'own'` is the only mode that opens one.
   * @param {object} agent
   * @returns {string}
   */
  agentMemoryName(agent) {
    const config = this.config;
    if (config.subagentMemory !== 'own') return '';
    if (!isDelegated(agent)) return '';
    const name = agentNamespace(agent);
    const dirName = safeAgentDirName(name);
    if (!dirName) return '';
    const allow = Array.isArray(config.agentMemoryPresets) ? config.agentMemoryPresets : [];
    if (allow.length > 0 && !allow.includes(name)) return '';
    return name;
  }

  /** True when this agent reads and writes `agents/<preset>/memory`. */
  agentMemoryEnabled(agent) {
    return this.agentMemoryName(agent) !== '';
  }

  /** Whether an agent may use the memory snapshot and write its own notes. */
  canWriteMemory(agent) {
    return !isDelegated(agent) || this.config.subagentMemory === 'shared' || this.agentMemoryEnabled(agent);
  }

  /**
   * Open (and cache) the private store for one named agent.
   *
   * The store is deliberately project-local and separate from the main store:
   * its index, history and trash never leak into the shared memory, and Dream
   * never scans it. Rules and global state stay on the base context.
   */
  async _agentContextFor(base, agent, name) {
    const dirName = safeAgentDirName(name);
    const agentsDir = path.join(base.paths.projectDir, 'agents');
    const key = path.resolve(path.join(agentsDir, dirName));
    const cached = this.agentProjects.get(key);
    if (cached) return cached;
    const pending = this.agentProjectPromises.get(key);
    if (pending) return pending;
    const promise = (async () => {
      const paths = { ...base.paths, ...projectLayout(path.join(agentsDir, dirName)) };
      const store = new MemoryStore({ paths, getConfig: () => this.config });
      await store.ensure();
      const projectContext = {
        ...base,
        paths,
        store,
        // Shared state is only used for the main project's Dream cadence; a
        // private agent store never runs Dream.
        state: base.state,
        agent,
        agentMemory: true,
        agentMemoryName: name,
        baseProjectContext: base,
      };
      this.agentProjects.set(key, projectContext);
      return projectContext;
    })().finally(() => this.agentProjectPromises.delete(key));
    this.agentProjectPromises.set(key, promise);
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
    let projectContext = { ...(await this.storeFor(workspaceDir)), agent, sessionId: agent.id };
    const agentMemoryName = this.agentMemoryName(agent);
    if (agentMemoryName) {
      try {
        projectContext = await this._agentContextFor(projectContext, agent, agentMemoryName);
      } catch (error) {
        warn('agent memory', error);
      }
    }
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
    const cwd = cwdHint || (await this._persistedCwd(sessionId));
    if (!cwd) return undefined;
    const projectContext = { ...(await this.storeFor(cwd)), sessionId };
    this.bySession.set(sessionId, projectContext);
    return projectContext;
  }

  /**
   * The directory a saved (not live) session was created in. An old
   * conversation reopened in the app has no agent yet, but its header still
   * names its own project, so it never has to borrow whichever one is loaded.
   */
  async _persistedCwd(sessionId) {
    try {
      const sessionQuery = this.ctx.get('sessionQuery');
      if (!sessionQuery || typeof sessionQuery.filterSessions !== 'function') return '';
      const records = await sessionQuery.filterSessions([{ kind: 'id', values: [sessionId] }]);
      const record = Array.isArray(records) ? records.find((item) => item?.header?.id === sessionId) : undefined;
      const cwd = record?.header?.cwd;
      return typeof cwd === 'string' ? cwd : '';
    } catch (error) {
      warn('sessionQuery.filterSessions', error);
      return '';
    }
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
      // Live provider: runtime toggles must reach an already-open store.
      const store = new MemoryStore({ paths, getConfig: () => this.config });
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

  /** Force one session's injected snapshot to be rebuilt now (manual refresh). */
  refreshSession(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') this.invalidateInjection(sessionId, 'manual');
    return { sessionId };
  }

  /** Subscribe to memory-change notifications. @returns {() => void} dispose. */
  onInvalidate(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start a resumable Dream run and return its id immediately. The pipeline
   * keeps per-unit state, so a later `resumeDreamRun` only redoes what failed.
   */
  async startDream(pctx, options = {}) {
    return this.#dreamPipeline.start({ pctx, ...options });
  }

  /** Run ids a Dream worker in this process is executing. */
  liveDreamRunIds() {
    return this.#dreamPipeline.liveRunIds();
  }

  /** Read one Dream run (or the newest) from disk. */
  async dreamRun(pctx, runId = '') {
    return this.#dreamPipeline.status(pctx, runId);
  }

  /** Ask a running Dream run to stop; finished units stay on disk. */
  async cancelDreamRun(pctx, runId = '') {
    return this.#dreamPipeline.cancel(pctx, runId);
  }

  /** Resume a stopped/failed Dream run, analyzing only the units left. */
  async resumeDreamRun(pctx, runId = '', options = {}) {
    return this.#dreamPipeline.resume(pctx, runId, options);
  }

  async estimateDream(pctx, options = {}) {
    return this.#dreamPipeline.estimate({ pctx, ...options });
  }

  /**
   * Start a dream and wait for its result. Same launcher as {@link startDream};
   * the run never touches the live notes: it ends with a pending copy the human
   * switches to or discards.
   * @param {object} options
   * @returns {Promise<object>}
   */
  async dream({ agent, pctx, sessionId, ...options } = {}) {
    const projectContext = pctx ?? (agent ? await this.forAgent(agent) : await this.forSessionId(sessionId));
    if (!projectContext) {
      return { ran: false, ready: false, skipped: true, skipReason: 'no-project' };
    }
    const started = await this.startDream(projectContext, { agent: agent ?? projectContext.agent, ...options });
    return started.done ? started.done : started;
  }

  /**
   * Switch memory over to the pending copy. The live memory is backed up first,
   * so {@link undoLastDream} can put it back.
   * @param {{agent?:object, pctx?:object}} [options]
   */
  async switchDream({ agent, pctx } = {}) {
    const projectContext = pctx ?? (agent ? await this.forAgent(agent) : undefined);
    if (!projectContext) return { switched: false, error: 'no-project' };
    try {
      const result = await this.#dreamEngine.switchShadow({ pctx: projectContext, agent: agent ?? projectContext.agent });
      if (result && result.switched === true) {
        try {
          this.invalidateAllInjections('dream-switch');
        } catch {
          /* cache refresh is best-effort */
        }
      }
      return result;
    } catch (error) {
      warn('switchDream', error);
      return { switched: false, error: 'switch-failed', message: String(error?.message ?? error) };
    }
  }

  /**
   * Discard the pending copy. Live memory is untouched.
   * @param {{agent?:object, pctx?:object}} [options]
   */
  async discardDream({ agent, pctx } = {}) {
    const projectContext = pctx ?? (agent ? await this.forAgent(agent) : undefined);
    if (!projectContext) return { discarded: false, error: 'no-project' };
    try {
      return await this.#dreamEngine.discardShadow({ pctx: projectContext });
    } catch (error) {
      warn('discardDream', error);
      return { discarded: false, error: 'discard-failed', message: String(error?.message ?? error) };
    }
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
      const result = await this.#dreamEngine.undoLastDream({ pctx: projectContext, agent: agent ?? projectContext.agent });
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
