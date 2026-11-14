/**
 * Prompt injection: register one dynamic prompt context per live agent that
 * advertises the project memory directory, the memory rules, and the head of
 * `MEMORY.md`.
 *
 * Claude Code parity: a session gets one snapshot of `MEMORY.md` (first 200
 * lines / 25 KB) when it starts. The snapshot is rebuilt only when the request
 * prefix changes anyway (a compaction) or the user changes configuration or
 * rules. Memory writes during the session do not touch it; the model reads
 * topic files on demand.
 *
 * `systemPrompt.context()` needs a synchronous `text` function, so this module
 * owns a `Map<sessionId, string>` cache that the prompt provider reads.
 *
 * The context registration lives on `agent.ctx` so it disappears with the agent;
 * its disposer is also kept here so plugin unload removes it too. Every failure
 * degrades to an empty injected string plus a `console.warn` — never a throw
 * into the host.
 *
 * @module dsh-cc-dream-memory/inject
 */
import { recordInjection } from './metrics.js';
import { attachRecall } from './recall.js';

export const CONTEXT_NAME = 'cc-memory';
const DEFAULT_ORDER = 850;
/** Reasons that rebuild a session's snapshot; everything else leaves it frozen. */
const REBUILD_REASONS = new Set(['config', 'rules', 'compaction', 'manual']);

/**
 * Claude Code's system prompt tells the model it owns a persistent memory
 * directory; without that sentence the four tools alone are easy to ignore.
 * This is the compact manual: the four note types, what not to save, the
 * frontmatter contract, absolute dates, and verify-before-recommending. It is
 * deliberately shorter than Claude Code's section (no team scope, no import or
 * rules prose) so first turns stay cheap. Paths stay out of the prompt (see the
 * injection tests).
 */
export const MEMORY_INSTRUCTIONS = [
  'You have a persistent memory directory for this project. MEMORY.md in it is your index: one line per note, `- [Title](file.md) — one-line hook`.',
  'Write one topic file per note. Keep each index line short (about 150 characters) and move detail into the topic file.',
  'Each topic file starts with YAML frontmatter:',
  '---',
  'name: <stable short name>',
  'description: <one line; a future session uses this to decide whether to read the note>',
  'type: user | feedback | project | reference',
  '---',
  'Use the four types deliberately:',
  '- user: who the user is, durable preferences, expertise, and communication style. Private to this project.',
  '- feedback: a correction or an approach the user confirmed. State the rule, then **Why:** and **How to apply:**.',
  '- project: ongoing goals, deadlines, decisions, and constraints that the repository does not record. Add **Why:** and **How to apply:** when they are not obvious.',
  '- reference: where external information lives (URLs, dashboards, docs) and what it is for.',
  'Save only durable facts that cannot be read off the repository or from memory-rules.md: user preferences and corrections, decisions, and pointers to external information.',
  'Do not save secrets, one-off tasks, code patterns, architecture notes, file paths, project structure, git history, debugging recipes, or anything a session can re-derive.',
  'Do not save what memory-rules.md or this instruction block already states. Update an existing note instead of adding a near-duplicate; merge duplicates and delete notes that are no longer true.',
  'Write dates as absolute dates (2026-11-13), never "today" or "yesterday".',
  'Before recommending from memory, verify the file, function, or flag still exists. If memory conflicts with what you observe, trust the observation and update the note.',
  'Memories are private to this project and are shared by its git worktrees; do not assume another project can see them.',
].join('\n');

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
 *   index?: {text?:string,lines?:number,bytes?:number,overflow?:boolean,
 *     maxLines?:number,maxBytes?:number,totalLines?:number,totalBytes?:number},
 *   rules?: string,
 *   rulesSource?: string,
 * }} input
 * @returns {string}
 */
