/**
 * Prompt injection: register one dynamic prompt context per live agent that
 * advertises the project memory directory, the memory rules, and the head of
 * `MEMORY.md`.
 *
 * `systemPrompt.context()` needs a synchronous `text` function, so this module
 * owns a `Map<sessionId, string>` cache: it is filled asynchronously on agent
 * creation, on runtime invalidation (a memory write) and by a slow refresh
 * timer, while the prompt provider only reads the cache.
 *
 * The context registration lives on `agent.ctx` so it disappears with the agent;
 * its disposer is also kept here so plugin unload removes it too. Every failure
 * degrades to an empty injected string plus a `console.warn` — never a throw
 * into the host.
 *
 * @module dsh-cc-dream-memory/inject
 */
import { readMetrics, recordInjection } from './metrics.js';
import { CORE_RULES, DEFAULT_RULES } from './rules.js';
import { attachRecall } from './recall.js';

/** Prompt-context name; a scoped registration shadows another with this name. */
export const CONTEXT_NAME = 'cc-memory';
const DEFAULT_ORDER = 850;
const DEFAULT_REFRESH_MS = 30_000;
const MIN_REFRESH_MS = 5_000;

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

/**
 * Build the stable injected text from already-read index data.
 *
 * Exported as a pure function so the `memory_status` tool can render the same
 * preview without touching the prompt cache.
 *
 * @param {{
 *   memoryDir: string,
 *   userMemoryDir?: string,
 *   config?: Record<string, any>,
 *   index?: {text?:string,lines?:number,bytes?:number,overflow?:boolean,
 *     maxLines?:number,maxBytes?:number},
 *   user?: {text?:string,overflow?:boolean,maxLines?:number,maxBytes?:number}|null,
 * }} input
 * @returns {string}
 */
export function buildInjectionText(input = {}) {
  const config = input.config && typeof input.config === 'object' ? input.config : {};
  const memoryDir = String(input.memoryDir ?? '');
  const index = input.index && typeof input.index === 'object' ? input.index : {};
  const lines = [];
  lines.push('<system-reminder>');
  lines.push('Auto memory is enabled for this project (managed by the dsh-cc-dream-memory plugin).');
  lines.push('');
  lines.push(
    'MEMORY.md is an index of durable notes written by you in earlier sessions. Topic files load only when you read them.',
  );
  lines.push('');
  lines.push('Rules:');
  const rulesText = typeof input.rules === 'string' ? input.rules.trim() : '';
  const usesDefault =
    input.rulesSource === 'default' || (input.rulesSource === undefined && rulesText === DEFAULT_RULES);
  if (usesDefault || rulesText === '') {
    lines.push(DEFAULT_RULES);
  } else {
    // The mandatory rules come first and can never be deleted by an override;
    // the user's rules file is appended after them.
    lines.push(CORE_RULES);
    lines.push(rulesText);
  }
  lines.push('');
  lines.push('When to save:');
  lines.push('- The user corrects you, states a preference or working style, says "remember", or confirms a non-obvious approach: save it immediately.');
  lines.push('- A project decision or deadline appears that the repository does not record: save it immediately.');
  lines.push('- If a related memory file already exists, use memory_update instead of creating a new note.');
  lines.push('- Test the result: would a teammate joining tomorrow need this and fail to find it in the repository? If yes, save it.');
  lines.push('- Skip version numbers, test counts, commit hashes, line counts, progress logs and one-off tasks.');
  lines.push('');
  lines.push('How to write and use a memory:');
  lines.push('- State the fact first. For feedback and project memories add **Why:** and **How to apply:** lines, and keep your own inferences labelled as inferences.');
  const now = input.now instanceof Date ? input.now : new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  lines.push(`- Today's date is ${today}. Convert relative dates ("yesterday", "next Friday") to an absolute date, and never guess a date you were not given.`);
  lines.push('- If a memory names a file, function or flag, check it still exists before recommending it.');
  lines.push('- When a note no longer holds, update it or remove it with memory_update (delete: true).');
  lines.push('- Questions about what happened in past sessions are answered from session history (session_search, if available) and the repository, not from memory.');

  if (config.injectIndex !== false) {
    lines.push('');
    lines.push('<index>');
    const head = typeof index.text === 'string' ? index.text : '';
    lines.push(head === '' ? '(empty — no memories saved yet)' : head.replace(/\n$/, ''));
    lines.push('</index>');
    const actualLines = Number(index.totalLines ?? index.lines ?? 0);
    const actualBytes = Number(index.totalBytes ?? index.bytes ?? 0);
    if (index.overflow === true) {
      lines.push(
        `<budget-notice>index is over budget (${actualLines} lines/${actualBytes} bytes; ` +
          `limit ${index.maxLines ?? 0} lines/${index.maxBytes ?? 0} bytes); the oldest and newest lines are injected, older middle entries are omitted. ` +
          'Merge related notes with memory_update (delete: true removes one); use memory_search/memory_read for details. ' +
          'The human can consolidate from the Memory page (Dry run) or /dream run.</budget-notice>',
      );
    } else if (
      Number(index.maxLines) > 0 &&
      Number(index.maxBytes) > 0 &&
      (actualLines / Number(index.maxLines) >= 0.8 || actualBytes / Number(index.maxBytes) >= 0.8)
    ) {
      lines.push(
        `<budget-notice>index is nearing its budget (${actualLines}/${index.maxLines ?? 0} lines, ` +
          `${actualBytes}/${index.maxBytes ?? 0} bytes). Merge related notes with memory_update (delete: true removes one) and avoid duplicates; ` +
          'ask the human to consolidate if it fills up.</budget-notice>',
      );
    }
  } else {
    lines.push('');
    lines.push('Index injection is disabled by configuration; use the memory_* tools to read MEMORY.md.');
  }

  const user = input.user;
  if (config.userMemoryEnabled === true && user && typeof user.text === 'string' && user.text !== '') {
    lines.push('');
    lines.push('User-level memory is enabled (shared across projects, managed by the plugin).');
    lines.push('<user-index>');
    lines.push(user.text.replace(/\n$/, ''));
    lines.push('</user-index>');
    if (user.overflow === true) {
      lines.push(
        `<budget-notice>the user MEMORY.md index is over budget (${user.maxLines ?? 0} lines/${user.maxBytes ?? 0} bytes); only its head is injected.</budget-notice>`,
      );
    }
  }

  const digest = typeof input.digest === 'string' ? input.digest.trim() : '';
  if (digest !== '') {
    lines.push('');
    lines.push('<memory-digest>');
    lines.push(digest);
    lines.push('</memory-digest>');
  }

  lines.push('</system-reminder>');
  return lines.join('\n');
}

/**
 * Register the memory prompt context for every existing agent and every agent
 * created while this plugin is loaded.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} runtime `MemoryRuntime` from `src/runtime.js`.
 * @param {Record<string, any>} [configOverride] resolved config when the
 *   runtime does not carry it (the runtime normally does).
 * @returns {() => void} disposer removing every listener, timer and
 *   per-agent context registration.
 */