export function buildInjectionText(input = {}) {
  const index = input.index && typeof input.index === 'object' ? input.index : {};
  const lines = [];
  lines.push('<system-reminder>');
  lines.push('Auto memory is enabled for this project (managed by the dsh-cc-dream-memory plugin).');
  lines.push('');
  lines.push(
    'MEMORY.md is an index of durable notes written by you in earlier sessions. Topic files load only when you read them.',
  );
  lines.push(
    'Save with memory_save (new note) or memory_update (existing note); search with memory_search; read with memory_read. Skip anything the repository already records.',
  );
  // The long behaviour manual that used to sit here cost context on every first
  // turn; Claude Code's auto-memory section is richer, but its per-turn selector
  // is what makes that affordable. This compact version is a deliberate
  // trade-off. An optional `memory-rules.md` (the CLAUDE.md analogue) is
  // injected only when the user wrote one.
  const rulesText = typeof input.rules === 'string' ? input.rules.trim() : '';
  if (rulesText !== '' && input.rulesSource !== 'default') {
    lines.push('');
    lines.push('<rules>');
    lines.push(rulesText);
    lines.push('</rules>');
  }
  lines.push('');
  lines.push('<instructions>');
  lines.push(MEMORY_INSTRUCTIONS);
  lines.push('</instructions>');

  lines.push('');
  lines.push('<index>');
  const head = typeof index.text === 'string' ? index.text : '';
  lines.push(head === '' ? '(empty — no memories saved yet)' : head.replace(/\n$/, ''));
  lines.push('</index>');
  const actualLines = Number(index.totalLines ?? index.lines ?? 0);
  const actualBytes = Number(index.totalBytes ?? index.bytes ?? 0);
  if (index.overflow === true) {
    lines.push(
      `<budget-notice>MEMORY.md is over its read limit (${actualLines} lines / ${actualBytes} bytes; ` +
        `limit ${index.maxLines ?? 0} lines / ${index.maxBytes ?? 0} bytes). Everything past the limit is dropped on read. ` +
        'Rewrite it now: one line per note, move detail into topic files, merge or drop stale entries.</budget-notice>',
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

  lines.push('</system-reminder>');
  return lines.join('\n');
}

/**
 * Register the memory prompt context for every existing agent and every agent
 * created while this plugin is loaded.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} runtime `MemoryRuntime` from `src/runtime.js`.
 * @returns {() => void} disposer removing every listener and per-agent context
 *   registration.
 */
export function registerInjection(ctx, runtime) {
  // `runtime.config` includes runtime overrides, so `/memory on` and the Web
  // toggles apply without reloading the plugin.
  const configNow = () => runtime.config;
  const orderValue = Number(configNow().contextOrder);
  const order = Number.isFinite(orderValue) ? orderValue : DEFAULT_ORDER;

  /** @type {Map<string, string>} sessionId -> injected text */
  const cache = new Map();
  /** @type {Map<string, {agent:object, dispose:(()=>void)|null, disposeRecall:(()=>void)|null, recallShown:Set<string>, building:Promise<void>|null, again:boolean}>} */
  const records = new Map();
  /** @type {Array<() => void>} */
  const cleanups = [];
  let disposed = false;

  const agentsService = () => ctx.get('agents');

  /** Build one agent's injected text from the current store contents. */
  const buildText = async (agent) => {
    const effective = configNow();
    if (effective.enabled === false || effective.autoMemoryEnabled === false) return '';
    if (!runtime.canWriteMemory(agent)) return '';
    const projectContext = await runtime.forAgent(agent);
    if (!projectContext || disposed) return '';
    const index = await projectContext.store.injectedIndex('project');
    const rules = runtime.rulesFor(projectContext);
    const text = buildInjectionText({ index, rules: rules?.text, rulesSource: rules?.source });
    // A metrics failure never blocks or changes the injected text.
    runtime.track(recordInjection(projectContext.paths));
    return text;
  };

  /**
   * (Re)build one session's snapshot. Concurrent requests coalesce: a request
   * that arrives during a build schedules exactly one more build afterwards.
   */
  const build = (record) => {
    if (record.building) {
      record.again = true;
      return record.building;
    }
    record.building = (async () => {
      try {
        do {
          record.again = false;
          let text = '';
          try {
            text = await buildText(record.agent);
          } catch (error) {
            warn('build injection text', error);
          }
          if (disposed || !records.has(record.agent.id)) return;
          cache.set(record.agent.id, text);
        } while (record.again && !disposed);
      } finally {
        record.building = null;
      }
    })();
    return record.building;
  };

  /** Register the prompt context on one agent's own context and build its snapshot once. */
  const attach = (agent) => {
    const sessionId = agent?.id;
    if (disposed || typeof sessionId !== 'string' || sessionId === '') return Promise.resolve();
    const existing = records.get(sessionId);
    if (existing) {
      existing.agent = agent;
      return existing.building ?? Promise.resolve();
    }
    if (!runtime.canWriteMemory(agent)) return Promise.resolve();
    const agentCtx = agent.ctx;
    const systemPrompt = agentCtx?.get?.('systemPrompt');
    if (!systemPrompt || typeof systemPrompt.context !== 'function') {
      warn('systemPrompt.context', new Error(`no systemPrompt service in agent ${sessionId} scope`));
      return Promise.resolve();
    }
    const record = { agent, dispose: null, disposeRecall: null, recallShown: new Set(), building: null, again: false };
    try {
      const dispose = agentCtx.effect(
        () => systemPrompt.context({ name: CONTEXT_NAME, order, required: false, text: () => cache.get(sessionId) ?? '' }),
        'cc-memory.prompt-context',
      );
      record.dispose = typeof dispose === 'function' ? dispose : null;
    } catch (error) {
      warn('register prompt context', error);
      return Promise.resolve();
    }
    records.set(sessionId, record);
    try {
      record.disposeRecall = attachRecall({ agent, agentCtx, runtime, config: configNow, shown: record.recallShown });
    } catch (error) {
      warn('attach recall', error);
    }
    return build(record);
  };

  /** Drop everything owned by one disposed agent. */
  const detach = (sessionId) => {
    const record = records.get(sessionId);
    if (record) {
      records.delete(sessionId);
      for (const dispose of [record.disposeRecall, record.dispose]) {
        try {
          dispose?.();
        } catch (error) {
          warn('detach dispose', error);
        }
      }
    }
    cache.delete(sessionId);
  };

  /** Rebuild one live session's snapshot (compaction, config, rules, manual refresh). */
  const rebuild = (sessionId, agent) => {
    const record = records.get(sessionId);
    if (!record) return;
    if (agent) record.agent = agent;
    runtime.track(build(record));
  };

  // Existing agents (plugin load through HMR).
  const agents = agentsService();
  for (const agent of agents?.list?.() ?? []) runtime.track(attach(agent));

  // New agents: `agent/created` is serial and awaited, so the very first
  // request already sees the built text.
  cleanups.push(ctx.on('agent/created', async (payload) => {
    if (payload?.agent) await attach(payload.agent);
  }));

  cleanups.push(ctx.on('agent/disposed', (payload) => {
    const sessionId = payload?.agent?.id;
    if (typeof sessionId !== 'string') return;
    detach(sessionId);
    runtime.forgetSession(sessionId);
  }));

  // Compaction invalidates the request prefix anyway: rebuild the snapshot so
  // the re-injected context reflects current memory, and allow recall again.
  cleanups.push(ctx.on('session/event', (session, event) => {
    const type = typeof event?.type === 'string' ? event.type : '';
    if (!type.startsWith('compaction/') || typeof session?.id !== 'string') return;
    records.get(session.id)?.recallShown.clear();
    rebuild(session.id);
  }));

  // Only explicit user actions rebuild a frozen snapshot; ordinary memory
  // writes leave it alone.
  cleanups.push(runtime.onInvalidate((info) => {
    const sessionId = info?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (!REBUILD_REASONS.has(info?.reason)) return;
    rebuild(sessionId, info?.agent);
  }));

  // Status surfaces (`/memory refresh`) read the snapshot through the runtime.
  runtime.getInjectedText = (sessionId) => cache.get(sessionId) ?? '';

  return function dispose() {
    if (disposed) return;
    disposed = true;
    for (const sessionId of [...records.keys()]) detach(sessionId);
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup?.();
      } catch (error) {
        warn('dispose', error);
      }
    }
    cache.clear();
    delete runtime.getInjectedText;
  };
}