export function registerInjection(ctx, runtime, configOverride) {
  const config = configOverride ?? runtime?.config ?? {};
  // NOTE: `autoMemoryEnabled` is checked per refresh (not here) so `/memory on`
  // and the Web toggle can turn injection back on without reloading the plugin.
  /** Effective configuration at call time (runtime overrides included). */
  const configNow = () => {
    try {
      return runtime?.config ?? config;
    } catch {
      return config;
    }
  };
  /**
   * Effective mode for one agent: a per-session `live` choice (v9) wins over
   * the configured mode. `session` freezes one snapshot; `live` refreshes on
   * every memory change.
   */
  const injectionMode = (agent) => {
    try {
      if (runtime && typeof runtime.sessionMode === 'function' && runtime.sessionMode(agent?.id) === 'live') {
        return 'live';
      }
    } catch {
      /* fall back to the configured mode */
    }
    return configNow().injectionMode === 'live' ? 'live' : 'session';
  };
  /** Whether delegated (teammate/subagent) sessions also receive the index. */
  const subagentsInjected = () => configNow().injectSubagents !== false;
  /** Delegated child sessions carry a parentSession id or a subagent origin. */
  const isDelegatedAgent = (agent) => {
    try {
      const header = agent?.session?.header ?? agent?.header;
      return Boolean(header && (header.parentSession || header.origin === 'subagent'));
    } catch {
      return false;
    }
  };
  const shouldInject = (agent) => subagentsInjected() || !isDelegatedAgent(agent);

  /** Run one background refresh under the runtime's drain tracking. */
  const runInBackground = (promise, scope) => {
    if (runtime && typeof runtime.track === 'function') runtime.track(promise);
    else void Promise.resolve(promise).catch((error) => warn(scope, error));
  };
  const orderValue = Number(config.contextOrder);
  const order = Number.isFinite(orderValue) ? orderValue : DEFAULT_ORDER;
  const refreshValue = Number(config.refreshIntervalMs);
  const refreshMs = Math.max(
    MIN_REFRESH_MS,
    Number.isFinite(refreshValue) && refreshValue > 0 ? Math.trunc(refreshValue) : DEFAULT_REFRESH_MS,
  );

  /** @type {Map<string, string>} sessionId -> injected text */
  const cache = new Map();
  /** @type {Map<string, {agent:object,dispose:(()=>void)|null,running:boolean,dirty:boolean,dead:boolean}>} */
  const records = new Map();
  /** @type {Array<() => void>} */
  const cleanups = [];
  let disposed = false;

  /** Resolve the agents service through the optional accessor. */
  const agentsService = () => {
    try {
      if (typeof ctx.get === 'function') return ctx.get('agents');
      return ctx.agents;
    } catch {
      return undefined;
    }
  };

  /** Every live agent, in registration order. */
  const listAgents = () => {
    try {
      const agents = agentsService();
      return agents && typeof agents.list === 'function' ? agents.list() : [];
    } catch (error) {
      warn('agents.list', error);
      return [];
    }
  };

  /** Live agent lookup for an invalidation that arrived without the agent. */
  const liveAgent = (sessionId) => {
    try {
      const agents = agentsService();
      if (!agents || typeof agents.get !== 'function') return undefined;
      return agents.get(sessionId);
    } catch {
      return undefined;
    }
  };

  /** Build one agent's injected text from the current store contents. */
  const buildText = async (agent, reason = '') => {
    const effective = configNow();
    if (effective.enabled === false || effective.autoMemoryEnabled === false) return '';
    if (!shouldInject(agent)) return '';
    const projectContext = await runtime?.forAgent?.(agent);
    if (!projectContext || disposed) return '';
    const store = projectContext.store;
    const paths = projectContext.paths;
    if (!store || !paths || typeof store.injectedIndex !== 'function') return '';
    const index = await store.injectedIndex('project');
    let user = null;
    if (effective.userMemoryEnabled === true) {
      try {
        const userIndex = await store.injectedIndex('user', {
          maxLines: Number(effective.userIndexMaxLines) || undefined,
          maxBytes: Number(effective.userIndexMaxBytes) || undefined,
        });
        if (userIndex && typeof userIndex.text === 'string' && userIndex.text !== '') user = userIndex;
      } catch (error) {
        warn('user index', error);
      }
    }
    let digest = '';
    if (reason === 'compaction' && effective.compactionDigest !== false) {
      try {
        const entries = typeof store.listEntries === 'function' ? await store.listEntries('project') : [];
        const recent = [...entries]
          .sort((left, right) => (Date.parse(right.modified) || 0) - (Date.parse(left.modified) || 0))
          .slice(0, 5);
        const metrics = await readMetrics(paths).catch(() => null);
        const topRead = metrics && metrics.entries && typeof metrics.entries === 'object'
          ? Object.entries(metrics.entries)
              .filter(([, value]) => value && value.reads > 0)
              .sort((left, right) => right[1].reads - left[1].reads)
              .slice(0, 3)
              .map(([file]) => file)
          : [];
        const lines = [];
        for (const entry of recent) {
          lines.push('- recently updated: [' + entry.name + '](' + entry.file + ') — ' + String(entry.description || '').slice(0, 120));
        }
        for (const file of topRead) {
          const entry = entries.find((candidate) => candidate.file === file);
          if (entry) lines.push('- most read: [' + entry.name + '](' + entry.file + ') — ' + String(entry.description || '').slice(0, 120));
        }
        digest = lines.join('\n').slice(0, 400);
      } catch (error) {
        warn('compaction digest', error);
      }
    }

    let rules;
    let rulesSource;
    try {
      const loadedRules = runtime?.rulesFor?.(projectContext);
      rules = loadedRules?.text;
      rulesSource = loadedRules?.source;
    } catch (error) {
      warn('rules', error);
      rules = undefined;
      rulesSource = undefined;
    }
    const text = buildInjectionText({
      memoryDir: paths.memoryDir,
      userMemoryDir: paths.userMemoryDir,
      config: effective,
      index,
      user,
      rules,
      rulesSource,
      digest,
    });
    // Effect metrics: count each successful non-empty injection. Fire-and-forget
    // through the runtime so unload/drain and tests can await it; a metrics
    // failure never blocks or changes the injected text.
    if (text !== '') {
      runInBackground(recordInjection(paths), 'record injection');
    }
    return text;
  };

  /** Order refresh reasons so a newer, stronger reason wins over init/timer. */
  const REASON_PRIORITY = { init: 0, timer: 0, 'memory-write': 0, expired: 1, config: 2, rules: 2, compaction: 3, manual: 3, undo: 2 };
  const mergeReason = (current, next) => {
    const left = REASON_PRIORITY[current] ?? 0;
    const right = REASON_PRIORITY[next] ?? 0;
    return right >= left ? next : current;
  };

  /**
   * Rebuild the cached text for one agent, coalescing concurrent refreshes.
   *
   * In the default `session` mode the snapshot is frozen after the first build:
   * memory writes, dream runs, other sessions' updates and the periodic timer
   * do not change it. Only a configuration/rules change (explicit user action)
   * or a compaction (the request prefix is invalid then anyway) refreshes it.
   * `live` mode keeps the previous always-refresh behavior.
   */
  const refresh = (agent, reason = 'init') => {
    const sessionId = agent?.id;
    if (disposed || typeof sessionId !== 'string' || sessionId === '') return Promise.resolve();
    const record = records.get(sessionId);
    if (record) {
      record.agent = agent;
      if (injectionMode(agent) === 'session' && record.built === true) {
        const forced = reason === 'config' || reason === 'rules' || reason === 'compaction' || reason === 'manual';
        if (!forced) return Promise.resolve();
      }
      if (record.running) {
        record.dirty = true;
        record.reason = mergeReason(record.reason, reason);
        return Promise.resolve();
      }
      record.reason = mergeReason(record.reason, reason);
      record.running = true;
    }
    const run = (async () => {
      try {
        do {
          if (record) record.dirty = false;
          const useReason = record && record.reason ? record.reason : reason;
          if (record) record.reason = '';
          let text = '';
          try {
            text = await buildText(record?.agent ?? agent, useReason);
          } catch (error) {
            warn('build injection text', error);
          }
          if (disposed) return;
          cache.set(sessionId, text);
          if (record) record.built = true;
        } while (record && record.dirty && !disposed);
      } finally {
        if (record) record.running = false;
      }
    })();
    return run;
  };

  /** Register the prompt context on one agent's own context, once. */
  const ensureRegistered = (agent) => {
    const sessionId = agent?.id;
    if (disposed || typeof sessionId !== 'string' || sessionId === '') return;
    if (!shouldInject(agent)) return;
    const existing = records.get(sessionId);
    if (existing) {
      existing.agent = agent;
      return;
    }
    const agentCtx = agent?.ctx;
    if (!agentCtx || typeof agentCtx !== 'object') {
      warn('agent context', new Error(`agent ${sessionId} has no ctx; memory index not injected`));
      return;
    }
    let systemPrompt;
    try {
      systemPrompt = typeof agentCtx.get === 'function' ? agentCtx.get('systemPrompt') : agentCtx.systemPrompt;
    } catch {
      systemPrompt = undefined;
    }
    if (!systemPrompt || typeof systemPrompt.context !== 'function') {
      warn('systemPrompt.context', new Error(`no systemPrompt service in agent ${sessionId} scope`));
      return;
    }
    const promptContext = {
      name: CONTEXT_NAME,
      order,
      required: false,
      text: () => cache.get(sessionId) ?? '',
    };
    const record = { agent, dispose: null, running: false, dirty: false, dead: false, built: false };
    try {
      if (typeof agentCtx.effect === 'function') {
        const dispose = agentCtx.effect(() => systemPrompt.context(promptContext), 'cc-memory.prompt-context');
        record.dispose = typeof dispose === 'function' ? dispose : null;
      } else {
        const dispose = systemPrompt.context(promptContext);
        record.dispose = typeof dispose === 'function' ? dispose : null;
      }
    } catch (error) {
      warn('register prompt context', error);
      return;
    }
    records.set(sessionId, record);
    if (typeof agentCtx.on === 'function') {
      try {
        record.recallShown = new Set();
        const stopRecall = attachRecall({ agent, agentCtx, runtime, config: configNow, shown: record.recallShown });
        record.disposeRecall = stopRecall;
        cleanups.push(stopRecall);
      } catch (error) {
        warn('attach recall', error);
      }
    }
    cleanups.push(() => {
      try {
        record.dispose?.();
      } catch (error) {
        warn('dispose prompt context', error);
      }
    });
  };

  /** Attach one agent: register its context and fill/replace its cached text. */
  const attach = async (agent, { buildFirst = false } = {}) => {
    if (disposed || typeof agent?.id !== 'string' || agent.id === '') return;
    if (buildFirst) {
      let text = '';
      try {
        text = await buildText(agent, 'init');
      } catch (error) {
        warn('initial injection text', error);
      }
      if (disposed) return;
      ensureRegistered(agent);
      cache.set(agent.id, text);
      const record = records.get(agent.id);
      if (record) record.built = true;
      return;
    }
    ensureRegistered(agent);
    await refresh(agent);
  };

  /** Drop everything owned by one disposed agent. */
  const detach = (sessionId) => {
    if (typeof sessionId !== 'string') return;
    const record = records.get(sessionId);
    if (record) {
      record.dead = true;
      try {
        record.disposeRecall?.();
        record.dispose?.();
      } catch (error) {
        warn('detach dispose', error);
      }
      records.delete(sessionId);
    }
    cache.delete(sessionId);
  };

  // Existing agents (plugin load through HMR): register now, rebuild asynchronously.
  for (const agent of listAgents()) {
    if (disposed) break;
    ensureRegistered(agent);
    runInBackground(refresh(agent), 'refresh existing agent');
  }

  // New agents: `agent/created` is serial and may be awaited, so the very first
  // request already sees the built text.
  try {
    const stopCreated = ctx.on('agent/created', async (payload) => {
      try {
        const agent = payload?.agent;
        if (!agent) return;
        await attach(agent, { buildFirst: true });
      } catch (error) {
        warn('agent/created', error);
      }
    });
    if (typeof stopCreated === 'function') cleanups.push(stopCreated);
  } catch (error) {
    warn('listen agent/created', error);
  }

  // Agents can be disposed without the plugin unloading; drop their cache.
  try {
    const stopDisposed = ctx.on('agent/disposed', (payload) => {
      try {
        const disposedId = payload?.agent?.id;
      detach(disposedId);
      try {
        runtime?.forgetSession?.(disposedId);
      } catch (error) {
        warn('forgetSession', error);
      }
      } catch (error) {
        warn('agent/disposed', error);
      }
    });
    if (typeof stopDisposed === 'function') cleanups.push(stopDisposed);
  } catch (error) {
    warn('listen agent/disposed', error);
  }

  // Compaction invalidates the request prefix anyway: refresh the frozen
  // snapshot once here so the re-injected context reflects current memory.
  try {
    const stopCompaction = ctx.on('session/event', (session, event) => {
      try {
        const type = event && typeof event.type === 'string' ? event.type : '';
        if (!type.startsWith('compaction/')) return;
        const sessionId = session?.id;
        if (typeof sessionId !== 'string') return;
        // What was attached may have been summarized away: allow it again.
        records.get(sessionId)?.recallShown?.clear();
        const agent = liveAgent(sessionId);
        if (agent) runInBackground(refresh(agent, 'compaction'), 'compaction refresh');
      } catch (error) {
        warn('compaction listener', error);
      }
    });
    if (typeof stopCompaction === 'function') cleanups.push(stopCompaction);
  } catch (error) {
    warn('listen compaction events', error);
  }

  // A memory write invalidates one session's cached text.
  try {
    const stopInvalidate =
      typeof runtime?.onInvalidate === 'function'
        ? runtime.onInvalidate((info) => {
            try {
              const sessionId = info?.sessionId;
              if (typeof sessionId !== 'string' || sessionId === '') return;
              const reason = typeof info?.reason === 'string' ? info.reason : 'memory-write';
              const agent = info?.agent ?? liveAgent(sessionId);
              if (!agent) {
                cache.delete(sessionId);
                return;
              }
              // `session` mode keeps the frozen snapshot for ordinary memory
              // writes; explicit user actions (config/rules) and a manual
              // refresh force a rebuild.
              if (
                injectionMode(agent) === 'session'
                && reason !== 'config'
                && reason !== 'rules'
                && reason !== 'manual'
              ) {
                return;
              }
              runInBackground(refresh(agent, reason), 'refresh invalidated agent');
            } catch (error) {
              warn('invalidate', error);
            }
          })
        : () => {};
    if (typeof stopInvalidate === 'function') cleanups.push(stopInvalidate);
  } catch (error) {
    warn('onInvalidate', error);
  }

  // Fallback refresh: `text` is synchronous and can only read the cache, so a
  // timer fills sessions whose first build has not happened yet. In `session`
  // mode a built snapshot is frozen and the timer leaves it alone.
  const timer = setInterval(() => {
    if (disposed) return;
    for (const record of [...records.values()]) {
      if (injectionMode(record.agent) === 'session' && record.built === true) continue;
      runInBackground(refresh(record.agent, 'timer'), 'periodic refresh');
    }
  }, refreshMs);
  if (typeof timer.unref === 'function') timer.unref();
  cleanups.push(() => clearInterval(timer));

  // Convenience accessor for status surfaces (`commands.js`, `tools.js`); the
  // prompt itself never uses it.
  try {
    if (runtime && typeof runtime === 'object') {
      runtime.getInjectedText = (sessionId) => cache.get(sessionId) ?? '';
    }
  } catch {
    // A frozen runtime is fine: the accessor is optional.
  }

  return function dispose() {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        warn('dispose', error);
      }
    }
    records.clear();
    cache.clear();
    try {
      if (runtime && typeof runtime === 'object' && typeof runtime.getInjectedText === 'function') {
        delete runtime.getInjectedText;
      }
    } catch {
      // Ignore: best-effort cleanup of the optional accessor.
    }
  };
}
